import { isMetadataAddress } from "./host-metadata.ts";
import { JOB_STATES, isJobTimestamp } from "./jobs.ts";
import type { JobTiming } from "./jobs.ts";

export const JOB_HISTORY_LIMIT = 10;
export const JOB_HISTORY_CACHE_MS = 300_000;
export const JOB_HISTORY_MARKET_CACHE_MS = 300_000;
/** Bound explicit host selections in one browser/server history request. */
export const JOB_HISTORY_REQUEST_LIMIT = 100;

/** A bounded, allowlisted observation; lifecycle and execution result are independent. */
export interface JobHistoryItem extends JobTiming {
  result: "success" | "failed" | null;
  checkedAtMs: number;
  /** The job's own market, never the host's present assignment. Older snapshots omit these fields. */
  marketAddress?: string | null;
  /** Indexed historical base USD/hour, before Explorer's customer-fee calculation. */
  usdRewardPerHour?: number | null;
  /** Independently checked Host Manager market metadata; not a physical GPU identity. */
  marketName?: string | null;
  marketUsdRewardPerHour?: number | null;
  marketCheckedAtMs?: number | null;
  marketValidUntilMs?: number | null;
}

export interface JobHistoryRecord {
  address: string;
  jobs: JobHistoryItem[];
  /** The indexer's total at the last page check, not a complete-history guarantee. */
  totalJobs: number | null;
  /** Page check time is independent of individual current-job observations. */
  checkedAtMs: number | null;
  validUntilMs: number | null;
  retained: boolean;
  pending: boolean;
  retryAtMs: number | null;
  error: string | null;
}

export interface JobHistorySnapshot {
  hosts: JobHistoryRecord[];
  nextRefreshAtMs?: number | null;
}

export function blankJobHistoryRecord(address: string): JobHistoryRecord {
  return { address, jobs: [], totalJobs: null, checkedAtMs: null, validUntilMs: null,
    retained: false, pending: false, retryAtMs: null, error: null };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function seconds(value: unknown): value is number | null {
  return value === null || typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function jobHistoryUsdRate(value: unknown): number | null {
  // Zero can be a source default; it has not been verified as a free job/rate.
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
}
export function jobHistoryMarketName(value: unknown): string | null {
  return typeof value === "string" && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)
    ? value.trim() || null : null;
}
function marketDetailsAreValid(item: Record<string, unknown>): boolean {
  const address = item.marketAddress ?? null;
  const name = item.marketName ?? null;
  const rate = item.marketUsdRewardPerHour ?? null;
  const checked = item.marketCheckedAtMs ?? null;
  const validUntil = item.marketValidUntilMs ?? null;
  if (address !== null && !isMetadataAddress(address) ||
      name !== null && jobHistoryMarketName(name) !== name ||
      [item.usdRewardPerHour ?? null, rate].some(value => value !== null && jobHistoryUsdRate(value) !== value)) return false;
  if (checked === null) return validUntil === null && name === null && rate === null;
  return address !== null && isJobTimestamp(checked) && isJobTimestamp(validUntil) &&
    validUntil > checked && validUntil <= checked + JOB_HISTORY_MARKET_CACHE_MS;
}
function timingIsValid(item: Record<string, unknown>, checkedAtMs: number): boolean {
  if (![item.timeStart, item.timeEnd, item.timeout].every(seconds)) return false;
  const start = item.timeStart as number | null;
  const end = item.timeEnd as number | null;
  const ceiling = Math.min(8_640_000_000_000_000, checkedAtMs + 15_000);
  if ([start, end].some(time => time !== null && (!isJobTimestamp(time * 1000) || time * 1000 > ceiling))) return false;
  return !(start !== null && start > 0 && end !== null && end > 0 && end < start);
}

/** Source payloads may use numeric lifecycle enums. Raw workload data never crosses this boundary. */
export function normalizeJobHistoryItem(value: unknown, checkedAtMs: number): JobHistoryItem {
  if (!object(value) || !isMetadataAddress(value.address) || !isMetadataAddress(value.node) || !isJobTimestamp(checkedAtMs)) {
    throw new Error("Job history contained invalid identity or observation time.");
  }
  const state = typeof value.state === "number" ? JOB_STATES[value.state] : value.state;
  const item = { address: value.address, node: value.node, state,
    timeStart: value.timeStart ?? null, timeEnd: value.timeEnd ?? null, timeout: value.timeout ?? null };
  if (typeof state !== "string" || !(JOB_STATES as readonly string[]).includes(state) || !timingIsValid(item, checkedAtMs)) {
    throw new Error("Job history contained invalid lifecycle or timing.");
  }
  return { address: item.address, node: item.node, state,
    timeStart: item.timeStart as number | null, timeEnd: item.timeEnd as number | null,
    timeout: item.timeout as number | null,
    result: value.jobStatus === "success" || value.jobStatus === "failed" ? value.jobStatus : null,
    marketAddress: isMetadataAddress(value.market) ? value.market : null,
    usdRewardPerHour: jobHistoryUsdRate(value.usdRewardPerHour),
    marketName: null, marketUsdRewardPerHour: null, marketCheckedAtMs: null, marketValidUntilMs: null,
    checkedAtMs };
}

/** Validate complete normalized records without refreshing observations or inferring success. */
export function isJobHistoryRecord(value: unknown): value is JobHistoryRecord {
  if (!object(value) || !isMetadataAddress(value.address) || !Array.isArray(value.jobs) || value.jobs.length > JOB_HISTORY_LIMIT ||
      typeof value.retained !== "boolean" || typeof value.pending !== "boolean" ||
      !(value.error === null || typeof value.error === "string" && value.error.length <= 1024)) return false;
  for (const field of ["checkedAtMs", "validUntilMs", "retryAtMs"]) {
    if (value[field] !== null && !isJobTimestamp(value[field])) return false;
  }
  if (value.totalJobs !== null && !(typeof value.totalJobs === "number" && Number.isSafeInteger(value.totalJobs) && value.totalJobs >= 0)) return false;
  if (value.checkedAtMs === null) {
    if (value.totalJobs !== null || value.validUntilMs !== null) return false;
  } else if (value.totalJobs === null || value.validUntilMs !== null &&
      ((value.validUntilMs as number) <= (value.checkedAtMs as number) ||
        (value.validUntilMs as number) > (value.checkedAtMs as number) + JOB_HISTORY_CACHE_MS)) return false;
  const identities = new Set<string>();
  for (const item of value.jobs) {
    if (!object(item) || !isMetadataAddress(item.address) || item.node !== value.address || identities.has(item.address) ||
        typeof item.state !== "string" || !(JOB_STATES as readonly string[]).includes(item.state) ||
        ![null, "success", "failed"].includes(item.result as string | null) || !isJobTimestamp(item.checkedAtMs) ||
        !timingIsValid(item, item.checkedAtMs) || !marketDetailsAreValid(item)) return false;
    identities.add(item.address);
  }
  return true;
}
