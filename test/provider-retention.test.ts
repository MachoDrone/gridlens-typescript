import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createOnlineRetention, ONLINE_RETIRED_RETENTION_MS } from "../scripts/online-retention.ts";
import { createHostMetadataProvider } from "../scripts/host-metadata.ts";
import { createNodeInfoProvider } from "../scripts/node-info.ts";
import { createMarketQueueProvider, createQueueProvider } from "../scripts/market-queue.ts";
import { createNodeActivityProvider, createReconciledNodeInfoProvider } from "../scripts/node-activity.ts";
import { createJobProvider } from "../scripts/jobs.ts";
import { createSchedulingEvidence } from "../scripts/scheduling-priority.ts";
import { createDemandWatch } from "../scripts/demand-watch.ts";
import { SYNTHETIC_HOST_ADDRESSES as addresses } from "./fixtures/host-addresses.ts";

const [host, other, market] = addresses as [string, string, string, ...string[]];
const hour = ONLINE_RETIRED_RETENTION_MS;
const base = 1_000_000;

test("watch pruning retains unexpected-error backoff across cancellation and rejoin", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: base });
  let calls = 0;
  const watch = createDemandWatch({ read: async (_key: string) => { calls++; throw new Error("fixture failure"); },
    peek: () => undefined, dueAt: () => 0 });
  const first = new AbortController();
  const initial = assert.rejects(watch.watch([host], first.signal, () => {}), { name: "AbortError" });
  await setImmediate();
  assert.equal(calls, 1);
  first.abort();
  await initial;
  watch.prune(new Set());
  assert.equal(watch.retryAt(host), base + 60_000);
  const second = new AbortController();
  const rejoined = assert.rejects(watch.watch([host], second.signal, () => {}), { name: "AbortError" });
  try {
    await setImmediate();
    assert.equal(calls, 1);
    t.mock.timers.tick(59_999);
    await setImmediate();
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    await setImmediate();
    assert.equal(calls, 2);
  } finally { second.abort(); await rejoined; }
});

test("a Node Info rejoin preserves original proof/backoff and only eligible retired records are pruned", async () => {
  let now = base;
  let calls = 0;
  const provider = createNodeInfoProvider({ now: () => now, fetch: async () => {
    calls++;
    return Response.json({ node: host, state: "QUEUED" });
  } });
  const retention = createOnlineRetention({ pinned: [], maximumRetiredHosts: 1, now: () => now,
    caches: () => [provider.retention] });
  assert(retention.accept([host]));
  const original = await provider([host]);
  assert(retention.accept([]));
  now += 1_000;
  assert(retention.accept([host]));
  const rejoined = await provider([host]);
  assert.deepEqual(rejoined, original);
  assert.equal(calls, 1);
  assert(retention.accept([]));
  now += hour;
  assert(retention.accept([other]));
  assert.equal(provider.retention!.retryAt!(host), 0);
});

test("long Node Info Retry-After survives retirement, capacity rejection and rejoin", async () => {
  let now = base;
  let calls = 0;
  const provider = createNodeInfoProvider({ now: () => now, fetch: async () => {
    calls++;
    return new Response("", { status: 429, headers: { "Retry-After": "7200" } });
  } });
  const retention = createOnlineRetention({ pinned: [], maximumRetiredHosts: 1, now: () => now,
    caches: () => [provider.retention] });
  assert(retention.accept([host, other]));
  const original = await provider([host]);
  const retryAt = provider.retention!.retryAt!(host);
  assert.equal(retryAt, base + 2 * hour);
  assert(retention.accept([other]));
  now += hour + 1;
  assert.equal(retention.accept([market]), false);
  assert(retention.accept([host, other]));
  assert.deepEqual(await provider([host]), original);
  assert.equal(calls, 1);
  assert.equal(provider.retention!.retryAt!(host), retryAt);
});

