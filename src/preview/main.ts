import "./sidebar.ts";
import { bindFleetViewport } from "./viewport.ts";
import { bindFleetTableScroll } from "./table-scroll.ts";
import { startConnectionIndicator } from "./connection.ts";
import { projectFleet } from "../fleet/freshness.ts";
import type { HostView, PCView, RuntimeView } from "../fleet/freshness.ts";
import { DEFAULT_SORT, nextFleetSort, parseSortPreference, sortFleetRows } from "../fleet/sort.ts";
import type { FleetSort, SortableFleetRow, SortColumn } from "../fleet/sort.ts";
import { formatIPDisplay, ipModeLabel, nextIPMode, normalizeIPMode } from "../fleet/ip-display.ts";
import type { IPAddresses, IPDisplayMode } from "../fleet/ip-display.ts";
import { nextDurationMode, normalizeDurationMode, projectDuration } from "../fleet/duration.ts";
import type { DurationDisplayMode, DurationInput, DurationView } from "../fleet/duration.ts";
import { projectDurationAvailability } from "../fleet/live-duration.ts";
import { isJobRecord, JOB_REFRESH_INTERVAL_MS } from "../fleet/jobs.ts";
import type { JobRecord } from "../fleet/jobs.ts";
import { LiveActivityDisplay } from "../fleet/live-activity.ts";
import type { LiveActivityView } from "../fleet/live-activity.ts";
import { isQueueRecord, projectQueue, QUEUE_REFRESH_INTERVAL_MS } from "../fleet/queue.ts";
import type { QueueRecord, QueueView } from "../fleet/queue.ts";
import { normalizeQueuedDurationLayout, projectQueuedDuration } from "../fleet/queued-duration.ts";
import type { QueuedDurationLayout } from "../fleet/queued-duration.ts";
import { nextMarketMode, normalizeMarketMode, projectMarket } from "../fleet/market-display.ts";
import type { MarketDisplayMode, MarketView } from "../fleet/market-display.ts";
import { formatHardwareDisplay, nextHardwareMode, normalizeHardwareMode } from "../fleet/hardware-display.ts";
import type { HardwareColumn, HardwareDisplayMode } from "../fleet/hardware-display.ts";
import type { HostMetadataRecord, HostMetadataValues } from "../fleet/host-metadata.ts";
import type { NodeInfoRecord } from "../fleet/node-info.ts";
import { isHostMetadataRecord as isMetadataRecord, isNodeInfoRecord } from "../contracts/fleet.ts";
import type { FleetResource } from "../contracts/fleet.ts";
import { readFleetConfig, fleetResourceURL } from "./fleet-config.ts";
import { createFleetTransport, fleetReadError } from "./fleet-transport.ts";
import { createOnlineRosterController } from "./online-roster.ts";
import type { OnlineRosterStatus } from "../contracts/online-hosts.ts";
import { createEvidenceClock } from "./evidence-clock.ts";
import { createRefreshDeadlines } from "./refresh-deadline.ts";
import type { RefreshDeadline } from "./refresh-deadline.ts";
import { formatSol, isSolRecord, SOL_DISPLAY_VALIDITY_MS, SOL_REFRESH_INTERVAL_MS } from "../fleet/sol.ts";
import type { SolRecord } from "../fleet/sol.ts";
import { formatNos, isNosRecord, NOS_MINT, NOS_DISPLAY_VALIDITY_MS, NOS_REFRESH_INTERVAL_MS } from "../fleet/nos.ts";
import type { NosRecord } from "../fleet/nos.ts";
import { formatStakingAmount, isStakingRecord, STAKING_REFRESH_INTERVAL_MS } from "../fleet/staking.ts";
import type { StakingRecord } from "../fleet/staking.ts";
import { projectStaking } from "../fleet/staking-view.ts";
import { projectNodeState, projectNodeStateDisplay } from "../fleet/node-state.ts";
import { projectNodeApi } from "../fleet/node-api.ts";
import { statusLabel, statusTone } from "../fleet/status-display.ts";
import { SAMPLE_TIME, SCENARIOS, sampleAddresses, sampleDuration, sampleHardware, sampleInventory, sampleMarket, sampleNodeInfo } from "./fixtures.ts";
import type { HardwareSample, ScenarioId } from "./fixtures.ts";
import { hasNewStateReads, nextJobRefreshAt, nextStateRefreshDelay, retainFailedActivity, STATE_REFRESH_INTERVAL_MS } from "./state-refresh.ts";
import { COLUMN_HELP } from "./column-help.ts";
import { infoText, renderInfoContent } from "./info-content.ts";
import type { InfoContent, InfoPart, InfoText, InfoTone } from "./info-content.ts";

// Constrain overflow before the viewport establishes this page's zoom baseline.
bindFleetTableScroll(document.querySelector<HTMLElement>(".fleet-table-wrap")!);
bindFleetViewport(document.querySelector<HTMLElement>(".fleet-title-row")!);
// Service reachability is independent of source freshness and host API status.
const fleetConfig = readFleetConfig(document);
const requestedScenario = fleetConfig.sourceMode === "snapshot" ? null : new URLSearchParams(location.search).get("scenario");
const evidenceClock = createEvidenceClock();
const liveNow = () => evidenceClock.now();
// Expiry uses a conservative time bound. Elapsed clocks, source validation and
// refresh/backoff scheduling continue to use the unchanged reference estimate.
const freshnessNow = () => evidenceClock.freshnessNow();
const deadlines = createRefreshDeadlines(liveNow);
let onlineRosterController: ReturnType<typeof createOnlineRosterController> | undefined;
const fleetTransport = createFleetTransport({
  ...(requestedScenario === "online-gpu-hosts" ? { maximumConcurrentRequests: 5 } : {}),
  onRosterMismatch() { void onlineRosterController?.refresh(); },
  onServerTime(serverTimeMs, requestElapsedMs) {
    // Initial roster loading may finish while hidden; only active views can
    // restore timing confidence after suspension.
    if (!visibleStateView()) return;
    const change = evidenceClock.accept(serverTimeMs, requestElapsedMs);
    if ((change.changed || change.freshnessChanged) && visibleStateView() && !inputLoading) {
      clockRenderPending ||= change.changed;
      freshnessRenderPending ||= change.freshnessChanged;
      scheduleProgressRender("state", []);
    }
  },
});
startConnectionIndicator(document.getElementById("fleet-connection")!, fleetResourceURL(fleetConfig, "connection"));

// Requested Fleet order; staking leads and API, State, Queued, Duration are adjacent.
const COLUMNS = [
  ["stakedNos", "Staked NOS", "Toggle between a dull-green checkmark / red lowercase x and the actual / required NOS amounts. A current checkmark means exact vault NOS meets the current market’s displayed NOS target, including verified 0 / 0; x means it is below that target. Amount view rounds to whole NOS and uses bright green or red for the actual amount. Exact amounts drive sorting and comparison. This does not establish full market eligibility. Amounts still releasing during unstaking remain included; details distinguish duration-weighted xNOS. Shared public RPC checks every 30 minutes; readings expire after 35 minutes. Failed or expired comparisons stay gray; an unknown comparison is a dash."],
  ["status", "Status", "Reported Nosana classification. ONBOARDED is displayed as COMMUNITY (yellow C); REJECTED as red R; PREMIUM as green P. Details preserve the raw response. This does not establish container health or current job activity."],
  ["pc", "PC", "The sample PC that owns this host. Select a PC cell for the row’s observation details."],
  ["ip", "IP", "Toggle between hidden (•), full global / internal addresses, global last octet and internal last octet. Compact IPv4 values include the leading dot, such as .102. IPv6 stays complete. Sorting always uses the full internal address. These are documentation-only sample addresses, not links or reachable PCs."],
  ["hostAddress", "Host Address", "A supplied public Nosana host address. Toggle between the first five characters (default) and the full address. Both views link to the same full address in Nosana Explorer, and sorting always uses the full address. Supplied addresses do not establish current host status or any measurements."],
  ["sol", "SOL", "Confirmed SOL balance from public mainnet RPC, checked best effort every 30 seconds while visible. Three decimals are rounded down for display; exact lamports and provenance are in details and drive sorting. Failed or 60-second-old readings remain gray. Missing accounts remain unknown; verified zero remains zero."],
  ["api", "API", "Last confirmed API result from Node Info, separate from State. Online stays green and Offline stays red. Bold means within its checking window; regular weight means stale or unconfirmed. Online uses a 30-second window. Offline stays bold until its recorded retry is overdue, including an eight-second request allowance. Details preserve original check times and the retry deadline. Amber Populating.. means no confirmed result is available yet. State OTHER can still be API Online. Timeouts and inconclusive checks do not overwrite the last confirmed result. This does not establish whether the PC or workload is running."],
  ["state", "State", "Fresh useful Node Info takes precedence, then a freshly verified running assignment unless equally recent or newer contrary evidence supersedes it. Node State keeps its 30-second deadline; job-backed State keeps its original 180-second deadline. The last useful State stays visible in a darker color with animation controlled by State animation. A dim amber spinner means no useful State yet; it does not establish restarting or an in-flight request. Details preserve source times and distinguish retained estimates from confirmed activity."],
  ["queued", "Queued", "One-based position / total in the host’s reported Nosana market queue. The public ordered queue is checked every 20 seconds while visible and expires locally after 30 seconds. Failed or expired positions remain gray; a missing position is unknown, not zero. Arrows connect current queue positions and running job durations. Details preserve the exact host, market and API check time; queue position is not a wait-time estimate."],
  ["duration", "Duration", "Toggle between a compact elapsed/limit bar and time text. Supplied hosts use the assigned Nosana job’s reported start and timeout, with a local one-second clock. After failed or expired reads, the last verified start keeps counting as a darker estimate until superseded. Bounded bars keep their animation preference; elapsed more than five minutes above the last reported limit is red, dimmer when stale. This display grace does not extend the reported limit or change elapsed time. Amber Populating.. means no useful timing yet; a dash with No running assignment in details means current confirmed absence. Expired or failed absence, or newer running evidence, returns to Populating.. without restoring an old counter. When API Offline is currently confirmed and timing is unknown, a dash means timing unavailable; Offline alone does not establish that a job stopped. Known job timings refresh independently of State every 120 seconds while visible; pending discovery follows the permitted retry deadline. Local display validity is 180 seconds. The indexer supplies no indexing-freshness timestamp."],
  ["nodeRuntime", "Node run time", "Node process run time requires its own observation. It cannot be inferred from inventory freshness."],
  ["dailyUptime", "Daily uptime %", "The last completed provider day, with independently verified coverage. No uptime source is connected."],
  ["latestJob", "Latest Job", "The latest independently verified job. Live assignments supporting Duration are shown in Duration details; Latest Job history remains unconnected. The Job durations scenario supplies selected synthetic job identifiers."],
  ["ram", "RAM", "Reported RAM in GB from Nosana metrics. The compact cell rounds to a whole GB; sorting preserves the reported number. This is not current memory usage."],
  ["disk", "Disk", "Reported disk GB from Nosana metrics. This does not establish current free space or usage."],
  ["dl", "DL", "Reported download Mbps from Node Info info.network.download_mbps. This is saved network data, not a speed test triggered by this page. An all-zero default triplet is unknown."],
  ["ul", "UL", "Reported upload Mbps from Node Info info.network.upload_mbps. The specific test provider and measurement time are not supplied. No FAST/Libre/Ookla fallback is applied."],
  ["ping", "Ping", "Reported ping milliseconds from Node Info info.network.ping_ms. Display is rounded; sorting preserves the reported value. An all-zero default triplet is unknown."],
  ["rewards", "Rewards to claim", "The exact claimable host-uptime amount. No rewards source or wallet is connected; no estimate or other balance is substituted."],
  ["nos", "NOS", "Confirmed NOS in each host’s standard associated token account, checked best effort every two minutes while visible. Display rounds to whole NOS; exact six-decimal amounts drive sorting. Additional wallet token accounts, staking and claimable rewards are excluded. A freshly verified absent standard account means zero there; failures remain unknown or retain gray values. Readings expire after three minutes."],
  ["market", "Market", "Toggle between the full reported market label and its first two characters. Sorting uses the full label. Supplied hosts resolve their market address through Nosana’s market lookup, preferring its slug. Missing labels stay unknown. This association does not identify the physical GPU or establish current activity; recommendations are separate."],
  ["gpuID", "GPU ID", "The current physical GPU index, resolved from measured UUID identity. No hardware observations are connected."],
  ["currentNode", "Current Node", "The reported Nosana package version. This does not prove which process is currently running. Prerelease versions are pink; no comparison with the latest release is connected."],
  ["cuda", "CUDA", "CUDA driver version reported by Nosana metrics."],
  ["nvidia", "NVIDIA", "Toggle between the major NVIDIA driver version and the full reported version. Sorting uses the full version. Supplied hosts use reported Nosana metadata; sample scenarios remain synthetic."],
  ["cpu", "CPU", "Toggle between a short CPU label and the full processor description. Compact mode shows the generation (such as 13th), otherwise the vendor, otherwise the first word. Sorting uses the full description. Supplied hosts use reported Nosana metadata."],
  ["system", "System", "Toggle between the release before its first hyphen and the full reported system string. A kernel release does not identify the complete OS or distribution. Sorting uses the full string. Supplied hosts use reported Nosana metadata."],
] as const satisfies readonly (readonly [SortColumn, string, string])[];

// The decorative divider follows Duration in either layout. Header help and
// sorting stay available everywhere; only right-side body cells are passive.
const RIGHT_BODY_COLUMNS = new Set<string>(COLUMNS.slice(COLUMNS.findIndex(([key]) => key === "duration") + 1)
  .map(([key]) => key));
function hasRowInformation(cell: HTMLTableCellElement): boolean {
  return !RIGHT_BODY_COLUMNS.has(cell.dataset.col ?? "");
}

function rowValue(cell: HTMLTableCellElement, className: string): HTMLButtonElement | HTMLSpanElement {
  const existing = cell.querySelector<HTMLButtonElement | HTMLSpanElement>(`.${className}`);
  if (existing) return existing;
  const value = document.createElement(hasRowInformation(cell) ? "button" : "span");
  if (value instanceof HTMLButtonElement) value.type = "button";
  return value;
}

// These current column meanings need local observation or machine mapping.
// A future Nosana connector may deliver them; no collection is enabled here.
const LOCAL_SOURCE_NOTES: Readonly<Partial<Record<SortColumn, string>>> = {
  pc: "Local machine name or operator-defined PC grouping; its mapping to Nosana nodes is pending.",
  ip: "The internal/private PC address needs local mapping. A global address can come from that node’s Nosana observation and may be shared by several PCs; it must never be replaced with the viewing device’s IP.",
  gpuID: "The physical GPU index on the PC. Nosana’s exported device index is not yet verified as that physical slot.",
};

function columnDescription(key: SortColumn, description: string): string {
  const localNote = LOCAL_SOURCE_NOTES[key];
  return localNote
    ? `${description}\n\nLocal source or mapping · connection to hosted app pending.\n${localNote}`
    : description;
}

const SORT_PREFERENCE_KEY = "gridlens.preview.sort.v1";
const IP_MODE_PREFERENCE_KEY = "gridlens.preview.ip-mode.v1";
const HOST_ADDRESS_MODE_PREFERENCE_KEY = "gridlens.preview.host-address-mode.v1";
const DURATION_MODE_PREFERENCE_KEY = "gridlens.preview.duration-mode.v1";
const MARKET_MODE_PREFERENCE_KEY = "gridlens.preview.market-mode.v1";
const STAKING_MODE_PREFERENCE_KEY = "gridlens.preview.staking-mode.v1";
const STATE_MOTION_PREFERENCE_KEY = "gridlens.preview.state-motion.v1";
const DURATION_MOTION_PREFERENCE_KEY = "gridlens.preview.duration-motion.v1";
const QUEUED_DURATION_LAYOUT_KEY = "gridlens.preview.queued-duration-layout.v1";
let queuedDurationLayout: QueuedDurationLayout = "separate";
try {
  queuedDurationLayout = normalizeQueuedDurationLayout(localStorage.getItem(QUEUED_DURATION_LAYOUT_KEY));
} catch {
  // Layout remains usable for this page when storage is unavailable.
}
type MotionMode = "on" | "system" | "off";
let stateMotion: MotionMode = "on";
try {
  const saved = localStorage.getItem(STATE_MOTION_PREFERENCE_KEY);
  if (saved === "on" || saved === "system" || saved === "off") stateMotion = saved;
} catch {
  // The explicitly requested State motion remains usable without storage.
}
document.documentElement.dataset.stateMotion = stateMotion;
let durationMotion: MotionMode = "on";
try {
  const saved = localStorage.getItem(DURATION_MOTION_PREFERENCE_KEY);
  if (saved === "on" || saved === "system" || saved === "off") durationMotion = saved;
} catch {
  // The requested reference glare remains usable when storage is unavailable.
}
document.documentElement.dataset.durationMotion = durationMotion;
const HARDWARE_COLUMNS = ["nvidia", "cpu", "system"] as const;
const hardwareModes: Record<HardwareColumn, HardwareDisplayMode> = {
  nvidia: "compact", cpu: "compact", system: "compact",
};
function hardwarePreferenceKey(column: HardwareColumn): string {
  return `gridlens.preview.${column}-mode.v1`;
}
for (const column of HARDWARE_COLUMNS) {
  try {
    hardwareModes[column] = normalizeHardwareMode(localStorage.getItem(hardwarePreferenceKey(column)));
  } catch {
    // Each display remains usable without persistent browser storage.
  }
}
let activeSort = DEFAULT_SORT;
try {
  activeSort = parseSortPreference(localStorage.getItem(SORT_PREFERENCE_KEY));
} catch {
  // Browsers that deny storage can still sort for the current page session.
}
let ipMode: IPDisplayMode = "dot";
try {
  ipMode = normalizeIPMode(localStorage.getItem(IP_MODE_PREFERENCE_KEY));
} catch {
  // The display control remains usable when browser storage is unavailable.
}
let hostAddressMode: "compact" | "full" = "compact";
try {
  if (localStorage.getItem(HOST_ADDRESS_MODE_PREFERENCE_KEY) === "full") hostAddressMode = "full";
} catch {
  // Keep five-character links as the default when storage is unavailable.
}
let durationMode: DurationDisplayMode = "bar";
try {
  durationMode = normalizeDurationMode(localStorage.getItem(DURATION_MODE_PREFERENCE_KEY));
} catch {
  // Rendering and display controls do not depend on storage permission.
}
let marketMode: MarketDisplayMode = "full";
try {
  marketMode = normalizeMarketMode(localStorage.getItem(MARKET_MODE_PREFERENCE_KEY));
} catch {
  // Market display remains available without persistent browser storage.
}
type StakingDisplayMode = "symbols" | "amounts";
let stakingMode: StakingDisplayMode = "symbols";
try {
  if (localStorage.getItem(STAKING_MODE_PREFERENCE_KEY) === "amounts") stakingMode = "amounts";
} catch {
  // The default symbols and display toggle remain available without storage.
}

