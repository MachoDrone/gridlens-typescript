import assert from "node:assert/strict";
import test from "node:test";
import { formatDurationSeconds, nextDurationMode, normalizeDurationMode, projectDuration } from "../src/fleet/duration.ts";
import type { DurationActivity, DurationInput, DurationReading } from "../src/fleet/duration.ts";

const nowMs = 1_800_000_000_000;
const reading: DurationReading = Object.freeze({
  jobId: "sample-job-1", elapsedSeconds: 120, limitSeconds: 600,
  observedAtMs: nowMs - 20_000, freshUntilMs: nowMs + 40_000, stale: false,
});
const activity: DurationActivity = Object.freeze({
  state: "running", jobId: reading.jobId, queuePosition: null,
  observedAtMs: nowMs - 10_000, freshUntilMs: nowMs + 50_000, stale: false,
});
const input: DurationInput = Object.freeze({ displayedJobId: reading.jobId, reading, activity });

function withReading(changes: Partial<DurationReading>): DurationInput {
  return { ...input, reading: { ...reading, ...changes } };
}

function withActivity(changes: Partial<DurationActivity>): DurationInput {
  return { ...input, activity: { ...activity, ...changes } };
}

test("duration display defaults to bar and alternates between the two reference modes", () => {
  for (const value of [undefined, null, "", "BAR", "TEXT", " text ", "full", false, 1, {}, ["text"], "constructor", "__proto__"]) {
    assert.equal(normalizeDurationMode(value), "bar");
  }
  assert.equal(normalizeDurationMode("bar"), "bar");
  assert.equal(normalizeDurationMode("text"), "text");
  assert.equal(nextDurationMode("bar"), "text");
  assert.equal(nextDurationMode(nextDurationMode("bar")), "bar");
});

test("duration text omits zero units and seconds after the first hour", () => {
  for (const [seconds, expected] of [
    [0, "0s"], [0.9, "0s"], [1, "1s"], [59.9, "59s"],
    [60, "1m"], [61, "1m 1s"], [3_000, "50m"], [3_599, "59m 59s"],
    [3_600, "1h"], [3_601, "1h"], [3_660, "1h 1m"], [21_600, "6h"],
    [86_400, "1d"], [86_460, "1d 1m"], [93_600, "1d 2h"], [93_661, "1d 2h 1m"],
  ] as const) assert.equal(formatDurationSeconds(seconds), expected, String(seconds));
});

test("invalid durations are never formatted as plausible measurements", () => {
  for (const seconds of [NaN, Infinity, -Infinity, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => formatDurationSeconds(seconds), RangeError);
    const view = projectDuration(withReading({ elapsedSeconds: seconds }), nowMs);
    assert.equal(view.kind, "unknown");
    assert.equal(view.text, "—");
    assert.equal(view.elapsedSeconds, null);
    assert.equal(view.percent, null);
    assert.equal(view.animated, false);
  }
});

test("current duration needs matching fresh reading and running activity", () => {
  const view = projectDuration(input, nowMs);
  assert.deepEqual({ ...view, description: undefined }, {
    kind: "duration", text: "2m / 10m", description: undefined,
    elapsedSeconds: 120, limitSeconds: 600, percent: 20,
    tone: "current", freshness: "current", animated: true,
  });
  assert.match(view.description, /Job sample-job-1: 2m \/ 10m/);
  assert.match(view.description, /Current duration with matching running activity/);
  for (const timestamp of [reading.observedAtMs, reading.freshUntilMs, activity.observedAtMs, activity.freshUntilMs]) {
    assert.ok(timestamp !== null);
    assert.ok(view.description.includes(new Date(timestamp).toISOString()));
  }
});

test("zero elapsed is a real reading and an exact limit is not exceeded", () => {
  const zero = projectDuration(withReading({ elapsedSeconds: 0 }), nowMs);
  assert.equal(zero.kind, "duration");
  assert.equal(zero.text, "0s / 10m");
  assert.equal(zero.percent, 0);
  assert.equal(zero.tone, "current");
  const exact = projectDuration(withReading({ elapsedSeconds: 600 }), nowMs);
  assert.equal(exact.percent, 100);
  assert.equal(exact.tone, "current");
  assert.equal(exact.animated, true);
  assert.doesNotMatch(exact.description, /EXCEEDED/);
});

