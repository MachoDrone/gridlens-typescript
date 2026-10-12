import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createMarketQueueProvider, createQueueProvider, normalizeMarketQueue } from "../scripts/market-queue.ts";
import { createNodeActivityProvider } from "../scripts/node-activity.ts";
import { normalizeHostMetadata } from "../src/fleet/host-metadata.ts";
import type { HostMetadataRecord } from "../src/fleet/host-metadata.ts";

const host = `${"1".repeat(31)}2`;
const other = `${"1".repeat(31)}3`;
const markets = ["A", "B", "C"].map(suffix => `${"1".repeat(31)}${suffix}`);
const market = markets[0]!;
const payload = (address = market, queue = [other, host]) => ({
  address, queueType: 1, queue, nodesInQueue: queue.length, jobsInQueue: 0, updatedAt: 0,
  jobDefinitions: { secret: "unrelated payload" },
});
const metadata = (address = host, marketAddress: string | null = market): HostMetadataRecord => ({
  address, values: normalizeHostMetadata(address, { nodeAddress: address, marketAddress }),
  fetchedAtMs: 500, retained: false, error: null, marketError: null,
});

test("ordered market queues preserve exact ordering, sanitize fields and separate check/indexer times", async () => {
  const calls: string[] = [];
  const provider = createMarketQueueProvider({ now: () => 1000, fetch: async (input, init) => {
    calls.push(String(input));
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit");
    assert.deepEqual(init?.headers, { Accept: "application/json" });
    assert(init?.signal instanceof AbortSignal);
    return Response.json(payload());
  } });
  assert.deepEqual(calls, []);
  assert.deepEqual(await provider(market), { marketAddress: market, queueType: 1, queue: [other, host],
    checkedAtMs: 1000, validUntilMs: 31_000, sourceUpdatedAtMs: 0, retained: false, error: null });
  assert.deepEqual(calls, [`https://blockchain-indexer.k8s.prd.nos.ci/markets/${market}`]);
});

test("queue identity, counts, type, timestamps and every member must validate before any position is trusted", () => {
  const invalid: unknown[] = [null, [], { ...payload(), address: markets[1] }, { ...payload(), queueType: 2 },
    { ...payload(), nodesInQueue: 3 }, { ...payload(), jobsInQueue: 1 }, { ...payload(), nodesInQueue: -1 },
    { ...payload(), nodesInQueue: 1.5 }, { ...payload(), queue: [host, "invalid"] },
    { ...payload(), queue: [host, host] }, { ...payload(), queue: [host, "0".repeat(32)] },
    { ...payload(), updatedAt: -1 }, { ...payload(), updatedAt: null }, { ...payload(), updatedAt: "10" },
    { ...payload(), updatedAt: Number.MAX_SAFE_INTEGER }, { ...payload(), updatedAt: 8_640_000_000_001 }, { ...payload(), queue: null },
    { ...payload(), queueType: 255 }, { ...payload(), queueType: 0 },
  ];
  for (const value of invalid) assert.throws(() => normalizeMarketQueue(market, value));
  assert.throws(() => normalizeMarketQueue("bad", payload()));
  const empty = { ...payload(market, []), queueType: 255 };
  assert.deepEqual(normalizeMarketQueue(market, empty).queue, []);
  const jobs = { ...payload(), queueType: 0, nodesInQueue: 0, jobsInQueue: 2 };
  assert.equal(normalizeMarketQueue(market, jobs).queueType, 0);
  for (const patch of [{ queue: [host] }, { nodesInQueue: 1 }, { jobsInQueue: 1 }]) {
    assert.throws(() => normalizeMarketQueue(market, { ...empty, ...patch }));
  }
});

test("market successes cache for 15 seconds; caller mutations cannot alter the cached ordered list", async () => {
  let now = 1000;
  let calls = 0;
  const provider = createMarketQueueProvider({ now: () => now, fetch: async () => { calls++; return Response.json(payload()); } });
  const first = await provider(market);
  (first.queue as string[]).reverse();
  first.checkedAtMs = 999999;
  now = 15_999;
  assert.deepEqual((await provider(market)).queue, [other, host]);
  assert.equal(calls, 1);
  now++;
  assert.equal((await provider(market)).checkedAtMs, 16_000);
  assert.equal(calls, 2);
});

test("overlapping position browsers share inflight market reads with at most two concurrent requests", async () => {
  let calls = 0;
  let active = 0;
  let maximum = 0;
  const provider = createMarketQueueProvider({ fetch: async input => {
    calls++;
    maximum = Math.max(maximum, ++active);
    await setImmediate();
    active--;
    return Response.json(payload(String(input).split("/").at(-1)!));
  } });
  const result = await Promise.all([...markets, ...markets].map(address => provider(address)));
  assert.equal(calls, 3);
  assert.equal(maximum, 2);
  assert(result.every(record => record.error === null));
  assert.notEqual(result[0]?.queue, result[3]?.queue);
});

