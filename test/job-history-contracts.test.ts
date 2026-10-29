import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isFleetSnapshot } from "../src/contracts/fleet.ts";
import type { FleetContext } from "../src/contracts/fleet.ts";
import { blankJobHistoryRecord, isJobHistoryRecord, JOB_HISTORY_CACHE_MS, normalizeJobHistoryItem } from "../src/fleet/job-history.ts";
import type { JobHistoryItem, JobHistorySnapshot } from "../src/fleet/job-history.ts";
import { createMemorySnapshotStore, emptyFleetSnapshots, normalizeFleetSnapshot, restoreFleetSnapshots } from "../src/server/snapshot-store.ts";
import { createSnapshotSource } from "../src/server/snapshot-source.ts";
import { createFileSnapshotStore } from "../src/server/file-snapshot-store.ts";
import { SYNTHETIC_HOST_ADDRESSES } from "./fixtures/host-addresses.ts";

const addresses = SYNTHETIC_HOST_ADDRESSES.slice(0, 2);
const context: FleetContext = { scopeId: "history-contracts", rosterRevision: "v1", addresses };
const at = 1_800_000_000_000;
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function item(index = 0, overrides: Partial<JobHistoryItem> = {}): JobHistoryItem {
  return { address: "1".repeat(30) + "B" + alphabet[index], node: addresses[0]!, state: "COMPLETED",
    timeStart: at / 1000 - 1000 + index * 10, timeEnd: at / 1000 - 995 + index * 10,
    timeout: 600, result: "success", checkedAtMs: at,
    marketAddress: null, usdRewardPerHour: null, marketName: null, marketUsdRewardPerHour: null,
    marketCheckedAtMs: null, marketValidUntilMs: null, ...overrides };
}
function history(items = [item()], checkedAtMs: number | null = at): JobHistorySnapshot {
  return { hosts: [{ ...blankJobHistoryRecord(addresses[0]!), jobs: items,
    checkedAtMs, totalJobs: checkedAtMs === null ? null : 20,
    validUntilMs: checkedAtMs === null ? null : checkedAtMs + JOB_HISTORY_CACHE_MS }, blankJobHistoryRecord(addresses[1]!)],
  nextRefreshAtMs: null };
}

test("history normalizes only selected fields and never infers execution success from lifecycle", () => {
  const payload = { ...item(), state: 2, jobStatus: "failed", definition: { secret: "must be discarded" },
    results: { secret: "must also be discarded" }, authorization: "not retained" };
  const normalized = normalizeJobHistoryItem(payload, at);
  assert.deepEqual(normalized, item(0, { result: "failed" }));
  assert.equal(normalized.state, "COMPLETED");
  for (const jobStatus of [undefined, null, "pending", "SUCCESS", false, {}]) {
    assert.equal(normalizeJobHistoryItem({ ...payload, jobStatus }, at).result, null);
  }
  assert.equal(normalizeJobHistoryItem({ ...payload, jobStatus: "success" }, at).result, "success");
  assert.deepEqual(normalizeJobHistoryItem({ address: item().address, node: addresses[0], state: "STOPPED" }, at),
    item(0, { state: "STOPPED", timeStart: null, timeEnd: null, timeout: null, result: null }));
  assert.equal(normalizeJobHistoryItem({ ...payload, timeEnd: 0 }, at).timeEnd, 0);
});

test("history rejects malformed identities, lifecycle, clocks and backwards or future timing", () => {
  const payload = item();
  for (const patch of [{ address: "invalid" }, { node: "invalid" }, { state: "SUCCEEDED" }, { state: 4 },
    { state: -1 }, { state: 1.5 }, { timeStart: "1000" }, { timeStart: -1 }, { timeStart: Infinity },
    { timeEnd: NaN }, { timeout: -1 }, { timeout: 0.5 }, { timeStart: Number.MAX_SAFE_INTEGER },
    { timeStart: at / 1000 + 16 }, { timeEnd: at / 1000 + 16 }, { timeEnd: payload.timeStart! - 1 }]) {
    assert.throws(() => normalizeJobHistoryItem({ ...payload, ...patch }, at), /invalid/);
  }
  for (const time of [-1, NaN, Infinity, at + 0.5]) assert.throws(() => normalizeJobHistoryItem(payload, time), /invalid/);
});

test("job price normalization preserves positive decimal rates and treats absent, default or malformed rates as unknown", () => {
  const payload = { ...item(), market: addresses[1], usdRewardPerHour: 0.123456789012345,
    price: 500, jobDefinition: { secret: "discard" }, marketName: "untrusted embedded label" };
  const normalized = normalizeJobHistoryItem(payload, at);
  assert.equal(normalized.marketAddress, addresses[1]);
  assert.equal(normalized.usdRewardPerHour, payload.usdRewardPerHour);
  assert.equal(normalized.marketName, null, "job payload cannot impersonate independently checked market metadata");
  for (const rate of [undefined, null, 0, -1, NaN, Infinity, "0.123", {}, Number.MAX_VALUE]) {
    assert.equal(normalizeJobHistoryItem({ ...payload, usdRewardPerHour: rate }, at).usdRewardPerHour, null);
  }
  assert.equal(normalizeJobHistoryItem({ ...payload, market: "invalid" }, at).marketAddress, null);
  assert.equal(JSON.stringify(normalized).includes("secret"), false);
});

