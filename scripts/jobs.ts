import { createSharedOperation, createRequestLimiter, throwIfAborted } from "./shared-read.ts";
import type { SharedOperation } from "./shared-read.ts";
import { isMetadataAddress } from "../src/fleet/host-metadata.ts";
import { JOB_DISPLAY_VALIDITY_MS, JOB_REFRESH_INTERVAL_MS, isJobTimestamp } from "../src/fleet/jobs.ts";
import type { JobRecord, JobSnapshot, JobTiming } from "../src/fleet/jobs.ts";
import type { NodeInfoSnapshot } from "../src/fleet/node-info.ts";

const origin = "https://blockchain-indexer.k8s.prd.nos.ci";
const failureBackoffMs = 60_000;
const maximumBackoffMs = 15 * 60_000;
const workWindowMs = 60_000;
const responseByteLimit = 2 * 1024 * 1024;
const states = ["QUEUED", "RUNNING", "COMPLETED", "STOPPED"] as const;
const budgets = [{ count: 16, window: 30_000 }, { count: 400, window: 3_600_000 },
  { count: 2_400, window: 86_400_000 }] as const;
// Discovery has its own fixed ceilings inside the total budget. Undiscovered
// hosts never reserve speculative maintenance or reduce this allowance to zero.
const discoveryBudgets = [{ count: 14, window: 30_000 }, { count: 336, window: 3_600_000 },
  { count: 900, window: 86_400_000 }] as const;
type RequestKind = "discovery" | "rediscovery" | "maintenance";

interface WorkWindow { readonly deadline: number }

export type JobProvider = ((addresses: readonly string[], signal?: AbortSignal,
  onUpdate?: (snapshot: JobSnapshot) => void) => Promise<JobSnapshot>) & {
  /** State only invalidates assignment lookup; it never supplies job timing. */
  observeStates?: (snapshot: NodeInfoSnapshot) => void;
};

interface HostCache {
  record: JobRecord;
  nextAttemptAt: number;
  maintenanceAttemptAt: number;
  lastLookupAt: number;
  forceDiscovery: boolean;
  revision: number;
  emptyLookups: number;
  failures: number;
  maintenanceFailures: number;
  order: number;
}

