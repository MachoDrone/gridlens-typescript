import assert from "node:assert/strict";
import { test } from "node:test";
import { hasNewStateReads, nextJobRefreshAt, nextStateRefreshDelay, retainFailedActivity } from "../src/preview/state-refresh.ts";
import { projectNodeState } from "../src/fleet/node-state.ts";
import type { JobRecord } from "../src/fleet/jobs.ts";
import type { NodeInfoRecord } from "../src/fleet/node-info.ts";

const now = Date.UTC(2026, 0, 1);
function record(): NodeInfoRecord {
  return {
    address: "synthetic-node", values: { state: "RUNNING_JOB", dl: null, ul: null, ping: null, networkUnavailableReason: null },
    fetchedAtMs: now, validUntilMs: now + 30_000, retained: false, error: null,
  };
}

test("a newly read state refreshes ahead of expiry without resetting its evidence", () => {
  const row = record();
  const before = structuredClone(row);
  assert.equal(nextStateRefreshDelay([row], now), 20_000);
  assert.equal(nextStateRefreshDelay([row], now + 10_000), 15_000);
  assert.equal(nextStateRefreshDelay([row], now + 27_000), 1_000);
  assert.deepEqual(row, before);
});

test("an earlier supplemental proof deadline determines refresh timing", () => {
  const row = record();
  row.values!.state = "OTHER";
  row.activity = { state: "RUNNING_JOB", source: "nosana-indexer", checkedAtMs: now - 15_000, validUntilMs: now + 15_000, error: null };
  assert.equal(nextStateRefreshDelay([row], now), 10_000);
});

test("observed request duration is allowed for before a healthy row's deadline even when a sibling failed", () => {
  const healthy = record();
  const failed = { ...record(), address: "failed-node", error: "HTTP 503", retained: true };
  assert.equal(nextStateRefreshDelay([healthy, failed], now + 12_000, true, 10_000), 3_000);
  assert.equal(nextStateRefreshDelay([healthy, failed], now + 15_000, true, 10_000), 1_000);
  assert.equal(nextStateRefreshDelay([failed], now + 15_000, true, 10_000), 20_000);
  assert.equal(nextStateRefreshDelay([healthy], now, true, -1), 20_000);
  assert.equal(nextStateRefreshDelay([healthy], now, true, 100_000), 5_000);
  assert.equal(nextStateRefreshDelay([healthy], now, false, 100_000), 20_000);
});

test("unchanged, failed, retained and already-expired readings do not cause tight refresh loops", () => {
  const row = record();
  assert.equal(nextStateRefreshDelay([row], now + 29_000, false), 20_000);
  assert.equal(nextStateRefreshDelay([{ ...row, error: "HTTP 429" }], now + 29_000), 20_000);
  assert.equal(nextStateRefreshDelay([{ ...row, retained: true }], now + 29_000), 20_000);
  assert.equal(nextStateRefreshDelay([row], now + 30_000), 20_000);
  assert.equal(nextStateRefreshDelay([], now), 20_000);
});

test("only changed supporting read timestamps establish progress", () => {
  const row = record();
  const old = new Map([[row.address, row]]);
  assert.equal(hasNewStateReads([{ ...row }], old), false);
  assert.equal(hasNewStateReads([{ ...row, validUntilMs: now + 99_000 }], old), false);
  assert.equal(hasNewStateReads([{ ...row, fetchedAtMs: now + 1 }], old), true);
  assert.equal(hasNewStateReads([{ ...row, fetchedAtMs: null }], old), false);
  const proof = { state: "RUNNING_JOB" as const, source: "nosana-indexer" as const, checkedAtMs: now, validUntilMs: now + 30_000, error: null };
  assert.equal(hasNewStateReads([{ ...row, activity: proof }], old), true);
  assert.equal(hasNewStateReads([{ ...row, activity: proof }], new Map([[row.address, { ...row, activity: proof }]])), false);
  const withProof = new Map([[row.address, { ...row, activity: proof }]]);
  assert.equal(hasNewStateReads([{ ...row, retained: true, error: "HTTP 503" }], withProof), false);
  assert.equal(hasNewStateReads([{ ...row, activity: { ...proof, state: null, checkedAtMs: null, validUntilMs: null, error: "Unavailable" } }], withProof), false);
});

