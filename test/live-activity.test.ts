import assert from "node:assert/strict";
import test from "node:test";
import { LiveActivityDisplay } from "../src/fleet/live-activity.ts";
import type { LiveActivityInput } from "../src/fleet/live-activity.ts";
import type { JobRecord } from "../src/fleet/jobs.ts";
import type { NodeInfoRecord } from "../src/fleet/node-info.ts";
import { projectNodeState, projectNodeStateDisplay } from "../src/fleet/node-state.ts";
import type { QueueRecord } from "../src/fleet/queue.ts";
import { SYNTHETIC_HOST_ADDRESSES } from "./fixtures/host-addresses.ts";

const [address, other, jobAddress, replacementAddress, marketAddress] = SYNTHETIC_HOST_ADDRESSES as [string, string, string, string, string];
const now = 1_800_000_000_000;
function job(at = now, changes: Partial<JobRecord> = {}): JobRecord {
  return { address, job: { address: jobAddress, node: address, state: "RUNNING", timeStart: now / 1000 - 120,
    timeEnd: 0, timeout: 600 }, checkedAtMs: at, validUntilMs: at + 180_000, failedAtMs: null,
    retained: false, pending: false, retryAtMs: null, error: null, ...changes };
}
function node(state: string | null = "RUNNING_JOB", at = now, changes: Partial<NodeInfoRecord> = {}): NodeInfoRecord {
  return { address, values: { state, dl: null, ul: null, ping: null, networkUnavailableReason: null },
    fetchedAtMs: at, validUntilMs: at + 30_000, retained: false, error: null, ...changes };
}
function queue(at = now, changes: Partial<QueueRecord> = {}): QueueRecord {
  return { address, marketAddress, position: 1, total: 2, checkedAtMs: at, validUntilMs: at + 30_000,
    sourceUpdatedAtMs: null, retained: false, error: null, ...changes };
}
function project(history: LiveActivityDisplay, input: Partial<LiveActivityInput> = {}) {
  return history.project({ address, marketAddress, nowMs: now, ...input });
}

test("display OTHER and missing evidence are unknown while provider-facing classification is preserved", () => {
  const history = new LiveActivityDisplay();
  for (const state of [undefined, node("OTHER"), node("FUTURE_STATE"), node(null)]) {
    const view = project(history, { state });
    assert.equal(view.state.short, "?");
    assert.equal(view.state.current, null);
    assert.equal(view.state.reported, null);
    assert.equal(view.state.artwork, "unknown");
    assert.equal(view.state.animated, true);
    assert.equal(view.state.source, null);
    assert.equal(view.state.checkedAtMs, null);
    assert.equal(view.state.validUntilMs, null);
    assert.equal(view.state.retained, false);
    assert.equal(view.duration.text, "Populating..");
  }
  assert.equal(projectNodeState(node("OTHER"), now).current, "OTHER");
  assert.equal(projectNodeState(node("RUNNING_JOB"), now + 30_000).animated, false);
});

test("fresh useful explicit and reconciled Node State outrank fresh job fallback", () => {
  for (const value of [node("BENCHMARKING"), node("OTHER", now, {
    activity: { state: "QUEUED", source: "nosana-indexer", checkedAtMs: now, validUntilMs: now + 30_000, error: null },
  })]) {
    const view = project(new LiveActivityDisplay(), { state: value, job: job(now + 1), nowMs: now + 1 });
    assert.equal(view.state.source, "node");
    assert.equal(view.state.current, value.activity?.state ?? value.values!.state);
  }
  for (const state of [undefined, node("OTHER"), node("OTHER", now, {
    activity: { state: null, source: "nosana-indexer", checkedAtMs: now, validUntilMs: now + 30_000, error: "Unknown membership" },
  })]) {
    const view = project(new LiveActivityDisplay(), { state, job: job() });
    assert.equal(view.state.current, "RUNNING_JOB");
    assert.equal(view.state.source, "job");
    assert.equal(view.state.jobAddress, jobAddress);
    assert.equal(view.state.checkedAtMs, now);
    assert.equal(view.state.validUntilMs, now + 180_000);
  }
});

