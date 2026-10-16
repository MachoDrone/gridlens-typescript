import { createSharedRead, createRequestLimiter, throwIfAborted } from "./shared-read.ts";
import { createDemandWatch } from "./demand-watch.ts";
import { combineRetention, pruneCacheKeys } from "./online-retention.ts";
import type { ProviderRetention } from "./online-retention.ts";
import { comparePriority, refreshPriority } from "./scheduling-priority.ts";
import type { ActivityPriority } from "./scheduling-priority.ts";
import { isMetadataAddress } from "../src/fleet/host-metadata.ts";
import type { HostMetadataSnapshot } from "../src/fleet/host-metadata.ts";
import type { QueueRecord, QueueSnapshot } from "../src/fleet/queue.ts";
import type { HostMetadataProvider } from "./host-metadata.ts";

const successCacheMs = 15_000;
const displayValidityMs = 30_000;
const failureBackoffMs = 60_000;
const responseByteLimit = 1024 * 1024;

export interface MarketQueueRecord {
  marketAddress: string;
  queueType: 0 | 1 | 255 | null;
  queue: readonly string[] | null;
  checkedAtMs: number | null;
  validUntilMs: number | null;
  sourceUpdatedAtMs: number | null;
  retained: boolean;
  error: string | null;
}
export interface MarketQueueProvider {
  retention?: ProviderRetention;
  (marketAddress: string, signal?: AbortSignal): Promise<MarketQueueRecord>;
  watch?: (markets: readonly string[], signal: AbortSignal, onUpdate: (record: MarketQueueRecord) => void) => Promise<never>;
  nextRefreshAt?: (market: string) => number;
}
/** Progress is emitted as complete currently known market cohorts. */
export interface QueueProvider {
  retention?: ProviderRetention;
  (addresses: readonly string[], signal?: AbortSignal, onUpdate?: (snapshot: QueueSnapshot) => void): Promise<QueueSnapshot>;
  watch?: (addresses: readonly string[], signal: AbortSignal, onUpdate: (snapshot: QueueSnapshot) => void) => Promise<never>;
}
class RequestError extends Error {}
/** A shared provider pause is not a failed attempt for this market. */
class DeferredRequest extends RequestError {}

/** The indexer preserves the on-chain queue's order; validate the entire list. */
export function normalizeMarketQueue(marketAddress: string, payload: unknown): Pick<MarketQueueRecord,
  "marketAddress" | "queueType" | "queue" | "sourceUpdatedAtMs"> {
  if (!isMetadataAddress(marketAddress) || typeof payload !== "object" || payload === null || Array.isArray(payload)
    || !("address" in payload) || payload.address !== marketAddress) {
    throw new RequestError("Nosana queue response did not match the requested market.");
  }
  const value = payload as Record<string, unknown>;
  const { queueType, nodesInQueue, jobsInQueue, queue, updatedAt } = value;
  if ((queueType !== 0 && queueType !== 1 && queueType !== 255)
    || !Number.isSafeInteger(nodesInQueue) || (nodesInQueue as number) < 0
    || !Number.isSafeInteger(jobsInQueue) || (jobsInQueue as number) < 0 || !Array.isArray(queue)) {
    throw new RequestError("Nosana queue response had an invalid queue type or counts.");
  }
  if (queue.some(address => !isMetadataAddress(address)) || new Set(queue).size !== queue.length) {
    throw new RequestError("Nosana queue response contained invalid or duplicate addresses.");
  }
  if ((queueType === 1 && (nodesInQueue !== queue.length || jobsInQueue !== 0))
    || (queueType === 0 && (jobsInQueue !== queue.length || nodesInQueue !== 0))
    || (queueType === 255 && (queue.length !== 0 || nodesInQueue !== 0 || jobsInQueue !== 0))) {
    throw new RequestError("Nosana queue response had conflicting queue counts.");
  }
  if (typeof updatedAt !== "number" || !Number.isSafeInteger(updatedAt) || updatedAt < 0
    || !Number.isSafeInteger(updatedAt * 1000) || updatedAt * 1000 > 8_640_000_000_000_000) {
    throw new RequestError("Nosana queue response had an invalid indexer processing time.");
  }
  return { marketAddress, queueType, queue: [...queue], sourceUpdatedAtMs: updatedAt * 1000 };
}

