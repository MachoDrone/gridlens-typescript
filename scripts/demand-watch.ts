import { throwIfAborted } from "./shared-read.ts";

/** An in-memory due queue that exists only while an HTTP consumer watches it. */
export function createDemandWatch<K, V>({ read, peek, dueAt, compare, canRead, now = Date.now, concurrency = 2 }: {
  read: (key: K, signal: AbortSignal) => Promise<V>;
  peek: (key: K) => V | undefined;
  dueAt: (key: K) => number;
  compare?: (left: K, right: K) => number;
  canRead?: (key: K, pending: readonly K[]) => boolean;
  now?: () => number;
  concurrency?: number;
}): {
  watch(keys: readonly K[], signal: AbortSignal, update: (key: K, value: V) => void): Promise<never>;
  publish(key: K, value: V): void;
  isWatching(key: K): boolean;
  retryAt(key: K): number;
  prune(keep: ReadonlySet<K>): void;
} {
  const viewers = new Set<{ keys: Set<K>; update: (key: K, value: V) => void }>();
  const pending = new Map<K, AbortController>();
  const published = new Map<K, V>();
  const unexpectedRetryAt = new Map<K, number>();
  const insertion = new Map<K, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let insertionSequence = 0;

  function interest(): Set<K> {
    return new Set([...viewers].flatMap(viewer => [...viewer.keys]));
  }

  function publish(key: K, value: V): void {
    if (published.get(key) === value) return;
    published.set(key, value);
    for (const viewer of viewers) if (viewer.keys.has(key)) viewer.update(key, value);
  }

  function pump(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const keys = [...interest()].filter(key => !pending.has(key));
    const eligibleAt = (key: K): number => Math.max(dueAt(key), unexpectedRetryAt.get(key) ?? 0);
    const ready = keys.filter(key => eligibleAt(key) <= now()).sort((left, right) =>
      (compare?.(left, right) ?? 0) || eligibleAt(left) - eligibleAt(right)
      || insertion.get(left)! - insertion.get(right)!);
    while (pending.size < concurrency && ready.length) {
      const index = ready.findIndex(key => canRead?.(key, [...pending.keys()]) ?? true);
      if (index < 0) break;
      const key = ready.splice(index, 1)[0]!;
      const controller = new AbortController();
      pending.set(key, controller);
      void Promise.resolve().then(() => {
        throwIfAborted(controller.signal);
        return read(key, controller.signal);
      }).then(value => {
        if (!controller.signal.aborted) {
          unexpectedRetryAt.delete(key);
          publish(key, value);
        }
      }).catch(() => {
        // Adapters record real failures/backoff. A cancellation is not a failure.
        // A buggy injected adapter must not turn a due deadline into a busy loop.
        if (!controller.signal.aborted) unexpectedRetryAt.set(key, now() + 60_000);
      }).finally(() => {
        if (pending.get(key) !== controller) return;
        pending.delete(key);
        pump();
      });
    }
    if (pending.size < concurrency) {
      const future = keys.filter(key => !pending.has(key) && (canRead?.(key, [...pending.keys()]) ?? true)).map(eligibleAt);
      if (future.length) timer = setTimeout(pump, Math.max(1, Math.min(...future) - now()));
    }
  }

  return {
    publish,
    isWatching: key => [...viewers].some(viewer => viewer.keys.has(key)),
    retryAt: key => unexpectedRetryAt.get(key) ?? 0,
    prune(keep) {
      const watching = interest();
      for (const collection of [published, unexpectedRetryAt, insertion]) {
        for (const key of collection.keys()) {
          if (!keep.has(key) && !watching.has(key) && !pending.has(key)
            && (unexpectedRetryAt.get(key) ?? 0) <= now()) collection.delete(key);
        }
      }
    },
    watch(keys, signal, update) {
      if (signal.aborted) return Promise.reject(signal.reason);
      return new Promise<never>((_resolve, reject) => {
        const viewer = { keys: new Set(keys), update };
        for (const key of keys) if (!insertion.has(key)) insertion.set(key, insertionSequence++);
        const cancel = (): void => {
          viewers.delete(viewer);
          signal.removeEventListener("abort", cancel);
          const remaining = interest();
          for (const [key, controller] of pending) {
            if (!remaining.has(key)) {
              pending.delete(key); // Detach before abort so an immediate resume can read.
              controller.abort();
            }
          }
          pump();
          reject(signal.reason);
        };
        viewers.add(viewer);
        signal.addEventListener("abort", cancel, { once: true });
        for (const key of viewer.keys) {
          const value = peek(key);
          if (value !== undefined) update(key, value);
        }
        pump();
      });
    },
  };
}
