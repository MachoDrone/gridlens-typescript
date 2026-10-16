import assert from "node:assert/strict";
import { test } from "node:test";
import { createEvidenceClock, isServerTimeMs } from "../src/preview/evidence-clock.ts";
import { projectNodeApi } from "../src/fleet/node-api.ts";
import type { NodeInfoRecord } from "../src/fleet/node-info.ts";
import { SYNTHETIC_HOST_ADDRESSES } from "./fixtures/host-addresses.ts";
import { createRefreshDeadlines } from "../src/preview/refresh-deadline.ts";
import { projectLiveDuration } from "../src/fleet/live-duration.ts";
import type { JobRecord } from "../src/fleet/jobs.ts";

const serverAt = Date.UTC(2026, 0, 1, 12);

test("initial server calibration replaces either wrong browser epoch and then ignores wall-clock changes", () => {
  for (const offset of [-86_400_000, 86_400_000]) {
    let wall = serverAt + offset;
    let elapsed = 10.25;
    const clock = createEvidenceClock({ wallNow: () => wall, monotonicNow: () => elapsed });
    assert.equal(clock.calibrated, false);
    assert.equal(clock.trusted, true);
    assert.equal(clock.suspend(), false);
    assert.equal(clock.trusted, true);
    assert.equal(clock.now(), wall);
    assert.deepEqual(clock.accept(serverAt), { changed: true, freshnessChanged: true, calibratedNow: true, trustChanged: false, correctionMs: 0 });
    assert.equal(clock.calibrated, true);
    assert.equal(clock.now(), serverAt);
    wall += 7 * 86_400_000;
    elapsed += 1_500.75;
    assert.equal(clock.now(), serverAt + 1_500);
    assert(Number.isSafeInteger(clock.now()));
    wall = 0;
    elapsed += 200;
    assert.equal(clock.now(), serverAt + 1_700);
  }
});

test("ordinary progression and delayed samples do not request rerenders or rewind established time", () => {
  let elapsed = 100;
  const clock = createEvidenceClock({ monotonicNow: () => elapsed });
  clock.accept(serverAt);
  elapsed += 15_000;
  assert.deepEqual(clock.accept(serverAt + 15_000), { changed: false, freshnessChanged: false, calibratedNow: false, trustChanged: false, correctionMs: 0 });
  assert.deepEqual(clock.accept(serverAt), { changed: false, freshnessChanged: false, calibratedNow: false, trustChanged: false, correctionMs: 0 });
  assert.equal(clock.now(), serverAt + 15_000);
  assert.deepEqual(clock.accept(serverAt + 15_500), { changed: true, freshnessChanged: true, calibratedNow: false, trustChanged: false, correctionMs: 500 });
  elapsed += 500;
  assert.equal(clock.now(), serverAt + 16_000);
  elapsed -= 100;
  assert.equal(clock.now(), serverAt + 16_000);
});

test("suspension preserves confirmed-label time and needs a server sample to restore freshness trust", () => {
  let elapsed = 0;
  const clock = createEvidenceClock({ wallNow: () => serverAt - 86_400_000, monotonicNow: () => elapsed });
  clock.accept(serverAt);
  assert.equal(clock.suspend(), true);
  assert.equal(clock.suspend(), false);
  assert.equal(clock.calibrated, true);
  assert.equal(clock.trusted, false);
  assert.equal(clock.now(), serverAt);
  // A device sleep can leave the browser's elapsed clock unchanged.
  assert.deepEqual(clock.accept(serverAt + 120_000), {
    changed: true, freshnessChanged: true, calibratedNow: false, trustChanged: true, correctionMs: 120_000,
  });
  assert.equal(clock.trusted, true);
  elapsed += 1_000;
  assert.equal(clock.now(), serverAt + 121_000);
  clock.suspend();
  assert.deepEqual(clock.accept(serverAt + 120_000), {
    changed: true, freshnessChanged: true, calibratedNow: false, trustChanged: true, correctionMs: 0,
  });
  assert.equal(clock.now(), serverAt + 121_000);
});

test("invalid clock samples cannot alter the anchor or restore trust, and Date limits stay bounded", () => {
  let elapsed = 0;
  const clock = createEvidenceClock({ monotonicNow: () => elapsed });
  clock.accept(serverAt);
  clock.suspend();
  for (const value of [null, undefined, "1000", -1, 1.5, NaN, Infinity, 8_640_000_000_000_001]) {
    assert.equal(isServerTimeMs(value), false);
    assert.throws(() => clock.accept(value as number), RangeError);
    assert.equal(clock.now(), serverAt);
    assert.equal(clock.trusted, false);
  }
  assert.equal(isServerTimeMs(0), true);
  assert.equal(isServerTimeMs(8_640_000_000_000_000), true);
  clock.accept(8_640_000_000_000_000);
  elapsed = 100_000;
  assert.equal(clock.now(), 8_640_000_000_000_000);
});

