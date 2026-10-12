import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createNodeInfoProvider } from "../scripts/node-info.ts";
import type { NodeInfoRecord } from "../src/fleet/node-info.ts";

const base = Date.UTC(2026, 9, 11, 12);
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function roster(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const value = index + 256;
    return `${"1".repeat(30)}${alphabet[Math.floor(value / 58)]}${alphabet[value % 58]}`;
  });
}
const addressFrom = (input: Parameters<typeof fetch>[0]): string => String(input).split("//")[1]!.split(".")[0]!;
function delayed(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

for (const count of [99, 100, 101, 200, 201, 300, 301, 500, 1000]) {
  test(`Node Info completes every initial attempt before routine repeats for ${count} hosts`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: base });
    const addresses = roster(count);
    const calls: string[] = [];
    const completed = new Map<string, NodeInfoRecord>();
    let firstAt: number | undefined;
    let coverageAt: number | undefined;
    let active = 0, maximum = 0;
    const provider = createNodeInfoProvider({ fetch: async (input, init) => {
      const address = addressFrom(input);
      calls.push(address);
      maximum = Math.max(maximum, ++active);
      try {
        await delayed(800, init?.signal);
        return Response.json({ node: address, state: calls.length % 3 ? "QUEUED" : "OTHER" });
      } finally { active--; }
    } });
    const controller = new AbortController();
    const pending = provider.watch!(addresses, controller.signal, update => {
      for (const record of update.hosts) completed.set(record.address, record);
      firstAt ??= Date.now();
      if (completed.size === count) coverageAt ??= Date.now();
    }).catch(() => {});
    await setImmediate();
    for (let index = 0; index < Math.ceil(count / 4); index++) {
      t.mock.timers.tick(800);
      await setImmediate();
    }
    assert.deepEqual(calls.slice(0, count), addresses, "every supplied host gets an initial attempt before a routine repeat");
    assert.equal(completed.size, count);
    assert.equal(firstAt, base + 800);
    assert.equal(coverageAt, base + Math.ceil(count / 4) * 800);
    assert.equal(maximum, 4);
    if (count >= 200) assert([...completed.values()].some(record => record.validUntilMs! <= Date.now()),
      "an oversized first pass preserves the original visible expiry");
    controller.abort();
    await pending;
    await setImmediate();
    assert.equal(active, 0);
  });
}

test("Node Info ordinary refresh orders expiring proof, fresh transitions, verified job hints, then routine ties", async () => {
  const addresses = roster(8);
  const [routine, routineTie, job, starting, restarting, expiring, newlyRunning, jobTie] = addresses as [string, string, string, string, string, string, string, string];
  let clock = base;
  let hold = false;
  const calls: string[] = [];
  const release: (() => void)[] = [];
  const provider = createNodeInfoProvider({ now: () => clock,
    activityPriority: address => address === newlyRunning ? 0 : address === job || address === jobTie ? 1 : 2,
    fetch: async (input, init) => {
      const address = addressFrom(input);
      if (hold) {
        calls.push(address);
        await new Promise<void>((resolve, reject) => {
          release.push(resolve);
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      return Response.json({ node: address, state: address === starting ? "STARTING" : address === restarting ? "RESTARTING" : "QUEUED" });
    },
  });
  await provider([expiring]);
  clock += 5000;
  await provider(addresses.filter(address => address !== expiring));
  clock = base + 20_000;
  hold = true;
  const controller = new AbortController();
  const pending = provider.watch!(addresses, controller.signal, () => {}).catch(() => {});
  await setImmediate();
  assert.deepEqual(calls, [expiring, starting, restarting, newlyRunning]);
  release[0]!();
  await setImmediate();
  release[1]!();
  await setImmediate();
  assert.deepEqual(calls.slice(4), [job, jobTie]);
  release[2]!();
  await setImmediate();
  release[3]!();
  await setImmediate();
  assert.deepEqual(calls.slice(6), [routine, routineTie]);
  controller.abort();
  await pending;
});

test("new Node Info viewers get their initial pass ahead of queued ordinary maintenance", async () => {
  const addresses = roster(12);
  const warm = addresses.slice(0, 8), cold = addresses.slice(8);
  let clock = base;
  let hold = false;
  const calls: string[] = [];
  const release: (() => void)[] = [];
  const provider = createNodeInfoProvider({ now: () => clock, fetch: async (input, init) => {
    const address = addressFrom(input);
    if (hold) {
      calls.push(address);
      await new Promise<void>((resolve, reject) => {
        release.push(resolve);
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }
    return Response.json({ node: address, state: "OTHER" });
  } });
  await provider(warm);
  clock += 15_000;
  hold = true;
  const first = new AbortController(), second = new AbortController();
  const firstView = provider.watch!(warm, first.signal, () => {}).catch(() => {});
  await setImmediate();
  assert.deepEqual(calls, warm.slice(0, 4));
  const secondView = provider.watch!(cold, second.signal, () => {}).catch(() => {});
  for (let index = 0; index < 4; index++) { release[index]!(); await setImmediate(); }
  assert.deepEqual(calls.slice(4), cold);
  first.abort(); second.abort();
  await Promise.all([firstView, secondView]);
});

test("finite Node Info reads reconsider new first attempts at the shared request dispatch boundary", async () => {
  const addresses = roster(9);
  const warm = addresses.slice(0, 8), cold = addresses[8]!;
  let clock = base;
  let hold = false;
  const calls: string[] = [];
  const release: (() => void)[] = [];
  const provider = createNodeInfoProvider({ now: () => clock, fetch: async (input, init) => {
    const address = addressFrom(input);
    if (hold) {
      calls.push(address);
      await new Promise<void>((resolve, reject) => {
        release.push(resolve);
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }
    return Response.json({ node: address, state: "QUEUED" });
  } });
  await provider(warm);
  clock += 15_000;
  hold = true;
  const controller = new AbortController();
  const maintenance = provider(warm, controller.signal).catch(() => {});
  await setImmediate();
  const newcomer = provider([cold], controller.signal).catch(() => {});
  await setImmediate();
  assert.deepEqual(calls, warm.slice(0, 4));
  release[0]!();
  await setImmediate();
  assert.equal(calls[4], cold);
  controller.abort();
  await Promise.all([maintenance, newcomer]);
});

test("a finite mixed roster attempts missing hosts first while preserving the requested output order", async () => {
  const addresses = roster(8);
  let clock = base;
  const calls: string[] = [];
  const provider = createNodeInfoProvider({ now: () => clock, fetch: async input => {
    const address = addressFrom(input);
    calls.push(address);
    return Response.json({ node: address, state: "OTHER" });
  } });
  await provider(addresses.slice(0, 7));
  calls.length = 0;
  clock += 15_000;
  const snapshot = await provider(addresses);
  assert.equal(calls[0], addresses[7]);
  assert.deepEqual(snapshot.hosts.map(record => record.address), addresses);
  assert(snapshot.hosts.every(record => record.fetchedAtMs === clock && record.validUntilMs === clock + 30_000));
});
