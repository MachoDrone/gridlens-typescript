import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createDemandWatch } from "../scripts/demand-watch.ts";
import { createNodeInfoProvider } from "../scripts/node-info.ts";
import { createHostMetadataProvider } from "../scripts/host-metadata.ts";
import { createNodeActivityProvider, createReconciledNodeInfoProvider } from "../scripts/node-activity.ts";
import { createMarketQueueProvider, createQueueProvider } from "../scripts/market-queue.ts";
import { projectNodeState } from "../src/fleet/node-state.ts";
import type { NodeInfoRecord } from "../src/fleet/node-info.ts";
import type { QueueRecord } from "../src/fleet/queue.ts";

const base = Date.parse("2026-10-07T12:00:00Z");
const base58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function roster(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const value = index + 256;
    return `${"1".repeat(30)}${base58[Math.floor(value / 58)]}${base58[value % 58]}`;
  });
}
const markets = ["A", "B", "C"].map(value => "1".repeat(31) + value);

function delayed(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const cancel = (): void => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, ms);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

for (const size of [86, 200]) test(`${size} hosts keep independent State and queue evidence current for ten minutes across two viewers`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: base });
  const addresses = roster(size);
  const failed = new Set(addresses.slice(-Math.min(12, Math.floor(size / 12))));
  const healthy = addresses.filter(address => !failed.has(address));
  const calls = new Map<string, number>();
  const activityCounts = { metadata: 0, node: 0, market: 0, membership: 0 };
  const maximum = { ...activityCounts };
  const total = { ...activityCounts };
  const checked = <K extends keyof typeof activityCounts>(kind: K, fetcher: typeof fetch): typeof fetch => async (input, init) => {
    total[kind]++;
    maximum[kind] = Math.max(maximum[kind], ++activityCounts[kind]);
    try { return await fetcher(input, init); }
    finally { activityCounts[kind]--; }
  };
  const marketOf = (address: string): string => markets[addresses.indexOf(address) % markets.length]!;
  const queueFor = (market: string): string[] => {
    const members = healthy.filter((address, index) => marketOf(address) === market && index % 2 === 1);
    return Date.now() - base >= 300_000 ? members.reverse() : members;
  };
  const metadataProvider = createHostMetadataProvider({ fetch: checked("metadata", async (input, init) => {
    await delayed(40, init?.signal);
    const path = new URL(String(input)).pathname;
    const address = path.split("/")[2]!;
    return Response.json(path.startsWith("/markets/") ? { address, slug: "demo" }
      : { nodeAddress: address, marketAddress: marketOf(address) });
  }) });
  const rawProvider = createNodeInfoProvider({ fetch: checked("node", async (input, init) => {
    const address = String(input).split("//")[1]!.split(".")[0]!;
    calls.set(address, (calls.get(address) ?? 0) + 1);
    await delayed(failed.has(address) ? 1000 : size === 86 ? 150 : 60, init?.signal);
    return failed.has(address) ? new Response("", { status: 503 }) : Response.json({ node: address, state: "OTHER" });
  }) });
  const marketQueueProvider = createMarketQueueProvider({ fetch: checked("market", async (input, init) => {
    await delayed(100, init?.signal);
    const address = String(input).split("/").at(-1)!;
    const queue = queueFor(address);
    return Response.json({ address, queueType: 1, nodesInQueue: queue.length, jobsInQueue: 0, queue, updatedAt: 0 });
  }) });
  const activityProvider = createNodeActivityProvider({ marketQueueProvider, fetch: checked("membership", async (input, init) => {
    await delayed(100, init?.signal);
    const market = new URL(String(input)).searchParams.get("market");
    return Response.json(healthy.filter((address, index) => marketOf(address) === market && index % 2 === 0));
  }) });
  const nodeProvider = createReconciledNodeInfoProvider({ nodeInfoProvider: rawProvider, metadataProvider, activityProvider });
  const queueProvider = createQueueProvider({ metadataProvider, marketQueueProvider });
  assert(nodeProvider.watch && queueProvider.watch);
  const first = new AbortController();
  const second = new AbortController();
  const states = new Map<string, NodeInfoRecord>();
  const queues = new Map<string, QueueRecord>();
  const promises = [
    nodeProvider.watch(addresses, first.signal, update => { for (const record of update.hosts) states.set(record.address, record); }),
    queueProvider.watch(addresses, first.signal, update => { for (const record of update.hosts) queues.set(record.address, record); }),
    nodeProvider.watch(addresses, second.signal, () => {}),
    queueProvider.watch(addresses, second.signal, () => {}),
  ].map(promise => promise.catch(() => {}));
  let snapshots = 0;
  let maxRawAge = 0;
  let maxProofAge = 0;
  for (let elapsed = 0; elapsed < 600_000; elapsed += 100) {
    t.mock.timers.tick(100);
    await setImmediate();
    if (elapsed === 300_000) second.abort();
    if (elapsed < 120_000 || elapsed % 1000 !== 0) continue;
    snapshots++;
    for (const address of healthy) {
      const record = states.get(address);
      assert(record, `missing State at ${elapsed}`);
      maxRawAge = Math.max(maxRawAge, Date.now() - record.fetchedAtMs!);
      maxProofAge = Math.max(maxProofAge, Date.now() - record.activity!.checkedAtMs!);
      assert(projectNodeState(record, Date.now()).current, `healthy State expired at ${elapsed}, raw age ${Date.now() - record.fetchedAtMs!}, proof age ${Date.now() - record.activity!.checkedAtMs!}`);
      const queue = queues.get(address);
      assert(queue && !queue.error && !queue.retained && queue.validUntilMs! > Date.now(), `queue expired at ${elapsed}`);
    }
  }
  assert.equal(snapshots, 480);
  assert(maxRawAge < 30_000 && maxProofAge < 30_000);
  for (const address of failed) {
    assert.equal(states.get(address)?.values, null);
    assert.match(states.get(address)?.error ?? "", /503/);
    assert((calls.get(address) ?? 0) >= 2, "every failed host must receive a turn in the paced retry sweep");
    assert((calls.get(address) ?? 0) <= 10, "failure backoff must not be bypassed");
  }
  for (const [kind, value] of Object.entries(maximum)) assert(value <= (kind === "node" ? 4 : 2));
  assert(healthy.every(address => (calls.get(address) ?? 0) < 41), "two viewers must not double upstream reads");
  const queuedAddress = healthy[1]!;
  assert.equal(queues.get(queuedAddress)?.position, queueFor(marketOf(queuedAddress)).indexOf(queuedAddress) + 1);
  first.abort();
  await Promise.all(promises);
  await setImmediate();
  const before = { ...total };
  t.mock.timers.tick(600_000);
  await setImmediate();
  assert.deepEqual(total, before, "no provider work may remain after the last viewer leaves");
  assert(Object.values(activityCounts).every(count => count === 0));
});