test("server-relative projection retains original proof times, expires normally and rejects genuinely future proof", () => {
  let elapsed = 0;
  const clock = createEvidenceClock({ wallNow: () => serverAt - 2_000, monotonicNow: () => elapsed });
  const record: NodeInfoRecord = { address: SYNTHETIC_HOST_ADDRESSES[0]!, values: null,
    fetchedAtMs: null, validUntilMs: null, retained: false, error: null,
    apiCheck: { status: "online", checkedAtMs: serverAt } };
  const original = structuredClone(record);
  assert.equal(projectNodeApi(record, clock.now()).label, "Populating..");
  clock.accept(serverAt);
  assert.equal(projectNodeApi(record, clock.now()).label, "Online");
  assert.equal(projectNodeApi(record, clock.now()).current, true);
  elapsed = 30_000;
  assert.equal(projectNodeApi(record, clock.now()).current, false);
  clock.accept(serverAt);
  assert.equal(projectNodeApi(record, clock.now()).current, false);
  clock.accept(serverAt + 30_000);
  assert.equal(projectNodeApi(record, clock.now()).checkedAtMs, serverAt);
  assert.equal(projectNodeApi({ ...record, apiCheck: { status: "online", checkedAtMs: serverAt + 30_001 } }, clock.now()).label, "Populating..");
  assert.deepEqual(record, original);
});

test("slow initial calibration carries expiry uncertainty without advancing elapsed jobs or refresh deadlines", () => {
  let elapsed = 90_000;
  const clock = createEvidenceClock({ monotonicNow: () => elapsed });
  const update = clock.accept(serverAt, 90_000);
  assert.equal(update.correctionMs, 0);
  assert.equal(clock.now(), serverAt);
  assert.equal(clock.freshnessNow(), serverAt + 90_000);
  const api: NodeInfoRecord = { address: SYNTHETIC_HOST_ADDRESSES[0]!, values: null,
    fetchedAtMs: null, validUntilMs: null, retained: false, error: null,
    apiCheck: { status: "online", checkedAtMs: serverAt } };
  assert.equal(projectNodeApi(api, clock.now()).checkedAtMs, serverAt);
  assert(clock.freshnessNow() >= projectNodeApi(api, clock.now()).expiresAtMs!,
    "the current label's original deadline can already be exceeded in transit");
  assert.equal(projectNodeApi({ ...api, apiCheck: { status: "online", checkedAtMs: serverAt + 1 } }, clock.now()).label,
    "Populating..", "uncertainty cannot admit future source timestamps");

  const record: JobRecord = { address: SYNTHETIC_HOST_ADDRESSES[0]!,
    job: { address: SYNTHETIC_HOST_ADDRESSES[1]!, node: SYNTHETIC_HOST_ADDRESSES[0]!,
      state: "RUNNING", timeStart: (serverAt - 850_000) / 1_000, timeEnd: 0, timeout: 600 },
    checkedAtMs: serverAt, validUntilMs: serverAt + 180_000, failedAtMs: null,
    retained: false, pending: false, retryAtMs: null, error: null };
  const original = structuredClone(record);
  const duration = projectLiveDuration(record, record.address, clock.now());
  assert.equal(duration.elapsedSeconds, 850);
  assert.equal(duration.tone, "current", "RTT cannot trigger premature overrun");
  const deadlines = createRefreshDeadlines(() => clock.now(), () => elapsed);
  const source = deadlines.source(serverAt + 120_000)!;
  const retry = deadlines.after(60_000);
  assert.equal(deadlines.remaining(source), 120_000);
  assert.equal(deadlines.remaining(retry), 60_000);

  const tighter = clock.accept(serverAt, 20);
  assert.equal(tighter.changed, false);
  assert.equal(tighter.freshnessChanged, true);
  assert.equal(clock.now(), serverAt);
  assert.equal(clock.freshnessNow(), serverAt + 20);
  assert.equal(deadlines.remaining(source), 120_000);
  assert.equal(deadlines.remaining(retry), 60_000);
  assert.deepEqual(record, original);
  elapsed += 500;
  assert.equal(clock.now(), serverAt + 500);
  assert.equal(clock.freshnessNow(), serverAt + 520);
});

