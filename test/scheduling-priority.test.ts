import assert from "node:assert/strict";
import { test } from "node:test";
import { createSchedulingEvidence, comparePriority, refreshPriority } from "../scripts/scheduling-priority.ts";
import { normalizeHostMetadata } from "../src/fleet/host-metadata.ts";
import type { NodeInfoRecord } from "../src/fleet/node-info.ts";
import type { JobRecord } from "../src/fleet/jobs.ts";

const host = "1".repeat(31) + "2";
const market = "1".repeat(31) + "3";
const nextMarket = "1".repeat(31) + "4";
const jobAddress = "1".repeat(31) + "5";
const base = 1_000_000;
const node = (state: string, time = base): NodeInfoRecord => ({ address: host, values: { state,
  dl: null, ul: null, ping: null, networkUnavailableReason: null }, fetchedAtMs: time,
  validUntilMs: time + 30_000, retained: false, error: null });
const job = (elapsed: number, limit: number, time = base): JobRecord => ({ address: host,
  job: { address: jobAddress, node: host, state: "RUNNING", timeStart: time / 1000 - elapsed,
    timeEnd: 0, timeout: limit }, checkedAtMs: time, validUntilMs: time + 180_000,
  failedAtMs: null, retained: false, pending: false, retryAtMs: null, error: null });

test("refresh ordering puts first attempts then aging proof ahead of fresh transitions and keeps oldest eligibility", () => {
  const cold = refreshPriority(false, null, 0, 2, base);
  const expiring = refreshPriority(true, base + 10_000, 20, 2, base);
  const transition = refreshPriority(true, base + 10_001, 10, 0, base);
  const earlyJob = refreshPriority(true, base + 20_000, 5, 1, base);
  const routine = refreshPriority(true, base + 20_000, 0, 2, base);
  const input = [routine, transition, cold, earlyJob, expiring];
  assert.deepEqual(input.sort(comparePriority), [cold, expiring, transition, earlyJob, routine]);
  assert(comparePriority(refreshPriority(true, base - 1, 2, 2, base),
    refreshPriority(true, base - 1, 3, 0, base)) < 0);
  assert(comparePriority(refreshPriority(true, null, 2, 2, base),
    refreshPriority(true, base - 1, 3, 0, base)) < 0, "due unresolved attempts age ahead of later overdue successes");
});

test("only fresh validated backend transitions influence hints; unresolved artwork and failed evidence cannot", () => {
  let time = base;
  const evidence = createSchedulingEvidence(() => time);
  for (const state of ["STARTING", "RESTARTING", "RUNNING_JOB"]) {
    evidence.observeStates({ hosts: [node(state)] });
    assert.equal(evidence.activityPriority(host, time), 0);
  }
  evidence.observeStates({ hosts: [node("OTHER")] });
  assert.equal(evidence.activityPriority(host, time), 2);
  evidence.observeStates({ hosts: [{ ...node("OTHER"), activity: { state: "RUNNING_JOB", source: "nosana-indexer",
    checkedAtMs: base, validUntilMs: base + 10_000, error: null } }] });
  assert.equal(evidence.activityPriority(host, time), 0);
  time += 10_000;
  assert.equal(evidence.activityPriority(host, time), 2);
  evidence.observeStates({ hosts: [{ ...node("RESTARTING", time), retained: true }] });
  assert.equal(evidence.activityPriority(host, time), 2);
  evidence.observeStates({ hosts: [node("STARTING", time + 1)] });
  assert.equal(evidence.activityPriority(host, time), 2, "future observations cannot grant priority");
});

test("replays and repeated running reports do not restart the new-running window or timestamp evidence", () => {
  let time = base;
  const evidence = createSchedulingEvidence(() => time);
  const first = node("RUNNING_JOB");
  evidence.observeStates({ hosts: [first] });
  for (let second = 15; second <= 120; second += 15) {
    time = base + second * 1000;
    evidence.observeStates({ hosts: [node("RUNNING_JOB", time)] });
  }
  assert.equal(evidence.activityPriority(host, time), 0);
  time++;
  assert.equal(evidence.activityPriority(host, time), 2);
  evidence.observeStates({ hosts: [first] });
  assert.equal(evidence.activityPriority(host, time), 2);
  assert.equal(first.fetchedAtMs, base);
});

