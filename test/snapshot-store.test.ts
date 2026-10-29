import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { FLEET_RESOURCES, isFleetSnapshot } from "../src/contracts/fleet.ts";
import type { FleetContext } from "../src/contracts/fleet.ts";
import type { SolSnapshot } from "../src/fleet/sol.ts";
import type { NodeInfoSnapshot } from "../src/fleet/node-info.ts";
import { normalizeHostMetadata } from "../src/fleet/host-metadata.ts";
import { createMemorySnapshotStore, emptyFleetSnapshots, normalizeFleetSnapshot, restoreFleetSnapshots } from "../src/server/snapshot-store.ts";
import type { SnapshotUpdates, StoredFleetSnapshot } from "../src/server/snapshot-store.ts";
import type { FleetSnapshotStore } from "../src/server/snapshot-store.ts";
import { createSnapshotSource } from "../src/server/snapshot-source.ts";
import { createFileSnapshotStore } from "../src/server/file-snapshot-store.ts";
import { SYNTHETIC_HOST_ADDRESSES } from "./fixtures/host-addresses.ts";

const addresses = SYNTHETIC_HOST_ADDRESSES.slice(0, 2);
const context: FleetContext = { scopeId: "operator:one", rosterRevision: "roster:1", addresses };
const base = 1_800_000_000_000;
const signal = (): AbortSignal => new AbortController().signal;
function sol(at = base, lamports = "1234567", slot = 100): SolSnapshot {
  return { hosts: addresses.map(address => ({ address, lamports, provider: "Verified fixture", endpoint: "https://fixture.invalid/",
    contextSlot: slot, blockTimeMs: at - 1000, checkedAtMs: at, validUntilMs: at + 60_000,
    retained: false, error: null, retryAtMs: null })), nextRefreshAtMs: at + 30_000 };
}

test("an empty snapshot store serves valid unknowns and finite recheck plans without any upstream work", async () => {
  const store = createMemorySnapshotStore({ now: () => base + 86_400_000 });
  const source = createSnapshotSource(store, { now: () => base });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Snapshot reads must never construct or call public providers."); };
  try {
    for (const resource of FLEET_RESOURCES) {
      const snapshot = await source.read(resource, context, signal());
      assert(isFleetSnapshot(resource, snapshot, addresses));
      assert.deepEqual(snapshot.hosts.map(row => row.address), addresses);
      if ("nextRefreshAtMs" in snapshot) assert(snapshot.nextRefreshAtMs! > base);
    }
    assert.equal((await store.read(context)).revision, 0);
  } finally { globalThis.fetch = originalFetch; await store.close(); }
});

test("two source instances share committed bulk observations; cache checks never renew source times", async () => {
  const store = createMemorySnapshotStore({ now: () => base + 86_400_000 });
  let time = base;
  const first = createSnapshotSource(store, { now: () => time });
  const second = createSnapshotSource(store, { now: () => time });
  const measurement = sol();
  await store.commit(context, { sol: measurement }, 0);
  assert.deepEqual(await first.read("sol", context, signal()), await second.read("sol", context, signal()));
  time += 24 * 60 * 60_000;
  const restored = await second.read("sol", context, signal());
  assert.deepEqual(restored.hosts, measurement.hosts);
  assert(restored.hosts.every(row => row.validUntilMs! < time));
  assert.equal(restored.nextRefreshAtMs, time + 30_000);
  assert.equal((await store.read(context)).snapshots.sol.nextRefreshAtMs, base + 30_000,
    "a viewer recheck plan must not mutate the stored provider schedule");
  measurement.hosts[0]!.lamports = "0";
  restored.hosts[0]!.lamports = "0";
  assert.equal((await store.read(context)).snapshots.sol.hosts[0]!.lamports, "1234567");
  await store.close();
});

test("scope and roster revisions isolate cached observations and pin exact membership before the first write", async () => {
  const store = createMemorySnapshotStore({ now: () => base + 86_400_000 });
  await store.read(context);
  await assert.rejects(store.commit({ ...context, addresses: [addresses[0]!] }, { sol: { ...sol(), hosts: [sol().hosts[0]!] } }, 0), { kind: "conflict" });
  await store.commit(context, { sol: sol() }, 0);
  for (const other of [{ ...context, scopeId: "operator:two" }, { ...context, rosterRevision: "roster:2" }]) {
    const result = await store.read(other);
    assert.equal(result.revision, 0);
    assert(result.snapshots.sol.hosts.every(row => row.lamports === null));
  }
  await assert.rejects(store.read({ ...context, addresses: [...addresses].reverse() }), { kind: "conflict" });
  await assert.rejects(store.read({ ...context, addresses: ["invalid"] }), { kind: "invalid" });
  await store.close();
});

