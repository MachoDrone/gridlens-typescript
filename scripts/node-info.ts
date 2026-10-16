import { createSharedRead, createRequestLimiter, throwIfAborted } from "./shared-read.ts";
import { createDemandWatch } from "./demand-watch.ts";
import { pruneCacheKeys } from "./online-retention.ts";
import type { ProviderRetention } from "./online-retention.ts";
import { isMetadataAddress } from "../src/fleet/host-metadata.ts";
import { normalizeNodeInfo } from "../src/fleet/node-info.ts";
import { NODE_API_ERROR_CODES } from "../src/fleet/node-info.ts";
import type { NodeInfoRecord, NodeInfoSnapshot, NodeApiFailureKind, NodeApiFailurePhase, NodeApiErrorCode, NodeApiResult } from "../src/fleet/node-info.ts";

const successCacheMs = 15_000;
const stateDisplayValidityMs = 30_000;
const failureBackoffMs = 60_000;
const maximumFailureBackoffMs = 15 * 60_000;
const failureRetryIntervalMs = 30_000;
const transientRetryIntervalMs = 5_000;
const confirmationDelayMs = 1_000;
const responseByteLimit = 256 * 1024;
// Independent node endpoints share a bounded pool; the per-host 15s cadence is
// unchanged. Four slots keep ordinary fleet RTTs from exhausting the 30s TTL.
const nodeInfoConcurrency = 4;

/** Updates contain only the completed hosts; the final result remains the full ordered roster. */
export interface NodeInfoProvider {
  retention?: ProviderRetention;
  (addresses: readonly string[], signal?: AbortSignal, onUpdate?: (snapshot: NodeInfoSnapshot) => void): Promise<NodeInfoSnapshot>;
  watch?: (addresses: readonly string[], signal: AbortSignal, onUpdate: (snapshot: NodeInfoSnapshot) => void) => Promise<never>;
  nextRefreshAt?: (addresses: readonly string[]) => number | null;
}

interface HostCache {
  record: NodeInfoRecord;
  /** Actual completed responses/failures count; pause deferrals and cancellation do not. */
  attempted: boolean;
  nextAttemptAt: number;
  consecutiveFailures: number;
  reachabilityFailures: number;
  serviceUnavailableFailures: number;
  firstServiceUnavailableAtMs: number | null;
}

interface FailureDetails {
  failureKind: NodeApiFailureKind;
  phase: NodeApiFailurePhase;
  httpStatus?: number;
  errorCode?: NodeApiErrorCode;
}
class RequestError extends Error {
  readonly details: FailureDetails;
  constructor(message: string, details: FailureDetails = { failureKind: "invalid-response", phase: "validation" }) {
    super(message);
    this.details = details;
  }
}

/** Retain only documented error codes; never expose exception messages, URLs or headers. */
function transportCode(error: unknown): NodeApiErrorCode | undefined {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  for (let count = 0; pending.length && count < 8; count++) {
    const value = pending.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    const record = value as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof record.code === "string" && (NODE_API_ERROR_CODES as readonly string[]).includes(record.code)) return record.code as NodeApiErrorCode;
    if (record.cause) pending.push(record.cause);
    if (Array.isArray(record.errors)) pending.push(...record.errors.slice(0, 4));
  }
  return undefined;
}

class DeferredRequestError extends Error {
  readonly retryAtMs: number;
  constructor(retryAtMs: number) {
    super("Nosana Node Info requests are paused after rate limiting.");
    this.retryAtMs = retryAtMs;
  }
}

