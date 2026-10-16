import { createSharedRead, createRequestLimiter, throwIfAborted } from "./shared-read.ts";
import { createDemandWatch } from "./demand-watch.ts";
import { combineRetention, pruneCacheKeys } from "./online-retention.ts";
import type { ProviderRetention } from "./online-retention.ts";
import { comparePriority, refreshPriority } from "./scheduling-priority.ts";
import type { ActivityPriority } from "./scheduling-priority.ts";
import { isMetadataAddress } from "../src/fleet/host-metadata.ts";
import type { NodeActivityEvidence, NodeInfoRecord } from "../src/fleet/node-info.ts";
import type { HostMetadataProvider } from "./host-metadata.ts";
import type { NodeInfoProvider } from "./node-info.ts";
import type { MarketQueueProvider } from "./market-queue.ts";

const successCacheMs = 15_000;
const displayValidityMs = 30_000;
const failureBackoffMs = 60_000;
const responseByteLimit = 256 * 1024;
const services = {
  running: "https://blockchain-indexer.k8s.prd.nos.ci/jobs/running-nodes?market=",
  queued: "https://host-manager.k8s.prd.nosana.com/nodes/queued-nodes?marketAddress=",
} as const;
type Service = keyof typeof services;

export interface NodeActivityRequest {
  address: string;
  marketAddress: string;
}
export interface NodeActivityProvider {
  retention?: ProviderRetention;
  (requests: readonly NodeActivityRequest[], signal?: AbortSignal): Promise<Map<string, NodeActivityEvidence>>;
  watch?: (requests: readonly NodeActivityRequest[], signal: AbortSignal,
    onUpdate: (evidence: Map<string, NodeActivityEvidence>) => void) => Promise<never>;
  nextRefreshAt?: (requests: readonly NodeActivityRequest[]) => number | null;
}

interface Membership {
  members: ReadonlySet<string> | null;
  checkedAtMs: number | null;
  error: string | null;
  nextAttemptAt: number;
}
class RequestError extends Error {}

function unavailable(error: string): NodeActivityEvidence {
  return { state: null, source: "nosana-indexer", checkedAtMs: null, validUntilMs: null, error };
}

/** Validate the complete response before accepting any membership from it. */
function membership(service: Service, market: string, payload: unknown): Set<string> {
  if (!Array.isArray(payload)) throw new RequestError("Nosana activity response had an invalid membership list.");
  const result = new Set<string>();
  for (const entry of payload) {
    let address: unknown = entry;
    if (service === "queued") {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)
        || entry.marketAddress !== market || entry.state !== "QUEUED") {
        throw new RequestError("Nosana queue response did not match the requested market and state.");
      }
      address = entry.nodeAddress;
    }
    if (!isMetadataAddress(address) || result.has(address)) {
      throw new RequestError("Nosana activity response contained invalid or duplicate Host Addresses.");
    }
    result.add(address);
  }
  return result;
}

