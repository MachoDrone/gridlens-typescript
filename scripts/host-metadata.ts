import { createSharedRead, createRequestLimiter, throwIfAborted } from "./shared-read.ts";
import { createDemandWatch } from "./demand-watch.ts";
import { pruneCacheKeys } from "./online-retention.ts";
import type { ProviderRetention } from "./online-retention.ts";
import {
  isMetadataAddress, normalizeHostMetadata, normalizeMarketLabel,
} from "../src/fleet/host-metadata.ts";
import type { HostMetadataRecord, HostMetadataSnapshot } from "../src/fleet/host-metadata.ts";

const origin = "https://host-manager.k8s.prd.nosana.com";
const successCacheMs = 5 * 60_000;
const failureBackoffMs = 60_000;
const marketCacheMs = 60 * 60_000;
const responseByteLimit = 256 * 1024;

/** Metrics publish first; matching market names may follow without changing source times. */
export interface HostMetadataProvider {
  retention?: ProviderRetention;
  (addresses: readonly string[], signal?: AbortSignal, onUpdate?: (snapshot: HostMetadataSnapshot) => void): Promise<HostMetadataSnapshot>;
  /** Assignment consumers need validated metrics, without waiting for a display label. */
  readMetadata?: HostMetadataProvider;
  watch?: (addresses: readonly string[], signal: AbortSignal, onUpdate: (snapshot: HostMetadataSnapshot) => void) => Promise<never>;
}

interface HostCache {
  record: HostMetadataRecord;
  nextAttemptAt: number;
}

interface MarketCache {
  label: string | null;
  error: string | null;
  nextAttemptAt: number;
}

class RequestError extends Error {}

/**
 * Demand-driven, memory-only anonymous adapter. These conservative limits are
 * local policy, not claims about Nosana's quota. Watch timers exist only for active consumers.
 */
