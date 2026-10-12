import assert from "node:assert/strict";
import { test } from "node:test";
import { compareSolLamports, formatSol, isLamports, isSolRecord } from "../src/fleet/sol.ts";

test("SOL formatting and sorting preserve integer precision and confirmed zero", () => {
  assert.equal(formatSol(null), "—");
  assert.equal(formatSol("0"), "0.000");
  assert.equal(formatSol("5000000"), "0.005");
  assert.equal(formatSol("4900000"), "0.004");
  assert.equal(formatSol("4999999"), "0.004");
  assert.equal(formatSol("4900000", false), "0.0049");
  assert.equal(formatSol("1000049999"), "1.000");
  assert.equal(formatSol("1000050000"), "1.000");
  assert.equal(formatSol("999999999"), "0.999");
  assert.equal(formatSol("18446744073709551615"), "18446744073.709");
  assert.equal(formatSol("18446744073709551615", false), "18446744073.709551615");
  assert.equal(formatSol("9007199254740993", false), "9007199.254740993");
  assert.equal(formatSol("0", false), "0");
  assert.equal(compareSolLamports("9007199254740992", "9007199254740993"), -1);
  assert.equal(compareSolLamports("2", "1"), 1);
  assert.equal(compareSolLamports(null, "0"), 1);
  assert.equal(compareSolLamports("0", undefined), -1);
  assert.equal(compareSolLamports(null, undefined), 0);
  for (const value of ["00", "-1", "1.0", "1e3", "18446744073709551616", 1, NaN]) assert.equal(isLamports(value), false);
});

test("SOL browser record validation requires exact public identity and evidence for amounts", () => {
  const row = { address: "11111111111111111111111111111111", lamports: "0", provider: "fixture",
    endpoint: "https://example.invalid", contextSlot: 3, blockTimeMs: 1000, checkedAtMs: 1001,
    validUntilMs: 61001, retained: false, error: null, retryAtMs: null };
  assert(isSolRecord(row));
  assert(!isSolRecord({ ...row, lamports: 0 }));
  assert(!isSolRecord({ ...row, address: "invalid" }));
  assert(!isSolRecord({ ...row, checkedAtMs: null }));
  assert(!isSolRecord({ ...row, contextSlot: 0.1 }));
  assert(!isSolRecord({ ...row, provider: null }));
  assert(!isSolRecord({ ...row, validUntilMs: row.validUntilMs + 1 }));
  assert(!isSolRecord({ ...row, retryAtMs: 8_640_000_000_000_001 }));
  assert(isSolRecord({ ...row, lamports: null, provider: null, checkedAtMs: null, validUntilMs: null }));
});