test("unexpected watcher errors back off and cancellation removes their idle timer", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: base });
  let calls = 0;
  const watch = createDemandWatch({
    read: async () => { calls++; throw new Error("injected failure"); },
    peek: () => undefined, dueAt: () => 0,
  });
  const controller = new AbortController();
  const pending = watch.watch(["one"], controller.signal, () => {}).catch(() => {});
  await setImmediate();
  assert.equal(calls, 1);
  t.mock.timers.tick(59_999);
  await setImmediate();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await setImmediate();
  assert.equal(calls, 2);
  controller.abort();
  await pending;
  t.mock.timers.tick(600_000);
  await setImmediate();
  assert.equal(calls, 2);
});

test("cold hosts eventually receive a turn under overload while expired readings remain gray", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: base });
  const addresses = roster(200);
  const seen = new Set<string>();
  const latest = new Map<string, NodeInfoRecord>();
  let active = 0;
  let maximum = 0;
  const provider = createNodeInfoProvider({ fetch: async (input, init) => {
    const address = String(input).split("//")[1]!.split(".")[0]!;
    maximum = Math.max(maximum, ++active);
    try {
      await delayed(800, init?.signal);
      seen.add(address);
      return Response.json({ node: address, state: "QUEUED" });
    } finally { active--; }
  } });
  const controller = new AbortController();
  const pending = provider.watch!(addresses, controller.signal,
    update => { for (const record of update.hosts) latest.set(record.address, record); }).catch(() => {});
  for (let elapsed = 0; elapsed < 600_000; elapsed += 200) {
    t.mock.timers.tick(200);
    await setImmediate();
  }
  assert.equal(seen.size, 200, "never-read hosts must not starve behind due successful reads");
  const expired = [...latest.values()].filter(record => record.validUntilMs! <= Date.now());
  assert(expired.length > 0, "this workload intentionally exceeds the public request capacity");
  assert(expired.every(record => projectNodeState(record, Date.now()).current === null));
  assert.equal(maximum, 4);
  controller.abort();
  await pending;
  await setImmediate();
  assert.equal(active, 0);
});