export function createHostMetadataProvider({
  fetch: fetcher = globalThis.fetch,
  now = Date.now,
  timeoutMs = 8_000,
}: {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  timeoutMs?: number;
} = {}): HostMetadataProvider {
  const hosts = new Map<string, HostCache>();
  const attempted = new Set<string>();
  const markets = new Map<string, MarketCache>();
  const readHost = createSharedRead<string, HostMetadataRecord>();
  const readMarket = createSharedRead<string, MarketCache>();
  const limited = createRequestLimiter(2);
  let pauseUntil = 0;

  function noteRateLimit(response: Response): void {
    const retry = response.headers.get("retry-after")?.trim();
    const seconds = retry && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) : NaN;
    const date = retry && !Number.isFinite(seconds) ? Date.parse(retry) : NaN;
    const until = Number.isFinite(seconds) ? now() + seconds * 1000 : date;
    pauseUntil = Math.max(pauseUntil, now() + failureBackoffMs, Number.isFinite(until) ? until : 0);
  }

  async function json(path: string, signal: AbortSignal, hostAddress?: string): Promise<unknown> {
    return limited(async () => {
      if (now() < pauseUntil) throw new RequestError("Nosana host-manager requests are paused after rate limiting.");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetcher(origin + path, {
          method: "GET",
          headers: { Accept: "application/json" },
          redirect: "error",
          credentials: "omit",
          signal: AbortSignal.any([signal, controller.signal]),
        });
        throwIfAborted(signal);
        if (!response.ok) {
          if (response.status === 429) noteRateLimit(response);
          void response.body?.cancel().catch(() => {});
          throw new RequestError(`Nosana request failed (HTTP ${response.status}).`);
        }
        const declaredLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > responseByteLimit) {
          void response.body?.cancel().catch(() => {});
          throw new RequestError("Nosana response exceeded the size limit.");
        }
        const reader = response.body?.getReader();
        if (!reader) throw new RequestError("Nosana response did not contain valid JSON.");
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
              throw new RequestError("Nosana response exceeded the size limit.");
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        try {
          return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        } catch {
          throw new RequestError("Nosana response did not contain valid JSON.");
        }
      } catch (error) {
        throwIfAborted(signal);
        if (error instanceof RequestError) throw error;
        throw new RequestError(controller.signal.aborted
          ? "Nosana request timed out." : "Nosana request could not be completed.");
      } finally {
        clearTimeout(timer);
        // A real failed/invalid response finishes this host's first attempt;
        // a provider pause or a canceled viewer never does.
        if (hostAddress && !signal.aborted) attempted.add(hostAddress);
      }
    }, signal, () => hostAddress
      ? [attempted.has(hostAddress) ? 1 : 0, hosts.get(hostAddress)?.nextAttemptAt ?? 0]
      : [2]);
  }

  async function market(address: string, signal?: AbortSignal): Promise<MarketCache> {
    throwIfAborted(signal);
    const cached = markets.get(address);
    if (cached && now() < cached.nextAttemptAt) return cached;
    return readMarket(address, async signal => {
      let result: MarketCache;
      try {
        const label = normalizeMarketLabel(address, await json(`/markets/${address}`, signal));
        result = { label, error: null, nextAttemptAt: now() + marketCacheMs };
      } catch (error) {
        throwIfAborted(signal);
        result = {
          label: cached?.label ?? null,
          error: error instanceof Error ? error.message : "Nosana market lookup failed.",
          nextAttemptAt: Math.max(now() + failureBackoffMs, pauseUntil),
        };
      }
      throwIfAborted(signal);
      markets.set(address, result);
      return result;
    }, signal);
  }

  async function host(address: string, signal?: AbortSignal): Promise<HostMetadataRecord> {
    throwIfAborted(signal);
    return readHost(address, async signal => {
      const cached = hosts.get(address);
      if (cached && now() < cached.nextAttemptAt) return cached.record;
      let result: HostCache;
      try {
        const values = normalizeHostMetadata(address, await json(`/nodes/${address}/metrics`, signal, address));
        const fetchedAtMs = now();
        const lookup = values.marketAddress ? markets.get(values.marketAddress) : null;
        values.marketLabel = lookup?.label ?? null;
        result = {
          record: { address, values, fetchedAtMs, retained: false, error: null, marketError: lookup?.error ?? null },
          nextAttemptAt: fetchedAtMs + successCacheMs,
        };
      } catch (error) {
        throwIfAborted(signal);
        result = {
          record: {
            address,
            values: cached?.record.values ?? null,
            fetchedAtMs: cached?.record.fetchedAtMs ?? null,
            retained: cached?.record.values !== undefined && cached.record.values !== null,
            error: error instanceof Error ? error.message : "Nosana metadata lookup failed.",
            marketError: cached?.record.marketError ?? null,
          },
          nextAttemptAt: Math.max(now() + failureBackoffMs, pauseUntil),
        };
      }
      throwIfAborted(signal);
      hosts.set(address, result);
      watch.publish(address, result.record);
      return result.record;
    }, signal);
  }

  async function enrich(record: HostMetadataRecord, signal?: AbortSignal): Promise<HostMetadataRecord> {
    const cached = hosts.get(record.address);
    const marketAddress = record.values?.marketAddress;
    if (!cached || cached.record !== record || !marketAddress || record.error) return record;
    const lookup = await market(marketAddress, signal);
    throwIfAborted(signal);
    // A label is presentation metadata for precisely this host/market generation.
    // Neither a changed assignment nor a newer metrics read may inherit an old
    // completion, and enrichment never changes the metrics measurement time.
    if (hosts.get(record.address) !== cached) return hosts.get(record.address)!.record;
    if (cached.record.values?.marketLabel !== lookup.label || cached.record.marketError !== lookup.error) {
      cached.record = { ...cached.record, values: { ...cached.record.values!, marketLabel: lookup.label }, marketError: lookup.error };
      watch.publish(record.address, cached.record);
    }
    return cached.record;
  }

  const watch = createDemandWatch({
    read: host, peek: (address: string) => hosts.get(address)?.record,
    dueAt: address => hosts.get(address)?.nextAttemptAt ?? 0, now,
    compare: (left, right) => Number(attempted.has(left)) - Number(attempted.has(right)),
    // The request limiter is the single dispatch boundary. Enqueue every due
    // metrics read there so it can reconsider cold-host priority across viewers
    // before every request, including queued label enrichment.
    concurrency: Number.MAX_SAFE_INTEGER,
  });
  const readMetadata: HostMetadataProvider = async (addresses, signal, onUpdate) => {
    throwIfAborted(signal);
    if (addresses.some(address => !isMetadataAddress(address)) || new Set(addresses).size !== addresses.length) {
      throw new Error("Metadata input must contain unique validated Host Addresses.");
    }
    const records = await Promise.all(addresses.map(async address => {
      const record = await host(address, signal);
      throwIfAborted(signal);
      onUpdate?.({ hosts: [{ ...record, values: record.values ? { ...record.values } : null }] });
      return record;
    }));
    // Callers never receive mutable references to the in-memory cache.
    return { hosts: records.map(record => ({ ...record, values: record.values ? { ...record.values } : null })) };
  };
  const provider: HostMetadataProvider = async (addresses, signal, onUpdate) => {
    const labels = new Map<string, Promise<HostMetadataRecord>>();
    const metadata = await readMetadata(addresses, signal, snapshot => {
      onUpdate?.(structuredClone(snapshot));
      for (const record of snapshot.hosts) {
        // readMetadata returns clones. Capture the matching cache generation
        // while publishing it rather than retaining a mutable response object.
        const current = hosts.get(record.address)?.record ?? record;
        const pending = enrich(current, signal).then(result => {
          throwIfAborted(signal);
          if (result !== current) onUpdate?.({ hosts: [structuredClone(result)] });
          return result;
        });
        void pending.catch(() => {});
        labels.set(record.address, pending);
      }
    });
    const records = await Promise.all(metadata.hosts.map(record => labels.get(record.address)!));
    return { hosts: structuredClone(records) };
  };
  provider.readMetadata = readMetadata;
  provider.watch = (addresses, signal, onUpdate) => {
    if (addresses.some(address => !isMetadataAddress(address)) || new Set(addresses).size !== addresses.length) {
      return Promise.reject(new Error("Metadata input must contain unique validated Host Addresses."));
    }
    return watch.watch(addresses, signal, (_address, record) => {
      onUpdate({ hosts: [structuredClone(record)] });
      // Keep labels under this viewer's demand and shared request cancellation,
      // independently of the host's now-released metadata scheduling slot.
      void enrich(record, signal).catch(() => {});
    });
  };
  provider.retention = {
    retryAt: address => Math.max(hosts.get(address)?.nextAttemptAt ?? 0, watch.retryAt(address)),
    markets: retained => [...retained].flatMap(address => {
      const market = hosts.get(address)?.record.values?.marketAddress;
      return market ? [market] : [];
    }),
    marketRetryAt: market => markets.get(market)?.nextAttemptAt ?? 0,
    prune: ({ hosts: retained, markets: retainedMarkets, nowMs }) => {
      const keep = new Set(retained);
      for (const address of hosts.keys()) if (readHost.isReading(address) || watch.isWatching(address)) keep.add(address);
      pruneCacheKeys(keep, hosts, attempted);
      watch.prune(keep);
      for (const [market, entry] of markets) {
        if (!retainedMarkets.has(market) && !readMarket.isReading(market) && entry.nextAttemptAt <= nowMs) markets.delete(market);
      }
    },
  };
  readMetadata.retention = provider.retention;
  return provider;
}