/** One memory-only cache per market, shared by position and State membership. */
export function createMarketQueueProvider({ fetch: fetcher = globalThis.fetch, now = Date.now, timeoutMs = 8_000,
  activityPriority = () => 2 }: {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  timeoutMs?: number;
  activityPriority?: ActivityPriority;
} = {}): MarketQueueProvider {
  const cache = new Map<string, { record: MarketQueueRecord; nextAttemptAt: number }>();
  const attempted = new Set<string>();
  const readMarket = createSharedRead<string, MarketQueueRecord>();
  const limited = createRequestLimiter(2);
  let pauseUntil = 0;
  const priority = (market: string): readonly number[] => refreshPriority(attempted.has(market),
    cache.get(market)?.record.validUntilMs ?? null, cache.get(market)?.nextAttemptAt ?? 0,
    activityPriority(market, now()), now());

  function noteRateLimit(response: Response): void {
    const retry = response.headers.get("retry-after")?.trim();
    const seconds = retry && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) : NaN;
    const date = retry && !Number.isFinite(seconds) ? Date.parse(retry) : NaN;
    const until = Number.isFinite(seconds) ? now() + seconds * 1000 : date;
    pauseUntil = Math.max(pauseUntil, now() + failureBackoffMs, Number.isFinite(until) ? until : 0);
  }

  async function json(market: string, signal: AbortSignal): Promise<unknown> {
    return limited(async () => {
      if (now() < pauseUntil) throw new DeferredRequest("Nosana queue requests are paused after rate limiting.");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetcher(`https://blockchain-indexer.k8s.prd.nos.ci/markets/${market}`, {
          method: "GET", headers: { Accept: "application/json" }, credentials: "omit", redirect: "error",
          signal: AbortSignal.any([signal, controller.signal]),
        });
        throwIfAborted(signal);
        if (!response.ok) {
          if (response.status === 429 || response.headers.has("retry-after")) noteRateLimit(response);
          void response.body?.cancel().catch(() => {});
          throw new RequestError(`Nosana queue request failed (HTTP ${response.status}).`);
        }
        if (Number(response.headers.get("content-length")) > responseByteLimit) {
          void response.body?.cancel().catch(() => {});
          throw new RequestError("Nosana queue response exceeded the size limit.");
        }
        const reader = response.body?.getReader();
        if (!reader) throw new RequestError("Nosana queue response did not contain valid JSON.");
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
              throw new RequestError("Nosana queue response exceeded the size limit.");
            }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { throw new RequestError("Nosana queue response did not contain valid JSON."); }
      } catch (error) {
        throwIfAborted(signal);
        if (error instanceof RequestError) throw error;
        throw new RequestError(controller.signal.aborted
          ? "Nosana queue request timed out." : "Nosana queue request could not be completed.");
      } finally {
        clearTimeout(timer);
        if (!signal.aborted) attempted.add(market);
      }
    }, signal, () => priority(market));
  }

  async function read(market: string, signal?: AbortSignal): Promise<MarketQueueRecord> {
    throwIfAborted(signal);
    const cached = cache.get(market);
    if (cached && now() < cached.nextAttemptAt) return cached.record;
    return readMarket(market, async signal => {
      let record: MarketQueueRecord;
      let nextAttemptAt: number;
      try {
        const values = normalizeMarketQueue(market, await json(market, signal));
        const checkedAtMs = now();
        if (values.sourceUpdatedAtMs! > checkedAtMs) {
          throw new RequestError("Nosana queue indexer processing time is in the future.");
        }
        record = { ...values, checkedAtMs, validUntilMs: checkedAtMs + displayValidityMs, retained: false, error: null };
        nextAttemptAt = checkedAtMs + successCacheMs;
      } catch (error) {
        throwIfAborted(signal);
        record = {
          marketAddress: market, queueType: cached?.record.queueType ?? null, queue: cached?.record.queue ?? null,
          checkedAtMs: cached?.record.checkedAtMs ?? null, validUntilMs: cached?.record.validUntilMs ?? null,
          sourceUpdatedAtMs: cached?.record.sourceUpdatedAtMs ?? null, retained: cached?.record.queue !== undefined && cached.record.queue !== null,
          error: error instanceof RequestError ? error.message : "Nosana queue lookup failed.",
        };
        // A finite read or a request queued before another market's 429 may
        // reach dispatch during the shared pause. Leave its cache and attempt
        // history unchanged; restarting a 60s failure delay here would extend
        // recovery beyond the actual Retry-After without an upstream attempt.
        if (error instanceof DeferredRequest) return record;
        nextAttemptAt = Math.max(now() + failureBackoffMs, pauseUntil);
      }
      throwIfAborted(signal);
      cache.set(market, { record, nextAttemptAt });
      watch.publish(market, record);
      return record;
    }, signal);
  }

  const watch = createDemandWatch({
    read, peek: (market: string) => cache.get(market)?.record,
    dueAt: market => Math.max(pauseUntil, cache.get(market)?.nextAttemptAt ?? 0), now,
    compare: (left, right) => comparePriority(priority(left), priority(right)),
  });
  const provider: MarketQueueProvider = async (market, signal) => {
    throwIfAborted(signal);
    if (!isMetadataAddress(market)) throw new Error("Queue input must contain a validated market address.");
    const record = await read(market, signal);
    return { ...record, queue: record.queue ? [...record.queue] : null };
  };
  provider.nextRefreshAt = market => Math.max(pauseUntil, cache.get(market)?.nextAttemptAt ?? now());
  provider.watch = (markets, signal, onUpdate) => {
    if (markets.some(market => !isMetadataAddress(market)) || new Set(markets).size !== markets.length) {
      return Promise.reject(new Error("Queue input must contain unique validated market addresses."));
    }
    return watch.watch(markets, signal, (_market, record) => onUpdate(structuredClone(record)));
  };
  provider.retention = {
    marketRetryAt: market => Math.max(cache.get(market)?.nextAttemptAt ?? 0, watch.retryAt(market)),
    prune: ({ markets, nowMs }) => {
      const keep = new Set(markets);
      for (const market of new Set([...cache.keys(), ...attempted])) {
        if ((cache.get(market)?.nextAttemptAt ?? 0) > nowMs || readMarket.isReading(market)
          || watch.isWatching(market)) keep.add(market);
      }
      pruneCacheKeys(keep, cache, attempted);
      watch.prune(keep);
    },
  };
  return provider;
}