test("a hidden watcher cancels pending work and immediate resume cannot receive old completion", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: base });
  const addresses = roster(2);
  let attempt = 0;
  const provider = createNodeInfoProvider({ fetch: async (input, init) => {
    const address = String(input).split("//")[1]!.split(".")[0]!;
    const old = ++attempt <= 2;
    await delayed(old ? 8000 : 100, init?.signal);
    return Response.json({ node: address, state: old ? "RUNNING_JOB" : "QUEUED" });
  } });
  const first = new AbortController();
  let hiddenUpdates = 0;
  const old = provider.watch!(addresses, first.signal, () => hiddenUpdates++).catch(() => {});
  await setImmediate();
  first.abort();
  const second = new AbortController();
  const resumed: NodeInfoRecord[] = [];
  const current = provider.watch!(addresses, second.signal, update => resumed.push(...update.hosts)).catch(() => {});
  await setImmediate();
  t.mock.timers.tick(100);
  await setImmediate();
  assert.equal(hiddenUpdates, 0);
  assert.equal(resumed.length, 2);
  assert(resumed.every(record => record.values?.state === "QUEUED" && !record.error));
  second.abort();
  await Promise.all([old, current]);
  t.mock.timers.tick(8000);
  await setImmediate();
  assert.equal(resumed.length, 2);
});

test("finite roster readers reuse active watcher snapshots without a competing upstream queue", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: base });
  const addresses = roster(86);
  const calls: string[] = [];
  const provider = createNodeInfoProvider({ fetch: async (input, init) => {
    const address = String(input).split("//")[1]!.split(".")[0]!;
    calls.push(address);
    await delayed(400, init?.signal);
    return Response.json({ node: address, state: "QUEUED" });
  } });
  const controller = new AbortController();
  const pending = provider.watch!(addresses, controller.signal, () => {}).catch(() => {});
  await setImmediate();
  assert.equal(calls.length, 4);
  const cold = await provider(addresses);
  assert.equal(cold.hosts.length, 86);
  assert(cold.hosts.every(record => record.values === null && record.fetchedAtMs === null && /pending/.test(record.error!)));
  assert.equal(calls.length, 4);
  t.mock.timers.tick(400);
  await setImmediate();
  assert.equal(calls.length, 8);
  const cached = await provider(addresses);
  assert.equal(cached.hosts.filter(record => record.values?.state === "QUEUED").length, 4);
  assert.equal(cached.hosts[0]?.fetchedAtMs, base + 400);
  cached.hosts[0]!.values!.state = "CALLER_MUTATION";
  assert.equal((await provider([addresses[0]!])).hosts[0]?.values?.state, "QUEUED");
  assert.equal(calls.length, 8);
  controller.abort();
  await pending;
  await setImmediate();
  const after = calls.length;
  t.mock.timers.tick(30_000);
  await setImmediate();
  assert.equal(calls.length, after);
  const standalone = provider([addresses[0]!]);
  await setImmediate();
  t.mock.timers.tick(400);
  await setImmediate();
  assert.equal((await standalone).hosts[0]?.fetchedAtMs, Date.now());
  assert.equal(calls.length, after + 1);
});

test("86 hosts with 600–900ms reads, four-second failures and intermittent eight-second timeouts retain healthy capacity", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: base });
  const addresses = roster(86);
  const failed = new Set(addresses.slice(-12));
  const intermittent = new Set(addresses.slice(0, 2));
  const stable = addresses.filter(address => !failed.has(address) && !intermittent.has(address));
  const attempts = new Map<string, number>();
  const states = new Map<string, NodeInfoRecord>();
  let active = 0;
  let maximum = 0;
  let maxAge = 0;
  let expired = 0;
  const provider = createNodeInfoProvider({ fetch: async (input, init) => {
    const address = String(input).split("//")[1]!.split(".")[0]!;
    const attempt = (attempts.get(address) ?? 0) + 1;
    attempts.set(address, attempt);
    maximum = Math.max(maximum, ++active);
    try {
      if (intermittent.has(address) && attempt % 3 === 0) await delayed(9000, init?.signal);
      else await delayed(failed.has(address) ? 4000 : 600 + addresses.indexOf(address) % 4 * 100, init?.signal);
      return failed.has(address) ? new Response("", { status: 503 }) : Response.json({ node: address, state: "QUEUED" });
    } finally { active--; }
  } });
  const controller = new AbortController();
  const pending = provider.watch!(addresses, controller.signal, update => {
    for (const record of update.hosts) states.set(record.address, record);
  }).catch(() => {});
  for (let elapsed = 0; elapsed < 900_000; elapsed += 100) {
    t.mock.timers.tick(100);
    await setImmediate();
    if (elapsed < 120_000 || elapsed % 1000 !== 0) continue;
    for (const address of stable) {
      const record = states.get(address)!;
      const age = Date.now() - record.fetchedAtMs!;
      maxAge = Math.max(maxAge, age);
      if (age >= 30_000) expired++;
    }
  }
  controller.abort();
  await pending;
  assert.equal(maximum, 4);
  assert.equal(expired, 0, `stable hosts expired in ${expired} observations; maximum age ${maxAge}ms`);
  assert([...failed].every(address => (attempts.get(address) ?? 0) <= 10),
    "confirmed HTTP 503 outages may refresh their expired pair, while retaining exponential recovery delays");
  assert([...intermittent].every(address => (attempts.get(address) ?? 0) >= 6));
});