test("each State source keeps its own original deadline, including reconciliation's earliest support", () => {
  const history = new LiveActivityDisplay();
  const input = { state: node(), job: job() };
  assert.equal(project(history, input).state.source, "node");
  assert.equal(project(history, { ...input, nowMs: now + 29_999 }).state.source, "node");
  const fallback = project(history, { ...input, nowMs: now + 30_000 }).state;
  assert.equal(fallback.source, "job");
  assert.equal(fallback.checkedAtMs, now);
  assert.equal(fallback.validUntilMs, now + 180_000);
  assert.equal(project(history, { ...input, nowMs: now + 179_999 }).state.current, "RUNNING_JOB");
  const expired = project(history, { ...input, nowMs: now + 180_000 });
  assert.equal(expired.state.current, null);
  assert.equal(expired.state.retained, true);
  assert.equal(expired.state.animated, true);
  assert.equal(expired.duration.freshness, "retained");
  assert.equal(project(history, { ...input, nowMs: now + 86_400_000 }).duration.elapsedSeconds, 86_520);
  const reconciled = node("OTHER", now, { activity: { state: "RUNNING_JOB", source: "nosana-indexer",
    checkedAtMs: now - 20_000, validUntilMs: now + 10_000, error: null } });
  assert.equal(projectNodeStateDisplay(reconciled, now).validUntilMs, now + 10_000);
  assert.equal(projectNodeStateDisplay(reconciled, now + 10_000).current, null);
});

test("retained State keeps every useful icon and initial with animation independent of freshness", () => {
  for (const [state, artwork] of [["RUNNING_JOB", "running"], ["QUEUED", "queued"], ["RESTARTING", "restarting"],
    ["BENCHMARKING", null], ["HEALTHCHECK", null], ["STARTING", "restarting"], ["JOINING_MARKET", null]] as const) {
    const history = new LiveActivityDisplay();
    project(history, { state: node(state) });
    const expired = project(history, { state: node("OTHER", now + 30_000), nowMs: now + 30_000 }).state;
    assert.equal(expired.reported, state);
    assert.equal(expired.artwork, artwork);
    assert.equal(expired.animated, artwork !== null);
    assert.equal(expired.current, null);
    assert.equal(expired.retained, true);
    assert.equal(expired.checkedAtMs, now);
    assert.match(expired.description, /Retained State estimate/);
  }
});

test("failures and cached replay cannot renew State or timing; newer successful reads restore them", () => {
  const history = new LiveActivityDisplay();
  const state = node();
  const running = job();
  project(history, { state, job: running });
  const failed = project(history, { state: { ...state, retained: true, error: "HTTP 503" },
    job: { ...running, retained: true, error: "HTTP 429", failedAtMs: now + 10_000 }, nowMs: now + 10_000 });
  assert.equal(failed.state.current, null);
  assert.equal(failed.duration.elapsedSeconds, 130);
  const replay = project(history, { state, job: running, nowMs: now + 20_000 });
  assert.equal(replay.state.current, null);
  assert.equal(replay.duration.freshness, "retained");
  assert.equal(replay.duration.elapsedSeconds, 140);
  const recovered = project(history, { state: node("RUNNING_JOB", now + 21_000), job: job(now + 21_000), nowMs: now + 21_000 });
  assert.equal(recovered.state.current, "RUNNING_JOB");
  assert.equal(recovered.duration.freshness, "current");
});

test("missing, deferred and malformed replies preserve the exact last validated job timing", () => {
  const history = new LiveActivityDisplay();
  const running = job();
  const before = structuredClone(running);
  project(history, { job: running });
  for (const next of [undefined, job(now, { job: null, checkedAtMs: null, validUntilMs: null, pending: true }),
    job(now + 1, { job: { ...running.job!, timeStart: null } }),
    job(now + 1, { job: { ...running.job!, timeStart: now / 1000 + 10 } }),
    job(now + 1, { address: other }), job(now + 1, { job: { ...running.job!, node: other } })]) {
    const view = project(history, { job: next, nowMs: now + 60_000 });
    assert.equal(view.duration.elapsedSeconds, 180);
    assert.equal(view.duration.freshness, "retained");
    assert.equal(view.eligibleJob?.job?.address, jobAddress);
  }
  assert.deepEqual(running, before);
});