test("concurrent writes use compare-and-swap and a failed durability hook publishes nothing", async () => {
  let release!: () => void;
  let writing = false;
  const store = createMemorySnapshotStore({ now: () => base + 86_400_000, persist: async () => { writing = true; await new Promise<void>(resolve => { release = resolve; }); } });
  const first = store.commit(context, { sol: sol() }, 0);
  const second = store.commit(context, { sol: sol(base + 1000) }, 0);
  const rejected = assert.rejects(second, { kind: "conflict" });
  while (!writing) await Promise.resolve();
  assert.equal((await store.read(context)).revision, 0, "unflushed state is not observable");
  release();
  assert.equal((await first).revision, 1);
  await rejected;
  await store.close();
  const failing = createMemorySnapshotStore({ now: () => base + 86_400_000, persist: async () => { throw new Error("isolated disk failure"); } });
  await assert.rejects(failing.commit(context, { sol: sol() }, 0), /disk failure/);
  await assert.rejects(failing.read(context), { kind: "closed" });
  await failing.close();
});

test("an ambiguous durable flush poisons reads, queued writers and watches until validated reopening", async () => {
  let durable: readonly StoredFleetSnapshot[] = [];
  let writes = 0;
  const store = createMemorySnapshotStore({ now: () => base + 86_400_000, persist: async snapshots => {
    writes++;
    durable = structuredClone(snapshots); // Model rename success before directory fsync failure.
    throw new Error("isolated directory flush failure");
  } });
  const observed: number[] = [];
  const watch = store.subscribe(context, signal(), update => { observed.push(update.revision); });
  const disconnected = assert.rejects(watch, { kind: "closed" });
  const first = assert.rejects(store.commit(context, { sol: sol() }, 0), /directory flush/);
  const queued = assert.rejects(store.commit(context, { sol: sol(base + 1) }, 0), { kind: "closed" });
  await Promise.all([first, queued, disconnected]);
  assert.deepEqual(observed, [0], "the failed commit never publishes possibly non-durable evidence");
  assert.equal(writes, 1, "a queued writer cannot reuse an uncertain CAS version");
  await assert.rejects(store.read(context), { kind: "closed" });
  await assert.rejects(store.commit(context, { sol: sol(base + 2) }, 0), { kind: "closed" });
  await store.close();
  const reopened = createMemorySnapshotStore({ now: () => base + 86_400_000, initial: durable });
  assert.equal((await reopened.read(context)).revision, 1);
  await assert.rejects(reopened.commit(context, { sol: sol(base + 2) }, 0), { kind: "conflict" });
  assert.equal((await reopened.commit(context, { sol: sol(base + 2) }, 1)).revision, 2);
  await reopened.close();
});

test("older source clocks, changed same-time amounts, erased proof and regressing slots cannot replace newer evidence", async () => {
  const store = createMemorySnapshotStore({ now: () => base + 86_400_000 });
  await store.commit(context, { sol: sol() }, 0);
  for (const update of [sol(base - 1), sol(base, "99"), sol(base + 1, "99", 99), emptyFleetSnapshots(addresses).sol]) {
    await assert.rejects(store.commit(context, { sol: update }, 1), { kind: "stale" });
    assert.equal((await store.read(context)).revision, 1);
  }
  const failed = sol();
  failed.hosts = failed.hosts.map(row => ({ ...row, retained: true, error: "Source temporarily unavailable" }));
  const retained = await store.commit(context, { sol: failed }, 1);
  assert.equal(retained.snapshots.sol.hosts[0]!.checkedAtMs, base);
  assert.equal(retained.snapshots.sol.hosts[0]!.validUntilMs, base + 60_000);
  assert.equal((await store.commit(context, { sol: sol(base + 1, "0", 101) }, 2)).snapshots.sol.hosts[0]!.lamports, "0");
  await store.close();
});