test("optional history price/market fields accept old snapshots but reject malformed associations and independent clocks", () => {
  const old = item();
  for (const field of ["marketAddress", "usdRewardPerHour", "marketName", "marketUsdRewardPerHour", "marketCheckedAtMs", "marketValidUntilMs"] as const) delete old[field];
  assert(isJobHistoryRecord(history([old]).hosts[0]));
  assert.deepEqual(normalizeFleetSnapshot("job-history", history([old]), addresses), history());
  const enriched = item(0, { marketAddress: addresses[1]!, usdRewardPerHour: 0.123456789,
    marketName: "Synthetic GPU", marketUsdRewardPerHour: 0.25, marketCheckedAtMs: at + 10,
    marketValidUntilMs: at + 10 + JOB_HISTORY_CACHE_MS });
  assert(isJobHistoryRecord(history([enriched]).hosts[0]));
  for (const patch of [{ marketAddress: "bad" }, { marketAddress: null }, { marketName: "bad\nname" },
    { marketName: "x".repeat(257) }, { usdRewardPerHour: 0 }, { marketUsdRewardPerHour: -1 },
    { marketCheckedAtMs: null }, { marketCheckedAtMs: at + 0.5 }, { marketValidUntilMs: null },
    { marketValidUntilMs: at + 10 }, { marketValidUntilMs: at + 11 + JOB_HISTORY_CACHE_MS }]) {
    assert.equal(isJobHistoryRecord(history([{ ...enriched, ...patch }]).hosts[0]), false, JSON.stringify(patch));
  }
});

test("market enrichment has its own store clock and cannot renew or rewrite either job or page evidence", async t => {
  const store = createMemorySnapshotStore({ now: () => at + 60_000 });
  t.after(() => store.close());
  const initial = item(0, { marketAddress: addresses[1]!, usdRewardPerHour: 0.2 });
  await store.commit(context, { "job-history": history([initial]) }, 0);
  const enriched = { ...initial, marketName: "Synthetic GPU", marketUsdRewardPerHour: 0.3,
    marketCheckedAtMs: at + 1000, marketValidUntilMs: at + 1000 + JOB_HISTORY_CACHE_MS };
  const stored = await store.commit(context, { "job-history": history([enriched]) }, 1);
  assert.equal(stored.snapshots["job-history"].hosts[0]!.checkedAtMs, at);
  assert.equal(stored.snapshots["job-history"].hosts[0]!.jobs[0]!.checkedAtMs, at);
  for (const patch of [{ marketName: "Changed" }, { marketUsdRewardPerHour: 0.4 },
    { marketCheckedAtMs: at, marketValidUntilMs: at + JOB_HISTORY_CACHE_MS },
    { marketCheckedAtMs: null, marketValidUntilMs: null, marketName: null, marketUsdRewardPerHour: null },
    { usdRewardPerHour: 0.4 }, { marketAddress: addresses[0]! }]) {
    await assert.rejects(store.commit(context, { "job-history": history([{ ...enriched, ...patch }]) }, 2), { kind: "stale" });
  }
  await assert.rejects(store.commit(context, { "job-history": history([{ ...enriched,
    marketCheckedAtMs: at + 75_001, marketValidUntilMs: at + 75_001 + JOB_HISTORY_CACHE_MS }]) }, 2), { kind: "invalid" });
  const refreshed = { ...enriched, marketName: "New synthetic label", marketUsdRewardPerHour: 0.4,
    marketCheckedAtMs: at + 2000, marketValidUntilMs: at + 2000 + JOB_HISTORY_CACHE_MS };
  await store.commit(context, { "job-history": history([refreshed]) }, 2);
});

test("history validates bounded exact host/job identity and preserves unknown coverage independently of item observations", () => {
  const observed = history([item()], null);
  assert(isFleetSnapshot("job-history", observed, addresses));
  assert.equal(observed.hosts[0]!.checkedAtMs, null);
  assert(isFleetSnapshot("job-history", history(), addresses));
  const row = history().hosts[0]!;
  for (const patch of [{ jobs: [...Array.from({ length: 11 }, (_, index) => item(index))] },
    { jobs: [item(), item()] }, { jobs: [item(0, { node: addresses[1]! })] },
    { jobs: [item(0, { result: "unknown" as JobHistoryItem["result"] })] },
    { totalJobs: -1 }, { checkedAtMs: null }, { validUntilMs: at + JOB_HISTORY_CACHE_MS + 1 },
    { validUntilMs: at }, { checkedAtMs: at + 0.5 }, { error: "x".repeat(1025) }]) {
    assert.equal(isJobHistoryRecord({ ...row, ...patch }), false);
  }
  const conflicting = history();
  conflicting.hosts[1]!.jobs = [item(0, { node: addresses[1]! })];
  assert.equal(isFleetSnapshot("job-history", conflicting, addresses), false);
  assert.equal(isFleetSnapshot("job-history", history(), [addresses[0]!]), false);
  const normalized = normalizeFleetSnapshot("job-history", { ...history(), raw: "discard",
    hosts: history().hosts.map(row => ({ ...row, raw: "discard", jobs: row.jobs.map(job => ({ ...job, results: "discard" })) })) }, addresses);
  assert.deepEqual(normalized, history());
});

