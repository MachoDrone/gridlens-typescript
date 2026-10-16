import assert from "node:assert/strict";
import test from "node:test";
import { isQueueRecord, projectQueue } from "../src/fleet/queue.ts";
import type { QueueRecord } from "../src/fleet/queue.ts";
import type { JobRecord } from "../src/fleet/jobs.ts";
import type { NodeInfoRecord } from "../src/fleet/node-info.ts";
import { SYNTHETIC_HOST_ADDRESSES } from "./fixtures/host-addresses.ts";

const [host, market, other, jobAddress] = SYNTHETIC_HOST_ADDRESSES as [string, string, string, string];
const now = 1_800_000_000_000;
const queued: QueueRecord = {
  address: host, marketAddress: market, position: 2, total: 8,
  checkedAtMs: now, validUntilMs: now + 30_000, sourceUpdatedAtMs: now - 60_000,
  retained: false, error: null,
};
const running: JobRecord = {
  address: host, job: { address: jobAddress, node: host, state: "RUNNING", timeStart: now / 1000 - 120, timeEnd: 0, timeout: 600 },
  checkedAtMs: now, validUntilMs: now + 180_000, failedAtMs: null,
  retained: false, pending: false, retryAtMs: null, error: null,
};
const empty = { ...queued, position: null, total: 0 };
const node = (state: string): NodeInfoRecord => ({
  address: host, values: { state, dl: null, ul: null, ping: null, networkUnavailableReason: null },
  fetchedAtMs: now, validUntilMs: now + 30_000, retained: false, error: null,
});
const project = (record: QueueRecord = queued, clock = now, options: Parameters<typeof projectQueue>[4] = {}) =>
  projectQueue(record, host, market, clock, options);

test("queue shows exact one-based position and total, with source/check times distinct", () => {
  assert.deepEqual({ ...project(), description: undefined }, {
    kind: "position", text: "2/8", current: true, checkCurrent: true, retained: false, sortValue: "2/8", description: undefined,
  });
  assert.match(project().description, /Position 1 is the front/);
  assert.match(project().description, /API checked at/);
  assert.match(project().description, /indexer market updated at/);
  assert.match(project().description, /not a synchronization watermark/);
  assert.match(project().description, /not an estimated wait time/);
});

test("a successful queue update can move a host and change queue size without accumulating positions", () => {
  assert.equal(project({ ...queued, position: 1, total: 3 }).text, "1/3");
  assert.equal(project(empty).kind, "unknown");
  assert.equal(project(empty).sortValue, null);
  assert.match(project(empty).description, /does not establish running or stopped/);
});

test("source update age alone is not treated as a liveness timestamp", () => {
  assert.equal(project({ ...queued, sourceUpdatedAtMs: now - 86_400_000 }).current, true);
  assert.equal(project({ ...queued, sourceUpdatedAtMs: null }).current, true);
  assert.equal(project({ ...queued, sourceUpdatedAtMs: now + 1000 }).current, false);
});

test("host and current market identity must match exactly; a moved market cannot inherit positions", () => {
  for (const record of [{ ...queued, address: other }, { ...queued, marketAddress: other }]) {
    assert.equal(project(record).kind, "unknown");
    assert.equal(project(record).sortValue, null);
  }
  assert.equal(projectQueue(queued, host, other, now).kind, "unknown");
  assert.equal(projectQueue(queued, host, null, now).kind, "unknown");
  assert.equal(projectQueue(undefined, host, market, now).kind, "unknown");
});

test("expiry, unavailable reads and bad local times preserve numbers as unconfirmed history", () => {
  for (const record of [
    { ...queued, retained: true }, { ...queued, error: "Queue read failed." },
    { ...queued, checkedAtMs: null }, { ...queued, checkedAtMs: now + 1 },
    { ...queued, validUntilMs: null }, { ...queued, validUntilMs: now },
    { ...queued, validUntilMs: now + 30_001 },
  ]) {
    const view = project(record);
    assert.equal(view.text, "2/8");
    assert.equal(view.current, false);
    assert.equal(view.retained, true);
    assert.match(view.description, /Current position is unconfirmed/);
  }
  assert.equal(project(queued, now + 29_999).current, true);
  assert.equal(project(queued, now + 30_000).current, false);
  assert.equal(project(queued, now + 86_400_000).text, "2/8");
  assert.equal(project(queued, now, { connectionError: "Disconnected." }).current, false);
});

