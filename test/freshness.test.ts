// Copyright (c) 2026 MachoDrone. MIT license; see LICENSE.
// Inventory freshness and failure-retention behavior.
import assert from "node:assert/strict";
import test from "node:test";
import { projectFleet } from "../src/fleet/freshness.ts";
import type { FleetView, PCInventory, RuntimeView } from "../src/fleet/freshness.ts";
import { NOW, RUNNING, STOPPED, pc, runtime, success } from "./fixtures/inventory.ts";

function runtimeAt(view: FleetView, pcIndex = 0, runtimeIndex = 0): RuntimeView {
  const result = view.pcs[pcIndex]?.runtimes[runtimeIndex];
  assert.ok(result);
  return result;
}

test("fresh running and stopped hosts both count as current inventory", () => {
  const view = projectFleet([pc([runtime(success(NOW, [RUNNING, STOPPED]))])], NOW);
  assert.deepEqual(view.counts, { pcs: 1, currentHosts: 2, retainedHosts: 0 });
  assert.deepEqual(runtimeAt(view).hosts.map((host) => host.currentState), ["running", "stopped"]);
});

test("fresh inventory with unknown container state does not invent running or stopped", () => {
  const view = projectFleet([pc([runtime(success(NOW, [{ ...RUNNING, state: "unknown" }]))])], NOW);
  assert.equal(runtimeAt(view).freshness, "fresh");
  assert.equal(runtimeAt(view).hosts[0]?.observedState, "unknown");
  assert.equal(runtimeAt(view).hosts[0]?.currentState, "unknown");
  assert.equal(view.counts.currentHosts, 1);
});

for (const { offset, expected } of [
  { offset: -89_999, expected: "fresh" },
  { offset: -90_000, expected: "fresh" },
  { offset: -90_001, expected: "stale" },
  { offset: 120_000, expected: "fresh" },
  { offset: 120_001, expected: "stale" },
] as const) {
  test(`source and runtime boundary at ${offset} ms is ${expected}`, () => {
    const at = NOW + offset;
    const view = projectFleet([pc([runtime(success(at))], at)], NOW);
    assert.equal(view.pcs[0]?.sourceFreshness, expected);
    assert.equal(runtimeAt(view).freshness, expected);
    assert.equal(runtimeAt(view).inventoryAgeMs, Math.max(0, -offset));
    assert.equal(view.pcs[0]?.sourceAgeMs, Math.max(0, -offset));
    assert.equal(runtimeAt(view).inventoryObservedAtMs, at);
  });
}

test("an old runtime cannot borrow a fresh PC's time", () => {
  const view = projectFleet([pc([runtime(success(NOW - 90_001))])], NOW);
  assert.equal(view.pcs[0]?.sourceFreshness, "fresh");
  assert.equal(runtimeAt(view).freshness, "stale");
  assert.equal(runtimeAt(view).hosts[0]?.currentState, "unknown");
});

test("a stale source cannot be rescued by a newer runtime timestamp", () => {
  const view = projectFleet([pc([runtime()], NOW - 90_001)], NOW);
  assert.equal(runtimeAt(view).freshness, "stale");
  assert.equal(runtimeAt(view).hosts[0]?.observedState, "running");
  assert.equal(runtimeAt(view).hosts[0]?.currentState, "unknown");
});

test("failure retains the prior inventory and time, including observed stopped state", () => {
  const previous = success(NOW - 30_000, [RUNNING, STOPPED]);
  const view = projectFleet([pc([runtime({
    outcome: "failure", observedAtMs: NOW, error: "fixture probe unavailable",
  }, previous)])], NOW);
  const projected = runtimeAt(view);
  assert.equal(projected.outcome, "failure");
  assert.equal(projected.error, "fixture probe unavailable");
  assert.equal(projected.attemptObservedAtMs, NOW);
  assert.equal(projected.inventoryObservedAtMs, NOW - 30_000);
  assert.equal(projected.inventoryAgeMs, 30_000);
  assert.equal(projected.freshness, "stale");
  assert.deepEqual(projected.hosts.map((host) => host.observedState), ["running", "stopped"]);
  assert.deepEqual(projected.hosts.map((host) => host.currentState), ["unknown", "unknown"]);
  assert.deepEqual(view.counts, { pcs: 1, currentHosts: 0, retainedHosts: 2 });
});