/** Anonymous, demand-driven reads with an independent, memory-only cache. */
export function createNodeInfoProvider({
  fetch: fetcher = globalThis.fetch,
  now = Date.now,
  timeoutMs = 8_000,
  activityPriority,
}: {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  timeoutMs?: number;
  /** Validated backend activity: transition, early/near-limit job, then routine. */
  activityPriority?: (address: string, nowMs: number) => 0 | 1 | 2;
} = {}): NodeInfoProvider {
  const hosts = new Map<string, HostCache>();
  const insertionOrder = new Map<string, number>();
  let insertionSequence = 0;
  const register = (addresses: readonly string[]): void => {
    for (const address of addresses) if (!insertionOrder.has(address)) insertionOrder.set(address, insertionSequence++);
  };
  const readHost = createSharedRead<string, NodeInfoRecord>();
  const limited = createRequestLimiter(nodeInfoConcurrency);
  let pauseUntil = 0;

  function noteRateLimit(response: Response): void {
    const retry = response.headers.get("retry-after")?.trim();
    const seconds = retry && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) : NaN;
    const date = retry && !Number.isFinite(seconds) ? Date.parse(retry) : NaN;
    const until = Number.isFinite(seconds) ? now() + seconds * 1000 : date;
    pauseUntil = Math.max(pauseUntil, now() + failureBackoffMs, Number.isFinite(until) ? until : 0);
  }

  async function json(address: string, signal: AbortSignal): Promise<{ payload: unknown; httpStatus: number | undefined }> {
    return limited(async () => {
      if (now() < pauseUntil) throw new DeferredRequestError(pauseUntil);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let phase: NodeApiFailurePhase = "request";
      let httpStatus: number | undefined;
      try {
        const response = await fetcher(`https://${address}.node.k8s.prd.nos.ci/node/info`, {
          method: "GET",
          headers: { Accept: "application/json" },
          redirect: "manual",
          credentials: "omit",
          signal: AbortSignal.any([signal, controller.signal]),
        });
        throwIfAborted(signal);
        phase = "headers";
        httpStatus = response.status >= 100 && response.status <= 599 ? response.status : undefined;
        if (!response.ok) {
          if (response.status === 429 || response.headers.has("retry-after")) noteRateLimit(response);
          void response.body?.cancel().catch(() => {});
          throw new RequestError(`Nosana Node Info request failed (HTTP ${response.status}).`, {
            failureKind: response.status >= 300 && response.status < 400 ? "redirect" : "http", phase,
            ...(httpStatus !== undefined ? { httpStatus } : {}),
          });
        }
        const declaredLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > responseByteLimit) {
          void response.body?.cancel().catch(() => {});
          throw new RequestError("Nosana Node Info response exceeded the size limit.", { failureKind: "invalid-response", phase, ...(httpStatus !== undefined ? { httpStatus } : {}) });
        }
        const reader = response.body?.getReader();
        if (!reader) throw new RequestError("Nosana Node Info response did not contain valid JSON.", { failureKind: "invalid-response", phase, ...(httpStatus !== undefined ? { httpStatus } : {}) });
        phase = "body";
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            throwIfAborted(signal);
            if (done) break;
            total += value.byteLength;
            if (total > responseByteLimit) {
              void reader.cancel().catch(() => {});
              throw new RequestError("Nosana Node Info response exceeded the size limit.", { failureKind: "invalid-response", phase, ...(httpStatus !== undefined ? { httpStatus } : {}) });
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        phase = "validation";
        try {
          return { payload: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))), httpStatus };
        } catch {
          throw new RequestError("Nosana Node Info response did not contain valid JSON.", { failureKind: "invalid-response", phase, ...(httpStatus !== undefined ? { httpStatus } : {}) });
        }
      } catch (error) {
        throwIfAborted(signal);
        if (error instanceof RequestError) throw error;
        const errorCode = transportCode(error);
        throw new RequestError(controller.signal.aborted
          ? "Nosana Node Info request timed out." : "Nosana Node Info request could not be completed.", {
            failureKind: controller.signal.aborted ? "timeout" : "network", phase,
            ...(httpStatus !== undefined ? { httpStatus } : {}), ...(errorCode !== undefined ? { errorCode } : {}),
          });
      } finally {
        clearTimeout(timer);
      }
    }, signal, () => requestPriority(address));
  }

  async function host(address: string, signal?: AbortSignal): Promise<NodeInfoRecord> {
    throwIfAborted(signal);
    const cached = hosts.get(address);
    if (cached && now() < cached.nextAttemptAt) return cached.record;
    return readHost(address, async signal => {
      let result: HostCache;
      try {
        if (now() < pauseUntil) throw new DeferredRequestError(pauseUntil);
        const response = await json(address, signal);
        let values;
        try { values = normalizeNodeInfo(address, response.payload); }
        catch { throw new RequestError("Nosana Node Info response did not match the requested Host Address.", {
          failureKind: "invalid-response", phase: "validation",
          ...(response.httpStatus !== undefined ? { httpStatus: response.httpStatus } : {}),
        }); }
        const fetchedAtMs = now();
        result = {
          attempted: true,
          record: { address, values, fetchedAtMs, validUntilMs: fetchedAtMs + stateDisplayValidityMs, retained: false, error: null,
            apiCheck: { status: "online", checkedAtMs: fetchedAtMs,
              lastConfirmed: { status: "online", checkedAtMs: fetchedAtMs } } },
          nextAttemptAt: fetchedAtMs + successCacheMs,
          consecutiveFailures: 0,
          reachabilityFailures: 0,
          serviceUnavailableFailures: 0, firstServiceUnavailableAtMs: null,
        };
      } catch (error) {
        throwIfAborted(signal);
        if (error instanceof DeferredRequestError) {
          // No endpoint was contacted. Preserve its last actual outcome and
          // failure count rather than manufacturing another node outage.
          result = {
            attempted: cached?.attempted ?? false,
            record: cached?.record ?? { address, values: null, fetchedAtMs: null, validUntilMs: null,
              retained: false, error: error.message, apiCheck: { status: "other", checkedAtMs: now() } },
            nextAttemptAt: Math.max(cached?.nextAttemptAt ?? 0, error.retryAtMs),
            consecutiveFailures: cached?.consecutiveFailures ?? 0,
            reachabilityFailures: cached?.reachabilityFailures ?? 0,
            serviceUnavailableFailures: cached?.serviceUnavailableFailures ?? 0,
            firstServiceUnavailableAtMs: cached?.firstServiceUnavailableAtMs ?? null,
          };
        } else {
          const consecutiveFailures = (cached?.consecutiveFailures ?? 0) + 1;
          const details: FailureDetails = error instanceof RequestError ? error.details : { failureKind: "invalid-response", phase: "validation" };
          const reachabilityFailure = details.failureKind === "timeout" || details.failureKind === "network"
            || details.failureKind === "redirect" || details.failureKind === "http" && (details.httpStatus ?? 0) >= 500;
          const reachabilityFailures = reachabilityFailure ? (cached?.reachabilityFailures ?? 0) + 1 : 0;
          const serviceUnavailable = details.failureKind === "http" && details.httpStatus === 503;
          const previousFirst = cached?.firstServiceUnavailableAtMs;
          const freshPair = previousFirst !== undefined && previousFirst !== null
            && previousFirst <= now() && now() < previousFirst + stateDisplayValidityMs;
          const serviceUnavailableFailures = serviceUnavailable ? freshPair ? (cached?.serviceUnavailableFailures ?? 0) + 1 : 1 : 0;
          const firstServiceUnavailableAtMs = serviceUnavailable ? freshPair ? previousFirst! : now() : null;
          const confirmationPending = reachabilityFailures === 1 || serviceUnavailableFailures === 1;
          const backoffMs = confirmationPending ? confirmationDelayMs
            : Math.min(maximumFailureBackoffMs, failureBackoffMs * 2 ** Math.min(4, consecutiveFailures - 1));
          const lastOnlineAtMs = cached?.record.fetchedAtMs;
          const checkedAtMs = now();
          const nextAttemptAt = Math.max(checkedAtMs + backoffMs, pauseUntil);
          const lastConfirmed: NodeApiResult | undefined = serviceUnavailableFailures >= 2
            ? { status: "offline", checkedAtMs, firstFailedAtMs: firstServiceUnavailableAtMs!, httpStatus: 503, nextCheckAtMs: nextAttemptAt }
            : cached?.record.apiCheck?.lastConfirmed;
          result = {
            attempted: true,
            record: {
              address,
              values: cached?.record.values ?? null,
              fetchedAtMs: cached?.record.fetchedAtMs ?? null,
              validUntilMs: cached?.record.validUntilMs ?? null,
              retained: cached?.record.values !== undefined && cached.record.values !== null,
              error: error instanceof RequestError ? error.message : "Nosana Node Info lookup failed.",
              apiCheck: {
                status: serviceUnavailableFailures >= 2 ? "offline" : "other", checkedAtMs, ...details,
                ...(confirmationPending ? { confirmationPending: true } : {}),
                ...(lastOnlineAtMs !== undefined && lastOnlineAtMs !== null ? { lastOnlineAtMs } : {}),
                ...(firstServiceUnavailableAtMs !== null ? { firstFailedAtMs: firstServiceUnavailableAtMs } : {}),
                ...(lastConfirmed !== undefined ? { lastConfirmed } : {}),
                ...(serviceUnavailableFailures >= 2 ? { nextCheckAtMs: nextAttemptAt } : {}),
              },
            },
            nextAttemptAt, consecutiveFailures, reachabilityFailures,
            serviceUnavailableFailures, firstServiceUnavailableAtMs,
          };
        }
      }
      throwIfAborted(signal);
      hosts.set(address, result);
      watch.publish(address, result.record);
      return result.record;
    }, signal);
  }

  let warmConfirmationDispatches = 0;
  let nextFailureRetryAt = 0;
  let nextTransientRetryAt = 0;
  const failedHost = (address: string): boolean => (hosts.get(address)?.consecutiveFailures ?? 0) > 0;
  const transientFailure = (address: string): boolean => {
    const cached = hosts.get(address);
    return cached?.record.apiCheck?.confirmationPending === true
      || cached?.consecutiveFailures === 1 && cached.record.values !== null;
  };
  const warmConfirmation = (address: string): boolean => hosts.get(address)?.record.apiCheck?.confirmationPending === true
    && hosts.get(address)?.record.values !== null;
  const liveServiceConfirmation = (address: string): boolean => {
    const check = hosts.get(address)?.record.apiCheck;
    return check?.confirmationPending === true && check.httpStatus === 503
      && check.firstFailedAtMs !== undefined && check.firstFailedAtMs <= now()
      && now() < check.firstFailedAtMs + stateDisplayValidityMs;
  };
  const eligibleAt = (address: string): number => Math.max(
    pauseUntil, hosts.get(address)?.nextAttemptAt ?? 0,
    failedHost(address) ? transientFailure(address) ? nextTransientRetryAt : nextFailureRetryAt : 0,
  );
  const priority = (address: string): number => {
    const cached = hosts.get(address);
    // A full initial attempt pass precedes routine repeats, even if that pass
    // exceeds the display deadline. Real failed/unresolved reads leave this lane.
    if (!cached?.attempted) return -2;
    if (failedHost(address)) {
      if (warmConfirmation(address)) return -7;
      // Keep bounded confirmation/recovery lanes and their existing fairness.
      if (warmConfirmationDispatches >= 3) return -8;
      return liveServiceConfirmation(address) ? -5 : transientFailure(address) ? -4 : -3;
    }
    const record = cached.record;
    const time = now();
    // Aging evidence eventually outranks any transition. This affects ordering
    // only; cache eligibility and the original 30-second proof remain unchanged.
    if (record.validUntilMs !== null && record.validUntilMs - time <= 10_000) return 0;
    const nativeTransition = !record.error && !record.retained && record.fetchedAtMs !== null
      && record.fetchedAtMs <= time && record.validUntilMs !== null && time < record.validUntilMs
      && (record.values?.state === "STARTING" || record.values?.state === "RESTARTING");
    return 1 + Math.min(nativeTransition ? 0 : 2, activityPriority?.(address, time) ?? 2);
  };
  const requestPriority = (address: string): readonly number[] => [
    priority(address), hosts.get(address)?.nextAttemptAt ?? 0, insertionOrder.get(address) ?? 0,
  ];
  const compare = (left: string, right: string): number => {
    const leftPriority = requestPriority(left), rightPriority = requestPriority(right);
    for (let index = 0; index < leftPriority.length; index++) {
      const difference = leftPriority[index]! - rightPriority[index]!;
      if (difference) return difference;
    }
    return 0;
  };
  const watch = createDemandWatch({
    read: (address: string, signal) => {
      const old = hosts.get(address)?.record;
      const previousWarmDispatches = warmConfirmationDispatches;
      if (failedHost(address)) warmConfirmationDispatches = warmConfirmation(address) ? warmConfirmationDispatches + 1 : 0;
      const transient = transientFailure(address);
      const previousRetryAt = transient ? nextTransientRetryAt : nextFailureRetryAt;
      const pacedRetryAt = failedHost(address) ? now() + (transient ? transientRetryIntervalMs : failureRetryIntervalMs) : null;
      if (pacedRetryAt !== null) {
        if (transient) nextTransientRetryAt = pacedRetryAt;
        else nextFailureRetryAt = pacedRetryAt;
      }
      let pacingRestored = false;
      const canceled = (): void => {
        if (pacedRetryAt === null || pacingRestored) return;
        pacingRestored = true;
        if (transient && nextTransientRetryAt === pacedRetryAt) nextTransientRetryAt = previousRetryAt;
        if (!transient && nextFailureRetryAt === pacedRetryAt) nextFailureRetryAt = previousRetryAt;
        warmConfirmationDispatches = previousWarmDispatches;
      };
      signal.addEventListener("abort", canceled, { once: true });
      return host(address, signal).then(record => {
        // A shared pause can win after admission but before dispatch. A cache
        // hit/deferral returns the same record and must not consume a retry turn.
        if (record === old) canceled();
        return record;
      }).finally(() => { signal.removeEventListener("abort", canceled); });
    },
    peek: (address: string) => hosts.get(address)?.record,
    dueAt: eligibleAt,
    canRead: (address, pending) => {
      // One retried failing endpoint may wait for its full timeout; reserve the
      // remaining slots for healthy/cold work instead of blocking on that cohort.
      return !failedHost(address) || !pending.some(failedHost);
    },
    compare, now, concurrency: nodeInfoConcurrency,
  });
  const provider: NodeInfoProvider = async (addresses, signal, onUpdate) => {
    throwIfAborted(signal);
    if (addresses.some(address => !isMetadataAddress(address)) || new Set(addresses).size !== addresses.length) {
      throw new Error("Node Info input must contain unique validated Host Addresses.");
    }
    register(addresses);
    const records = await Promise.all([...addresses].sort(compare).map(async address => {
      // A finite/manual reader must not enqueue a competing full-roster pass
      // behind the active feed's carefully scheduled healthy/retry work.
      const record: NodeInfoRecord = watch.isWatching(address)
        ? hosts.get(address)?.record ?? {
          address, values: null, fetchedAtMs: null, validUntilMs: null, retained: false,
          error: "Nosana Node Info lookup is pending in the visible feed.",
          apiCheck: { status: "other", checkedAtMs: now() },
        }
        : await host(address, signal);
      throwIfAborted(signal);
      onUpdate?.({ hosts: [structuredClone(record)] });
      return record;
    }));
    const byAddress = new Map(records.map(record => [record.address, record]));
    return { hosts: addresses.map(address => structuredClone(byAddress.get(address)!)) };
  };
  provider.nextRefreshAt = addresses => addresses.length
    ? Math.min(...addresses.map(address => Math.max(pauseUntil, eligibleAt(address) || now()))) : null;
  provider.watch = (addresses, signal, onUpdate) => {
    if (addresses.some(address => !isMetadataAddress(address)) || new Set(addresses).size !== addresses.length) {
      return Promise.reject(new Error("Node Info input must contain unique validated Host Addresses."));
    }
    register(addresses);
    return watch.watch(addresses, signal, (_address, record) => onUpdate({
      hosts: [structuredClone(record)], nextRefreshAtMs: provider.nextRefreshAt!(addresses),
    }));
  };
  provider.retention = {
    retryAt: address => Math.max(hosts.get(address)?.nextAttemptAt ?? 0, watch.retryAt(address)),
    prune: ({ hosts: retained }) => {
      const keep = new Set(retained);
      for (const address of insertionOrder.keys()) if (readHost.isReading(address) || watch.isWatching(address)) keep.add(address);
      pruneCacheKeys(keep, hosts, insertionOrder);
      watch.prune(keep);
    },
  };
  return provider;
}