test("fresh contradictory running jobs or explicit node states cannot establish queue position", () => {
  const conflict = project(queued, now, { job: running });
  assert.equal(conflict.text, "2/8");
  assert.equal(conflict.current, false);
  assert.match(conflict.description, /independently checked job/);
  assert.equal(project(queued, now, { job: { ...running, job: { ...running.job!, timeout: null } } }).current, false);
  for (const state of ["RUNNING_JOB", "BENCHMARKING", "HEALTHCHECK", "RESTARTING", "STARTING", "JOINING_MARKET"]) {
    assert.equal(project(queued, now, { state: node(state) }).current, false, state);
  }
  for (const state of ["OTHER", "QUEUED"]) assert.equal(project(queued, now, { state: node(state) }).current, true);
});

test("unavailable or expired independent readings cannot veto positive current queue proof", () => {
  assert.equal(project(queued, now, { job: { ...running, retained: true, error: "Failed." } }).current, true);
  assert.equal(project(queued, now, { job: { ...running, validUntilMs: now } }).current, true);
  assert.equal(project(queued, now, { state: { ...node("RUNNING_JOB"), retained: true } }).current, true);
  assert.equal(project(queued, now, { state: { ...node("RUNNING_JOB"), address: other } }).current, true);
});

test("newer positive queue proof supersedes older running job or State checks", () => {
  const later = { ...queued, checkedAtMs: now + 1000, validUntilMs: now + 31_000 };
  assert.equal(project(later, now + 1000, { job: running }).current, true);
  assert.equal(project(later, now + 1000, { state: node("RUNNING_JOB") }).current, true);
  assert.equal(project(later, now + 1000, { job: { ...running, checkedAtMs: now + 1000,
    validUntilMs: now + 181_000 } }).current, false);
});

test("a retained red estimate cannot establish running arrows or veto fresh queue proof", () => {
  const staleRed = { ...running, job: { ...running.job!, timeout: 60 }, retained: true, error: "Unavailable." };
  assert.equal(project(queued, now, { job: staleRed }).current, true);
  assert.equal(project(empty, now, { job: staleRed }).kind, "unknown");
  const afterExpiry = now + 181_000;
  const freshQueue = { ...queued, checkedAtMs: afterExpiry, validUntilMs: afterExpiry + 30_000 };
  assert.equal(project(freshQueue, afterExpiry, { job: running }).current, true);
  assert.equal(project({ ...freshQueue, position: null }, afterExpiry, { job: running }).kind, "unknown");
});

test("current nonqueued host with a bounded running job points right to Duration", () => {
  const view = project(empty, now, { job: running });
  assert.equal(view.kind, "running");
  assert.equal(view.text, "⟶");
  assert.equal(view.current, true);
  assert.equal(view.sortValue, null);
  assert.match(view.description, /see the Duration column on the right/);
});

test("running arrows require current nonconflicting queue and job evidence plus positive limit", () => {
  for (const job of [
    { ...running, error: "Failed." }, { ...running, validUntilMs: now },
    { ...running, address: other }, { ...running, job: { ...running.job!, timeout: null } },
    { ...running, job: { ...running.job!, state: "COMPLETED" } },
  ]) assert.equal(project(empty, now, { job }).kind, "unknown");
  for (const record of [{ ...empty, validUntilMs: now }, { ...empty, retained: true }, { ...empty, error: "Failed." }]) {
    assert.equal(project(record, now, { job: running }).kind, "unknown");
  }
  for (const state of ["QUEUED", "HEALTHCHECK"]) {
    assert.equal(project(empty, now, { job: running, state: node(state) }).kind, "unknown");
  }
  assert.equal(project(empty, now, { job: running, connectionError: "Failed." }).kind, "unknown");
});

