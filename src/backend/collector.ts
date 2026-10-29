import { createHash } from "node:crypto";
import type { FleetContext, FleetResource, FleetSnapshots } from "../contracts/fleet.ts";
import { FLEET_RESOURCES, isFleetRoster } from "../contracts/fleet.ts";
import { normalizeFleetSnapshot, validateFleetContext } from "../server/snapshot-store.ts";
import { SNAPSHOT_CHECK_INTERVALS } from "../server/snapshot-source.ts";
import type { SharedState } from "./sqlite-state.ts";
import { createProviderCheckpoint } from "../../scripts/provider-checkpoint.ts";
import { createHostMetadataProvider } from "../../scripts/host-metadata.ts";
import { createNodeInfoProvider } from "../../scripts/node-info.ts";
import { createNodeActivityProvider, createReconciledNodeInfoProvider } from "../../scripts/node-activity.ts";
import { createMarketQueueProvider, createQueueProvider } from "../../scripts/market-queue.ts";
import { createJobProvider } from "../../scripts/jobs.ts";
import { createSolanaRpc } from "../../scripts/solana-rpc.ts";
import { createSolProvider } from "../../scripts/sol.ts";
import { createNosProvider } from "../../scripts/nos.ts";
import { createStakingProvider } from "../../scripts/staking.ts";
import { createSchedulingEvidence } from "../../scripts/scheduling-priority.ts";

export interface SharedCollector {
  start(): void;
  stop(): Promise<void>;
  /** An explicit scheduling turn, also used by deterministic isolated tests. */
  tick(): Promise<void>;
  requestHistory(context: FleetContext, addresses: readonly string[], refresh?: boolean): Promise<void>;
  providerWaits(): { provider: string; retryAtMs: number }[];
}
type Read = <R extends FleetResource>(resource: R, addresses: readonly string[], signal: AbortSignal,
  update: (snapshot: FleetSnapshots[R]) => void) => Promise<FleetSnapshots[R]>;

/** The only installed public-reader composition. It runs independently of viewers,
 * reuses the preview's actual readers and persists their private scheduling state.
 * No browser/phone cache read calls this scheduler. History is explicit bounded work. */