test("fresh jobs without a valid timeout establish State but never progress or overrun alarms", () => {
  const value = job();
  value.job!.timeout = null;
  const view = project(new LiveActivityDisplay(), { job: value });
  assert.equal(view.state.current, "RUNNING_JOB");
  assert.equal(view.duration.text, "2m");
  assert.equal(view.duration.animated, false);
  assert.equal(view.duration.tone, "unbounded");
});

test("newer queue evidence retires timing and job-backed State permanently until a newer running check", () => {
  const history = new LiveActivityDisplay();
  const running = job();
  project(history, { job: running });
  const queued = project(history, { job: running, queue: queue(now + 10_000), nowMs: now + 10_000 });
  assert.equal(queued.duration.kind, "queue");
  assert.equal(queued.state.short, "?");
  assert.equal(queued.eligibleJob, undefined);
  const expired = project(history, { job: running, nowMs: now + 60_000 });
  assert.equal(expired.duration.text, "Populating..");
  assert.match(expired.duration.description, /current assignment timing is unconfirmed/);
  assert.equal(expired.state.current, null);
  const equal = project(history, { job: job(now + 10_000), nowMs: now + 60_000 });
  assert.equal(equal.duration.kind, "unknown");
  const recovered = project(history, { job: job(now + 60_001), nowMs: now + 60_001 });
  assert.equal(recovered.duration.kind, "duration");
  assert.equal(recovered.state.current, "RUNNING_JOB");
});

test("older, absent, mismatched and failed queue membership never retires a newer job", () => {
  for (const reading of [queue(now - 1), queue(now, { position: null }), queue(now, { address: other }),
    queue(now, { marketAddress: other }), queue(now, { retained: true }), queue(now, { error: "HTTP 429" }),
    queue(now, { validUntilMs: now + 30_001 })]) {
    const view = project(new LiveActivityDisplay(), { job: job(), queue: reading });
    assert.equal(view.duration.kind, "duration");
    assert.equal(view.state.current, "RUNNING_JOB");
  }
});

test("contrary State blocks an equal or older job even after State expires", () => {
  const history = new LiveActivityDisplay();
  project(history, { job: job() });
  const contrary = node("BENCHMARKING", now + 10_000);
  assert.equal(project(history, { job: job(), state: contrary, nowMs: now + 10_000 }).state.current, "BENCHMARKING");
  const expired = project(history, { job: job(), state: contrary, nowMs: now + 90_000 });
  assert.equal(expired.state.reported, "BENCHMARKING");
  assert.equal(expired.state.current, null);
  assert.equal(expired.duration.kind, "duration");
  assert.equal(expired.eligibleJob, undefined);
  assert.equal(expired.durationJob?.job?.address, jobAddress);
  assert.equal(project(history, { job: job(now + 91_000), state: contrary, nowMs: now + 91_000 }).state.current, "RUNNING_JOB");
});

test("explicit queued State retires the counter with an arrow for its original deadline", () => {
  const history = new LiveActivityDisplay();
  project(history, { job: job() });
  const queued = node("QUEUED", now + 10_000);
  const view = project(history, { job: job(), state: queued, nowMs: now + 10_000 });
  assert.equal(view.duration.kind, "queue");
  assert.match(view.duration.description, /No ordered queue rank/);
  assert.equal(project(history, { job: job(), state: queued, nowMs: now + 40_000 }).duration.text, "Populating..");
  assert.equal(project(history, { job: job(), nowMs: now + 50_000 }).duration.kind, "unknown");
});