test("zero positions, impossible counts and malformed preview data fail validation", () => {
  assert.equal(isQueueRecord(queued), true);
  assert.equal(isQueueRecord(empty), true);
  for (const bad of [null, [], {}, { ...queued, position: 0 }, { ...queued, position: 9 },
    { ...queued, position: 1.1 }, { ...queued, total: -1 }, { ...queued, total: null },
    { ...queued, total: Infinity }, { ...queued, marketAddress: null },
    { ...queued, sourceUpdatedAtMs: NaN }, { ...queued, retained: "false" }, { ...queued, error: "x".repeat(1025) }]) {
    assert.equal(isQueueRecord(bad), false);
  }
});

test("projection does not mutate snapshots or renew source times", () => {
  const before = structuredClone(queued);
  assert.equal(project(queued).text, project(queued, now + 10_000).text);
  assert.deepEqual(queued, before);
  for (const clock of [-1, NaN, Infinity, 0.1]) assert.throws(() => project(queued, clock), RangeError);
});

test("fresh confirmed absence remains distinct from an unchecked or expired dash", () => {
  assert.equal(project(empty).text, "—");
  assert.equal(project(empty).checkCurrent, true);
  assert.equal(project(empty, now + 30_000).checkCurrent, false);
  assert.equal(project({ ...empty, error: "Queue unavailable" }).checkCurrent, false);
  assert.equal(projectQueue(undefined, host, market, now).checkCurrent, false);
  assert.equal(project({ ...empty, marketAddress: other }).checkCurrent, false);
  assert.equal(project(queued, now, { job: running }).checkCurrent, true);
  assert.equal(project(queued, now, { job: running }).current, false);
});

test("delivery uncertainty expires queue positions and absence without moving source time or values", () => {
  for (const record of [queued, empty]) {
    const before = structuredClone(record);
    assert.equal(project(record, now, { freshnessAtMs: now + 29_999 }).checkCurrent, true);
    const uncertain = project(record, now, { freshnessAtMs: now + 30_000 });
    assert.equal(uncertain.current, false);
    assert.equal(uncertain.checkCurrent, false);
    assert.equal(uncertain.text, project(record).text);
    assert.match(uncertain.description, /may have expired during delivery/);
    assert.ok(uncertain.description.includes(new Date(record.checkedAtMs!).toISOString()));
    assert.deepEqual(record, before);
  }
  assert.deepEqual(project(queued, now + 30_000, { freshnessAtMs: now }), project(queued, now + 30_000));
});

test("queue running arrows require the job deadline and use only certainly current Node State", () => {
  const shortJob = { ...running, validUntilMs: now + 5_000 };
  assert.equal(project(empty, now, { job: shortJob }).kind, "running");
  assert.equal(project(empty, now, { job: shortJob, freshnessAtMs: now + 5_000 }).kind, "unknown");
  const state = { ...node("QUEUED"), validUntilMs: now + 5_000 };
  const original = structuredClone({ shortJob, state });
  assert.equal(project(empty, now, { job: running, state }).kind, "unknown");
  assert.equal(project(empty, now, { job: running, state, freshnessAtMs: now + 5_000 }).kind, "running");
  assert.deepEqual({ shortJob, state }, original);
});

test("a later freshness bound cannot admit genuinely future queue, job or Node evidence", () => {
  const options = { freshnessAtMs: now + 20_000 };
  const futureQueue = { ...queued, checkedAtMs: now + 1, validUntilMs: now + 30_001 };
  assert.equal(project(futureQueue, now, options).current, false);
  assert.doesNotMatch(project(futureQueue, now, options).description, /may have expired during delivery/);
  const futureJob = { ...running, checkedAtMs: now + 1, validUntilMs: now + 180_001 };
  assert.equal(project(empty, now, { ...options, job: futureJob }).kind, "unknown");
  const futureNode = { ...node("RUNNING_JOB"), fetchedAtMs: now + 1, validUntilMs: now + 30_001 };
  assert.equal(project(queued, now, { ...options, state: futureNode }).current, true);
});