test("metadata label enrichment preserves the original measurement while changed hardware needs new proof", async () => {
  const store = createMemorySnapshotStore({ now: () => base + 86_400_000 });
  const metadata = { hosts: addresses.map(address => ({ address, fetchedAtMs: base, retained: false, error: null, marketError: null,
    values: { status: "PREMIUM", marketAddress: addresses[0]!, marketLabel: null as string | null,
      ram: 32, disk: 100, cpu: null, cuda: null, nvidia: null, currentNode: null, system: null } })) };
  await store.commit(context, { metadata }, 0);
  metadata.hosts[0]!.values.marketLabel = "Verified fixture market";
  const enriched = await store.commit(context, { metadata }, 1);
  assert.equal(enriched.snapshots.metadata.hosts[0]!.fetchedAtMs, base);
  metadata.hosts[0]!.values.ram = 64;
  await assert.rejects(store.commit(context, { metadata }, 2), { kind: "stale" });
  await store.close();
});

test("country survives sanitization and restore while changes require a new metadata observation", async () => {
  const store = createMemorySnapshotStore({ now: () => base + 86_400_000 });
  const metadata = { hosts: addresses.map(address => ({ address, fetchedAtMs: base, retained: false,
    error: null, marketError: null, values: normalizeHostMetadata(address, { nodeAddress: address }) })) };
  for (const row of metadata.hosts) delete row.values.country;
  const legacy = await store.commit(context, { metadata }, 0);
  const restored = restoreFleetSnapshots([legacy], { now: () => base });
  assert.equal(restored[0]!.snapshots.metadata.hosts[0]!.values?.country ?? null, null);
  assert.equal(restored[0]!.snapshots.metadata.hosts[0]!.fetchedAtMs, base);

  // Absent and explicit null both mean unknown, including replay of old stores.
  metadata.hosts[0]!.values.country = null;
  const unknown = await store.commit(context, { metadata }, 1);
  assert.equal(unknown.snapshots.metadata.hosts[0]!.values?.country, null);
  metadata.hosts[0]!.values.country = "US";
  await assert.rejects(store.commit(context, { metadata }, 2), { kind: "stale" });
  metadata.hosts[0]!.fetchedAtMs = base + 1;
  Object.assign(metadata.hosts[0]!.values, { rawLocationPayload: "discard me" });
  const saved = await store.commit(context, { metadata }, 2);
  assert.equal(saved.snapshots.metadata.hosts[0]!.values?.country, "US");
  assert(!JSON.stringify(saved).includes("discard me"));
  const roundTrip = restoreFleetSnapshots([JSON.parse(JSON.stringify(saved))], { now: () => base + 1 })[0]!;
  assert.equal(roundTrip.snapshots.metadata.hosts[0]!.values?.country, "US");
  assert.equal(roundTrip.snapshots.metadata.hosts[0]!.fetchedAtMs, base + 1);

  metadata.hosts[0]!.values.country = "CA";
  await assert.rejects(store.commit(context, { metadata }, 3), { kind: "stale" });
  delete metadata.hosts[0]!.values.country;
  await assert.rejects(store.commit(context, { metadata }, 3), { kind: "stale" });
  metadata.hosts[0]!.values.country = "CA";
  metadata.hosts[0]!.fetchedAtMs = base + 2;
  assert.equal((await store.commit(context, { metadata }, 3)).snapshots.metadata.hosts[0]!.values?.country, "CA");
  await store.close();
});

test("malformed bulk resources reject atomically and extra transport/provider fields are never stored", async () => {
  const store = createMemorySnapshotStore({ now: () => base + 86_400_000 });
  const source = { ...sol(), complete: true, watching: true, opaqueMaterial: "discard me",
    hosts: sol().hosts.map(row => ({ ...row, rawPayload: { unselected: "discard me too" } })) };
  const saved = await store.commit({ ...context, unselected: "discard context material" } as FleetContext, { sol: source }, 0);
  const text = JSON.stringify(saved);
  assert(!text.includes("discard")); assert(!text.includes("watching")); assert(!text.includes("complete"));
  await assert.rejects(store.commit(context, { sol: { ...sol(base + 1), failed: true } } as SnapshotUpdates, 1), { kind: "invalid" });
  await assert.rejects(store.commit(context, { sol: sol(base + 1), nos: { hosts: [], nextRefreshAtMs: null } }, 1), { kind: "invalid" });
  assert.equal((await store.read(context)).revision, 1);
  await assert.rejects(store.commit(context, { unexpected: {} } as SnapshotUpdates, 1), { kind: "invalid" });
  const bad = sol(); bad.hosts[0]!.lamports = "1.5";
  await assert.rejects(store.commit(context, { sol: bad }, 1), { kind: "invalid" });
  await store.close();
});

