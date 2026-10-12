import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createHostMetadataProvider } from "../scripts/host-metadata.ts";
import { createNodeInfoProvider } from "../scripts/node-info.ts";
import { createNodeActivityProvider, createReconciledNodeInfoProvider } from "../scripts/node-activity.ts";
import { createMarketQueueProvider, createQueueProvider } from "../scripts/market-queue.ts";
import type { HostMetadataRecord } from "../src/fleet/host-metadata.ts";
import type { NodeInfoRecord } from "../src/fleet/node-info.ts";
import type { QueueRecord } from "../src/fleet/queue.ts";

const base58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const roster = (count: number): string[] => Array.from({ length: count }, (_, index) => {
  const value = index + 256;
  return `${"1".repeat(30)}${base58[Math.floor(value / 58)]}${base58[value % 58]}`;
});
const [host, other] = roster(2) as [string, string];
const market = "1".repeat(31) + "A";
const nextMarket = "1".repeat(31) + "B";

function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

for (const mode of ["finite", "watch"] as const) test(`${mode}: all 200 State and Queued rows populate while market names are held`, async () => {
  const addresses = roster(200);
  const held = gate();
  let now = 1000;
  let metadataReads = 0;
  let labelReads = 0;
  let queueReads = 0;
  let activityReads = 0;
  let active = 0;
  let maximum = 0;
  const metadata = createHostMetadataProvider({ now: () => now, fetch: async input => {
    maximum = Math.max(maximum, ++active);
    const path = new URL(String(input)).pathname;
    const address = path.split("/")[2]!;
    if (path.startsWith("/markets/")) { labelReads++; await held.promise; }
    else metadataReads++;
    active--;
    return Response.json(path.startsWith("/markets/") ? { address, slug: "later-label" }
      : { nodeAddress: address, marketAddress: market });
  } });
  const marketQueue = createMarketQueueProvider({ now: () => now, fetch: async () => {
    queueReads++;
    return Response.json({ address: market, queueType: 1, nodesInQueue: addresses.length,
      jobsInQueue: 0, queue: addresses, updatedAt: 0 });
  } });
  const raw = createNodeInfoProvider({ now: () => now, fetch: async input =>
    Response.json({ node: String(input).split("//")[1]!.split(".")[0], state: "OTHER" }) });
  const activity = createNodeActivityProvider({ now: () => now, marketQueueProvider: marketQueue, fetch: async () => {
    activityReads++;
    return Response.json([]);
  } });
  const state = createReconciledNodeInfoProvider({ now: () => now, nodeInfoProvider: raw,
    metadataProvider: metadata, activityProvider: activity });
  const queue = createQueueProvider({ now: () => now, metadataProvider: metadata, marketQueueProvider: marketQueue });
  const metadataRows = new Map<string, HostMetadataRecord>();
  const stateRows = new Map<string, NodeInfoRecord>();
  const queueRows = new Map<string, QueueRecord>();
  const controller = new AbortController();
  const collect = <T extends { address: string }>(target: Map<string, T>) => (snapshot: { hosts: T[] }): void => {
    for (const record of snapshot.hosts) target.set(record.address, record);
  };
  let metadataFinished = false;
  let stateFinished = false;
  let queueFinished = false;
  const reads = mode === "finite" ? [
    metadata(addresses, controller.signal, collect(metadataRows)).then(() => { metadataFinished = true; }),
    state(addresses, controller.signal, collect(stateRows)).then(() => { stateFinished = true; }),
    queue(addresses, controller.signal, collect(queueRows)).then(() => { queueFinished = true; }),
  ] : [
    metadata.watch!(addresses, controller.signal, collect(metadataRows)),
    state.watch!(addresses, controller.signal, collect(stateRows)),
    queue.watch!(addresses, controller.signal, collect(queueRows)),
  ];
  const finished = reads.map(read => read.catch(() => {}));
  try {
    await setImmediate();
    assert.equal(metadataFinished, false);
    assert.equal(metadataRows.size, 200);
    assert.equal(stateRows.size, 200);
    assert.equal(queueRows.size, 200);
    assert([...metadataRows.values()].every(record => record.values?.marketLabel === null));
    assert([...stateRows.values()].every(record => record.activity?.state === "QUEUED"));
    assert([...queueRows.values()].every(record => record.position !== null));
    assert.equal(metadataReads, 200);
    assert.equal(labelReads, 1);
    assert.equal(queueReads, 1, "State and Queued share the same market evidence");
    assert.equal(activityReads, 1);
    assert(maximum <= 2);
    if (mode === "finite") assert(stateFinished && queueFinished, "finite dependent responses must not wait for labels");
    now = 2000;
    held.resolve();
    await setImmediate();
    assert([...metadataRows.values()].every(record => record.values?.marketLabel === "later-label"));
    assert([...metadataRows.values()].every(record => record.fetchedAtMs === 1000));
    assert([...queueRows.values()].every(record => record.checkedAtMs === 1000));
    assert([...stateRows.values()].every(record => record.fetchedAtMs === 1000 && record.validUntilMs === 31_000));
  } finally {
    controller.abort();
    held.resolve();
    await Promise.all(finished);
  }
});

