import { isMetadataAddress } from "./host-metadata.ts";
import { isJobTimestamp } from "./jobs.ts";
import type { JobRecord } from "./jobs.ts";
import { projectLiveDuration } from "./live-duration.ts";
import type { NodeInfoRecord } from "./node-info.ts";
import { projectNodeState } from "./node-state.ts";

export const QUEUE_REFRESH_INTERVAL_MS = 20_000;
export const QUEUE_DISPLAY_VALIDITY_MS = 30_000;

/** A position in this host's exact assigned market, not an estimated wait time. */
export interface QueueRecord {
  address: string;
  marketAddress: string | null;
  position: number | null;
  total: number | null;
  checkedAtMs: number | null;
  validUntilMs: number | null;
  /** Indexer processing/update time, not a synchronization or finality guarantee. */
  sourceUpdatedAtMs: number | null;
  retained: boolean;
  error: string | null;
}

export interface QueueSnapshot { hosts: QueueRecord[]; nextRefreshAtMs?: number | null }

export interface QueueView {
  readonly kind: "position" | "running" | "unknown";
  readonly text: string;
  readonly description: string;
  readonly current: boolean;
  /** A fresh successful queue check, including confirmed absence of a position. */
  readonly checkCurrent: boolean;
  readonly retained: boolean;
  readonly sortValue: string | null;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isQueueRecord(value: unknown): value is QueueRecord {
  if (!object(value) || !isMetadataAddress(value.address) ||
      !(value.marketAddress === null || isMetadataAddress(value.marketAddress)) ||
      typeof value.retained !== "boolean" ||
      !(value.error === null || typeof value.error === "string" && value.error.length <= 1024)) return false;
  for (const key of ["checkedAtMs", "validUntilMs", "sourceUpdatedAtMs"]) {
    if (value[key] !== null && !isJobTimestamp(value[key])) return false;
  }
  if (value.total !== null && !count(value.total)) return false;
  return value.position === null || count(value.position) && value.position > 0 &&
    count(value.total) && value.position <= value.total && value.marketAddress !== null;
}

function timestamp(value: number | null): string {
  return isJobTimestamp(value) ? new Date(value).toISOString() : "unavailable";
}

function unknown(description: string, checkCurrent = false): QueueView {
  return { kind: "unknown", text: "—", description, current: false, checkCurrent, retained: false, sortValue: null };
}

/** Resolve presentation only; reading State/Duration here never launches a read. */
export function projectQueue(
  record: QueueRecord | undefined, address: string, marketAddress: string | null, nowMs: number,
  options: { job?: JobRecord | undefined; state?: NodeInfoRecord | undefined; connectionError?: string | null;
    /** Conservative expiry time only; source validation still uses nowMs. */
    freshnessAtMs?: number } = {},
): QueueView {
  if (!isJobTimestamp(nowMs)) throw new RangeError("Clock must be non-negative integer milliseconds in the Date range");
  const freshnessAtMs = Math.max(nowMs, options.freshnessAtMs ?? nowMs);
  if (!isMetadataAddress(address) || record && (!isQueueRecord(record) || record.address !== address)) {
    return unknown("Queue position unknown: queue evidence does not match this Host Address or is invalid.");
  }
  if (!isMetadataAddress(marketAddress) || record?.marketAddress !== marketAddress) {
    return unknown("Queue position unknown: no matching current market assignment and queue reading are available.");
  }
  const error = options.connectionError ?? record.error;
  const stateView = options.state?.address === address ? projectNodeState(options.state, nowMs) : null;
  const state = stateView !== null && stateView.validUntilMs !== null &&
    freshnessAtMs < stateView.validUntilMs ? stateView.current : null;
  const duration = projectLiveDuration(options.job, address, nowMs);
  const runningAssignment = duration.kind === "duration" && duration.freshness === "current" &&
    isJobTimestamp(duration.validUntilMs) && freshnessAtMs < duration.validUntilMs;
  const runningJob = runningAssignment && duration.limitSeconds !== null;
  const timesValid = isJobTimestamp(record.checkedAtMs) && record.checkedAtMs <= nowMs &&
    isJobTimestamp(record.validUntilMs) && record.validUntilMs > record.checkedAtMs &&
    record.validUntilMs <= record.checkedAtMs + QUEUE_DISPLAY_VALIDITY_MS &&
    (record.sourceUpdatedAtMs === null || record.sourceUpdatedAtMs <= record.checkedAtMs);
  const timingValid = timesValid && freshnessAtMs < record.validUntilMs!;
  const deliveryUncertain = timesValid && nowMs < record.validUntilMs! && record.validUntilMs! <= freshnessAtMs;
  const source = `Host ${address}. Market ${marketAddress}. Source: Nosana indexer ordered host queue. API checked at ${timestamp(record.checkedAtMs)}; local display deadline ${timestamp(record.validUntilMs)}; indexer market updated at ${timestamp(record.sourceUpdatedAtMs)}. The indexer update time is its processing time, not a synchronization watermark. Position is not an estimated wait time.`;
  if (record.position !== null) {
    const conflict = runningAssignment && options.job!.checkedAtMs! >= (record.checkedAtMs ?? 0)
      ? "The independently checked job still reports a running assignment."
      : state !== null && state !== "QUEUED" && state !== "OTHER" &&
        (stateView?.checkedAtMs ?? 0) >= (record.checkedAtMs ?? 0) ? `Node Info currently reports ${state}.` : null;
    const current = timingValid && !record.retained && error === null && conflict === null;
    const text = `${record.position}/${record.total}`;
    const reason = error ?? conflict ?? (record.retained ? "The queue reading is retained after an unavailable read."
      : !timingValid ? deliveryUncertain ? "The queue evidence may have expired during delivery."
        : "The queue evidence is expired or its supporting times are invalid." : "");
    return {
      kind: "position", text, current, checkCurrent: timingValid && !record.retained && error === null, retained: !current, sortValue: text,
      description: `${current ? "Queue position" : "Last reported queue position"}: ${record.position} of ${record.total} hosts. ${current ? "Position 1 is the front of this market's host queue." : `Current position is unconfirmed. ${reason}`}\n\n${source}`,
    };
  }
  if (runningJob && (state === null || state === "OTHER" || state === "RUNNING_JOB") &&
      timingValid && error === null && !record.retained) {
    return { kind: "running", text: "⟶", current: true, checkCurrent: true, retained: false, sortValue: null,
      description: `A current running job has a reported duration limit; see the Duration column on the right.\n\n${duration.description}\n\n${source}` };
  }
  return unknown(`${error !== null ? `Queue read unavailable. ${error}` : !timingValid || record.retained
    ? deliveryUncertain && !record.retained ? "Queue position unknown: the queue evidence may have expired during delivery."
      : "Queue position unknown: the queue reading is unavailable or expired."
    : "This host is not present in the reported market host queue. This does not establish running or stopped state."}\n\n${source}`, timingValid && !record.retained && error === null);
}
