import assert from "node:assert/strict";
import test from "node:test";
import { nextMarketMode, normalizeMarketMode, projectMarket } from "../src/fleet/market-display.ts";
import type { MarketDisplayMode, MarketObservation } from "../src/fleet/market-display.ts";

const nowMs = Date.UTC(2026, 0, 1, 12);
const observation: MarketObservation = Object.freeze({
  label: "sample-market-2", observedAtMs: nowMs - 15_000,
  freshUntilMs: nowMs + 60_000, stale: false,
});
const modes: readonly MarketDisplayMode[] = ["full", "compact"];

test("Market defaults to full and toggles through the two reference modes", () => {
  assert.equal(normalizeMarketMode(null), "full");
  assert.equal(nextMarketMode("full"), "compact");
  assert.equal(nextMarketMode("compact"), "full");
  for (const mode of modes) {
    assert.equal(normalizeMarketMode(mode), mode);
    assert.equal(nextMarketMode(nextMarketMode(mode)), mode);
  }
});

test("only the exact compact preference overrides full Market display", () => {
  for (const value of [undefined, null, "", "COMPACT", " compact ", "dot", "constructor", "__proto__", 1, false, {}, ["compact"]]) {
    assert.equal(normalizeMarketMode(value), "full", String(value));
  }
});

test("full and compact modes preserve complete market identity and source description", () => {
  const full = projectMarket(observation, "full", nowMs);
  const compact = projectMarket(observation, "compact", nowMs);
  assert.equal(full.text, "sample-market-2");
  assert.equal(compact.text, "sa");
  assert.equal(compact.fullLabel, full.text);
  assert.equal(full.freshness, "current");
  assert.equal(full.description, compact.description);
  assert.match(compact.description, /Current market association: sample-market-2/);
  assert.match(compact.description, /2026-01-01T11:59:45\.000Z/);
  assert.match(compact.description, /2026-01-01T12:01:00\.000Z/);
  assert.match(compact.description, /does not establish physical GPU identity/);
});

test("compact abbreviations are two Unicode code points, with short labels retained", () => {
  for (const [label, expected] of [["A", "A"], ["AI", "AI"], ["\u{1F680}X-market", "\u{1F680}X"], ["\u{1F680}", "\u{1F680}"], ["  R9-sample \n", "R9"]]) {
    const projected = projectMarket({ ...observation, label: label! }, "compact", nowMs);
    assert.equal(projected.text, expected);
    assert.equal(projected.fullLabel, label!.trim());
  }
});

test("colliding compact labels retain distinct full identities for sorting and details", () => {
  const first = projectMarket(observation, "compact", nowMs);
  const second = projectMarket({ ...observation, label: "sample-market-10" }, "compact", nowMs);
  assert.equal(first.text, second.text);
  assert.notEqual(first.fullLabel, second.fullLabel);
  assert.notEqual(first.description, second.description);
});

test("market text remains plain text without interpreting markup or numeric-looking labels", () => {
  for (const label of ["<b>sample</b>", "&sample;", "0", "false"]) {
    const view = projectMarket({ ...observation, label }, "full", nowMs);
    assert.equal(view.text, label);
    assert.equal(view.fullLabel, label);
    assert.equal(view.freshness, "current");
  }
});

test("missing or blank market associations remain unknown in both modes", () => {
  for (const candidate of [null, { ...observation, label: null }, { ...observation, label: "" }, { ...observation, label: " \t\n" }]) {
    for (const mode of modes) {
      const view = projectMarket(candidate, mode, nowMs);
      assert.equal(view.text, "—");
      assert.equal(view.fullLabel, null);
      assert.equal(view.freshness, "unknown");
      assert.equal(view.observedAtMs, candidate?.observedAtMs ?? null);
      assert.match(view.description, /Market unknown/);
    }
  }
});

test("market expires at its explicit deadline and retains the original label and timestamp", () => {
  const deadline = observation.freshUntilMs!;
  assert.equal(projectMarket(observation, "full", deadline - 1).freshness, "current");
  for (const at of [deadline, deadline + 1]) {
    const view = projectMarket(observation, "full", at);
    assert.equal(view.freshness, "retained");
    assert.equal(view.fullLabel, observation.label);
    assert.equal(view.observedAtMs, observation.observedAtMs);
    assert.match(view.description, /market evidence has expired/);
  }
});

test("missing, invalid or future source times retain known market labels honestly", () => {
  for (const observedAtMs of [null, Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5, 8_640_000_000_000_001, nowMs + 1]) {
    const view = projectMarket({ ...observation, observedAtMs }, "full", nowMs);
    assert.equal(view.freshness, "retained");
    assert.equal(view.text, observation.label);
    assert.equal(view.observedAtMs, observedAtMs);
    assert.match(view.description, /observation time is (missing or invalid|in the future)/);
  }
  assert.equal(projectMarket({ ...observation, observedAtMs: nowMs }, "full", nowMs).freshness, "current");
});

test("missing, invalid and nonforward expiries do not invent a market freshness window", () => {
  for (const freshUntilMs of [null, Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5, 8_640_000_000_000_001, observation.observedAtMs!, observation.observedAtMs! - 1]) {
    const view = projectMarket({ ...observation, freshUntilMs }, "compact", nowMs);
    assert.equal(view.freshness, "retained");
    assert.equal(view.text, "sa");
    assert.match(view.description, /expiry (is missing or invalid|does not follow its observation)/);
  }
});

test("an explicitly stale market remains retained inside an otherwise valid interval", () => {
  const view = projectMarket({ ...observation, stale: true }, "full", nowMs);
  assert.equal(view.freshness, "retained");
  assert.match(view.description, /source marked this observation stale/);
});

test("projection is immutable and display changes or later reads never renew evidence", () => {
  const input = Object.freeze({ ...observation, label: "  sample-market-2  " });
  const original = { ...input };
  const full = projectMarket(input, "full", nowMs);
  const compact = projectMarket(input, "compact", nowMs + 30_000);
  const expired = projectMarket(input, "compact", nowMs + 60_000);
  assert.equal(full.fullLabel, "sample-market-2");
  assert.equal(compact.fullLabel, full.fullLabel);
  assert.equal(compact.description, full.description);
  assert.equal(expired.observedAtMs, full.observedAtMs);
  assert.equal(expired.freshness, "retained");
  assert.deepEqual(input, original);
});

test("projection accepts Date-range boundary times without imposing a fixed TTL", () => {
  const view = projectMarket({ ...observation, observedAtMs: 0, freshUntilMs: 8_640_000_000_000_000 }, "full", 0);
  assert.equal(view.freshness, "current");
  assert.match(view.description, /1970-01-01T00:00:00\.000Z/);
  assert.equal(projectMarket(null, "full", 8_640_000_000_000_000).freshness, "unknown");
});

test("invalid clocks are rejected even when no market is available", () => {
  for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5, 8_640_000_000_000_001]) {
    assert.throws(() => projectMarket(observation, "full", invalid), RangeError);
    assert.throws(() => projectMarket(null, "full", invalid), RangeError);
  }
});