test("retained timeouts receive bounded recovery turns under continuous 600–900ms healthy traffic", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: base });
  const addresses = roster(74);
  const recovering = new Set(addresses.slice(-4));
  const attempts = new Map<string, number>();
  const failedAt = new Map<string, number>();
  const recoveredAt = new Map<string, number>();
  const retries: number[] = [];
  const states = new Map<string, NodeInfoRecord>();
  let active = 0;
  let maximum = 0;
  const provider = createNodeInfoProvider({ fetch: async (input, init) => {
    const address = String(input).split("//")[1]!.split(".")[0]!;
    const attempt = (attempts.get(address) ?? 0) + 1;
    attempts.set(address, attempt);
    if (recovering.has(address) && attempt === 3) retries.push(Date.now());
    maximum = Math.max(maximum, ++active);
    try {
      if (recovering.has(address) && attempt === 2) await delayed(9000, init?.signal);
      else await delayed(600 + addresses.indexOf(address) % 4 * 100, init?.signal);
      return Response.json({ node: address, state: "QUEUED" });
    } finally { active--; }
  } });
  const controller = new AbortController();
  const pending = provider.watch!(addresses, controller.signal, update => {
    for (const record of update.hosts) {
      states.set(record.address, record);
      if (record.error && record.retained) failedAt.set(record.address, Date.now());
      if (!record.error && failedAt.has(record.address) && !recoveredAt.has(record.address)) recoveredAt.set(record.address, Date.now());
    }
  }).catch(() => {});
  for (let elapsed = 0; elapsed < 600_000; elapsed += 100) {
    t.mock.timers.tick(100);
    await setImmediate();
  }
  controller.abort();
  await pending;
  assert.equal(failedAt.size, 4);
  assert.equal(recoveredAt.size, 4, "a healthy deadline tier must not starve overdue recovery forever");
  for (const address of recovering) {
    const delay = recoveredAt.get(address)! - failedAt.get(address)!;
    assert(delay >= 1_000 && delay < 30_000, `confirmation recovery exceeded four short turns: ${delay}ms`);
    assert.equal(states.get(address)?.error, null);
  }
  for (let index = 1; index < retries.length; index++) assert(retries[index]! - retries[index - 1]! >= 5_000);
  assert.equal(maximum, 4);
});

test("canceling a paced failed-host retry does not delay its immediate visible resume", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: base });
  const [address] = roster(1);
  let calls = 0;
  const provider = createNodeInfoProvider({ fetch: async (_input, init) => {
    calls++;
    if (calls === 1) return new Response("", { status: 503 });
    await delayed(calls === 2 ? 5000 : 100, init?.signal);
    return Response.json({ node: address, state: "QUEUED" });
  } });
  await provider([address!]);
  const first = new AbortController();
  const old = provider.watch!([address!], first.signal, () => {}).catch(() => {});
  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(calls, 2);
  first.abort();
  const resumed: NodeInfoRecord[] = [];
  const second = new AbortController();
  const current = provider.watch!([address!], second.signal, update => resumed.push(...update.hosts)).catch(() => {});
  await setImmediate();
  assert.equal(calls, 3, "canceled work must not leave a global recovery cooldown");
  t.mock.timers.tick(100);
  await setImmediate();
  assert.equal(resumed.at(-1)?.values?.state, "QUEUED");
  assert.equal(resumed.at(-1)?.error, null);
  assert.equal(provider.nextRefreshAt?.([address!]), Date.now() + 15_000);
  second.abort();
  await Promise.all([old, current]);
});