test("schema 1 snapshots without history restore unknowns while present malformed history fails closed", () => {
  const snapshots: Record<string, unknown> = { ...emptyFleetSnapshots(addresses) };
  delete snapshots["job-history"];
  const stored = { schemaVersion: 1, context, revision: 4, snapshots };
  const restored = restoreFleetSnapshots([stored], { now: () => at });
  assert.deepEqual(restored[0]!.snapshots["job-history"], emptyFleetSnapshots(addresses)["job-history"]);
  assert.equal(restored[0]!.revision, 4);
  for (const value of [undefined, null, {}, { hosts: [] }, { ...history(), hosts: [history().hosts[0]] }]) {
    assert.throws(() => restoreFleetSnapshots([{ ...stored, snapshots: { ...snapshots, "job-history": value } }], { now: () => at }), { kind: "invalid" });
  }
});

test("history store preserves separate page/item clocks and refuses evidence regression or replayed success", async t => {
  const store = createMemorySnapshotStore({ now: () => at + 60_000 });
  t.after(() => store.close());
  await store.commit(context, { "job-history": history() }, 0);
  const enriched = history([item(0, { checkedAtMs: at + 1000, result: "failed" })]);
  await store.commit(context, { "job-history": enriched }, 1);
  const first = (await store.read(context)).snapshots["job-history"].hosts[0]!;
  assert.equal(first.checkedAtMs, at);
  assert.equal(first.jobs[0]!.checkedAtMs, at + 1000);
  for (const next of [history(), history([item(0, { checkedAtMs: at + 1000, result: "success" })]), history([], at),
    history([], at + 500),
    { ...enriched, hosts: enriched.hosts.map((row, i) => i === 0 ? { ...row, validUntilMs: row.validUntilMs! + 1 } : row) }]) {
    await assert.rejects(store.commit(context, { "job-history": next }, 2), error =>
      error instanceof Error && "kind" in error && ["stale", "invalid"].includes(error.kind as string));
  }
  const failed = structuredClone(enriched);
  failed.hosts[0]!.retained = true;
  failed.hosts[0]!.error = "History temporarily unavailable";
  await store.commit(context, { "job-history": failed }, 2);
  await assert.rejects(store.commit(context, { "job-history": enriched }, 3), { kind: "stale" });
  const recovered = history(enriched.hosts[0]!.jobs, at + 2000);
  assert.equal((await store.commit(context, { "job-history": recovered }, 3)).snapshots["job-history"].hosts[0]!.retained, false);
  const future = history([item(0, { checkedAtMs: at + 75_001 })], at + 2000);
  await assert.rejects(store.commit(context, { "job-history": future }, 4), { kind: "invalid" });
});

test("bounded history allows top-ten eviction and newer pages without allowing silent evidence erasure", async t => {
  const store = createMemorySnapshotStore({ now: () => at + 60_000 });
  t.after(() => store.close());
  const oldItems = Array.from({ length: 10 }, (_, index) => item(index));
  await store.commit(context, { "job-history": history(oldItems, null) }, 0);
  const nextItems = [...oldItems.slice(1), item(10, { checkedAtMs: at + 1000 })];
  await store.commit(context, { "job-history": history(nextItems, null) }, 1);
  await assert.rejects(store.commit(context, { "job-history": history(nextItems.slice(1), null) }, 2), { kind: "stale" });
  await assert.rejects(store.commit(context, { "job-history": history(oldItems, null) }, 2), { kind: "stale" });
  // A fresh complete page may legitimately replace membership or return fewer records.
  await store.commit(context, { "job-history": history([item(20)], at + 1000) }, 2);
  const emptyPage = history([], at + 2000);
  emptyPage.hosts[0]!.totalJobs = 0;
  await store.commit(context, { "job-history": emptyPage }, 3);
});

test("isolated history persistence and later reads retain original item, page and coverage observations", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-history-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await createFileSnapshotStore(directory, { now: () => at + 60_000 });
  try { await first.commit(context, { "job-history": history([item(0, { result: "failed" })]) }, 0); }
  finally { await first.close(); }
  const second = await createFileSnapshotStore(directory, { now: () => at + 86_400_000 });
  try {
    const source = createSnapshotSource(second, { now: () => at + 86_400_000 });
    const restored = await source.read("job-history", context, new AbortController().signal);
    assert.deepEqual(restored.hosts, history([item(0, { result: "failed" })]).hosts);
    assert(restored.nextRefreshAtMs! > at + 86_400_000);
    assert.equal((await second.read(context)).snapshots["job-history"].nextRefreshAtMs, null);
    assert.equal((await source.read("job-history", { ...context, scopeId: "another" }, new AbortController().signal)).hosts[0]!.jobs.length, 0);
  } finally { await second.close(); }
});
