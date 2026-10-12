import { isMetadataAddress } from "./host-metadata.ts";

export const JOB_REFRESH_INTERVAL_MS = 120_000;
export const JOB_DISPLAY_VALIDITY_MS = 180_000;
export const JOB_STATES = ["QUEUED", "RUNNING", "COMPLETED", "STOPPED"] as const;

/** Selected indexer fields only. All three timing values use seconds. */
export interface JobTiming {
  address: string;
  node: string;
  state: string;
  timeStart: number | null;
  timeEnd: number | null;
  timeout: number | null;
}

export interface JobRecord {
  address: string;
  job: JobTiming | null;
  /** Successful API check time, not an indexing-freshness timestamp. */
  checkedAtMs: number | null;
  /** Local display deadline; successful reads alone renew it. */
  validUntilMs: number | null;
  /** First failure since the last success; retained estimates keep its source age. */
  failedAtMs: number | null;
  retained: boolean;
  pending: boolean;
  retryAtMs: number | null;
  error: string | null;
}

export interface JobSnapshot {
  hosts: JobRecord[];
  /** Earliest shared upstream eligibility; omitted by older injected providers. */
  nextRefreshAtMs?: number | null;
  /** A shared dispatch restriction, distinct from routine refresh or per-host backoff. */
  waitReason?: "retry-after" | "local-budget" | "discovery-budget" | null;
  waitUntilMs?: number | null;
}

export function isJobTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate the preview's narrow wire contract before browser identity binding. */
export function isJobRecord(value: unknown): value is JobRecord {
  if (!object(value) || !isMetadataAddress(value.address) ||
      typeof value.retained !== "boolean" || typeof value.pending !== "boolean" ||
      !(value.error === null || typeof value.error === "string" && value.error.length <= 1024)) return false;
  for (const field of ["checkedAtMs", "validUntilMs", "failedAtMs", "retryAtMs"]) {
    if (value[field] !== null && !isJobTimestamp(value[field])) return false;
  }
  if (value.job === null) return true;
  const job = value.job;
  if (!object(job) || !isMetadataAddress(job.address) || job.node !== value.address ||
      typeof job.state !== "string" || !(JOB_STATES as readonly string[]).includes(job.state)) return false;
  return [job.timeStart, job.timeEnd, job.timeout].every(seconds => seconds === null ||
    typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 && seconds <= Number.MAX_SAFE_INTEGER);
}