test("failed market refresh freezes previous evidence and backs off for at least 60 seconds", async () => {
  let now = 1000;
  let fail = false;
  let calls = 0;
  const provider = createMarketQueueProvider({ now: () => now, fetch: async () => {
    calls++;
    return fail ? new Response("untrusted diagnostic", { status: 503 }) : Response.json(payload());
  } });
  const first = await provider(market);
  now = 16_000;
  fail = true;
  const failed = await provider(market);
  assert.deepEqual(failed.queue, first.queue);
  assert.equal(failed.checkedAtMs, first.checkedAtMs);
  assert.equal(failed.validUntilMs, first.validUntilMs);
  assert.equal(failed.retained, true);
  assert.match(failed.error!, /HTTP 503/);
  assert(!JSON.stringify(failed).includes("untrusted"));
  now = 75_999;
  assert.deepEqual(await provider(market), failed);
  assert.equal(calls, 2);
  now++;
  fail = false;
  assert.equal((await provider(market)).retained, false);
  assert.equal(calls, 3);
});

test("Retry-After pauses all market queues and accepts HTTP dates with a one-minute floor", async () => {
  for (const status of [429, 503]) for (const [retry, wait] of [["120", 120_000], ["Wed, 07 Oct 2026 12:03:00 GMT", 180_000], ["bad", 60_000], ["0", 60_000]] as const) {
    let now = Date.parse("2026-10-07T12:00:00Z");
    let calls = 0;
    let fail = true;
    const provider = createMarketQueueProvider({ now: () => now, fetch: async input => {
      calls++;
      return fail ? new Response("", { status, headers: { "Retry-After": retry } })
        : Response.json(payload(String(input).split("/").at(-1)!));
    } });
    await provider(market);
    await provider(markets[1]!);
    assert.equal(calls, 1);
    now += wait - 1;
    await provider(market);
    assert.equal(calls, 1);
    now++;
    fail = false;
    assert.equal((await provider(markets[1]!)).error, null);
    assert.equal(calls, 2);
  }
});

test("future indexer processing timestamps retain previous evidence without establishing State", async () => {
  let now = 1000;
  let future = false;
  const provider = createMarketQueueProvider({ now: () => now, fetch: async () =>
    Response.json({ ...payload(), updatedAt: future ? now / 1000 + 1 : 0 }) });
  const first = await provider(market);
  now += 15_000;
  future = true;
  const result = await provider(market);
  assert.equal(result.retained, true);
  assert.match(result.error!, /future/);
  assert.equal(result.checkedAtMs, first.checkedAtMs);
  assert.equal(result.sourceUpdatedAtMs, first.sourceUpdatedAtMs);
  const activity = createNodeActivityProvider({ now: () => now, marketQueueProvider: provider,
    fetch: async () => Response.json([]) });
  assert.equal((await activity([{ address: host, marketAddress: market }])).get(host)?.state, null);
});

test("timeouts, oversized bodies, malformed JSON and fetch errors produce bounded failures", async () => {
  const cases: Array<[typeof fetch, RegExp]> = [
    [async (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))), /timed out/],
    [async () => new Response("", { headers: { "content-length": String(1024 * 1024 + 1) } }), /size limit/],
    [async () => new Response(" ".repeat(1024 * 1024 + 1)), /size limit/],
    [async () => new Response("not-json"), /valid JSON/],
    [async () => { throw new Error("private failure"); }, /could not be completed/],
  ];
  for (const [fetch, message] of cases) {
    const provider = createMarketQueueProvider({ fetch, timeoutMs: 5 });
    const result = await provider(market);
    assert.equal(result.queue, null);
    assert.equal(result.checkedAtMs, null);
    assert.equal(result.retained, false);
    assert.match(result.error!, message);
    assert(!result.error?.includes("private"));
  }
});

test("host positions are one-based and only node queues establish position; absence and empty queues clear", async () => {
  let now = 1000;
  let current = payload();
  const marketsProvider = createMarketQueueProvider({ now: () => now, fetch: async () => Response.json(current) });
  const provider = createQueueProvider({ now: () => now, marketQueueProvider: marketsProvider,
    metadataProvider: async addresses => ({ hosts: addresses.map(address => metadata(address)) }) });
  const first = (await provider([host, other])).hosts;
  assert.deepEqual(first.map(record => record.position), [2, 1]);
  assert.deepEqual(first.map(record => record.total), [2, 2]);
  first[0]!.position = 99;
  assert.equal((await provider([host])).hosts[0]?.position, 2);
  now += 15_000;
  current = payload(market, [other]);
  assert.equal((await provider([host])).hosts[0]?.position, null);
  now += 15_000;
  current = { ...payload(market, []), queueType: 255 };
  assert.equal((await provider([host])).hosts[0]?.total, 0);
  now += 15_000;
  current = { ...payload(), queueType: 0, jobsInQueue: 2, nodesInQueue: 0 };
  const jobs = (await provider([host])).hosts[0]!;
  assert.equal(jobs.position, null);
  assert.equal(jobs.total, 0);
  assert.equal(jobs.error, null);
});