test("exceeded durations clamp the bar but preserve the reported elapsed value", () => {
  for (const elapsedSeconds of [600.01, 750, 899.99, 900]) {
    const withinGrace = projectDuration(withReading({ elapsedSeconds }), nowMs);
    assert.equal(withinGrace.tone, "current");
    assert.equal(withinGrace.elapsedSeconds, elapsedSeconds);
    assert.equal(withinGrace.limitSeconds, 600);
    assert.equal(withinGrace.percent, 100);
    assert.equal(withinGrace.animated, true);
    assert.doesNotMatch(withinGrace.description, /EXCEEDED/);
    assert.match(withinGrace.description, /5 minutes past the reported limit/);
  }
  const view = projectDuration(withReading({ elapsedSeconds: 901 }), nowMs);
  assert.equal(view.text, "15m 1s / 10m");
  assert.equal(view.elapsedSeconds, 901);
  assert.equal(view.percent, 100);
  assert.equal(view.tone, "exceeded");
  assert.equal(view.animated, true);
  assert.match(view.description, /EXCEEDED: reported elapsed duration is beyond its limit/);
  assert.equal(projectDuration(withReading({ elapsedSeconds: 900.01 }), nowMs).tone, "exceeded");
});

test("missing, invalid and nonpositive limits preserve elapsed without progress or animation", () => {
  for (const limitSeconds of [null, NaN, Infinity, -Infinity, -1, 0, Number.MAX_SAFE_INTEGER + 1]) {
    const view = projectDuration(withReading({ limitSeconds }), nowMs);
    assert.equal(view.kind, "duration");
    assert.equal(view.text, "2m");
    assert.equal(view.elapsedSeconds, 120);
    assert.equal(view.limitSeconds, null);
    assert.equal(view.percent, null);
    assert.equal(view.tone, "unbounded");
    assert.equal(view.animated, false);
    assert.match(view.description, /No valid positive duration limit/);
    assert.doesNotMatch(view.description, /EXCEEDED/);
  }
});

test("fractional durations retain numeric precision and progress stays finite at extreme ratios", () => {
  const view = projectDuration(withReading({ elapsedSeconds: 60.75, limitSeconds: 121.5 }), nowMs);
  assert.equal(view.elapsedSeconds, 60.75);
  assert.equal(view.limitSeconds, 121.5);
  assert.equal(view.percent, 50);
  assert.equal(view.text, "1m / 2m 1s");
  assert.equal(projectDuration(withReading({ elapsedSeconds: 1, limitSeconds: Number.MIN_VALUE }), nowMs).percent, 100);
});

test("expiry is exclusive and independently enforced for duration and activity", () => {
  for (const candidate of [
    withReading({ freshUntilMs: nowMs + 1 }),
    withActivity({ freshUntilMs: nowMs + 1 }),
  ]) {
    assert.equal(projectDuration(candidate, nowMs).tone, "current");
    const expired = projectDuration(candidate, nowMs + 1);
    assert.equal(expired.tone, "retained");
    assert.equal(expired.animated, false);
    assert.match(expired.description, /expired/);
    assert.equal(projectDuration(candidate, nowMs + 2).tone, "retained");
  }
});

test("explicit provider expiry is used without a local inventory or job-age cutoff", () => {
  const old = nowMs - 86_400_000;
  const candidate = {
    ...input,
    reading: { ...reading, observedAtMs: old },
    activity: { ...activity, observedAtMs: old },
  };
  assert.equal(projectDuration(candidate, nowMs).tone, "current");
});

test("missing or invalid source timestamps retain duration without claiming current activity", () => {
  for (const timestamp of [null, -1, NaN, Infinity, 1.5, 8_640_000_000_000_001, Number.MAX_SAFE_INTEGER + 1]) {
    for (const candidate of [
      withReading({ observedAtMs: timestamp }), withReading({ freshUntilMs: timestamp }),
      withActivity({ observedAtMs: timestamp }), withActivity({ freshUntilMs: timestamp }),
    ]) {
      const view = projectDuration(candidate, nowMs);
      assert.equal(view.kind, "duration");
      assert.equal(view.tone, "retained");
      assert.equal(view.animated, false);
      assert.match(view.description, /missing or invalid/);
    }
  }
});