/** Demand-driven public membership reads: one request per service and distinct market. */
export function createNodeActivityProvider({
  fetch: fetcher = globalThis.fetch,
  now = Date.now,
  timeoutMs = 8_000,
  marketQueueProvider,
  activityPriority = () => 2,
}: {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  timeoutMs?: number;
  marketQueueProvider?: MarketQueueProvider;
  activityPriority?: ActivityPriority;
} = {}): NodeActivityProvider {
  const cache = new Map<string, Membership>();
  const assignments = new Map<string, string>();
  const attempted = new Set<string>();
  const readMembership = createSharedRead<string, Membership>();
  const pauseUntil: Record<Service, number> = { running: 0, queued: 0 };
  const limited = createRequestLimiter(2);
  const priority = (service: Service, market: string): readonly number[] => {
    const entry = cache.get(`${service}:${market}`);
    return refreshPriority(attempted.has(`${service}:${market}`), entry?.checkedAtMs == null
      ? null : entry.checkedAtMs + displayValidityMs, entry?.nextAttemptAt ?? 0, activityPriority(market, now()), now());
  };

  function noteRateLimit(service: Service, response: Response): void {
    const retry = response.headers.get("retry-after")?.trim();
    const seconds = retry && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) : NaN;
    const date = retry && !Number.isFinite(seconds) ? Date.parse(retry) : NaN;
    const until = Number.isFinite(seconds) ? now() + seconds * 1000 : date;
    pauseUntil[service] = Math.max(pauseUntil[service], now() + failureBackoffMs, Number.isFinite(until) ? until : 0);
  }

  async function json(service: Service, market: string, signal: AbortSignal): Promise<unknown> {
    return limited(async () => {
      if (now() < pauseUntil[service]) throw new RequestError("Nosana activity requests are paused after rate limiting.");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetcher(services[service] + market, {
          method: "GET", headers: { Accept: "application/json" }, redirect: "error",
          credentials: "omit", signal: AbortSignal.any([signal, controller.signal]),
        });
        throwIfAborted(signal);
        if (!response.ok) {
          if (response.status === 429) noteRateLimit(service, response);
          void response.body?.cancel().catch(() => {});
          throw new RequestError(`Nosana activity request failed (HTTP ${response.status}).`);
        }
        const declaredLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > responseByteLimit) {
          void response.body?.cancel().catch(() => {});
          throw new RequestError("Nosana activity response exceeded the size limit.");
        }
        const reader = response.body?.getReader();
        if (!reader) throw new RequestError("Nosana activity response did not contain valid JSON.");
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
              throw new RequestError("Nosana activity response exceeded the size limit.");
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        try {
          return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        } catch {
          throw new RequestError("Nosana activity response did not contain valid JSON.");
        }
      } catch (error) {
        throwIfAborted(signal);
        if (error instanceof RequestError) throw error;
        throw new RequestError(controller.signal.aborted
          ? "Nosana activity request timed out." : "Nosana activity request could not be completed.");
      } finally {
        clearTimeout(timer);
        if (!signal.aborted) attempted.add(`${service}:${market}`);
      }
    }, signal, () => priority(service, market));
  }

  async function read(service: Service, market: string, signal?: AbortSignal): Promise<Membership> {
    throwIfAborted(signal);
    const key = `${service}:${market}`;
    const cached = cache.get(key);
    if (cached && now() < cached.nextAttemptAt) return cached;
    return readMembership(key, async signal => {
      let result: Membership;
      try {
        const members = membership(service, market, await json(service, market, signal));
        const checkedAtMs = now();
        result = { members, checkedAtMs, error: null, nextAttemptAt: checkedAtMs + successCacheMs };
      } catch (error) {
        throwIfAborted(signal);
        // Never retain an earlier positive list after a failed membership refresh.
        result = {
          members: null, checkedAtMs: null,
          error: error instanceof RequestError ? error.message : "Nosana activity lookup failed.",
          nextAttemptAt: Math.max(now() + failureBackoffMs, pauseUntil[service]),
        };
      }
      throwIfAborted(signal);
      cache.set(key, result);
      return result;
    }, signal);
  }

  async function readQueued(market: string, signal?: AbortSignal): Promise<Membership> {
    throwIfAborted(signal);
    if (!marketQueueProvider) return read("queued", market, signal);
    try {
      const result = await marketQueueProvider(market, signal);
      throwIfAborted(signal);
      if (result.marketAddress !== market || result.error || result.retained || result.queue === null
        || result.checkedAtMs === null || result.validUntilMs === null || now() >= result.validUntilMs) {
        return { members: null, checkedAtMs: null, error: "Nosana ordered queue membership is unavailable or expired.", nextAttemptAt: 0 };
      }
      return { members: new Set(result.queueType === 1 ? result.queue : []), checkedAtMs: result.checkedAtMs,
        error: null, nextAttemptAt: 0 };
    } catch {
      throwIfAborted(signal);
      return { members: null, checkedAtMs: null, error: "Nosana ordered queue lookup failed.", nextAttemptAt: 0 };
    }
  }

  interface MarketEvidence { running: Membership; queued: Membership; nextAttemptAt: number }
  const marketEvidence = new Map<string, MarketEvidence>();
  function evidence(address: string, { running, queued }: MarketEvidence): NodeActivityEvidence {
    if (running.error || queued.error || running.checkedAtMs === null || queued.checkedAtMs === null) {
      return unavailable(running.error ?? queued.error ?? "Nosana activity lookup failed.");
    }
    const isRunning = running.members!.has(address);
    const isQueued = queued.members!.has(address);
    const checkedAtMs = Math.min(running.checkedAtMs, queued.checkedAtMs);
    return {
      state: isRunning === isQueued ? null : isRunning ? "RUNNING_JOB" : "QUEUED",
      source: "nosana-indexer", checkedAtMs, validUntilMs: checkedAtMs + displayValidityMs,
      error: isRunning && isQueued ? "Nosana activity sources disagree: host appears both running and queued."
        : !isRunning && !isQueued ? "Nosana activity sources did not establish running or queued membership." : null,
    };
  }
  async function marketRead(market: string, signal?: AbortSignal): Promise<MarketEvidence> {
    const [running, queued] = await Promise.all([read("running", market, signal), readQueued(market, signal)]);
    throwIfAborted(signal);
    const nextAttemptAt = Math.min(running.nextAttemptAt,
      marketQueueProvider ? marketQueueProvider.nextRefreshAt?.(market)
        ?? now() + (queued.error ? failureBackoffMs : successCacheMs) : queued.nextAttemptAt);
    const old = marketEvidence.get(market);
    const key = (value: Membership): string => JSON.stringify([value.checkedAtMs, value.error, value.members ? [...value.members] : null]);
    if (old && key(old.running) === key(running) && key(old.queued) === key(queued)
      && old.nextAttemptAt === nextAttemptAt) return old;
    const result = { running, queued, nextAttemptAt };
    marketEvidence.set(market, result);
    watch.publish(market, result);
    return result;
  }
  const watch = createDemandWatch({
    read: marketRead, peek: (market: string) => marketEvidence.get(market),
    dueAt: market => marketEvidence.get(market)?.nextAttemptAt ?? 0, now,
    compare: (left, right) => {
      const marketPriority = (market: string): readonly number[] => {
        const running = priority("running", market);
        if (marketQueueProvider) return running;
        const queued = priority("queued", market);
        return comparePriority(running, queued) <= 0 ? running : queued;
      };
      return comparePriority(marketPriority(left), marketPriority(right));
    },
  });
  function validate(requests: readonly NodeActivityRequest[]): void {
    if (requests.some(({ address, marketAddress }) => !isMetadataAddress(address) || !isMetadataAddress(marketAddress))
      || new Set(requests.map(request => request.address)).size !== requests.length) {
      throw new Error("Activity input must contain unique validated Host Addresses and valid market addresses.");
    }
    for (const request of requests) assignments.set(request.address, request.marketAddress);
  }
  const provider: NodeActivityProvider = async (requests, signal) => {
    throwIfAborted(signal);
    validate(requests);
    const byMarket = new Map<string, string[]>();
    for (const { address, marketAddress } of requests) {
      const addresses = byMarket.get(marketAddress) ?? [];
      addresses.push(address);
      byMarket.set(marketAddress, addresses);
    }
    const result = new Map<string, NodeActivityEvidence>();
    await Promise.all([...byMarket].map(async ([market, addresses]) => {
      const values = await marketRead(market, signal);
      for (const address of addresses) result.set(address, evidence(address, values));
    }));
    return result;
  };
  provider.nextRefreshAt = requests => requests.length
    ? Math.min(...requests.map(({ marketAddress }) => marketEvidence.get(marketAddress)?.nextAttemptAt ?? now())) : null;
  provider.watch = (requests, signal, onUpdate) => {
    try { validate(requests); } catch (error) { return Promise.reject(error); }
    return watch.watch([...new Set(requests.map(request => request.marketAddress))], signal, (market, values) => {
      onUpdate(new Map(requests.filter(request => request.marketAddress === market)
        .map(request => [request.address, evidence(request.address, values)])));
    });
  };
  provider.retention = combineRetention(marketQueueProvider?.retention, {
    markets: hosts => [...hosts].flatMap(address => {
      const market = assignments.get(address);
      return market ? [market] : [];
    }),
    marketRetryAt: market => Math.max(cache.get(`running:${market}`)?.nextAttemptAt ?? 0,
      cache.get(`queued:${market}`)?.nextAttemptAt ?? 0, watch.retryAt(market)),
    prune: ({ hosts, markets, nowMs }) => {
      pruneCacheKeys(hosts, assignments);
      const keepMarkets = new Set(markets);
      for (const market of marketEvidence.keys()) {
        if (watch.isWatching(market) || ["running", "queued"].some(service => {
          const key = `${service}:${market}`;
          return readMembership.isReading(key) || (cache.get(key)?.nextAttemptAt ?? 0) > nowMs;
        })) keepMarkets.add(market);
      }
      const keepKeys = new Set<string>();
      for (const key of new Set([...cache.keys(), ...attempted])) {
        const market = key.slice(key.indexOf(":") + 1);
        if (keepMarkets.has(market) || readMembership.isReading(key) || (cache.get(key)?.nextAttemptAt ?? 0) > nowMs) {
          keepKeys.add(key);
          keepMarkets.add(market);
        }
      }
      pruneCacheKeys(keepKeys, cache, attempted);
      pruneCacheKeys(keepMarkets, marketEvidence);
      watch.prune(keepMarkets);
    },
  });
  return provider;
}