test("metadata and dependent queue/activity caches preserve market cooldown then release obsolete assignments", async () => {
  let now = base;
  let marketCalls = 0;
  const metadata = createHostMetadataProvider({ now: () => now, fetch: async input => {
    const path = new URL(String(input)).pathname;
    return path.endsWith("/metrics") ? Response.json({ nodeAddress: host, marketAddress: market })
      : Response.json({ address: market, name: "Fixture" });
  } });
  const queue = createMarketQueueProvider({ now: () => now, fetch: async () => {
    marketCalls++;
    return new Response("", { status: 429, headers: { "Retry-After": "7200" } });
  } });
  const activity = createNodeActivityProvider({ now: () => now, marketQueueProvider: queue,
    fetch: async () => Response.json([host]) });
  const joined = createQueueProvider({ metadataProvider: metadata, marketQueueProvider: queue, now: () => now });
  const retention = createOnlineRetention({ pinned: [], maximumRetiredHosts: 1, now: () => now,
    caches: () => [metadata.retention, joined.retention, activity.retention] });
  assert(retention.accept([host, other]));
  await joined([host]);
  await activity([{ address: host, marketAddress: market }]);
  assert(retention.accept([other]));
  now += hour + 1;
  assert.equal(retention.accept([market]), false);
  assert.equal(queue.retention!.marketRetryAt!(market), base + 2 * hour);
  await queue(market);
  assert.equal(marketCalls, 1);
  now = base + 2 * hour;
  assert(retention.accept([market]));
  assert.equal(metadata.retention!.retryAt!(host), 0);
  assert.equal(queue.retention!.marketRetryAt!(market), 0);
  assert.deepEqual([...activity.retention!.markets!(new Set([host]))], []);
  assert.deepEqual([...joined.retention!.markets!(new Set([host]))], []);
});

test("a pending old-revision Node read stays pinned until its actual completion", async () => {
  let now = base;
  let complete!: () => void;
  const pending = new Promise<void>(resolve => { complete = resolve; });
  const provider = createNodeInfoProvider({ now: () => now, fetch: async () => {
    await pending;
    return Response.json({ node: host, state: "QUEUED" });
  } });
  const retention = createOnlineRetention({ pinned: [], maximumRetiredHosts: 1, now: () => now,
    caches: () => [provider.retention] });
  assert(retention.accept([host, other]));
  const release = retention.hold([host]);
  const read = provider([host]).finally(release);
  await setImmediate();
  assert(retention.accept([other]));
  now += hour;
  assert.equal(retention.accept([market]), false);
  complete();
  await read;
  assert.equal(retention.accept([market]), false, "the just-completed proof still has its original cache deadline");
  now += 15_000;
  assert(retention.accept([market]));
});

test("job budget dispatch history survives cache pruning and a new roster", async () => {
  let now = base;
  let calls = 0;
  const provider = createJobProvider({ now: () => now, fetch: async () => {
    calls++;
    return Response.json({ jobs: [], totalJobs: 0 });
  } });
  const retention = createOnlineRetention({ pinned: [], now: () => now, retentionMs: 0,
    caches: () => [provider.retention] });
  for (let turn = 0; turn < 3; turn++) {
    assert(retention.accept(addresses));
    await provider(addresses);
    assert(retention.accept([]));
    now += 120_000;
    retention.prune();
  }
  assert.equal(calls, 24);
  // The nested daily quota remains in the same closure; cache churn cannot
  // obtain fresh budgets. Exercise enough generations to reach its 900 ceiling.
  for (let turn = 3; turn < 200; turn++) {
    assert(retention.accept(addresses));
    await provider(addresses);
    assert(retention.accept([]));
    now += 120_000;
    retention.prune();
  }
  assert.equal(calls, 900, "daily discovery budget survives repeated eligible cache eviction");
});

test("reconciler and scheduling retention compose child state without republishing stale history", async () => {
  let now = base;
  const metadata = createHostMetadataProvider({ now: () => now,
    fetch: async () => Response.json({ nodeAddress: host }) });
  const raw = createNodeInfoProvider({ now: () => now,
    fetch: async () => Response.json({ node: host, state: "STARTING" }) });
  const provider = createReconciledNodeInfoProvider({ nodeInfoProvider: raw, metadataProvider: metadata,
    activityProvider: createNodeActivityProvider({ now: () => now, fetch: async () => Response.json([]) }), now: () => now });
  const scheduling = createSchedulingEvidence(() => now);
  const retention = createOnlineRetention({ pinned: [], now: () => now,
    caches: () => [provider.retention, scheduling.retention] });
  assert(retention.accept([host]));
  scheduling.observeStates(await provider([host]));
  assert.equal(scheduling.activityPriority(host, now), 0);
  assert(retention.accept([]));
  now += hour;
  retention.prune();
  assert.equal(provider.retention!.retryAt!(host), 0);
  assert.equal(raw.retention!.retryAt!(host), 0);
  assert.equal(scheduling.activityPriority(host, base), 2, "even an old lookup cannot retrieve evicted scheduling evidence");
});
