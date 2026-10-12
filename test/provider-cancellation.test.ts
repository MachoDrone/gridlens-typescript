import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createHostMetadataProvider } from "../scripts/host-metadata.ts";
import { createNodeInfoProvider } from "../scripts/node-info.ts";
import { createNodeActivityProvider, createReconciledNodeInfoProvider } from "../scripts/node-activity.ts";
import { createJobProvider } from "../scripts/jobs.ts";
import { createMarketQueueProvider, createQueueProvider } from "../scripts/market-queue.ts";

const host = "1".repeat(31) + "2";
const market = "1".repeat(31) + "A";
const base58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const addresses = Array.from({ length: 200 }, (_, index) => {
  const value = index + 256;
  return `${"1".repeat(30)}${base58[Math.floor(value / 58)]}${base58[value % 58]}`;
});

function payload(input: Parameters<typeof fetch>[0]): Response {
  const url = new URL(String(input));
  if (url.pathname.endsWith("/metrics")) return Response.json({ nodeAddress: url.pathname.split("/")[2], status: "PREMIUM" });
  if (url.pathname === "/node/info") return Response.json({ node: url.hostname.split(".")[0], state: "QUEUED" });
  if (url.pathname === "/jobs/") return Response.json({ jobs: [], totalJobs: 0 });
  if (url.pathname === "/jobs/running-nodes") return Response.json([host]);
  if (url.pathname === "/nodes/queued-nodes") return Response.json([]);
  return Response.json({ address: market, queueType: 1, queue: [host], nodesInQueue: 1, jobsInQueue: 0, updatedAt: 0 });
}

function assertSuccessful(value: unknown): void {
  assert(value && typeof value === "object");
  const records: unknown[] = value instanceof Map ? [...value.values()]
    : "hosts" in value && Array.isArray(value.hosts) ? value.hosts : [value];
  assert(records.length > 0);
  for (const record of records) {
    assert(record && typeof record === "object" && "error" in record);
    assert.equal(record.error, null);
    if ("retained" in record) assert.equal(record.retained, false);
  }
}

const adapters: {
  name: string;
  calls: number;
  create: (fetcher: typeof fetch, now?: () => number) => (signal?: AbortSignal) => Promise<unknown>;
}[] = [
  { name: "metadata", calls: 1, create: (fetcher, now = () => 0) => {
    const provider = createHostMetadataProvider({ fetch: fetcher, now });
    return signal => provider([host], signal);
  } },
  { name: "Node Info", calls: 1, create: (fetcher, now = () => 0) => {
    const provider = createNodeInfoProvider({ fetch: fetcher, now });
    return signal => provider([host], signal);
  } },
  { name: "job assignment", calls: 1, create: (fetcher, now = () => 0) => {
    const provider = createJobProvider({ fetch: fetcher, now });
    return signal => provider([host], signal);
  } },
  { name: "market queue", calls: 1, create: (fetcher, now = () => 0) => {
    const provider = createMarketQueueProvider({ fetch: fetcher, now });
    return signal => provider(market, signal);
  } },
  { name: "activity membership", calls: 2, create: (fetcher, now = () => 0) => {
    const provider = createNodeActivityProvider({ fetch: fetcher, now });
    return signal => provider([{ address: host, marketAddress: market }], signal);
  } },
];