/** Reconcile each completed host before publishing it, without a fleet-wide barrier. */
export function createReconciledNodeInfoProvider({
  nodeInfoProvider, metadataProvider, activityProvider = createNodeActivityProvider(), now = Date.now,
}: {
  nodeInfoProvider: NodeInfoProvider;
  metadataProvider: HostMetadataProvider;
  activityProvider?: NodeActivityProvider;
  now?: () => number;
}): NodeInfoProvider {
  const published = new Map<string, NodeInfoRecord>();
  function remember(record: NodeInfoRecord): void {
    const previous = published.get(record.address);
    const time = record.apiCheck?.checkedAtMs ?? record.fetchedAtMs ?? 0;
    const previousTime = previous?.apiCheck?.checkedAtMs ?? previous?.fetchedAtMs ?? 0;
    if (time >= previousTime) published.set(record.address, structuredClone(record));
  }
  function apiProgress(record: NodeInfoRecord, previous = published.get(record.address)): NodeInfoRecord | undefined {
    const check = record.apiCheck;
    if (record.retained || record.error || record.values?.state !== "OTHER" || check?.status !== "online"
      || !Number.isSafeInteger(check.checkedAtMs) || check.checkedAtMs < 0 || check.checkedAtMs > now()) return undefined;
    // Reachability completes before independent activity reconciliation. Keep
    // the previously published State and all its dates untouched in that interval.
    return { ...(previous ?? { address: record.address, values: null, fetchedAtMs: null,
      validUntilMs: null, retained: false, error: null }), apiCheck: { ...check } };
  }
  async function reconcile(record: NodeInfoRecord, signal?: AbortSignal): Promise<NodeInfoRecord> {
    const result = { ...record, values: record.values ? { ...record.values } : null };
    if (record.retained || record.error || record.values?.state !== "OTHER"
      || record.validUntilMs === null || now() >= record.validUntilMs) return result;
    let marketAddress: string;
    try {
      const metadata = await (metadataProvider.readMetadata ?? metadataProvider)([record.address], signal);
      throwIfAborted(signal);
      const matching = metadata.hosts.filter(host => host.address === record.address);
      const host = matching.length === 1 ? matching[0] : undefined;
      const market = host?.values?.marketAddress;
      if (!host || host.retained || host.error || !isMetadataAddress(market)) {
        return { ...result, activity: unavailable("Nosana activity could not be checked without a current market assignment.") };
      }
      marketAddress = market;
    } catch {
      throwIfAborted(signal);
      return { ...result, activity: unavailable("Nosana activity market lookup failed.") };
    }
    try {
      const evidence = await activityProvider([{ address: record.address, marketAddress }], signal);
      throwIfAborted(signal);
      return { ...result, activity: { ...(evidence.get(record.address)
        ?? unavailable("Nosana activity lookup did not return this Host Address.")) } };
    } catch {
      throwIfAborted(signal);
      return { ...result, activity: unavailable("Nosana activity lookup failed.") };
    }
  }

  const provider: NodeInfoProvider = async (addresses, signal, onUpdate) => {
    throwIfAborted(signal);
    const requested = new Set(addresses);
    const completed = new Map<string, Promise<NodeInfoRecord>>();
    const accept = (snapshot: { hosts: NodeInfoRecord[] }): void => {
      for (const record of snapshot.hosts) {
        if (!requested.has(record.address) || completed.has(record.address)) continue;
        const progress = apiProgress(record);
        if (progress) {
          remember(progress);
          onUpdate?.({ hosts: [structuredClone(progress)] });
        }
        const pending = reconcile(record, signal).then(result => {
          throwIfAborted(signal);
          // In particular, never flash raw OTHER over previously resolved State
          // while the fresh independent membership evidence is still pending.
          remember(result);
          onUpdate?.({ hosts: [structuredClone(result)] });
          return result;
        });
        // Cancellation can settle a dependent read before the raw roster ends.
        void pending.catch(() => {});
        completed.set(record.address, pending);
      }
    };
    const snapshot = await nodeInfoProvider(addresses, signal, accept);
    throwIfAborted(signal);
    accept(snapshot); // Injected providers may support only the final snapshot.
    return { hosts: await Promise.all(snapshot.hosts.map(record => completed.get(record.address)
      ?? Promise.resolve(record))) };
  };
  provider.nextRefreshAt = addresses => nodeInfoProvider.nextRefreshAt?.(addresses) ?? null;
  if (nodeInfoProvider.watch && metadataProvider.watch && activityProvider.watch) {
    provider.watch = (addresses, signal, onUpdate) => {
      if (signal.aborted) return Promise.reject(signal.reason);
      const raw = new Map<string, NodeInfoRecord>();
      const latest = new Map<string, NodeInfoRecord>();
      const proofs = new Map<string, NodeActivityEvidence>();
      const metadataWatches = new Map<string, AbortController>();
      const activityWatches = new Map<string, { marketAddress: string; controller: AbortController }>();
      const requestList = (): NodeActivityRequest[] => [...activityWatches]
        .map(([address, { marketAddress }]) => ({ address, marketAddress }));
      const publish = (record: NodeInfoRecord): void => {
        if (signal.aborted) return;
        latest.set(record.address, record);
        remember(record);
        const deadlines = [nodeInfoProvider.nextRefreshAt?.(addresses), activityProvider.nextRefreshAt?.(requestList())]
          .filter((value): value is number => value !== null && value !== undefined);
        onUpdate({ hosts: [structuredClone(record)], nextRefreshAtMs: deadlines.length ? Math.min(...deadlines) : null });
      };
      const combine = (address: string): void => {
        const record = raw.get(address);
        const activity = proofs.get(address);
        if (record && activity && record.values?.state === "OTHER" && !record.error && !record.retained) {
          publish({ ...record, values: record.values ? { ...record.values } : null, activity: { ...activity } });
        }
      };
      const stopActivity = (address: string): void => {
        const previous = activityWatches.get(address);
        activityWatches.delete(address);
        previous?.controller.abort();
      };
      const acceptRaw = (snapshot: { hosts: NodeInfoRecord[] }): void => {
        for (const record of snapshot.hosts) {
          if (signal.aborted) return;
          raw.set(record.address, record);
          if (record.retained || record.error || record.values?.state !== "OTHER") {
            metadataWatches.get(record.address)?.abort();
            metadataWatches.delete(record.address);
            stopActivity(record.address);
            const previous = latest.get(record.address);
            const historical = record.values?.state === "OTHER" && (record.retained || record.error)
              && previous?.fetchedAtMs === record.fetchedAtMs ? previous.activity : undefined;
            proofs.delete(record.address);
            publish(historical ? { ...record, activity: { ...historical } } : record);
            continue;
          }
          // A reconnect must not replace gray resolved artwork with raw OTHER
          // while a fresh raw read is pending. Its unchanged browser TTL still applies.
          if (record.validUntilMs === null || now() >= record.validUntilMs) continue;
          const progress = apiProgress(record, latest.get(record.address) ?? published.get(record.address));
          if (progress) publish(progress);
          combine(record.address);
          if (metadataWatches.has(record.address)) continue;
          const controller = new AbortController();
          metadataWatches.set(record.address, controller);
          void metadataProvider.watch!([record.address], AbortSignal.any([signal, controller.signal]), metadata => {
            if (signal.aborted || controller.signal.aborted) return;
            const matching = metadata.hosts.filter(host => host.address === record.address);
            const host = matching.length === 1 ? matching[0] : undefined;
            const marketAddress = host?.values?.marketAddress;
            if (!host || host.error || host.retained || !isMetadataAddress(marketAddress)) {
              stopActivity(record.address);
              proofs.set(record.address, unavailable("Nosana activity could not be checked without a current market assignment."));
              combine(record.address);
              return;
            }
            if (activityWatches.get(record.address)?.marketAddress === marketAddress) return;
            stopActivity(record.address);
            proofs.delete(record.address);
            const current = { marketAddress, controller: new AbortController() };
            activityWatches.set(record.address, current);
            void activityProvider.watch!([{ address: record.address, marketAddress }],
              AbortSignal.any([signal, current.controller.signal]), evidence => {
                if (signal.aborted || current.controller.signal.aborted) return;
                proofs.set(record.address, evidence.get(record.address)
                  ?? unavailable("Nosana activity lookup did not return this Host Address."));
                combine(record.address);
              }).catch(() => {});
          }).catch(() => {});
        }
      };
      return nodeInfoProvider.watch!(addresses, signal, acceptRaw);
    };
  }
  provider.retention = combineRetention(nodeInfoProvider.retention, activityProvider.retention, {
    prune: ({ hosts }) => pruneCacheKeys(hosts, published),
  });
  return provider;
}