class RequestError extends Error {}
class DeferredRequest extends RequestError {
  retryAtMs: number;
  constructor(message: string, retryAtMs: number) {
    super(message);
    this.retryAtMs = retryAtMs;
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function seconds(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Retain only identity and timing; indexer definitions/results are discarded. */
function timing(payload: unknown): JobTiming {
  if (!object(payload) || !isMetadataAddress(payload.address) || !isMetadataAddress(payload.node)) {
    throw new RequestError("Nosana jobs response contained an invalid job or Host Address.");
  }
  const state = typeof payload.state === "number" ? states[payload.state] : payload.state;
  if (typeof state !== "string" || !(states as readonly string[]).includes(state)) {
    throw new RequestError("Nosana jobs response contained an unrecognized assignment state.");
  }
  return { address: payload.address, node: payload.node, state,
    timeStart: seconds(payload.timeStart), timeEnd: seconds(payload.timeEnd), timeout: seconds(payload.timeout) };
}

function assignment(address: string, payload: unknown): JobTiming | null {
  if (!object(payload) || !Array.isArray(payload.jobs) ||
      typeof payload.totalJobs !== "number" || !Number.isSafeInteger(payload.totalJobs) ||
      payload.totalJobs < 0 || payload.jobs.length !== Math.min(2, payload.totalJobs)) {
    throw new RequestError("Nosana assignment response did not contain a consistent jobs/totalJobs result.");
  }
  if (payload.totalJobs > 1) throw new RequestError("Nosana reported ambiguous running assignments for this Host Address.");
  if (payload.totalJobs === 0) return null;
  const job = timing(payload.jobs[0]);
  if (job.node !== address || job.state !== "RUNNING" || job.timeEnd !== 0) {
    throw new RequestError("Nosana assignment did not match the requested Host Address and running state.");
  }
  return job;
}

function blank(address: string): JobRecord {
  return { address, job: null, checkedAtMs: null, validUntilMs: null, failedAtMs: null,
    retained: false, pending: false, retryAtMs: null, error: null };
}

/** Anonymous on-demand reads. All caches, dispatch budgets and pauses are shared in memory. */
export function createJobProvider({ fetch: fetcher = globalThis.fetch, now = Date.now, timeoutMs = 8_000,
  elapsedNow = () => performance.now(), activityPriority = () => 2 }: {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  timeoutMs?: number;
  /** Monotonic elapsed time bounds finite reads independently of evidence time. */
  elapsedNow?: () => number;
  /** Priority from validated backend activity; never from rendered State. */
  activityPriority?: (address: string, time: number) => number;
} = {}): JobProvider {
  const hosts = new Map<string, HostCache>();
  const pending = new Map<string, SharedOperation<void>>();
  const observers = new Map<string, Set<() => void>>();
  const reportedStates = new Map<string, string>();
  const dispatches: number[] = [];
  const discoveryDispatches: number[] = [];
  const limited = createRequestLimiter(2);
  let pauseUntil = 0;

  function cache(address: string): HostCache {
    let value = hosts.get(address);
    if (!value) {
      value = { record: blank(address), nextAttemptAt: 0, maintenanceAttemptAt: 0, lastLookupAt: -Infinity,
        forceDiscovery: false, revision: 0, emptyLookups: 0, failures: 0, maintenanceFailures: 0, order: hosts.size };
      hosts.set(address, value);
    }
    return value;
  }

  function nextDispatchAt(kind: RequestKind, time = now()): number {
    while (dispatches.length && dispatches[0]! <= time - 86_400_000) dispatches.shift();
    while (discoveryDispatches.length && discoveryDispatches[0]! <= time - 86_400_000) discoveryDispatches.shift();
    const deadline = (history: readonly number[], limits: readonly { count: number; window: number }[]): number => {
      let retryAt = time;
      for (const budget of limits) {
        const recent = history.filter(at => at > time - budget.window);
        if (recent.length >= budget.count) retryAt = Math.max(retryAt, recent[recent.length - budget.count]! + budget.window);
      }
      return retryAt;
    };
    const hardDeadline = Math.max(time, pauseUntil, deadline(dispatches, budgets));
    if (kind === "maintenance") return hardDeadline;
    // Repeated empty, failed and hinted lookups cannot consume the final quarter
    // of discovery capacity. Count ALL discovery traffic toward this gate so
    // previous cold starts do not erase the reservation for a newly viewed roster.
    const limits = discoveryBudgets.map(budget => ({ ...budget,
      count: kind === "rediscovery" ? Math.floor(budget.count * 0.75) : budget.count,
    }));
    return Math.max(hardDeadline, deadline(discoveryDispatches, limits));
  }

  function discoveryKind(entry: HostCache): RequestKind {
    return entry.lastLookupAt === -Infinity ? "discovery" : "rediscovery";
  }

  function reserve(kind: RequestKind): void {
    const time = now();
    // Use one instant for admission: crossing a millisecond between these reads
    // must not invent a budget pause when the provider has capacity.
    const retryAt = nextDispatchAt(kind, time);
    if (retryAt > time) throw new DeferredRequest(
      pauseUntil > time ? "Nosana job reads are pending until the shared Retry-After pause ends."
        : "Nosana job reads are pending within the preview's local request budget.", retryAt);
    dispatches.push(time);
    if (kind !== "maintenance") discoveryDispatches.push(time);
  }

  function snapshot(addresses: readonly string[]): JobSnapshot {
    const maintenanceAt = nextDispatchAt("maintenance");
    const discoveryAt = nextDispatchAt("discovery");
    const rediscoveryAt = nextDispatchAt("rediscovery");
    const discoveryWaits = addresses.flatMap(address => {
      const entry = cache(address);
      if (entry.record.job && !entry.forceDiscovery) return [];
      const deadline = discoveryKind(entry) === "discovery" ? discoveryAt : rediscoveryAt;
      return deadline > now() ? [deadline] : [];
    });
    const discoveryWaitAt = discoveryWaits.length ? Math.min(...discoveryWaits) : null;
    const waitReason = !addresses.length ? null : pauseUntil > now() ? "retry-after"
      : maintenanceAt > now() ? "local-budget" : discoveryWaitAt !== null ? "discovery-budget" : null;
    return {
      hosts: addresses.map(address => {
        const record = cache(address).record;
        const entry = cache(address);
        const lookupAt = discoveryKind(entry) === "discovery" ? discoveryAt : rediscoveryAt;
        const retryAtMs = entry.record.job && !entry.forceDiscovery
          ? Math.max(entry.maintenanceAttemptAt, maintenanceAt) : Math.max(entry.nextAttemptAt, lookupAt);
        return { ...record, job: record.job ? { ...record.job } : null,
          ...(record.pending ? { retryAtMs } : {}) };
      }),
      nextRefreshAtMs: addresses.length ? Math.min(...addresses.map(address => {
        const entry = cache(address);
        const lookup = Math.max(discoveryKind(entry) === "discovery" ? discoveryAt : rediscoveryAt, entry.nextAttemptAt);
        const maintenance = Math.max(maintenanceAt, entry.maintenanceAttemptAt);
        return !entry.record.job ? lookup : entry.forceDiscovery ? Math.min(lookup, maintenance) : maintenance;
      })) : null,
      waitReason,
      waitUntilMs: waitReason === "retry-after" ? pauseUntil : waitReason === "local-budget" ? maintenanceAt
        : waitReason === "discovery-budget" ? discoveryWaitAt : null,
    };
  }

  function notify(entry: HostCache): void {
    for (const observer of observers.get(entry.record.address) ?? []) observer();
  }

  function noteRetry(response: Response): void {
    const retry = response.headers.get("retry-after")?.trim();
    if (response.status !== 429 && !retry) return;
    const seconds = retry && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) : NaN;
    const date = retry && !Number.isFinite(seconds) ? Date.parse(retry) : NaN;
    const until = Number.isFinite(seconds) ? now() + seconds * 1000 : date;
    pauseUntil = Math.max(pauseUntil, now() + failureBackoffMs, Number.isFinite(until) ? until : 0);
  }

  function comparePriority(one: readonly number[], two: readonly number[]): number {
    for (let index = 0; index < one.length; index++) {
      if (one[index] !== two[index]) return one[index]! < two[index]! ? -1 : 1;
    }
    return 0;
  }

  function maintenancePriority(entry: HostCache, time = now()): readonly number[] {
    const expiresAt = entry.record.validUntilMs ?? -Infinity;
    return [entry.maintenanceAttemptAt > time ? 4 : expiresAt <= time + 10_000 ? 0
      : activityPriority(entry.record.address, time) + 1,
    entry.record.checkedAtMs ?? -Infinity, entry.maintenanceAttemptAt, entry.order];
  }

  function dispatchPriority(kind: RequestKind, entries: readonly HostCache[]): readonly number[] {
    if (kind === "discovery") return [0, activityPriority(entries[0]!.record.address, now()), 0, entries[0]!.order];
    if (kind === "maintenance") {
      // Expiring evidence always leads, ordered by its original check time.
      // Otherwise backend transition hints order already due batches. Fresh
      // coalesced entries cannot promote a batch ahead of eligible work.
      const time = now();
      let priority = maintenancePriority(entries[0]!, time);
      for (const entry of entries.slice(1)) {
        const candidate = maintenancePriority(entry, time);
        if (comparePriority(candidate, priority) < 0) priority = candidate;
      }
      return [1, ...priority];
    }
    const entry = entries[0]!;
    const time = now();
    // An attempted but still unverified host has no current evidence. Give its
    // already due retry the same lane as expired evidence, retaining backoff.
    const expiresAt = entry.record.validUntilMs ?? -Infinity;
    const expiring = expiresAt <= time + 10_000;
    return [2, expiring ? 0 : activityPriority(entry.record.address, time) + 1,
      entry.nextAttemptAt, entry.order];
  }

  async function json(path: string, signal: AbortSignal, kind: RequestKind, entries: readonly HostCache[],
    window: WorkWindow, body?: { addresses: string[] }): Promise<unknown> {
    return limited(async () => {
      // Finish this finite read with a complete pending/cache snapshot instead
      // of holding its browser stream open behind a whole slow roster. Existing
      // requests drain normally; unstarted work spends no quota or failure count.
      if (elapsedNow() >= window.deadline) {
        throw new DeferredRequest("Nosana job lookup is pending for the next bounded read.", now());
      }
      reserve(kind);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetcher(`${origin}${path}`, {
          method: body ? "POST" : "GET", headers: body
            ? { Accept: "application/json", "Content-Type": "application/json" } : { Accept: "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
          redirect: "error", credentials: "omit", signal: AbortSignal.any([signal, controller.signal]),
        });
        throwIfAborted(signal);
        if (!response.ok) {
          noteRetry(response);
          void response.body?.cancel().catch(() => {});
          throw new RequestError(`Nosana jobs request failed (HTTP ${response.status}).`);
        }
        if (Number(response.headers.get("content-length")) > responseByteLimit) {
          void response.body?.cancel().catch(() => {});
          throw new RequestError("Nosana jobs response exceeded the size limit.");
        }
        const reader = response.body?.getReader();
        if (!reader) throw new RequestError("Nosana jobs response did not contain valid JSON.");
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            throwIfAborted(signal);
            if (done) break;
            length += value.byteLength;
            if (length > responseByteLimit) {
              void reader.cancel().catch(() => {});
              throw new RequestError("Nosana jobs response exceeded the size limit.");
            }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { throw new RequestError("Nosana jobs response did not contain valid JSON."); }
      } catch (error) {
        throwIfAborted(signal);
        if (error instanceof RequestError) throw error;
        throw new RequestError(controller.signal.aborted ? "Nosana jobs request timed out."
          : "Nosana jobs request could not be completed.");
      } finally { clearTimeout(timer); }
    }, signal, () => elapsedNow() >= window.deadline
      // Expired work must leave the queue before another viewer's eligible work
      // can keep this response open. Older windows drain first without fetching.
      ? [-1, window.deadline, entries[0]!.order] : dispatchPriority(kind, entries));
  }

  function adaptiveBackoff(attempts: number): number {
    return Math.min(maximumBackoffMs, failureBackoffMs * 2 ** Math.min(4, Math.max(0, attempts - 1)));
  }

  function success(entry: HostCache, job: JobTiming | null, revision: number, kind: RequestKind = "discovery"): void {
    const checkedAtMs = now();
    const pendingLookupAt = entry.nextAttemptAt;
    entry.maintenanceFailures = 0;
    if (kind === "discovery") {
      entry.failures = 0;
      entry.emptyLookups = job ? 0 : entry.emptyLookups + 1;
    }
    entry.record = { address: entry.record.address, job, checkedAtMs,
      validUntilMs: checkedAtMs + JOB_DISPLAY_VALIDITY_MS, failedAtMs: null,
      retained: false, pending: false, retryAtMs: null, error: null };
    entry.nextAttemptAt = checkedAtMs + (job ? JOB_REFRESH_INTERVAL_MS : adaptiveBackoff(entry.emptyLookups));
    entry.maintenanceAttemptAt = checkedAtMs + JOB_REFRESH_INTERVAL_MS;
    if (kind === "maintenance" && entry.forceDiscovery) {
      // A known-job batch validates this clock, but cannot answer a pending
      // host-assignment question or clear a newer State transition hint.
      entry.nextAttemptAt = pendingLookupAt;
      entry.record.pending = true;
      entry.record.retryAtMs = Math.max(pendingLookupAt, nextDispatchAt(discoveryKind(entry)));
    } else if (entry.revision === revision) entry.forceDiscovery = false;
    else {
      entry.nextAttemptAt = Math.max(now(), entry.lastLookupAt + failureBackoffMs);
      entry.record.pending = true;
      entry.record.retryAtMs = Math.max(entry.nextAttemptAt, nextDispatchAt(discoveryKind(entry)));
    }
    notify(entry);
  }

  function failure(entry: HostCache, error: unknown, kind: RequestKind = "discovery"): void {
    const retryAtMs = error instanceof DeferredRequest ? error.retryAtMs
      : Math.max(now() + adaptiveBackoff(kind === "maintenance" ? ++entry.maintenanceFailures : ++entry.failures), pauseUntil);
    if (error instanceof DeferredRequest) {
      // Budget deadlines are recomputed, not persisted as host failure backoff.
      entry.record = { ...entry.record, pending: true, retryAtMs };
      notify(entry);
      return;
    }
    if (kind === "maintenance") entry.maintenanceAttemptAt = retryAtMs;
    if (kind === "discovery" || !entry.forceDiscovery) entry.nextAttemptAt = retryAtMs;
    entry.record = { ...entry.record, retained: entry.record.job !== null,
      failedAtMs: entry.record.failedAtMs ?? now(), pending: false, retryAtMs,
      error: error instanceof RequestError ? error.message : "Nosana job assignment lookup failed." };
    notify(entry);
  }

  function rejectConflictingOwner(entry: HostCache, job: JobTiming): void {
    for (const other of hosts.values()) {
      if (other !== entry && other.record.job?.address === job.address) {
        const error = new RequestError("Nosana returned one job for conflicting Host Addresses.");
        failure(other, error);
        other.forceDiscovery = true;
        throw error;
      }
    }
  }

  async function discover(entry: HostCache, signal: AbortSignal, window: WorkWindow): Promise<void> {
    throwIfAborted(signal);
    const revision = entry.revision;
    try {
      const job = assignment(entry.record.address, await json(`/jobs/?${new URLSearchParams({
        node: entry.record.address, state: "RUNNING", limit: "2",
      })}`, signal, discoveryKind(entry), [entry], window));
      throwIfAborted(signal);
      entry.lastLookupAt = now();
      if (job) rejectConflictingOwner(entry, job);
      if (job && (job.timeStart === null || job.timeStart <= 0 ||
          !isJobTimestamp(job.timeStart * 1000) || job.timeStart * 1000 > now())) {
        throw new RequestError("Nosana job run start is missing, invalid or in the future.");
      }
      success(entry, job, revision);
    } catch (error) {
      throwIfAborted(signal);
      if (!(error instanceof DeferredRequest)) entry.lastLookupAt = now();
      failure(entry, error);
    }
  }

  async function refreshBatch(entries: HostCache[], signal: AbortSignal, window: WorkWindow): Promise<void> {
    throwIfAborted(signal);
    const expected = new Map(entries.map(entry => [entry.record.job!.address, entry]));
    const revisions = new Map(entries.map(entry => [entry, entry.revision]));
    try {
      const payload = await json("/jobs/batch", signal, "maintenance", entries, window, { addresses: [...expected.keys()] });
      throwIfAborted(signal);
      if (!Array.isArray(payload) || payload.length > expected.size) {
        throw new RequestError("Nosana jobs batch response contained an invalid list.");
      }
      const jobs = new Map<string, JobTiming>();
      for (const raw of payload) {
        const job = timing(raw);
        if (!expected.has(job.address) || jobs.has(job.address)) {
          throw new RequestError("Nosana jobs batch contained unsolicited or duplicate job addresses.");
        }
        jobs.set(job.address, job);
      }
      await Promise.all(entries.map(async entry => {
        const job = jobs.get(entry.record.job!.address);
        if (job?.node === entry.record.address && job.state === "RUNNING" && job.timeEnd === 0) {
          if (job.timeStart === null || job.timeStart <= 0 ||
              !isJobTimestamp(job.timeStart * 1000) || job.timeStart * 1000 > now()) {
            failure(entry, new RequestError("Nosana job run start is missing, invalid or in the future."), "maintenance");
            return;
          }
          success(entry, job, revisions.get(entry)!, "maintenance");
          return;
        }
        // A known terminal state/end clears this assignment before replacement discovery.
        const ended = job?.timeEnd !== null && job?.timeStart !== null && job !== undefined &&
          job.timeEnd > 0 && job.timeStart > 0 && job.timeEnd >= job.timeStart && job.timeEnd * 1000 <= now();
        if (job?.node === entry.record.address && (job.state !== "RUNNING" || ended)) {
          success(entry, null, revisions.get(entry)!, "maintenance");
        } else {
          failure(entry, new RequestError("The known job is missing, moved or has unverified end timing; rechecking assignment."), "maintenance");
        }
        entry.forceDiscovery = true;
        // Replacement discovery is already due. If this response's work window
        // ends first, do not turn its unattempted lookup into empty/failure backoff.
        entry.nextAttemptAt = now();
        await discover(entry, signal, window);
      }));
    } catch (error) { throwIfAborted(signal); entries.forEach(entry => failure(entry, error, "maintenance")); }
  }

  function start(entries: HostCache[], action: (signal: AbortSignal) => Promise<void>, signal?: AbortSignal): Promise<void> {
    const operation = createSharedOperation(action, () => {
      for (const entry of entries) {
        if (pending.get(entry.record.address) === operation) pending.delete(entry.record.address);
      }
    });
    for (const entry of entries) pending.set(entry.record.address, operation);
    return operation.read(signal);
  }

  const provider: JobProvider = async (addresses, signal, onUpdate) => {
    throwIfAborted(signal);
    const window: WorkWindow = { deadline: elapsedNow() + workWindowMs };
    if (addresses.some(address => !isMetadataAddress(address)) || new Set(addresses).size !== addresses.length) {
      throw new Error("Job input must contain unique validated Host Addresses.");
    }
    const unsubscribe: (() => void)[] = [];
    if (onUpdate) {
      const emit = (selected: readonly string[]): void => {
        if (signal?.aborted || !selected.length) return;
        // A disconnected streaming consumer cannot turn validated evidence into a failure.
        try { onUpdate(snapshot(selected)); } catch { /* The final read remains authoritative. */ }
      };
      emit(addresses.filter(address => hosts.has(address)));
      for (const address of addresses) {
        const observer = (): void => emit([address]);
        let subscribed = observers.get(address);
        if (!subscribed) { subscribed = new Set(); observers.set(address, subscribed); }
        subscribed.add(observer);
        unsubscribe.push(() => {
          subscribed.delete(observer);
          if (!subscribed.size && observers.get(address) === subscribed) observers.delete(address);
        });
      }
    }
    try {
      throwIfAborted(signal);
      const work: Promise<void>[] = [];
      const batch: HostCache[] = [];
      const coalescible: HostCache[] = [];
      const discoveries: HostCache[] = [];
      const firstDiscoveryAt = nextDispatchAt("discovery");
      const repeatDiscoveryAt = nextDispatchAt("rediscovery");
      for (const address of addresses) {
        const existing = pending.get(address);
        if (existing) { work.push(existing.read(signal)); continue; }
        const entry = cache(address);
        const discoveryAt = discoveryKind(entry) === "discovery" ? firstDiscoveryAt : repeatDiscoveryAt;
        if (!entry.record.job) {
          if (now() >= entry.nextAttemptAt) discoveries.push(entry);
        } else if (entry.forceDiscovery && now() >= Math.max(entry.nextAttemptAt, discoveryAt)) {
          discoveries.push(entry);
        } else {
          if (entry.forceDiscovery && now() >= entry.nextAttemptAt && discoveryAt > now()) {
            failure(entry, new DeferredRequest("Assignment discovery is waiting for its shared request allowance.", discoveryAt));
          }
          if (now() >= entry.maintenanceAttemptAt) batch.push(entry);
          // A pending assignment hint does not exclude its still-valid known job.
          else if (!entry.record.error && (!entry.record.pending || entry.forceDiscovery)) coalescible.push(entry);
        }
      }
      const time = now();
      const compareMaintenance = (one: HostCache, two: HostCache): number =>
        comparePriority(maintenancePriority(one, time), maintenancePriority(two, time));
      batch.sort(compareMaintenance);
      coalescible.sort(compareMaintenance);
      if (batch.length) batch.push(...coalescible);
      // Submit the same initial lane ordering used at each shared dispatch. The
      // limiter reconsiders it whenever either of the two request slots opens.
      discoveries.sort((one, two) => one.lastLookupAt === -Infinity && two.lastLookupAt === -Infinity
        ? comparePriority(dispatchPriority("discovery", [one]), dispatchPriority("discovery", [two]))
        : one.lastLookupAt - two.lastLookupAt || one.order - two.order);
      const enqueueDiscovery = (entry: HostCache): void => {
        work.push(start([entry], operationSignal => discover(entry, operationSignal, window), signal));
      };
      discoveries.filter(entry => entry.lastLookupAt === -Infinity).forEach(enqueueDiscovery);
      for (let offset = 0; offset < batch.length; offset += 100) {
        const entries = batch.slice(offset, offset + 100);
        work.push(start(entries, operationSignal => refreshBatch(entries, operationSignal, window), signal));
      }
      discoveries.filter(entry => entry.lastLookupAt !== -Infinity).forEach(enqueueDiscovery);
      await Promise.all(work);
      throwIfAborted(signal);
      return snapshot(addresses);
    } finally {
      unsubscribe.forEach(remove => remove());
    }
  };

  provider.observeStates = snapshot => {
    for (const record of snapshot.hosts) {
      if (!isMetadataAddress(record.address) || record.error || record.retained ||
          record.fetchedAtMs === null || record.fetchedAtMs > now() ||
          record.validUntilMs === null || record.validUntilMs <= now()) continue;
      let state = record.values?.state;
      if (state === "OTHER") {
        const activity = record.activity;
        state = activity && !activity.error && activity.checkedAtMs !== null && activity.checkedAtMs <= now() &&
          activity.validUntilMs !== null && activity.validUntilMs > now() ? activity.state : null;
      }
      if (!state) continue;
      const previous = reportedStates.get(record.address);
      reportedStates.set(record.address, state);
      const entry = hosts.get(record.address);
      // A viewer can first report State after a cached empty/failed lookup has
      // already backed off. That first running proof deserves the same bounded
      // recheck as a transition; it supplies no timing and does not disturb an
      // existing clock or repeatedly reset backoff while State remains running.
      const firstRunningWithoutTiming = previous === undefined && entry !== undefined &&
        entry.record.job === null && entry.lastLookupAt !== -Infinity;
      if (entry && state === "RUNNING_JOB" &&
          (previous !== undefined && previous !== "RUNNING_JOB" || firstRunningWithoutTiming)) {
        entry.forceDiscovery = true;
        entry.revision++;
        entry.emptyLookups = 0;
        entry.nextAttemptAt = Math.max(now(), entry.lastLookupAt + failureBackoffMs);
        entry.record = { ...entry.record, pending: true,
          retryAtMs: Math.max(entry.nextAttemptAt, nextDispatchAt(discoveryKind(entry))) };
      }
    }
  };
  return provider;
}
