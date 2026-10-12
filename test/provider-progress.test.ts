import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createHostMetadataProvider } from "../scripts/host-metadata.ts";
import { createNodeInfoProvider } from "../scripts/node-info.ts";
import { createReconciledNodeInfoProvider } from "../scripts/node-activity.ts";
import { createQueueProvider } from "../scripts/market-queue.ts";
import { normalizeHostMetadata } from "../src/fleet/host-metadata.ts";
import type { HostMetadataRecord } from "../src/fleet/host-metadata.ts";
import type { NodeInfoRecord } from "../src/fleet/node-info.ts";
import type { QueueRecord } from "../src/fleet/queue.ts";

function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const base58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const addresses = Array.from({ length: 200 }, (_, index) => {
  const value = index + 256;
  return `${"1".repeat(30)}${base58[Math.floor(value / 58)]}${base58[value % 58]}`;
});
const [host, other, third] = addresses as [string, string, string, ...string[]];
const market = "1".repeat(31) + "A";
const otherMarket = "1".repeat(31) + "B";
const metadata = (address: string, marketAddress = market): HostMetadataRecord => ({
  address, values: normalizeHostMetadata(address, { nodeAddress: address, marketAddress }),
  fetchedAtMs: 1000, retained: false, error: null, marketError: null,
});
const node = (address: string): NodeInfoRecord => ({
  address, values: { state: "OTHER", dl: null, ul: null, ping: null, networkUnavailableReason: null },
  fetchedAtMs: 1000, validUntilMs: 31_000, retained: false, error: null,
});

test("200 Node Info hosts publish healthy rows before a slow peer and preserve original deadlines", async () => {
  const held = gate();
  let now = 1000;
  let active = 0;
  let maximum = 0;
  let finished = false;
  const updates: NodeInfoRecord[] = [];
  const provider = createNodeInfoProvider({ now: () => now, fetch: async input => {
    const address = String(input).split("//")[1]!.split(".")[0]!;
    maximum = Math.max(maximum, ++active);
    if (address === other) await held.promise;
    active--;
    return Response.json({ node: address, state: "QUEUED" });
  } });
  const pending = provider(addresses, undefined, snapshot => {
    updates.push(...structuredClone(snapshot.hosts));
    snapshot.hosts[0]!.values!.state = "CALLER_MUTATION";
  }).then(value => { finished = true; return value; });
  await setImmediate();
  assert.equal(finished, false);
  assert.equal(updates.length, 199);
  assert.equal(updates[0]?.address, host);
  assert.equal(updates[0]?.validUntilMs, 31_000);
  assert(maximum <= 4);
  now = 40_000;
  held.resolve();
  const result = await pending;
  assert.deepEqual(result.hosts.map(record => record.address), addresses);
  assert.equal(result.hosts[0]?.validUntilMs, 31_000);
  assert.equal(result.hosts[1]?.validUntilMs, 70_000);
  assert(result.hosts.every(record => record.values?.state === "QUEUED"));
});

test("200 metadata hosts publish assignments before labels and share later enrichment around a slow peer", async () => {
  const held = gate();
  const calls: string[] = [];
  const updates: HostMetadataRecord[] = [];
  let active = 0;
  let maximum = 0;
  let finished = false;
  const provider = createHostMetadataProvider({ now: () => 1000, fetch: async input => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    maximum = Math.max(maximum, ++active);
    if (url.pathname === `/nodes/${other}/metrics`) await held.promise;
    active--;
    return Response.json(url.pathname.startsWith("/markets/")
      ? { address: market, slug: "demo" }
      : { nodeAddress: url.pathname.split("/")[2], marketAddress: market });
  } });
  const pending = provider(addresses, undefined, snapshot => updates.push(...snapshot.hosts))
    .then(value => { finished = true; return value; });
  await setImmediate();
  assert.equal(finished, false);
  assert.equal(updates.length, 398);
  assert.equal(updates[0]?.values?.marketLabel, null);
  assert.equal(updates.at(-1)?.values?.marketLabel, "demo");
  assert.equal(updates[0]?.fetchedAtMs, 1000);
  assert(calls.indexOf(`/markets/${market}`) > calls.indexOf(`/nodes/${addresses.at(-1)}/metrics`));
  assert.equal(calls.filter(path => path.startsWith("/markets/")).length, 1);
  assert.equal(maximum, 2);
  held.resolve();
  assert.equal((await pending).hosts.length, 200);
});