test("valid source timestamps display as ISO UTC including the Date range boundary", () => {
  const view = projectDuration(withReading({ observedAtMs: 0, freshUntilMs: 8_640_000_000_000_000 }), nowMs);
  assert.match(view.description, /observed at 1970-01-01T00:00:00\.000Z/);
  assert.match(view.description, /fresh until \+275760-09-13T00:00:00\.000Z/);
  assert.equal(view.tone, "current");
  assert.equal(projectDuration(null, 8_640_000_000_000_000).kind, "unknown");
});

test("future observations and expiry before observation cannot make a duration current", () => {
  for (const candidate of [
    withReading({ observedAtMs: nowMs + 1 }), withActivity({ observedAtMs: nowMs + 1 }),
    withReading({ freshUntilMs: reading.observedAtMs }), withActivity({ freshUntilMs: activity.observedAtMs }),
    withReading({ freshUntilMs: nowMs - 30_000 }), withActivity({ freshUntilMs: nowMs - 30_000 }),
  ]) {
    const view = projectDuration(candidate, nowMs);
    assert.equal(view.tone, "retained");
    assert.equal(view.animated, false);
  }
  assert.equal(projectDuration(withReading({ observedAtMs: nowMs }), nowMs).tone, "current");
  assert.equal(projectDuration(withActivity({ observedAtMs: nowMs }), nowMs).tone, "current");
});

test("explicit stale evidence overrides a future expiry and exceeded color", () => {
  for (const candidate of [
    withReading({ stale: true, elapsedSeconds: 960 }),
    { ...withReading({ elapsedSeconds: 960 }), activity: { ...activity, stale: true } },
  ]) {
    const view = projectDuration(candidate, nowMs);
    assert.equal(view.tone, "retained");
    assert.equal(view.percent, 100);
    assert.equal(view.animated, false);
    assert.match(view.description, /marked stale/);
    assert.match(view.description, /EXCEEDED in retained reading/);
  }
  assert.equal(projectDuration(withReading({ stale: true, limitSeconds: null }), nowMs).tone, "retained");
});

test("missing, completed, idle and unknown activity preserve a grey retained duration", () => {
  for (const candidate of [
    { ...input, activity: null },
    ...(["completed", "idle", "unknown"] as const).map(state => withActivity({ state })),
  ]) {
    const view = projectDuration(candidate, nowMs);
    assert.equal(view.kind, "duration");
    assert.equal(view.text, "2m / 10m");
    assert.equal(view.tone, "retained");
    assert.equal(view.animated, false);
    assert.match(view.description, /Retained duration/);
  }
});

test("a different or missing active job cannot animate the displayed job's reading", () => {
  for (const jobId of [null, "", " ", "sample-job-2", " sample-job-1 "]) {
    const view = projectDuration(withActivity({ jobId }), nowMs);
    assert.equal(view.kind, "duration");
    assert.equal(view.tone, "retained");
    assert.equal(view.animated, false);
    assert.match(view.description, /Activity job does not match/);
  }
});

test("missing readings, invalid elapsed and mismatched display identity remain unknown", () => {
  const candidates: (DurationInput | null)[] = [
    null, { ...input, reading: null }, withReading({ elapsedSeconds: null }),
    withReading({ jobId: "sample-job-2" }),
    ...[null, "", " ", "sample-job-2", " sample-job-1 "].map(displayedJobId => ({ ...input, displayedJobId })),
    { ...input, displayedJobId: " ", reading: { ...reading, jobId: " " } },
  ];
  for (const candidate of candidates) {
    const view = projectDuration(candidate, nowMs);
    assert.equal(view.kind, "unknown");
    assert.equal(view.text, "—");
    assert.equal(view.elapsedSeconds, null);
    assert.equal(view.percent, null);
    assert.equal(view.animated, false);
  }
});

test("fresh queued activity takes precedence over an old duration and keeps sorting unknown", () => {
  const candidate = withActivity({ state: "queued", jobId: null, queuePosition: " 4 " });
  const view = projectDuration(candidate, nowMs);
  assert.equal(view.kind, "queue");
  assert.equal(view.text, "⟵");
  assert.equal(view.elapsedSeconds, null);
  assert.equal(view.limitSeconds, null);
  assert.equal(view.percent, null);
  assert.equal(view.tone, "current");
  assert.equal(view.animated, false);
  assert.match(view.description, /Current queued activity at position 4/);
  assert.match(view.description, /See the Queued column on the left/);
  assert.ok(activity.observedAtMs !== null);
  assert.ok(view.description.includes(new Date(activity.observedAtMs).toISOString()));
  assert.equal(projectDuration({ ...candidate, reading: null }, nowMs).kind, "queue");
  assert.equal(projectDuration({ ...candidate, displayedJobId: "some-old-job" }, nowMs).kind, "queue");
});

