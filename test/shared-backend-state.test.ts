import assert from "node:assert/strict";
import { mkdtemp, rm, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { openSharedState } from "../src/backend/sqlite-state.ts";
import { createSharedCollector } from "../src/backend/collector.ts";
import { createProviderCheckpoint } from "../scripts/provider-checkpoint.ts";
import { createJobProvider } from "../scripts/jobs.ts";
import { createNodeInfoProvider } from "../scripts/node-info.ts";
import { createSolanaRpc, SolanaRpcError, SolanaRequestBudget } from "../scripts/solana-rpc.ts";
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

test("SQLite admits one owner, restores original observations, and preserves ledger through matched cache rollback", async () => {
  const root = await mkdtemp(join(tmpdir(), "gridlens-state-"));
  const cache = join(root, "cache"), ledger = join(root, "ledger"), imageCheckpoint = join(root, "image-state.sqlite");
  let state = openSharedState(cache, { now: () => base, ledgerDirectory: ledger });
  try {
    assert.throws(() => openSharedState(cache, { ledgerDirectory: ledger }), /locked/);
    const snapshots = emptyFleetSnapshots([host]);
    snapshots.metadata.hosts[0]!.fetchedAtMs = base - 10_000;
    await state.snapshots.commit(context, snapshots, 0);
    await state.checkpoint(imageCheckpoint);
    state.set("access/device", { revoked: true, revision: 2 });
    state.set("provider/reservations", [base]);
    await state.close();
    await copyFile(imageCheckpoint, join(cache, "state.sqlite"));
    state = openSharedState(cache, { now: () => base, ledgerDirectory: ledger });
    assert.equal((await state.snapshots.read(context)).snapshots.metadata.hosts[0]!.fetchedAtMs, base - 10_000);
    assert.deepEqual(state.get("access/device"), { revoked: true, revision: 2 });
    assert.deepEqual(state.get("provider/reservations"), [base]);
    await assert.rejects(state.snapshots.read({ ...context, addresses: [address(2)] }), /revision/);
  } finally { await state.close(); await rm(root, { recursive: true, force: true }); }
});

test("job dispatch reservations and first/repeat histories survive owner restart without new allowance", async () => {
  const root = await mkdtemp(join(tmpdir(), "gridlens-jobs-durable-"));
  let time = base, calls = 0;
  let state = openSharedState(root, { now: () => time });
  const fakeFetch: typeof fetch = async () => { calls++; return Response.json({ jobs: [], totalJobs: 0 }); };
  const make = () => createJobProvider({ now: () => time, fetch: fakeFetch, checkpoint: createProviderCheckpoint(state, "jobs") });
  try {
    let provider = make();
    const hosts = Array.from({ length: 20 }, (_, i) => address(i + 1));
    const first = await provider(hosts);
    assert.equal(calls, 14);
    const original = first.hosts.filter(row => row.checkedAtMs !== null);
    await state.close(); state = openSharedState(root, { now: () => time }); provider = make();
    const replay = await provider(hosts);
    assert.equal(calls, 14, "restart cannot refill the rolling discovery budget");
    assert.deepEqual(replay.hosts.filter(row => row.checkedAtMs !== null), original);
    time += 30_001;
    await provider(hosts);
    assert.equal(calls, 20, "unattempted hosts keep first-read capacity and empty successes stay cached");
    const saved = createProviderCheckpoint(state, "jobs").read<{ dispatches: number[]; discoveryDispatches: number[] }>()!;
    assert.equal(saved.dispatches.length, 20); assert.equal(saved.discoveryDispatches.length, 20);
  } finally { await state.close(); await rm(root, { recursive: true, force: true }); }
});

test("Node retry failure history and original retained readings survive a restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "gridlens-nodes-durable-"));
  let time = base, calls = 0, failed = false;
  let state = openSharedState(root, { now: () => time });
  const make = () => createNodeInfoProvider({ now: () => time, checkpoint: createProviderCheckpoint(state, "nodes"),
    fetch: async () => { calls++; return failed ? new Response("busy", { status: 429, headers: { "Retry-After": "3600" } })
      : Response.json({ node: host, state: "QUEUED", info: { network: {} } }); } });
  try {
    let provider = make(); const first = await provider([host]);
    assert.equal(first.hosts[0]!.fetchedAtMs, base);
    time += 15_000; failed = true;
    await provider([host]); const failureCalls = calls;
    await state.close(); state = openSharedState(root, { now: () => time }); provider = make();
    time += 600_000;
    const retained = await provider([host]);
    assert.equal(calls, failureCalls);
    assert.equal(retained.hosts[0]!.fetchedAtMs, base);
    assert.equal(retained.hosts[0]!.retained, true);
  } finally { await state.close(); await rm(root, { recursive: true, force: true }); }
});

test("RPC pauses, permanent denials and shared method reservation persist across all asset sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "gridlens-rpc-durable-"));
  let state = openSharedState(root, { now: () => base });
  let calls = 0;
  const make = () => createSolanaRpc({ now: () => base, checkpoint: createProviderCheckpoint(state, "rpc"),
    fetch: async () => { calls++; return new Response("denied", { status: 403 }); } });
  try {
    let rpc = make(); const session = rpc.createSession("sol"), provider = session.eligible()!;
    await assert.rejects(rpc.rpc(provider, "getGenesisHash", [], new AbortController().signal, base + 28_000), error => {
      assert(error instanceof SolanaRpcError); session.failure(provider, error); return true;
    });
    await state.close(); state = openSharedState(root, { now: () => base }); rpc = make();
    const other = rpc.createSession("nos");
    assert.notEqual(other.eligible()!.endpoint, provider.endpoint);
    const persisted = createProviderCheckpoint(state, "rpc").read<{ dispatches: number[]; providers: { disabled: boolean }[] }>()!;
    assert.equal(persisted.providers[0]!.disabled, true); assert.deepEqual(persisted.dispatches, [base]);
    assert.equal(calls, 1);
  } finally { await state.close(); await rm(root, { recursive: true, force: true }); }
});

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
