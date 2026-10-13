import assert from "node:assert/strict";
import test from "node:test";
import { isJobRecord, JOB_DISPLAY_VALIDITY_MS } from "../src/fleet/jobs.ts";
import type { JobRecord } from "../src/fleet/jobs.ts";
import { projectLiveDuration } from "../src/fleet/live-duration.ts";
import { SYNTHETIC_HOST_ADDRESSES } from "./fixtures/host-addresses.ts";

const address = SYNTHETIC_HOST_ADDRESSES[0]!;
const other = SYNTHETIC_HOST_ADDRESSES[1]!;
const jobAddress = SYNTHETIC_HOST_ADDRESSES[2]!;
const checkedAtMs = 1_800_000_000_000;
const record: JobRecord = {
  address, job: { address: jobAddress, node: address, state: "RUNNING",
    timeStart: checkedAtMs / 1000 - 120, timeEnd: 0, timeout: 600 },
  checkedAtMs, validUntilMs: checkedAtMs + JOB_DISPLAY_VALIDITY_MS,
  failedAtMs: null, retained: false, pending: false, retryAtMs: null, error: null,
};
const project = (value: JobRecord = record, now = checkedAtMs) => projectLiveDuration(value, address, now);
const withJob = (job: Partial<NonNullable<JobRecord["job"]>>): JobRecord => ({ ...record, job: { ...record.job!, ...job } });

test("live duration ticks from exact job start without mutating observations", () => {
  const before = structuredClone(record);
  assert.equal(project().text, "2m / 10m");
  assert.equal(project(record, checkedAtMs + 1000).elapsedSeconds, 121);
  assert.equal(project().percent, 20);
  assert.equal(project().animated, true);
  assert.match(project().description, new RegExp(jobAddress));
  assert.match(project().description, /API checked at 2027-01-15T08:00:00.000Z/);
  assert.match(project().description, /no indexing-freshness timestamp/);
  assert.deepEqual(record, before);
});

test("replacement resets start and timeout; extensions apply to the same job", () => {
  const replacement = withJob({ address: other, timeStart: checkedAtMs / 1000 - 10, timeout: 30 });
  assert.equal(project(replacement).text, "10s / 30s");
  assert.equal(project(replacement).tone, "current");
  assert.doesNotMatch(project(replacement).description, new RegExp(jobAddress));
  assert.equal(project(withJob({ timeout: 60 })).tone, "current");
  assert.equal(project(withJob({ timeStart: checkedAtMs / 1000 - 361, timeout: 60 })).tone, "exceeded");
  assert.equal(project(withJob({ timeStart: checkedAtMs / 1000 - 361, timeout: 240 })).tone, "current");
  assert.equal(project(withJob({ timeout: 240 })).tone, "current");
  assert.equal(project(withJob({ timeout: 240 })).percent, 50);
});

test("confirmed completion/absence clears timing instead of carrying old job forward", () => {
  for (const ended of [withJob({ state: "COMPLETED" }), withJob({ timeEnd: checkedAtMs / 1000 }), { ...record, job: null }]) {
    assert.equal(project(ended).kind, "unknown");
    assert.equal(project(ended).elapsedSeconds, null);
    assert.equal(project(ended).animated, false);
  }
});

test("identity mismatches never bind duration to another host", () => {
  for (const wrong of [{ ...record, address: other }, withJob({ node: other }), withJob({ address: "bad-job" })]) {
    assert.equal(project(wrong).kind, "unknown");
    assert.match(project(wrong).description, /does not match/);
  }
});

test("missing, invalid, unsafe or future run start cannot produce elapsed", () => {
  for (const timeStart of [null, 0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER, checkedAtMs / 1000 + 1]) {
    assert.equal(project(withJob({ timeStart })).kind, "unknown");
  }
  assert.equal(project({ ...record, checkedAtMs: null }).kind, "unknown");
  assert.equal(project({ ...record, checkedAtMs: checkedAtMs + 1 }).kind, "unknown");
});

