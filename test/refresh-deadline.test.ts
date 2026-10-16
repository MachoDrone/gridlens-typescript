import assert from "node:assert/strict";
import { test } from "node:test";
import { createRefreshDeadlines } from "../src/preview/refresh-deadline.ts";

test("server calibration changes source deadlines without shortening local retry waits", () => {
  let epoch = 1_000, elapsed = 0;
  const deadlines = createRefreshDeadlines(() => epoch, () => elapsed);
  const local = deadlines.after(30_000);
  const source = deadlines.source(60_000)!;
  epoch = 100_000;
  elapsed = 5_000;
  assert.equal(deadlines.remaining(local), 25_000);
  assert.equal(deadlines.at(local), 125_000);
  assert.equal(deadlines.remaining(source), -5_000);
  assert.equal(deadlines.earlier(local, source), source);
  epoch = 500;
  assert.equal(deadlines.remaining(local), 25_000);
  assert.equal(deadlines.remaining(source), 59_500);
  assert.equal(deadlines.earlier(local, source), local);
});

test("source refreshes preserve their local minimum wait across a forward correction", () => {
  let epoch = 1_000, elapsed = 0;
  const deadlines = createRefreshDeadlines(() => epoch, () => elapsed);
  const source = deadlines.source(2_000, 1_000)!;
  epoch = 10_000;
  elapsed = 100;
  assert.equal(deadlines.remaining(source), 900);
  assert.equal(deadlines.source(null), null);
  assert.equal(deadlines.at(null), null);
  assert.equal(deadlines.earlier(null, source), source);
});