test("failed retained OTHER preserves matching historical artwork without reviving current state", () => {
  const previous = record();
  previous.values!.state = "OTHER";
  previous.activity = { state: "RUNNING_JOB", source: "nosana-indexer", checkedAtMs: now, validUntilMs: now + 30_000, error: null };
  const failed = { ...record(), values: { ...previous.values! }, retained: true, error: "HTTP 503" };
  const before = structuredClone({ previous, failed });
  const restored = retainFailedActivity(failed, previous);
  assert.equal(restored.fetchedAtMs, now);
  assert.equal(restored.activity?.checkedAtMs, now);
  assert.equal(projectNodeState(restored, now + 1).artwork, "running");
  assert.equal(projectNodeState(restored, now + 1).animated, false);
  assert.equal(projectNodeState(restored, now + 1).current, null);
  assert.deepEqual({ previous, failed }, before);
});

test("historical proof never overrides a new reading, identity, explicit state or newer assessment", () => {
  const previous = record();
  previous.values!.state = "OTHER";
  previous.activity = { state: "RUNNING_JOB", source: "nosana-indexer", checkedAtMs: now, validUntilMs: now + 30_000, error: null };
  const failed = { ...record(), values: { ...previous.values! }, retained: true, error: "HTTP 503" };
  for (const next of [
    { ...failed, fetchedAtMs: now + 1 }, { ...failed, fetchedAtMs: null },
    { ...failed, address: "different-node" }, { ...failed, values: { ...failed.values, state: "QUEUED" } },
    { ...failed, retained: false, error: null },
    { ...failed, activity: { ...previous.activity, state: null, error: "No current membership" } },
  ]) assert.equal(retainFailedActivity(next, previous), next);
  assert.equal(retainFailedActivity(failed, undefined), failed);
});

function jobRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  return { address: "synthetic-host", job: { address: "synthetic-job", node: "synthetic-host", state: "RUNNING",
    timeStart: now / 1000, timeEnd: 0, timeout: 600 }, checkedAtMs: now, validUntilMs: now + 180_000,
    failedAtMs: null, retained: false, pending: false, retryAtMs: null, error: null, ...overrides };
}

test("job refresh follows pending budget, known timing and confirmed-empty deadlines without artificial 120s caps", () => {
  const pending = jobRecord({ job: null, checkedAtMs: null, pending: true, retryAtMs: now + 30_000 });
  const before = structuredClone(pending);
  assert.equal(nextJobRefreshAt([pending], now), now + 30_000);
  assert.equal(nextJobRefreshAt([{ ...pending, retryAtMs: now + 3_600_000 }], now), now + 3_600_000);
  assert.equal(nextJobRefreshAt([jobRecord()], now + 5_000), now + 120_000);
  assert.equal(nextJobRefreshAt([jobRecord({ job: null })], now + 5_000), now + 60_000);
  assert.equal(nextJobRefreshAt([pending, jobRecord()], now + 5_000), now + 30_000);
  assert.deepEqual(pending, before);
});

test("old pending deadlines and unchanged overdue snapshots do not create a 1s or immediate retry loop", () => {
  const pending = jobRecord({ pending: true, retryAtMs: now - 1 });
  assert.equal(nextJobRefreshAt([pending], now), now + 30_000);
  assert.equal(nextJobRefreshAt([{ ...pending, retryAtMs: null }], now), now + 30_000);
  assert.equal(nextJobRefreshAt([jobRecord({ checkedAtMs: now - 120_000 })], now), now + 120_000);
  assert.equal(nextJobRefreshAt([jobRecord({ error: "Unavailable" })], now), now + 60_000);
  assert.equal(nextJobRefreshAt([], now), now + 120_000);
});
