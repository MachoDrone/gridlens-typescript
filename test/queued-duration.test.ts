import assert from "node:assert/strict";
import test from "node:test";
import { LiveActivityDisplay } from "../src/fleet/live-activity.ts";
import { projectLiveDuration } from "../src/fleet/live-duration.ts";
import type { JobRecord } from "../src/fleet/jobs.ts";
import type { NodeInfoRecord } from "../src/fleet/node-info.ts";
import { projectQueue } from "../src/fleet/queue.ts";
import type { QueueRecord } from "../src/fleet/queue.ts";
import { normalizeQueuedDurationLayout, projectQueuedDuration } from "../src/fleet/queued-duration.ts";
import { SYNTHETIC_HOST_ADDRESSES } from "./fixtures/host-addresses.ts";

const [address, marketAddress, jobAddress] = SYNTHETIC_HOST_ADDRESSES as [string, string, string];
const nowMs = 1_800_000_000_000;
const queueRecord: QueueRecord = Object.freeze({
  address, marketAddress, position: 2, total: 8,
  checkedAtMs: nowMs, validUntilMs: nowMs + 30_000, sourceUpdatedAtMs: nowMs - 60_000,
  retained: false, error: null,
});
const jobRecord: JobRecord = Object.freeze({
  address, job: Object.freeze({ address: jobAddress, node: address, state: "RUNNING", timeStart: nowMs / 1000 - 120,
    timeEnd: 0, timeout: 600 }),
  checkedAtMs: nowMs, validUntilMs: nowMs + 180_000, failedAtMs: null,
  retained: false, pending: false, retryAtMs: null, error: null,
});
const absentQueue: QueueRecord = { ...queueRecord, position: null, total: 0 };

test("combined layout is independent and opt-in; invalid preferences default to separate", () => {
  assert.equal(normalizeQueuedDurationLayout("combined"), "combined");
  for (const value of [undefined, null, "separate", "", "COMBINED", " combined ", "bar", "text", true, 1, {}, ["combined"]]) {
    assert.equal(normalizeQueuedDurationLayout(value), "separate");
  }
});

test("single useful positions suppress Duration placeholders and redundant arrows", () => {
  const queue = projectQueue(queueRecord, address, marketAddress, nowMs);
  const history = new LiveActivityDisplay();
  const queuedDuration = history.project({ address, marketAddress, queue: queueRecord, nowMs }).duration;
  assert.equal(queuedDuration.kind, "queue");
  for (const duration of [projectLiveDuration(undefined, address, nowMs), queuedDuration,
    projectLiveDuration({ ...jobRecord, job: null }, address, nowMs)]) {
    const view = projectQueuedDuration(queue, duration);
    assert.equal(view.showQueue, true);
    assert.equal(view.showDuration, false);
    assert.equal(view.stacked, false);
    assert.ok(view.description.includes(duration.description));
  }
});

test("single useful timings suppress the running arrow and empty Queue placeholder", () => {
  const duration = projectLiveDuration(jobRecord, address, nowMs);
  const arrow = projectQueue(absentQueue, address, marketAddress, nowMs, { job: jobRecord });
  assert.equal(arrow.kind, "running");
  for (const queue of [arrow, projectQueue(undefined, address, marketAddress, nowMs)]) {
    const view = projectQueuedDuration(queue, duration);
    assert.equal(view.showQueue, false);
    assert.equal(view.showDuration, true);
    assert.equal(view.stacked, false);
    assert.equal(view.durationText, duration.text);
    assert.ok(view.description.includes(queue.description));
  }
});

test("overlaps preserve useful current, retained and conflicting sources independently", () => {
  for (const clock of [nowMs, nowMs + 30_000, nowMs + 180_000]) {
    for (const conflict of [false, true]) {
      const queue = Object.freeze(projectQueue(queueRecord, address, marketAddress, clock, conflict ? { job: jobRecord } : {}));
      const duration = Object.freeze(projectLiveDuration(jobRecord, address, clock));
      const original = structuredClone({ queue, duration });
      const view = projectQueuedDuration(queue, duration);
      assert.equal(view.showQueue, true);
      assert.equal(view.showDuration, true);
      assert.equal(view.stacked, true);
      assert.equal(view.durationText, duration.text);
      assert.deepEqual({ queue, duration }, original);
      assert.ok(view.description.includes(queue.description));
      assert.ok(view.description.includes(duration.description));
    }
  }
  const conflict = projectQueue(queueRecord, address, marketAddress, nowMs, { job: jobRecord });
  assert.equal(conflict.current, false);
  assert.match(conflict.description, /independently checked job/);
});

test("confirmed queued activity without rank becomes Queued without inventing a position", () => {
  const state: NodeInfoRecord = {
    address, values: { state: "QUEUED", dl: null, ul: null, ping: null, networkUnavailableReason: null },
    fetchedAtMs: nowMs, validUntilMs: nowMs + 30_000, retained: false, error: null,
  };
  const duration = new LiveActivityDisplay().project({ address, marketAddress, state, nowMs }).duration;
  assert.equal(duration.kind, "queue");
  const queue = projectQueue(undefined, address, marketAddress, nowMs);
  const view = projectQueuedDuration(queue, duration);
  assert.equal(view.showQueue, false);
  assert.equal(view.showDuration, true);
  assert.equal(view.stacked, false);
  assert.equal(view.durationText, "Queued");
  assert.equal(duration.text, "⟵");
  assert.equal(queue.sortValue, null);
});

test("without useful values Duration retains initial population versus confirmed absence", () => {
  const queue = projectQueue(absentQueue, address, marketAddress, nowMs);
  for (const [record, expected] of [[undefined, "Populating.."], [{ ...jobRecord, job: null }, "—"]] as const) {
    const duration = projectLiveDuration(record, address, nowMs);
    const view = projectQueuedDuration(queue, duration);
    assert.equal(view.showQueue, false);
    assert.equal(view.showDuration, true);
    assert.equal(view.stacked, false);
    assert.equal(view.durationText, expected);
  }
});

test("repeated layout projection preserves source descriptions, timestamps and history", () => {
  const history = new LiveActivityDisplay();
  const input = { address, marketAddress, job: jobRecord, nowMs };
  const activity = history.project(input);
  const duration = Object.freeze(activity.duration);
  const queue = Object.freeze(projectQueue(queueRecord, address, marketAddress, nowMs, { job: activity.eligibleJob }));
  const original = structuredClone({ queueRecord, jobRecord, queue, duration });
  const expected = projectQueuedDuration(queue, duration);
  for (let index = 0; index < 10; index += 1) assert.deepEqual(projectQueuedDuration(queue, duration), expected);
  assert.deepEqual({ queueRecord, jobRecord, queue, duration }, original);
  assert.deepEqual(history.project(input), activity);
  assert.equal(expected.description, `Queued\n${queue.description}\n\nDuration\n${duration.description}`);
  for (const time of [queueRecord.checkedAtMs, queueRecord.sourceUpdatedAtMs, queueRecord.validUntilMs,
    jobRecord.checkedAtMs, jobRecord.validUntilMs]) {
    assert.ok(time !== null);
    assert.ok(expected.description.includes(new Date(time).toISOString()));
  }
});
