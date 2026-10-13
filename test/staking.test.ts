import assert from "node:assert/strict";
import { test } from "node:test";
import { blankStakingRecord, compareStakingAmounts, formatStakingAmount, isStakingAmount,
  isStakingRecord, STAKING_DISPLAY_VALIDITY_MS } from "../src/fleet/staking.ts";
import type { StakingRecord } from "../src/fleet/staking.ts";
import type { HostMetadataRecord } from "../src/fleet/host-metadata.ts";
import { projectStaking, STAKING_MARKET_VALIDITY_MS } from "../src/fleet/staking-view.ts";
import { sortFleetRows } from "../src/fleet/sort.ts";
import { SYNTHETIC_HOST_ADDRESSES as addresses } from "./fixtures/host-addresses.ts";

const NOW = 1_000_000;
function reading(amount = "1000000", target = "1000000"): StakingRecord {
  const row = blankStakingRecord(addresses[0]!);
  const evidence = { provider: "fixture", endpoint: "https://example.invalid", contextSlot: 3,
    blockTimeMs: NOW - 1_000, checkedAtMs: NOW, validUntilMs: NOW + STAKING_DISPLAY_VALIDITY_MS };
  row.stake = { ...row.stake, ...evidence, stakeAccount: addresses[1]!, vaultAccount: addresses[2]!,
    amount, recordedAmount: amount, xnos: amount, durationSeconds: "1209600", unstakeAtSeconds: "0", accountState: "initialized" };
  row.requirement = { ...row.requirement, ...evidence, marketAddress: addresses[3]!, targetAmount: target, xnosMinimum: target };
  row.marketAddress = addresses[3]!;
  row.marketFetchedAtMs = NOW;
  return row;
}
function metadata(marketAddress = addresses[3]!, fetchedAtMs = NOW): HostMetadataRecord {
  return { address: addresses[0]!, fetchedAtMs, retained: false, error: null, marketError: null,
    values: { marketAddress, marketLabel: "sample", status: null, ram: null, disk: null, cpu: null,
      cuda: null, nvidia: null, currentNode: null, system: null } };
}

test("staking rounds whole NOS half-up but keeps u128 exact details and threshold comparisons", () => {
  for (const [amount, compact, exact] of [
    ["0", "0", "0"], ["499999", "0", "0.499999"], ["500000", "1", "0.5"],
    ["1499999", "1", "1.499999"], ["1500000", "2", "1.5"],
    ["9007199254740993", "9007199255", "9007199254.740993"],
    ["340282366920938463463374607431768211455", "340282366920938463463374607431768", "340282366920938463463374607431768.211455"],
  ]) {
    assert.equal(formatStakingAmount(amount), compact);
    assert.equal(formatStakingAmount(amount, false), exact);
  }
  for (const value of [null, "00", "1e6", "-1", "1.0", 2, "340282366920938463463374607431768211456"]) {
    assert.equal(isStakingAmount(value), false);
    assert.equal(formatStakingAmount(value as string | null), "—");
  }
  assert.equal(compareStakingAmounts("9007199254740993", "9007199254740992"), 1);
  assert.equal(compareStakingAmounts(null, "0"), 1);
  for (const [amount, target, satisfied] of [
    ["1499999", "1500000", false], ["1500000", "1500000", true], ["1500001", "1500000", true],
    ["0", "0", true], ["9007199254740992", "9007199254740993", false],
  ] as const) assert.equal(projectStaking(reading(amount, target), metadata(), NOW).satisfied, satisfied);
});

test("staking record validation rejects incomplete identities, evidence and inconsistent zero or target claims", () => {
  const row = reading();
  assert(isStakingRecord(row));
  assert(isStakingRecord(blankStakingRecord(addresses[0]!)));
  for (const stake of [
    { amount: 0 }, { stakeAccount: null }, { vaultAccount: "invalid" }, { mint: addresses[0] },
    { accountState: "absent" }, { provider: null }, { checkedAtMs: null }, { validUntilMs: NOW + 1 },
    { recordedAmount: null }, { xnos: "1e3" },
  ]) assert(!isStakingRecord({ ...row, stake: { ...row.stake, ...stake } }), JSON.stringify(stake));
  assert(!isStakingRecord({ ...row, requirement: { ...row.requirement, xnosMinimum: "2" } }));
  assert(!isStakingRecord({ ...row, requirement: { ...row.requirement, marketAddress: null } }));
});

test("staking comparison gates the current market immediately, retains independent amount evidence and requires fresh metadata", () => {
  const row = reading();
  const changed = projectStaking(row, metadata(addresses[4]!), NOW);
  assert.equal(changed.amount, "1000000");
  assert.equal(changed.amountCurrent, true);
  assert.equal(changed.target, null);
  assert.equal(changed.satisfied, false);
  for (const report of [{ ...metadata(), retained: true }, { ...metadata(), error: "failed" },
    { ...metadata(), values: null }, metadata(addresses[3]!, NOW - STAKING_MARKET_VALIDITY_MS)]) {
    const view = projectStaking(row, report, NOW);
    assert.equal(view.satisfied, false);
    assert.equal(view.amountCurrent, true);
    assert.equal(view.targetCurrent, false);
  }
  const later = NOW + STAKING_MARKET_VALIDITY_MS;
  assert.equal(projectStaking(row, metadata(addresses[3]!, later), later).satisfied, true);
  assert.equal(projectStaking(row, metadata(), NOW, null, "metadata feed failed").satisfied, false);
  assert.equal(projectStaking(row, metadata(), NOW, "staking failed").amountCurrent, false);
});

