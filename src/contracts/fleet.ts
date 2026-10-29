import { isMetadataAddress } from "../fleet/host-metadata.ts";
import type { HostMetadataRecord, HostMetadataSnapshot } from "../fleet/host-metadata.ts";
import { NODE_API_ERROR_CODES } from "../fleet/node-info.ts";
import type { NodeInfoRecord, NodeInfoSnapshot } from "../fleet/node-info.ts";
import { isJobRecord, isJobTimestamp } from "../fleet/jobs.ts";
import type { JobSnapshot } from "../fleet/jobs.ts";
import { isJobHistoryRecord } from "../fleet/job-history.ts";
import type { JobHistorySnapshot } from "../fleet/job-history.ts";
import { isQueueRecord } from "../fleet/queue.ts";
import type { QueueSnapshot } from "../fleet/queue.ts";
import { isSolRecord } from "../fleet/sol.ts";
import type { SolSnapshot } from "../fleet/sol.ts";
import { isNosRecord } from "../fleet/nos.ts";
import type { NosSnapshot } from "../fleet/nos.ts";
import { isStakingRecord } from "../fleet/staking.ts";
import type { StakingSnapshot } from "../fleet/staking.ts";

/** The same observation contracts serve the local adapters and a hosted source. */
export interface FleetSnapshots {
  metadata: HostMetadataSnapshot;
  "node-info": NodeInfoSnapshot;
  jobs: JobSnapshot;
  "job-history": JobHistorySnapshot;
  queue: QueueSnapshot;
  sol: SolSnapshot;
  nos: NosSnapshot;
  staking: StakingSnapshot;
}
export type FleetResource = keyof FleetSnapshots;
export const FLEET_RESOURCES = ["metadata", "node-info", "jobs", "job-history", "queue", "sol", "nos", "staking"] as const satisfies readonly FleetResource[];
export interface FleetContext {
  scopeId: string;
  rosterRevision: string;
  addresses: readonly string[];
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const text = (value: unknown, maximum = 1024): boolean => value === null || typeof value === "string" && value.length <= maximum;
const time = (value: unknown): boolean => value === null || isJobTimestamp(value);
const number = (value: unknown): boolean => value === null || typeof value === "number" && Number.isFinite(value) && value >= 0;
function deadline(checked: unknown, until: unknown, maximum: number): boolean {
  return time(checked) && time(until) && (until === null || checked !== null &&
    (until as number) > (checked as number) && (until as number) <= (checked as number) + maximum);
}

/** Roster identities are exact public keys; the order is presentation input. */
export function isFleetRoster(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isMetadataAddress) && new Set(value).size === value.length;
}

export function isHostMetadataRecord(value: unknown): value is HostMetadataRecord {
  if (!object(value) || !isMetadataAddress(value.address) || typeof value.retained !== "boolean" ||
      !text(value.error) || !text(value.marketError) || !time(value.fetchedAtMs)) return false;
  if (value.values === null) return true;
  const fields = value.values;
  return object(fields) && (fields.marketAddress === null || isMetadataAddress(fields.marketAddress)) &&
    ["status", "marketLabel", "cpu", "cuda", "nvidia", "currentNode", "system"].every(key => text(fields[key])) &&
    (fields.country === undefined || text(fields.country, 256) &&
      (typeof fields.country !== "string" || fields.country.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(fields.country))) &&
    [fields.ram, fields.disk].every(number);
}

function apiResult(value: unknown, history = false): boolean {
  if (!object(value) || !(history ? ["online", "offline"] : ["online", "offline", "other"]).includes(value.status as string)
      || !isJobTimestamp(value.checkedAtMs)) return false;
  for (const key of ["firstFailedAtMs", "nextCheckAtMs", ...(history ? [] : ["lastOnlineAtMs"])]) {
    if (value[key] !== undefined && !isJobTimestamp(value[key])) return false;
  }
  if (value.httpStatus !== undefined && (typeof value.httpStatus !== "number" ||
      !Number.isInteger(value.httpStatus) || value.httpStatus < 100 || value.httpStatus > 599)) return false;
  if (history) return value.lastConfirmed === undefined;
  if (value.confirmationPending !== undefined && typeof value.confirmationPending !== "boolean" ||
      value.confirmationPending === true && value.status !== "other") return false;
  if (value.failureKind !== undefined && !["timeout", "network", "redirect", "http", "invalid-response"].includes(value.failureKind as string)) return false;
  if (value.phase !== undefined && !["request", "headers", "body", "validation"].includes(value.phase as string)) return false;
  if (value.errorCode !== undefined && !(NODE_API_ERROR_CODES as readonly unknown[]).includes(value.errorCode)) return false;
  return value.lastConfirmed === undefined || apiResult(value.lastConfirmed, true);
}