for (const adapter of adapters) {
  test(`${adapter.name}: a disconnected consumer leaves another viewer's shared reads running`, async () => {
    const signals: AbortSignal[] = [];
    const releases: (() => void)[] = [];
    const read = adapter.create(async (input, init) => {
      signals.push(init!.signal!);
      await new Promise<void>(resolve => { releases.push(resolve); });
      return payload(input);
    });
    const leaving = new AbortController();
    const one = read(leaving.signal);
    const two = read();
    await setImmediate();
    assert.equal(signals.length, adapter.calls);
    const rejected = assert.rejects(one, { name: "AbortError" });
    leaving.abort();
    await rejected;
    assert(signals.every(signal => !signal.aborted));
    releases.forEach(release => release());
    const successful = await two;
    assertSuccessful(successful);
    assert.equal(signals.length, adapter.calls);
  });

  test(`${adapter.name}: final cancellation ignores late throttling and resumes without a cooldown`, async () => {
    let now = 0;
    let holding = true;
    let calls = 0;
    const signals: AbortSignal[] = [];
    const releases: (() => void)[] = [];
    const read = adapter.create(async (input, init) => {
      calls++;
      if (!holding) return payload(input);
      signals.push(init!.signal!);
      await new Promise<void>(resolve => { releases.push(resolve); });
      return new Response("", { status: 429, headers: { "Retry-After": "900" } });
    }, () => now);
    const controller = new AbortController();
    const canceled = read(controller.signal);
    await setImmediate();
    const rejected = assert.rejects(canceled, { name: "AbortError" });
    controller.abort();
    holding = false;
    const resumed = read();
    assert(signals.every(signal => signal.aborted));
    releases.forEach(release => release());
    await rejected;
    const result = await resumed;
    assertSuccessful(result);
    assert.equal(calls, adapter.calls * 2);
    // Past each success cache, but still before the late response's Retry-After.
    now = 300_001;
    await read();
    assert.equal(calls, adapter.calls * 3);
  });
}

for (const [name, create] of [
  ["metadata", createHostMetadataProvider], ["Node Info", createNodeInfoProvider], ["jobs", createJobProvider],
] as const) {
  test(`${name}: hiding a 200-host viewer aborts its bounded active reads and removes every queued read`, async () => {
    const concurrency = name === "Node Info" ? 4 : 2;
    let calls = 0;
    let aborted = 0;
    let holding = true;
    const provider = create({ now: () => 0, fetch: async (input, init) => {
      calls++;
      if (!holding) return payload(input);
      return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => {
        aborted++;
        reject(init!.signal!.reason);
      }, { once: true }));
    } });
    const controller = new AbortController();
    const pending = provider(addresses, controller.signal);
    await setImmediate();
    assert.equal(calls, concurrency);
    const rejected = assert.rejects(pending, { name: "AbortError" });
    controller.abort();
    holding = false;
    const resumed = provider([addresses[199]!]);
    await rejected;
    await resumed;
    await setImmediate();
    assert.equal(aborted, concurrency);
    assert.equal(calls, concurrency + 1);
  });
}

test("metadata survives a queue-view disconnect while its independent viewer remains", async () => {
  let release!: () => void;
  let upstream!: AbortSignal;
  let calls = 0;
  const metadataProvider = createHostMetadataProvider({ now: () => 0, fetch: async (_input, init) => {
    calls++;
    upstream = init!.signal!;
    await new Promise<void>(resolve => { release = resolve; });
    return Response.json({ nodeAddress: host, status: "PREMIUM" });
  } });
  const queueProvider = createQueueProvider({ metadataProvider, marketQueueProvider: async () => { throw new Error("No market"); } });
  const controller = new AbortController();
  const queued = queueProvider([host], controller.signal);
  const metadata = metadataProvider([host]);
  await setImmediate();
  const rejected = assert.rejects(queued, { name: "AbortError" });
  controller.abort();
  await rejected;
  assert.equal(upstream.aborted, false);
  release();
  assert.equal((await metadata).hosts[0]?.values?.status, "PREMIUM");
  assert.equal(calls, 1);
});