test("partial wire normalization strips unused fields and rejects rows outside the authorized roster", () => {
  const partial = { ...sol(), complete: false, opaqueMaterial: "discard me",
    hosts: [{ ...sol().hosts[0]!, rawPayload: { unselected: "discard me too" } }] };
  assert.throws(() => normalizeFleetSnapshot("sol", partial, addresses), { kind: "invalid" });
  const normalized = normalizeFleetSnapshot("sol", partial, addresses, false);
  assert.equal(normalized.hosts.length, 1);
  assert(!JSON.stringify(normalized).includes("discard"));
  assert(!("complete" in normalized));
  assert.throws(() => normalizeFleetSnapshot("sol", partial, [addresses[1]!], false), { kind: "invalid" });
});

test("store subscriptions replay once, publish only changed resources and stop canceled or broken viewers independently", async () => {
  const store = createMemorySnapshotStore({ now: () => base + 86_400_000 });
  const source = createSnapshotSource(store, { now: () => base });
  const first = new AbortController(); const second = new AbortController(); const third = new AbortController();
  const one: unknown[] = []; const two: unknown[] = []; const metadata: unknown[] = [];
  const a = source.watch!("sol", context, first.signal, update => { one.push(update); throw new Error("observer failed"); });
  const b = source.watch!("sol", context, second.signal, update => { two.push(update); });
  const c = source.watch!("metadata", context, third.signal, update => { metadata.push(update); });
  const rejectedA = assert.rejects(a, { name: "AbortError" });
  const rejectedB = assert.rejects(b, { name: "AbortError" });
  const rejectedC = assert.rejects(c, { name: "AbortError" });
  assert.equal(one.length, 1); assert.equal(two.length, 1);
  await store.commit(context, { sol: sol() }, 0);
  assert.equal(one.length, 2); assert.equal(two.length, 2); assert.equal(metadata.length, 1);
  first.abort(); await rejectedA;
  await store.commit(context, { sol: sol(base + 1) }, 1);
  assert.equal(one.length, 2); assert.equal(two.length, 3);
  second.abort(); third.abort(); await Promise.all([rejectedB, rejectedC]);
  await store.close();
});

test("source read preserves authoritative future schedules and cancellation prevents callbacks", async () => {
  const store = createMemorySnapshotStore({ now: () => base + 86_400_000 });
  const snapshot = sol(); snapshot.nextRefreshAtMs = base + 900_000;
  await store.commit(context, { sol: snapshot }, 0);
  const source = createSnapshotSource(store, { now: () => base + 70_000 });
  assert.equal((await source.read("sol", context, signal())).nextRefreshAtMs, base + 900_000);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(source.read("sol", context, controller.signal, () => assert.fail("Canceled observer")), { name: "AbortError" });
  await store.close();
});

test("file snapshots survive restart and time away without refreshing evidence or resetting revisions", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-snapshots-"));
  let active: FleetSnapshotStore | undefined;
  t.after(async () => { await active?.close(); await rm(directory, { recursive: true, force: true }); });
  const first = await createFileSnapshotStore(directory, { now: () => base + 86_400_000 });
  active = first;
  const committed = await first.commit(context, { sol: sol() }, 0);
  await first.close();
  const second = await createFileSnapshotStore(directory, { now: () => base + 86_400_000 });
  active = second;
  assert.deepEqual(await second.read(context), committed);
  const source = createSnapshotSource(second, { now: () => base + 86_400_000 });
  const replayed = await source.read("sol", context, signal());
  assert.deepEqual(replayed.hosts, committed.snapshots.sol.hosts);
  assert.equal((await second.commit(context, { sol: sol(base + 86_400_000, "0", 101) }, 1)).revision, 2);
  assert.equal(JSON.parse(await readFile(join(directory, "snapshots.json"), "utf8")).schemaVersion, 1);
});