test("first failure is unknown inventory, not successful empty", () => {
  const projected = runtimeAt(projectFleet([pc([runtime({
    outcome: "failure", observedAtMs: NOW, error: "fixture timeout",
  })])], NOW));
  assert.equal(projected.freshness, "unknown");
  assert.equal(projected.outcome, "failure");
  assert.equal(projected.inventoryObservedAtMs, null);
  assert.equal(projected.inventoryAgeMs, null);
  assert.equal(projected.error, "fixture timeout");
  assert.deepEqual(projected.hosts, []);
});

test("successful empty clears only its runtime instead of resurrecting older hosts", () => {
  const previous = success(NOW - 30_000);
  const view = projectFleet([pc([
    runtime(success(NOW, []), previous),
    runtime({ outcome: "failure", observedAtMs: NOW, error: "child failed" }, previous, "podman@fixture-wrapper"),
  ])], NOW);
  assert.deepEqual(runtimeAt(view).hosts, []);
  assert.equal(runtimeAt(view).freshness, "fresh");
  assert.equal(runtimeAt(view).outcome, "success");
  assert.equal(runtimeAt(view).inventoryObservedAtMs, NOW);
  assert.equal(runtimeAt(view, 0, 1).hosts.length, 1);
  assert.equal(runtimeAt(view, 0, 1).freshness, "stale");
  assert.deepEqual(view.counts, { pcs: 1, currentHosts: 0, retainedHosts: 1 });
});

test("later failures preserve a verified empty inventory without reviving hosts", () => {
  const projected = runtimeAt(projectFleet([pc([runtime({
    outcome: "failure", observedAtMs: NOW, error: "failed after empty",
  }, success(NOW - 20_000, []))])], NOW));
  assert.equal(projected.freshness, "stale");
  assert.equal(projected.inventoryObservedAtMs, NOW - 20_000);
  assert.equal(projected.error, "failed after empty");
  assert.deepEqual(projected.hosts, []);
});

for (const failedRuntime of ["docker", "podman@fixture-wrapper"]) {
  test(`failure in ${failedRuntime} does not poison its sibling or a second PC`, () => {
    const runtimes = ["docker", "podman@fixture-wrapper"].map((id) => id === failedRuntime
      ? runtime({ outcome: "failure", observedAtMs: NOW, error: "fixture failure" }, success(NOW - 5_000), id)
      : runtime(success(), null, id));
    const view = projectFleet([pc(runtimes), pc([runtime()], NOW, "fixture-pc-two")], NOW);
    for (const projected of view.pcs[0]?.runtimes ?? []) {
      assert.equal(projected.freshness, projected.runtimeId === failedRuntime ? "stale" : "fresh");
    }
    assert.equal(runtimeAt(view, 1).freshness, "fresh");
    assert.deepEqual(view.counts, { pcs: 2, currentHosts: 2, retainedHosts: 1 });
  });
}

test("a failed child without a wrapper or history remains visible without inventing a parent", () => {
  const view = projectFleet([pc([runtime({
    outcome: "failure", observedAtMs: NOW, error: "no child reading yet",
  }, null, "podman@absent-wrapper")])], NOW);
  assert.equal(view.pcs[0]?.runtimes.length, 1);
  assert.equal(runtimeAt(view).runtimeId, "podman@absent-wrapper");
  assert.equal(runtimeAt(view).error, "no child reading yet");
  assert.equal(runtimeAt(view).freshness, "unknown");
});

