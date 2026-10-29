import { JOB_HISTORY_CACHE_MS, JOB_HISTORY_LIMIT, JOB_HISTORY_MARKET_CACHE_MS } from "../fleet/job-history.ts";
import type { JobHistoryItem, JobHistoryRecord, JobHistorySnapshot } from "../fleet/job-history.ts";
import { JOB_DISPLAY_VALIDITY_MS } from "../fleet/jobs.ts";
import type { JobRecord } from "../fleet/jobs.ts";

interface Options {
  now: () => number;
  trusted: () => boolean;
  visible: () => boolean;
  cacheOnly: () => boolean;
  live: () => boolean;
  currentJob: (address: string) => JobRecord | undefined;
  read: (addresses: string[], refresh: boolean, signal: AbortSignal,
    apply: (snapshot: JobHistorySnapshot) => void) => Promise<unknown>;
  changed: () => void;
  expanded?: (address: string) => void;
  gpuConditions?: (item: JobHistoryItem, now: number, current: boolean) => string;
}
const setText = (node: HTMLElement, text: string): void => { if (node.textContent !== text) node.textContent = text; };
const utc = (at: number | null): string => at === null || !Number.isFinite(at) || at < 0 || at > 8_640_000_000_000_000
  ? "Unknown" : `${new Date(at).toISOString().replace("T", " ").slice(0, 19)} UTC`;