test("a file store rejects a second owner in this process and another process without touching committed state", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-snapshot-lock-"));
  let active: FleetSnapshotStore | undefined;
  t.after(async () => { await active?.close(); await rm(directory, { recursive: true, force: true }); });
  const store = await createFileSnapshotStore(directory, { now: () => base + 86_400_000 }); active = store;
  await store.commit(context, { sol: sol() }, 0);
  await assert.rejects(createFileSnapshotStore(directory, { now: () => base + 86_400_000 }), /writer lock/);
  const module = new URL("../src/server/file-snapshot-store.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    `import { createFileSnapshotStore } from ${JSON.stringify(module)}; try { const store = await createFileSnapshotStore(process.argv[1]); await store.close(); process.exitCode = 1; } catch(error) { if(!error.message.includes('writer lock')) process.exitCode = 2; }`, directory], { stdio: "pipe" });
  let error = ""; child.stderr.on("data", value => { error += String(value); });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0, error);
  assert.equal((await store.read(context)).revision, 1);
});

test("invalid persisted bodies, schema versions and evidence fail closed and release the writer lock", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-snapshot-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createMemorySnapshotStore({ now: () => base + 86_400_000 });
  const valid = await store.commit(context, { sol: sol() }, 0); await store.close();
  const invalid = structuredClone(valid); invalid.snapshots.sol.hosts[0]!.validUntilMs = base + 3600_000;
  for (const body of ["{", JSON.stringify({ schemaVersion: 2, fleets: [valid] }),
    JSON.stringify({ schemaVersion: 1, fleets: [invalid] }), JSON.stringify({ schemaVersion: 1, fleets: [valid, valid] })]) {
    await writeFile(join(directory, "snapshots.json"), body);
    await assert.rejects(createFileSnapshotStore(directory, { now: () => base + 86_400_000 }));
  }
  await writeFile(join(directory, "snapshots.json"), JSON.stringify({ schemaVersion: 1, fleets: [valid] }));
  const restored = await createFileSnapshotStore(directory, { now: () => base + 86_400_000 }); await restored.close();
  assert.throws(() => restoreFleetSnapshots([invalid], { now: () => base + 86_400_000 }), { kind: "invalid" });
});

test("large local snapshot files are rejected before reading and a changed market cannot admit an older queue proof", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-snapshot-size-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "snapshots.json");
  await writeFile(file, "{}"); await truncate(file, 64 * 1024 * 1024 + 1);
  await assert.rejects(createFileSnapshotStore(directory, { now: () => base + 86_400_000 }), /validation/);
  const store = createMemorySnapshotStore({ now: () => base + 86_400_000 });
  const queue = { hosts: addresses.map(address => ({ address, marketAddress: addresses[0]!, position: null, total: 0,
    checkedAtMs: base, validUntilMs: base + 30_000, sourceUpdatedAtMs: null, retained: false, error: null })) };
  await store.commit(context, { queue }, 0);
  for (const row of queue.hosts) { row.marketAddress = addresses[1]!; row.checkedAtMs = base - 1; row.validUntilMs = base + 29_999; }
  await assert.rejects(store.commit(context, { queue }, 1), { kind: "stale" });
  await store.close();
});

test("failed activity reconciliation invalidates membership while preserving Online and a durable fence against old positive replay", async () => {
  let durable: readonly StoredFleetSnapshot[] = [];
  const clock = { now: () => base + 3000 };
  const store = createMemorySnapshotStore({ ...clock, persist: async value => { durable = structuredClone(value); } });
  const nodes = (at: number, activityAt: number | null): NodeInfoSnapshot => ({ hosts: addresses.map(address => ({
    address, values: { state: "OTHER", dl: null, ul: null, ping: null, networkUnavailableReason: null },
    fetchedAtMs: at, validUntilMs: at + 30_000, retained: false, error: null,
    apiCheck: { status: "online", checkedAtMs: at },
    activity: activityAt === null ? { state: null, source: "nosana-indexer", checkedAtMs: null, validUntilMs: null,
      error: "Membership confirmation failed." } : { state: "QUEUED", source: "nosana-indexer", checkedAtMs: activityAt,
      validUntilMs: activityAt + 30_000, error: null },
  })) });
  await store.commit(context, { "node-info": nodes(base, base) }, 0);
  const failed = await store.commit(context, { "node-info": nodes(base + 1000, null) }, 1);
  assert.equal(failed.snapshots["node-info"].hosts[0]!.apiCheck!.status, "online");
  assert.equal(failed.snapshots["node-info"].hosts[0]!.activity!.state, null);
  assert.equal(failed.snapshots["node-info"].hosts[0]!.activity!.checkedAtMs, null);
  await assert.rejects(store.commit(context, { "node-info": nodes(base + 2000, base) }, 2), { kind: "stale" });
  const wire = await createSnapshotSource(store, clock).read("node-info", context, signal());
  assert(!JSON.stringify(wire).includes("activityObservationFences"));
  await store.close();
  const reopened = createMemorySnapshotStore({ ...clock, initial: durable });
  await assert.rejects(reopened.commit(context, { "node-info": nodes(base + 2000, base) }, 2), { kind: "stale" });
  const recovered = await reopened.commit(context, { "node-info": nodes(base + 2000, base + 2000) }, 2);
  assert.equal(recovered.snapshots["node-info"].hosts[0]!.activity!.state, "QUEUED");
  assert.equal(recovered.snapshots["node-info"].hosts[0]!.activity!.checkedAtMs, base + 2000);
  await reopened.close();
});