export function isNodeInfoRecord(value: unknown): value is NodeInfoRecord {
  if (!object(value) || !isMetadataAddress(value.address) || typeof value.retained !== "boolean" ||
      !text(value.error) || !deadline(value.fetchedAtMs, value.validUntilMs, 30_000)) return false;
  if (value.apiCheck !== undefined && !apiResult(value.apiCheck)) return false;
  if (value.activity !== undefined) {
    const activity = value.activity;
    if (!object(activity) || activity.source !== "nosana-indexer" ||
        ![null, "RUNNING_JOB", "QUEUED"].includes(activity.state as string | null) || !text(activity.error) ||
        // Membership providers may declare a longer bound. The existing State
        // projection independently caps each supporting proof at its own 30s.
        !deadline(activity.checkedAtMs, activity.validUntilMs, Infinity)) return false;
  }
  if (value.values === null) return true;
  return object(value.values) && text(value.values.state, 64) && text(value.values.networkUnavailableReason) &&
    [value.values.dl, value.values.ul, value.values.ping].every(number);
}

const validators = {
  metadata: isHostMetadataRecord,
  "node-info": isNodeInfoRecord,
  jobs: (value: unknown) => isJobRecord(value) && deadline(value.checkedAtMs, value.validUntilMs, 180_000),
  "job-history": isJobHistoryRecord,
  queue: (value: unknown) => isQueueRecord(value) && deadline(value.checkedAtMs, value.validUntilMs, 30_000),
  sol: isSolRecord,
  nos: isNosRecord,
  staking: isStakingRecord,
} satisfies Record<FleetResource, (value: unknown) => boolean>;

/** Expired observations remain valid snapshots: projection owns freshness. */
export function isFleetSnapshot<R extends FleetResource>(resource: R, value: unknown,
  addresses: readonly string[], complete = true): value is FleetSnapshots[R] {
  return isFleetRoster(addresses) && matchesRoster(resource, value, new Set(addresses), complete);
}

/** Validate and capture a stream's fixed roster once, independent of caller mutation. */
export function createFleetSnapshotValidator(addresses: readonly string[]) {
  if (!isFleetRoster(addresses)) throw new Error("Fleet roster identities are invalid.");
  const allowed = new Set(addresses);
  return <R extends FleetResource>(resource: R, value: unknown, complete = true): value is FleetSnapshots[R] =>
    matchesRoster(resource, value, allowed, complete);
}

function matchesRoster<R extends FleetResource>(resource: R, value: unknown,
  allowed: ReadonlySet<string>, complete: boolean): value is FleetSnapshots[R] {
  if (!object(value) || !Array.isArray(value.hosts) || !value.hosts.every(validators[resource]) ||
      value.hosts.length > allowed.size || complete && value.hosts.length !== allowed.size) return false;
  const identities = value.hosts.map((row: { address: string }) => row.address);
  if (new Set(identities).size !== identities.length || !identities.every(address => allowed.has(address))) return false;
  if (["sol", "nos", "staking"].includes(resource) && !("nextRefreshAtMs" in value)) return false;
  for (const field of ["nextRefreshAtMs", "waitUntilMs"]) {
    if (value[field] !== undefined && !time(value[field])) return false;
  }
  for (const field of ["complete", "watching", "failed"]) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") return false;
  }
  if (value.waitReason !== undefined && value.waitReason !== null &&
      !["retry-after", "local-budget", "discovery-budget"].includes(value.waitReason as string)) return false;
  if (resource === "jobs") {
    const jobs = (value as unknown as JobSnapshot).hosts.flatMap(row => row.job ? [row.job.address] : []);
    if (new Set(jobs).size !== jobs.length) return false;
  }
  if (resource === "job-history") {
    const jobs = (value as unknown as JobHistorySnapshot).hosts.flatMap(row => row.jobs.map(job => job.address));
    if (new Set(jobs).size !== jobs.length) return false;
  }
  return true;
}