test("queue failure, absence or market change removes the arrow without reviving old timing", () => {
  for (const change of [
    { queue: queue(now + 10_000, { error: "HTTP 503", retained: true }) },
    { queue: queue(now + 15_000, { position: null }) },
    { queue: queue(now + 10_000), marketAddress: other },
    { queue: queue(now + 10_000), queueError: "Preview disconnected" },
  ]) {
    const history = new LiveActivityDisplay();
    project(history, { job: job() });
    assert.equal(project(history, { queue: queue(now + 10_000), job: job(), nowMs: now + 10_000 }).duration.kind, "queue");
    const view = project(history, { ...change, job: job(), nowMs: now + 15_000 });
    assert.equal(view.duration.text, "Populating..");
    assert.equal(view.eligibleJob, undefined);
  }
});

test("retained State details preserve source identity and include the latest failed refresh", () => {
  const history = new LiveActivityDisplay();
  project(history, { state: node() });
  const stale = project(history, { state: node("OTHER", now + 10_000, { error: "HTTP 503", retained: true }), nowMs: now + 10_000 }).state;
  assert.equal(stale.checkedAtMs, now);
  assert.match(stale.description, /HTTP 503/);
  assert.match(stale.description, /Original State confirmation/);
});

test("completion and successful absence cannot be undone by expired or cached old assignments", () => {
  for (const ended of [job(now + 10_000, { job: null }), job(now + 10_000, { job: null, pending: true }),
    job(now + 10_000, { job: null, error: "Replacement discovery failed", failedAtMs: now + 15_000 }),
    job(now + 10_000, { job: { ...job().job!, state: "COMPLETED" } }),
    job(now + 10_000, { job: { ...job().job!, state: "RUNNING", timeEnd: now / 1000 + 5 } })]) {
    const history = new LiveActivityDisplay();
    project(history, { job: job() });
    const done = project(history, { job: ended, nowMs: now + 10_000 });
    assert.equal(done.duration.text, ended.error === null ? "—" : "Populating..");
    assert.equal(done.state.current, null);
    assert.equal(done.state.reported, null);
    assert.equal(project(history, { job: job(), nowMs: now + 86_400_000 }).duration.kind, "unknown");
  }
});

test("fresh contrary Node proof removes a queue arrow while preserving counter supersession", () => {
  const history = new LiveActivityDisplay();
  project(history, { job: job() });
  const membership = queue(now + 10_000);
  project(history, { queue: membership, job: job(), nowMs: now + 10_000 });
  const view = project(history, { queue: membership, job: job(), state: node("RUNNING_JOB", now + 10_000), nowMs: now + 15_000 });
  assert.equal(view.duration.text, "Populating..");
  assert.equal(view.state.current, "RUNNING_JOB");
  assert.equal(view.eligibleJob, undefined);
  const replay = project(history, { queue: membership, job: job(), nowMs: now + 20_000 });
  assert.equal(replay.duration.text, "Populating..");
  assert.equal(replay.eligibleJob, undefined);
});

test("absence expiry preserves retirement and does not resurrect a cached old counter", () => {
  const history = new LiveActivityDisplay();
  project(history, { job: job() });
  const absent = job(now + 10_000, { job: null });
  assert.equal(project(history, { job: absent, nowMs: now + 10_000 }).duration.text, "—");
  assert.equal(project(history, { job: absent, nowMs: absent.validUntilMs! - 1 }).duration.freshness, "current");
  const expired = project(history, { job: absent, nowMs: absent.validUntilMs! });
  assert.equal(expired.duration.text, "Populating..");
  assert.equal(expired.duration.freshness, "unknown");
  assert.equal(expired.duration.validUntilMs, absent.validUntilMs);
  assert.equal(project(history, { job: job(), nowMs: now + 200_000 }).duration.text, "Populating..");
  const replacement = job(now + 200_001, { job: { ...job().job!, address: replacementAddress } });
  assert.equal(project(history, { job: replacement, nowMs: now + 200_001 }).durationJob?.job?.address, replacementAddress);
});