test("State and Queued retain their shared market read until the last route disconnects", async () => {
  let upstream!: AbortSignal;
  let calls = 0;
  const marketQueueProvider = createMarketQueueProvider({ fetch: async (_input, init) => {
    calls++;
    upstream = init!.signal!;
    return new Promise<Response>((_resolve, reject) => upstream.addEventListener("abort", () => reject(upstream.reason), { once: true }));
  } });
  const metadataProvider = createHostMetadataProvider({ fetch: async input => String(input).includes("/markets/")
    ? Response.json({ address: market, slug: "sample" })
    : Response.json({ nodeAddress: host, status: "PREMIUM", marketAddress: market }) });
  const nodeInfoProvider = createReconciledNodeInfoProvider({
    metadataProvider,
    nodeInfoProvider: createNodeInfoProvider({ fetch: async () => Response.json({ node: host, state: "OTHER" }) }),
    activityProvider: createNodeActivityProvider({ marketQueueProvider, fetch: async () => Response.json([]) }),
  });
  const queueProvider = createQueueProvider({ metadataProvider, marketQueueProvider });
  const stateController = new AbortController();
  const queueController = new AbortController();
  const state = nodeInfoProvider([host], stateController.signal);
  const queue = queueProvider([host], queueController.signal);
  await setImmediate();
  assert.equal(calls, 1);
  const rejectedState = assert.rejects(state, { name: "AbortError" });
  stateController.abort();
  await rejectedState;
  assert.equal(upstream.aborted, false);
  const rejectedQueue = assert.rejects(queue, { name: "AbortError" });
  queueController.abort();
  await rejectedQueue;
  assert.equal(upstream.aborted, true);
});

test("canceling a Node Info refresh cannot overwrite retained data with a late successful response", async () => {
  let now = 0;
  let calls = 0;
  let release!: () => void;
  const provider = createNodeInfoProvider({ now: () => now, fetch: async () => {
    calls++;
    if (calls === 2) {
      await new Promise<void>(resolve => { release = resolve; });
      return Response.json({ node: host, state: "RESTARTING" });
    }
    return Response.json({ node: host, state: calls === 1 ? "QUEUED" : "RUNNING_JOB" });
  } });
  const initial = (await provider([host])).hosts[0]!;
  now = 15_000;
  const controller = new AbortController();
  const old = provider([host], controller.signal);
  await setImmediate();
  const rejected = assert.rejects(old, { name: "AbortError" });
  controller.abort();
  const current = (await provider([host])).hosts[0]!;
  assert.equal(current.values?.state, "RUNNING_JOB");
  assert.equal(current.error, null);
  assert.equal(initial.values?.state, "QUEUED");
  release();
  await rejected;
  await setImmediate();
  assert.deepEqual((await provider([host])).hosts[0], current);
  assert.equal(calls, 3);
});

test("job batches share cancellation across address aliases and discard obsolete completions", async () => {
  let now = 1_000_000;
  const hosts = [host, "1".repeat(31) + "3"];
  const jobs = hosts.map((node, index) => ({ address: "1".repeat(31) + ["B", "C"][index],
    node, state: "RUNNING", timeStart: 900, timeEnd: 0, timeout: 300 }));
  const releases: ((response: Response) => void)[] = [];
  const signals: AbortSignal[] = [];
  const provider = createJobProvider({ now: () => now, fetch: async (input, init) => {
    if (init?.method !== "POST") {
      const node = new URL(String(input)).searchParams.get("node");
      return Response.json({ jobs: jobs.filter(job => job.node === node), totalJobs: 1 });
    }
    signals.push(init.signal!);
    return new Promise(resolve => { releases.push(resolve); });
  } });
  await provider(hosts);
  now += 120_000;
  const first = new AbortController();
  const wholeBatch = provider(hosts, first.signal);
  const joinedHost = provider([hosts[1]!]);
  await setImmediate();
  const rejectedWhole = assert.rejects(wholeBatch, { name: "AbortError" });
  first.abort();
  await rejectedWhole;
  assert.equal(signals[0]?.aborted, false);
  releases[0]!(Response.json(jobs));
  assertSuccessful(await joinedHost);
  now += 120_000;
  const second = new AbortController();
  const obsolete = provider(hosts, second.signal);
  await setImmediate();
  const rejectedOld = assert.rejects(obsolete, { name: "AbortError" });
  second.abort();
  const resumed = provider(hosts);
  await setImmediate();
  assert.equal(signals[1]?.aborted, true);
  assert.equal(signals.length, 3);
  const extended = jobs.map(job => ({ ...job, timeout: 600 }));
  releases[2]!(Response.json(extended));
  const current = await resumed;
  assert(current.hosts.every(record => record.job?.timeout === 600));
  releases[1]!(Response.json(jobs));
  await rejectedOld;
  await setImmediate();
  assert.deepEqual(await provider(hosts), current);
});
