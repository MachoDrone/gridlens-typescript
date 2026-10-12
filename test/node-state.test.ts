import assert from "node:assert/strict";
import { test } from "node:test";
import { nextStateExpiryDelay, projectNodeState } from "../src/fleet/node-state.ts";
import { NODE_STATES } from "../src/fleet/node-info.ts";
import type { NodeInfoRecord } from "../src/fleet/node-info.ts";
import { statusLabel, statusTone } from "../src/fleet/status-display.ts";

const now = Date.UTC(2026, 0, 1);
function reading(state: string | null): NodeInfoRecord {
  return { address: "synthetic-only", values: { state, dl: null, ul: null, ping: null, networkUnavailableReason: null }, fetchedAtMs: now, validUntilMs: now + 30_000, retained: false, error: null };
}

test("ONBOARDED displays and sorts as COMMUNITY while REJECTED keeps its own label", () => {
  assert.equal(statusLabel("ONBOARDED"), "COMMUNITY");
  assert.equal(statusLabel("community"), "COMMUNITY");
  assert.equal(statusTone("ONBOARDED"), "community");
  assert.equal(statusLabel("REJECTED"), "REJECTED");
  assert.equal(statusTone("REJECTED"), "rejected");
  assert.equal(statusTone("PREMIUM"), "premium");
  assert.equal(statusLabel(null), null);
  assert.equal(statusTone("FUTURE_STATUS"), "unknown");
});

test("all eight reported states stay distinct; STARTING and RESTARTING share spinner artwork", () => {
  const artwork = ["running", "queued", null, null, "restarting", "restarting", null, null];
  for (const [index, state] of NODE_STATES.entries()) {
    const view = projectNodeState(reading(state), now);
    assert.equal(view.current, state);
    assert.equal(view.artwork, artwork[index]);
    assert.equal(view.animated, artwork[index] !== null);
    assert.match(view.description, new RegExp(state));
  }
  assert.equal(projectNodeState(undefined, now).short, "—");
  assert.equal(projectNodeState(reading("OTHER"), now).short, "O");
});

test("failed, retained, expired and future reads never animate or establish current state", () => {
  const record = reading("RUNNING_JOB");
  const before = structuredClone(record);
  for (const input of [
    { ...record, error: "HTTP 429" }, { ...record, retained: true },
    { ...record, fetchedAtMs: now + 1 }, { ...record, fetchedAtMs: null },
    { ...record, validUntilMs: now }, { ...record, validUntilMs: null },
  ]) {
    const result = projectNodeState(input, now);
    assert.equal(result.current, null);
    assert.equal(result.artwork, "running");
    assert.equal(result.animated, false);
    assert.match(result.description, /Current state unknown/);
  }
  assert.equal(projectNodeState(record, now + 29_999).current, "RUNNING_JOB");
  assert.equal(projectNodeState(record, now + 30_000).artwork, "running");
  assert.equal(projectNodeState(record, now + 30_000).animated, false);
  assert.equal(projectNodeState(record, now, "Preview unreachable").current, null);
  assert.equal(projectNodeState({ ...record, validUntilMs: now + 60_000 }, now + 30_000).current, null);
  assert.deepEqual(record, before);
});

test("unknown future state is preserved without being converted to OTHER or a known activity", () => {
  const view = projectNodeState(reading("FUTURE_STATE"), now);
  assert.equal(view.reported, "FUTURE_STATE");
  assert.equal(view.current, null);
  assert.equal(view.artwork, null);
  assert.match(view.description, /Unrecognized/);
});

test("rendering across a validity deadline still schedules immediate expiry of the displayed artwork", () => {
  const record = reading("RUNNING_JOB");
  const projectedAt = now + 29_999;
  assert.equal(projectNodeState(record, projectedAt).artwork, "running");
  assert.equal(nextStateExpiryDelay([record], projectedAt, now + 30_005), 1);
  assert.equal(projectNodeState(record, now + 30_005).artwork, "running");
  assert.equal(projectNodeState(record, now + 30_005).animated, false);
  assert.equal(nextStateExpiryDelay([record], now + 30_005, now + 30_006), null);
});

test("OTHER requires positive independent evidence; empty, failed or conflicting assessments are unknown", () => {
  const record = reading("OTHER");
  record.activity = { source: "nosana-indexer", state: "RUNNING_JOB", checkedAtMs: now, validUntilMs: now + 30_000, error: null };
  const view = projectNodeState(record, now);
  assert.equal(view.current, "RUNNING_JOB");
  assert.equal(view.artwork, "running");
  assert.match(view.description, /Raw Node Info state: OTHER/);
  assert.match(view.description, /indexer/);
  assert.equal(record.values!.state, "OTHER");
  for (const evidence of [
    { ...record.activity, state: null },
    { ...record.activity, state: null, error: "Conflicting membership" },
    { ...record.activity, state: null, error: "HTTP 429" },
    { ...record.activity, checkedAtMs: null },
  ]) {
    const unknown = projectNodeState({ ...record, activity: evidence }, now);
    assert.equal(unknown.current, null);
    assert.equal(unknown.short, "—");
    assert.equal(unknown.artwork, null);
  }
});

test("independent evidence never overrides explicit state or outlives either supporting read", () => {
  const activity = { source: "nosana-indexer" as const, state: "RUNNING_JOB" as const, checkedAtMs: now - 20_000, validUntilMs: now + 10_000, error: null };
  for (const state of ["QUEUED", "BENCHMARKING", "STARTING", "RESTARTING"]) assert.equal(projectNodeState({ ...reading(state), activity }, now).current, state);
  const record = { ...reading("OTHER"), activity };
  assert.equal(nextStateExpiryDelay([record], now, now), 10_001);
  assert.equal(projectNodeState(record, now + 9999).current, "RUNNING_JOB");
  assert.equal(projectNodeState(record, now + 10_000).current, null);
  assert.equal(projectNodeState(record, now + 10_000).artwork, "running");
  assert.equal(projectNodeState(record, now + 10_000).animated, false);
  assert.equal(projectNodeState({ ...record, error: "Node unavailable" }, now).current, null);
  assert.equal(projectNodeState({ ...record, retained: true }, now).current, null);
  assert.equal(projectNodeState({ ...record, validUntilMs: now }, now).current, null);
});

test("expired raw running, queued, starting and restarting readings keep identifiable artwork without motion", () => {
  for (const [state, artwork] of [["RUNNING_JOB", "running"], ["QUEUED", "queued"], ["STARTING", "restarting"], ["RESTARTING", "restarting"]] as const) {
    const expired = projectNodeState(reading(state), now + 30_000);
    assert.equal(expired.current, null);
    assert.equal(expired.artwork, artwork);
    assert.equal(expired.animated, false);
    assert.match(expired.description, /Current state unknown/);
  }
});