test("a 1000-host watch dispatches every initial metadata read ahead of market names under the shared two-slot cap", async () => {
  const addresses = roster(1000);
  const held = gate();
  const calls: string[] = [];
  const rows = new Map<string, HostMetadataRecord>();
  let maximum = 0;
  let active = 0;
  const provider = createHostMetadataProvider({ fetch: async input => {
    maximum = Math.max(maximum, ++active);
    const path = new URL(String(input)).pathname;
    calls.push(path);
    const address = path.split("/")[2]!;
    if (path.startsWith("/markets/")) await held.promise;
    active--;
    return Response.json(path.startsWith("/markets/") ? { address, slug: "demo" }
      : { nodeAddress: address, marketAddress: market });
  } });
  const controller = new AbortController();
  const pending = provider.watch!(addresses, controller.signal, update => {
    for (const record of update.hosts) rows.set(record.address, record);
  }).catch(() => {});
  try {
    await setImmediate();
    assert.equal(rows.size, 1000);
    assert(calls.slice(0, 1000).every(path => path.startsWith("/nodes/")));
    assert.equal(calls[1000], `/markets/${market}`);
    assert(maximum <= 2);
  } finally {
    controller.abort();
    held.resolve();
    await pending;
  }
});

test("late labels cannot overwrite a newer host/market generation or advance its timestamp", async () => {
  let now = 1000;
  let assignment = market;
  const held = gate();
  const updates: HostMetadataRecord[] = [];
  const provider = createHostMetadataProvider({ now: () => now, fetch: async input => {
    const path = new URL(String(input)).pathname;
    if (path === `/markets/${market}`) await held.promise;
    return Response.json(path.startsWith("/markets/")
      ? { address: path.split("/")[2], slug: path.endsWith(market) ? "old" : "new" }
      : { nodeAddress: host, marketAddress: assignment });
  } });
  const first = provider([host], undefined, snapshot => updates.push(...snapshot.hosts));
  await setImmediate();
  now = 301_000;
  assignment = nextMarket;
  const second = await provider([host]);
  assert.equal(second.hosts[0]?.values?.marketLabel, "new");
  held.resolve();
  const final = await first;
  assert.equal(final.hosts[0]?.values?.marketAddress, nextMarket);
  assert.equal(final.hosts[0]?.values?.marketLabel, "new");
  assert.equal(final.hosts[0]?.fetchedAtMs, 301_000);
  assert(!updates.some(record => record.values?.marketLabel === "old"));
});

test("label demand survives one canceled viewer, ends with the last viewer and resumes without replacing metrics", async () => {
  const held = gate();
  let labelReads = 0;
  let metadataReads = 0;
  let labelSignal: AbortSignal | undefined;
  const provider = createHostMetadataProvider({ now: () => 1000, fetch: async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.startsWith("/markets/")) {
      labelReads++;
      labelSignal = init!.signal!;
      if (labelReads === 1) { await held.promise; return new Response("", { status: 429 }); }
      return Response.json({ address: market, slug: "resumed" });
    }
    metadataReads++;
    return Response.json({ nodeAddress: path.split("/")[2], marketAddress: market });
  } });
  const first = new AbortController();
  const second = new AbortController();
  const a = provider.watch!([host, other], first.signal, () => {}).catch(() => {});
  const b = provider.watch!([host, other], second.signal, () => {}).catch(() => {});
  await setImmediate();
  assert.equal(labelReads, 1);
  first.abort();
  await a;
  assert.equal(labelSignal?.aborted, false);
  second.abort();
  await b;
  assert.equal(labelSignal?.aborted, true);
  const resumed = provider([host, other]);
  held.resolve();
  const result = await resumed;
  assert.equal(metadataReads, 2);
  assert.equal(labelReads, 2);
  assert(result.hosts.every(record => record.values?.marketLabel === "resumed" && record.fetchedAtMs === 1000
    && !record.error && !record.marketError));
});
