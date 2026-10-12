import assert from "node:assert/strict";
import { test } from "node:test";
import { compareNosAmounts, formatNos, isNosAmount, isNosRecord, NOS_MINT } from "../src/fleet/nos.ts";

test("NOS formatting rounds whole tokens at the half boundary while exact details retain six decimals", () => {
  for (const [amount, compact, exact] of [
    ["0", "0", "0"], ["1", "0", "0.000001"], ["499999", "0", "0.499999"],
    ["500000", "1", "0.5"], ["999999", "1", "0.999999"], ["1499999", "1", "1.499999"],
    ["1500000", "2", "1.5"], ["9007199254740993", "9007199255", "9007199254.740993"],
    ["18446744073709551615", "18446744073710", "18446744073709.551615"],
  ] as const) {
    assert.equal(formatNos(amount), compact);
    assert.equal(formatNos(amount, false), exact);
  }
  assert.equal(formatNos(null), "—");
  assert.equal(formatNos(undefined), "—");
  for (const value of ["00", "-1", "1.0", "1e3", "18446744073709551616", 1, NaN]) assert.equal(isNosAmount(value), false);
  assert.equal(compareNosAmounts("9007199254740992", "9007199254740993"), -1);
  assert.equal(compareNosAmounts("2", "1"), 1);
  assert.equal(compareNosAmounts("0", "0"), 0);
  assert.equal(compareNosAmounts(null, "0"), 1);
  assert.equal(compareNosAmounts("0", undefined), -1);
  assert.equal(compareNosAmounts(null, undefined), 0);
});

test("NOS browser validation requires account scope, exact amounts and original freshness evidence", () => {
  const row = { address: "11111111111111111111111111111111", tokenAccount: "11111111111111111111111111111112",
    mint: NOS_MINT, amount: "0", decimals: 6, accountState: "initialized", provider: "fixture",
    endpoint: "https://example.invalid", contextSlot: 3, blockTimeMs: 1000, checkedAtMs: 1001,
    validUntilMs: 181001, retained: false, error: null, retryAtMs: null };
  assert(isNosRecord(row));
  assert(isNosRecord({ ...row, accountState: "absent" }));
  assert(isNosRecord({ ...row, accountState: "frozen", amount: "42" }));
  for (const invalid of [
    { amount: 0 }, { address: "invalid" }, { tokenAccount: null }, { tokenAccount: "bad" },
    { mint: row.address }, { decimals: 9 }, { accountState: "uninitialized" },
    { accountState: "absent", amount: "1" }, { accountState: null }, { checkedAtMs: null },
    { contextSlot: 0.1 }, { provider: null }, { validUntilMs: row.validUntilMs + 1 },
    { retryAtMs: 8_640_000_000_000_001 },
  ]) assert(!isNosRecord({ ...row, ...invalid }), JSON.stringify(invalid));
  assert(isNosRecord({ ...row, amount: null, tokenAccount: null, accountState: null,
    provider: null, checkedAtMs: null, validUntilMs: null }));
});