interface PreviewRow extends SortableFleetRow {
  readonly pcView: PCView;
  readonly runtime: RuntimeView;
  readonly host: HostView;
  readonly addresses: IPAddresses;
  readonly durationInput: DurationInput | null;
  readonly duration: DurationView;
  readonly market: MarketView;
  readonly hardware: HardwareSample;
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing preview element: ${id}`);
  return found as T;
}

/** Preserve text nodes/live regions when a refresh has no new display value. */
function setText(target: HTMLElement, text: string): void {
  if (target.textContent !== text) target.textContent = text;
}

/** Keep count nodes stable so narrow layouts can hide the unit independently. */
function setHostCount(count: number | null): void {
  const number = count === null ? "" : String(count);
  const unit = count === null ? "" : count === 1 ? " host" : " hosts";
  setText(element("host-count-number"), number);
  setText(element("host-count-unit"), unit);
  const target = element("host-count");
  if (count === null) {
    if (target.hasAttribute("title")) target.removeAttribute("title");
  } else if (target.getAttribute("title") !== number + unit) {
    target.setAttribute("title", number + unit);
  }
}

const stateMotionSelect = element<HTMLSelectElement>("state-motion");
stateMotionSelect.value = stateMotion;
stateMotionSelect.addEventListener("change", () => {
  const value = stateMotionSelect.value;
  stateMotion = value === "system" || value === "off" ? value : "on";
  document.documentElement.dataset.stateMotion = stateMotion;
  try {
    localStorage.setItem(STATE_MOTION_PREFERENCE_KEY, stateMotion);
  } catch {
    // This is an app-only preference, not a change to the desktop/browser OS setting.
  }
});

const durationMotionSelect = element<HTMLSelectElement>("duration-motion");
durationMotionSelect.value = durationMotion;
durationMotionSelect.addEventListener("change", () => {
  const value = durationMotionSelect.value;
  durationMotion = value === "system" || value === "off" ? value : "on";
  document.documentElement.dataset.durationMotion = durationMotion;
  try {
    localStorage.setItem(DURATION_MOTION_PREFERENCE_KEY, durationMotion);
  } catch {
    // This preference only controls eligible Duration glare in this application.
  }
});

const dialog = element<HTMLDialogElement>("info-dialog");
let infoReturnTarget: HTMLElement | null = null;
function showInfo(title: string, content: InfoContent): void {
  infoReturnTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  element("info-title").textContent = title;
  renderInfoContent(element("info-body"), content);
  element("info-body").scrollTop = 0;
  dialog.showModal();
}
element("close-info").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {
  const opener = infoReturnTarget;
  infoReturnTarget = null;
  restoreSuppressedInfoTarget(opener);
});

interface CellInfo extends InfoContent { readonly checked?: InfoText }
const cellInformation = new WeakMap<HTMLTableCellElement, CellInfo>();
const ink = (text: string, tone: InfoTone = "plain"): InfoPart => ({ text, tone });
const brief = (text: string, maximum = 200): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= maximum ? line : `${line.slice(0, maximum - 1).trimEnd()}…`;
};
const checkedFact = (at: number | null | undefined, label = "Checked"): string =>
  `${label}: ${timestamp(typeof at === "number" && Number.isSafeInteger(at) && at >= 0 && at <= 8_640_000_000_000_000 ? at : null)}.`;

function rememberInfo(cell: HTMLTableCellElement, content: CellInfo, value?: HTMLElement): void {
  if (!hasRowInformation(cell)) {
    cellInformation.delete(cell);
    cell.removeAttribute("title");
    if (value) {
      value.removeAttribute("aria-description");
      const label = value.getAttribute("aria-label")?.replace(/\s*Open details\.$/, "").trim();
      if (label) {
        value.setAttribute("aria-label", label);
        cell.setAttribute("aria-label", label);
      }
    }
    return;
  }
  cellInformation.set(cell, content);
  cell.title = brief(infoText(content.summary));
  if (value) value.setAttribute("aria-description", cell.title);
}

function openCellInfo(cell: HTMLTableCellElement, title: string): void {
  if (!hasRowInformation(cell)) return;
  const content = cellInformation.get(cell);
  if (content) showInfo(title, content);
}

function changeSort(next: FleetSort): void {
  activeSort = next;
  try {
    localStorage.setItem(SORT_PREFERENCE_KEY, JSON.stringify(activeSort));
  } catch {
    // Sorting does not require persistent browser storage.
  }
  render();
}

for (const id of ["clear-sort", "sidebar-clear-sort"]) {
  element(id).addEventListener("click", () => changeSort(DEFAULT_SORT));
}
element("column-info").addEventListener("click", () => {
  const column = COLUMNS.find(([key]) => key === activeSort.column);
  if (column) showInfo(column[1], {
    summary: COLUMN_HELP[column[0]],
    ...(LOCAL_SOURCE_NOTES[column[0]] ? { facts: [[ink("Local data or mapping is not connected yet.", "warning")]] } : {}),
    source: columnDescription(column[0], column[2]),
  });
});

function dividerCell(tag: "th" | "td"): HTMLTableCellElement {
  const cell = document.createElement(tag);
  cell.className = "column-divider";
  cell.setAttribute("aria-hidden", "true");
  return cell;
}

/** Move connected controls without resetting focus or CSS animation timelines. */
function movePresentation(parent: HTMLElement, child: HTMLElement, before: Element | null = null): void {
  if (child.parentElement === parent && child.nextElementSibling === before) return;
  const focus = document.activeElement instanceof HTMLElement && child.contains(document.activeElement)
    ? document.activeElement : null;
  const animations = child.getAnimations({ subtree: true }).map(animation => ({
    animation, time: animation.currentTime, state: animation.playState,
    rate: animation.playbackRate,
    effect: animation.effect instanceof KeyframeEffect ? animation.effect : null,
    name: animation instanceof CSSAnimation ? animation.animationName : null,
  }));
  if (parent.isConnected && child.isConnected && typeof parent.moveBefore === "function") {
    parent.moveBefore(child, before);
  } else {
    parent.insertBefore(child, before);
  }
  // Legacy insertion and some native moves recreate pseudo-element animations.
  // Match the new effect to its original target, pseudo-element and name, keeping
  // the elapsed phase and any paused state independently of Animation identity.
  const moved = child.getAnimations({ subtree: true });
  for (const saved of animations) {
    const animation = moved.find(candidate => candidate === saved.animation ||
      candidate instanceof CSSAnimation && candidate.animationName === saved.name &&
      candidate.effect instanceof KeyframeEffect && candidate.effect.target === saved.effect?.target &&
      candidate.effect.pseudoElement === saved.effect?.pseudoElement);
    if (!animation) continue;
    animation.playbackRate = saved.rate;
    if (saved.time !== null) animation.currentTime = saved.time;
    if (saved.state === "paused") animation.pause();
  }
  if (focus && document.activeElement !== focus) focus.focus({ preventScroll: true });
}

const sourceContainers = new WeakMap<HTMLTableCellElement, HTMLSpanElement>();
const durationViews = new WeakMap<HTMLTableCellElement, DurationView>();
// Keep the deadlines actually painted current. A large render can cross an
// expiry before timers are armed; recomputing only then would miss that cell.
const displayExpiry = new WeakMap<HTMLTableCellElement, number>();
const durationNames = new WeakMap<HTMLTableCellElement, string>();
const queueViews = new WeakMap<HTMLTableCellElement, QueueView>();

function rememberDisplayExpiry(cell: HTMLTableCellElement, deadline: number | null | undefined): void {
  if (deadline == null) displayExpiry.delete(cell);
  else displayExpiry.set(cell, deadline);
}

function displayedExpiryDates(columns: readonly string[]): number[] {
  const selector = columns.map(column => `td[data-col="${column}"]`).join(",");
  return [...element("fleet-rows").querySelectorAll<HTMLTableCellElement>(selector)].flatMap(cell => {
    const deadline = displayExpiry.get(cell);
    return deadline === undefined ? [] : [deadline];
  });
}

function sourceContainer(cell: HTMLTableCellElement): HTMLSpanElement {
  let container = sourceContainers.get(cell);
  if (!container) {
    container = document.createElement("span");
    container.className = "queued-duration-source";
    container.dataset.source = cell.dataset.col;
    container.dataset.label = cell.dataset.col === "queued" ? "Q" : "D";
    cell.append(container);
    sourceContainers.set(cell, container);
  }
  return container;
}

function combinedInformation(row: Element): InfoContent | null {
  const queue = row.querySelector<HTMLTableCellElement>('td[data-col="queued"]');
  const duration = row.querySelector<HTMLTableCellElement>('td[data-col="duration"]');
  const queueView = queue && queueViews.get(queue);
  const durationView = duration && durationViews.get(duration);
  const queueInfo = queue && cellInformation.get(queue);
  const durationInfo = duration && cellInformation.get(duration);
  if (!queueView || !durationView || !queueInfo || !durationInfo) return null;
  return {
    summary: "Queued and Duration keep their own readings and freshness.",
    facts: [queueInfo.summary, durationInfo.summary,
      queueInfo.checked ?? "Queue check time unavailable.",
      durationInfo.checked ?? "Duration supporting evidence is in Source details."],
    source: projectQueuedDuration(queueView, durationView).description,
  };
}

function sourceDetails(cell: HTMLTableCellElement, title: string): void {
  const row = cell.parentElement;
  if (queuedDurationLayout === "combined" && row) {
    const info = combinedInformation(row);
    if (info) {
      showInfo("Queued / Duration", info);
      return;
    }
  }
  openCellInfo(cell, title);
}

for (const [key, label] of COLUMNS) {
  const heading = document.createElement("th");
  heading.scope = "col";
  heading.dataset.col = key;
  if (LOCAL_SOURCE_NOTES[key]) heading.dataset.source = "local";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "column-label";
  button.textContent = label;
  button.setAttribute("aria-label", `Sort by ${label}`);
  button.title = COLUMN_HELP[key];
  if (LOCAL_SOURCE_NOTES[key]) button.setAttribute("aria-describedby", "local-source-note");
  button.addEventListener("click", () => changeSort(nextFleetSort(activeSort, key)));
  heading.append(button);
  if (key === "ip" || key === "hostAddress" || key === "duration" || key === "market" || key === "stakedNos" || key === "nvidia" || key === "cpu" || key === "system") {
    heading.classList.add("has-display-toggle");
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.id = `${key}-display-toggle`;
    toggle.className = "column-display-toggle";
    toggle.textContent = "🔄";
    toggle.setAttribute("aria-label", `Toggle ${label} display`);
    toggle.setAttribute("aria-describedby", `${key}-mode-status`);
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      if (key === "ip") ipMode = nextIPMode(ipMode);
      else if (key === "hostAddress") hostAddressMode = hostAddressMode === "compact" ? "full" : "compact";
      else if (key === "duration") durationMode = nextDurationMode(durationMode);
      else if (key === "market") marketMode = nextMarketMode(marketMode);
      else if (key === "stakedNos") stakingMode = stakingMode === "symbols" ? "amounts" : "symbols";
      else hardwareModes[key] = nextHardwareMode(hardwareModes[key]);
      try {
        if (key === "ip") localStorage.setItem(IP_MODE_PREFERENCE_KEY, ipMode);
        else if (key === "hostAddress") localStorage.setItem(HOST_ADDRESS_MODE_PREFERENCE_KEY, hostAddressMode);
        else if (key === "duration") localStorage.setItem(DURATION_MODE_PREFERENCE_KEY, durationMode);
        else if (key === "market") localStorage.setItem(MARKET_MODE_PREFERENCE_KEY, marketMode);
        else if (key === "stakedNos") localStorage.setItem(STAKING_MODE_PREFERENCE_KEY, stakingMode);
        else localStorage.setItem(hardwarePreferenceKey(key), hardwareModes[key]);
      } catch {
        // Display changes are still retained in memory for this page session.
      }
      render();
    });
    heading.append(toggle);
  }
  if (key === "queued" || key === "duration") {
    const container = sourceContainer(heading);
    container.classList.add("queued-duration-heading");
    if (key === "duration") container.classList.add("has-display-toggle");
    for (const child of [...heading.children]) if (child !== container) container.append(child);
  }
  element("column-headings").append(heading);
  if (key === "duration") element("column-headings").append(dividerCell("th"));
}

const layoutToggle = document.createElement("button");
layoutToggle.id = "queued-duration-layout-toggle";
layoutToggle.className = "queued-duration-layout-toggle";
layoutToggle.type = "button";
layoutToggle.setAttribute("aria-describedby", "queued-duration-help");
// Static artwork: two columns with inward arrows, or one with outward arrows.
layoutToggle.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <g class="combine-columns"><rect x="1.5" y="4" width="5" height="16" rx="1"/><rect x="17.5" y="4" width="5" height="16" rx="1"/><path d="M8 12h3m-2-2 2 2-2 2m7-2h-3m2-2-2 2 2 2"/></g>
  <g class="separate-columns"><rect x="8" y="4" width="8" height="16" rx="1"/><path d="M6 12H1m3-3-3 3 3 3m14-3h5m-3-3 3 3-3 3"/></g>
</svg><span class="queued-duration-tooltip" role="tooltip"></span>`;
element("column-headings").querySelector('th[data-col="queued"]')!.append(layoutToggle);

function positionQueuedDurationToggle(): void {
  const parent = layoutToggle.parentElement!;
  const headings = element("column-headings");
  const queue = headings.querySelector<HTMLTableCellElement>('th[data-col="queued"]')!;
  const duration = headings.querySelector<HTMLTableCellElement>('th[data-col="duration"]')!;
  const left = sourceContainer(queue).querySelector(".column-label")!.getBoundingClientRect();
  const right = sourceContainer(duration).querySelector(".column-label")!.getBoundingClientRect();
  const bounds = parent.getBoundingClientRect();
  if (!bounds.width) return;
  const scale = bounds.width / parent.offsetWidth;
  layoutToggle.style.left = `${((left.left + left.width / 2 + right.left + right.width / 2) / 2 - bounds.left) / scale}px`;
}

// Header widths can change with bar/text modes, incoming values and viewport
// size. Position only this control; observation never touches data or row state.
const layoutHeadingResize = new ResizeObserver(positionQueuedDurationToggle);
for (const key of ["queued", "duration"]) {
  layoutHeadingResize.observe(element("column-headings").querySelector(`th[data-col="${key}"]`)!);
}

function renderQueuedDurationHeader(): void {
  const headings = element("column-headings");
  const queue = headings.querySelector<HTMLTableCellElement>('th[data-col="queued"]')!;
  const duration = headings.querySelector<HTMLTableCellElement>('th[data-col="duration"]')!;
  const combined = queuedDurationLayout === "combined";
  let joined = headings.querySelector<HTMLTableCellElement>('th[data-col="queued-duration"]');
  if (combined && !joined) {
    joined = document.createElement("th");
    joined.scope = "col";
    joined.dataset.col = "queued-duration";
    joined.setAttribute("aria-label", "Queued / Duration");
    const slot = document.createElement("span");
    slot.className = "queued-duration-layout-slot";
    slot.setAttribute("aria-hidden", "true");
    joined.append(slot);
    duration.after(joined);
    layoutHeadingResize.observe(joined);
  }
  // Reveal destinations first: moving a bar into display:none would cancel it.
  if (joined && combined) joined.hidden = false;
  if (!combined) { queue.hidden = false; duration.hidden = false; }
  for (const cell of [queue, duration]) {
    const container = sourceContainer(cell);
    const target = combined ? joined! : cell;
    if (container.parentElement !== target) {
      movePresentation(target, container, combined && cell === queue ? joined!.firstElementChild : null);
    }
    const direction = activeSort.column === cell.dataset.col
      ? activeSort.direction === "asc" ? "ascending" : "descending" : "none";
    container.dataset.sort = direction;
    container.querySelector(".column-label")?.setAttribute("aria-pressed", String(direction !== "none"));
    cell.setAttribute("aria-sort", combined ? "none" : direction);
  }
  const toggleTarget = combined ? joined! : queue;
  if (layoutToggle.parentElement !== toggleTarget) {
    movePresentation(toggleTarget, layoutToggle, combined ? joined!.querySelector(".queued-duration-layout-slot") : null);
  }
  queue.hidden = duration.hidden = combined;
  if (joined) {
    joined.hidden = !combined;
    const sorted = activeSort.column === "queued" || activeSort.column === "duration";
    joined.setAttribute("aria-sort", combined && sorted ? activeSort.direction === "asc" ? "ascending" : "descending" : "none");
    joined.setAttribute("aria-label", `Queued / Duration${sorted ? `, sorted by ${activeSort.column === "queued" ? "Queued" : "Duration"}` : ""}`);
  }
  const label = combined ? "Separate Queued + Duration" : "Combine Queued + Duration";
  layoutToggle.setAttribute("aria-label", label);
  layoutToggle.title = label;
  setText(layoutToggle.querySelector<HTMLElement>(".queued-duration-tooltip")!, label);
  layoutToggle.setAttribute("aria-pressed", String(combined));
  positionQueuedDurationToggle();
  document.documentElement.dataset.queuedDurationLayout = queuedDurationLayout;
}

const combinedSourceFocus = new WeakMap<HTMLTableRowElement, HTMLButtonElement>();

function availableInfoTarget(target: HTMLElement | null | undefined): boolean {
  return Boolean(target?.isConnected && !target.closest("[hidden], [inert]") && target.getClientRects().length > 0);
}

/** A background reading may replace the combined action while its popup is open. */
function restoreSuppressedInfoTarget(opener: HTMLElement | null): void {
  // Native dialog return-focus remains authoritative when its original target is
  // still available. Only adapt a suppressed Queued / Duration presentation.
  if (!opener?.isConnected || availableInfoTarget(opener)) return;
  const row = opener.closest<HTMLTableRowElement>("tr[data-host]");
  if (!row || !opener.matches(".queued-duration-details, .queue-value, .duration-value")) return;
  const shared = row.querySelector<HTMLButtonElement>(".queued-duration-details");
  if (shared && availableInfoTarget(shared)) {
    if (opener instanceof HTMLButtonElement && opener.closest(".queued-duration-source")) {
      combinedSourceFocus.set(row, opener);
    }
    shared.focus({ preventScroll: true });
    return;
  }
  const candidates = [combinedSourceFocus.get(row),
    ...row.querySelectorAll<HTMLButtonElement>(".queued-duration-source button")];
  candidates.find(availableInfoTarget)?.focus({ preventScroll: true });
}

function renderQueuedDurationRow(row: HTMLTableRowElement): void {
  const queue = row.querySelector<HTMLTableCellElement>('td[data-col="queued"]');
  const duration = row.querySelector<HTMLTableCellElement>('td[data-col="duration"]');
  if (!queue || !duration) return;
  const queueView = queueViews.get(queue);
  const durationView = durationViews.get(duration);
  if (!queueView || !durationView) return;
  const view = projectQueuedDuration(queueView, durationView);
  const combined = queuedDurationLayout === "combined";
  const sharedDetails = combined && view.stacked;
  const oldFocus = document.activeElement;
  let focusTransferred = false;
  let joined = row.querySelector<HTMLTableCellElement>('td[data-col="queued-duration"]');
  if (combined && !joined) {
    joined = document.createElement("td");
    joined.dataset.col = "queued-duration";
    duration.after(joined);
  }
  if (joined) {
    if (combined) joined.hidden = false;
    joined.dataset.stacked = String(view.stacked);
    joined.title = brief([cellInformation.get(queue), cellInformation.get(duration)]
      .filter((info): info is InfoContent => info !== undefined).map(info => infoText(info.summary).replace(/\.$/, "")).join("; ") + ".");
  }
  if (!combined) { queue.hidden = false; duration.hidden = false; }
  for (const [cell, visible] of [[queue, view.showQueue], [duration, view.showDuration]] as const) {
    const container = sourceContainer(cell);
    const target = combined ? joined! : cell;
    // The two compact source lines share one detail action. Keep their original
    // nodes connected for animation, then restore the original actions when split.
    if (!sharedDetails) {
      container.inert = false;
      container.removeAttribute("aria-hidden");
      container.querySelector("button")?.removeAttribute("tabindex");
    }
    container.hidden = combined && !visible;
    if (container.parentElement !== target) movePresentation(target, container);
  }
  // Only the navigation arrow changes wording. Timing nodes and bar fills stay intact.
  if (durationView.kind === "queue") {
    const button = sourceContainer(duration).querySelector<HTMLButtonElement>(".duration-value")!;
    setText(button, combined ? view.durationText : durationView.text);
  }
  sourceContainer(duration).querySelector(".duration-value")?.setAttribute("aria-label",
    durationLabel(durationView, durationNames.get(duration) ?? row.dataset.host ?? "host"));
  let details = joined?.querySelector<HTMLButtonElement>(".queued-duration-details");
  if (sharedDetails) {
    if (!details) {
      details = document.createElement("button");
      details.type = "button";
      details.className = "queued-duration-details";
      details.addEventListener("click", () => sourceDetails(queue, "Queued / Duration"));
      joined!.append(details);
    }
    details.hidden = false;
    details.setAttribute("aria-label", `Queued / Duration. ${joined!.title} Open details.`);
    for (const cell of [queue, duration]) {
      const container = sourceContainer(cell);
      if (oldFocus instanceof HTMLButtonElement && container.contains(oldFocus)) {
        combinedSourceFocus.set(row, oldFocus);
        details.focus({ preventScroll: true });
        focusTransferred = true;
      }
      container.inert = true;
      container.setAttribute("aria-hidden", "true");
      container.querySelector("button")?.setAttribute("tabindex", "-1");
    }
  } else if (details) {
    if (oldFocus === details) {
      const previous = combinedSourceFocus.get(row);
      const available = (button: HTMLButtonElement | undefined): button is HTMLButtonElement =>
        Boolean(button && !button.closest(".queued-duration-source[hidden]"));
      const next = available(previous) ? previous : [queue, duration]
        .map(cell => sourceContainer(cell).querySelector<HTMLButtonElement>("button") ?? undefined)
        .find(available);
      next?.focus({ preventScroll: true });
      focusTransferred = next !== undefined;
    }
    details.hidden = true;
  }
  queue.hidden = duration.hidden = combined;
  if (joined) joined.hidden = !combined;
  // A suppressed placeholder has no keyboard/AT stop. Transfer its focus to the
  // surviving source if it was focused when the layout changed.
  if (oldFocus instanceof HTMLElement && !focusTransferred &&
      row.contains(oldFocus) && oldFocus.closest("[hidden]")) {
    row.querySelector<HTMLButtonElement>(combined
      ? 'td[data-col="queued-duration"] .queued-duration-source:not([hidden]) button'
      : 'td[data-col="duration"] button')?.focus({ preventScroll: true });
  }
}

element("queued-duration-layout-toggle").addEventListener("click", () => {
  queuedDurationLayout = queuedDurationLayout === "combined" ? "separate" : "combined";
  try {
    localStorage.setItem(QUEUED_DURATION_LAYOUT_KEY, queuedDurationLayout);
  } catch {
    // The current page still remembers the selected layout.
  }
  renderQueuedDurationHeader();
  for (const row of element("fleet-rows").querySelectorAll<HTMLTableRowElement>("tr[data-host]")) {
    renderQueuedDurationRow(row);
  }
  for (const cell of element("fleet-rows").querySelectorAll<HTMLTableCellElement>(".empty-message")) {
    cell.colSpan = COLUMNS.length + (queuedDurationLayout === "combined" ? 0 : 1);
  }
});

const select = element<HTMLSelectElement>("scenario");
const suppliedOption = document.createElement("option");
suppliedOption.value = "supplied";
suppliedOption.textContent = "Supplied Host Addresses";
select.append(suppliedOption);
const real200Option = document.createElement("option");
real200Option.value = "real200";
real200Option.textContent = "Real200";
select.append(real200Option);
const onlineOption = document.createElement("option");
onlineOption.value = "online-gpu-hosts";
onlineOption.textContent = "Online GPU Hosts";
select.append(onlineOption);
const sampleOptions = document.createElement("optgroup");
sampleOptions.label = "Synthetic scenarios";
for (const scenario of SCENARIOS) {
  const option = document.createElement("option");
  option.value = scenario.id;
  option.textContent = scenario.label;
  sampleOptions.append(option);
}
select.append(sampleOptions);
if (fleetConfig.sourceMode === "snapshot") {
  select.replaceChildren(suppliedOption);
  suppliedOption.textContent = "Fleet";
  const scenarioLabel = select.closest("label");
  if (scenarioLabel) scenarioLabel.hidden = true;
  else select.hidden = true;
  for (const id of ["advance-time", "reset-sample"]) element(id).hidden = true;
  document.querySelector(".sample-controls")?.setAttribute("aria-label", "Fleet display controls");
}
// Switching live scenarios starts a new page. Only Online GPU Hosts maintains
// membership dynamically, with each data read bound to a server-issued revision.
const liveScenario = requestedScenario === "online-gpu-hosts" ? "online-gpu-hosts"
  : requestedScenario === "real200" ? "real200" : "supplied";
const onlineScenario = liveScenario === "online-gpu-hosts";
let onlineStatus: OnlineRosterStatus | undefined;
let onlineRosterError: string | null = null;
let onlineExpiryTimer: ReturnType<typeof setTimeout> | undefined;
function previewURL(resource: FleetResource | "hosts"): string {
  return fleetResourceURL(fleetConfig, resource, liveScenario, onlineStatus?.revision ?? undefined);
}
const initialSample = SCENARIOS.find((scenario) => scenario.id === requestedScenario);
let supplied = initialSample === undefined;
let selected: ScenarioId = initialSample?.id ?? "mixed";
select.value = supplied ? liveScenario : selected;
let suppliedAddresses: readonly string[] = [];
// Display admission is independent of the server-owned candidate roster. Keep
// original admitted proof deadlines even if a large render crosses their expiry.
let displayedOnlineHosts = new Map<string, number>();
const activityDisplay = new LiveActivityDisplay();
let inputError: string | null = null;
let inputLoading = true;
let rosterEstablished = false;
let rosterReadPending = false;
let metadataRecords = new Map<string, HostMetadataRecord>();
let metadataLoading = false;
let metadataAttempted = false;
let metadataError: string | null = null;
let metadataRefreshDueAt: RefreshDeadline | null = null;
let nodeInfoRecords = new Map<string, NodeInfoRecord>();
let nodeInfoLoading = false;
let nodeInfoAttempted = false;
let nodeInfoError: string | null = null;
let stateExpiryTimer: ReturnType<typeof setTimeout> | undefined;
let stateRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let stateRefreshDueAt: RefreshDeadline | null = null;
let stateProviderNextAt: number | null | undefined;
let stateWatching = false;
let jobRecords = new Map<string, JobRecord>();
let jobsLoading = false;
let jobsAttempted = false;
let jobsError: string | null = null;
let jobRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let jobTickTimer: ReturnType<typeof setTimeout> | undefined;
let jobRefreshDueAt: RefreshDeadline | null = null;
let jobProviderNextAt: number | null | undefined;
let jobWaitReason: "retry-after" | "local-budget" | "discovery-budget" | null = null;
let jobWaitUntilMs: number | null = null;
let jobRefreshRequested = false;
let queueRecords = new Map<string, QueueRecord>();
let queueLoading = false;
let queueAttempted = false;
let queueError: string | null = null;
let queueRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let queueExpiryTimer: ReturnType<typeof setTimeout> | undefined;
let queueRefreshDueAt: RefreshDeadline | null = null;
let queueProviderNextAt: number | null | undefined;
let queueWatching = false;
let solRecords = new Map<string, SolRecord>();
let solLoading = false;
let solAttempted = false;
let solError: string | null = null;
let solRefreshDueAt: RefreshDeadline | null = null;
let solRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let solExpiryTimer: ReturnType<typeof setTimeout> | undefined;
let nosRecords = new Map<string, NosRecord>();
let nosLoading = false;
let nosAttempted = false;
let nosError: string | null = null;
let nosRefreshDueAt: RefreshDeadline | null = null;
let nosRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let nosExpiryTimer: ReturnType<typeof setTimeout> | undefined;
let stakingRecords = new Map<string, StakingRecord>();
let stakingLoading = false;
let stakingAttempted = false;
let stakingError: string | null = null;
let stakingRefreshDueAt: RefreshDeadline | null = null;
let stakingRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let stakingExpiryTimer: ReturnType<typeof setTimeout> | undefined;
let stakingMarketRefreshRequested = false;
type ReadKind = "metadata" | "state" | "jobs" | "queue" | "sol" | "nos" | "staking";
const activeReads = new Map<ReadKind, AbortController>();
let progressRenderTimer: ReturnType<typeof setTimeout> | undefined;
let clockRenderPending = false;
let freshnessRenderPending = false;
const progressRows = new Map<string, Set<ReadKind>>();
let pageHidden = false;

function startRead(kind: ReadKind): AbortController {
  const controller = new AbortController();
  activeReads.set(kind, controller);
  return controller;
}

function currentRead(kind: ReadKind, controller: AbortController): boolean {
  return activeReads.get(kind) === controller && !controller.signal.aborted && visibleStateView();
}

/** Drop ownership synchronously so visibility can resume before an old fetch settles. */
function pauseReads(): void {
  // Selecting a synthetic example pauses collection without suspending the
  // browser's elapsed clock. Only page lifecycle suspension loses time trust.
  if (pageHidden || document.visibilityState !== "visible") evidenceClock.suspend();
  if (progressRenderTimer !== undefined) clearTimeout(progressRenderTimer);
  progressRenderTimer = undefined;
  progressRows.clear();
  clockRenderPending = false;
  freshnessRenderPending = false;
  for (const controller of activeReads.values()) controller.abort();
  if (activeReads.has("metadata")) metadataAttempted = false;
  if (activeReads.has("state")) nodeInfoAttempted = false;
  if (activeReads.has("jobs")) jobsAttempted = false;
  if (activeReads.has("queue")) queueAttempted = false;
  if (activeReads.has("sol")) { solAttempted = false; solRefreshDueAt = null; }
  if (activeReads.has("nos")) { nosAttempted = false; nosRefreshDueAt = null; }
  if (activeReads.has("staking")) { stakingAttempted = false; stakingRefreshDueAt = null; }
  activeReads.clear();
  metadataLoading = nodeInfoLoading = jobsLoading = queueLoading = solLoading = nosLoading = stakingLoading = false;
  jobRefreshRequested = false;
  stateWatching = queueWatching = false;
}

/** Coalesce completions, updating only their connected rows unless sorting needs them. */
function scheduleProgressRender(kind: ReadKind, records: readonly { address: string }[]): void {
  for (const record of records) {
    const kinds = progressRows.get(record.address) ?? new Set<ReadKind>();
    kinds.add(kind);
    progressRows.set(record.address, kinds);
  }
  if (progressRenderTimer !== undefined || !visibleStateView()) return;
  progressRenderTimer = setTimeout(() => {
    progressRenderTimer = undefined;
    if (!visibleStateView()) { progressRows.clear(); return; }
    const updates = [...progressRows];
    progressRows.clear();
    const needsSort = updates.some(([, kinds]) =>
      ["duration", "queued", "state"].includes(activeSort.column) ||
      kinds.has("metadata") && isMetadataColumn(activeSort.column) ||
      kinds.has("sol") && activeSort.column === "sol" ||
      kinds.has("state") && ["state", "api", "dl", "ul", "ping"].includes(activeSort.column));
    const clockChanged = clockRenderPending;
    const freshnessChanged = freshnessRenderPending;
    clockRenderPending = false;
    freshnessRenderPending = false;
    if (needsSort || clockChanged || freshnessChanged || onlineMembershipChanged(liveNow())) render();
    else {
      const at = liveNow();
      const rows = new Map([...element("fleet-rows").querySelectorAll<HTMLTableRowElement>('tr[data-source="supplied"]')]
        .map(row => [row.dataset.host!, row]));
      for (const [address, kinds] of updates) {
        const row = rows.get(address);
        if (!row) continue;
        if (kinds.has("sol")) {
          const cell = row.querySelector<HTMLTableCellElement>('td[data-col="sol"]');
          if (cell) renderSolCell(cell, address, at);
          if (kinds.size === 1) continue;
        }
        if (kinds.has("metadata")) for (const key of METADATA_COLUMNS) {
          const cell = row.querySelector<HTMLTableCellElement>(`td[data-col="${key}"]`);
          const label = COLUMNS.find(column => column[0] === key)![1];
          if (cell) renderMetadataCell(cell, key, label, address, metadataRecords.get(address));
        }
        if (kinds.has("state")) for (const key of ["state", "api", "dl", "ul", "ping"] as const) {
          const cell = row.querySelector<HTMLTableCellElement>(`td[data-col="${key}"]`);
          if (cell) renderNodeInfoCell(cell, key, address, nodeInfoRecords.get(address), at);
        }
        if (!kinds.has("state")) {
          const stateCell = row.querySelector<HTMLTableCellElement>('td[data-col="state"]');
          if (stateCell) renderNodeInfoCell(stateCell, "state", address, nodeInfoRecords.get(address), at);
        }
        const duration = row.querySelector<HTMLTableCellElement>('td[data-col="duration"]');
        const queue = row.querySelector<HTMLTableCellElement>('td[data-col="queued"]');
        if (duration) renderLiveDuration(duration, address, at);
        if (queue) renderLiveQueue(queue, address, at);
        renderQueuedDurationRow(row);
        const staking = row.querySelector<HTMLTableCellElement>('td[data-col="stakedNos"]');
        if (staking && kinds.has("metadata")) renderStakingCell(staking, address, at);
      }
      renderSuppliedStatus(at);
      // Painting a large progress frame can itself cross an admission deadline.
      // Reconcile in this task, before observers/paint can see a stale API row.
      if (onlineMembershipChanged(liveNow())) renderSupplied();
      else scheduleStateExpiry();
    }
    scheduleQueueExpiry();
    scheduleJobTick();
    scheduleStakingExpiry();
    scheduleSolExpiry();
    scheduleNosExpiry();
    if (clockChanged) {
      scheduleStateRefresh();
      scheduleJobRefresh();
      scheduleQueueRefresh();
      scheduleSolRefresh();
      scheduleNosRefresh();
      scheduleStakingRefresh();
    }
  }, 16);
}

/** The transport owns bounds/identities; each column applies its original source rules. */
async function readProgressive<T extends { address: string }>(
  resource: FleetResource, kind: ReadKind, controller: AbortController,
  valid: (value: unknown) => value is T,
  apply: (records: T[], complete: boolean, payload: Record<string, unknown>) => void,
): Promise<void> {
  await fleetTransport.read(resource, previewURL(resource), {
    addresses: suppliedAddresses, signal: controller.signal, current: () => currentRead(kind, controller),
    ...(onlineStatus?.revision ? { onlineRevision: onlineStatus.revision } : {}),
    onSnapshot: (snapshot, complete, payload) => {
      const records: unknown[] = snapshot.hosts;
      if (!records.every(valid)) throw new Error("Invalid Fleet observations.");
      apply(records, complete, payload);
    },
  });
}

function resumeVisibleView(): void {
  if (!visibleStateView()) { pauseReads(); onlineRosterController?.pause(); }
  else {
    void onlineRosterController?.resume();
    // Reuse an ordinary resumed read for calibration whenever one is already
    // due. Finite providers otherwise need one metadata read after OS sleep,
    // during which performance.now can pause and hide overdue source deadlines.
    const dueData = ([
      [nodeInfoAttempted, stateRefreshDueAt], [jobsAttempted, jobRefreshDueAt],
      [queueAttempted, queueRefreshDueAt], [solAttempted, solRefreshDueAt],
      [nosAttempted, nosRefreshDueAt], [stakingAttempted, stakingRefreshDueAt],
    ] satisfies [boolean, RefreshDeadline | null][]).some(([attempted, deadline]) =>
      !attempted || deadline !== null && deadlines.remaining(deadline) <= 0);
    if (!metadataAttempted || metadataRefreshDueAt !== null && deadlines.remaining(metadataRefreshDueAt) <= 0 ||
        !evidenceClock.trusted && !dueData && activeReads.size === 0) void loadMetadata();
  }
  resumeStateView();
  resumeJobView();
  resumeQueueView();
  resumeSolView();
  resumeNosView();
  resumeStakingView();
  renderOnlineRosterStatus();
}
let sampleNow = SAMPLE_TIME;
let inventory = sampleInventory(selected);

function solDeadline(record: SolRecord): number | null {
  return record.checkedAtMs === null || record.validUntilMs === null ? null
    : Math.min(record.validUntilMs, record.checkedAtMs + SOL_DISPLAY_VALIDITY_MS);
}

function solCurrent(record: SolRecord | undefined, at: number): boolean {
  if (!evidenceClock.trusted) return false;
  if (record === undefined || record.lamports === null || record.retained || record.error !== null || solError !== null) return false;
  const deadline = solDeadline(record);
  return deadline !== null && at < deadline && freshnessNow() < deadline;
}

function renderSolCell(cell: HTMLTableCellElement, address: string, at: number): void {
  const record = solRecords.get(address);
  const known = record?.lamports != null;
  const current = solCurrent(record, at);
  rememberDisplayExpiry(cell, current ? solDeadline(record!) : null);
  const text = formatSol(record?.lamports);
  const issue = record?.error ?? solError;
  const details = `Host Address: ${address}\nSOL: ${formatSol(record?.lamports, false)}\nExact lamports: ${record?.lamports ?? "unknown"}\nCommitment: confirmed\nProvider: ${record?.provider ?? "not received"}${record?.endpoint ? ` (${record.endpoint})` : ""}\nContext slot: ${record?.contextSlot ?? "not received"}\nOldest provider batch estimated block time: ${timestamp(record?.blockTimeMs ?? null)}\nAPI check time: ${timestamp(record?.checkedAtMs ?? null)}\nLocal validity deadline: ${timestamp(record?.validUntilMs ?? null)}\n\n${known ? current ? "Current validated balance." : "Retained from the last successful read; current balance is unknown." : "Balance unknown. A missing account or failed check does not establish a zero balance."} ${fleetConfig.sourceMode === "snapshot" ? "This view reads backend snapshots without changing original source times." : "Public RPC checks are best effort, with one shared 30-second refresh deadline across viewers."}${issue ? `\nRead unavailable: ${issue}` : ""}${record?.retryAtMs ? `\nNext eligible retry: ${timestamp(record.retryAtMs)}` : ""}`;
  cell.dataset.solState = !known ? "unknown" : current ? "current" : "retained";
  const value = cell.querySelector<HTMLButtonElement>(".sol-value") ?? document.createElement("button");
  value.type = "button";
  const classes = `sol-value${!known ? " sol-unknown" : current ? "" : " sol-retained"}`;
  if (value.className !== classes) value.className = classes;
  setText(value, text);
  value.setAttribute("aria-label", `SOL: ${text} for ${address}. Open details.`);
  rememberInfo(cell, {
    summary: [ink(!known ? "SOL balance unknown" : `${current ? "SOL" : "Last known SOL"}: ${formatSol(record?.lamports, false)}`,
      !known ? "warning" : current ? "accent" : "muted"), ink(".")],
    facts: ["Scope: balance at this host address.",
      [ink(!known ? "No verified amount yet; unknown is not zero." : current ? "Current reading." : "Retained reading; current balance is unconfirmed.",
        current ? "plain" : "warning")],
      checkedFact(record?.checkedAtMs),
      record?.retryAtMs ? checkedFact(record.retryAtMs, "Next retry") : `Source: ${record?.provider ?? "public Solana RPC"}.`],
    source: details,
  }, value);
  value.onclick = () => openCellInfo(cell, "SOL balance");
  if (!value.parentElement) cell.replaceChildren(value);
}

function renderSolStatus(at: number): void {
  const notice = element("sol-status");
  notice.hidden = !supplied || inputLoading || inputError !== null || suppliedAddresses.length === 0;
  if (notice.hidden) return;
  const current = [...solRecords.values()].filter(record => solCurrent(record, at)).length;
  const retained = [...solRecords.values()].filter(record => record.lamports !== null && !solCurrent(record, at)).length;
  const failed = solError !== null || [...solRecords.values()].some(record => record.error !== null);
  setText(notice, solLoading && solRecords.size === 0 && solError === null ? "Reading confirmed SOL balances…"
    : `${candidateCoveragePrefix()}${current}/${suppliedAddresses.length} current SOL balances${retained ? ` · ${retained} retained gray` : ""}. Best-effort checks every 30 seconds while visible; readings expire after 60 seconds.${failed ? ` Some reads are unavailable.${solRefreshDueAt !== null ? ` Next eligible retry: ${timestamp(deadlines.at(solRefreshDueAt))}.` : ""}` : ""}`);
}

function updateSol(): void {
  const at = liveNow();
  for (const row of element("fleet-rows").querySelectorAll<HTMLTableRowElement>('tr[data-source="supplied"]')) {
    const cell = row.querySelector<HTMLTableCellElement>('td[data-col="sol"]');
    if (cell) renderSolCell(cell, row.dataset.host!, at);
  }
  renderSolStatus(at);
}

function scheduleSolExpiry(): void {
  if (solExpiryTimer !== undefined) clearTimeout(solExpiryTimer);
  solExpiryTimer = undefined;
  if (!visibleStateView()) return;
  const deadlines = displayedExpiryDates(["sol"]);
  if (deadlines.length === 0) return;
  solExpiryTimer = setTimeout(() => {
    solExpiryTimer = undefined;
    if (!visibleStateView()) return;
    updateSol();
    scheduleSolExpiry();
  }, Math.max(1, Math.min(...deadlines) - freshnessNow()));
}

function scheduleSolRefresh(): void {
  if (solRefreshTimer !== undefined) clearTimeout(solRefreshTimer);
  solRefreshTimer = undefined;
  if (!visibleStateView() || solLoading || inputLoading || inputError || suppliedAddresses.length === 0 || solRefreshDueAt === null) return;
  solRefreshTimer = setTimeout(() => {
    solRefreshTimer = undefined;
    if (visibleStateView()) void loadSol();
  }, Math.max(1, deadlines.remaining(solRefreshDueAt)));
}

function resumeSolView(): void {
  if (visibleStateView()) {
    updateSol();
    if (!solAttempted) void loadSol();
  }
  scheduleSolRefresh();
  scheduleSolExpiry();
}

async function loadSol(): Promise<void> {
  if (solLoading || inputLoading || inputError || suppliedAddresses.length === 0 || !visibleStateView() ||
      solAttempted && solRefreshDueAt !== null && deadlines.remaining(solRefreshDueAt) > 0) return;
  solAttempted = true;
  solLoading = true;
  const controller = startRead("sol");
  if (solRefreshTimer !== undefined) clearTimeout(solRefreshTimer);
  solRefreshTimer = undefined;
  renderSolStatus(liveNow());
  try {
    await readProgressive("sol", "sol", controller, isSolRecord, (records, complete, payload) => {
      if (records.some(record => record.checkedAtMs !== null && record.checkedAtMs > liveNow() + 15_000 ||
          record.blockTimeMs !== null && record.blockTimeMs > liveNow() + 15_000) ||
          !("nextRefreshAtMs" in payload) || payload.nextRefreshAtMs !== null &&
          (typeof payload.nextRefreshAtMs !== "number" || !Number.isFinite(payload.nextRefreshAtMs))) {
        throw new Error("Invalid SOL response.");
      }
      if (complete) {
        solRecords = new Map(records.map(record => [record.address, record]));
        solRefreshDueAt = deadlines.source(payload.nextRefreshAtMs);
      } else for (const record of records) solRecords.set(record.address, record);
      solError = null;
      if (!complete) scheduleProgressRender("sol", records);
    });
  } catch (error) {
    if (!currentRead("sol", controller)) return;
    solError = fleetReadError(error, "The confirmed SOL balances could not be loaded.");
    solRefreshDueAt = deadlines.after(SOL_REFRESH_INTERVAL_MS);
  } finally {
    if (!currentRead("sol", controller)) return;
    activeReads.delete("sol");
    solLoading = false;
    if (activeSort.column === "sol") renderSupplied();
    else updateSol();
    scheduleSolRefresh();
    scheduleSolExpiry();
  }
}

function nosDeadline(record: NosRecord): number | null {
  return record.checkedAtMs === null || record.validUntilMs === null ? null
    : Math.min(record.validUntilMs, record.checkedAtMs + NOS_DISPLAY_VALIDITY_MS);
}

function nosCurrent(record: NosRecord | undefined, at: number): boolean {
  if (!evidenceClock.trusted) return false;
  if (record === undefined || record.amount === null || record.retained || record.error !== null || nosError !== null) return false;
  const deadline = nosDeadline(record);
  return deadline !== null && at < deadline && freshnessNow() < deadline;
}

function renderNosCell(cell: HTMLTableCellElement, address: string, at: number): void {
  const record = nosRecords.get(address);
  const known = record?.amount != null;
  const current = nosCurrent(record, at);
  rememberDisplayExpiry(cell, current ? nosDeadline(record!) : null);
  const text = formatNos(record?.amount);
  const issue = record?.error ?? nosError;
  const scope = "Standard associated token account only; additional wallet token accounts, staking and claimable rewards are excluded.";
  const accountState = record?.accountState === "absent" ? "Absent: a fresh confirmed lookup established zero in this standard account."
    : record?.accountState === "frozen" ? "Frozen at the recorded check: transfers are restricted while frozen; the recorded balance remains visible."
      : record?.accountState === "initialized" ? "Initialized" : "Unknown";
  const details = `Host Address: ${address}\nNOS: ${formatNos(record?.amount, false)}\nExact base units: ${record?.amount ?? "unknown"}\nDecimals: 6\nMint: ${record?.mint ?? NOS_MINT}\nAssociated token account: ${record?.tokenAccount ?? "not received"}\nAccount state: ${accountState}\nScope: ${scope}\nCommitment: confirmed\nProvider: ${record?.provider ?? "not received"}${record?.endpoint ? ` (${record.endpoint})` : ""}\nContext slot: ${record?.contextSlot ?? "not received"}\nOldest provider batch estimated block time: ${timestamp(record?.blockTimeMs ?? null)}\nAPI check time: ${timestamp(record?.checkedAtMs ?? null)}\nLocal validity deadline: ${timestamp(record?.validUntilMs ?? null)}\n\n${known ? current ? "Current validated balance." : "Retained from the last successful read; current balance is unknown." : "Balance unknown. Failed or malformed checks do not establish a zero balance."} ${fleetConfig.sourceMode === "snapshot" ? "This view reads backend snapshots without changing original source times." : "Public RPC checks are best effort, with one shared two-minute refresh deadline across viewers."}${issue ? `\nRead unavailable: ${issue}` : ""}${record?.retryAtMs ? `\nNext eligible retry: ${timestamp(record.retryAtMs)}` : ""}`;
  cell.dataset.nosState = !known ? "unknown" : current ? "current" : "retained";
  const value = rowValue(cell, "nos-value");
  const classes = `nos-value${!known ? " nos-unknown" : current ? "" : " nos-retained"}`;
  if (value.className !== classes) value.className = classes;
  setText(value, text);
  value.setAttribute("aria-label", `${known && !current ? "Last known NOS" : "NOS"}: ${known ? text : "unknown"} for ${address}. Open details.`);
  rememberInfo(cell, {
    summary: [ink(!known ? "NOS balance unknown" : `${current ? "NOS" : "Last known NOS"}: ${formatNos(record?.amount, false)}`,
      !known ? "warning" : current ? "accent" : "muted"), ink(".")],
    facts: ["Standard token account only; other accounts, staking and rewards are separate.",
      [ink(record?.accountState === "frozen" ? "Account was frozen at the recorded check; transfers are restricted."
        : !known ? "No verified amount yet; unknown is not zero." : current ? "Current reading." : "Retained reading; current balance is unconfirmed.",
        record?.accountState === "frozen" || !current ? "warning" : "plain")],
      checkedFact(record?.checkedAtMs),
      record?.retryAtMs ? checkedFact(record.retryAtMs, "Next retry") : `Source: ${record?.provider ?? "public Solana RPC"}.`],
    source: details,
  }, value);
  value.onclick = hasRowInformation(cell) ? () => openCellInfo(cell, "NOS balance") : null;
  if (!value.parentElement) cell.replaceChildren(value);
}

function renderNosStatus(at: number): void {
  const notice = element("nos-status");
  notice.hidden = !supplied || inputLoading || inputError !== null || suppliedAddresses.length === 0;
  if (notice.hidden) return;
  const current = [...nosRecords.values()].filter(record => nosCurrent(record, at)).length;
  const retained = [...nosRecords.values()].filter(record => record.amount !== null && !nosCurrent(record, at)).length;
  const failed = nosError !== null || [...nosRecords.values()].some(record => record.error !== null);
  setText(notice, nosLoading && nosRecords.size === 0 && nosError === null ? "Reading confirmed NOS balances…"
    : `${candidateCoveragePrefix()}${current}/${suppliedAddresses.length} current NOS balances${retained ? ` · ${retained} retained gray` : ""}. Best-effort checks every two minutes while visible; readings expire after three minutes.${failed ? ` Some reads are unavailable.${nosRefreshDueAt !== null ? ` Next eligible retry: ${timestamp(deadlines.at(nosRefreshDueAt))}.` : ""}` : ""}`);
}

function updateNos(): void {
  const at = liveNow();
  for (const row of element("fleet-rows").querySelectorAll<HTMLTableRowElement>('tr[data-source="supplied"]')) {
    const cell = row.querySelector<HTMLTableCellElement>('td[data-col="nos"]');
    if (cell) renderNosCell(cell, row.dataset.host!, at);
  }
  renderNosStatus(at);
}

function scheduleNosExpiry(): void {
  if (nosExpiryTimer !== undefined) clearTimeout(nosExpiryTimer);
  nosExpiryTimer = undefined;
  if (!visibleStateView()) return;
  const deadlines = displayedExpiryDates(["nos"]);
  if (deadlines.length === 0) return;
  nosExpiryTimer = setTimeout(() => {
    nosExpiryTimer = undefined;
    if (!visibleStateView()) return;
    updateNos();
    scheduleNosExpiry();
  }, Math.max(1, Math.min(...deadlines) - freshnessNow()));
}

function scheduleNosRefresh(): void {
  if (nosRefreshTimer !== undefined) clearTimeout(nosRefreshTimer);
  nosRefreshTimer = undefined;
  if (!visibleStateView() || nosLoading || inputLoading || inputError || suppliedAddresses.length === 0 || nosRefreshDueAt === null) return;
  nosRefreshTimer = setTimeout(() => {
    nosRefreshTimer = undefined;
    if (visibleStateView()) void loadNos();
  }, Math.max(1, deadlines.remaining(nosRefreshDueAt)));
}

function resumeNosView(): void {
  if (visibleStateView()) {
    updateNos();
    if (!nosAttempted) void loadNos();
  }
  scheduleNosRefresh();
  scheduleNosExpiry();
}

async function loadNos(): Promise<void> {
  if (nosLoading || inputLoading || inputError || suppliedAddresses.length === 0 || !visibleStateView() ||
      nosAttempted && nosRefreshDueAt !== null && deadlines.remaining(nosRefreshDueAt) > 0) return;
  nosAttempted = true;
  nosLoading = true;
  const controller = startRead("nos");
  if (nosRefreshTimer !== undefined) clearTimeout(nosRefreshTimer);
  nosRefreshTimer = undefined;
  renderNosStatus(liveNow());
  try {
    const payload = await fleetTransport.read("nos", previewURL("nos"), {
      addresses: suppliedAddresses, signal: controller.signal, current: () => currentRead("nos", controller), progressive: false,
      ...(onlineStatus?.revision ? { onlineRevision: onlineStatus.revision } : {}),
    });
    if (!currentRead("nos", controller)) return;
    if (payload === null || typeof payload !== "object" || !("hosts" in payload) || !Array.isArray(payload.hosts) ||
        !payload.hosts.every(isNosRecord) || payload.hosts.length !== suppliedAddresses.length ||
        payload.hosts.some(record => record.checkedAtMs !== null && record.checkedAtMs > liveNow() + 15_000 ||
          record.blockTimeMs !== null && record.blockTimeMs > liveNow() + 15_000) ||
        new Set(payload.hosts.map(record => record.address)).size !== suppliedAddresses.length ||
        !payload.hosts.every(record => suppliedAddresses.includes(record.address)) ||
        !("nextRefreshAtMs" in payload) || payload.nextRefreshAtMs !== null &&
        (typeof payload.nextRefreshAtMs !== "number" || !Number.isFinite(payload.nextRefreshAtMs))) throw new Error("Invalid NOS response.");
    nosRecords = new Map(payload.hosts.map(record => [record.address, record]));
    nosError = null;
    nosRefreshDueAt = deadlines.source(payload.nextRefreshAtMs);
  } catch (error) {
    if (!currentRead("nos", controller)) return;
    nosError = fleetReadError(error, "The confirmed NOS balances could not be loaded.");
    nosRefreshDueAt = deadlines.after(NOS_REFRESH_INTERVAL_MS);
  } finally {
    if (!currentRead("nos", controller)) return;
    activeReads.delete("nos");
    nosLoading = false;
    if (activeSort.column === "nos") renderSupplied();
    else updateNos();
    scheduleNosRefresh();
    scheduleNosExpiry();
  }
}

function stakingView(address: string, at: number) {
  const view = projectStaking(stakingRecords.get(address), metadataRecords.get(address), at, stakingError, metadataError,
    supplied ? freshnessNow() : at);
  return !supplied || evidenceClock.trusted ? view : { ...view, amountCurrent: false, targetCurrent: false,
    marketCurrent: false, comparisonCurrent: false, satisfied: false, nextExpiryAtMs: null };
}

function renderStakingCell(cell: HTMLTableCellElement, address: string, at: number): void {
  const record = stakingRecords.get(address);
  const view = stakingView(address, at);
  rememberDisplayExpiry(cell, supplied ? view.nextExpiryAtMs : null);
  const actual = formatStakingAmount(view.amount);
  const required = formatStakingAmount(view.target);
  const known = view.amount !== null || view.target !== null;
  // projectStaking hides targets from a changed/unknown market. A matching
  // retained pair can still explain its old comparison, always in gray.
  const comparisonKnown = view.amount !== null && view.target !== null;
  const satisfiesTarget = comparisonKnown && BigInt(view.amount!) >= BigInt(view.target!);
  const comparisonLabel = !comparisonKnown ? "comparison unknown"
    : view.comparisonCurrent ? satisfiesTarget ? "meets the current target" : "below the current target"
      : satisfiesTarget ? "retained comparison: met the target; current comparison unknown"
        : "retained comparison: below the target; current comparison unknown";
  const evidence = (reading: StakingRecord["stake"] | StakingRecord["requirement"] | undefined): string =>
    `Provider: ${reading?.provider ?? "not received"}${reading?.endpoint ? ` (${reading.endpoint})` : ""}\nContext slot: ${reading?.contextSlot ?? "not received"}\nOldest provider batch estimated block time: ${timestamp(reading?.blockTimeMs ?? null)}\nAPI check time: ${timestamp(reading?.checkedAtMs ?? null)}\nLocal validity deadline: ${timestamp(reading?.validUntilMs ?? null)}${reading?.error ? `\nRead unavailable: ${reading.error}` : ""}${reading?.retryAtMs ? `\nNext eligible retry: ${timestamp(reading.retryAtMs)}` : ""}`;
  const unstaking = record?.stake.unstakeAtSeconds == null ? "Unknown"
    : record.stake.unstakeAtSeconds === "0" ? "Not releasing at the recorded check"
      : `Unstaking/releasing (on-chain timestamp, Unix seconds: ${record.stake.unstakeAtSeconds}). Vault NOS remains included until withdrawn; this does not establish active stake eligibility.`;
  const details = `Host Address: ${address}\nStaked NOS (current vault holdings): ${formatStakingAmount(view.amount, false)}\nExact vault base units: ${view.amount ?? "unknown"}\nDecimals: 6\nMint: ${record?.stake.mint ?? NOS_MINT}\nStaking account: ${record?.stake.stakeAccount ?? "not received"}\nStaking vault: ${record?.stake.vaultAccount ?? "not received"}\nAccount state: ${record?.stake.accountState ?? "unknown"}\nRecorded stake ledger amount: ${formatStakingAmount(record?.stake.recordedAmount, false)} NOS\nRecorded duration-weighted xNOS: ${formatStakingAmount(record?.stake.xnos, false)}\nStake duration (seconds): ${record?.stake.durationSeconds ?? "unknown"}\nUnstaking status: ${unstaking}\n${evidence(record?.stake)}\n\nCurrent reported market: ${view.marketAddress ?? "unknown"}\nMarket assignment check: ${timestamp(metadataRecords.get(address)?.fetchedAtMs ?? record?.marketFetchedAtMs ?? null)}\nRequirement source market: ${record?.requirement.marketAddress ?? "not received"}\nNOS target (node display convention): ${formatStakingAmount(view.target, false)}\nExact target base units: ${view.target ?? "unknown"}\nOn-chain duration-weighted xNOS minimum: ${formatStakingAmount(record?.requirement.xnosMinimum, false)}\n${evidence(record?.requirement)}\n\nCommitment: confirmed. The denominator follows the Nosana node software’s displayed NOS target. On-chain xNOS incorporates stake duration; unstaking status and other market requirements are separate. A dull-green checkmark means current, unrounded vault NOS meets the current market’s displayed target; a red lowercase x means it is below that target. Amount view uses bright green or red for the same exact comparison. Gray symbols retain a previous comparison; a dash means the comparison is unknown. The comparison does not establish full market eligibility.\n${view.amountCurrent ? "Current validated vault amount." : view.amount !== null ? "Vault amount retained from the last successful read; current holdings are unknown." : "Vault amount unknown. Only verified absence of both staking account and vault establishes zero."} ${view.targetCurrent ? "Current target and market assignment." : "Current target comparison unavailable; failed, expired or changed market evidence cannot highlight the amount."}\nBest-effort shared checks every 30 minutes while visible; staking and requirement readings expire after 35 minutes.${stakingError ? `\nRead unavailable: ${stakingError}` : ""}${metadataError || metadataRecords.get(address)?.error || record?.marketError ? `\nMarket assignment unavailable: ${metadataError ?? metadataRecords.get(address)?.error ?? record?.marketError}` : ""}`;
  cell.dataset.stakingState = !known ? "unknown" : view.comparisonCurrent ? "current" : "retained";
  cell.dataset.stakingMode = stakingMode;
  const value = cell.querySelector<HTMLButtonElement>(".staking-value") ?? document.createElement("button");
  value.type = "button";
  if (value.className !== "staking-value") value.className = "staking-value";
  const amount = value.querySelector<HTMLSpanElement>(".staking-actual") ?? document.createElement("span");
  const target = value.querySelector<HTMLSpanElement>(".staking-required") ?? document.createElement("span");
  const divider = value.querySelector<HTMLSpanElement>(".staking-divider") ?? document.createElement("span");
  const symbol = value.querySelector<HTMLSpanElement>(".staking-symbol") ?? document.createElement("span");
  const dividerClass = `staking-divider${known && !view.comparisonCurrent ? " staking-retained" : ""}`;
  if (divider.className !== dividerClass) divider.className = dividerClass;
  const amountClass = `staking-actual${view.amount === null ? " staking-unknown" : !view.amountCurrent ? " staking-retained" : view.satisfied ? " staking-satisfied" : view.comparisonCurrent ? " staking-shortfall" : ""}`;
  const targetClass = `staking-required${view.target === null ? " staking-unknown" : !view.targetCurrent ? " staking-retained" : ""}`;
  const symbolClass = `staking-symbol ${!comparisonKnown ? "staking-unknown" : !view.comparisonCurrent ? "staking-retained" : satisfiesTarget ? "staking-met-target" : "staking-shortfall"}`;
  if (amount.className !== amountClass) amount.className = amountClass;
  if (target.className !== targetClass) target.className = targetClass;
  if (symbol.className !== symbolClass) symbol.className = symbolClass;
  setText(amount, stakingMode === "amounts" ? actual : "");
  setText(target, stakingMode === "amounts" && known ? required : "");
  setText(divider, stakingMode === "amounts" && known ? " / " : "");
  setText(symbol, stakingMode === "symbols" ? !comparisonKnown ? "—" : satisfiesTarget ? "✓" : "x" : "");
  amount.hidden = divider.hidden = target.hidden = stakingMode === "symbols";
  symbol.hidden = stakingMode === "amounts";
  if (!amount.parentElement) value.append(amount, divider, target);
  if (!symbol.parentElement) value.append(symbol);
  value.setAttribute("aria-label", `Staked NOS: ${comparisonLabel}${known ? `, ${actual} / ${required}` : ""} for ${address}. Open details.`);
  rememberInfo(cell, {
    summary: [ink(`${view.amount === null || view.amountCurrent ? "Vault" : "Last known vault"}: `),
      ink(view.amount === null ? "unknown" : `${formatStakingAmount(view.amount, false)} NOS`, view.amount === null ? "warning" : !view.comparisonCurrent ? "muted" : satisfiesTarget ? "positive" : "negative"),
      ink(`; target: ${view.target === null ? "unknown" : `${formatStakingAmount(view.target, false)} NOS`}.`)],
    facts: [[ink(comparisonLabel.charAt(0).toUpperCase() + comparisonLabel.slice(1) + ".",
      !view.comparisonCurrent ? "warning" : satisfiesTarget ? "positive" : "negative")],
      "Vault balance includes releasing tokens; meeting this target alone does not prove market eligibility.",
      checkedFact(record?.stake.checkedAtMs, "Vault checked"),
      checkedFact(record?.requirement.checkedAtMs, "Target checked")],
    source: details,
  }, value);
  value.onclick = () => openCellInfo(cell, "Staked NOS");
  if (!value.parentElement) cell.replaceChildren(value);
}

function renderStakingStatus(at: number): void {
  const notice = element("staking-status");
  notice.hidden = !supplied || inputLoading || inputError !== null || suppliedAddresses.length === 0;
  if (notice.hidden) return;
  const views = suppliedAddresses.map(address => stakingView(address, at));
  const current = views.filter(view => view.amountCurrent).length;
  const comparisons = views.filter(view => view.comparisonCurrent).length;
  const retained = views.filter(view => view.amount !== null && !view.amountCurrent).length;
  const failed = stakingError !== null || [...stakingRecords.values()].some(record =>
    record.stake.error !== null || record.requirement.error !== null || record.marketError !== null);
  setText(notice, stakingLoading && stakingRecords.size === 0 && stakingError === null ? "Reading confirmed staking vaults and market targets…"
    : `${candidateCoveragePrefix()}${current}/${suppliedAddresses.length} current staking vault amounts · ${comparisons} current market comparisons${retained ? ` · ${retained} amounts retained gray` : ""}. Best-effort checks every 30 minutes while visible; readings expire after 35 minutes.${failed ? ` Some reads are unavailable.${stakingRefreshDueAt !== null ? ` Next eligible retry: ${timestamp(deadlines.at(stakingRefreshDueAt))}.` : ""}` : ""}`);
}

function updateStaking(): void {
  const at = liveNow();
  for (const row of element("fleet-rows").querySelectorAll<HTMLTableRowElement>('tr[data-source="supplied"]')) {
    const cell = row.querySelector<HTMLTableCellElement>('td[data-col="stakedNos"]');
    if (cell) renderStakingCell(cell, row.dataset.host!, at);
  }
  renderStakingStatus(at);
}

function scheduleStakingExpiry(): void {
  if (stakingExpiryTimer !== undefined) clearTimeout(stakingExpiryTimer);
  stakingExpiryTimer = undefined;
  if (!visibleStateView()) return;
  const deadlines = displayedExpiryDates(["stakedNos"]);
  if (deadlines.length === 0) return;
  stakingExpiryTimer = setTimeout(() => {
    stakingExpiryTimer = undefined;
    if (!visibleStateView()) return;
    updateStaking();
    scheduleStakingExpiry();
  }, Math.max(1, Math.min(...deadlines) - freshnessNow()));
}

function scheduleStakingRefresh(): void {
  if (stakingRefreshTimer !== undefined) clearTimeout(stakingRefreshTimer);
  stakingRefreshTimer = undefined;
  if (!visibleStateView() || stakingLoading || inputLoading || inputError || suppliedAddresses.length === 0 || stakingRefreshDueAt === null) return;
  stakingRefreshTimer = setTimeout(() => {
    stakingRefreshTimer = undefined;
    if (visibleStateView()) void loadStaking();
  }, Math.max(1, deadlines.remaining(stakingRefreshDueAt)));
}

function resumeStakingView(): void {
  if (visibleStateView()) {
    updateStaking();
    if (!stakingAttempted) void loadStaking();
  }
  scheduleStakingRefresh();
  scheduleStakingExpiry();
}

/** Metadata changes request the new market through the selected roster endpoint.
 * The server reuses current vault data and shared market caches. */
function refreshChangedStakingMarkets(): void {
  if (!stakingMarketRefreshRequested || stakingLoading || !visibleStateView()) return;
  stakingMarketRefreshRequested = false;
  const changed = suppliedAddresses.some(address => {
    const market = metadataRecords.get(address)?.values?.marketAddress;
    return market != null && stakingRecords.get(address)?.requirement.marketAddress !== market;
  });
  if (changed) void loadStaking(true);
}

async function loadStaking(marketChanged = false): Promise<void> {
  if (stakingLoading || inputLoading || inputError || suppliedAddresses.length === 0 || !visibleStateView() ||
      !marketChanged && stakingAttempted && stakingRefreshDueAt !== null && deadlines.remaining(stakingRefreshDueAt) > 0) return;
  stakingAttempted = true;
  stakingLoading = true;
  const controller = startRead("staking");
  if (stakingRefreshTimer !== undefined) clearTimeout(stakingRefreshTimer);
  stakingRefreshTimer = undefined;
  renderStakingStatus(liveNow());
  try {
    const payload = await fleetTransport.read("staking", previewURL("staking"), {
      addresses: suppliedAddresses, signal: controller.signal, current: () => currentRead("staking", controller), progressive: false,
      ...(onlineStatus?.revision ? { onlineRevision: onlineStatus.revision } : {}),
    });
    if (!currentRead("staking", controller)) return;
    if (payload === null || typeof payload !== "object" || !("hosts" in payload) || !Array.isArray(payload.hosts) ||
        !payload.hosts.every(isStakingRecord) || payload.hosts.length !== suppliedAddresses.length ||
        payload.hosts.some(record => [record.stake.checkedAtMs, record.stake.blockTimeMs,
          record.requirement.checkedAtMs, record.requirement.blockTimeMs, record.marketFetchedAtMs]
          .some(time => time !== null && time > liveNow() + 15_000)) ||
        new Set(payload.hosts.map(record => record.address)).size !== suppliedAddresses.length ||
        !payload.hosts.every(record => suppliedAddresses.includes(record.address)) ||
        !("nextRefreshAtMs" in payload) || payload.nextRefreshAtMs !== null &&
        (typeof payload.nextRefreshAtMs !== "number" || !Number.isFinite(payload.nextRefreshAtMs))) throw new Error("Invalid staking response.");
    stakingRecords = new Map(payload.hosts.map(record => [record.address, record]));
    stakingError = null;
    stakingRefreshDueAt = deadlines.source(payload.nextRefreshAtMs);
  } catch (error) {
    if (!currentRead("staking", controller)) return;
    stakingError = fleetReadError(error, "The confirmed staking vaults and market targets could not be loaded.");
    stakingRefreshDueAt = deadlines.after(STAKING_REFRESH_INTERVAL_MS);
  } finally {
    if (!currentRead("staking", controller)) return;
    activeReads.delete("staking");
    stakingLoading = false;
    if (activeSort.column === "stakedNos") renderSupplied();
    else updateStaking();
    scheduleStakingRefresh();
    scheduleStakingExpiry();
    refreshChangedStakingMarkets();
  }
}

function ageLabel(ageMs: number | null): string {
  if (ageMs === null) return "Unknown";
  const seconds = Math.floor(ageMs / 1_000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function timestamp(at: number | null): string {
  return at === null ? "Not received" : new Date(at).toISOString();
}

function inventoryLabel(runtime: RuntimeView): string {
  if (runtime.outcome === "missing") return "No observation yet";
  if (runtime.outcome === "failure") return runtime.inventoryObservedAtMs === null
    ? "Read failed · inventory unknown" : "Read failed · last observation retained";
  if (runtime.hosts.length === 0) return runtime.freshness === "fresh"
    ? "Confirmed empty" : "Last reading empty · now stale";
  return runtime.freshness === "fresh" ? "Current inventory" : "Stale inventory";
}

function rowDetails(pc: PCView, runtime: RuntimeView, host: HostView, duration: DurationView): string {
  return `${host.name} on ${pc.pcId}\nRuntime: ${runtime.runtimeId}\n${inventoryLabel(runtime)}\nCurrent container state: ${host.currentState}\nLast observed container state: ${host.observedState}\nSource observation: ${timestamp(pc.observedAtMs)}\nInventory observation: ${timestamp(runtime.inventoryObservedAtMs)}\nLatest attempt: ${timestamp(runtime.attemptObservedAtMs)}${runtime.error ? `\n${runtime.error}` : ""}\n\n${duration.description}\n\nInventory and job evidence are separate synthetic observations. No live data is connected.`;
}

/** Stable pseudorandom stagger: similar Host Addresses must not sweep together. */
function durationPhase(identity: string): number {
  let hash = 2_166_136_261;
  for (const character of identity) hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619);
  // Mix all input bits before choosing a phase. A simple modulo string hash
  // gives addresses differing only in their suffix almost identical delays.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return (hash >>> 0) % 10_000;
}

function durationLabel(view: DurationView, name: string): string {
  const text = view.unavailableReason === "api-offline" ? "Timing unavailable while API is Offline"
    : queuedDurationLayout === "combined" && view.kind === "queue" ? "Queued" : view.text;
  return `Duration for ${name}: ${text}.${view.freshness === "retained" ? " Stale estimate; current activity unconfirmed." : ""} Open details.`;
}

function renderDuration(cell: HTMLTableCellElement, view: DurationView, host: Pick<HostView, "id" | "name">, live = false, checkedAt: number | null = null): void {
  durationViews.set(cell, view);
  rememberDisplayExpiry(cell, live && view.freshness === "current" ? view.validUntilMs : null);
  durationNames.set(cell, host.name);
  const container = sourceContainer(cell);
  container.dataset.durationKind = view.kind;
  cell.dataset.durationKind = view.kind;
  cell.dataset.durationTone = view.tone;
  cell.dataset.durationFreshness = view.freshness;
  cell.dataset.durationUnavailableReason = view.unavailableReason ?? "";
  // Update the same connected button and fill; ordinary clock/API updates must
  // preserve CSS timelines, keyboard focus and an open dialog’s return target.
  const value = container.querySelector<HTMLButtonElement>(".duration-value") ?? document.createElement("button");
  value.type = "button";
  const valueClass = `duration-value duration-${view.tone}${live && view.freshness === "retained" ? " duration-stale" : ""}${view.text === "Populating.." ? " duration-populating" : ""}${!live && view.kind === "unknown" ? " duration-sample-unknown" : ""}`;
  if (value.className !== valueClass) value.className = valueClass;
  value.setAttribute("aria-label", durationLabel(view, host.name));
  const timing = view.kind === "duration";
  const stale = view.freshness === "retained";
  const missing = view.kind === "unknown";
  const offlineUnavailable = view.unavailableReason === "api-offline";
  const noAssignment = live && missing && view.text !== "Populating.." && !offlineUnavailable;
  const checked = checkedFact(checkedAt, live ? "Job checked" : "Sample observed");
  rememberInfo(cell, {
    summary: timing
      ? [ink(stale ? "Retained Duration estimate: " : "Duration: "),
        ink(view.text, stale ? "muted" : view.tone === "exceeded" ? "negative" : view.limitSeconds === null ? "accent" : "positive"),
        ink(view.tone === "exceeded" ? " — over the five-minute grace." : view.limitSeconds === null ? " — no reported limit." : ".")]
      : [ink(view.kind === "queue" ? "Duration: queued; see Queued for the position."
        : offlineUnavailable ? "Duration: timing unavailable while API is Offline."
          : noAssignment ? stale ? "Duration: earlier reading retained; current timing is unconfirmed."
            : "Duration: no running timing in the last job reading."
            : "Duration: no useful timing is available yet.", missing && !noAssignment && !offlineUnavailable ? "warning" : "muted")],
    facts: [
      [ink(timing ? stale ? "Stale estimate; current activity is unconfirmed." : "Current timing reading."
        : view.kind === "queue" ? "Queued activity does not supply a run duration."
          : offlineUnavailable ? "Job timing is unknown; API Offline does not prove the job stopped."
            : noAssignment ? "The last job reading reported no running timing." : "Unknown timing is not zero elapsed time.", stale || missing && !noAssignment ? "warning" : "plain")],
      ...(timing ? [[ink(view.limitSeconds === null ? "No valid positive duration limit is reported."
        : "Red starts more than five minutes past the unchanged job limit.", view.tone === "exceeded" ? "negative" : "plain")]] : []),
      ...(timing || !live ? [checked] : []),
      !live ? "Synthetic sample; no live job connection." : timing ? "Source: assigned Nosana job; State is shown separately."
        : "Source details retain the supporting activity or assignment evidence.",
    ], ...(timing || !live ? { checked } : {}), source: view.description,
  }, value);
  value.onclick = () => sourceDetails(cell, "Job duration");
  if (durationMode === "text" || view.kind !== "duration" || live && view.limitSeconds === null) {
    setText(value, queuedDurationLayout === "combined" && view.kind === "queue" ? "Queued" : view.text);
  } else {
    const track = value.querySelector<HTMLSpanElement>(".duration-track") ?? document.createElement("span");
    track.className = "duration-track";
    track.setAttribute("aria-hidden", "true");
    const fill = track.querySelector<HTMLSpanElement>(".duration-fill") ?? document.createElement("span");
    const fillClass = `duration-fill duration-${view.tone}${view.animated ? " duration-active" : ""}`;
    if (fill.className !== fillClass) fill.className = fillClass;
    fill.style.width = `${view.percent ?? 100}%`;
    if (!fill.parentElement) {
      fill.style.setProperty("--duration-delay", `-${durationPhase(host.id)}ms`);
      track.append(fill);
    }
    if (!track.parentElement) value.replaceChildren(track);
  }
  if (!value.parentElement) container.append(value);
}

function liveQueue(address: string, nowMs: number): QueueView {
  const metadata = metadataRecords.get(address);
  const job = liveActivity(address, nowMs).eligibleJob;
  const state = nodeInfoRecords.get(address);
  const view = projectQueue(queueRecords.get(address), address, metadata?.values?.marketAddress ?? null, nowMs, {
    freshnessAtMs: freshnessNow(),
    ...(job ? { job: jobsError ? { ...job, error: jobsError, retained: true } : job } : {}),
    ...(state ? { state: nodeInfoError ? { ...state, error: nodeInfoError, retained: true } : state } : {}),
    connectionError: queueError ?? metadataError ?? metadata?.error ??
      (metadata?.retained ? "The host’s reported market is retained from an unavailable metadata read." : null),
  });
  return evidenceClock.trusted ? view : { ...view, current: false, checkCurrent: false,
    retained: view.kind !== "unknown", description: `${CLOCK_RETAINED_NOTE}\n\n${view.description}` };
}

function renderLiveQueue(cell: HTMLTableCellElement, address: string, nowMs: number): void {
  const view = liveQueue(address, nowMs);
  const record = queueRecords.get(address);
  const jobUntil = view.kind === "running" ? liveActivity(address, nowMs).eligibleJob?.validUntilMs : null;
  rememberDisplayExpiry(cell, view.checkCurrent && record?.validUntilMs != null
    ? Math.min(record.validUntilMs, jobUntil ?? Infinity) : null);
  cell.dataset.queueKind = view.kind;
  cell.dataset.queueCurrent = String(view.current);
  cell.dataset.queueCheckCurrent = String(view.checkCurrent);
  cell.dataset.queueRetained = String(view.retained);
  cell.dataset.queueCheckedAt = String(record?.checkedAtMs ?? "");
  cell.dataset.queueMarket = record?.marketAddress ?? "";
  renderQueue(cell, view, address, record?.checkedAtMs ?? null);
}

function renderQueue(cell: HTMLTableCellElement, view: QueueView, name: string, checkedAt: number | null = null): void {
  queueViews.set(cell, view);
  const container = sourceContainer(cell);
  const value = container.querySelector<HTMLButtonElement>(".queue-value") ?? document.createElement("button");
  value.type = "button";
  const className = `queue-value${view.retained ? " queue-retained" : ""}${view.kind === "running" ? " queue-arrow" : view.kind === "unknown" ? " queue-unknown" : ""}`;
  if (value.className !== className) value.className = className;
  setText(value, view.text);
  value.setAttribute("aria-label", `Queued for ${name}: ${view.text}.${view.retained ? " Retained or conflicting position; current position unconfirmed." : ""} Open details.`);
  const checked = checkedFact(checkedAt, "Queue checked");
  rememberInfo(cell, {
    summary: [ink(view.kind === "position"
      ? `${view.retained ? "Retained/conflicting queue position" : "Queue position"}: ${view.text}.`
      : view.kind === "running" ? "Queued: running job; see Duration."
        : view.checkCurrent ? "Queued: no position in the checked market queue." : "Queued: position unknown.",
    view.retained ? "muted" : view.kind === "unknown" && !view.checkCurrent ? "warning" : "plain")],
    facts: [
      [ink(view.kind === "position" ? view.current ? "Position 1 is the front of the queue." : "Current position is unconfirmed."
        : view.checkCurrent ? "No position does not establish stopped activity." : "No current queue reading is available.",
      view.retained || !view.checkCurrent ? "warning" : "plain")],
      "Position is not an estimated waiting time.", checked,
    ], checked, source: view.description,
  }, value);
  value.onclick = () => sourceDetails(cell, "Queued");
  if (!value.parentElement) container.append(value);
}

function latestCheck(values: readonly (number | null | undefined)[]): number | null {
  const times = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return times.length ? Math.max(...times) : null;
}

function checkSchedule(lastAt: number | null, nextAt: number | null | undefined, watching = false, checkingJobs = false): string {
  const due = nextAt !== null && nextAt !== undefined && nextAt <= liveNow();
  const next = due && watching ? " Eligible checks queued/in progress."
    : due && checkingJobs ? " Checking eligible jobs."
      : nextAt !== null && nextAt !== undefined ? ` Next permitted check: ${timestamp(nextAt)}.` : "";
  return ` Latest successful API check: ${timestamp(lastAt)}.${next}${watching ? " Visible feed active." : ""}`;
}

function readIssues(values: readonly (string | null | undefined)[]): string {
  const issues = [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
  return issues.length ? ` Read/retry reason: ${issues.slice(0, 2).join("; ")}${issues.length > 2 ? "; other hosts also have unavailable reads" : ""}.` : "";
}

function snapshotDeadline(payload: Record<string, unknown>): number | null | undefined {
  const value = payload.nextRefreshAtMs;
  if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isSafeInteger(value) ||
      value < 0 || value > 8_640_000_000_000_000)) throw new Error("Invalid preview refresh deadline.");
  return value as number | null | undefined;
}

function renderQueueStatus(): void {
  const notice = element("queue-status");
  notice.hidden = !supplied || inputLoading || inputError !== null || suppliedAddresses.length === 0;
  if (notice.hidden) return;
  const at = liveNow();
  const views = suppliedAddresses.map(address => ({ view: liveQueue(address, at), record: queueRecords.get(address) }));
  const checked = views.filter(({ view }) => view.checkCurrent).length;
  const positions = views.filter(({ view }) => view.kind === "position" && view.current).length;
  const absent = views.filter(({ view, record }) => view.checkCurrent && record?.position === null).length;
  const retained = views.filter(({ view }) => view.kind === "position" && view.retained).length;
  const schedule = checkSchedule(latestCheck([...queueRecords.values()].map(record => record.checkedAtMs)),
    queueProviderNextAt !== undefined ? queueProviderNextAt : deadlines.at(queueRefreshDueAt), queueWatching);
  const issues = readIssues([queueError, metadataError, ...[...queueRecords.values()].map(record => record.error),
    ...[...metadataRecords.values()].map(record => record.error)]);
  setText(notice, queueLoading && queueRecords.size === 0 && queueError === null ? "Reading Nosana market queues…"
    : `${candidateCoveragePrefix()}${checked}/${suppliedAddresses.length} current queue checks · ${positions} current positions · ${absent} confirmed absent · ${retained} retained/conflicting positions · ${suppliedAddresses.length - checked} unchecked or expired.${queueError ? " Queue refresh failed." : ""}${schedule}${issues} Queued shows position / total; a dash after a successful check means no current position, while unavailable checks remain unknown.`);
}

function scheduleQueueExpiry(): void {
  if (queueExpiryTimer !== undefined) clearTimeout(queueExpiryTimer);
  queueExpiryTimer = undefined;
  if (!visibleStateView() || queueError) return;
  const nowMs = freshnessNow();
  const deadlines = displayedExpiryDates(["queued"]);
  if (deadlines.length === 0) return;
  queueExpiryTimer = setTimeout(() => {
    queueExpiryTimer = undefined;
    if (!visibleStateView()) return;
    updateLiveDurations();
    scheduleQueueExpiry();
  }, Math.max(1, Math.min(...deadlines) - nowMs));
}

function scheduleQueueRefresh(): void {
  if (queueRefreshTimer !== undefined) clearTimeout(queueRefreshTimer);
  queueRefreshTimer = undefined;
  if (!visibleStateView() || queueLoading || inputLoading || inputError || suppliedAddresses.length === 0 || queueRefreshDueAt === null) return;
  queueRefreshTimer = setTimeout(() => {
    queueRefreshTimer = undefined;
    if (visibleStateView()) void loadQueue();
  }, Math.max(0, deadlines.remaining(queueRefreshDueAt)));
}

function resumeQueueView(): void {
  if (visibleStateView()) {
    updateLiveDurations();
    if (!queueAttempted) void loadQueue();
  }
  scheduleQueueRefresh();
  scheduleQueueExpiry();
}

const CLOCK_RETAINED_NOTE = "The server time reference is awaiting refresh after suspension. Earlier readings are retained; their original check times are unchanged.";
const DELIVERY_RETAINED_NOTE = "Delivery timing is uncertain, so the original freshness deadline may already have passed. The reading is retained with its original check time; no new source failure is inferred.";

function liveApi(record: NodeInfoRecord | undefined, at: number) {
  const view = projectNodeApi(record, at, nodeInfoError);
  const uncertain = view.current && view.expiresAtMs !== null && freshnessNow() >= view.expiresAtMs;
  return evidenceClock.trusted && !uncertain ? view : { ...view, current: false, expiresAtMs: null,
    description: `${evidenceClock.trusted ? DELIVERY_RETAINED_NOTE : CLOCK_RETAINED_NOTE}\n\n${view.description}` };
}

function onlineHostProof(address: string, at: number): number | null {
  const api = liveApi(nodeInfoRecords.get(address), at);
  return api.status === "Online" && api.current ? api.expiresAtMs : null;
}

function onlineMembershipChanged(at: number): boolean {
  if (!supplied || !onlineScenario) return false;
  return suppliedAddresses.some(address =>
    (onlineHostProof(address, at) !== null) !== displayedOnlineHosts.has(address));
}

function candidateCoveragePrefix(): string {
  return onlineScenario ? "Explorer candidate coverage: " : "";
}

function liveActivity(address: string, nowMs: number): LiveActivityView {
  const metadata = metadataRecords.get(address);
  const view = activityDisplay.project({
    address, nowMs,
    state: nodeInfoRecords.get(address), job: jobRecords.get(address), queue: queueRecords.get(address),
    marketAddress: metadata?.values?.marketAddress ?? null,
    stateError: nodeInfoError, jobsError,
    queueError: queueError ?? metadataError ?? metadata?.error ??
      (metadata?.retained ? "The host’s reported market is retained from an unavailable metadata read." : null),
  });
  // Clock uncertainty is presentation-only. Feeding a fabricated source error
  // into the history reconciler would permanently invalidate cached evidence.
  const at = freshnessNow();
  const uncertainState = view.state.current !== null && view.state.validUntilMs !== null && at >= view.state.validUntilMs;
  const uncertainDuration = view.duration.freshness === "current" && view.duration.validUntilMs != null && at >= view.duration.validUntilMs;
  const note = evidenceClock.trusted ? DELIVERY_RETAINED_NOTE : CLOCK_RETAINED_NOTE;
  const state = evidenceClock.trusted && !uncertainState ? view.state : {
    ...view.state, current: null, retained: view.state.reported !== null,
    description: `${note}\n\n${view.state.description}`,
  };
  let duration = view.duration;
  if (!evidenceClock.trusted) duration = { ...duration,
    freshness: duration.freshness === "unknown" ? "unknown" : "retained",
    description: `${note}\n\n${duration.description}`,
  };
  else if (uncertainDuration) duration = duration.kind === "duration" ? {
    ...duration, freshness: "retained", description: `${note}\n\n${duration.description}`,
  } : {
    ...duration, kind: "unknown", text: "Populating..", freshness: "unknown", tone: "unbounded", animated: false,
    description: `${note}\n\n${duration.description}`,
  };
  // Availability is presentation-only too; it cannot replace the source/history
  // selection above or convert clock uncertainty into an Offline confirmation.
  if (evidenceClock.trusted) duration = projectDurationAvailability(duration, liveApi(nodeInfoRecords.get(address), nowMs));
  return { ...view, state, duration };
}

function liveDuration(address: string, nowMs: number): DurationView {
  return liveActivity(address, nowMs).duration;
}

function renderLiveDuration(cell: HTMLTableCellElement, address: string, nowMs: number): void {
  const view = liveActivity(address, nowMs);
  cell.dataset.jobAddress = view.durationJob?.job?.address ?? "";
  cell.dataset.jobCheckedAt = String(view.durationJob?.checkedAtMs ?? "");
  renderDuration(cell, view.duration, { id: address, name: address }, true, view.durationJob?.checkedAtMs ?? null);
}

function renderJobStatus(nowMs: number): void {
  const notice = element("jobs-status");
  notice.hidden = !supplied || inputLoading || inputError !== null || suppliedAddresses.length === 0;
  if (notice.hidden) return;
  const views = suppliedAddresses.map(address => liveDuration(address, nowMs));
  const current = views.filter(view => view.kind === "duration" && view.freshness === "current").length;
  const retained = views.filter(view => view.kind === "duration" && view.freshness === "retained").length;
  const pending = [...jobRecords.values()].filter(record => record.pending).length;
  const failed = [...jobRecords.values()].filter(record => record.error !== null && !record.pending).length;
  const pendingDeadlines = [...jobRecords.values()].flatMap(record => record.pending && record.retryAtMs !== null ? [record.retryAtMs] : []);
  const retryAt = jobProviderNextAt ?? (pendingDeadlines.length ? Math.min(...pendingDeadlines) : deadlines.at(jobRefreshDueAt));
  const schedule = checkSchedule(latestCheck([...jobRecords.values()].map(record => record.checkedAtMs)), retryAt, false, jobsLoading);
  const wait = jobWaitReason === "retry-after" ? "Provider Retry-After pause"
    : jobWaitReason === "local-budget" ? "Shared request budget pause"
      : jobWaitReason === "discovery-budget" ? "Discovery budget pause; known job timing maintenance remains eligible under its own schedule" : null;
  const waitNote = wait === null ? "" : ` ${wait}${jobWaitUntilMs === null ? "." : ` until ${timestamp(jobWaitUntilMs)}.`}`;
  const issues = readIssues([jobsError, ...[...jobRecords.values()].map(record => record.error)]);
  setText(notice, jobsLoading && jobRecords.size === 0 && jobsError === null ? "Reading assigned Nosana jobs…"
    : `${candidateCoveragePrefix()}${current}/${suppliedAddresses.length} current job timings · ${retained} retained estimates · ${suppliedAddresses.length - current - retained} without a timing${pending ? ` · ${pending} lookups pending` : ""}${failed ? ` · ${failed} unavailable reads` : ""}.${jobsError ? " Job refresh failed. Previous durations keep counting as dimmed estimates." : ""}${schedule}${waitNote}${issues} ${onlineScenario ? "This scenario rereads cached job timings every 120 seconds; Supplied Host Addresses and Real200 own active job collection." : "Known job timings refresh every 120 seconds while visible; pending discovery follows the permitted retry deadline."} Elapsed time ticks locally. Failed or 180-second-old evidence stays dimmed and ticking from its original verified start; current activity is unconfirmed. The indexer supplies no indexing-freshness timestamp.`);
}

function updateLiveDurations(): void {
  const at = liveNow();
  if (["duration", "queued", "state"].includes(activeSort.column)) {
    renderSupplied();
    return;
  }
  for (const row of element("fleet-rows").querySelectorAll<HTMLTableRowElement>('tr[data-source="supplied"]')) {
    const cell = row.querySelector<HTMLTableCellElement>('td[data-col="duration"]');
    if (cell) renderLiveDuration(cell, row.dataset.host!, at);
    const queueCell = row.querySelector<HTMLTableCellElement>('td[data-col="queued"]');
    if (queueCell) renderLiveQueue(queueCell, row.dataset.host!, at);
    renderQueuedDurationRow(row);
    const stateCell = row.querySelector<HTMLTableCellElement>('td[data-col="state"]');
    if (stateCell) renderNodeInfoCell(stateCell, "state", row.dataset.host!, nodeInfoRecords.get(row.dataset.host!), at);
  }
  renderNodeInfoStatus(at);
  renderJobStatus(at);
  renderQueueStatus();
}

function scheduleJobTick(): void {
  if (jobTickTimer !== undefined) clearTimeout(jobTickTimer);
  jobTickTimer = undefined;
  if (!visibleStateView() || inputLoading || inputError || suppliedAddresses.length === 0) return;
  const nowMs = liveNow();
  const expiryNowMs = freshnessNow();
  // Reanchoring/coalesced rendering must not shift the elapsed-second boundary.
  // Job starts are Unix seconds, so tick at the next server-referenced second.
  let delay = 1_000 - nowMs % 1_000;
  for (const deadline of displayedExpiryDates(["duration"])) delay = Math.min(delay, Math.max(1, deadline - expiryNowMs));
  jobTickTimer = setTimeout(() => {
    jobTickTimer = undefined;
    if (!visibleStateView()) return;
    updateLiveDurations();
    scheduleJobTick();
  }, delay);
}

function scheduleJobRefresh(): void {
  if (jobRefreshTimer !== undefined) clearTimeout(jobRefreshTimer);
  jobRefreshTimer = undefined;
  if (!visibleStateView() || jobsLoading || inputLoading || inputError || suppliedAddresses.length === 0 || jobRefreshDueAt === null) return;
  jobRefreshTimer = setTimeout(() => {
    jobRefreshTimer = undefined;
    if (visibleStateView()) void loadJobs();
  }, Math.max(0, deadlines.remaining(jobRefreshDueAt)));
}

function resumeJobView(): void {
  if (visibleStateView()) {
    updateLiveDurations();
    if (!jobsAttempted) void loadJobs();
  }
  scheduleJobTick();
  scheduleJobRefresh();
}

function renderRow({ pcView: pc, runtime, host, addresses, durationInput, duration, market, hardware }: PreviewRow): HTMLTableRowElement {
  const row = document.createElement("tr");
  row.dataset.host = host.id;
  row.dataset.pc = pc.pcId;
  row.dataset.runtime = runtime.runtimeId;
  row.dataset.freshness = runtime.freshness;
  row.dataset.observedAt = String(runtime.inventoryObservedAtMs);
  if (durationInput) row.dataset.jobObservedAt = String(durationInput.reading?.observedAtMs ?? "");
  row.dataset.marketObservedAt = String(market.observedAtMs ?? "");
  row.dataset.hardwareObservedAt = String(hardware.observedAtMs ?? "");
  row.setAttribute("aria-label", `${host.name} on ${pc.pcId}`);
  for (const [key, label, description] of COLUMNS) {
    const cell = document.createElement("td");
    cell.dataset.col = key;
    switch (key) {
      case "stakedNos":
        renderStakingCell(cell, host.id, sampleNow);
        break;
      case "pc": {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "host-details";
        button.textContent = pc.pcId;
        button.setAttribute("aria-label", `Observation details for ${host.name} on ${pc.pcId}`);
        rememberInfo(cell, {
          summary: [ink(`Sample container ${host.currentState}`, host.currentState === "running" ? "positive" : host.currentState === "stopped" ? "negative" : "warning"),
            ink(` — ${host.name} on ${pc.pcId}.`)],
          facts: [`Runtime: ${runtime.runtimeId}; ${inventoryLabel(runtime)}.`,
            `Last observed container state: ${host.observedState}.`,
            checkedFact(pc.observedAtMs, "PC observed"), checkedFact(runtime.inventoryObservedAtMs, "Inventory observed")],
          source: rowDetails(pc, runtime, host, duration),
        }, button);
        button.addEventListener("click", () => openCellInfo(cell, host.name));
        cell.append(button);
        break;
      }
      case "ip": {
        const display = formatIPDisplay(addresses, ipMode);
        cell.textContent = display.text;
        cell.title = brief(display.description.replace(". Internal:", "; Internal:"));
        cell.setAttribute("aria-label", display.description);
        break;
      }
      case "duration":
        renderDuration(cell, duration, host, false, durationInput?.reading?.observedAtMs ?? durationInput?.activity?.observedAtMs ?? null);
        break;
      case "state":
      case "api":
      case "dl":
      case "ul":
      case "ping":
        renderNodeInfoCell(cell, key, host.id, sampleNodeInfo(selected, host.id), sampleNow, true);
        break;
      case "latestJob":
        cell.textContent = durationInput?.displayedJobId ?? "—";
        break;
      case "queued": {
        const position = duration.kind === "queue" ? durationInput?.activity?.queuePosition?.trim() : null;
        renderQueue(cell, {
          kind: position ? "position" : "unknown", text: position || "—",
          description: duration.kind === "queue" ? duration.description : description,
          current: Boolean(position), checkCurrent: false, retained: false, sortValue: position || null,
        }, host.name, durationInput?.activity?.observedAtMs ?? null);
        break;
      }
      case "market": {
        cell.dataset.marketFreshness = market.freshness;
        const content: InfoContent = {
          summary: [ink(`${market.freshness === "retained" ? "Retained market" : "Market"}: ${brief(market.fullLabel ?? "unknown", 160)}.`,
            market.fullLabel === null ? "warning" : market.freshness === "retained" ? "muted" : "accent")],
          facts: ["Synthetic sample market; no live assignment is connected.", checkedFact(market.observedAtMs, "Sample observed")],
          source: `${market.description}\n\nFictitious sample market. No provider refresh or assignment change is performed.`,
        };
        rememberInfo(cell, content);
        if (market.fullLabel === null) {
          cell.textContent = "—";
          cell.setAttribute("aria-label", infoText(content.summary));
        } else {
          const value = rowValue(cell, "market-value");
          value.className = `market-value market-${market.freshness}`;
          value.textContent = market.text;
          value.setAttribute("aria-label", `${market.freshness === "retained" ? "Retained market" : "Market"} for ${host.name}: ${market.fullLabel}. Open details.`);
          rememberInfo(cell, content, value);
          value.onclick = hasRowInformation(cell) ? () => openCellInfo(cell, "Market") : null;
          cell.append(value);
        }
        break;
      }
      case "nvidia":
      case "cpu":
      case "system": {
        const display = formatHardwareDisplay(key, hardware.values[key], hardwareModes[key]);
        const details = `${label}: ${display.fullValue ?? "unknown"}\nSample observation: ${timestamp(hardware.observedAtMs)}\n\nSynthetic metadata; no live source or freshness contract is connected.${key === "system" ? " A kernel release does not identify the complete OS or distribution." : ""}`;
        const content: InfoContent = {
          summary: [ink(`${label}: ${brief(display.fullValue ?? "unknown", 160)}.`, display.fullValue === null ? "warning" : "accent")],
          facts: [COLUMN_HELP[key], checkedFact(hardware.observedAtMs, "Sample observed"), "Synthetic metadata; no live hardware reading."],
          source: details,
        };
        rememberInfo(cell, content);
        if (display.fullValue === null) {
          cell.textContent = "—";
          cell.className = "unknown";
          cell.setAttribute("aria-label", `${label}: unknown`);
        } else {
          const value = rowValue(cell, "hardware-value");
          value.className = "hardware-value";
          value.textContent = display.text;
          value.setAttribute("aria-label", `${label} for ${host.name}: ${display.fullValue}. Open details.`);
          rememberInfo(cell, content, value);
          value.onclick = hasRowInformation(cell) ? () => openCellInfo(cell, label) : null;
          cell.append(value);
        }
        break;
      }
      default:
        cell.textContent = "—";
        cell.className = "unknown";
        cell.setAttribute("aria-label", `${label}: unknown`);
        if (hasRowInformation(cell)) cell.title = COLUMN_HELP[key];
    }
    row.append(cell);
    if (key === "duration") row.append(dividerCell("td"));
  }
  renderQueuedDurationRow(row);
  return row;
}

function renderDisplaySettings(): void {
  for (const heading of element("column-headings").querySelectorAll("th[data-col]")) {
    const direction = heading.getAttribute("data-col") === activeSort.column
      ? activeSort.direction === "asc" ? "ascending" : "descending" : "none";
    if (heading.getAttribute("aria-sort") !== direction) heading.setAttribute("aria-sort", direction);
  }
  renderQueuedDurationHeader();
  const sortLabel = COLUMNS.find(([key]) => key === activeSort.column)?.[1] ?? "PC";
  setText(element("sort-status"), `${sortLabel} · ${activeSort.direction === "asc" ? "ascending" : "descending"}`);
  const ipDisplayStatus = `IP display: ${ipModeLabel(ipMode)}; next: ${ipModeLabel(nextIPMode(ipMode))}.`;
  element("ip-display-toggle").title = ipDisplayStatus;
  element("ip-display-toggle").dataset.mode = ipMode;
  setText(element("ip-mode-status"), ipDisplayStatus);
  const hostAddressStatus = `Host Address display: ${hostAddressMode === "compact" ? "first five characters" : "full address"}; next: ${hostAddressMode === "compact" ? "full address" : "first five characters"}.`;
  element("hostAddress-display-toggle").title = hostAddressStatus;
  element("hostAddress-display-toggle").dataset.mode = hostAddressMode;
  element("hostAddress-display-toggle").setAttribute("aria-pressed", String(hostAddressMode === "full"));
  setText(element("hostAddress-mode-status"), hostAddressStatus);
  const durationStatus = `Duration display: ${durationMode === "bar" ? "progress bar" : "time text"}; next: ${durationMode === "bar" ? "time text" : "progress bar"}.`;
  element("duration-display-toggle").title = durationStatus;
  element("duration-display-toggle").dataset.mode = durationMode;
  setText(element("duration-mode-status"), durationStatus);
  const marketStatus = `Market display: ${marketMode === "full" ? "full label" : "first two characters"}; next: ${marketMode === "full" ? "first two characters" : "full label"}.`;
  element("market-display-toggle").title = marketStatus;
  element("market-display-toggle").dataset.mode = marketMode;
  setText(element("market-mode-status"), marketStatus);
  const stakingStatus = `Staked NOS display: ${stakingMode === "symbols" ? "checkmark / x" : "actual / required amounts"}; next: ${stakingMode === "symbols" ? "actual / required amounts" : "checkmark / x"}.`;
  element("stakedNos-display-toggle").title = stakingStatus;
  element("stakedNos-display-toggle").dataset.mode = stakingMode;
  setText(element("stakedNos-mode-status"), stakingStatus);
  for (const key of HARDWARE_COLUMNS) {
    const label = COLUMNS.find(([column]) => column === key)![1];
    const compactLabel = key === "nvidia" ? "major version" : key === "cpu" ? "short CPU label" : "release without suffix";
    const mode = hardwareModes[key];
    const status = `${label} display: ${mode === "compact" ? `compact (${compactLabel})` : "expanded (full value)"}; next: ${mode === "compact" ? "full value" : compactLabel}.`;
    element(`${key}-display-toggle`).title = status;
    element(`${key}-display-toggle`).dataset.mode = mode;
    setText(element(`${key}-mode-status`), status);
  }
}

const METADATA_COLUMNS = ["status", "market", "ram", "disk", "cpu", "cuda", "nvidia", "currentNode", "system"] as const;
type MetadataColumn = typeof METADATA_COLUMNS[number];

function isMetadataColumn(key: SortColumn): key is MetadataColumn {
  return METADATA_COLUMNS.some((column) => column === key);
}

function metadataValue(values: HostMetadataValues | null | undefined, key: MetadataColumn): string | number | null {
  if (key === "status") return statusLabel(values?.status);
  return (key === "market" ? values?.marketLabel : values?.[key]) ?? null;
}

function renderMetadataCell(
  cell: HTMLTableCellElement, key: MetadataColumn, label: string, address: string, record: HostMetadataRecord | undefined,
): void {
  const raw = metadataValue(record?.values, key);
  const retained = record?.retained === true || (metadataError !== null && record?.values != null);
  const marketError = key === "market" ? record?.marketError : null;
  const failed = retained || Boolean(marketError);
  let text = raw === null ? "—" : String(raw);
  if (raw !== null) {
    if (key === "status") text = String(raw).charAt(0).toUpperCase();
    else if (key === "ram") text = String(Math.round(Number(raw)));
    else if (key === "market" && marketMode === "compact") text = Array.from(String(raw)).slice(0, 2).join("");
    else if (key === "nvidia" || key === "cpu" || key === "system") {
      text = formatHardwareDisplay(key, String(raw), hardwareModes[key]).text;
    }
  }
  const full = raw === null ? "unknown" : `${raw}${key === "ram" || key === "disk" ? " GB" : ""}`;
  const note = COLUMNS.find(([column]) => column === key)![2];
  const issue = record?.error ?? metadataError;
  const details = `${label}: ${full}${key === "status" && record?.values?.status ? `\nRaw Nosana status: ${record.values.status}` : ""}${key === "market" && record?.values?.marketAddress ? `\nMarket address: ${record.values.marketAddress}` : ""}\n\n${note}\n\n${retained ? "Retained from the last successful read. " : ""}Reported Nosana metadata; current host activity is not established.${issue ? `\nRead unavailable: ${issue}` : ""}${marketError ? `\nMarket label unavailable: ${marketError}` : ""}`;
  cell.dataset.metadataState = raw === null ? "unknown" : failed ? "retained" : "reported";
  const value = rowValue(cell, "metadata-value");
  const classes = ["metadata-value"];
  if (failed) classes.push("metadata-retained");
  if (key === "status" && raw !== null && !failed) {
    classes.push(`tier-${statusTone(String(raw))}`);
  }
  if (key === "currentNode" && raw !== null && String(raw).includes("-") && !failed) classes.push("version-prerelease");
  if (key === "market" && raw !== null && !failed) classes.push("metadata-market");
  const className = classes.join(" ");
  if (value.className !== className) value.className = className;
  setText(value, text);
  value.setAttribute("aria-label", `${failed && raw !== null ? "Retained " : ""}${label}: ${full} for ${address}. Open details.`);
  const tone: InfoTone = raw === null ? "warning" : failed ? "muted" : key !== "status" ? "accent"
    : statusTone(String(raw)) === "premium" ? "positive" : statusTone(String(raw)) === "rejected" ? "negative"
      : statusTone(String(raw)) === "community" ? "warning" : "plain";
  rememberInfo(cell, {
    summary: [ink(`${failed && raw !== null ? "Retained " : ""}${label}: `), ink(brief(full, 160), tone), ink(".")],
    facts: [COLUMN_HELP[key], checkedFact(record?.fetchedAtMs, "Metadata checked"),
      ...(key === "status" && record?.values?.status ? [`Raw Nosana status: ${record.values.status}.`] : []),
      ...(issue || marketError || failed ? [[ink(raw === null ? "Reading unavailable; no verified value yet."
        : "Latest reading is unavailable; retained values are unconfirmed.", "warning")]] : [])],
    source: details,
  }, value);
  value.onclick = hasRowInformation(cell) ? () => openCellInfo(cell, label) : null;
  if (!value.parentElement) cell.replaceChildren(value);
}

type NodeColumn = "state" | "api" | "dl" | "ul" | "ping";

function stateArtwork(kind: "running" | "queued" | "restarting" | "unknown", identity: string): HTMLElement {
  // Static SVG geometry from the preserved MIT Fleet reference; no provider markup.
  const wrapper = document.createElement("span");
  wrapper.className = `node-state-art state-${kind}`;
  wrapper.dataset.artwork = kind;
  wrapper.setAttribute("aria-hidden", "true");
  const phase = [...identity].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 10_000, 0);
  wrapper.style.setProperty("--state-delay", `-${phase}ms`);
  if (kind === "restarting" || kind === "unknown") {
    const dots = document.createElement("span");
    dots.className = "state-dots";
    for (let index = 0; index < 4; index++) dots.append(document.createElement("span"));
    wrapper.append(dots);
    return wrapper;
  }
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.classList.add("state-ring-svg");
  for (const className of ["state-ring-solid", kind === "running" ? "state-running-ring" : "state-queued-ring"]) {
    const circle = document.createElementNS(svg.namespaceURI, "circle");
    for (const [name, value] of Object.entries({ cx: "12", cy: "12", r: "10", class: className })) circle.setAttribute(name, value);
    svg.append(circle);
  }
  wrapper.append(svg);
  const inside = document.createElementNS(svg.namespaceURI, "svg");
  inside.setAttribute("viewBox", "0 0 24 24");
  inside.setAttribute("class", kind === "running" ? "state-bolt" : "state-queue-dots");
  if (kind === "running") {
    const path = document.createElementNS(svg.namespaceURI, "path");
    for (const [key, value] of Object.entries({ d: "M12 7L9 12L15 12L12 17", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" })) path.setAttribute(key, value);
    inside.append(path);
  } else {
    for (const [index, y] of [8, 12, 16].entries()) {
      const dot = document.createElementNS(svg.namespaceURI, "circle");
      for (const [key, value] of Object.entries({ cx: "12", cy: String(y), r: "1.8", class: `state-queue-dot state-queue-dot-${index + 1}` })) dot.setAttribute(key, value);
      inside.append(dot);
    }
  }
  wrapper.append(inside);
  return wrapper;
}

function renderNodeInfoCell(cell: HTMLTableCellElement, key: NodeColumn, address: string, record: NodeInfoRecord | undefined, nowMs: number, synthetic = false): void {
  const label = COLUMNS.find(([column]) => column === key)![1];
  const connectionError = synthetic ? null : nodeInfoError;
  const value = rowValue(cell, "node-info-value");
  value.classList.add("node-info-value");
  let details: string;
  let information: InfoContent;
  displayExpiry.delete(cell);
  if (key === "state") {
    const view = synthetic ? projectNodeStateDisplay(record, nowMs, connectionError) : liveActivity(address, nowMs).state;
    if (!synthetic && view.current !== null && view.validUntilMs !== null) displayExpiry.set(cell, view.validUntilMs);
    value.classList.toggle("node-state-retained", view.current === null && view.reported !== null);
    value.classList.toggle("node-state-unknown", view.reported === null);
    value.classList.toggle("node-state-animated", view.animated);
    value.classList.add("node-state-value");
    const artwork = value.querySelector<HTMLElement>(".node-state-art");
    if (view.artwork) {
      // Keeping the same connected SVG preserves its animation timeline, focus
      // target and open-dialog return target through every unchanged-state read.
      if (artwork?.dataset.artwork !== view.artwork) value.replaceChildren(stateArtwork(view.artwork, address));
    } else if (artwork || value.textContent !== view.short) {
      value.textContent = view.short;
    }
    cell.dataset.state = view.reported ?? "unknown";
    cell.dataset.stateCurrent = String(view.current !== null);
    cell.dataset.stateSource = view.source ?? "unknown";
    cell.dataset.stateCheckedAt = String(view.checkedAtMs ?? "");
    cell.dataset.stateValidUntil = String(view.validUntilMs ?? "");
    details = `${view.description}${synthetic ? "\n\nSynthetic state example; no live connection." : ""}`;
    value.setAttribute("aria-label", `State for ${address}: ${view.current ?? (view.reported ? `stale estimate; last reported ${view.reported}; current activity unconfirmed` : "unknown")}. Open details.`);
    const tone: InfoTone = view.reported === null ? "warning" : view.current === null ? "muted"
      : view.artwork === "restarting" ? "warning" : view.artwork === "running" || view.artwork === "queued" ? "positive" : "accent";
    information = {
      summary: [ink(view.reported === null ? "State unknown; no useful activity has been confirmed."
        : view.current === null ? `Last known State: ${view.reported}; current activity is unconfirmed.` : `State: ${view.current}.`, tone)],
      facts: [
        synthetic ? "Synthetic example; no live connection."
          : `Source: ${view.source === "job" ? "verified running job assignment" : "Node Info"}.`,
        checkedFact(view.checkedAtMs ?? record?.fetchedAtMs, view.checkedAtMs === null ? "Node Info read" : "State confirmed"),
        view.reported === null ? "The dim amber spinner does not establish restarting or a check in progress."
          : view.current === null ? "Retained artwork keeps its original source time." : "Activity and API reachability are separate.",
        ...(record?.values?.state === "OTHER" ? ["Node Info reported OTHER; details show the independent activity evidence."] : []),
      ], source: details,
    };
  } else if (key === "api") {
    const view = synthetic ? projectNodeApi(record, nowMs, connectionError) : liveApi(record, nowMs);
    if (!synthetic && view.current && view.expiresAtMs !== null) displayExpiry.set(cell, view.expiresAtMs);
    if (!synthetic && onlineScenario && displayedOnlineHosts.has(address) &&
        view.status === "Online" && view.current && view.expiresAtMs !== null) {
      displayedOnlineHosts.set(address, view.expiresAtMs);
    }
    value.classList.add("node-api-value");
    cell.dataset.apiStatus = view.status;
    cell.dataset.apiCurrent = String(view.current);
    cell.dataset.apiCheckedAt = view.checkedAtMs === null ? "" : String(view.checkedAtMs);
    value.classList.toggle("node-api-retained", !view.current && view.status !== "Unknown");
    setText(value, view.label);
    details = `${view.description}${synthetic ? "\n\nSynthetic API example; no live connection." : ""}`;
    const status = !view.current && view.status !== "Unknown" ? `last confirmed ${view.status}; current reachability unknown` : view.label;
    value.setAttribute("aria-label", `API for ${address}: ${status}. Open details.`);
    const tone: InfoTone = view.status === "Online" ? "positive" : view.status === "Offline" ? "negative" : "warning";
    information = {
      summary: view.status === "Unknown" ? [ink("API result unknown; no confirmed response yet.", "warning")]
        : [ink(view.current ? "API: " : "Last confirmed API: "), ink(view.status, tone),
          ink(view.current ? "." : "; current reachability is unknown.")],
      facts: [checkedFact(view.checkedAtMs, "Last confirmed"),
        [ink(record?.apiCheck?.confirmationPending ? "A failed attempt is awaiting confirmation."
          : view.status === "Unknown" ? "The last attempt did not establish a result."
            : view.current ? "Within its checking window." : "Stale or inconclusive; the earlier result is retained.", view.current ? "plain" : "warning")],
        "API reachability does not establish host or job activity.",
        ...(record?.apiCheck?.httpStatus ? [`Latest HTTP response: ${record.apiCheck.httpStatus}.`] : []),
      ], source: details,
    };
  } else {
    const raw = record?.values?.[key] ?? null;
    const units = key === "ping" ? "ms" : "Mbps";
    const field = key === "dl" ? "download_mbps" : key === "ul" ? "upload_mbps" : "ping_ms";
    const retained = record?.retained === true || (connectionError !== null && record?.values != null);
    value.classList.toggle("node-network-retained", retained);
    setText(value, raw === null ? "—" : String(Math.round(raw)));
    details = `${label}: ${raw === null ? "unknown" : `${raw} ${units}`}\nSource: ${synthetic ? "synthetic example of " : ""}Node Info info.network.${field}.\n\nSaved reported network reading; its measurement time and test provider are unavailable. Fetching Node Info does not run a speed test.${record?.values?.networkUnavailableReason ? `\n${record.values.networkUnavailableReason}` : ""}${retained ? "\nRetained from the last successful read." : ""}${record?.error || connectionError ? `\nRead unavailable: ${record?.error ?? connectionError}` : ""}`;
    value.setAttribute("aria-label", `${retained && raw !== null ? "Retained " : ""}${label}: ${raw === null ? "unknown" : `${raw} ${units}`} for ${address}. Open details.`);
    information = {
      summary: [ink(`${retained && raw !== null ? "Retained " : ""}${label}: `),
        ink(raw === null ? "unknown" : `${raw} ${units}`, raw === null ? "warning" : retained ? "muted" : "accent"), ink(".")],
      facts: ["Saved network reading; opening this view does not run a speed test.",
        "The test provider and measurement time were not reported.",
        checkedFact(record?.fetchedAtMs, synthetic ? "Sample observed" : "Node Info read"),
        ...(record?.values?.networkUnavailableReason ? [[ink(brief(record.values.networkUnavailableReason), "warning")]] : [])],
      source: details,
    };
  }
  rememberInfo(cell, information, value);
  value.onclick = hasRowInformation(cell) ? () => openCellInfo(cell, label) : null;
  if (!value.parentElement) cell.replaceChildren(value);
}

function renderNodeInfoStatus(nowMs: number): void {
  const notice = element("node-info-status");
  notice.hidden = !supplied || inputLoading || inputError !== null || suppliedAddresses.length === 0;
  if (notice.hidden) return;
  const views = suppliedAddresses.map(address => liveActivity(address, nowMs).state);
  const recent = views.filter(view => view.current !== null).length;
  const retained = views.filter(view => view.current === null && view.reported !== null).length;
  const failed = [...nodeInfoRecords.values()].filter(record => record.error || record.activity?.error).length;
  const noNetwork = [...nodeInfoRecords.values()].filter(record => record.values?.networkUnavailableReason).length;
  const initialLoading = nodeInfoLoading && nodeInfoRecords.size === 0 && nodeInfoError === null;
  const schedule = checkSchedule(latestCheck([...nodeInfoRecords.values()].map(record => record.fetchedAtMs)),
    stateProviderNextAt !== undefined ? stateProviderNextAt : deadlines.at(stateRefreshDueAt), stateWatching);
  const issues = readIssues([nodeInfoError, ...[...nodeInfoRecords.values()].flatMap(record => [record.error, record.activity?.error])]);
  setText(notice, initialLoading ? "Reading Node Info state and network fields…"
    : `${candidateCoveragePrefix()}${recent}/${suppliedAddresses.length} recent state readings · ${retained} retained estimates · ${suppliedAddresses.length - recent - retained} unknown${failed ? ` · ${failed} unavailable reads; last reported values retained` : ""}${noNetwork ? ` · ${noNetwork} network reports unavailable` : ""}.${nodeInfoError ? " Node Info refresh failed." : ""}${schedule}${issues} Node-backed State expires within 30 seconds; job-backed State uses its original 180-second deadline. Retained icons stay dimmed and follow the State animation setting.`);
}

function scheduleStateExpiry(): void {
  if (stateExpiryTimer !== undefined) clearTimeout(stateExpiryTimer);
  stateExpiryTimer = undefined;
  if (!supplied || !visibleStateView() || !evidenceClock.trusted) return;
  const nowMs = freshnessNow();
  const expiryDates = [...displayedExpiryDates(["api", "state"]),
    ...(onlineScenario ? displayedOnlineHosts.values() : [])];
  if (expiryDates.length === 0) return;
  const delay = Math.max(1, Math.min(...expiryDates) - nowMs);
  stateExpiryTimer = setTimeout(() => {
    // Keep buttons (and dialog return-focus targets) intact while state expires.
    const at = liveNow();
    if (activeSort.column === "api" || onlineMembershipChanged(at)) { render(); return; }
    for (const row of element("fleet-rows").querySelectorAll<HTMLTableRowElement>('tr[data-source="supplied"]')) {
      const address = row.dataset.host!;
      for (const key of ["state", "api"] as const) {
        const cell = row.querySelector<HTMLTableCellElement>(`td[data-col="${key}"]`);
        if (cell) renderNodeInfoCell(cell, key, address, nodeInfoRecords.get(address), at);
      }
    }
    renderNodeInfoStatus(at);
    if (onlineMembershipChanged(liveNow())) { renderSupplied(); return; }
    updateLiveDurations();
    scheduleStateExpiry();
  }, delay);
}

function visibleStateView(): boolean {
  return supplied && !pageHidden && document.visibilityState === "visible";
}

function scheduleStateRefresh(): void {
  if (stateRefreshTimer !== undefined) clearTimeout(stateRefreshTimer);
  stateRefreshTimer = undefined;
  if (!visibleStateView() || nodeInfoLoading || inputLoading || inputError ||
      suppliedAddresses.length === 0 || stateRefreshDueAt === null) return;
  stateRefreshTimer = setTimeout(() => {
    stateRefreshTimer = undefined;
    if (visibleStateView()) void loadNodeInfo();
  }, Math.max(0, deadlines.remaining(stateRefreshDueAt)));
}

function resumeStateView(): void {
  if (visibleStateView()) {
    // Reproject expired evidence before attempting a read after suspension.
    render();
    if (!nodeInfoAttempted) void loadNodeInfo();
  }
  scheduleStateRefresh();
  scheduleStateExpiry();
}

function renderOnlineRosterStatus(): void {
  if (onlineExpiryTimer !== undefined) clearTimeout(onlineExpiryTimer);
  onlineExpiryTimer = undefined;
  const notice = element("online-hosts-status");
  notice.hidden = !supplied || !onlineScenario;
  element("online-job-policy").hidden = notice.hidden;
  if (notice.hidden) return;
  const checked = onlineStatus?.checkedAtMs;
  const stale = onlineRosterError !== null || onlineStatus?.retained === true ||
    checked !== undefined && checked !== null && (!evidenceClock.trusted || freshnessNow() >= checked + 120_000);
  notice.dataset.stale = String(stale);
  notice.dataset.onlineCount = String(displayedOnlineHosts.size);
  notice.dataset.candidateCount = String(suppliedAddresses.length);
  setText(notice, checked === undefined || checked === null
    ? onlineRosterError ?? "Finding Online GPU Hosts…"
    : `${displayedOnlineHosts.size}/${suppliedAddresses.length} Explorer candidates confirmed API Online. Offline/unconfirmed hosts hidden; checks continue while viewed. ${stale ? "Discovery list stale" : "Explorer candidate list"} · Last checked ${timestamp(checked)}.${stale
      ? ` ${onlineRosterError ?? onlineStatus?.discoveryError ?? "Waiting for a current host list."}`
      : " Updates every minute while viewed."}`);
  // List expiry is independent of detail progress and the discovery request's
  // network timeout, including an empty fleet or a stalled browser connection.
  if (!stale && checked !== undefined && checked !== null && visibleStateView()) {
    onlineExpiryTimer = setTimeout(renderOnlineRosterStatus, Math.max(50, checked + 120_000 - freshnessNow()));
  }
}

function renderSuppliedStatus(nodeProjectionTime: number): void {
  renderOnlineRosterStatus();
  setHostCount(inputLoading || inputError ? null : onlineScenario ? displayedOnlineHosts.size : suppliedAddresses.length);
  const available = [...metadataRecords.values()].filter((record) => record.values !== null).length;
  const unavailable = [...metadataRecords.values()].filter((record) => record.error || record.marketError).length;
  const initialMetadataLoading = metadataLoading && metadataRecords.size === 0 && metadataError === null;
  setText(element("inventory-summary"), inputLoading ? fleetConfig.sourceMode === "snapshot" ? "Loading Fleet hosts…"
    : onlineScenario ? "Finding Online GPU Hosts…" : "Loading supplied Host Addresses…" : inputError
    ? "Host Address input unavailable" : initialMetadataLoading ? "Loading reported Nosana metadata…"
      : `${candidateCoveragePrefix()}Reported Nosana metadata · ${available}/${suppliedAddresses.length} host reports available`);
  setText(element("metadata-status"), initialMetadataLoading ? "Reading Nosana metadata…" : metadataError
    ? `Metadata refresh failed: ${metadataError}${available ? " Previously reported values are retained." : " Fields remain unknown."}`
    : unavailable ? `${unavailable} host ${unavailable === 1 ? "report has" : "reports have"} unavailable reads. Select a value for details; retained values are gray.`
      : fleetConfig.sourceMode === "snapshot" ? "Reported metadata from backend snapshots; source times are unchanged by this view."
        : "Reported Nosana metadata. Successful metrics reads are cached for five minutes; State is checked separately.");
  element("metadata-status").hidden = inputLoading || inputError !== null || suppliedAddresses.length === 0;
  renderNodeInfoStatus(nodeProjectionTime);
  renderJobStatus(nodeProjectionTime);
  renderQueueStatus();
  renderSolStatus(nodeProjectionTime);
  renderNosStatus(nodeProjectionTime);
  renderStakingStatus(nodeProjectionTime);
  setText(element("sample-clock"), "");
  setText(element("pc-count"), "");
  element("runtime-scopes").replaceChildren();
  setText(element("scenario-description"), fleetConfig.sourceMode === "snapshot"
    ? "The source supplies this fleet’s host list. Reload to read a changed roster; refreshing values preserves the current roster."
    : onlineScenario ? "Online GPU Hosts checks Explorer’s queued/running candidates and shows only hosts with a current, validated API Online result. Online proof expires after 30 seconds; offline, unknown and expired results are hidden while their checks continue. Discovery refreshes every minute while viewed; removal from its candidate list requires two complete checks. Diagnostics cover all Explorer candidates, including hidden hosts. Duration reuses cached timing collected for Supplied Host Addresses or Real200; this scenario starts no job lookups. API reachability does not establish GPU health or current job activity. Shared request limits can leave readings pending or stale. No host file or restart is required when membership changes."
    : `${liveScenario === "real200" ? "Real200 uses its separate supplied Host Address list; the count above reflects the file contents. " : ""}Addresses are read when the preview starts. Edit the supplied file outside the app and restart the preview to load changes.`);
}

function renderSupplied(): void {
  const nodeProjectionTime = liveNow();
  if (onlineScenario) displayedOnlineHosts = new Map(suppliedAddresses.flatMap(address => {
    const deadline = onlineHostProof(address, nodeProjectionTime);
    return deadline === null ? [] : [[address, deadline] as const];
  }));
  const displayedAddresses = onlineScenario ? suppliedAddresses.filter(address => displayedOnlineHosts.has(address)) : suppliedAddresses;
  renderSuppliedStatus(nodeProjectionTime);
  const tbody = element("fleet-rows");
  const connectedRows = new Map([...tbody.querySelectorAll<HTMLTableRowElement>('tr[data-source="supplied"]')]
    .map(row => [row.dataset.host!, row]));
  const rows: HTMLTableRowElement[] = [];
  const sortableRows = displayedAddresses.map((address) => ({
    pc: "", gpuIndex: null, containerName: "", solLamports: solRecords.get(address)?.lamports ?? null,
    nosAmount: nosRecords.get(address)?.amount ?? null,
    stakedNosAmount: stakingRecords.get(address)?.stake.amount ?? null, values: {
      hostAddress: address,
      duration: liveDuration(address, nodeProjectionTime).elapsedSeconds,
      queued: liveQueue(address, nodeProjectionTime).sortValue,
      ...Object.fromEntries(METADATA_COLUMNS.map((key) => [key, metadataValue(metadataRecords.get(address)?.values, key)])),
      state: liveActivity(address, nodeProjectionTime).state.reported,
      api: liveApi(nodeInfoRecords.get(address), nodeProjectionTime).label,
      dl: nodeInfoRecords.get(address)?.values?.dl ?? null,
      ul: nodeInfoRecords.get(address)?.values?.ul ?? null,
      ping: nodeInfoRecords.get(address)?.values?.ping ?? null,
    }, address,
  }));
  for (const { address } of sortFleetRows(sortableRows, activeSort)) {
    const row = connectedRows.get(address) ?? document.createElement("tr");
    row.dataset.host = address;
    row.dataset.source = "supplied";
    row.setAttribute("aria-label", `${onlineScenario ? "Confirmed API Online" : "Supplied"} host address ${address}`);
    for (const [key, label] of COLUMNS) {
      const cell = row.querySelector<HTMLTableCellElement>(`td[data-col="${key}"]`) ?? document.createElement("td");
      cell.dataset.col = key;
      if (key === "hostAddress") {
        const link = cell.querySelector<HTMLAnchorElement>(".host-address") ?? document.createElement("a");
        link.className = "host-address";
        link.href = `https://explore.nosana.com/hosts/${encodeURIComponent(address)}`;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        setText(link, hostAddressMode === "full" ? address : address.slice(0, 5));
        if (hostAddressMode === "compact") link.title = address;
        else link.removeAttribute("title");
        link.setAttribute("aria-label", `Open ${address} in Nosana Explorer (new tab)`);
        if (!link.parentElement) cell.append(link);
      } else if (key === "sol") {
        renderSolCell(cell, address, nodeProjectionTime);
      } else if (key === "nos") {
        renderNosCell(cell, address, nodeProjectionTime);
      } else if (key === "stakedNos") {
        renderStakingCell(cell, address, nodeProjectionTime);
      } else if (key === "duration") {
        renderLiveDuration(cell, address, nodeProjectionTime);
      } else if (key === "queued") {
        renderLiveQueue(cell, address, nodeProjectionTime);
      } else if (isMetadataColumn(key)) {
        renderMetadataCell(cell, key, label, address, metadataRecords.get(address));
      } else if (key === "state" || key === "api" || key === "dl" || key === "ul" || key === "ping") {
        renderNodeInfoCell(cell, key, address, nodeInfoRecords.get(address), nodeProjectionTime);
      } else {
        setText(cell, "—");
        cell.className = "unknown";
        cell.setAttribute("aria-label", `${label}: unknown`);
        if (hasRowInformation(cell)) cell.title = `${label}: unknown; no reading is connected yet.`;
      }
      if (!cell.parentElement) row.append(cell);
      if (key === "duration" && !row.querySelector(".column-divider")) cell.after(dividerCell("td"));
    }
    renderQueuedDurationRow(row);
    rows.push(row);
  }
  if (onlineScenario) {
    // Eligibility captured before a large render may have expired while cells
    // were built. Do not publish those rows and wait for a later expiry timer.
    for (let index = rows.length - 1; index >= 0; index--) {
      const address = rows[index]!.dataset.host!;
      if (onlineHostProof(address, liveNow()) !== null) continue;
      rows.splice(index, 1);
      displayedOnlineHosts.delete(address);
    }
    renderOnlineRosterStatus();
    setHostCount(inputLoading || inputError ? null : displayedOnlineHosts.size);
  }
  if (rows.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = COLUMNS.length + (queuedDurationLayout === "combined" ? 0 : 1);
    cell.className = "empty-message";
    const message = document.createElement("span");
    message.className = "empty-content";
    message.textContent = onlineScenario ? inputLoading ? "Finding Online GPU Hosts…" : inputError
      ? "Online GPU host discovery is unavailable. Retrying automatically."
      : suppliedAddresses.length === 0 ? "Nosana’s indexer currently reports no queued or running candidates. The list updates automatically."
        : "No Explorer candidates have a current API Online confirmation. Offline and unconfirmed hosts are hidden; checks continue automatically while viewed."
      : inputLoading ? "Loading supplied addresses…" : inputError
      ? "No supplied addresses loaded. Correct the input file and restart the preview."
      : "The supplied list is empty. No host measurements are connected.";
    cell.append(message);
    row.append(cell);
    rows.push(row);
  }
  // Only touch row placement when identities or actual order changed. Moving a
  // still-correct row through a fragment would restart its CSS animations.
  const wanted = new Set(rows);
  const removed = [...tbody.children].filter(old => !wanted.has(old as HTMLTableRowElement));
  const removedOpener = infoReturnTarget !== null && removed.some(row => row.contains(infoReturnTarget));
  const removedFocus = removed.some(row => row.contains(document.activeElement));
  if (removedOpener) {
    infoReturnTarget = null;
    if (dialog.open) dialog.close();
  }
  for (const old of [...tbody.children]) if (!wanted.has(old as HTMLTableRowElement)) old.remove();
  rows.forEach((row, index) => {
    const at = tbody.children.item(index);
    if (at === row) return;
    if (row.parentElement === tbody && typeof tbody.moveBefore === "function") {
      // Supported browsers can preserve focus and animation even when sorting
      // actually changes the row order.
      tbody.moveBefore(row, at);
    } else {
      tbody.insertBefore(row, at);
    }
  });
  if (removedOpener || removedFocus) select.focus({ preventScroll: true });
  scheduleStateExpiry();
  scheduleSolExpiry();
  scheduleNosExpiry();
  scheduleStakingExpiry();
}

function render(): void {
  renderDisplaySettings();
  setText(element("data-label"), fleetConfig.sourceMode === "snapshot" ? fleetConfig.sourceLabel
    : supplied ? onlineScenario ? "Online GPU Hosts" : liveScenario === "real200" ? "Real200" : "Supplied addresses" : "Sample data");
  setText(element("connection-note"), fleetConfig.sourceMode === "snapshot" ? "Original observation times preserved"
    : supplied ? "Public Nosana metadata" : "No live connections");
  setText(element("fleet-caption"), fleetConfig.sourceMode === "snapshot"
    ? `${fleetConfig.sourceLabel}. Retained and unknown observations remain identified.` : supplied
    ? onlineScenario ? "Online GPU Hosts: Explorer candidates with current, validated API Online responses. Offline and unconfirmed hosts are hidden while checks continue. API reachability does not establish current job activity. Unconnected fields are unknown."
    : `${liveScenario === "real200" ? "Real200: " : ""}Supplied Nosana Host Addresses and selected reported metadata. Unconnected fields are unknown.`
    : "Sample Nosana Fleet inventory. Unconnected measurements are unknown.");
  element("input-error").hidden = !supplied || inputError === null;
  setText(element("input-error"), inputError ?? "");
  element<HTMLButtonElement>("advance-time").disabled = supplied;
  element<HTMLButtonElement>("reset-sample").disabled = supplied;
  element("clock-help").hidden = supplied;
  element("inventory-details").hidden = supplied;
  if (!supplied) {
    element("online-hosts-status").hidden = true;
    element("online-job-policy").hidden = true;
    element("metadata-status").hidden = true;
    element("sol-status").hidden = true;
    element("nos-status").hidden = true;
    element("staking-status").hidden = true;
    element("node-info-status").hidden = true;
    element("jobs-status").hidden = true;
    element("queue-status").hidden = true;
    scheduleStateExpiry();
  }
  setText(element("preview-description"), fleetConfig.sourceMode === "snapshot"
    ? `${fleetConfig.sourceLabel}. This view reads backend observations; opening or refreshing it does not establish new host evidence. Each value keeps its original source time and freshness deadline. Missing observations stay unknown; retained timings remain dimmed estimates. Host activity and API reachability are independent.` : supplied
    ? "Metadata comes from Nosana metrics; State uses Node Info with independent job/queue evidence when needed. API shows reachability from that same check; DL/UL/Ping also use Node Info. Duration uses assigned Nosana jobs with an independent local clock; Queued uses the ordered Nosana market queue. SOL uses confirmed public mainnet RPC with shared best-effort 30-second checks. NOS checks standard associated token accounts every two minutes. Staked NOS checks vault holdings and current market targets every 30 minutes. Latest-job history, claimable rewards and physical GPU identity remain unconnected. Duration shows Populating.. until useful timing arrives, and a dash for current confirmed absence or unavailable timing while API Offline is confirmed; State uses a dim amber spinner until useful activity arrives. Other unconnected fields stay unknown. Synthetic scenarios stay separate."
    : "Sample preview. Market names and hardware readings are synthetic; Job durations and Node states add separate synthetic examples. No live data sources are connected. A dash means unknown, not zero.");
  if (supplied) {
    renderSupplied();
    return;
  }
  const view = projectFleet(inventory, sampleNow);
  const total = view.counts.currentHosts + view.counts.retainedHosts;
  const pending = view.pcs.flatMap((pc) => pc.runtimes).filter((runtime) => runtime.inventoryObservedAtMs === null).length;
  setHostCount(total);
  const pcCountLabel = `${view.counts.pcs} ${view.counts.pcs === 1 ? "PC" : "PCs"}`;
  element("inventory-summary").textContent = `${pcCountLabel} · ${view.counts.currentHosts} current · ${view.counts.retainedHosts} retained${pending ? ` · ${pending} unknown ${pending === 1 ? "inventory" : "inventories"}` : ""}`;
  element("sample-clock").textContent = `Sample clock ${new Date(sampleNow).toISOString().slice(11, 19)} UTC`;
  element("pc-count").textContent = `· ${pcCountLabel}`;
  element("scenario-description").textContent = SCENARIOS.find((scenario) => scenario.id === selected)?.description ?? "";
  const rows = document.createDocumentFragment();
  const sortableRows: PreviewRow[] = [];
  const scopes = document.createDocumentFragment();
  view.pcs.forEach((pc, pcIndex) => {
    for (const runtime of pc.runtimes) {
      const addresses = sampleAddresses(pcIndex);
      for (const host of runtime.hosts) {
        const durationInput = sampleDuration(selected, host.id);
        const duration = projectDuration(durationInput, sampleNow);
        const market = projectMarket(sampleMarket(host.id), marketMode, sampleNow);
        const hardware = sampleHardware(host.id);
        sortableRows.push({
          pc: pc.pcId, gpuIndex: null, containerName: host.name,
          pcView: pc, runtime, host, addresses, durationInput, duration, market, hardware,
          values: {
            pc: pc.pcId, ip: addresses.internal,
            duration: duration.elapsedSeconds,
            latestJob: durationInput?.displayedJobId ?? null,
            queued: duration.kind === "queue" ? durationInput?.activity?.queuePosition ?? null : null,
            market: market.fullLabel,
            nvidia: hardware.values.nvidia,
            cpu: hardware.values.cpu,
            system: hardware.values.system,
            state: sampleNodeInfo(selected, host.id)?.values?.state ?? null,
            api: projectNodeApi(sampleNodeInfo(selected, host.id), sampleNow).label,
            dl: sampleNodeInfo(selected, host.id)?.values?.dl ?? null,
            ul: sampleNodeInfo(selected, host.id)?.values?.ul ?? null,
            ping: sampleNodeInfo(selected, host.id)?.values?.ping ?? null,
          },
        });
      }
      const scope = document.createElement("li");
      scope.dataset.pc = pc.pcId;
      scope.dataset.runtime = runtime.runtimeId;
      scope.dataset.freshness = runtime.freshness;
      const name = document.createElement("strong");
      name.textContent = `${pc.pcId} / ${runtime.runtimeId}`;
      const status = document.createElement("span");
      status.textContent = inventoryLabel(runtime);
      status.className = `scope-status ${runtime.freshness}`;
      const detail = document.createElement("span");
      detail.className = "scope-time";
      detail.textContent = runtime.inventoryObservedAtMs === null
        ? "Host count unknown"
        : `${runtime.hosts.length} observed ${runtime.hosts.length === 1 ? "host" : "hosts"} · ${ageLabel(runtime.inventoryAgeMs)} ago`;
      scope.append(name, status, detail);
      if (runtime.error) {
        const error = document.createElement("span");
        error.textContent = runtime.error;
        scope.append(error);
      }
      scopes.append(scope);
    }
  });
  for (const row of sortFleetRows(sortableRows, activeSort)) rows.append(renderRow(row));
  if (total === 0) {
    const empty = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = COLUMNS.length + (queuedDurationLayout === "combined" ? 0 : 1);
    cell.className = "empty-message";
    const message = document.createElement("span");
    message.className = "empty-content";
    message.textContent = pending > 0 ? "No inventory received yet. Host count is unknown."
      : view.pcs.every((pc) => pc.runtimes.every((runtime) => runtime.freshness === "fresh"))
        ? "The sample runtime reported no hosts."
        : "The last sample reading was empty. Current inventory is unknown.";
    cell.append(message);
    empty.append(cell);
    rows.append(empty);
  }
  element("fleet-rows").replaceChildren(rows);
  element("runtime-scopes").replaceChildren(scopes);
}

select.addEventListener("change", () => {
  const scenario = SCENARIOS.find((value) => value.id === select.value);
  const nextLive = select.value === "supplied" || select.value === "real200" || select.value === "online-gpu-hosts" ? select.value : null;
  if (!scenario && nextLive === null) return;
  if (nextLive !== null && nextLive !== liveScenario) {
    pageHidden = true;
    resumeVisibleView();
    const nextURL = new URL(location.href);
    nextURL.searchParams.set("scenario", nextLive);
    location.assign(nextURL);
    return;
  }
  supplied = nextLive !== null;
  if (scenario) selected = scenario.id;
  inventory = sampleInventory(selected);
  sampleNow = SAMPLE_TIME;
  render();
  resumeVisibleView();
  document.querySelector<HTMLElement>(".fleet-table-wrap")!.scrollLeft = 0;
  window.scrollTo({ top: 0, left: 0 });
});
element("advance-time").addEventListener("click", () => { sampleNow += 30_000; render(); });
element("refresh-view").addEventListener("click", () => {
  if (supplied && onlineScenario) void onlineRosterController?.refresh();
  if (fleetConfig.sourceMode === "snapshot" && inputError !== null && !rosterEstablished) {
    void loadHostRoster();
    return;
  }
  if (supplied) { void loadMetadata(); void loadNodeInfo(); void loadJobs(); void loadQueue(); void loadSol(); void loadNos(); void loadStaking(); }
  else render();
});
element("reset-sample").addEventListener("click", () => {
  sampleNow = SAMPLE_TIME;
  inventory = sampleInventory(selected);
  render();
});
document.addEventListener("visibilitychange", resumeVisibleView);
window.addEventListener("pagehide", () => {
  pageHidden = true;
  resumeVisibleView();
});
window.addEventListener("pageshow", () => {
  pageHidden = false;
  resumeVisibleView();
});
render();

async function loadMetadata(): Promise<void> {
  if (metadataLoading || inputLoading || inputError || suppliedAddresses.length === 0 || !visibleStateView()) return;
  metadataAttempted = true;
  metadataLoading = true;
  const controller = startRead("metadata");
  render();
  try {
    await readProgressive("metadata", "metadata", controller, isMetadataRecord, (records, complete) => {
      if (records.some(record => record.values?.marketAddress !== metadataRecords.get(record.address)?.values?.marketAddress)) {
        stakingMarketRefreshRequested = true;
      }
      if (complete) metadataRecords = new Map(records.map(record => [record.address, record]));
      else for (const record of records) metadataRecords.set(record.address, record);
      metadataError = null;
      if (!complete) scheduleProgressRender("metadata", records);
      updateStaking();
      scheduleStakingExpiry();
      refreshChangedStakingMarkets();
    });
  } catch (error) {
    if (!currentRead("metadata", controller)) return;
    metadataError = fleetReadError(error, "The reported fields could not be read. Try Refresh view again.");
  } finally {
    if (!currentRead("metadata", controller)) return;
    activeReads.delete("metadata");
    metadataLoading = false;
    // Metadata remains demand-driven. Resume checks its source-cache deadline,
    // without adding a background metadata loop or replaying missed refreshes.
    const times = [...metadataRecords.values()].flatMap(record => record.fetchedAtMs === null ? [] : [record.fetchedAtMs]);
    const failed = metadataError !== null || [...metadataRecords.values()].some(record => record.error !== null);
    metadataRefreshDueAt = failed ? deadlines.after(60_000) : times.length === 0 ? deadlines.after(300_000)
      : deadlines.source(Math.min(...times) + 300_000);
    render();
  }
}

async function loadNodeInfo(): Promise<void> {
  if (nodeInfoLoading || inputLoading || inputError || suppliedAddresses.length === 0 || !visibleStateView()) return;
  const previousRefreshDueAt = stateRefreshDueAt;
  let upstreamNextAt: number | null | undefined;
  if (stateRefreshTimer !== undefined) clearTimeout(stateRefreshTimer);
  stateRefreshTimer = undefined;
  nodeInfoAttempted = true;
  nodeInfoLoading = true;
  const controller = startRead("state");
  let madeProgress = false;
  render();
  const readStartedAt = performance.now();
  try {
    await readProgressive("node-info", "state", controller, isNodeInfoRecord, (records, complete, payload) => {
      if (complete || payload.watching === true) {
        upstreamNextAt = snapshotDeadline(payload);
        stateProviderNextAt = upstreamNextAt;
      }
      stateWatching = payload.watching === true && !complete;
      const newRunningAssignment = records.some(record => {
        const previous = nodeInfoRecords.get(record.address);
        // A first State response can arrive after an empty cached job snapshot.
        // It must wake discovery too, without duplicating an ordinary cold read
        // or invalidating a timing that is already known.
        return (previous !== undefined || jobRecords.get(record.address)?.job === null) &&
          projectNodeState(previous, liveNow(), nodeInfoError).reported !== "RUNNING_JOB" &&
          projectNodeState(record, liveNow()).current === "RUNNING_JOB";
      });
      madeProgress = hasNewStateReads(records, nodeInfoRecords) || madeProgress;
      const updated = records.map(record => [record.address, retainFailedActivity(record, nodeInfoRecords.get(record.address))] as const);
      if (complete) nodeInfoRecords = new Map(updated);
      else for (const [address, record] of updated) nodeInfoRecords.set(address, record);
      nodeInfoError = null;
      // Record supersession before coalesced rendering can skip an intermediate frame.
      for (const record of records) liveActivity(record.address, liveNow());
      if (newRunningAssignment) {
        if (jobsLoading) jobRefreshRequested = true;
        else void loadJobs();
      }
      if (!complete) scheduleProgressRender("state", records);
    });
  } catch (error) {
    if (!currentRead("state", controller)) return;
    nodeInfoError = fleetReadError(error, "The Node Info readings could not be loaded. Try Refresh view again.");
  } finally {
    if (!currentRead("state", controller)) return;
    activeReads.delete("state");
    nodeInfoLoading = false;
    stateWatching = false;
    const completedAt = liveNow();
    const nextDelay = nodeInfoError ? STATE_REFRESH_INTERVAL_MS
      : nextStateRefreshDelay([...nodeInfoRecords.values()], completedAt, madeProgress, performance.now() - readStartedAt);
    // A manual read served from cache must not postpone an already planned
    // update. A failed/unchanged overdue read still waits, avoiding rapid retries.
    const next = deadlines.after(nextDelay);
    stateRefreshDueAt = nodeInfoError === null && upstreamNextAt !== undefined
      ? deadlines.source(upstreamNextAt, 1_000)
      : !madeProgress && previousRefreshDueAt !== null && deadlines.remaining(previousRefreshDueAt) > 0
        ? deadlines.earlier(previousRefreshDueAt, next) : next;
    render();
    scheduleStateRefresh();
  }
}

function nextLegacyJobDeadline(at: number): RefreshDeadline {
  const records = [...jobRecords.values()];
  const next = nextJobRefreshAt(records, at);
  // The finite-provider compatibility policy can choose either a source date
  // or a local wait. Preserve that distinction when the server clock advances.
  const source = records.some(record => record.retryAtMs === next && next > at ||
    !record.pending && record.error === null && record.checkedAtMs !== null &&
    (record.retryAtMs === null || record.retryAtMs <= at) && next > at &&
    record.checkedAtMs + (record.job === null ? 60_000 : JOB_REFRESH_INTERVAL_MS) === next);
  return source ? deadlines.source(next)! : deadlines.after(next - at);
}

async function loadJobs(): Promise<void> {
  if (jobsLoading || inputLoading || inputError || suppliedAddresses.length === 0 || !visibleStateView()) return;
  const previousDueAt = jobRefreshDueAt;
  let upstreamNextAt: number | null | undefined;
  if (jobRefreshTimer !== undefined) clearTimeout(jobRefreshTimer);
  jobRefreshTimer = undefined;
  jobsAttempted = true;
  jobsLoading = true;
  const controller = startRead("jobs");
  renderJobStatus(liveNow());
  try {
    await readProgressive("jobs", "jobs", controller, isJobRecord, (records, complete, payload) => {
      const next = complete ? new Map<string, JobRecord>() : new Map(jobRecords);
      for (const record of records) next.set(record.address, record);
      const assignedJobs = [...next.values()].flatMap(record => record.job === null ? [] : [record.job.address]);
      if (new Set(assignedJobs).size !== assignedJobs.length) throw new Error("Conflicting job identities across hosts.");
      if (complete && payload.nextRefreshAtMs !== undefined) {
        if (payload.nextRefreshAtMs !== null && (typeof payload.nextRefreshAtMs !== "number" ||
            !Number.isSafeInteger(payload.nextRefreshAtMs) || payload.nextRefreshAtMs < 0)) throw new Error("Invalid job refresh deadline.");
        upstreamNextAt = payload.nextRefreshAtMs;
      }
      if (complete) {
        if (payload.waitReason !== undefined && payload.waitReason !== null &&
            payload.waitReason !== "retry-after" && payload.waitReason !== "local-budget" && payload.waitReason !== "discovery-budget") {
          throw new Error("Invalid job wait reason.");
        }
        if (payload.waitUntilMs !== undefined && payload.waitUntilMs !== null &&
            (typeof payload.waitUntilMs !== "number" || !Number.isSafeInteger(payload.waitUntilMs) ||
             payload.waitUntilMs < 0 || payload.waitUntilMs > 8_640_000_000_000_000)) throw new Error("Invalid job wait deadline.");
        jobProviderNextAt = upstreamNextAt;
        jobWaitReason = payload.waitReason ?? null;
        jobWaitUntilMs = payload.waitUntilMs ?? null;
      }
      jobRecords = next;
      jobsError = null;
      for (const record of records) liveActivity(record.address, liveNow());
      if (!complete) scheduleProgressRender("jobs", records);
    });
  } catch (error) {
    if (!currentRead("jobs", controller)) return;
    jobsError = fleetReadError(error, "The assigned job readings could not be loaded. Try Refresh view again.");
  } finally {
    if (!currentRead("jobs", controller)) return;
    activeReads.delete("jobs");
    jobsLoading = false;
    const nowMs = liveNow();
    // A bounded server read can finish successfully with eligible work still
    // pending. Continue from its cache promptly instead of adding another 30s
    // to every portion. Future provider/quota deadlines remain authoritative.
    const pendingContinuation = [...jobRecords.values()].some(record => record.pending);
    const next = jobsError === null && upstreamNextAt !== undefined
      ? upstreamNextAt === null ? null : upstreamNextAt > nowMs ? deadlines.source(upstreamNextAt, pendingContinuation ? 1_000 : 0)
        : deadlines.after(pendingContinuation ? 1_000 : 30_000)
      : jobsError === null ? nextLegacyJobDeadline(nowMs) : deadlines.after(JOB_REFRESH_INTERVAL_MS);
    // Source times keep cached reads on schedule. An explicit provider retry can
    // move the deadline later, including an hourly/daily budget pause.
    jobRefreshDueAt = jobsError !== null && previousDueAt !== null && deadlines.remaining(previousDueAt) > 0
      ? deadlines.earlier(previousDueAt, next) : next;
    if (jobRefreshRequested) {
      jobRefreshRequested = false;
      // A State hint may have changed shared eligibility after this response was
      // captured. Recheck the preview once, even when the older snapshot carried
      // a deadline. The server still enforces upstream budgets and Retry-After;
      // repeated RUNNING reports do not request additional follow-ups.
      jobRefreshDueAt = deadlines.after(0);
    }
    if (supplied) updateLiveDurations();
    scheduleJobRefresh();
    scheduleJobTick();
  }
}

async function loadQueue(): Promise<void> {
  if (queueLoading || inputLoading || inputError || suppliedAddresses.length === 0 || !visibleStateView()) return;
  const previousDueAt = queueRefreshDueAt;
  let upstreamNextAt: number | null | undefined;
  if (queueRefreshTimer !== undefined) clearTimeout(queueRefreshTimer);
  queueRefreshTimer = undefined;
  queueAttempted = true;
  queueLoading = true;
  const controller = startRead("queue");
  renderQueueStatus();
  try {
    await readProgressive("queue", "queue", controller, isQueueRecord, (records, complete, payload) => {
      if (complete || payload.watching === true) {
        upstreamNextAt = snapshotDeadline(payload);
        queueProviderNextAt = upstreamNextAt;
      }
      queueWatching = payload.watching === true && !complete;
      const markets = new Map<string, { signature: string; positions: Set<number> }>();
      for (const record of records) {
        if (record.marketAddress === null || record.error !== null || record.retained) continue;
        const signature = JSON.stringify([record.total, record.checkedAtMs, record.validUntilMs, record.sourceUpdatedAtMs]);
        const market = markets.get(record.marketAddress) ?? { signature, positions: new Set<number>() };
        if (market.signature !== signature || record.position !== null && market.positions.has(record.position)) {
          throw new Error("Conflicting positions or snapshots for the same market queue.");
        }
        if (record.position !== null) market.positions.add(record.position);
        markets.set(record.marketAddress, market);
      }
      if (complete) queueRecords = new Map(records.map(record => [record.address, record]));
      else for (const record of records) queueRecords.set(record.address, record);
      queueError = null;
      for (const record of records) liveActivity(record.address, liveNow());
      if (!complete) scheduleProgressRender("queue", records);
    });
  } catch (error) {
    if (!currentRead("queue", controller)) return;
    queueError = fleetReadError(error, "The Nosana queue readings could not be loaded. Try Refresh view again.");
  } finally {
    if (!currentRead("queue", controller)) return;
    activeReads.delete("queue");
    queueLoading = false;
    queueWatching = false;
    const next = deadlines.after(QUEUE_REFRESH_INTERVAL_MS);
    // A manual cached read cannot postpone the independent visible-view check.
    queueRefreshDueAt = queueError === null && upstreamNextAt !== undefined
      ? deadlines.source(upstreamNextAt, 1_000)
      : previousDueAt !== null && deadlines.remaining(previousDueAt) > 0 ? deadlines.earlier(previousDueAt, next) : next;
    if (supplied) updateLiveDurations();
    scheduleQueueRefresh();
    scheduleQueueExpiry();
  }
}

function beginLiveReads(): void {
  if (!supplied || !rosterEstablished) return;
  void loadMetadata();
  void loadNodeInfo();
  void loadJobs();
  scheduleJobTick();
  void loadQueue();
  void loadSol();
  void loadNos();
  void loadStaking();
}

// File-backed and snapshot rosters remain fixed for this page.
async function loadHostRoster(): Promise<void> {
  if (rosterEstablished || rosterReadPending) return;
  rosterReadPending = true;
  inputLoading = true;
  inputError = null;
  render();
  try {
    const result = await fleetTransport.roster(previewURL("hosts"));
    if (result.error !== null) throw new Error(result.error);
    suppliedAddresses = result.addresses;
    activityDisplay.prune(suppliedAddresses);
    rosterEstablished = true;
  } catch (error) {
    inputError = fleetReadError(error, error instanceof Error ? error.message : "Fleet host roster is unavailable.");
    if (fleetConfig.sourceMode === "snapshot") inputError += " Use Refresh view to retry.";
  } finally {
    rosterReadPending = false;
    inputLoading = false;
    render();
  }
  beginLiveReads();
}

if (onlineScenario) {
  onlineRosterController = createOnlineRosterController({
    visible: visibleStateView,
    now: liveNow,
    read: async signal => {
      const result = await fleetTransport.roster(previewURL("hosts"), signal);
      if (!result.online) throw new Error("Online GPU host discovery is not supported by this server.");
      return { ...result, online: result.online };
    },
    pending() {
      if (!rosterEstablished) { inputLoading = true; inputError = null; render(); }
      else renderOnlineRosterStatus();
    },
    failed(message) {
      onlineRosterError = message;
      inputLoading = false;
      if (!rosterEstablished) inputError = message;
      render();
    },
    apply(snapshot, changed) {
      if (changed) {
        pauseReads();
        const allowed = new Set(snapshot.addresses);
        const target = infoReturnTarget?.closest<HTMLTableRowElement>("tr[data-host]");
        const focused = document.activeElement?.closest<HTMLTableRowElement>("tr[data-host]");
        if (target?.dataset.host && !allowed.has(target.dataset.host)) {
          if (dialog.open) dialog.close();
          infoReturnTarget = null;
          select.focus({ preventScroll: true });
        } else if (focused?.dataset.host && !allowed.has(focused.dataset.host)) select.focus({ preventScroll: true });
        suppliedAddresses = [...snapshot.addresses];
        for (const records of [metadataRecords, nodeInfoRecords, jobRecords, queueRecords, solRecords, nosRecords, stakingRecords]) {
          for (const address of records.keys()) if (!allowed.has(address)) records.delete(address);
        }
        activityDisplay.prune(suppliedAddresses);
        metadataRefreshDueAt = stateRefreshDueAt = jobRefreshDueAt = queueRefreshDueAt =
          solRefreshDueAt = nosRefreshDueAt = stakingRefreshDueAt = null;
        stateProviderNextAt = jobProviderNextAt = queueProviderNextAt = undefined;
        metadataAttempted = nodeInfoAttempted = jobsAttempted = queueAttempted = solAttempted = nosAttempted = stakingAttempted = false;
      }
      onlineStatus = snapshot.online;
      onlineRosterError = snapshot.online.discoveryError;
      inputLoading = false;
      inputError = null;
      rosterEstablished = true;
      // An unchanged discovery check updates only its notice; it must not
      // restart healthy feeds, replace rows or advance observation timestamps.
      if (changed) { render(); beginLiveReads(); }
      else renderOnlineRosterStatus();
    },
  });
  await onlineRosterController.resume();
} else await loadHostRoster();
