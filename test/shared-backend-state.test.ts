import assert from "node:assert/strict";
import { mkdtemp, rm, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { openSharedState } from "../src/backend/sqlite-state.ts";
import { createProviderCheckpoint } from "../scripts/provider-checkpoint.ts";
import { createJobProvider } from "../scripts/jobs.ts";
import { createNodeInfoProvider } from "../scripts/node-info.ts";
import { createSolanaRpc, SolanaRpcError } from "../scripts/solana-rpc.ts";
import { emptyFleetSnapshots } from "../src/server/snapshot-store.ts";
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
