import { createSharedOperation, throwIfAborted } from "./shared-read.ts";
import type { SharedOperation } from "./shared-read.ts";

/** Shared work keeps the same last-consumer cancellation rules while delivering
 * completed evidence to current viewers and replaying it to a joining viewer. */
export function createSharedProgressRead<K, T>(merge: (previous: T | undefined, update: T) => T) {
  const pending = new Map<K, {
    operation: SharedOperation<T>;
    listeners: Set<(update: T) => void>;
    latest: T | undefined;
  }>();
  return (key: K, action: (signal: AbortSignal, emit: (update: T) => void) => Promise<T>,
    signal?: AbortSignal, onUpdate?: (update: T) => void): Promise<T> => {
    throwIfAborted(signal);
    let entry = pending.get(key);
    if (!entry) {
      const listeners = new Set<(update: T) => void>();
      const current = {
        listeners, latest: undefined as T | undefined,
        operation: createSharedOperation<T>(workSignal => action(workSignal, update => {
          // Detached/obsolete producers may finish late even after transport abort.
          if (workSignal.aborted) return;
          current.latest = merge(current.latest, update);
          for (const listener of [...listeners]) listener(update);
        }), () => {
          if (pending.get(key) === current) pending.delete(key);
        }),
      };
      entry = current;
      pending.set(key, current);
    }
    const subscribed = entry;
    if (onUpdate) {
      subscribed.listeners.add(onUpdate);
      if (subscribed.latest !== undefined) onUpdate(subscribed.latest);
    }
    return subscribed.operation.read(signal).finally(() => {
      if (onUpdate) subscribed.listeners.delete(onUpdate);
    });
  };
}

export function mergeHostUpdates<T extends { hosts: readonly { address: string }[] }>(previous: T | undefined, update: T): T {
  const hosts = new Map(previous?.hosts.map(host => [host.address, host]));
  for (const host of update.hosts) hosts.set(host.address, host);
  return { ...previous, ...update, hosts: [...hosts.values()] };
}
