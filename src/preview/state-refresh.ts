import { JOB_REFRESH_INTERVAL_MS } from "../fleet/jobs.ts";
import type { JobRecord } from "../fleet/jobs.ts";
import type { NodeInfoRecord } from "../fleet/node-info.ts";
import { nextStateExpiryDelay } from "../fleet/node-state.ts";

export const STATE_REFRESH_INTERVAL_MS = 20_000;

/** Schedule from read completion, independently of table rendering. */
export function nextStateRefreshDelay(
  records: readonly NodeInfoRecord[], nowMs: number, madeProgress = true, readDurationMs = 0,
): number {
  // Unchanged reads must not make an expiring deadline cause a tight retry loop.
  // The preview server independently enforces provider backoff/cache rules.
  if (!madeProgress) return STATE_REFRESH_INTERVAL_MS;
  // Only current records supply a deadline. One unavailable host must not delay
  // the next read for healthy hosts whose supporting evidence is expiring.
  const expiry = nextStateExpiryDelay(records, nowMs, nowMs);
  const readAllowance = Number.isFinite(readDurationMs)
    ? Math.min(STATE_REFRESH_INTERVAL_MS, Math.max(0, readDurationMs)) : 0;
  return expiry === null ? STATE_REFRESH_INTERVAL_MS
    : Math.max(1_000, Math.min(STATE_REFRESH_INTERVAL_MS, expiry - 5_001 - readAllowance));
}

/** Preserve only historical evidence belonging to the exact failed raw reading. */
export function retainFailedActivity(record: NodeInfoRecord, previous: NodeInfoRecord | undefined): NodeInfoRecord {
  if (record.activity !== undefined || (!record.retained && !record.error) ||
      record.values?.state !== "OTHER" || previous?.values?.state !== "OTHER" ||
      record.fetchedAtMs === null || record.fetchedAtMs !== previous.fetchedAtMs ||
      record.address !== previous.address || !previous.activity?.state) return record;
  // No timestamps are advanced. retained=true prevents this evidence from
  // becoming current even if a malformed response omitted that flag on error.
  return { ...record, retained: true, activity: previous.activity };
}

/** Only original supporting read times count as progress; UI updates do not. */
export function hasNewStateReads(records: readonly NodeInfoRecord[], previous: ReadonlyMap<string, NodeInfoRecord>): boolean {
  return records.some(record => {
    const old = previous.get(record.address);
    const activityTime = record.activity?.checkedAtMs;
    return record.fetchedAtMs !== null && (old?.fetchedAtMs !== record.fetchedAtMs ||
      (activityTime !== undefined && activityTime !== null && old?.activity?.checkedAtMs !== activityTime));
  });
}

/** Follow actual assignment/retry deadlines instead of repeatedly polling a quota pause. */
export function nextJobRefreshAt(records: readonly JobRecord[], nowMs: number): number {
  const deadlines = records.map(record => {
    // A provider retry applies to this host even when retained job evidence exists.
    if (record.retryAtMs !== null && record.retryAtMs > nowMs) return record.retryAtMs;
    if (record.pending) return nowMs + 30_000;
    if (record.error !== null) return nowMs + 60_000;
    if (record.checkedAtMs !== null) {
      const deadline = record.checkedAtMs + (record.job === null ? 60_000 : JOB_REFRESH_INTERVAL_MS);
      if (deadline > nowMs) return deadline;
    }
    // An unchanged overdue snapshot must not create an immediate retry loop.
    return nowMs + JOB_REFRESH_INTERVAL_MS;
  });
  return deadlines.length ? Math.min(...deadlines) : nowMs + JOB_REFRESH_INTERVAL_MS;
}