test("missing PC/runtime remain distinct from verified empty and leave other PCs fresh", () => {
  const view = projectFleet([pc(), pc([runtime(null)], null, "fixture-missing")], NOW);
  assert.equal(runtimeAt(view).freshness, "fresh");
  assert.equal(view.pcs[1]?.sourceFreshness, "unknown");
  assert.equal(view.pcs[1]?.sourceAgeMs, null);
  assert.equal(runtimeAt(view, 1).outcome, "missing");
  assert.equal(runtimeAt(view, 1).freshness, "unknown");
  assert.deepEqual(view.counts, { pcs: 2, currentHosts: 1, retainedHosts: 0 });
});

test("missing source cannot turn supplied history into current evidence", () => {
  const view = projectFleet([pc([runtime()], null)], NOW);
  assert.equal(runtimeAt(view).freshness, "unknown");
  assert.equal(runtimeAt(view).hosts[0]?.currentState, "unknown");
  assert.equal(view.counts.retainedHosts, 1);
});

test("a missing latest attempt preserves history as stale, without inventing success", () => {
  const view = projectFleet([pc([runtime(null, success())])], NOW);
  assert.equal(runtimeAt(view).outcome, "missing");
  assert.equal(runtimeAt(view).freshness, "stale");
  assert.equal(runtimeAt(view).attemptObservedAtMs, null);
  assert.equal(runtimeAt(view).inventoryObservedAtMs, NOW);
  assert.equal(runtimeAt(view).hosts[0]?.currentState, "unknown");
});

test("container IDs remain scoped to their PC and runtime", () => {
  const view = projectFleet([
    pc([runtime(), runtime(success(), null, "podman@fixture-wrapper")]),
    pc([runtime()], NOW, "fixture-pc-two"),
  ], NOW);
  assert.equal(view.counts.currentHosts, 3);
  assert.deepEqual(view.pcs.map((entry) => entry.pcId), ["fixture-pc", "fixture-pc-two"]);
  assert.equal(runtimeAt(view, 0, 1).hosts[0]?.id, RUNNING.id);
  assert.equal(runtimeAt(view, 1).hosts[0]?.id, RUNNING.id);
});

function deepFreeze(value: unknown): void {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
}

test("repeated views age immutable source evidence without refreshing or mutating it", () => {
  const inventory: readonly PCInventory[] = [pc([runtime(success(NOW, [RUNNING, STOPPED]))])];
  const original = structuredClone(inventory);
  deepFreeze(inventory);
  const first = projectFleet(inventory, NOW);
  const later = projectFleet(inventory, NOW + 90_001);
  assert.equal(runtimeAt(first).freshness, "fresh");
  assert.equal(runtimeAt(later).freshness, "stale");
  assert.equal(later.pcs[0]?.observedAtMs, NOW);
  assert.equal(runtimeAt(later).attemptObservedAtMs, NOW);
  assert.equal(runtimeAt(later).inventoryObservedAtMs, NOW);
  assert.equal(runtimeAt(later).inventoryAgeMs, 90_001);
  assert.deepEqual(runtimeAt(later).hosts.map((host) => host.currentState), ["unknown", "unknown"]);
  assert.deepEqual(inventory, original);
  assert.deepEqual(projectFleet(inventory, NOW), first);
  assert.notEqual(runtimeAt(first).hosts[0], RUNNING);
  assert.notEqual(first.pcs, later.pcs);
});

test("empty fleet has no invented PC or host", () => {
  assert.deepEqual(projectFleet([], NOW), { pcs: [], counts: { pcs: 0, currentHosts: 0, retainedHosts: 0 } });
});

test("invalid internal timestamps fail explicitly instead of claiming freshness", () => {
  for (const invalid of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => projectFleet([], invalid), RangeError);
    assert.throws(() => projectFleet([pc([], invalid)], NOW), RangeError);
    assert.throws(() => projectFleet([pc([runtime(success(invalid))])], NOW), RangeError);
    assert.throws(() => projectFleet([pc([runtime({ outcome: "failure", observedAtMs: invalid, error: "fixture" })])], NOW), RangeError);
    assert.throws(() => projectFleet([pc([runtime(null, success(invalid))])], NOW), RangeError);
  }
});
