import { NODE_STATES } from "./node-info.ts";
import type { NodeInfoRecord } from "./node-info.ts";

export interface NodeStateView {
  readonly reported: string | null;
  readonly current: string | null;
  readonly short: string;
  /** Unknown artwork is display-only; it never establishes a provider State. */
  readonly artwork: "running" | "queued" | "restarting" | "unknown" | null;
  readonly animated: boolean;
  readonly description: string;
  readonly retained: boolean;
  readonly source: "node" | "job" | null;
  readonly checkedAtMs: number | null;
  readonly validUntilMs: number | null;
  readonly jobAddress: string | null;
}

/** The read-validity window is local display policy, not a Nosana guarantee. */
export function projectNodeState(record: NodeInfoRecord | undefined, nowMs: number, connectionError: string | null = null): NodeStateView {
  const rawReported = record?.values?.state ?? null;
  // OTHER is a coarse fallback in the upstream classifier. Reconciliation must
  // carry positive independent evidence, never assume it means RUNNING_JOB.
  const activity = rawReported === "OTHER" ? record?.activity : undefined;
  const activityTimesValid = activity !== undefined &&
    typeof activity.checkedAtMs === "number" && Number.isSafeInteger(activity.checkedAtMs) && activity.checkedAtMs >= 0 &&
    typeof activity.validUntilMs === "number" && Number.isSafeInteger(activity.validUntilMs) && activity.validUntilMs > activity.checkedAtMs;
  const reported = activity ? !activity.error && activityTimesValid ? activity.state : null : rawReported;
  const fetched = record?.fetchedAtMs;
  const until = record?.validUntilMs;
  const known = NODE_STATES.some(state => state === reported);
  const activityValid = activity === undefined || (!activity.error && activity.state !== null && activityTimesValid &&
    activity.checkedAtMs! <= nowMs && nowMs < activity.validUntilMs! && nowMs < activity.checkedAtMs! + 30_000);
  const valid = known && !record?.error && !record?.retained && !connectionError &&
    typeof fetched === "number" && Number.isSafeInteger(fetched) && fetched >= 0 && fetched <= nowMs &&
    typeof until === "number" && Number.isSafeInteger(until) && until > fetched && nowMs < until && nowMs < fetched + 30_000 && activityValid;
  const current = valid ? reported : null;
  const error = record?.error ?? connectionError;
  const source = activity
    ? `Raw Node Info state: ${rawReported}. Independent source: Nosana indexer running-job membership and Nosana market queue membership.${activity.error ? ` ${activity.error}` : ""} ${activity.state ? "Positive indexed assignment evidence is available." : "No unambiguous activity was established."} These sources provide no synchronization watermark; request time is not a source observation timestamp.`
    : "Source: public Node Info.";
  const description = (reported === null ? `Current state unknown.${activity ? " The coarse OTHER response could not establish activity." : " No Node Info state is available."}${error ? ` ${error}` : ""}`
    : `${current ? `Reported state: ${reported}.` : `Last reported state: ${reported}. Current state unknown.`}${!known ? " Unrecognized state; no activity is inferred." : ""}${error ? ` ${error}` : ""}`
  ) + `\n\n${source}\nNode State expires within 30 seconds of each supporting read. Visible supplied addresses refresh automatically; unavailable or expired readings remain unconfirmed. Refresh view also checks again. This does not establish a current job identity, queue position or container state.`;
  return {
    reported, current, short: reported?.charAt(0) ?? "—",
    artwork: reported === "RUNNING_JOB" ? "running" : reported === "QUEUED" ? "queued" : (reported === "STARTING" || reported === "RESTARTING") ? "restarting" : null,
    animated: current === "RUNNING_JOB" || current === "QUEUED" || current === "STARTING" || current === "RESTARTING",
    description,
    retained: reported !== null && current === null,
    source: reported === null ? null : "node",
    checkedAtMs: activity ? activity.checkedAtMs : fetched ?? null,
    validUntilMs: typeof fetched === "number" && typeof until === "number"
      ? Math.min(until, fetched + 30_000, activity?.validUntilMs ?? Infinity,
        typeof activity?.checkedAtMs === "number" ? activity.checkedAtMs + 30_000 : Infinity) : null,
    jobAddress: null,
  };
}

/** Display policy is separate from the raw classifier used by request scheduling. */
export function projectNodeStateDisplay(record: NodeInfoRecord | undefined, nowMs: number, connectionError: string | null = null): NodeStateView {
  const view = projectNodeState(record, nowMs, connectionError);
  const useful = view.reported !== null && view.reported !== "OTHER" && NODE_STATES.some(state => state === view.reported);
  const checked = view.checkedAtMs;
  const validSource = typeof checked === "number" && Number.isSafeInteger(checked) && checked >= 0 && checked <= 8_640_000_000_000_000 && checked <= nowMs &&
    typeof record?.fetchedAtMs === "number" && Number.isSafeInteger(record.fetchedAtMs) && record.fetchedAtMs >= 0 && record.fetchedAtMs <= nowMs;
  if (!useful || !validSource) return {
    reported: null, current: null, short: "?", artwork: "unknown", animated: true,
    retained: false, source: null, checkedAtMs: null, validUntilMs: null, jobAddress: null,
    description: `Current state unknown. No useful activity has been established. The dim amber spinner indicates unknown activity, not a confirmed restart or a request in progress. Motion follows the State animation setting.\n\n${view.description}`,
  };
  const confirmation = new Date(checked).toISOString();
  return { ...view, retained: view.current === null, animated: view.artwork !== null,
    description: `${view.current === null ? "Retained State estimate; current activity is unconfirmed. " : ""}Original State confirmation: ${confirmation}. ${view.description}\nRetained State keeps its last useful artwork and color, dimmed; motion follows the State animation setting.` };
}

/** Schedule every state that was rendered current, even if rendering crossed its deadline. */
export function nextStateExpiryDelay(records: readonly NodeInfoRecord[], projectedAtMs: number, nowMs: number): number | null {
  const deadlines = records.filter(record => projectNodeState(record, projectedAtMs).current !== null)
    .map(record => {
      const activity = record.values?.state === "OTHER" ? record.activity : undefined;
      return Math.min(record.validUntilMs!, record.fetchedAtMs! + 30_000,
        activity?.validUntilMs ?? Infinity, activity?.checkedAtMs !== null && activity?.checkedAtMs !== undefined ? activity.checkedAtMs + 30_000 : Infinity);
    });
  return deadlines.length ? Math.max(1, Math.min(...deadlines) - nowMs + 1) : null;
}