test("queue without a reported position cannot replace a retained duration", () => {
  for (const queuePosition of [null, "", " ", "0", " 0 ", "-", " - "]) {
    const candidate = withActivity({ state: "queued", jobId: null, queuePosition });
    const view = projectDuration(candidate, nowMs);
    assert.equal(view.kind, "duration");
    assert.equal(view.tone, "retained");
    assert.equal(view.animated, false);
    assert.equal(projectDuration({ ...candidate, reading: null }, nowMs).kind, "unknown");
  }
});

test("queue accepts normalized positive positions and position/total pairs", () => {
  for (const queuePosition of ["1", " 4 ", "1/4", "4/4", " 4/17 ", String(Number.MAX_SAFE_INTEGER), `1/${Number.MAX_SAFE_INTEGER}`]) {
    const view = projectDuration(withActivity({ state: "queued", queuePosition }), nowMs);
    assert.equal(view.kind, "queue", queuePosition);
    assert.ok(view.description.includes(`position ${queuePosition.trim()}.`));
  }
});

test("unknown, malformed and unsafe queue positions cannot replace a retained duration", () => {
  for (const queuePosition of [
    "—", "?", "unknown", "NaN", "Infinity", "-1", "1.5", "+1", "01", "000", "1e2", "1x", "1\n2",
    "0/4", "-1/4", "1/0", "1/-4", "5/4", "1/4.5", "1/04", "01/4", "1/", "/4", "1 / 4", "1/2/3",
    String(Number.MAX_SAFE_INTEGER + 1), `1/${Number.MAX_SAFE_INTEGER + 1}`,
    `${Number.MAX_SAFE_INTEGER + 1}/${Number.MAX_SAFE_INTEGER + 1}`, "9".repeat(400),
  ]) {
    const candidate = withActivity({ state: "queued", jobId: null, queuePosition });
    const view = projectDuration(candidate, nowMs);
    assert.equal(view.kind, "duration", queuePosition);
    assert.equal(view.tone, "retained");
    assert.equal(view.animated, false);
    assert.equal(projectDuration({ ...candidate, reading: null }, nowMs).kind, "unknown");
  }
});

test("stale, future and unverified queue evidence cannot hide retained duration", () => {
  for (const changes of [
    { stale: true }, { freshUntilMs: nowMs }, { observedAtMs: nowMs + 1 },
    { observedAtMs: null }, { freshUntilMs: null }, { freshUntilMs: activity.observedAtMs },
  ]) {
    const candidate = withActivity({ state: "queued", jobId: null, queuePosition: "4", ...changes });
    const view = projectDuration(candidate, nowMs);
    assert.equal(view.kind, "duration");
    assert.equal(view.tone, "retained");
    assert.equal(view.animated, false);
  }
});

test("queue position on a nonqueued activity is not evidence of being queued", () => {
  assert.equal(projectDuration(withActivity({ queuePosition: "4" }), nowMs).kind, "duration");
});

test("projection does not mutate inputs or advance the reported elapsed time", () => {
  const before = structuredClone(input);
  const first = projectDuration(input, nowMs);
  const later = projectDuration(input, nowMs + 30_000);
  assert.deepEqual(first, later);
  assert.deepEqual(input, before);
  const expired = projectDuration(input, nowMs + 60_000);
  assert.equal(expired.elapsedSeconds, first.elapsedSeconds);
  assert.equal(expired.text, first.text);
  assert.equal(expired.tone, "retained");
  assert.deepEqual(input, before);
});

test("invalid explicit clocks throw before any projection, including missing evidence", () => {
  for (const invalid of [-1, NaN, Infinity, -Infinity, 0.5, 8_640_000_000_000_001, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => projectDuration(input, invalid), RangeError);
    assert.throws(() => projectDuration(null, invalid), RangeError);
  }
  assert.equal(projectDuration(null, 0).kind, "unknown");
});
