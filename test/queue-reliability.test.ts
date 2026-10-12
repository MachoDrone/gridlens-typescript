import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createMarketQueueProvider, createQueueProvider } from "../scripts/market-queue.ts";
import type { MarketQueueProvider, MarketQueueRecord } from "../scripts/market-queue.ts";
import type { HostMetadataProvider } from "../scripts/host-metadata.ts";
import { normalizeHostMetadata } from "../src/fleet/host-metadata.ts";
import type { HostMetadataRecord, HostMetadataSnapshot } from "../src/fleet/host-metadata.ts";
import type { QueueSnapshot } from "../src/fleet/queue.ts";

const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const address = (index: number): string => "1".repeat(30) + alphabet[Math.floor(index / 58)] + alphabet[index % 58];
const host = address(1);
const market = address(2000);
const secondMarket = address(2001);
const base = 1_000_000;
const payload = (marketAddress: string) => ({ address: marketAddress, queueType: 1,
  queue: [host], nodesInQueue: 1, jobsInQueue: 0, updatedAt: 0 });
const metadata = (node = host, marketAddress = market): HostMetadataRecord => ({
  address: node, values: normalizeHostMetadata(node, { nodeAddress: node, marketAddress }),
  fetchedAtMs: base, retained: false, error: null, marketError: null,
});
const proof = (marketAddress = market, queue = [host]): MarketQueueRecord => ({
  marketAddress, queueType: 1, queue, checkedAtMs: base, validUntilMs: base + 30_000,
  sourceUpdatedAtMs: 0, retained: false, error: null,
});

for (const retained of [false, true]) test(`shared Queue pause does not add a fresh failure delay to ${retained ? "previously checked" : "unattempted"} markets`, async () => {
  let now = base;
  const calls: string[] = [];
  let limited = false;
  const provider = createMarketQueueProvider({ now: () => now, fetch: async input => {
    const requested = new URL(String(input)).pathname.split("/").at(-1)!;
    calls.push(requested);
    return limited && requested === market ? new Response("", { status: 429, headers: { "Retry-After": "60" } })
      : Response.json(payload(requested));
  } });
  const old = retained ? await provider(secondMarket) : undefined;
  now += 15_000;
  limited = true;
  await provider(market);
  const retryAt = now + 60_000;
  now = retryAt - 1;
  const deferred = await provider(secondMarket);
  assert.match(deferred.error!, /paused/);
  assert.equal(deferred.checkedAtMs, old?.checkedAtMs ?? null);
  assert.equal(deferred.validUntilMs, old?.validUntilMs ?? null);
  assert.equal(provider.nextRefreshAt!(secondMarket), retryAt,
    "a read deferred by another market's Retry-After must use the original pause deadline");
  assert.equal(calls.length, retained ? 2 : 1);
  now = retryAt;
  assert.equal((await provider(secondMarket)).error, null);
  assert.equal(calls.at(-1), secondMarket);
});