test("staking and target expire independently at original 35-minute deadlines; failures cannot reactivate comparison", () => {
  const row = reading();
  row.requirement.checkedAtMs = NOW + 100;
  row.requirement.validUntilMs = NOW + STAKING_DISPLAY_VALIDITY_MS + 100;
  const at = NOW + STAKING_DISPLAY_VALIDITY_MS;
  assert(projectStaking(row, metadata(addresses[3]!, at), at - 1).satisfied);
  const view = projectStaking(row, metadata(addresses[3]!, at), at);
  assert.equal(view.amountCurrent, false);
  assert.equal(view.targetCurrent, true);
  assert.equal(view.satisfied, false);
  for (const part of ["stake", "requirement"] as const) {
    const retained = reading();
    retained[part].retained = true;
    retained[part].error = "read failed";
    assert.equal(projectStaking(retained, metadata(), NOW).satisfied, false);
  }
});

test("delivery uncertainty expires stake, target and market support independently without hiding their values", () => {
  for (const expiredPart of ["stake", "requirement"] as const) {
    const row = reading();
    row[expiredPart].checkedAtMs = NOW - 100;
    row[expiredPart].validUntilMs = NOW + STAKING_DISPLAY_VALIDITY_MS - 100;
    const at = NOW + STAKING_DISPLAY_VALIDITY_MS - 200;
    const report = metadata(addresses[3]!, at);
    const before = structuredClone({ row, report });
    assert.equal(projectStaking(row, report, at).comparisonCurrent, true);
    const view = projectStaking(row, report, at, null, null, at + 100);
    assert.equal(view.amountCurrent, expiredPart !== "stake");
    assert.equal(view.targetCurrent, expiredPart !== "requirement");
    assert.equal(view.marketCurrent, true);
    assert.equal(view.comparisonCurrent, false);
    assert.equal(view.satisfied, false);
    assert.equal(view.amount, row.stake.amount);
    assert.equal(view.target, row.requirement.targetAmount);
    assert.equal(view.nextExpiryAtMs, NOW + STAKING_DISPLAY_VALIDITY_MS);
    assert.deepEqual({ row, report }, before);
  }
  const row = reading();
  const expiredMarket = projectStaking(row, metadata(), NOW, null, null, NOW + STAKING_MARKET_VALIDITY_MS);
  assert.equal(expiredMarket.amountCurrent, true);
  assert.equal(expiredMarket.targetCurrent, false);
  assert.equal(expiredMarket.marketCurrent, false);
  assert.equal(expiredMarket.target, row.requirement.targetAmount);
  assert.equal(expiredMarket.nextExpiryAtMs, row.stake.validUntilMs);
  assert.deepEqual(projectStaking(row, metadata(), NOW, null, null, NOW - 1), projectStaking(row, metadata(), NOW));
});

test("freshness uncertainty cannot admit future stake, target or metadata beyond the existing tolerance", () => {
  for (const futurePart of ["stake", "requirement"] as const) {
    const row = reading();
    row[futurePart].checkedAtMs = NOW + 15_001;
    row[futurePart].validUntilMs = NOW + 15_001 + STAKING_DISPLAY_VALIDITY_MS;
    const view = projectStaking(row, metadata(), NOW, null, null, NOW + 20_000);
    assert.equal(futurePart === "stake" ? view.amountCurrent : view.targetCurrent, false);
    assert.equal(view.satisfied, false);
  }
  const view = projectStaking(reading(), metadata(addresses[3]!, NOW + 15_001), NOW, null, null, NOW + 20_000);
  assert.equal(view.marketCurrent, false);
  assert.equal(view.targetCurrent, false);
  assert.equal(view.amountCurrent, true);
});

test("vault withdrawals and unstaking preserve holdings semantics without presenting full eligibility", () => {
  const row = reading("0", "0");
  row.stake.recordedAmount = "3000000";
  row.stake.xnos = "6000000";
  row.stake.unstakeAtSeconds = "1767225600";
  assert.equal(projectStaking(row, metadata(), NOW).amount, "0");
  assert.equal(projectStaking(row, metadata(), NOW).satisfied, true);
  row.stake.amount = null;
  assert.equal(projectStaking(row, metadata(), NOW).satisfied, false);
});

test("Staked NOS sorting preserves exact base units beyond Number precision and puts unknown last both ways", () => {
  const rows = [null, "9007199254740993", "0", "9007199254740992"].map((amount, index) => ({
    id: index, pc: "", gpuIndex: null, containerName: "", stakedNosAmount: amount, values: {},
  }));
  assert.deepEqual(sortFleetRows(rows, { column: "stakedNos", direction: "asc" }).map(row => row.id), [2, 3, 1, 0]);
  assert.deepEqual(sortFleetRows(rows, { column: "stakedNos", direction: "desc" }).map(row => row.id), [1, 3, 2, 0]);
});
