/** Opt-in cache maintenance for the changing Online roster. No timers or I/O. */
export interface RetentionScope {
  readonly hosts: ReadonlySet<string>;
  readonly markets: ReadonlySet<string>;
  readonly nowMs: number;
}

export interface ProviderRetention {
  retryAt?: (address: string) => number;
  markets?: (hosts: ReadonlySet<string>) => Iterable<string>;
  marketRetryAt?: (market: string) => number;
  prune: (scope: RetentionScope) => void;
}

export function pruneCacheKeys(keep: ReadonlySet<string>, ...collections: {
  keys(): IterableIterator<string>;
  delete(key: string): unknown;
}[]): void {
  for (const collection of collections) {
    for (const key of collection.keys()) if (!keep.has(key)) collection.delete(key);
  }
}

/** Composite adapters preserve the hooks of their existing provider instances. */
export function combineRetention(...caches: (ProviderRetention | undefined)[]): ProviderRetention {
  const selected = caches.filter((cache): cache is ProviderRetention => cache !== undefined);
  return {
    retryAt: address => Math.max(0, ...selected.map(cache => cache.retryAt?.(address) ?? 0)),
    markets: hosts => new Set(selected.flatMap(cache => [...cache.markets?.(hosts) ?? []])),
    marketRetryAt: market => Math.max(0, ...selected.map(cache => cache.marketRetryAt?.(market) ?? 0)),
    prune: scope => { for (const cache of selected) cache.prune(scope); },
  };
}

export const ONLINE_RETIRED_RETENTION_MS = 60 * 60_000;
export const ONLINE_RETIRED_HOST_LIMIT = 5_000;

/**
 * Fixed inputs and current membership are outside the departed-host capacity. A rejected admission
 * leaves the current roster intact; it never evicts cooldowns to make room.
 * Callers hold every provider read/watch until it settles, including old revisions.
 */
export function createOnlineRetention({ pinned, caches, now = Date.now,
  retentionMs = ONLINE_RETIRED_RETENTION_MS, maximumRetiredHosts = ONLINE_RETIRED_HOST_LIMIT }: {
  pinned: readonly string[];
  caches: () => readonly (ProviderRetention | undefined)[];
  now?: () => number;
  retentionMs?: number;
  maximumRetiredHosts?: number;
}) {
  if (!Number.isSafeInteger(maximumRetiredHosts) || maximumRetiredHosts < 1
    || !Number.isFinite(retentionMs) || retentionMs < 0) throw new Error("Invalid Online cache retention policy.");
  const fixed = new Set(pinned);
  const retiredAt = new Map<string, number | null>();
  const active = new Map<string, number>();
  let current = new Set<string>();

  function prune(): void {
    const time = now();
    const hooks = combineRetention(...caches());
    // A current/fixed/read host already protects its shared markets. Their
    // continually renewed cache deadlines must not pin departed peers forever.
    const protectedMarkets = new Set(hooks.markets?.(new Set([...fixed, ...current, ...active.keys()])) ?? []);
    for (const [address, retired] of retiredAt) {
      if (retired === null || active.has(address) || time < retired + retentionMs) continue;
      const dependencies = hooks.markets?.(new Set([address])) ?? [];
      const deadline = Math.max(hooks.retryAt?.(address) ?? 0,
        ...[...dependencies].filter(market => !protectedMarkets.has(market))
          .map(market => hooks.marketRetryAt?.(market) ?? 0));
      if (time >= deadline) retiredAt.delete(address);
    }
    const hosts = new Set([...fixed, ...retiredAt.keys(), ...active.keys()]);
    const markets = new Set(hooks.markets?.(hosts) ?? []);
    hooks.prune({ hosts, markets, nowMs: time });
  }

  return {
    get size(): number { return retiredAt.size; },
    get retiredSize(): number { return [...retiredAt.values()].filter(value => value !== null).length; },
    prune,
    accept(addresses: readonly string[]): boolean {
      prune();
      const next = new Set(addresses);
      const departed = [...retiredAt.keys()].filter(address => !next.has(address));
      if (departed.length > maximumRetiredHosts) return false;
      const time = now();
      for (const address of current) {
        if (!fixed.has(address) && !next.has(address)) retiredAt.set(address, time);
      }
      for (const address of next) if (!fixed.has(address)) retiredAt.set(address, null);
      current = next;
      return true;
    },
    hold(addresses: readonly string[]): () => void {
      const unique = new Set(addresses);
      for (const address of unique) {
        if (!fixed.has(address) && !retiredAt.has(address)) throw new Error("Online read requires an admitted Host Address.");
      }
      for (const address of unique) active.set(address, (active.get(address) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        for (const address of unique) {
          const remaining = active.get(address)! - 1;
          if (remaining) active.set(address, remaining);
          else active.delete(address);
        }
        prune();
      };
    },
  };
}