test("future observations cannot poison clock fences, while deadlines and retry plans stay exempt", async () => {
  const store = createMemorySnapshotStore({ now: () => base });
  const future = base + 15_001;
  const snapshots = emptyFleetSnapshots(addresses);
  snapshots.metadata.hosts[0]!.fetchedAtMs = future;
  snapshots["node-info"].hosts[0]!.apiCheck = { status: "online", checkedAtMs: future };
  snapshots.jobs.hosts[0]!.failedAtMs = future;
  snapshots.queue.hosts[0]!.sourceUpdatedAtMs = future;
  snapshots.staking.hosts[0]!.marketFetchedAtMs = future;
  for (const resource of ["metadata", "node-info", "jobs", "queue", "staking"] as const) {
    await assert.rejects(store.commit(context, { [resource]: snapshots[resource] }, 0), { kind: "invalid" });
  }
  await assert.rejects(store.commit(context, { sol: sol(future) }, 0), { kind: "invalid" });
  assert.equal((await store.read(context)).revision, 0);
  const accepted = sol(base + 15_000);
  accepted.nextRefreshAtMs = base + 86_400_000;
  accepted.hosts[0]!.retryAtMs = base + 86_400_000;
  const committed = await store.commit(context, { sol: accepted }, 0);
  assert.deepEqual(committed.snapshots.sol, accepted);
  assert.throws(() => restoreFleetSnapshots([committed], { now: () => base - 1 }), { kind: "invalid" });
  const validRestore = restoreFleetSnapshots([committed], { now: () => base });
  assert.equal(validRestore[0]!.snapshots.sol.hosts[0]!.checkedAtMs, base + 15_000);
  await store.close();
});

test("a replayed success cannot clear a failed observation until a later source check", async () => {
  const store = createMemorySnapshotStore({ now: () => base + 3000 });
  await store.commit(context, { sol: sol() }, 0);
  const failed = sol();
  for (const row of failed.hosts) { row.retained = true; row.error = "Source request failed."; }
  await store.commit(context, { sol: failed }, 1);
  await assert.rejects(store.commit(context, { sol: sol() }, 2), { kind: "stale" });
  const recovered = await store.commit(context, { sol: sol(base + 1000) }, 2);
  assert(recovered.snapshots.sol.hosts.every(row => !row.retained && row.error === null && row.checkedAtMs === base + 1000));
  await store.close();
});

test("job failures retain the first failure time and cached absence cannot become current without a newer check", async () => {
  const store = createMemorySnapshotStore({ now: () => base + 3000 });
  const initial = emptyFleetSnapshots(addresses).jobs;
  for (const row of initial.hosts) { row.checkedAtMs = base; row.validUntilMs = base + 180_000; }
  await store.commit(context, { jobs: initial }, 0);
  const failed = structuredClone(initial);
  for (const row of failed.hosts) { row.retained = true; row.error = "Assignment lookup failed."; row.failedAtMs = base + 1000; }
  await store.commit(context, { jobs: failed }, 1);
  const movedFailure = structuredClone(failed);
  movedFailure.hosts[0]!.failedAtMs = base + 2000;
  await assert.rejects(store.commit(context, { jobs: movedFailure }, 2), { kind: "stale" });
  await assert.rejects(store.commit(context, { jobs: initial }, 2), { kind: "stale" });
  for (const row of initial.hosts) { row.checkedAtMs = base + 3000; row.validUntilMs = base + 183_000; }
  const recovered = await store.commit(context, { jobs: initial }, 2);
  assert.equal(recovered.snapshots.jobs.hosts[0]!.failedAtMs, null);
  assert.equal(recovered.snapshots.jobs.hosts[0]!.checkedAtMs, base + 3000);
  await store.close();
});
