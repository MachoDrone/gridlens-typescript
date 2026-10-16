import { DURATION_OVERRUN_GRACE_NOTE, formatDurationSeconds, isDurationOverrun } from "./duration.ts";
import type { DurationView } from "./duration.ts";
import type { NodeApiView } from "./node-api.ts";
import { JOB_DISPLAY_VALIDITY_MS, isJobTimestamp } from "./jobs.ts";
import type { JobRecord } from "./jobs.ts";
import { isMetadataAddress } from "./host-metadata.ts";

const freshnessNote = "The indexer supplies no indexing-freshness timestamp. API check time and the 180-second local display deadline do not establish when the indexer last observed this assignment.";

function timestamp(value: number | null): string {
  return isJobTimestamp(value) ? new Date(value).toISOString() : "unavailable";
}

function unknown(description: string): DurationView {
  return { kind: "unknown", text: "Populating..", description, elapsedSeconds: null, limitSeconds: null,
    percent: null, tone: "unbounded", freshness: "unknown", animated: false };
}

function positiveSeconds(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER;
}

/**
 * Live elapsed time uses the exact verified run start even when its assignment
 * check is retained. Only successful source checks renew freshness. The caller
 * arbitrates supersession; synthetic Duration retains reported-elapsed semantics.
 */
export function projectLiveDuration(
  record: JobRecord | undefined, address: string, nowMs: number,
  connectionError: string | null = null, connectionFailedAtMs: number | null = null,
): DurationView {
  if (!isJobTimestamp(nowMs)) throw new RangeError("Clock must be non-negative integer milliseconds in the Date range");
  if (!record) return unknown(`Duration pending: the job assignment has not been checked. ${freshnessNote}`);
  if (!isMetadataAddress(address) || record.address !== address ||
      record.job && (!isMetadataAddress(record.job.address) || record.job.node !== address)) {
    return unknown(`Duration unknown: job evidence does not match this Host Address. ${freshnessNote}`);
  }
  const times = `API checked at ${timestamp(record.checkedAtMs)}; local display deadline ${timestamp(record.validUntilMs)}.`;
  const pending = record.pending ? ` Assignment lookup pending${record.retryAtMs === null ? "." : `; next attempt no earlier than ${timestamp(record.retryAtMs)}.`}` : "";
  const error = connectionError ?? record.error;
  const failure = isJobTimestamp(connectionFailedAtMs) && connectionError !== null
    ? ` Preview connection failed at ${timestamp(connectionFailedAtMs)}.`
    : isJobTimestamp(record.failedAtMs) ? ` First failed refresh at ${timestamp(record.failedAtMs)}.` : "";
  const context = `${times}${pending}${error ? ` ${error}` : ""}${failure} ${freshnessNote}`;
  const checkValid = isJobTimestamp(record.checkedAtMs) && record.checkedAtMs <= nowMs;
  const deadlineValid = checkValid && isJobTimestamp(record.validUntilMs) && record.validUntilMs > record.checkedAtMs! &&
    record.validUntilMs <= record.checkedAtMs! + JOB_DISPLAY_VALIDITY_MS;
  const validUntilMs = deadlineValid ? record.validUntilMs : null;
  const retained = record.retained || error !== null || !deadlineValid || nowMs >= record.validUntilMs!;
  const absent = (identity = ""): DurationView => {
    const description = `${identity}${retained ? "Last confirmed: no running assignment; current assignment timing is pending" : "No running assignment"}. Original confirmation ${timestamp(record.checkedAtMs)}. ${context}`;
    return retained ? { ...unknown(description), validUntilMs }
      : { ...unknown(description), text: "—", freshness: "current", validUntilMs };
  };
  const job = record.job;
  if (!job) {
    return checkValid ? absent() : unknown(`Duration ${record.pending ? "pending" : "unavailable"}: no useful assignment information yet. ${context}`);
  }
  const identity = `Job ${job.address} on host ${address}`;
  const confirmedEnded = ["QUEUED", "COMPLETED", "STOPPED"].includes(job.state) ||
    positiveSeconds(job.timeEnd) && positiveSeconds(job.timeStart) && job.timeEnd >= job.timeStart &&
    checkValid && job.timeEnd * 1000 <= record.checkedAtMs!;
  if (!record.retained && record.error === null && checkValid && confirmedEnded) return absent(`${identity}: `);
  if (!checkValid || !positiveSeconds(job.timeStart) || !isJobTimestamp(job.timeStart * 1000) ||
      job.timeStart * 1000 > record.checkedAtMs!) {
    return unknown(`${identity}: run start or API check time is missing, invalid or in the future. ${context}`);
  }
  if (job.state !== "RUNNING" || job.timeEnd !== 0) {
    return unknown(`${identity}: running state or end timing is unverified or conflicting. ${context}`);
  }
  const elapsedSeconds = Math.floor((nowMs - job.timeStart * 1000) / 1000);
  const limitSeconds = positiveSeconds(job.timeout) ? job.timeout : null;
  const exceeded = isDurationOverrun(elapsedSeconds, limitSeconds);
  const text = `${formatDurationSeconds(elapsedSeconds)}${limitSeconds === null ? "" : ` / ${formatDurationSeconds(limitSeconds)}`}`;
  return {
    kind: "duration", text, elapsedSeconds, limitSeconds,
    percent: limitSeconds === null ? null : Math.min(100, elapsedSeconds / limitSeconds * 100),
    tone: limitSeconds === null ? "unbounded" : exceeded ? "exceeded" : "current",
    freshness: retained ? "retained" : "current", animated: limitSeconds !== null, validUntilMs,
    description: `${identity}: ${text}. Run start ${timestamp(job.timeStart * 1000)}. Original confirmation ${timestamp(record.checkedAtMs)}. ${retained
      ? `Stale estimate: elapsed time continues from the last verified run start; current activity is unconfirmed (${error ?? (nowMs >= record.validUntilMs! ? "local evidence expired" : "unverified freshness deadline")}).`
      : "Elapsed time from the reported run start; limit from this assigned job's timeout."}${exceeded ? " EXCEEDED: elapsed time is more than 5 minutes beyond the last reported limit." : ""}${limitSeconds === null ? " No valid positive duration limit reported." : ` Last reported limit: ${formatDurationSeconds(limitSeconds)} (${limitSeconds} seconds). ${DURATION_OVERRUN_GRACE_NOTE}`} ${context}`,
  };
}

/** Apply to the source projection after its history and clock checks on each render. */
export function projectDurationAvailability(view: DurationView, api: NodeApiView): DurationView {
  if (view.kind !== "unknown" || view.freshness !== "unknown" || view.text !== "Populating.." ||
      api.status !== "Offline" || !api.current || !isJobTimestamp(api.checkedAtMs)) return view;
  return {
    ...view,
    text: "—",
    unavailableReason: "api-offline",
    description: `Duration unavailable: API Offline; no verified job timing is available. Last confirmed API check: ${new Date(api.checkedAtMs).toISOString()}. API reachability does not establish whether a job is running.\n\nAPI source\n${api.description}\n\nDuration source\n${view.description}`,
  };
}