const stateLabel = (state: string): string => state.slice(0, 1) + state.slice(1).toLowerCase();
function order(jobs: Iterable<JobHistoryItem>): JobHistoryItem[] {
  return [...jobs].sort((a, b) => (b.timeStart ?? -1) - (a.timeStart ?? -1) || b.checkedAtMs - a.checkedAtMs || a.address.localeCompare(b.address));
}
function elapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86_400), hours = Math.floor(total % 86_400 / 3600);
  const minutes = Math.floor(total % 3600 / 60), remainder = total % 60;
  if (days) return `${days}d ${hours}h ${minutes}m`;
  if (hours) return `${hours}h ${minutes}m`;
  return minutes ? `${minutes}m${remainder ? ` ${remainder}s` : ""}` : `${remainder}s`;
}
const exactUTC = (at: number | null): string => at === null ? "Unknown" : new Date(at).toISOString();
function relativeStarted(start: number | null, now: number, trusted: boolean): string {
  if (!trusted || start === null || start > now) return "Unknown";
  const age = Math.floor((now - start) / 1000);
  if (age < 60) return `${age} ${age === 1 ? "second" : "seconds"} ago`;
  if (age < 3600) { const minutes = Math.floor(age / 60); return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`; }
  if (age < 86_400) { const hours = Math.floor(age / 3600); return `${hours} ${hours === 1 ? "hour" : "hours"} ago`; }
  const days = Math.floor(age / 86_400);
  return days === 1 ? "yesterday" : `${days} days ago`;
}
function historyLink(cell: HTMLTableCellElement, className: string, kind: "jobs" | "hosts", address: string): void {
  let link = cell.querySelector<HTMLAnchorElement>(`.${className}`);
  if (!link) { link = document.createElement("a"); link.className = className; cell.append(link); }
  link.href = `https://explore.nosana.com/${kind}/${encodeURIComponent(address)}`;
  link.target = "_blank"; link.rel = "noopener noreferrer";
  link.setAttribute("aria-label", `Open ${kind === "jobs" ? "job" : "host"} ${address} in Nosana Explorer (new tab)`);
  setText(link, `${address.slice(0, 16)}…`);
}
interface HistoryStatus { label: string; note: string; tone: "running" | "success" | "failed" | "unknown" | "stopped"; current: boolean }
function historyStatus(item: JobHistoryItem, current: boolean): HistoryStatus {
  if ((item.state === "RUNNING" || item.state === "QUEUED") && (item.result !== null || (item.timeEnd ?? 0) > 0)) {
    return { label: "CONFLICT", note: item.result === null ? "End reported" : "Result conflict", tone: "unknown", current: false };
  }
  if (item.state === "RUNNING") return { label: "RUNNING", note: current ? "" : "Last reported", tone: "running", current };
  if (item.state === "COMPLETED" && item.result === "success") return { label: "SUCCESS", note: "", tone: "success", current: false };
  if (item.state === "COMPLETED" && item.result === "failed") return { label: "FAILED", note: "", tone: "failed", current: false };
  if (item.state === "COMPLETED") return { label: "COMPLETED", note: "Result unknown", tone: "unknown", current: false };
  if (item.state === "STOPPED") return { label: "STOPPED", note: "", tone: "stopped", current: false };
  return { label: "QUEUED", note: "Last reported", tone: "unknown", current: false };
}
function renderHistoryStatus(cell: HTMLTableCellElement, value: HistoryStatus, item: JobHistoryItem): void {
  let badge = cell.querySelector<HTMLElement>(".job-history-status");
  if (!badge) {
    const stack = document.createElement("span"); stack.className = "job-history-status-stack";
    badge = document.createElement("span"); badge.className = "job-history-status";
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 16 16"); icon.setAttribute("width", "16"); icon.setAttribute("height", "16");
    icon.setAttribute("aria-hidden", "true"); icon.setAttribute("fill", "none"); icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.3"); icon.setAttribute("stroke-linecap", "round"); icon.setAttribute("stroke-linejoin", "round");
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", "8"); circle.setAttribute("cy", "8"); circle.setAttribute("r", "6.2");
    icon.append(circle, document.createElementNS("http://www.w3.org/2000/svg", "path"));
    const label = document.createElement("span"); label.className = "job-history-status-label";
    const note = document.createElement("span"); note.className = "job-history-status-note";
    badge.append(icon, label); stack.append(badge, note); cell.append(stack);
  }
  badge.dataset.tone = value.tone; badge.dataset.current = String(value.current);
  badge.setAttribute("aria-label", `${value.label}${value.note ? `. ${value.note}` : ""}. Lifecycle: ${stateLabel(item.state)}. Result: ${item.result ?? "unknown"}. Job checked ${exactUTC(item.checkedAtMs)}.`);
  badge.querySelector("path")!.setAttribute("d", value.tone === "success" ? "m4.7 8 2.1 2.2 4.5-4.5"
    : value.tone === "failed" ? "m5.5 5.5 5 5m0-5-5 5" : value.tone === "running" ? "m8.5 3.8-3 4.5h3L7.5 12.2l3-4.5h-3Z"
      : value.tone === "stopped" ? "M5.5 5.5h5v5h-5Z" : "M8 4.6v4M8 11.2h.01");
  setText(badge.querySelector<HTMLElement>(".job-history-status-label")!, value.label);
  const note = cell.querySelector<HTMLElement>(".job-history-status-note")!;
  setText(note, value.note); note.hidden = !value.note;
}

interface HistoryPrice { text: string; kind: "hourly" | "total" | "unknown"; retained: boolean; basis: string }
function historyPrice(item: JobHistoryItem, fields: JobHistoryItem, now: number, trusted: boolean): HistoryPrice {
  const active = item.state === "RUNNING" || item.state === "QUEUED";
  const rate = active ? fields.marketUsdRewardPerHour : fields.usdRewardPerHour;
  let value: number | null = null;
  let basis = active ? "Current market quote unavailable." : "Recorded job rate or final duration unavailable; no current-market fallback is used.";
  if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
    if (active && fields.marketAddress) {
      value = rate * 1.1;
      basis = `Market base rate ${rate} USD/hour × 1.1.`;
    } else if (!active && item.timeStart !== null && item.timeStart > 0 && item.timeEnd !== null && item.timeEnd >= item.timeStart) {
      const seconds = item.timeEnd - item.timeStart;
      value = rate * (seconds / 3600) * 1.1;
      basis = `Recorded job base rate ${rate} USD/hour × ${seconds} seconds / 3600 × 1.1.`;
    }
  }
  const known = value !== null && Number.isFinite(value) && value >= 0;
  const text = !known ? "—" : value === 0 ? "$0" : value! < .001 ? "<$0.001" : `$${value!.toFixed(3)}`;
  const checked = fields.marketCheckedAtMs, until = fields.marketValidUntilMs;
  const retained = active && known && (!trusted || checked == null || until == null || checked > now ||
    now >= Math.min(until, checked + JOB_HISTORY_MARKET_CACHE_MS));
  return { text: `${text}${active && known ? "/h" : ""}`, kind: known ? active ? "hourly" : "total" : "unknown", retained,
    basis: `${basis} Explorer-style calculated customer price includes 10%; it is not a settled invoice or host rewards.` };
}
function renderHistoryPrice(cell: HTMLTableCellElement, value: HistoryPrice): void {
  let price = cell.querySelector<HTMLElement>(".job-history-price");
  if (!price) {
    const stack = document.createElement("span"); stack.className = "job-history-price-stack";
    price = document.createElement("span"); price.className = "job-history-price";
    const note = document.createElement("span"); note.className = "job-history-price-note"; note.textContent = "Last quoted";
    stack.append(price, note); cell.append(stack);
  }
  setText(price, value.text);
  cell.dataset.priceKind = value.kind; cell.dataset.retained = String(value.retained);
  cell.querySelector<HTMLElement>(".job-history-price-note")!.hidden = !value.retained;
  cell.setAttribute("aria-label", `${value.retained ? "Last quoted: " : ""}${value.kind === "unknown" ? "Price unknown" : `Calculated customer price ${value.text}`}. ${value.basis}`);
}