test("retirement projections expose only their selected original queue or absence deadline", () => {
  for (const retirement of [
    { queue: queue(now + 10_000), deadline: now + 40_000 },
    { state: node("QUEUED", now + 10_000), deadline: now + 40_000 },
    { job: job(now + 10_000, { job: null }), deadline: now + 190_000 },
  ]) {
    const history = new LiveActivityDisplay();
    project(history, { job: job() });
    const { deadline, ...input } = retirement;
    assert.equal(project(history, { ...input, nowMs: now + 10_000 }).duration.validUntilMs, deadline);
    assert.equal(project(history, { job: job(), nowMs: now + 200_000 }).duration.validUntilMs, deadline);
  }
  const missing = project(new LiveActivityDisplay());
  assert.equal(missing.duration.validUntilMs, undefined);
  const malformed = project(new LiveActivityDisplay(), { job: job(now, { job: null, validUntilMs: now + 180_001 }) });
  assert.equal(malformed.duration.validUntilMs, null);
});

test("newer explicit or reconciled running proof invalidates old absence through expiry and cache replay", () => {
  for (const running of [node("RUNNING_JOB", now + 20_000), node("OTHER", now + 20_000, {
    activity: { state: "RUNNING_JOB", source: "nosana-indexer", checkedAtMs: now + 20_000,
      validUntilMs: now + 50_000, error: null },
  })]) {
    const history = new LiveActivityDisplay();
    project(history, { job: job() });
    const absent = job(now + 10_000, { job: null });
    assert.equal(project(history, { job: absent, nowMs: now + 10_000 }).duration.text, "—");
    const view = project(history, { job: absent, state: running, nowMs: now + 20_000 });
    assert.equal(view.duration.text, "Populating..");
    assert.equal(view.durationJob, undefined);
    assert.equal(view.state.current, "RUNNING_JOB");
    for (const state of [undefined, node("OTHER", now + 60_000), node("RUNNING_JOB", now)]) {
      assert.equal(project(history, { job: absent, state, nowMs: now + 60_000 }).duration.text, "Populating..");
    }
    assert.equal(project(history, { job: job(), nowMs: now + 61_000 }).duration.text, "Populating..");
    assert.equal(project(history, { job: job(now + 62_000, { job: null }), nowMs: now + 62_000 }).duration.text, "—");
  }
});

test("invalid running evidence cannot discard a current absence", () => {
  for (const state of [node("RUNNING_JOB", now - 1), node("RUNNING_JOB", now + 10_000, { address: other }),
    node("RUNNING_JOB", now + 10_000, { error: "HTTP 503" }), node("RUNNING_JOB", now + 10_000, { retained: true }),
    node("RUNNING_JOB", now + 10_000, { validUntilMs: null }), node("RUNNING_JOB", now + 30_000)]) {
    const view = project(new LiveActivityDisplay(), { job: job(now, { job: null }), state, nowMs: now + 20_000 });
    assert.equal(view.duration.text, "—");
  }
});

test("failed absence stays unknown through old success replay and recovers only on a newer check", () => {
  const history = new LiveActivityDisplay();
  const absent = job(now, { job: null });
  assert.equal(project(history, { job: absent }).duration.text, "—");
  const failed = { ...absent, error: "HTTP 429", failedAtMs: now + 10_000 };
  assert.equal(project(history, { job: failed, nowMs: now + 10_000 }).duration.text, "Populating..");
  assert.equal(project(history, { job: absent, nowMs: now + 20_000 }).duration.text, "Populating..");
  assert.equal(project(history, { job: job(now + 21_000, { job: null }), nowMs: now + 21_000 }).duration.text, "—");
  assert.equal(project(history, { jobsError: "Preview disconnected", nowMs: now + 22_000 }).duration.text, "Populating..");
  assert.equal(project(history, { job: job(now + 21_000, { job: null }), nowMs: now + 23_000 }).duration.text, "Populating..");
  for (const validUntilMs of [null, now, now + 180_001]) {
    assert.equal(project(new LiveActivityDisplay(), { job: job(now, { job: null, validUntilMs }) }).duration.text, "Populating..");
  }
});