function watchHarness() {
  let updateMetadata!: (snapshot: HostMetadataSnapshot) => void;
  const updates: QueueSnapshot[] = [];
  const listeners = new Map<string, { signal: AbortSignal; update: (market: MarketQueueRecord) => void }>();
  const metadataProvider: HostMetadataProvider = async () => ({ hosts: [] });
  metadataProvider.watch = (_addresses, signal, update) => {
    updateMetadata = update;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  const marketQueueProvider: MarketQueueProvider = async marketAddress => proof(marketAddress);
  marketQueueProvider.watch = (markets, signal, update) => {
    for (const marketAddress of markets) listeners.set(marketAddress, { signal, update });
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  const provider = createQueueProvider({ metadataProvider, marketQueueProvider, now: () => base });
  const controller = new AbortController();
  const start = (addresses: readonly string[]) => {
    const pending = provider.watch!(addresses, controller.signal, snapshot => updates.push(snapshot));
    return assert.rejects(pending, { name: "AbortError" });
  };
  return { start, controller, updates, listeners, metadata: (snapshot: HostMetadataSnapshot) => updateMetadata(snapshot) };
}

test("optional labels and unchanged metadata do not replay an entire queue cohort", async () => {
  const harness = watchHarness();
  const hosts = Array.from({ length: 200 }, (_, index) => address(index + 256));
  const canceled = harness.start(hosts);
  try {
    harness.metadata({ hosts: hosts.map(node => metadata(node)) });
    harness.listeners.get(market)!.update(proof(market, hosts));
    assert.equal(harness.updates.length, 1);
    assert.equal(harness.updates[0]!.hosts.length, 200);
    for (const node of hosts) {
      const record = metadata(node);
      harness.metadata({ hosts: [{ ...record, values: { ...record.values!, marketLabel: "label" } }] });
    }
    assert.equal(harness.updates.length, 1, "200 labels must not emit 40,000 duplicate Queue records");
    harness.listeners.get(market)!.update({ ...proof(market, hosts.slice().reverse()), checkedAtMs: base + 15_000,
      validUntilMs: base + 45_000 });
    assert.equal(harness.updates.length, 2, "real refreshed Queue evidence must still reach every row");
    assert.equal(harness.updates[1]!.hosts[0]!.position, 200);
  } finally { harness.controller.abort(); await canceled; }
});

test("market reassignment clears the old rank immediately and ignores the retired market's late response", async () => {
  const harness = watchHarness();
  const canceled = harness.start([host]);
  try {
    harness.metadata({ hosts: [metadata()] });
    const old = harness.listeners.get(market)!;
    old.update(proof());
    assert.equal(harness.updates.at(-1)!.hosts[0]!.position, 1);
    harness.metadata({ hosts: [metadata(host, secondMarket)] });
    const pending = harness.updates.at(-1)!.hosts[0]!;
    assert.equal(pending.marketAddress, secondMarket);
    assert.equal(pending.position, null);
    assert.equal(pending.checkedAtMs, null);
    assert.equal(pending.retained, false);
    assert.equal(old.signal.aborted, true);
    const count = harness.updates.length;
    old.update({ ...proof(), checkedAtMs: base + 10 });
    assert.equal(harness.updates.length, count);
    harness.listeners.get(secondMarket)!.update(proof(secondMarket));
    assert.equal(harness.updates.at(-1)!.hosts[0]!.position, 1);
    assert.equal(harness.updates.at(-1)!.hosts[0]!.marketAddress, secondMarket);
    await setImmediate();
  } finally { harness.controller.abort(); await canceled; }
});

test("late metadata follows the original shared market-cache deadline instead of renewing it on receipt", async () => {
  let now = base;
  let marketCalls = 0;
  const other = address(2);
  const marketQueueProvider = createMarketQueueProvider({ now: () => now, fetch: async () => {
    marketCalls++;
    const queue = marketCalls === 1 ? [host, other] : [other, host];
    return Response.json({ ...payload(market), queue, nodesInQueue: 2 });
  } });
  await marketQueueProvider(market);
  now += 14_000;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const provider = createQueueProvider({ marketQueueProvider, now: () => now,
    metadataProvider: async (_addresses, _signal, update) => {
      update?.({ hosts: [metadata()] });
      await held;
      return { hosts: [metadata(), metadata(other)] };
    },
  });
  const updates: QueueSnapshot[] = [];
  const pending = provider([host, other], undefined, snapshot => updates.push(snapshot));
  await setImmediate();
  assert.equal(updates[0]!.hosts[0]!.checkedAtMs, base);
  assert.equal(marketCalls, 1);
  now = base + 15_000;
  release();
  const final = await pending;
  assert.equal(marketCalls, 2, "late assignment should share a refresh already due under the original cache deadline");
  assert.deepEqual(final.hosts.map(record => record.position), [2, 1]);
  assert(final.hosts.every(record => record.checkedAtMs === base + 15_000));
});

test("finite reassignment progress clears a prior market while its new queue read is pending", async () => {
  let assigned = market;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const provider = createQueueProvider({ now: () => base,
    metadataProvider: async () => ({ hosts: [metadata(host, assigned)] }),
    marketQueueProvider: async marketAddress => {
      if (marketAddress === secondMarket) await held;
      return proof(marketAddress);
    },
  });
  assert.equal((await provider([host])).hosts[0]!.position, 1);
  assigned = secondMarket;
  const updates: QueueSnapshot[] = [];
  const pending = provider([host], undefined, snapshot => updates.push(snapshot));
  await setImmediate();
  assert.equal(updates.length, 1);
  assert.equal(updates[0]!.hosts[0]!.marketAddress, secondMarket);
  assert.equal(updates[0]!.hosts[0]!.position, null);
  assert.equal(updates[0]!.hosts[0]!.checkedAtMs, null);
  release();
  assert.equal((await pending).hosts[0]!.position, 1);
});

test("a recovered metadata assignment republishes its original queue proof after failure", async () => {
  const harness = watchHarness();
  const other = address(2);
  const canceled = harness.start([host, other]);
  try {
    harness.metadata({ hosts: [metadata(), metadata(other)] });
    harness.listeners.get(market)!.update(proof(market, [host, other]));
    harness.metadata({ hosts: [{ ...metadata(), error: "metadata unavailable", retained: true }] });
    assert.equal(harness.updates.at(-1)!.hosts[0]!.retained, true);
    assert.equal(harness.updates.at(-1)!.hosts[0]!.checkedAtMs, base);
    harness.metadata({ hosts: [metadata()] });
    const recovered = harness.updates.at(-1)!.hosts.find(record => record.address === host)!;
    assert.equal(recovered.retained, false);
    assert.equal(recovered.position, 1);
    assert.equal(recovered.checkedAtMs, base);
    assert.equal(recovered.validUntilMs, base + 30_000);
  } finally { harness.controller.abort(); await canceled; }
});