test("invalid timeout keeps elapsed gray with no progress or motion", () => {
  for (const timeout of [null, 0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const view = project(withJob({ timeout }));
    assert.equal(view.elapsedSeconds, 120);
    assert.equal(view.limitSeconds, null);
    assert.equal(view.percent, null);
    assert.equal(view.animated, false);
    assert.equal(view.tone, "unbounded");
  }
});

test("red begins only beyond five minutes over the true limit without extending progress or freshness", () => {
  for (const elapsed of [600, 601, 899, 900]) {
    const withinGrace = project(withJob({ timeStart: checkedAtMs / 1000 - elapsed }));
    assert.equal(withinGrace.tone, "current");
    assert.equal(withinGrace.elapsedSeconds, elapsed);
    assert.equal(withinGrace.limitSeconds, 600);
    assert.equal(withinGrace.percent, 100);
    assert.equal(withinGrace.freshness, "current");
    assert.equal(withinGrace.animated, true);
    assert.doesNotMatch(withinGrace.description, /EXCEEDED/);
    assert.match(withinGrace.description, /5 minutes past the reported limit/);
  }
  const overrun = project(withJob({ timeStart: checkedAtMs / 1000 - 901 }));
  assert.equal(overrun.tone, "exceeded");
  assert.equal(overrun.percent, 100);
  assert.equal(overrun.animated, true);
  assert.match(overrun.description, /EXCEEDED/);
});

test("expired evidence keeps ticking as a dimmable estimate through prolonged suspension", () => {
  const expiry = record.validUntilMs!;
  assert.equal(project(record, expiry - 1).freshness, "current");
  const expired = project(record, expiry);
  assert.equal(expired.elapsedSeconds, 300);
  assert.equal(expired.tone, "current");
  assert.equal(expired.freshness, "retained");
  assert.equal(expired.animated, true);
  assert.equal(project(record, expiry + 86_400_000).elapsedSeconds, 86_700);
  assert.equal(project(record, expiry + 86_400_000).tone, "exceeded");
  assert.match(expired.description, /Stale estimate/);
  assert.match(expired.description, /Original confirmation 2027-01-15T08:00:00.000Z/);
  assert.match(expired.description, /Last reported limit: 10m \(600 seconds\)/);
});

test("provider failures retain exact timing, limit and source times while estimates advance", () => {
  const failed = { ...withJob({ timeout: 60 }), retained: true, error: "Request failed.", failedAtMs: checkedAtMs + 20_000 };
  const before = structuredClone(failed);
  const view = project(failed, checkedAtMs + 50_000);
  assert.equal(view.elapsedSeconds, 170);
  assert.equal(view.tone, "current");
  assert.equal(view.freshness, "retained");
  assert.equal(view.animated, true);
  assert.equal(project(failed, checkedAtMs + 90_000).elapsedSeconds, 210);
  assert.equal(project({ ...failed, failedAtMs: checkedAtMs + 240_000 }, checkedAtMs + 250_000).elapsedSeconds, 370);
  assert.equal(project({ ...failed, failedAtMs: checkedAtMs + 240_000 }, checkedAtMs + 250_000).tone, "exceeded");
  assert.equal(project({ ...failed, failedAtMs: null }, checkedAtMs + 50_000).elapsedSeconds, 170);
  assert.match(view.description, /First failed refresh at/);
  assert.deepEqual(failed, before);
});

test("browser transport failures preserve ticking without renewing freshness", () => {
  const first = projectLiveDuration(record, address, checkedAtMs + 30_000, "Preview disconnected.", checkedAtMs + 10_000);
  const later = projectLiveDuration(record, address, checkedAtMs + 60_000, "Preview disconnected.", checkedAtMs + 10_000);
  assert.equal(first.elapsedSeconds, 150);
  assert.equal(later.elapsedSeconds, 180);
  assert.equal(first.tone, "current");
  assert.equal(first.freshness, "retained");
  assert.equal(first.animated, true);
  assert.match(first.description, /Preview connection failed at/);
});

test("invalid local deadlines cannot mint freshness but preserve validated start timing", () => {
  for (const validUntilMs of [null, NaN, checkedAtMs, checkedAtMs - 1, checkedAtMs + JOB_DISPLAY_VALIDITY_MS + 1]) {
    const view = project({ ...record, validUntilMs }, checkedAtMs + 1000);
    assert.equal(view.freshness, "retained");
    assert.equal(view.elapsedSeconds, 121);
    assert.equal(view.animated, true);
    assert.equal(view.validUntilMs, null);
  }
});

test("selected live timing and absence expose their original validated deadline without renewing it", () => {
  for (const value of [record, { ...record, job: null }, { ...record, retained: true, error: "HTTP 429" },
    { ...record, job: null, error: "HTTP 429" }]) {
    const before = structuredClone(value);
    for (const at of [checkedAtMs, checkedAtMs + JOB_DISPLAY_VALIDITY_MS, checkedAtMs + 86_400_000]) {
      assert.equal(project(value, at).validUntilMs, record.validUntilMs);
    }
    assert.deepEqual(value, before);
  }
  assert.equal(projectLiveDuration(undefined, address, checkedAtMs).validUntilMs, undefined);
  assert.equal(project({ ...record, job: null, checkedAtMs: null, validUntilMs: null }).validUntilMs, undefined);
  assert.equal(project({ ...record, job: null, validUntilMs: checkedAtMs + JOB_DISPLAY_VALIDITY_MS + 1 }).validUntilMs, null);
});

test("pending budget delay stays explicit and never extends evidence deadlines", () => {
  const pending = { ...record, pending: true, retryAtMs: checkedAtMs + 300_000 };
  assert.match(project(pending).description, /lookup pending; next attempt no earlier/);
  assert.equal(project(pending).freshness, "current");
  const delayed = project(pending, checkedAtMs + 200_000);
  assert.equal(delayed.freshness, "retained");
  assert.equal(delayed.elapsedSeconds, 320);
  const initial = project({ ...pending, job: null, checkedAtMs: null, validUntilMs: null });
  assert.equal(initial.kind, "unknown");
  assert.equal(initial.text, "Populating..");
  assert.equal(initial.freshness, "unknown");
  assert.match(initial.description, /Duration pending/);
});

test("unverified end timing and unknown state cannot establish a running estimate", () => {
  for (const job of [
    { timeEnd: null }, { state: "UNKNOWN" }, { timeEnd: checkedAtMs / 1000 + 1 },
    { timeEnd: checkedAtMs / 1000 - 500 },
  ]) {
    const view = project(withJob(job));
    assert.equal(view.kind, "unknown");
    assert.equal(view.text, "Populating..");
    assert.equal(view.animated, false);
  }
  const failure = { ...record, error: "Ambiguous assignment.", retained: true, failedAtMs: checkedAtMs + 5000 };
  assert.equal(project(failure, checkedAtMs + 20_000).elapsedSeconds, 140);
  assert.equal(project(failure, checkedAtMs + 20_000).animated, true);
});

test("failure timestamps and empty error strings do not stop or renew the estimated clock", () => {
  for (const failedAtMs of [checkedAtMs + 90_000, checkedAtMs - 1000, null, NaN]) {
    for (const now of [checkedAtMs + 10_000, checkedAtMs + 20_000]) {
      const failed = { ...record, error: "", failedAtMs };
      assert.equal(project(failed, now).elapsedSeconds, 120 + (now - checkedAtMs) / 1000);
      assert.equal(project(failed, now).animated, true);
      assert.equal(project(failed, now).freshness, "retained");
      assert.equal(projectLiveDuration(record, address, now, "", failedAtMs).freshness, "retained");
    }
  }
});

test("stale estimates share the five-minute grace without restarting it after failed checks", () => {
  const failed = { ...record, retained: true, failedAtMs: checkedAtMs, error: "Unavailable" };
  const exact = project(failed, checkedAtMs + 480_000);
  assert.equal(exact.elapsedSeconds, 600);
  assert.equal(exact.tone, "current");
  assert.equal(exact.freshness, "retained");
  assert.doesNotMatch(exact.description, /EXCEEDED/);
  for (const offset of [481_000, 779_000, 780_000]) {
    const withinGrace = project(failed, checkedAtMs + offset);
    assert.equal(withinGrace.tone, "current");
    assert.equal(withinGrace.freshness, "retained");
    assert.equal(withinGrace.limitSeconds, 600);
    assert.equal(withinGrace.elapsedSeconds, 120 + offset / 1000);
    assert.doesNotMatch(withinGrace.description, /EXCEEDED/);
  }
  const above = project(failed, checkedAtMs + 781_000);
  assert.equal(above.tone, "exceeded");
  assert.equal(above.freshness, "retained");
  assert.equal(above.animated, true);
  assert.match(above.description, /EXCEEDED/);
  const extended = { ...record, job: { ...record.job!, timeout: 1200 }, checkedAtMs: checkedAtMs + 781_000,
    validUntilMs: checkedAtMs + 781_000 + JOB_DISPLAY_VALIDITY_MS };
  assert.equal(project(extended, checkedAtMs + 781_000).tone, "current");
  assert.equal(project(extended, checkedAtMs + 781_000).freshness, "current");
});

test("missing limits preserve elapsed text without motion or an overrun alarm even when stale", () => {
  const view = project(withJob({ timeout: null }), checkedAtMs + 86_400_000);
  assert.equal(view.elapsedSeconds, 86_520);
  assert.equal(view.limitSeconds, null);
  assert.equal(view.freshness, "retained");
  assert.equal(view.animated, false);
  assert.equal(view.tone, "unbounded");
  assert.doesNotMatch(view.description, /EXCEEDED/);
});

test("only current confirmed absence uses a dash; expired absence returns to populating", () => {
  const absent = { ...record, job: null };
  assert.equal(project(absent).text, "—");
  assert.equal(project(absent).freshness, "current");
  assert.match(project(absent).description, /No running assignment/);
  assert.equal(project(absent, absent.validUntilMs! - 1).text, "—");
  for (const at of [absent.validUntilMs!, checkedAtMs + 86_400_000]) {
    const expired = project(absent, at);
    assert.equal(expired.text, "Populating..");
    assert.equal(expired.freshness, "unknown");
    assert.match(expired.description, /Last confirmed: no running assignment/);
    assert.match(expired.description, /Original confirmation 2027-01-15T08:00:00.000Z/);
  }
  assert.equal(project({ ...absent, checkedAtMs: null, validUntilMs: null }).text, "Populating..");
  assert.equal(projectLiveDuration(undefined, address, checkedAtMs).text, "Populating..");
});

test("failed or malformed absence cannot claim current absence", () => {
  const absent = { ...record, job: null };
  for (const changes of [{ retained: true }, { error: "HTTP 429" }, { validUntilMs: null },
    { validUntilMs: checkedAtMs }, { validUntilMs: checkedAtMs + JOB_DISPLAY_VALIDITY_MS + 1 },
    { checkedAtMs: checkedAtMs + 1 }]) {
    assert.equal(project({ ...absent, ...changes }).text, "Populating..");
  }
  assert.equal(projectLiveDuration(absent, address, checkedAtMs, "Preview disconnected").text, "Populating..");
  assert.equal(project(withJob({ state: "COMPLETED" }), record.validUntilMs!).text, "Populating..");
});

test("browser contract rejects malformed fields and cross-host job data", () => {
  assert.equal(isJobRecord(record), true);
  assert.equal(isJobRecord({ ...record, job: null }), true);
  for (const bad of [null, [], {}, { ...record, pending: "yes" }, { ...record, failedAtMs: NaN },
    { ...record, validUntilMs: undefined }, { ...record, error: "x".repeat(1025) },
    withJob({ node: other }), withJob({ state: "RUNNING\n" }), withJob({ state: "UNKNOWN" }), withJob({ timeout: -1 })]) {
    assert.equal(isJobRecord(bad), false);
  }
});

test("invalid clocks throw even without evidence", () => {
  for (const clock of [-1, NaN, Infinity, 1.5]) assert.throws(() => project(record, clock), RangeError);
  assert.equal(projectLiveDuration(undefined, address, checkedAtMs).kind, "unknown");
});