test("later slow and buffered stream frames preserve a tighter established freshness bound", () => {
  let elapsed = 100;
  const clock = createEvidenceClock({ monotonicNow: () => elapsed });
  clock.accept(serverAt, 20);
  elapsed += 240_000;
  const later = clock.accept(serverAt + 240_000, 240_000);
  assert.equal(later.changed, false);
  assert.equal(later.freshnessChanged, false);
  assert.equal(clock.now(), serverAt + 240_000);
  assert.equal(clock.freshnessNow(), serverAt + 240_020);
  const buffered = clock.accept(serverAt - 10_000, 120_000);
  assert.equal(buffered.changed, false);
  assert.equal(buffered.freshnessChanged, false);
  assert.equal(clock.now(), serverAt + 240_000);
  assert.equal(clock.freshnessNow(), serverAt + 240_020,
    "an incompatible old envelope cannot widen, tighten or rewind the active interval");
});

test("compatible samples tighten only freshness and forward disjoint samples rebase without adding their RTT to now", () => {
  const clock = createEvidenceClock({ monotonicNow: () => 0 });
  clock.accept(serverAt, 40_000);
  const tighten = clock.accept(serverAt - 500, 600);
  assert.equal(tighten.changed, false);
  assert.equal(tighten.freshnessChanged, true);
  assert.equal(clock.now(), serverAt);
  assert.equal(clock.freshnessNow(), serverAt + 100);
  const forward = clock.accept(serverAt + 1_000, 25);
  assert.equal(forward.correctionMs, 1_000);
  assert.equal(forward.changed, true);
  assert.equal(forward.freshnessChanged, true);
  assert.equal(clock.now(), serverAt + 1_000);
  assert.equal(clock.freshnessNow(), serverAt + 1_025);
});

test("suspension drops measured freshness confidence until a compatible measured response arrives", () => {
  const maximum = 8_640_000_000_000_000;
  const clock = createEvidenceClock({ monotonicNow: () => 100 });
  clock.accept(serverAt, 20);
  clock.suspend();
  assert.equal(clock.freshnessNow(), maximum);
  assert.equal(clock.now(), serverAt);
  clock.accept(serverAt - 1_000, 10);
  assert.equal(clock.trusted, true, "a response restores reference trust independently of measured freshness confidence");
  assert.equal(clock.freshnessNow(), maximum, "an older incompatible envelope cannot restore precision after sleep");
  clock.accept(serverAt + 600_000, 15_000);
  assert.equal(clock.now(), serverAt + 600_000);
  assert.equal(clock.freshnessNow(), serverAt + 615_000);
  clock.accept(serverAt + 700_000);
  assert.equal(clock.now(), serverAt + 700_000);
  assert.equal(clock.freshnessNow(), maximum, "an unmeasured forward sample cannot fabricate a zero-delay bound");
  clock.accept(serverAt + 700_000, 25);
  assert.equal(clock.freshnessNow(), serverAt + 700_025);
});

test("invalid transit intervals cannot mutate either clock, and legacy samples keep their existing fallback", () => {
  let elapsed = 0;
  const clock = createEvidenceClock({ monotonicNow: () => elapsed });
  clock.accept(serverAt, 20);
  for (const value of [null, "0", -1, NaN, Infinity, 8_640_000_000_000_001]) {
    assert.throws(() => clock.accept(serverAt + 90_000, value as number), RangeError);
    assert.equal(clock.now(), serverAt);
    assert.equal(clock.freshnessNow(), serverAt + 20);
    assert.equal(clock.trusted, true);
  }
  clock.suspend();
  assert.throws(() => clock.accept(serverAt + 90_000, NaN), RangeError);
  assert.equal(clock.trusted, false);
  const legacy = createEvidenceClock({ monotonicNow: () => elapsed });
  legacy.accept(serverAt);
  elapsed = 1_000;
  assert.equal(legacy.freshnessNow(), legacy.now());
  legacy.suspend();
  legacy.accept(serverAt + 1_000);
  assert.equal(legacy.freshnessNow(), legacy.now());
});

test("freshness bounds round outward, survive elapsed-clock rollback and stay within the Date range", () => {
  let elapsed = 100;
  const clock = createEvidenceClock({ monotonicNow: () => elapsed });
  clock.accept(serverAt, 0.25);
  assert.equal(clock.freshnessNow(), serverAt + 1);
  elapsed += 100.25;
  assert.equal(clock.now(), serverAt + 100);
  assert.equal(clock.freshnessNow(), serverAt + 102);
  elapsed -= 50;
  assert.equal(clock.now(), serverAt + 100);
  assert.equal(clock.freshnessNow(), serverAt + 102);
  clock.accept(8_640_000_000_000_000 - 2, 2.5);
  assert.equal(clock.freshnessNow(), 8_640_000_000_000_000);
  elapsed += 1_000;
  assert.equal(clock.now(), 8_640_000_000_000_000);
  assert.equal(clock.freshnessNow(), 8_640_000_000_000_000);
});
