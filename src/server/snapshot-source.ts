import type { FleetContext, FleetResource, FleetSnapshots } from "../contracts/fleet.ts";
import type { FleetSnapshotStore } from "./snapshot-store.ts";

/** The product boundary owns neither public-provider construction nor authentication. */
export interface FleetSource {
  read<K extends FleetResource>(resource: K, context: FleetContext, signal: AbortSignal,
    onUpdate?: (snapshot: FleetSnapshots[K]) => void): Promise<FleetSnapshots[K]>;
  watch?<K extends FleetResource>(resource: K, context: FleetContext, signal: AbortSignal,
    onUpdate: (snapshot: FleetSnapshots[K]) => void): Promise<never>;
}
export const SNAPSHOT_CHECK_INTERVALS: Readonly<Record<FleetResource, number>> = {
  metadata: 300_000, "node-info": 15_000, jobs: 120_000, "job-history": 300_000, queue: 15_000,
  sol: 30_000, nos: 120_000, staking: 1_800_000,
};

/** Requests only read/subscribe to committed bulk observations. Ingestion is independent of viewers. */
export function createSnapshotSource(store: FleetSnapshotStore, { now = Date.now }: { now?: () => number } = {}): FleetSource {
  function scheduled<K extends FleetResource>(resource: K, value: FleetSnapshots[K]): FleetSnapshots[K] {
    const snapshot = structuredClone(value);
    if (resource === "metadata") return snapshot;
    const schedule = snapshot as { nextRefreshAtMs?: number | null };
    const time = now();
    // This is a cache recheck, not a new observation or provider dispatch. A
    // stored future budget deadline remains authoritative; expired/null plans
    // need a finite check so later ingestion is visible to finite-only clients.
    if (schedule.nextRefreshAtMs === undefined || schedule.nextRefreshAtMs === null || schedule.nextRefreshAtMs <= time) {
      schedule.nextRefreshAtMs = Math.min(8_640_000_000_000_000, time + SNAPSHOT_CHECK_INTERVALS[resource]);
    }
    return snapshot;
  }
  return {
    async read(resource, context, signal, onUpdate) {
      signal.throwIfAborted();
      const stored = await store.read(context);
      signal.throwIfAborted();
      const snapshot = scheduled(resource, stored.snapshots[resource]);
      if (onUpdate) {
        try { onUpdate(structuredClone(snapshot)); } catch { /* The finite response remains available. */ }
      }
      signal.throwIfAborted();
      return snapshot;
    },
    watch(resource, context, signal, onUpdate) {
      return store.subscribe(context, signal, (stored, changed) => {
        if (changed.includes(resource)) onUpdate(scheduled(resource, stored.snapshots[resource]));
      });
    },
  };
}