/** Page-only expansion/cache. Historical records never feed State or Duration. */
export function createJobHistoryView(options: Options) {
  const expanded = new Set<string>();
  const pages = new Map<string, JobHistoryRecord>();
  const observed = new Map<string, Map<string, JobHistoryItem>>();
  const rows = new Map<string, HTMLTableRowElement>();
  const queued = new Map<string, boolean>();
  const attempted = new Set<string>();
  const errors = new Map<string, string>();
  let roster: string[] = [];
  let scope = "";
  let active: { controller: AbortController; addresses: string[]; refresh: boolean } | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let pumpTimer: ReturnType<typeof setTimeout> | undefined;
  let renderTimer: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;
  function changedSoon(): void {
    if (renderTimer !== undefined) return;
    renderTimer = setTimeout(() => { renderTimer = undefined; options.changed(); }, 16);
  }

  function jobs(address: string): JobHistoryItem[] {
    const merged = new Map(observed.get(address));
    for (const job of pages.get(address)?.jobs ?? []) {
      const prior = merged.get(job.address);
      if (!prior || job.checkedAtMs >= prior.checkedAtMs) merged.set(job.address, job);
    }
    return order(merged.values()).slice(0, JOB_HISTORY_LIMIT);
  }
  function summary(address: string): { job: JobHistoryItem; current: boolean } | null {
    const current = options.currentJob(address);
    const now = options.now();
    const newer = current?.job ? jobs(address).find(job => job.address === current.job!.address && job.checkedAtMs > (current.checkedAtMs ?? -1) && job.state !== "RUNNING") : undefined;
    if (!newer && options.trusted() && current?.job && current.job.state === "RUNNING" && !current.error && !current.retained &&
        current.checkedAtMs !== null && current.checkedAtMs <= now && current.validUntilMs !== null &&
        now < Math.min(current.validUntilMs, current.checkedAtMs + JOB_DISPLAY_VALIDITY_MS)) {
      const known = jobs(address).find(job => job.address === current.job!.address);
      if (known?.result == null && (known?.timeEnd ?? 0) === 0) {
        return { job: { ...current.job, result: null, checkedAtMs: current.checkedAtMs }, current: true };
      }
    }
    const job = jobs(address)[0];
    return job ? { job, current: false } : null;
  }
  function loading(address: string): boolean { return queued.has(address) || active?.addresses.includes(address) === true; }
  function stale(page: JobHistoryRecord | undefined): boolean {
    const now = options.now();
    return !options.trusted() || page?.checkedAtMs == null || page.retained || page.error !== null || page.validUntilMs === null ||
      now < page.checkedAtMs || now >= Math.min(page.validUntilMs, page.checkedAtMs + JOB_HISTORY_CACHE_MS);
  }
  function queue(address: string, refresh = false): void {
    if (!options.live() || !expanded.has(address)) return;
    const page = pages.get(address);
    if (!refresh && !stale(page) && !page?.pending || loading(address)) return;
    // Opening a pending page must still respect its original provider deadline.
    if (!refresh && page?.pending && page.retryAtMs !== null && page.retryAtMs > options.now()) return;
    queued.set(address, refresh);
  }
  function schedule(): void {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
    if (!options.visible() || !options.live()) return;
    if (queued.size && !active && pumpTimer === undefined) pumpTimer = setTimeout(() => {
      pumpTimer = undefined;
      void pump();
    }, 0);
    if (options.cacheOnly()) return;
    const retries = [...expanded].flatMap(address => {
      const page = pages.get(address);
      return !errors.has(address) && !loading(address) && page?.pending && page.retryAtMs !== null ? [page.retryAtMs] : [];
    });
    if (!retries.length) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      for (const address of expanded) {
        const page = pages.get(address);
        if (!errors.has(address) && page?.pending && page.retryAtMs !== null && page.retryAtMs <= options.now()) queue(address);
      }
      schedule();
      options.changed();
    }, Math.min(2_147_483_647, Math.max(1000, Math.min(...retries) - options.now())));
  }
  async function pump(): Promise<void> {
    if (active || !options.visible() || !options.live()) return;
    const first = queued.values().next().value as boolean | undefined;
    if (first === undefined) return;
    const addresses = [...queued].filter(([address, refresh]) => expanded.has(address) && refresh === first).slice(0, 100).map(([address]) => address);
    if (!addresses.length) return;
    for (const address of addresses) { queued.delete(address); attempted.add(address); errors.delete(address); }
    const request = { addresses, refresh: first, controller: new AbortController() };
    active = request;
    options.changed();
    try {
      await options.read(addresses, first, request.controller.signal, snapshot => {
        if (active !== request || request.controller.signal.aborted) return;
        for (const page of snapshot.hosts) if (expanded.has(page.address)) pages.set(page.address, page);
        changedSoon();
      });
    } catch {
      if (active === request && !request.controller.signal.aborted) for (const address of addresses) errors.set(address, "History could not be loaded. Previous records keep their original check times. Use Refresh to try again.");
    } finally {
      if (active === request) {
        active = null;
        changedSoon();
        schedule();
      }
    }
  }
  function pause(): void {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    if (pumpTimer !== undefined) clearTimeout(pumpTimer);
    if (renderTimer !== undefined) clearTimeout(renderTimer);
    retryTimer = pumpTimer = renderTimer = undefined;
    if (active) {
      const canceled = active;
      active = null;
      for (const address of canceled.addresses) if (expanded.has(address)) queued.set(address, canceled.refresh);
      canceled.controller.abort();
    }
  }
  function close(address: string): void {
    expanded.delete(address);
    queued.delete(address);
    if (active?.addresses.includes(address)) pause();
    rows.delete(address);
  }
  function toggle(address: string): void {
    if (expanded.has(address)) close(address);
    else { expanded.add(address); queue(address); options.expanded?.(address); }
    options.changed();
    schedule();
  }
  function renderCell(cell: HTMLTableCellElement, address: string, sampleId?: string | null): void {
    cell.className = "jobs-cell";
    cell.removeAttribute("title");
    let toggleButton = cell.querySelector<HTMLButtonElement>(".jobs-expand");
    if (!toggleButton) {
      toggleButton = document.createElement("button");
      toggleButton.type = "button";
      toggleButton.className = "jobs-expand";
      toggleButton.onclick = () => toggle(address);
      cell.replaceChildren(toggleButton);
      const link = document.createElement("a");
      link.className = "job-summary-link";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      cell.append(link);
    }
    const isExpanded = expanded.has(address);
    setText(toggleButton, isExpanded ? "▾" : "▸");
    toggleButton.setAttribute("aria-expanded", String(isExpanded));
    toggleButton.setAttribute("aria-label", `${isExpanded ? "Hide" : "Show"} recent jobs for ${address}`);
    const link = cell.querySelector<HTMLAnchorElement>(".job-summary-link")!;
    const reading = options.live() ? summary(address) : null;
    const id = reading?.job.address ?? sampleId ?? null;
    setText(link, id ? id.slice(0, 5) : "—");
    if (reading) {
      link.href = `https://explore.nosana.com/jobs/${encodeURIComponent(reading.job.address)}`;
      link.setAttribute("aria-label", `Open job ${reading.job.address} in Nosana Explorer (new tab)`);
    } else {
      link.removeAttribute("href");
      link.removeAttribute("aria-label");
    }
    const conflicting = reading !== null && historyStatus(reading.job, reading.current).label === "CONFLICT";
    const evidence = conflicting ? "Conflicting job evidence" : reading?.current
      ? "Current verified assignment" : "Last observed job; current activity is not confirmed";
    cell.setAttribute("aria-label", reading
      ? `Job ${reading.job.address}. Lifecycle: ${stateLabel(reading.job.state)}. ${evidence}. Checked ${utc(reading.job.checkedAtMs)}.`
      : sampleId ? `Synthetic job ${sampleId}` : "Jobs: unknown");
    const row = rows.get(address);
    if (row) toggleButton.setAttribute("aria-controls", row.id);
    else toggleButton.removeAttribute("aria-controls");
  }
  function renderExpanded(address: string, columns: number): HTMLTableRowElement | null {
    if (!expanded.has(address)) return null;
    let row = rows.get(address);
    if (!row) {
      row = document.createElement("tr");
      row.className = "job-history-row";
      row.dataset.jobHistoryHost = address;
      row.id = `job-history-${++sequence}`;
      const cell = document.createElement("td");
      const panel = document.createElement("section");
      panel.className = "job-history-panel";
      panel.setAttribute("aria-label", `Recent jobs for ${address}`);
      const toolbar = document.createElement("div");
      toolbar.className = "job-history-toolbar";
      const title = document.createElement("strong");
      title.textContent = `Recent jobs · ${address.slice(0, 5)}`;
      const refresh = document.createElement("button");
      refresh.type = "button";
      refresh.className = "job-history-refresh";
      refresh.textContent = "Refresh";
      refresh.setAttribute("aria-label", `Refresh recent jobs for ${address}`);
      refresh.onclick = () => { queue(address, true); options.expanded?.(address); schedule(); options.changed(); };
      toolbar.append(title, refresh);
      const notice = document.createElement("p");
      notice.className = "job-history-notice";
      notice.setAttribute("role", "status");
      const table = document.createElement("table");
      table.className = "job-history-table";
      table.setAttribute("aria-label", `Job history for ${address}`);
      const head = document.createElement("thead");
      const headings = document.createElement("tr");
      for (const name of ["address", "host", "started", "duration", "price", "gpu", "status"]) {
        const heading = document.createElement("th"); heading.scope = "col";
        heading.dataset.historyCol = name; heading.textContent = name.toUpperCase(); headings.append(heading);
      }
      head.append(headings);
      table.append(head, document.createElement("tbody"));
      const empty = document.createElement("p"); empty.className = "job-history-empty";
      const source = document.createElement("details"); source.className = "job-history-source";
      const sourceLabel = document.createElement("summary"); sourceLabel.textContent = "Source details";
      const sourceSummary = document.createElement("p"); sourceSummary.className = "job-history-source-summary";
      const sourceList = document.createElement("ol"); sourceList.className = "job-history-source-list";
      source.append(sourceLabel, sourceSummary, sourceList);
      panel.append(toolbar, notice, table, empty, source);
      cell.append(panel); row.append(cell); rows.set(address, row);
    }
    row.cells[0]!.colSpan = columns;
    const page = pages.get(address), items = jobs(address), busy = loading(address), now = options.now();
    const refresh = row.querySelector<HTMLButtonElement>(".job-history-refresh")!;
    refresh.disabled = busy || !options.live();
    const notice = row.querySelector<HTMLElement>(".job-history-notice")!;
    const coverage = page?.checkedAtMs == null ? "History coverage unknown; these are locally observed records."
      : page.totalJobs === null ? "History coverage unknown."
        : `Showing ${Math.min(items.length, JOB_HISTORY_LIMIT)} recent jobs; last page reported ${page.totalJobs} indexed record${page.totalJobs === 1 ? "" : "s"}${page.totalJobs > JOB_HISTORY_LIMIT ? "; more history exists" : ""}.`;
    const failure = errors.get(address) ?? page?.error ?? null;
    const messages: string[] = [];
    if (!options.live()) messages.push("Synthetic example only; live history is not requested.");
    else {
      if (busy) messages.push(items.length ? "Refreshing recent jobs…" : "Loading recent jobs…");
      if (page?.pending) messages.push(`History pending${page.retryAtMs === null ? "" : ` · retry eligible ${utc(page.retryAtMs)}`}`);
      if (failure) messages.push("History refresh unavailable");
      if (page?.checkedAtMs != null && stale(page)) messages.push("History stale");
      messages.push(`${items.length} recent job${items.length === 1 ? "" : "s"}`);
      if (page?.checkedAtMs == null) messages.push("History coverage unknown");
      else {
        if ((page.totalJobs ?? 0) > JOB_HISTORY_LIMIT) messages.push("More history available");
        messages.push(`Checked ${new Date(page.checkedAtMs).toISOString().slice(11, 16)} UTC`);
      }
      if (options.cacheOnly()) messages.push("Cached history only");
    }
    setText(notice, messages.join(" · "));
    notice.dataset.stale = String(stale(page));
    const table = row.querySelector<HTMLTableElement>(".job-history-table")!;
    table.hidden = items.length === 0 || !options.live();
    const body = table.tBodies[0]!;
    const existing = new Map([...body.rows].map(item => [item.dataset.job!, item]));
    const sourceList = row.querySelector<HTMLOListElement>(".job-history-source-list")!;
    const sourceEntries = new Map([...sourceList.children].map(item => [(item as HTMLElement).dataset.jobSource!, item as HTMLElement]));
    const wanted = new Set<string>();
    const current = summary(address);
    for (const [index, item] of items.entries()) {
      wanted.add(item.address);
      const itemRow = existing.get(item.address) ?? document.createElement("tr");
      itemRow.dataset.job = item.address;
      if (!itemRow.cells.length) for (const name of ["address", "host", "started", "duration", "price", "gpu", "status"]) {
        const cell = document.createElement("td"); cell.dataset.historyCol = name; itemRow.append(cell);
      }
      historyLink(itemRow.cells[0]!, "job-history-address", "jobs", item.address);
      historyLink(itemRow.cells[1]!, "job-history-host", "hosts", item.node);
      const start = item.timeStart !== null && item.timeStart > 0 ? item.timeStart * 1000 : null;
      const end = item.timeEnd !== null && item.timeEnd > 0 ? item.timeEnd * 1000 : null;
      const started = itemRow.cells[2]!;
      setText(started, relativeStarted(start, now, options.trusted()));
      started.setAttribute("aria-label", `Started: ${exactUTC(start)}. ${started.textContent}`);
      const estimated = start !== null && end === null && item.state === "RUNNING" && item.result === null && now >= start;
      const seconds = start === null ? null : end !== null && end >= start ? (end - start) / 1000 : estimated ? (now - start) / 1000 : null;
      const duration = itemRow.cells[3]!;
      let timing = duration.querySelector<HTMLElement>(".job-history-duration");
      if (!timing) {
        timing = document.createElement("span"); timing.className = "job-history-duration";
        const limit = document.createElement("span"); limit.className = "job-history-limit";
        duration.append(timing, limit);
      }
      setText(timing, seconds === null ? "Unknown" : `${estimated ? "~" : ""}${elapsed(seconds)}`);
      timing.dataset.estimated = String(estimated); timing.dataset.unknown = String(seconds === null);
      const knownLimit = item.timeout !== null && item.timeout > 0;
      setText(duration.querySelector<HTMLElement>(".job-history-limit")!, `(Max ${knownLimit ? elapsed(item.timeout!) : "unknown"})`);
      duration.setAttribute("aria-label", `${seconds === null ? "Duration unknown" : `${estimated ? "Estimated elapsed" : "Duration"}: ${Math.floor(seconds)} seconds`}. ${knownLimit ? `Reported maximum: ${item.timeout} seconds` : "Reported maximum unknown"}.${estimated ? " Current activity depends on original job evidence." : ""}`);
      // Current-job timing reads omit market/price fields. Use the matching
      // history observation and keep its original field-check time independent.
      const fields = page?.jobs.find(job => job.address === item.address) ?? item;
      const price = historyPrice(item, fields, now, options.trusted());
      renderHistoryPrice(itemRow.cells[4]!, price);
      const gpu = itemRow.cells[5]!;
      let marketName = gpu.querySelector<HTMLElement>(".job-history-gpu");
      if (!marketName) { marketName = document.createElement("span"); marketName.className = "job-history-gpu"; gpu.append(marketName); }
      setText(marketName, fields.marketName ?? "—");
      gpu.setAttribute("aria-label", fields.marketName ? `Job market label: ${fields.marketName}. This is not a physical GPU identity.` : "Job market label unknown");
      renderHistoryStatus(itemRow.cells[6]!, historyStatus(item, current?.current === true && current.job.address === item.address), item);
      const at = body.rows.item(index);
      if (at !== itemRow) {
        if (itemRow.isConnected && typeof body.moveBefore === "function") body.moveBefore(itemRow, at);
        else body.insertBefore(itemRow, at);
      }
      const sourceEntry = sourceEntries.get(item.address) ?? document.createElement("li");
      sourceEntry.dataset.jobSource = item.address;
      setText(sourceEntry, `Job: ${item.address}\nHost: ${item.node}\nLifecycle: ${stateLabel(item.state)}\nResult: ${item.result === "success" ? "Succeeded" : item.result === "failed" ? "Failed" : "Unavailable"}\nStarted: ${exactUTC(start)} (reported ${item.timeStart === null ? "unknown" : `${item.timeStart} seconds`})\nEnded: ${exactUTC(end)} (reported ${item.timeEnd === null ? "unknown" : `${item.timeEnd} seconds`})\nReported timeout: ${item.timeout === null ? "unknown" : `${item.timeout} seconds`}\nJob checked: ${exactUTC(item.checkedAtMs)}\nPrice/GPU fields checked: ${exactUTC(fields.checkedAtMs)}\nJob market address: ${fields.marketAddress ?? "Unknown"}\nJob market label: ${fields.marketName ?? "Unknown"}\nRecorded job rate: ${fields.usdRewardPerHour == null ? "Unknown" : `${fields.usdRewardPerHour} USD/hour`}\nMarket rate: ${fields.marketUsdRewardPerHour == null ? "Unknown" : `${fields.marketUsdRewardPerHour} USD/hour`}\nMarket checked: ${exactUTC(fields.marketCheckedAtMs ?? null)}\nMarket valid until: ${exactUTC(fields.marketValidUntilMs ?? null)}\nPrice basis: ${price.basis}${options.gpuConditions ? `\n${options.gpuConditions(item, now, current?.current === true && current.job.address === item.address)}` : ""}`);
      const sourceAt = sourceList.children.item(index);
      if (sourceAt !== sourceEntry) {
        if (sourceEntry.isConnected && typeof sourceList.moveBefore === "function") sourceList.moveBefore(sourceEntry, sourceAt);
        else sourceList.insertBefore(sourceEntry, sourceAt);
      }
    }
    for (const item of [...body.rows]) if (!wanted.has(item.dataset.job!)) item.remove();
    for (const entry of [...sourceList.children]) if (!wanted.has((entry as HTMLElement).dataset.jobSource!)) entry.remove();
    setText(row.querySelector<HTMLElement>(".job-history-source-summary")!, `Page checked: ${exactUTC(page?.checkedAtMs ?? null)}\nPage valid until: ${exactUTC(page?.validUntilMs ?? null)}\n${coverage}\n${page?.pending ? `Pending · retry eligible: ${exactUTC(page.retryAtMs)}\n` : ""}${failure ? `History error: ${failure}\n` : ""}${options.cacheOnly() ? "Cached records only; this view starts no upstream job requests.\n" : ""}Lifecycle and execution result are separate reported fields. A completed lifecycle does not establish a successful result. Check times describe our reads, not indexing freshness. ~ marks an elapsed estimate from the reported start; it does not establish current activity.`);
    const empty = row.querySelector<HTMLElement>(".job-history-empty")!;
    empty.hidden = items.length > 0 && options.live();
    setText(empty, !options.live() ? "No synthetic history is attached to this sample host."
      : busy || page?.pending ? "Waiting for recent jobs…" : page?.checkedAtMs != null && page.totalJobs === 0
        ? "No jobs were returned by the last history check." : "Job history is unavailable.");
    return row;
  }

  return {
    renderCell, renderExpanded, summary,
    observe(records: readonly JobRecord[]) {
      for (const record of records) {
        if (!record.job || record.checkedAtMs === null) continue;
        const retained = observed.get(record.address) ?? new Map<string, JobHistoryItem>();
        const prior = retained.get(record.job.address);
        if (!prior || record.checkedAtMs >= prior.checkedAtMs) retained.set(record.job.address, { ...record.job,
          result: prior?.result ?? null, checkedAtMs: record.checkedAtMs });
        observed.set(record.address, new Map(order(retained.values()).slice(0, JOB_HISTORY_LIMIT).map(job => [job.address, job])));
      }
    },
    setRoster(next: readonly string[], nextScope: string) {
      if (scope !== nextScope) {
        pause(); expanded.clear(); pages.clear(); observed.clear(); rows.clear(); queued.clear(); attempted.clear(); errors.clear(); scope = nextScope;
      }
      const rosterChanged = roster.length !== next.length || roster.some((address, index) => address !== next[index]);
      roster = [...next];
      const keep = new Set(next);
      for (const address of expanded) if (!keep.has(address)) close(address);
      for (const map of [pages, observed, rows, errors]) for (const address of map.keys()) if (!keep.has(address)) map.delete(address);
      for (const address of attempted) if (!keep.has(address)) attempted.delete(address);
      if (rosterChanged) schedule();
    },
    showAll() { for (const address of roster) { expanded.add(address); queue(address); options.expanded?.(address); } options.changed(); schedule(); },
    hideAll() { pause(); expanded.clear(); queued.clear(); rows.clear(); options.changed(); },
    pause,
    resume() {
      if (!options.visible()) { pause(); return; }
      // Ordinary visibility changes do not periodically refresh settled pages.
      for (const address of expanded) if (!attempted.has(address)) queue(address);
      schedule();
    },
    get expandedCount() { return expanded.size; },
  };
}