/** Join only the startup host's current reported market with its exact ordered membership. */
export function createQueueProvider({ metadataProvider, marketQueueProvider = createMarketQueueProvider(), now = Date.now }: {
  metadataProvider: HostMetadataProvider;
  marketQueueProvider?: MarketQueueProvider;
  now?: () => number;
}): QueueProvider {
  const previous = new Map<string, QueueRecord>();
  function failed(address: string, marketAddress: string | null, error: string): QueueRecord {
    const old = previous.get(address);
    if (old && (marketAddress === null || old.marketAddress === marketAddress)) {
      return { ...old, retained: old.checkedAtMs !== null, error };
    }
    const record: QueueRecord = { address, marketAddress, position: null, total: null, checkedAtMs: null,
      validUntilMs: null, sourceUpdatedAtMs: null, retained: false, error };
    previous.set(address, record);
    return { ...record };
  }
  function position(address: string, marketAddress: string, market: MarketQueueRecord | null): QueueRecord {
    if (!market) return failed(address, marketAddress, "Nosana queue lookup failed.");
    if (market.marketAddress !== marketAddress) return failed(address, marketAddress, "Nosana queue market identity did not match.");
    if (market.error || market.retained || market.queue === null || market.checkedAtMs === null
      || market.validUntilMs === null || now() >= market.validUntilMs) {
      return failed(address, marketAddress, market.error ?? "Nosana queue evidence is unavailable or expired.");
    }
    const index = market.queueType === 1 ? market.queue.indexOf(address) : -1;
    const record: QueueRecord = { address, marketAddress, position: index < 0 ? null : index + 1,
      total: market.queueType === 1 ? market.queue.length : 0, checkedAtMs: market.checkedAtMs,
      validUntilMs: market.validUntilMs, sourceUpdatedAtMs: market.sourceUpdatedAtMs, retained: false, error: null };
    previous.set(address, record);
    return { ...record };
  }
  const provider: QueueProvider = async (addresses, signal, onUpdate) => {
    throwIfAborted(signal);
    if (addresses.some(address => !isMetadataAddress(address)) || new Set(addresses).size !== addresses.length) {
      throw new Error("Queue input must contain unique validated Host Addresses.");
    }
    if (!addresses.length) return { hosts: [] };
    const requested = new Set(addresses);
    const seen = new Set<string>();
    const assignments = new Map<string, string>();
    const records = new Map<string, QueueRecord>();
    const reads = new Map<string, Promise<void>>();
    const markets = new Map<string, MarketQueueRecord | null>();
    const pendingMarkets = new Set<string>();
    const nextMarketReadAt = new Map<string, number>();
    let metadataFailed = false;


    function publishMarket(marketAddress: string): void {
      throwIfAborted(signal);
      if (metadataFailed || !markets.has(marketAddress)) return;
      const cohort: QueueRecord[] = [];
      for (const address of addresses) {
        if (assignments.get(address) === marketAddress) {
          const record = position(address, marketAddress, markets.get(marketAddress)!);
          records.set(address, record);
          cohort.push(record);
        } else if (!seen.has(address) && previous.get(address)?.marketAddress === marketAddress) {
          // Do not show mixed fresh positions from two reads of one queue while
          // another member's refreshed market assignment is still pending.
          cohort.push(failed(address, marketAddress, "Nosana queue is waiting for the current market assignment."));
        }
      }
      if (cohort.length) onUpdate?.({ hosts: cohort.map(record => ({ ...record })) });
    }

    function accept(metadata: HostMetadataSnapshot): void {
      throwIfAborted(signal);
      const changed = new Set<string>();
      for (const address of new Set(metadata.hosts.map(host => host.address))) {
        if (!requested.has(address) || seen.has(address)) continue;
        seen.add(address);
        const matching = metadata.hosts.filter(host => host.address === address);
        const host = matching.length === 1 ? matching[0] : undefined;
        const marketAddress = host?.values?.marketAddress;
        if (!host || host.retained || host.error || !isMetadataAddress(marketAddress)) {
          const record = failed(address, null, "Nosana queue could not be checked without a current market assignment.");
          records.set(address, record);
          onUpdate?.({ hosts: [{ ...record }] });
          continue;
        }
        assignments.set(address, marketAddress);
        if (previous.has(address) && previous.get(address)!.marketAddress !== marketAddress) {
          const record = failed(address, marketAddress, "Nosana queue is waiting for the new market's queue evidence.");
          records.set(address, record);
          onUpdate?.({ hosts: [{ ...record }] });
        }
        changed.add(marketAddress);
      }
      for (const marketAddress of changed) {
        if (markets.has(marketAddress) && now() < nextMarketReadAt.get(marketAddress)!) publishMarket(marketAddress);
        else if (!pendingMarkets.has(marketAddress)) {
          pendingMarkets.add(marketAddress);
          const pending = Promise.resolve().then(() => marketQueueProvider(marketAddress, signal)).then(market => {
            throwIfAborted(signal);
            markets.set(marketAddress, market);
            pendingMarkets.delete(marketAddress);
            // A shared response may already be near its next check. Replaying
            // it cannot renew its cache interval for later metadata arrivals.
            nextMarketReadAt.set(marketAddress, marketQueueProvider.nextRefreshAt?.(marketAddress)
              ?? (market.checkedAtMs === null ? now() : market.checkedAtMs) + successCacheMs);
            publishMarket(marketAddress);
          }, () => {
            throwIfAborted(signal);
            markets.set(marketAddress, null);
            pendingMarkets.delete(marketAddress);
            nextMarketReadAt.set(marketAddress, marketQueueProvider.nextRefreshAt?.(marketAddress)
              ?? now() + successCacheMs);
            publishMarket(marketAddress);
          });
          void pending.catch(() => {});
          reads.set(marketAddress, pending);
        }
      }
    }

    try {
      const metadata = await (metadataProvider.readMetadata ?? metadataProvider)(addresses, signal, accept);
      throwIfAborted(signal);
      accept(metadata); // Compatible with injected providers without progress.
    } catch {
      throwIfAborted(signal);
      metadataFailed = true;
    }
    await Promise.all(reads.values());
    throwIfAborted(signal);
    if (metadataFailed) return { hosts: addresses.map(address => failed(address, null, "Nosana queue market lookup failed.")) };
    return { hosts: addresses.map(address => ({ ...(records.get(address)
      ?? failed(address, null, "Nosana queue could not be checked without a current market assignment.")) })) };
  };
  if (metadataProvider.watch && marketQueueProvider.watch) {
    provider.watch = (addresses, signal, onUpdate) => {
      if (signal.aborted) return Promise.reject(signal.reason);
      if (addresses.some(address => !isMetadataAddress(address)) || new Set(addresses).size !== addresses.length) {
        return Promise.reject(new Error("Queue input must contain unique validated Host Addresses."));
      }
      const requested = new Set(addresses);
      const assignments = new Map<string, string>();
      const markets = new Map<string, MarketQueueRecord>();
      const watching = new Map<string, AbortController>();
      const publish = (hosts: QueueRecord[]): void => {
        if (signal.aborted || !hosts.length) return;
        const deadlines = [...watching.keys()].map(market => marketQueueProvider.nextRefreshAt?.(market) ?? now() + successCacheMs);
        onUpdate({ hosts: structuredClone(hosts), nextRefreshAtMs: deadlines.length ? Math.min(...deadlines) : null });
      };
      const publishMarket = (marketAddress: string): void => {
        const market = markets.get(marketAddress);
        if (!market) return;
        publish(addresses.filter(address => assignments.get(address) === marketAddress)
          .map(address => position(address, marketAddress, market)));
      };
      return metadataProvider.watch!(addresses, signal, metadata => {
        if (signal.aborted) return;
        const changed = new Set<string>();
        for (const address of new Set(metadata.hosts.map(record => record.address))) {
          if (!requested.has(address)) continue;
          const matching = metadata.hosts.filter(record => record.address === address);
          const host = matching.length === 1 ? matching[0] : undefined;
          const marketAddress = host?.values?.marketAddress;
          if (!host || host.error || host.retained || !isMetadataAddress(marketAddress)) {
            assignments.delete(address);
            publish([failed(address, null, "Nosana queue could not be checked without a current market assignment.")]);
          } else {
            // Optional label enrichment and unchanged metadata do not change
            // Queue evidence. Its own market watch owns refresh publication.
            if (assignments.get(address) === marketAddress) continue;
            assignments.set(address, marketAddress);
            if (previous.has(address) && previous.get(address)!.marketAddress !== marketAddress) {
              publish([failed(address, marketAddress, "Nosana queue is waiting for the new market's queue evidence.")]);
            }
            changed.add(marketAddress);
          }
        }
        for (const [marketAddress, controller] of watching) {
          if (![...assignments.values()].includes(marketAddress)) {
            watching.delete(marketAddress);
            markets.delete(marketAddress);
            controller.abort();
          }
        }
        for (const marketAddress of changed) {
          if (watching.has(marketAddress)) { publishMarket(marketAddress); continue; }
          const controller = new AbortController();
          watching.set(marketAddress, controller);
          void marketQueueProvider.watch!([marketAddress], AbortSignal.any([signal, controller.signal]), market => {
            if (signal.aborted || controller.signal.aborted) return;
            markets.set(marketAddress, market);
            publishMarket(marketAddress);
          }).catch(() => {});
        }
      });
    };
  }
  provider.retention = combineRetention(marketQueueProvider.retention, {
    markets: hosts => [...hosts].flatMap(address => {
      const market = previous.get(address)?.marketAddress;
      return market ? [market] : [];
    }),
    prune: ({ hosts }) => pruneCacheKeys(hosts, previous),
  });
  return provider;
}