test("OTHER reconciles before a slow raw roster completes and never publishes a transient raw O", async () => {
  const tail = gate();
  const membership = gate();
  const updates: NodeInfoRecord[] = [];
  let now = 2000;
  let finished = false;
  const provider = createReconciledNodeInfoProvider({
    now: () => now,
    nodeInfoProvider: async (_addresses, _signal, onUpdate) => {
      onUpdate?.({ hosts: [node(host)] });
      await tail.promise;
      return { hosts: [node(host), { ...node(other), values: null }] };
    },
    metadataProvider: async input => ({ hosts: input.map(address => metadata(address)) }),
    activityProvider: async input => {
      assert.deepEqual(input, [{ address: host, marketAddress: market }]);
      await membership.promise;
      return new Map([[host, { state: "RUNNING_JOB", source: "nosana-indexer", checkedAtMs: 2000,
        validUntilMs: 32_000, error: null }]]);
    },
  });
  const pending = provider([host, other], undefined, snapshot => updates.push(...snapshot.hosts))
    .then(value => { finished = true; return value; });
  await setImmediate();
  assert.equal(updates.length, 0);
  membership.resolve();
  await setImmediate();
  assert.equal(finished, false);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.values?.state, "OTHER");
  assert.equal(updates[0]?.activity?.state, "RUNNING_JOB");
  assert.equal(updates[0]?.fetchedAtMs, 1000);
  assert.equal(updates[0]?.validUntilMs, 31_000);
  now = 40_000;
  tail.resolve();
  const result = await pending;
  assert.equal(result.hosts[0]?.validUntilMs, 31_000);
  assert.equal(result.hosts[0]?.activity?.checkedAtMs, 2000);
});

test("queue progress publishes a complete available market cohort before unrelated metadata finishes", async () => {
  const tail = gate();
  const updates: QueueRecord[][] = [];
  const calls: string[] = [];
  let finished = false;
  const provider = createQueueProvider({
    now: () => 2000,
    metadataProvider: async (_addresses, _signal, onUpdate) => {
      onUpdate?.({ hosts: [metadata(host), metadata(other)] });
      await tail.promise;
      return { hosts: [metadata(host), metadata(other), metadata(third, otherMarket)] };
    },
    marketQueueProvider: async marketAddress => {
      calls.push(marketAddress);
      return { marketAddress, queueType: 1, queue: marketAddress === market ? [other, host] : [third],
        checkedAtMs: 2000, validUntilMs: 32_000, sourceUpdatedAtMs: 1000, retained: false, error: null };
    },
  });
  const pending = provider([host, other, third], undefined, snapshot => updates.push(snapshot.hosts))
    .then(value => { finished = true; return value; });
  await setImmediate();
  assert.equal(finished, false);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0]?.map(record => [record.address, record.position]), [[host, 2], [other, 1]]);
  assert.deepEqual(calls, [market]);
  tail.resolve();
  assert.deepEqual((await pending).hosts.map(record => record.position), [2, 1, 1]);
  assert.deepEqual(calls, [market, otherMarket]);
});

test("a refreshed queue never leaves another known market member showing an old fresh rank", async () => {
  const tail = gate();
  let refresh = false;
  const updates: QueueRecord[][] = [];
  const provider = createQueueProvider({
    now: () => refresh ? 20_000 : 1000,
    metadataProvider: async (_addresses, _signal, onUpdate) => {
      if (refresh) {
        onUpdate?.({ hosts: [metadata(host)] });
        await tail.promise;
      }
      return { hosts: [metadata(host), metadata(other)] };
    },
    marketQueueProvider: async marketAddress => ({ marketAddress, queueType: 1,
      queue: refresh ? [host, other] : [other, host], checkedAtMs: refresh ? 20_000 : 1000,
      validUntilMs: refresh ? 50_000 : 31_000, sourceUpdatedAtMs: 1000, retained: false, error: null }),
  });
  await provider([host, other]);
  refresh = true;
  const pending = provider([host, other], undefined, snapshot => updates.push(snapshot.hosts));
  await setImmediate();
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.length, 2);
  assert.equal(updates[0]?.[0]?.position, 1);
  assert.equal(updates[0]?.[0]?.retained, false);
  assert.equal(updates[0]?.[1]?.retained, true);
  assert.equal(updates[0]?.[1]?.checkedAtMs, 1000);
  tail.resolve();
  const result = await pending;
  assert.deepEqual(result.hosts.map(record => record.position), [1, 2]);
  assert(result.hosts.every(record => record.checkedAtMs === 20_000 && !record.retained));
});

test("late metadata rechecks an expired market and updates its entire already-known cohort", async () => {
  const held = gate();
  let now = 1000;
  let calls = 0;
  const updates: QueueRecord[][] = [];
  const provider = createQueueProvider({
    now: () => now,
    metadataProvider: async (_addresses, _signal, onUpdate) => {
      onUpdate?.({ hosts: [metadata(host)] });
      await held.promise;
      return { hosts: [metadata(host), metadata(other)] };
    },
    marketQueueProvider: async marketAddress => {
      calls++;
      return { marketAddress, queueType: 1, queue: calls === 1 ? [host, other] : [other, host],
        checkedAtMs: now, validUntilMs: now + 30_000, sourceUpdatedAtMs: 1000, retained: false, error: null };
    },
  });
  const pending = provider([host, other], undefined, snapshot => updates.push(snapshot.hosts));
  await setImmediate();
  assert.equal(calls, 1);
  assert.equal(updates[0]?.[0]?.checkedAtMs, 1000);
  now = 40_000;
  held.resolve();
  const result = await pending;
  assert.equal(calls, 2);
  assert.deepEqual(result.hosts.map(record => record.position), [2, 1]);
  assert(result.hosts.every(record => record.checkedAtMs === 40_000 && record.validUntilMs === 70_000));
  assert.equal(updates[1]?.length, 2);
});
