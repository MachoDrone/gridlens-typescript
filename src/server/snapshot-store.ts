import { FLEET_RESOURCES, isFleetRoster, isFleetSnapshot } from "../contracts/fleet.ts";
import type { FleetContext, FleetResource, FleetSnapshots } from "../contracts/fleet.ts";
import { NOS_MINT } from "../fleet/nos.ts";
import { blankStakingRecord } from "../fleet/staking.ts";
import { blankJobHistoryRecord, JOB_HISTORY_LIMIT } from "../fleet/job-history.ts";
import type { JobHistoryItem } from "../fleet/job-history.ts";

export interface StoredFleetSnapshot {
  schemaVersion: 1;
  context: FleetContext;
  /** Local storage version for compare-and-swap, never a backend freshness watermark. */
  revision: number;
  snapshots: FleetSnapshots;
  /** Internal fence survives an explicit undated activity failure; never sent as new evidence. */
  activityObservationFences?: Record<string, number>;
}
export type SnapshotUpdates = Partial<FleetSnapshots>;
export interface FleetSnapshotStore {
  read(context: FleetContext): Promise<StoredFleetSnapshot>;
  /** Each supplied resource is a complete, normalized roster snapshot. */
  commit(context: FleetContext, updates: SnapshotUpdates, expectedRevision: number): Promise<StoredFleetSnapshot>;
  subscribe(context: FleetContext, signal: AbortSignal,
    onUpdate: (snapshot: StoredFleetSnapshot, changed: readonly FleetResource[]) => void): Promise<never>;
  close(): Promise<void>;
}
export class SnapshotStoreError extends Error {
  readonly kind: "invalid" | "conflict" | "stale" | "closed";
  constructor(kind: SnapshotStoreError["kind"], message: string) { super(message); this.kind = kind; }
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export function validateFleetContext(value: unknown): asserts value is FleetContext {
  if (!object(value) || ![value.scopeId, value.rosterRevision].every(part =>
    typeof part === "string" && part.length > 0 && part.length <= 256 && !/[\u0000-\u001f\u007f]/.test(part)) ||
    !isFleetRoster(value.addresses)) throw new SnapshotStoreError("invalid", "Invalid Fleet snapshot context.");
}
const keyFor = (context: FleetContext): string => JSON.stringify([context.scopeId, context.rosterRevision]);
const cloneContext = (context: FleetContext): FleetContext => ({ scopeId: context.scopeId,
  rosterRevision: context.rosterRevision, addresses: [...context.addresses] });
function matchingRoster(a: FleetContext, b: FleetContext): boolean {
  return a.addresses.length === b.addresses.length && a.addresses.every((address, index) => address === b.addresses[index]);
}

export function emptyFleetSnapshots(addresses: readonly string[]): FleetSnapshots {
  const evidence = () => ({ provider: null, endpoint: null, contextSlot: null, blockTimeMs: null,
    checkedAtMs: null, validUntilMs: null, retained: false, error: null, retryAtMs: null });
  return {
    metadata: { hosts: addresses.map(address => ({ address, values: null, fetchedAtMs: null, retained: false, error: null, marketError: null })) },
    "node-info": { hosts: addresses.map(address => ({ address, values: null, fetchedAtMs: null, validUntilMs: null, retained: false, error: null })) },
    jobs: { hosts: addresses.map(address => ({ address, job: null, checkedAtMs: null, validUntilMs: null,
      failedAtMs: null, retained: false, pending: false, retryAtMs: null, error: null })), nextRefreshAtMs: null },
    "job-history": { hosts: addresses.map(blankJobHistoryRecord), nextRefreshAtMs: null },
    queue: { hosts: addresses.map(address => ({ address, marketAddress: null, position: null, total: null,
      checkedAtMs: null, validUntilMs: null, sourceUpdatedAtMs: null, retained: false, error: null })), nextRefreshAtMs: null },
    sol: { hosts: addresses.map(address => ({ address, lamports: null, ...evidence() })), nextRefreshAtMs: null },
    nos: { hosts: addresses.map(address => ({ address, tokenAccount: null, mint: NOS_MINT, amount: null,
      decimals: 6, accountState: null, ...evidence() })), nextRefreshAtMs: null },
    staking: { hosts: addresses.map(blankStakingRecord), nextRefreshAtMs: null },
  };
}

function select(value: unknown, fields: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (object(value)) for (const field of fields.split(" ")) if (Object.hasOwn(value, field)) result[field] = value[field];
  return result;
}
const evidenceFields = "provider endpoint contextSlot blockTimeMs checkedAtMs validUntilMs retained error retryAtMs";
const apiResultFields = "status checkedAtMs firstFailedAtMs httpStatus nextCheckAtMs";
const observationFields = new Set(["fetchedAtMs", "checkedAtMs", "blockTimeMs", "failedAtMs", "sourceUpdatedAtMs",
  "marketFetchedAtMs", "marketCheckedAtMs", "lastOnlineAtMs", "firstFailedAtMs"]);
const maximumTime = 8_640_000_000_000_000;
function observationCeiling(now: number): number {
  if (!Number.isSafeInteger(now) || now < 0 || now > maximumTime) throw new SnapshotStoreError("invalid", "Invalid snapshot store clock.");
  return Math.min(maximumTime, now + 15_000);
}
function rejectFutureObservations(value: unknown, ceiling: number): void {
  if (Array.isArray(value)) { for (const child of value) rejectFutureObservations(child, ceiling); return; }
  if (!object(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (observationFields.has(key) && typeof child === "number" && child > ceiling) {
      throw new SnapshotStoreError("invalid", "Snapshot observation exceeds the allowed source clock skew.");
    }
    if (typeof child === "object") rejectFutureObservations(child, ceiling);
  }
}
/** The wire validators are forward compatible. Persistence deliberately keeps only known observations. */
export function normalizeFleetSnapshot<K extends FleetResource>(resource: K, value: unknown,
  addresses: readonly string[], complete = true): FleetSnapshots[K] {
  if (!isFleetSnapshot(resource, value, addresses, complete) || object(value) && value.failed === true) {
    throw new SnapshotStoreError("invalid", `Invalid ${resource} Fleet snapshot.`);
  }
  const hosts = value.hosts.map(value => {
    const row = value as unknown as Record<string, unknown>;
    switch (resource) {
      case "metadata": return { ...select(row, "address fetchedAtMs retained error marketError"), values: row.values === null ? null :
        select(row.values, "status marketAddress marketLabel ram disk cpu cuda nvidia currentNode system country") };
      case "node-info": {
        const result = { ...select(row, "address fetchedAtMs validUntilMs retained error"), values: row.values === null ? null :
          select(row.values, "state dl ul ping networkUnavailableReason") } as Record<string, unknown>;
        if (row.activity !== undefined) result.activity = select(row.activity, "state source checkedAtMs validUntilMs error");
        if (row.apiCheck !== undefined) {
          const api = select(row.apiCheck, `${apiResultFields} confirmationPending lastOnlineAtMs failureKind phase errorCode`);
          if (object(row.apiCheck) && row.apiCheck.lastConfirmed !== undefined) api.lastConfirmed = select(row.apiCheck.lastConfirmed, apiResultFields);
          result.apiCheck = api;
        }
        return result;
      }
      case "jobs": return { ...select(row, "address checkedAtMs validUntilMs failedAtMs retained pending retryAtMs error"),
        job: row.job === null ? null : select(row.job, "address node state timeStart timeEnd timeout") };
      case "job-history": return { ...select(row, "address totalJobs checkedAtMs validUntilMs retained pending retryAtMs error"),
        jobs: (row.jobs as JobHistoryItem[]).map(item => ({
          ...select(item, "address node state timeStart timeEnd timeout result checkedAtMs"),
          marketAddress: item.marketAddress ?? null, usdRewardPerHour: item.usdRewardPerHour ?? null,
          marketName: item.marketName ?? null, marketUsdRewardPerHour: item.marketUsdRewardPerHour ?? null,
          marketCheckedAtMs: item.marketCheckedAtMs ?? null, marketValidUntilMs: item.marketValidUntilMs ?? null,
        })) };
      case "queue": return select(row, "address marketAddress position total checkedAtMs validUntilMs sourceUpdatedAtMs retained error");
      case "sol": return select(row, `address lamports ${evidenceFields}`);
      case "nos": return select(row, `address tokenAccount mint amount decimals accountState ${evidenceFields}`);
      case "staking": return { ...select(row, "address marketAddress marketFetchedAtMs marketRetained marketError"),
        stake: select(row.stake, `${evidenceFields} stakeAccount vaultAccount mint amount recordedAmount xnos durationSeconds unstakeAtSeconds accountState`),
        requirement: select(row.requirement, `${evidenceFields} marketAddress targetAmount xnosMinimum`) };
    }
  });
  const snapshot = { ...select(value, resource === "metadata" ? "" : resource === "jobs"
    ? "nextRefreshAtMs waitReason waitUntilMs" : "nextRefreshAtMs"), hosts };
  return structuredClone(snapshot) as unknown as FleetSnapshots[K];
}

/** Validate restored data in full before making any scope available. */
export function restoreFleetSnapshots(value: unknown, { now = Date.now }: { now?: () => number } = {}): StoredFleetSnapshot[] {
  if (!Array.isArray(value)) throw new SnapshotStoreError("invalid", "Invalid stored Fleet snapshot collection.");
  const ceiling = observationCeiling(now());
  const keys = new Set<string>();
  return value.map(entry => {
    if (!object(entry) || entry.schemaVersion !== 1 || !Number.isSafeInteger(entry.revision) ||
        (entry.revision as number) < 0 || !object(entry.snapshots)) throw new SnapshotStoreError("invalid", "Invalid stored Fleet snapshot envelope.");
    validateFleetContext(entry.context);
    const key = keyFor(entry.context);
    if (keys.has(key)) throw new SnapshotStoreError("invalid", "Duplicate stored Fleet snapshot context.");
    keys.add(key);
    const snapshots = {} as FleetSnapshots;
    for (const resource of FLEET_RESOURCES) {
      // Schema 1 predates optional recent history. Only a truly absent resource
      // restores as unknown; malformed present history must still fail closed.
      const value = resource === "job-history" && !Object.hasOwn(entry.snapshots, resource)
        ? { hosts: entry.context.addresses.map(blankJobHistoryRecord), nextRefreshAtMs: null }
        : entry.snapshots[resource];
      Object.assign(snapshots, { [resource]: normalizeFleetSnapshot(resource, value, entry.context.addresses) });
    }
    rejectFutureObservations(snapshots, ceiling);
    const fences: Record<string, number> = {};
    if (entry.activityObservationFences !== undefined) {
      if (!object(entry.activityObservationFences)) throw new SnapshotStoreError("invalid", "Invalid stored activity observation fences.");
      for (const [address, time] of Object.entries(entry.activityObservationFences)) {
        if (!entry.context.addresses.includes(address) || typeof time !== "number" || !Number.isSafeInteger(time) || time < 0 || time > ceiling) {
          throw new SnapshotStoreError("invalid", "Invalid stored activity observation fence.");
        }
        fences[address] = time;
      }
    }
    for (const row of snapshots["node-info"].hosts) if (typeof row.activity?.checkedAtMs === "number") {
      if (fences[row.address] !== undefined && fences[row.address]! > row.activity.checkedAtMs) {
        throw new SnapshotStoreError("invalid", "Stored activity evidence is older than its observation fence.");
      }
      fences[row.address] = row.activity.checkedAtMs;
    }
    return { schemaVersion: 1, context: cloneContext(entry.context), revision: entry.revision as number, snapshots,
      ...(Object.keys(fences).length ? { activityObservationFences: fences } : {}) };
  });
}

function compareClock(previous: Record<string, unknown>, next: Record<string, unknown>, field: string): void {
  if (typeof previous[field] === "number" && (next[field] === null || next[field] === undefined ||
    typeof next[field] === "number" && next[field] < previous[field])) {
    throw new SnapshotStoreError("stale", "Snapshot update would regress or discard established source evidence.");
  }
}
function compareEvidence(previous: unknown, next: unknown, checked: string, fields: string): void {
  if (!object(previous) || !object(next)) return;
  compareClock(previous, next, checked);
  if (typeof previous[checked] === "number" && previous[checked] === next[checked]) {
    if (JSON.stringify(select(previous, fields)) !== JSON.stringify(select(next, fields))) {
      throw new SnapshotStoreError("stale", "Changed measurements require a new source observation.");
    }
    if (typeof previous.validUntilMs === "number" && typeof next.validUntilMs === "number" && next.validUntilMs > previous.validUntilMs) {
      throw new SnapshotStoreError("stale", "Redisplaying an observation cannot extend its original deadline.");
    }
    if ((previous.retained === true || typeof previous.error === "string") && next.retained !== true && next.error === null) {
      throw new SnapshotStoreError("stale", "A cached success cannot clear failure without a new source observation.");
    }
    if (typeof previous.failedAtMs === "number" && next.failedAtMs !== previous.failedAtMs) {
      throw new SnapshotStoreError("stale", "The first failure time remains fixed until a new source observation.");
    }
  }
  if (previous.contextSlot !== undefined) compareClock(previous, next, "contextSlot");
}
function failedActivity(value: unknown): boolean {
  return object(value) && value.state === null && value.checkedAtMs === null && value.validUntilMs === null &&
    typeof value.error === "string" && value.error.length > 0;
}
function activityFences(previous: StoredFleetSnapshot, updates: SnapshotUpdates): Record<string, number> {
  const fences = { ...previous.activityObservationFences };
  const old = new Map(previous.snapshots["node-info"].hosts.map(row => [row.address, row.activity]));
  for (const row of updates["node-info"]?.hosts ?? []) {
    const checked = row.activity?.checkedAtMs;
    const fence = fences[row.address];
    if (typeof checked !== "number") continue;
    if (fence !== undefined && (checked < fence || checked === fence && typeof old.get(row.address)?.checkedAtMs !== "number")) {
      throw new SnapshotStoreError("stale", "Invalidated activity evidence requires a newer source confirmation.");
    }
    fences[row.address] = checked;
  }
  return fences;
}
function compareHistory(previous: Record<string, unknown>, next: Record<string, unknown>): void {
  // Current-job observations may enrich a page without performing another page
  // read. Its original coverage count and cache deadline must remain unchanged.
  compareEvidence(previous, next, "checkedAtMs", "totalJobs");
  const oldJobs = previous.jobs as JobHistoryItem[];
  const newJobs = next.jobs as JobHistoryItem[];
  const old = new Map(oldJobs.map(item => [item.address, item]));
  for (const item of newJobs) {
    const prior = old.get(item.address);
    compareEvidence(prior, item, "checkedAtMs", "address node state timeStart timeEnd timeout result marketAddress usdRewardPerHour");
    if (prior && prior.marketAddress === item.marketAddress) {
      // Optional display metadata may arrive after its job, on an independent
      // clock. A new name/rate must not renew job or page timing evidence.
      const market = (job: JobHistoryItem) => ({ checkedAtMs: job.marketCheckedAtMs ?? null,
        validUntilMs: job.marketValidUntilMs ?? null, name: job.marketName ?? null,
        rate: job.marketUsdRewardPerHour ?? null });
      compareEvidence(market(prior), market(item), "checkedAtMs", "name rate");
    }
  }
  const freshPage = typeof next.checkedAtMs === "number" &&
    (previous.checkedAtMs === null || next.checkedAtMs > (previous.checkedAtMs as number));
  const newestFirst = (a: JobHistoryItem, b: JobHistoryItem): number =>
    (b.timeStart ?? 0) - (a.timeStart ?? 0) || a.address.localeCompare(b.address);
  const tail = [...newJobs].sort(newestFirst).at(-1);
  const newIds = new Set(newJobs.map(item => item.address));
  for (const item of oldJobs) if (!newIds.has(item.address)) {
    if (freshPage && (next.checkedAtMs as number) >= item.checkedAtMs) continue;
    // An observed-only update may evict the oldest member of a full ten-item
    // list. A page that predates an individual observation cannot discard it.
    if (newJobs.length !== JOB_HISTORY_LIMIT || !tail || newestFirst(item, tail) < 0) {
      throw new SnapshotStoreError("stale", "Removing job history requires a new page check or bounded recent-history eviction.");
    }
  }
}
function rejectRegressions(resource: FleetResource, previous: FleetSnapshots[FleetResource], next: FleetSnapshots[FleetResource]): void {
  const old = new Map(previous.hosts.map(row => [row.address, row as unknown as Record<string, unknown>]));
  for (const value of next.hosts) {
    const row = value as unknown as Record<string, unknown>;
    const prior = old.get(value.address)!;
    switch (resource) {
      case "metadata": {
        // Optional labels can arrive after the same validated metrics observation.
        const core = "status marketAddress ram disk cpu cuda nvidia currentNode system country";
        const measurements = (values: unknown) => values === null ? null : {
          ...select(values, core), country: object(values) ? values.country ?? null : null,
        };
        compareEvidence({ ...prior, values: measurements(prior.values) },
          { ...row, values: measurements(row.values) }, "fetchedAtMs", "values");
        break;
      }
      case "node-info":
        compareEvidence(prior, row, "fetchedAtMs", "values");
        compareEvidence(prior.apiCheck, row.apiCheck, "checkedAtMs", "status");
        // A failed reconciliation invalidates membership without inventing a
        // check timestamp. Keep its previous positive proof only in the store's
        // replay fence, not in the current Node activity reading.
        if (!failedActivity(row.activity)) compareEvidence(prior.activity, row.activity, "checkedAtMs", "state source");
        break;
      case "jobs": compareEvidence(prior, row, "checkedAtMs", "job"); break;
      case "job-history": compareHistory(prior, row); break;
      case "queue":
        if (prior.marketAddress === row.marketAddress) compareEvidence(prior, row, "checkedAtMs", "marketAddress position total sourceUpdatedAtMs");
        else if (typeof row.checkedAtMs === "number") compareClock(prior, row, "checkedAtMs");
        break;
      case "sol": compareEvidence(prior, row, "checkedAtMs", "lamports provider endpoint contextSlot blockTimeMs"); break;
      case "nos": compareEvidence(prior, row, "checkedAtMs", "tokenAccount mint amount decimals accountState provider endpoint contextSlot blockTimeMs"); break;
      case "staking":
        compareEvidence(prior.stake, row.stake, "checkedAtMs", "stakeAccount vaultAccount mint amount recordedAmount xnos durationSeconds unstakeAtSeconds accountState provider endpoint contextSlot blockTimeMs");
        compareClock(prior, row, "marketFetchedAtMs");
        if (object(prior.requirement) && object(row.requirement) && prior.requirement.marketAddress === row.requirement.marketAddress) {
          compareEvidence(prior.requirement, row.requirement, "checkedAtMs", "marketAddress targetAmount xnosMinimum provider endpoint contextSlot blockTimeMs");
        }
        break;
    }
  }
}

export function createMemorySnapshotStore({ initial = [], persist, now = Date.now }: {
  initial?: unknown;
  now?: () => number;
  /** Optional durability hook completes before the new revision becomes observable. */
  persist?: (snapshots: readonly StoredFleetSnapshot[]) => Promise<void>;
} = {}): FleetSnapshotStore {
  const records = new Map(restoreFleetSnapshots(initial, { now }).map(snapshot => [keyFor(snapshot.context), snapshot]));
  const subscribers = new Map<string, Set<{ update: (value: StoredFleetSnapshot, changed: readonly FleetResource[]) => void; close: () => void }>>();
  let closed = false;
  let persistenceFailed = false;
  let tail: Promise<unknown> = Promise.resolve();
  let shutdown: Promise<void> | undefined;
  const available = (): void => {
    if (closed || persistenceFailed) throw new SnapshotStoreError("closed", "Fleet snapshot store is closed or requires reopening after a persistence failure.");
  };
  const stopSubscriptions = (): void => {
    for (const set of [...subscribers.values()]) for (const listener of [...set]) listener.close();
  };
  const current = (context: FleetContext): StoredFleetSnapshot => {
    validateFleetContext(context);
    const stored = records.get(keyFor(context));
    if (stored && !matchingRoster(context, stored.context)) throw new SnapshotStoreError("conflict", "Roster membership changed without a new roster revision.");
    if (stored) return stored;
    const empty: StoredFleetSnapshot = { schemaVersion: 1, context: cloneContext(context), revision: 0,
      snapshots: emptyFleetSnapshots(context.addresses) };
    records.set(keyFor(context), empty);
    return empty;
  };
  return {
    async read(context) { available(); return structuredClone(current(context)); },
    async commit(context, updates, expectedRevision) {
      available(); validateFleetContext(context);
      const ownedContext = cloneContext(context);
      if (!object(updates) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
          !Object.keys(updates).length || Object.keys(updates).some(key => !(FLEET_RESOURCES as readonly string[]).includes(key))) {
        throw new SnapshotStoreError("invalid", "Invalid Fleet snapshot commit.");
      }
      // Normalize before awaiting a queued writer so caller mutation cannot alter a commit.
      const ownedUpdates: SnapshotUpdates = {};
      for (const resource of FLEET_RESOURCES) if (Object.hasOwn(updates, resource)) {
        Object.assign(ownedUpdates, { [resource]: normalizeFleetSnapshot(resource, updates[resource], ownedContext.addresses) });
      }
      const changed = FLEET_RESOURCES.filter(resource => Object.hasOwn(ownedUpdates, resource));
      const operation = tail.then(async () => {
        // A previous failed flush might already have replaced durable storage.
        // Never reuse the old in-memory CAS revision after that uncertainty.
        if (persistenceFailed) available();
        const previous = current(ownedContext);
        if (previous.revision !== expectedRevision) throw new SnapshotStoreError("conflict", "Fleet snapshot revision was superseded.");
        if (expectedRevision === Number.MAX_SAFE_INTEGER) throw new SnapshotStoreError("conflict", "Fleet snapshot revision is exhausted.");
        rejectFutureObservations(ownedUpdates, observationCeiling(now()));
        for (const resource of changed) rejectRegressions(resource, previous.snapshots[resource], ownedUpdates[resource]!);
        const fences = activityFences(previous, ownedUpdates);
        const next: StoredFleetSnapshot = { schemaVersion: 1, context: ownedContext, revision: expectedRevision + 1,
          snapshots: { ...previous.snapshots, ...ownedUpdates }, ...(Object.keys(fences).length ? { activityObservationFences: fences } : {}) };
        const nextRecords = new Map(records); nextRecords.set(keyFor(ownedContext), next);
        try { await persist?.(structuredClone([...nextRecords.values()])); }
        catch (error) {
          persistenceFailed = true;
          stopSubscriptions();
          throw error;
        }
        records.set(keyFor(ownedContext), next);
        for (const subscriber of [...(subscribers.get(keyFor(ownedContext)) ?? [])]) subscriber.update(next, changed);
        return structuredClone(next);
      });
      tail = operation.catch(() => {});
      return operation;
    },
    subscribe(context, signal, onUpdate) {
      try { available(); signal.throwIfAborted(); current(context); } catch (error) { return Promise.reject(error); }
      const ownedContext = cloneContext(context);
      const key = keyFor(ownedContext);
      return new Promise<never>((_resolve, reject) => {
        const remove = (): void => {
          signal.removeEventListener("abort", abort);
          const set = subscribers.get(key); set?.delete(listener); if (!set?.size) subscribers.delete(key);
        };
        const abort = (): void => { remove(); reject(signal.reason); };
        const listener = {
          update(value: StoredFleetSnapshot, changed: readonly FleetResource[]) {
            if (signal.aborted) return;
            try { onUpdate(structuredClone(value), [...changed]); } catch { /* A viewer cannot invalidate committed evidence. */ }
          },
          close() { remove(); reject(new SnapshotStoreError("closed", "Fleet snapshot store is closed.")); },
        };
        let set = subscribers.get(key); if (!set) { set = new Set(); subscribers.set(key, set); }
        set.add(listener); signal.addEventListener("abort", abort, { once: true });
        listener.update(current(ownedContext), FLEET_RESOURCES);
      });
    },
    close() {
      if (!shutdown) {
        closed = true;
        shutdown = tail.then(stopSubscriptions);
      }
      return shutdown;
    },
  };
}