test("verified job transition priority uses exact start, limit and grace boundaries with original freshness", () => {
  for (const [elapsed, limit, expected] of [[120, 900, 1], [121, 900, 2], [779, 900, 2],
    [780, 900, 1], [1200, 900, 1], [1201, 900, 2]] as const) {
    let time = base * 10;
    const evidence = createSchedulingEvidence(() => time);
    const record = job(elapsed, limit, time);
    evidence.observeJobs({ hosts: [record] });
    assert.equal(evidence.activityPriority(host, time), expected, `${elapsed}/${limit}`);
    time += 180_000;
    assert.equal(evidence.activityPriority(host, time), 2, "expired job is not a transition hint");
    evidence.observeJobs({ hosts: [record] });
    assert.equal(evidence.activityPriority(host, time), 2, "replay retains its original deadline");
  }
  const evidence = createSchedulingEvidence(() => base);
  evidence.observeStates({ hosts: [node("RUNNING_JOB")] });
  evidence.observeJobs({ hosts: [job(300, 900)] });
  assert.equal(evidence.activityPriority(host, base), 2, "verified routine timing ends missing-timing priority");
  for (const record of [{ ...job(100, 900), retained: true }, { ...job(100, 900), error: "failed" },
    { ...job(100, 900), job: { ...job(100, 900).job!, node: nextMarket } }]) {
    const isolated = createSchedulingEvidence(() => base);
    isolated.observeJobs({ hosts: [record] });
    assert.equal(isolated.activityPriority(host, base), 2);
  }
});

test("market hints follow the validated current assignment and expire without renewing source time", () => {
  let time = base;
  const evidence = createSchedulingEvidence(() => time);
  evidence.observeStates({ hosts: [node("STARTING")] });
  const metadata = (marketAddress: string, fetchedAtMs = base) => ({ address: host,
    values: normalizeHostMetadata(host, { nodeAddress: host, marketAddress }), fetchedAtMs,
    retained: false, error: null, marketError: null });
  evidence.observeMetadata({ hosts: [metadata(market)] });
  assert.equal(evidence.marketPriority(market, time), 0);
  time++;
  evidence.observeMetadata({ hosts: [metadata(nextMarket, time)] });
  evidence.observeMetadata({ hosts: [metadata(market)] });
  assert.equal(evidence.marketPriority(market, time), 2);
  assert.equal(evidence.marketPriority(nextMarket, time), 0);
  time += 300_000;
  evidence.observeStates({ hosts: [node("STARTING", time)] });
  assert.equal(evidence.marketPriority(nextMarket, time), 2);
});

test("a late aggregate success cannot restore a hint invalidated by a newer failed backend check", () => {
  let time = base;
  const evidence = createSchedulingEvidence(() => time);
  const original = { ...node("STARTING"), apiCheck: { status: "online" as const, checkedAtMs: base } };
  evidence.observeStates({ hosts: [original] });
  assert.equal(evidence.activityPriority(host, time), 0);
  time += 15_000;
  evidence.observeStates({ hosts: [{ ...original, retained: true, error: "failed",
    apiCheck: { status: "other", checkedAtMs: time } }] });
  evidence.observeStates({ hosts: [original] });
  assert.equal(evidence.activityPriority(host, time), 2);
  time++;
  evidence.observeStates({ hosts: [{ ...node("STARTING", time),
    apiCheck: { status: "online", checkedAtMs: time } }] });
  assert.equal(evidence.activityPriority(host, time), 0, "actual new success restores priority");

  const originalJob = job(100, 900, time);
  const jobEvidence = createSchedulingEvidence(() => time);
  jobEvidence.observeJobs({ hosts: [originalJob] });
  assert.equal(jobEvidence.activityPriority(host, time), 1);
  time++;
  jobEvidence.observeJobs({ hosts: [{ ...originalJob, retained: true, error: "failed", failedAtMs: time }] });
  jobEvidence.observeJobs({ hosts: [originalJob] });
  assert.equal(jobEvidence.activityPriority(host, time), 2);
});

test("reconciled activity failures retire the original proof but allow a new proof after API-only progress", () => {
  let time = base;
  const evidence = createSchedulingEvidence(() => time);
  const original = { ...node("OTHER"), apiCheck: { status: "online" as const, checkedAtMs: base },
    activity: { state: "RUNNING_JOB" as const, source: "nosana-indexer" as const,
      checkedAtMs: base, validUntilMs: base + 30_000, error: null } };
  evidence.observeStates({ hosts: [original] });
  assert.equal(evidence.activityPriority(host, time), 0);
  time += 15_000;
  evidence.observeStates({ hosts: [{ ...original, activity: { ...original.activity,
    state: null, checkedAtMs: null, validUntilMs: null, error: "unavailable" } }] });
  evidence.observeStates({ hosts: [original] });
  assert.equal(evidence.activityPriority(host, time), 2, "old membership cannot revive after failure");
  evidence.observeStates({ hosts: [{ ...original, activity: { ...original.activity,
    checkedAtMs: time, validUntilMs: time + 30_000 } }] });
  assert.equal(evidence.activityPriority(host, time), 0, "a new proof restores the hint");
  const failed = { ...original, retained: true, error: "raw failure",
    apiCheck: { status: "other" as const, checkedAtMs: time } };
  evidence.observeStates({ hosts: [failed] });
  time++;
  evidence.observeStates({ hosts: [{ ...failed, apiCheck: { status: "online", checkedAtMs: time } }] });
  evidence.observeStates({ hosts: [{ ...node("STARTING", time), apiCheck: { status: "online", checkedAtMs: time } }] });
  assert.equal(evidence.activityPriority(host, time), 0, "API-only progress cannot block the completed State proof");
});
