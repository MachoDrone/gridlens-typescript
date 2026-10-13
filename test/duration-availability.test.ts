import assert from "node:assert/strict";
import test from "node:test";
import { projectDurationAvailability, projectLiveDuration } from "../src/fleet/live-duration.ts";
import { projectNodeApi } from "../src/fleet/node-api.ts";
import type { NodeInfoRecord } from "../src/fleet/node-info.ts";
import type { JobRecord } from "../src/fleet/jobs.ts";
import { LiveActivityDisplay } from "../src/fleet/live-activity.ts";
import { SYNTHETIC_HOST_ADDRESSES } from "./fixtures/host-addresses.ts";

const [address, jobAddress] = SYNTHETIC_HOST_ADDRESSES as [string, string];
const now = 1_800_000_000_000;
const offline: NodeInfoRecord = Object.freeze({
  address, values: null, fetchedAtMs: null, validUntilMs: null, retained: false, error: "HTTP 503",
  apiCheck: Object.freeze({ status: "offline", checkedAtMs: now, firstFailedAtMs: now - 1000,
    failureKind: "http", httpStatus: 503, nextCheckAtMs: now + 900_000 }),
});
const job: JobRecord = Object.freeze({
  address, job: Object.freeze({ address: jobAddress, node: address, state: "RUNNING",
    timeStart: now / 1000 - 120, timeEnd: 0, timeout: 600 }),
  checkedAtMs: now, validUntilMs: now + 180_000, failedAtMs: null,
  retained: false, pending: false, retryAtMs: null, error: null,
});

test("currently confirmed API Offline substitutes a dash without claiming job absence", () => {
  const duration = Object.freeze(projectLiveDuration(undefined, address, now));
  const api = Object.freeze(projectNodeApi(offline, now));
  const original = structuredClone({ duration, api });
  const view = projectDurationAvailability(duration, api);
  assert.equal(view.text, "—");
  assert.equal(view.unavailableReason, "api-offline");
  assert.equal(view.kind, "unknown");
  assert.equal(view.freshness, "unknown");
  assert.equal(view.elapsedSeconds, null);
  assert.equal(view.limitSeconds, null);
  assert.equal(view.percent, null);
  assert.equal(view.animated, false);
  assert.match(view.description, /API reachability does not establish whether a job is running/);
  assert.ok(view.description.includes(api.description));
  assert.ok(view.description.includes(duration.description));
  assert.ok(view.description.includes(new Date(now).toISOString()));
  assert.deepEqual({ duration, api }, original);
  assert.equal(projectDurationAvailability(view, api), view);
});

test("stale, unknown, inconclusive or disconnected API results leave timing populating", () => {
  const duration = projectLiveDuration(undefined, address, now);
  const inconclusive: NodeInfoRecord = { ...offline, apiCheck: { status: "other", checkedAtMs: now + 1000,
    failureKind: "timeout", lastConfirmed: { status: "offline", checkedAtMs: now,
      firstFailedAtMs: now - 1000, httpStatus: 503, nextCheckAtMs: now + 900_000 } } };
  for (const api of [projectNodeApi(offline, now + 908_000), projectNodeApi(undefined, now),
    projectNodeApi(inconclusive, now + 1000), projectNodeApi(offline, now, "Preview unavailable")]) {
    assert.equal(projectDurationAvailability(duration, api), duration);
  }
  for (const checkedAtMs of [null, NaN, -1, Infinity, 8_640_000_000_000_001]) {
    assert.equal(projectDurationAvailability(duration, { ...projectNodeApi(offline, now), checkedAtMs }), duration);
  }
});

test("API recovery or expiry removes the display substitution on the next source projection", () => {
  const duration = projectLiveDuration(undefined, address, now);
  assert.equal(projectDurationAvailability(duration, projectNodeApi(offline, now)).text, "—");
  const online: NodeInfoRecord = { ...offline, error: null, apiCheck: { status: "online", checkedAtMs: now + 1000 } };
  const recovered = projectDurationAvailability(duration, projectNodeApi(online, now + 1000));
  assert.equal(recovered.text, "Populating..");
  assert.equal(recovered.unavailableReason, undefined);
  const expired = projectDurationAvailability(duration, projectNodeApi(offline, now + 908_000));
  assert.equal(expired.text, "Populating..");
  assert.equal(expired.unavailableReason, undefined);
});

test("current and retained clocks keep their values, limits, freshness and animation while API is Offline", () => {
  for (const at of [now, now + 180_000, now + 781_000]) {
    const duration = projectLiveDuration(job, address, at);
    assert.equal(projectDurationAvailability(duration, projectNodeApi(offline, at)), duration);
  }
  const failed = projectLiveDuration({ ...job, retained: true, failedAtMs: now + 1000, error: "HTTP 429" }, address, now + 1000);
  assert.equal(projectDurationAvailability(failed, projectNodeApi(offline, now + 1000)), failed);
});

test("fresh absence and queue arrows retain their distinct meanings", () => {
  const api = projectNodeApi(offline, now);
  const absent = projectLiveDuration({ ...job, job: null }, address, now);
  assert.equal(absent.text, "—");
  assert.equal(projectDurationAvailability(absent, api), absent);
  assert.equal(absent.unavailableReason, undefined);
  const state: NodeInfoRecord = { address, values: { state: "QUEUED", dl: null, ul: null,
    ping: null, networkUnavailableReason: null }, fetchedAtMs: now, validUntilMs: now + 30_000,
    retained: false, error: null };
  const queued = new LiveActivityDisplay().project({ address, nowMs: now, state }).duration;
  assert.equal(queued.kind, "queue");
  assert.equal(projectDurationAvailability(queued, api), queued);
});
