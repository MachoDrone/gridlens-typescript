// Copyright (c) 2026 MachoDrone. MIT license; see LICENSE.
// Internal presentation model only: no wire format, persistence or collection.

export const INVENTORY_FRESH_FOR_MS = 90_000;
export const ALLOWED_FUTURE_SKEW_MS = 120_000;

export type Freshness = "fresh" | "stale" | "unknown";
export type ContainerState = "running" | "stopped" | "unknown";

/** Already-matched host inventory. Raw runtime parsing/matching comes later. */
export interface ObservedHost {
  readonly id: string;
  readonly name: string;
  readonly state: ContainerState;
}

export interface SuccessfulInventory {
  readonly outcome: "success";
  readonly observedAtMs: number;
  readonly hosts: readonly ObservedHost[];
}

export interface FailedInventory {
  readonly outcome: "failure";
  readonly observedAtMs: number;
  readonly error: string;
}

export interface RuntimeInventory {
  /** Native and nested runtime identities are independent, e.g. podman@wrapper. */
  readonly runtimeId: string;
  readonly latest: SuccessfulInventory | FailedInventory | null;
  /** Last accepted success for this exact PC/runtime, supplied by the caller. */
  readonly lastSuccess: SuccessfulInventory | null;
}

export interface PCInventory {
  readonly pcId: string;
  /** Source observation time, never receipt, rendering or browser-poll time. */
  readonly observedAtMs: number | null;
  readonly runtimes: readonly RuntimeInventory[];
}

export interface HostView {
  readonly id: string;
  readonly name: string;
  readonly observedState: ContainerState;
  readonly currentState: ContainerState;
}

export interface RuntimeView {
  readonly runtimeId: string;
  readonly outcome: "success" | "failure" | "missing";
  readonly attemptObservedAtMs: number | null;
  readonly inventoryObservedAtMs: number | null;
  readonly inventoryAgeMs: number | null;
  readonly freshness: Freshness;
  readonly error: string | null;
  readonly hosts: readonly HostView[];
}

export interface PCView {
  readonly pcId: string;
  readonly observedAtMs: number | null;
  readonly sourceAgeMs: number | null;
  readonly sourceFreshness: Freshness;
  readonly runtimes: readonly RuntimeView[];
}

export interface FleetView {
  readonly pcs: readonly PCView[];
  readonly counts: {
    readonly pcs: number;
    /** Fresh inventory, including verified stopped hosts; not running jobs. */
    readonly currentHosts: number;
    readonly retainedHosts: number;
  };
}

function requireTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Timestamps must be non-negative integer milliseconds");
  }
}

function timestampFreshness(at: number | null, nowMs: number): Freshness {
  if (at === null) return "unknown";
  requireTimestamp(at);
  return nowMs - at <= INVENTORY_FRESH_FOR_MS &&
    at - nowMs <= ALLOWED_FUTURE_SKEW_MS
    ? "fresh"
    : "stale";
}

function age(at: number | null, nowMs: number): number | null {
  return at === null ? null : Math.max(0, nowMs - at);
}

function projectRuntime(
  runtime: RuntimeInventory,
  sourceFreshness: Freshness,
  nowMs: number,
): RuntimeView {
  const latest = runtime.latest;
  if (latest !== null) requireTimestamp(latest.observedAtMs);

  // A successful empty list is authoritative. Never fall back based on length.
  const inventory = latest?.outcome === "success" ? latest : runtime.lastSuccess;
  const inventoryObservedAtMs = inventory?.observedAtMs ?? null;
  const inventoryFreshness = timestampFreshness(inventoryObservedAtMs, nowMs);
  const freshness: Freshness = inventory === null || sourceFreshness === "unknown"
    ? "unknown"
    : latest?.outcome === "success" &&
        sourceFreshness === "fresh" && inventoryFreshness === "fresh"
      ? "fresh"
      : "stale";

  return {
    runtimeId: runtime.runtimeId,
    outcome: latest?.outcome ?? "missing",
    attemptObservedAtMs: latest?.observedAtMs ?? null,
    inventoryObservedAtMs,
    inventoryAgeMs: age(inventoryObservedAtMs, nowMs),
    freshness,
    error: latest?.outcome === "failure" ? latest.error : null,
    hosts: (inventory?.hosts ?? []).map((host) => ({
      id: host.id,
      name: host.name,
      observedState: host.state,
      currentState: freshness === "fresh" ? host.state : "unknown",
    })),
  };
}

/**
 * Project normalized, accepted inventory with an explicit clock and no I/O.
 * The caller owns matching, source/generation validation and history selection.
 * Nothing here accepts replicas, verifies signatures, or persists observations.
 */
export function projectFleet(
  inventory: readonly PCInventory[],
  nowMs: number,
): FleetView {
  requireTimestamp(nowMs);
  let currentHosts = 0;
  let retainedHosts = 0;
  const pcs = inventory.map((pc): PCView => {
    const sourceFreshness = timestampFreshness(pc.observedAtMs, nowMs);
    const runtimes = pc.runtimes.map((runtime) => {
      const view = projectRuntime(runtime, sourceFreshness, nowMs);
      if (view.freshness === "fresh") currentHosts += view.hosts.length;
      else retainedHosts += view.hosts.length;
      return view;
    });
    return {
      pcId: pc.pcId,
      observedAtMs: pc.observedAtMs,
      sourceAgeMs: age(pc.observedAtMs, nowMs),
      sourceFreshness,
      runtimes,
    };
  });
  return { pcs, counts: { pcs: pcs.length, currentHosts, retainedHosts } };
}