export function createSharedCollector({ state, contexts, now = Date.now, fetch: fetcher = globalThis.fetch,
  onError = () => {}, read }: {
  state: SharedState;
  contexts: () => readonly FleetContext[];
  now?: () => number;
  fetch?: typeof globalThis.fetch;
  onError?: (message: string) => void;
  /** Isolated synthetic adapter; never selected by a runtime environment variable. */
  read?: Read;
}): SharedCollector {
  const checkpointNames = ["metadata", "node-info", "activity", "node-reconciled", "markets", "queue", "jobs", "rpc", "sol", "nos", "staking"];
  const checkpoint = (name: string) => createProviderCheckpoint(state, name);
  const scheduling = createSchedulingEvidence(now, checkpoint("scheduling"));
  const metadata = createHostMetadataProvider({ now, fetch: fetcher, checkpoint: checkpoint("metadata") });
  const markets = createMarketQueueProvider({ now, fetch: fetcher, activityPriority: scheduling.marketPriority, checkpoint: checkpoint("markets") });
  const nodes = createReconciledNodeInfoProvider({ now, metadataProvider: metadata,
    nodeInfoProvider: createNodeInfoProvider({ now, fetch: fetcher, activityPriority: scheduling.activityPriority, checkpoint: checkpoint("node-info") }),
    activityProvider: createNodeActivityProvider({ now, fetch: fetcher, marketQueueProvider: markets,
      activityPriority: scheduling.marketPriority, checkpoint: checkpoint("activity") }), checkpoint: checkpoint("node-reconciled") });
  const queue = createQueueProvider({ now, metadataProvider: metadata, marketQueueProvider: markets, checkpoint: checkpoint("queue") });
  const jobs = createJobProvider({ now, fetch: fetcher, activityPriority: scheduling.activityPriority, checkpoint: checkpoint("jobs") });
  const rpc = createSolanaRpc({ now, fetch: fetcher, checkpoint: checkpoint("rpc") });
  const sol = createSolProvider({ rpc, assetCheckpoint: checkpoint("sol") });
  const nos = createNosProvider({ rpc, assetCheckpoint: checkpoint("nos") });
  const staking = createStakingProvider({ rpc, metadataProvider: metadata, assetCheckpoint: checkpoint("staking") });
  const providerRead: Read = async (resource, addresses, signal, update) => {
    const emit = update as (snapshot: FleetSnapshots[FleetResource]) => void;
    switch (resource) {
      case "metadata": return await metadata(addresses, signal, emit) as FleetSnapshots[typeof resource];
      case "node-info": return await nodes(addresses, signal, emit) as FleetSnapshots[typeof resource];
      case "queue": return await queue(addresses, signal, emit) as FleetSnapshots[typeof resource];
      case "jobs": return await jobs(addresses, signal, emit) as FleetSnapshots[typeof resource];
      case "job-history": return jobs.peekHistory!(addresses) as FleetSnapshots[typeof resource];
      case "sol": return await sol(addresses, signal, emit) as FleetSnapshots[typeof resource];
      case "nos": return await nos(addresses, signal) as FleetSnapshots[typeof resource];
      case "staking": return await staking(addresses, signal) as FleetSnapshots[typeof resource];
    }
    throw new Error("Unsupported collection resource.");
  };
  const due = state.get<Record<string, number>>("collector/schedule") ?? {};
  const active = new Map<string, { context: FleetContext; controller: AbortController; task: Promise<void> }>();
  const writes = new Map<string, Promise<void>>();
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const contextKey = (context: FleetContext): string => createHash("sha256").update(JSON.stringify(context)).digest("hex");
  const approved = (context: FleetContext): boolean => contexts().some(value => contextKey(value) === contextKey(context));
  const write = <R extends FleetResource>(context: FleetContext, resource: R, snapshot: FleetSnapshots[R]): Promise<void> => {
    const key = contextKey(context);
    const owned = normalizeFleetSnapshot(resource, snapshot, context.addresses, false);
    const operation = (writes.get(key) ?? Promise.resolve()).then(async () => {
      if (stopped || !approved(context)) return;
      const stored = await state.snapshots.read(context);
      const previous = stored.snapshots[resource];
      const rows = new Map(previous.hosts.map(row => [row.address, row]));
      for (const row of owned.hosts) rows.set(row.address, row);
      const merged = { ...previous, ...owned, hosts: context.addresses.map(address => rows.get(address)!) };
      if (JSON.stringify(previous) !== JSON.stringify(merged)) {
        await state.snapshots.commit(context, { [resource]: merged }, stored.revision);
      }
      if (resource === "metadata") scheduling.observeMetadata(merged as FleetSnapshots["metadata"]);
      if (resource === "node-info") {
        scheduling.observeStates(merged as FleetSnapshots["node-info"]);
        jobs.observeStates?.(merged as FleetSnapshots["node-info"]);
      }
      if (resource === "jobs") scheduling.observeJobs(merged as FleetSnapshots["jobs"]);
    });
    writes.set(key, operation.catch(() => {}));
    return operation;
  };
  const collect = (context: FleetContext, resource: FleetResource): Promise<void> => {
    const key = `${contextKey(context)}/${resource}`;
    const existing = active.get(key); if (existing) return existing.task;
    const controller = new AbortController();
    const task = (async () => {
      let writeFailure: unknown;
      const update = (snapshot: FleetSnapshots[FleetResource]): void => {
        if (controller.signal.aborted) return;
        void write(context, resource, snapshot).catch(error => { writeFailure = error; controller.abort(); });
      };
      try {
        const snapshot = await (read ?? providerRead)(resource, context.addresses, controller.signal, update);
        if (writeFailure) throw writeFailure;
        controller.signal.throwIfAborted();
        await write(context, resource, snapshot);
        const deadline = resource === "node-info" && !read ? nodes.nextRefreshAt?.(context.addresses)
          : "nextRefreshAtMs" in snapshot ? snapshot.nextRefreshAtMs : undefined;
        due[key] = Math.max(now() + 1_000, typeof deadline === "number" ? deadline : now() + SNAPSHOT_CHECK_INTERVALS[resource]);
        state.set("collector/schedule", due);
      } catch {
        if (!controller.signal.aborted || writeFailure) {
          due[key] = now() + 60_000; state.set("collector/schedule", due);
          onError(`Shared ${resource} collection failed; dated observations are retained.`);
        }
      } finally { active.delete(key); }
    })();
    active.set(key, { context, controller, task });
    return task;
  };
  const tick = async (): Promise<void> => {
    if (stopped) return;
    const roster = contexts().map(context => { validateFleetContext(context); return structuredClone(context); });
    const allowed = new Set(roster.map(contextKey));
    for (const current of active.values()) if (!allowed.has(contextKey(current.context))) current.controller.abort();
    const work: Promise<void>[] = [];
    for (const context of roster) {
      for (const resource of FLEET_RESOURCES) {
        if (resource === "job-history") continue;
        const key = `${contextKey(context)}/${resource}`;
        if ((due[key] ?? 0) <= now()) work.push(collect(context, resource));
      }
    }
    await Promise.all(work);
  };
  return {
    tick,
    start() {
      if (stopped || timer) return;
      const turn = () => { void tick().catch(() => onError("Shared collection is unavailable; inspect owner state.")); };
      turn(); timer = setInterval(turn, 1_000); timer.unref();
    },
    async stop() {
      if (stopped) return;
      stopped = true; if (timer) clearInterval(timer);
      for (const current of active.values()) current.controller.abort();
      await Promise.allSettled([...active.values()].map(value => value.task));
      await Promise.allSettled([...writes.values()]);
    },
    async requestHistory(context, addresses, refresh = false) {
      if (stopped || !approved(context) || !isFleetRoster(addresses) || !addresses.length || addresses.length > 100
        || addresses.some(address => !context.addresses.includes(address))) throw new Error("History requires the authorized current roster subset.");
      const key = `${contextKey(context)}/history/${createHash("sha256").update(JSON.stringify(addresses)).digest("hex")}`;
      if (active.has(key)) return active.get(key)!.task;
      if ([...active.keys()].filter(key => key.includes("/history/")).length >= 8) throw new Error("History work is already queued; retry after the current bounded requests.");
      const controller = new AbortController();
      const task = (async () => {
        const snapshot = await jobs.history!(addresses, controller.signal, undefined, refresh);
        controller.signal.throwIfAborted();
        await write(context, "job-history", snapshot);
      })().finally(() => active.delete(key));
      active.set(key, { context, controller, task });
      return task;
    },
    providerWaits() {
      const result: { provider: string; retryAtMs: number }[] = [];
      for (const name of checkpointNames) {
        const value = checkpoint(name).read<unknown>();
        let latest = 0;
        const visit = (entry: unknown, key = ""): void => {
          if (typeof entry === "number" && Number.isSafeInteger(entry) && /^(pauseUntil|retryAtMs)$/.test(key)) latest = Math.max(latest, entry);
          else if (entry instanceof Map) for (const item of entry.values()) visit(item, key);
          else if (Array.isArray(entry)) for (const item of entry) visit(item, key);
          else if (entry && typeof entry === "object") {
            const cached = entry as { record?: { error?: unknown }; error?: unknown; nextAttemptAt?: number; maintenanceAttemptAt?: number };
            if (typeof cached.error === "string" || typeof cached.record?.error === "string") {
              for (const at of [cached.nextAttemptAt, cached.maintenanceAttemptAt]) if (typeof at === "number" && Number.isSafeInteger(at)) latest = Math.max(latest, at);
            }
            for (const [child, item] of Object.entries(entry)) visit(item, key === "pauseUntil" ? key : child);
          }
        };
        visit(value);
        if (value && typeof value === "object") {
          const saved = value as { dispatches?: number[]; discoveryDispatches?: number[] };
          const budgetDeadline = (dispatches: number[] | undefined, limits: readonly (readonly [number, number])[]) => {
            if (!Array.isArray(dispatches)) return;
            for (const [count, window] of limits) {
              const recent = dispatches.filter(at => at > now() - window).sort((a, b) => a - b);
              if (recent.length >= count) latest = Math.max(latest, recent[recent.length - count]! + window);
            }
          };
          if (name === "rpc") budgetDeadline(saved.dispatches, [[1, 1000], [12, 60_000], [600, 3_600_000], [12000, 86_400_000]]);
          if (name === "jobs") {
            budgetDeadline(saved.dispatches, [[16, 30_000], [400, 3_600_000], [2400, 86_400_000]]);
            budgetDeadline(saved.discoveryDispatches, [[10, 30_000], [252, 3_600_000], [675, 86_400_000]]);
          }
        }
        if (latest > now()) result.push({ provider: name, retryAtMs: latest });
      }
      return result;
    },
  };
}