test("host queue failure retains only the same market, and migration cannot revive old positions", async () => {
  let now = 1000;
  let assigned = market;
  let fail = false;
  let metadataFail = false;
  const marketQueueProvider = createMarketQueueProvider({ now: () => now, fetch: async input => fail
    ? new Response("", { status: 503 }) : Response.json(payload(String(input).split("/").at(-1)!)) });
  const provider = createQueueProvider({ now: () => now, marketQueueProvider,
    metadataProvider: async () => { if (metadataFail) throw new Error("private"); return { hosts: [metadata(host, assigned)] }; } });
  const first = (await provider([host])).hosts[0]!;
  fail = true;
  now += 15_000;
  const failed = (await provider([host])).hosts[0]!;
  assert.equal(failed.position, 2);
  assert.equal(failed.retained, true);
  assert.equal(failed.checkedAtMs, first.checkedAtMs);
  assigned = markets[1]!;
  const moved = (await provider([host])).hosts[0]!;
  assert.equal(moved.position, null);
  assert.equal(moved.marketAddress, assigned);
  assert.equal(moved.retained, false);
  metadataFail = true;
  assert.equal((await provider([host])).hosts[0]?.position, null);
});

test("invalid, missing and ambiguous market metadata never causes a queue lookup", async () => {
  for (const hosts of [[], [metadata(other)], [metadata(), metadata()], [metadata(host, null)],
    [{ ...metadata(), retained: true }], [{ ...metadata(), error: "failed" }]]) {
    const provider = createQueueProvider({ metadataProvider: async () => ({ hosts }),
      marketQueueProvider: async () => { assert.fail("untrusted market lookup"); } });
    const result = (await provider([host])).hosts[0]!;
    assert.equal(result.position, null);
    assert.match(result.error!, /current market assignment/);
  }
});

test("provider identity mismatches and stale queue evidence cannot set host positions", async () => {
  for (const patch of [{ marketAddress: markets[1]! }, { validUntilMs: 999 }, { retained: true }, { error: "failed" }]) {
    const provider = createQueueProvider({ now: () => 1000, metadataProvider: async () => ({ hosts: [metadata()] }),
      marketQueueProvider: async () => ({ marketAddress: market, queueType: 1, queue: [host], checkedAtMs: 500,
        validUntilMs: 30_500, sourceUpdatedAtMs: 100, retained: false, error: null, ...patch }) });
    const result = (await provider([host])).hosts[0]!;
    assert.equal(result.position, null);
    assert(result.error);
  }
});

test("invalid inputs and empty hosts never dispatch metadata or market reads", async () => {
  const marketProvider = createMarketQueueProvider({ fetch: async () => { assert.fail("must not fetch"); } });
  await assert.rejects(marketProvider("invalid"), /validated market/);
  const provider = createQueueProvider({ metadataProvider: async () => { assert.fail("must not read metadata"); }, marketQueueProvider: marketProvider });
  for (const addresses of [[host, host], ["invalid"]]) await assert.rejects(provider(addresses), /unique validated/);
  assert.deepEqual(await provider([]), { hosts: [] });
});

test("State and Queued share one ordered market read; failed retained queues cannot establish State", async () => {
  let now = 1000;
  let marketCalls = 0;
  let fail = false;
  const marketQueueProvider = createMarketQueueProvider({ now: () => now, fetch: async () => {
    marketCalls++;
    await setImmediate();
    return fail ? new Response("", { status: 503 }) : Response.json(payload());
  } });
  const queue = createQueueProvider({ now: () => now, marketQueueProvider,
    metadataProvider: async () => ({ hosts: [metadata()] }) });
  const activity = createNodeActivityProvider({ now: () => now, marketQueueProvider, fetch: async input => {
    assert.equal(new URL(String(input)).pathname, "/jobs/running-nodes");
    return Response.json([]);
  } });
  const request = [{ address: host, marketAddress: market }];
  const [positions, states] = await Promise.all([queue([host]), activity(request)]);
  assert.equal(marketCalls, 1);
  assert.equal(positions.hosts[0]?.position, 2);
  assert.equal(states.get(host)?.state, "QUEUED");
  now += 15_000;
  fail = true;
  const [failedPosition, failedState] = await Promise.all([queue([host]), activity(request)]);
  assert.equal(marketCalls, 2);
  assert.equal(failedPosition.hosts[0]?.position, 2);
  assert.equal(failedPosition.hosts[0]?.retained, true);
  assert.equal(failedState.get(host)?.state, null);
  assert(failedState.get(host)?.error);
});
