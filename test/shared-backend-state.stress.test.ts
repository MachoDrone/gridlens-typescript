import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { openSharedState } from "../src/backend/sqlite-state.ts";
import { createSharedCollector } from "../src/backend/collector.ts";
import { createProviderCheckpoint } from "../scripts/provider-checkpoint.ts";
import { createJobProvider } from "../scripts/jobs.ts";
import { SolanaRequestBudget } from "../scripts/solana-rpc.ts";
import { emptyFleetSnapshots } from "../src/server/snapshot-store.ts";
import { createSnapshotSource } from "../src/server/snapshot-source.ts";
import type { FleetContext } from "../src/contracts/fleet.ts";

function address(n: number): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = n, encoded = "";
  while (value) { encoded = alphabet[value % 58]! + encoded; value = Math.floor(value / 58); }
  return "1".repeat(32 - Math.ceil(Math.log2(n + 1) / 8)) + encoded;
}
const host = address(1);
const context: FleetContext = { scopeId: "synthetic", rosterRevision: "one", addresses: [host] };
const base = 1_800_000_000_000;

test("240 hosts warm with no viewers; both clients read identical dated cache without dispatch and revocation stops collection", async () => {
  const root = await mkdtemp(join(tmpdir(), "gridlens-collector-"));
  let time = base, reads = 0;
  const large: FleetContext = { ...context, addresses: Array.from({ length: 240 }, (_, i) => address(i + 1)) };
  let rosters = [large];
  let state = openSharedState(root, { now: () => time });
  const make = () => createSharedCollector({ state, contexts: () => rosters, now: () => time,
    read: async (resource, addresses) => {
      reads++;
      const snapshots = emptyFleetSnapshots(addresses);
      snapshots.metadata.hosts.forEach(row => { row.fetchedAtMs = time; });
      return snapshots[resource];
    } });
  let collector = make();
  try {
    await collector.tick();
    const observedAt = (await state.snapshots.read(large)).snapshots.metadata.hosts[0]!.fetchedAtMs;
    assert.equal(observedAt, base); assert.equal(reads, 7);
    const browser = createSnapshotSource(state.snapshots, { now: () => time });
    const phone = createSnapshotSource(state.snapshots, { now: () => time });
    for (let minute = 0; minute < 48 * 60; minute += 5) {
      time += 300_000;
      await collector.tick();
      const beforeReads: number = reads;
      assert.deepEqual(await browser.read("metadata", large, new AbortController().signal),
        await phone.read("metadata", large, new AbortController().signal));
      assert.equal(reads, beforeReads);
    }
    await collector.stop(); await state.close();
    state = openSharedState(root, { now: () => time }); collector = make();
    const beforeRestart = reads; await collector.tick(); assert.equal(reads, beforeRestart);
    const last = (await state.snapshots.read(large)).snapshots.metadata.hosts[0]!.fetchedAtMs;
    rosters = []; time += 600_000; await collector.tick(); assert.equal(reads, beforeRestart);
    assert.equal((await state.snapshots.read(large)).snapshots.metadata.hosts[0]!.fetchedAtMs, last);
  } finally { await collector.stop(); await state.close(); await rm(root, { recursive: true, force: true }); }
});

test("240-host actual job reader keeps identical observations and all budgets across 48 hours with hourly owner restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "gridlens-48h-durable-"));
  let time = base;
  let state = openSharedState(root, { now: () => time });
  const trace: number[] = [], baselineTrace: number[] = [];
  const addresses = Array.from({ length: 240 }, (_, i) => address(i + 1));
  const fetchFor = (output: number[]): typeof fetch => async () => { output.push(time); return Response.json({ jobs: [], totalJobs: 0 }); };
  const baseline = createJobProvider({ now: () => time, fetch: fetchFor(baselineTrace) });
  const make = () => createJobProvider({ now: () => time, fetch: fetchFor(trace), checkpoint: createProviderCheckpoint(state, "jobs") });
  let provider = make();
  let nextJobsAt = base;
  const rpcTrace: number[] = [], baselineRpcTrace: number[] = [];
  const baselineRpc = new SolanaRequestBudget();
  let rpcBudget = new SolanaRequestBudget([], dispatches => state.set("test/rpc-budget", dispatches));
  try {
    for (let second = 0; second < 48 * 3600; second += 30) {
      time = base + second * 1000;
      if (second > 0 && second % 3600 === 0) {
        await state.close(); state = openSharedState(root, { now: () => time }); provider = make();
        rpcBudget = new SolanaRequestBudget(state.get<number[]>("test/rpc-budget") ?? [], dispatches => state.set("test/rpc-budget", dispatches));
      }
      const due = time >= nextJobsAt;
      const actual = due ? await provider(addresses) : provider.peek!(addresses);
      const expected = due ? await baseline(addresses) : baseline.peek!(addresses);
      if (due) nextJobsAt = Math.max(time + 1000, actual.nextRefreshAtMs ?? time + 120_000);
      assert.deepEqual(actual, expected, `job evidence and eligibility differ at second ${second}`);
      // Multiple cache-only consumers never acquire dispatch capacity.
      const before: number = trace.length;
      assert.deepEqual(provider.peek!(addresses).hosts, provider.peek!(addresses).hosts);
      assert.equal(trace.length, before);
      // Saturate the actual shared rolling RPC-budget implementation from a
      // 30-second test step: this reaches minute/hour/day limits independently.
      for (let offset = 0; offset < 30; offset++) {
        const at = time + offset * 1000;
        const accepted = rpcBudget.reserve(at), baselineAccepted = baselineRpc.reserve(at);
        assert.equal(accepted, baselineAccepted);
        if (accepted) rpcTrace.push(at); if (baselineAccepted) baselineRpcTrace.push(at);
      }
    }
    assert.deepEqual(trace, baselineTrace); assert.deepEqual(rpcTrace, baselineRpcTrace);
    assert(trace.length >= 1000 && trace.length <= 1800, `two-day actual discoveries remain bounded under sustained demand (${trace.length})`);
    for (let index = 0; index < trace.length; index++) {
      for (const [count, window] of [[14, 30_000], [336, 3_600_000], [900, 86_400_000]] as const) {
        if (index >= count) assert(trace[index]! - trace[index - count]! >= window);
      }
    }
    for (let index = 0; index < rpcTrace.length; index++) {
      for (const [count, window] of [[1, 1000], [12, 60_000], [600, 3_600_000], [12000, 86_400_000]] as const) {
        if (index >= count) assert(rpcTrace[index]! - rpcTrace[index - count]! >= window);
      }
    }
  } finally { await state.close(); await rm(root, { recursive: true, force: true }); }
});