test("malformed contrary Node deadlines cannot retire valid running timing", () => {
  for (const changes of [{ validUntilMs: null }, { validUntilMs: now }, { fetchedAtMs: null }]) {
    const history = new LiveActivityDisplay();
    project(history, { job: job() });
    const view = project(history, { job: job(), state: node("QUEUED", now + 1000, changes), nowMs: now + 1000 });
    assert.equal(view.duration.kind, "duration");
    assert.equal(view.state.current, "RUNNING_JOB");
  }
});

test("replacement preserves new timing through old cache replies and timeout extensions retain identity", () => {
  const history = new LiveActivityDisplay();
  project(history, { job: job() });
  const replacement = job(now + 10_000, { job: { ...job().job!, address: replacementAddress, timeStart: now / 1000 + 5, timeout: 30 } });
  assert.equal(project(history, { job: replacement, nowMs: now + 10_000 }).duration.text, "5s / 30s");
  const replay = project(history, { job: job(), nowMs: now + 20_000 });
  assert.equal(replay.duration.text, "15s / 30s");
  assert.equal(replay.eligibleJob?.job?.address, replacementAddress);
  assert.equal(replay.durationJob?.job?.address, replacementAddress);
  assert.equal(replay.durationJob?.checkedAtMs, now + 10_000);
  assert.equal(replay.duration.freshness, "retained");
  const extended = job(now + 25_000, { job: { ...replacement.job!, timeout: 60 } });
  assert.equal(project(history, { job: extended, nowMs: now + 25_000 }).duration.text, "20s / 1m");
});

test("an expired replacement cannot retain the superseded job-backed State or revive it from cache", () => {
  const history = new LiveActivityDisplay();
  project(history, { job: job() });
  const replacement = job(now + 10_000, { job: { ...job().job!, address: replacementAddress, timeStart: now / 1000 + 5 } });
  const expired = project(history, { job: replacement, nowMs: now + 200_000 });
  assert.equal(expired.duration.freshness, "retained");
  assert.equal(expired.eligibleJob?.job?.address, replacementAddress);
  assert.equal(expired.state.reported, null);
  assert.equal(expired.state.jobAddress, null);
  const replay = project(history, { job: job(), nowMs: now + 201_000 });
  assert.equal(replay.state.short, "?");
  assert.equal(replay.eligibleJob?.job?.address, replacementAddress);
  assert.equal(replay.duration.elapsedSeconds, 196);
});

test("stale overrun keeps red estimate without establishing fresh State", () => {
  const history = new LiveActivityDisplay();
  const running = job();
  running.job!.timeout = 300;
  project(history, { job: running });
  const boundary = project(history, { job: running, nowMs: now + 480_000 });
  assert.equal(boundary.duration.tone, "current");
  const exceeded = project(history, { job: running, nowMs: now + 481_000 });
  assert.equal(exceeded.duration.tone, "exceeded");
  assert.equal(exceeded.duration.freshness, "retained");
  assert.equal(exceeded.state.current, null);
  assert.equal(exceeded.state.checkedAtMs, now);
});

test("history is bounded, prunes only removed identities, and never mutates provider evidence", () => {
  const history = new LiveActivityDisplay(2);
  const first = node();
  const original = structuredClone(first);
  project(history, { state: first });
  history.project({ address: other, nowMs: now, state: { ...node("QUEUED"), address: other } });
  history.prune([address]);
  assert.equal(history.size, 1);
  assert.equal(project(history).state.reported, "RUNNING_JOB");
  history.project({ address: other, nowMs: now });
  history.project({ address: jobAddress, nowMs: now });
  assert.equal(history.size, 2);
  assert.equal(project(history).state.reported, null);
  history.clear();
  assert.equal(history.size, 0);
  assert.deepEqual(first, original);
  assert.throws(() => new LiveActivityDisplay(0), RangeError);
  assert.throws(() => project(history, { nowMs: NaN }), RangeError);
  assert.equal(project(history, { address: "invalid-address", job: job() }).durationJob, undefined);
});
