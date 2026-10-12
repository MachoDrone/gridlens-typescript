import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createNodeInfoProvider } from "../scripts/node-info.ts";
import type { NodeInfoRecord } from "../src/fleet/node-info.ts";
import { projectNodeApi } from "../src/fleet/node-api.ts";
import { projectNodeState } from "../src/fleet/node-state.ts";

const base = Date.UTC(2026, 9, 7, 12);
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

test("one Retry-After pauses 86 hosts without turning undispatched healthy reads into failures", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: base });
  const addresses = roster(86);
  const records = new Map<string, NodeInfoRecord>();
  let pausedAddress = "";
  let pausedAt = 0;
  let callsDuringPause = 0;
  let duringPauseChecked = false;
  const provider = createNodeInfoProvider({ fetch: async input => {
    const address = addressFrom(input);
    if (pausedAt && Date.now() > pausedAt && Date.now() < pausedAt + 60_000) callsDuringPause++;
    if (!pausedAt && Date.now() - base >= 30_000) {
      pausedAt = Date.now();
      pausedAddress = address;
      return new Response("", { status: 429, headers: { "Retry-After": "60" } });
    }
    return Response.json({ node: address, state: "QUEUED" });
  } });
  const controller = new AbortController();
  const pending = provider.watch!(addresses, controller.signal, update => {
    for (const record of update.hosts) records.set(record.address, record);
  }).catch(() => {});
  for (let elapsed = 0; elapsed < 100_000; elapsed += 100) {
    t.mock.timers.tick(100);
    await setImmediate();
    if (pausedAt && !duringPauseChecked && Date.now() >= pausedAt + 10_000) {
      duringPauseChecked = true;
      const snapshot = await provider(addresses);
      for (const record of snapshot.hosts.filter(record => record.address !== pausedAddress)) {
        assert.equal(record.error, null);
        assert.equal(record.retained, false);
        assert.equal(record.apiCheck?.status, "online");
        assert(record.apiCheck!.checkedAtMs <= pausedAt);
      }
      assert.equal(provider.nextRefreshAt?.(addresses), pausedAt + 60_000);
    }
  }
  assert(duringPauseChecked);
  assert.equal(callsDuringPause, 0);
  assert.equal(records.size, 86);
  assert([...records.values()].every(record => {
    const view = projectNodeApi(record, Date.now());
    return view.status === "Online" && view.current;
  }),
    "all healthy hosts should recover within ten seconds of the shared pause ending");
  controller.abort();
  await pending;
});

test("warm deferral preserves outcome and failure count; cold deferral receives ordinary startup capacity", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: base });
  const addresses = roster(4);
  let phase: "warm" | "pause" | "recover" = "warm";
  let calls = 0;
  const provider = createNodeInfoProvider({ fetch: async input => {
    calls++;
    const address = addressFrom(input);
    if (phase === "pause" && address === addresses[1]) return new Response("", { status: 429, headers: { "Retry-After": "60" } });
    return Response.json({ node: address, state: "QUEUED" });
  } });
  const original = (await provider([addresses[0]!])).hosts[0]!;
  t.mock.timers.tick(15_000);
  phase = "pause";
  await provider([addresses[1]!]);
  assert.deepEqual((await provider([addresses[0]!])).hosts[0], original);
  const deferred = (await provider(addresses.slice(2))).hosts;
  assert(deferred.every(record => record.values === null && record.apiCheck?.status === "other"));
  assert.equal(calls, 2);
  phase = "recover";
  const controller = new AbortController();
  const recovered = new Map<string, NodeInfoRecord>();
  const pending = provider.watch!(addresses, controller.signal, update => {
    for (const record of update.hosts) recovered.set(record.address, record);
  }).catch(() => {});
  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(calls, 6, "cold deferred records must use all ordinary slots instead of one failed-host turn");
  assert([...recovered.values()].every(record => record.error === null));
  controller.abort();
  await pending;

  let clock = base;
  let failure = false;
  const warm = createNodeInfoProvider({ now: () => clock, fetch: async input => {
    if (addressFrom(input) === addresses[1]) return new Response("", { status: 429, headers: { "Retry-After": "60" } });
    return failure ? new Response("", { status: 503 }) : Response.json({ node: addresses[0], state: "QUEUED" });
  } });
  const before = (await warm([addresses[0]!])).hosts[0]!;
  clock += 15_000;
  await warm([addresses[1]!]);
  assert.deepEqual((await warm([addresses[0]!])).hosts[0], before);
  clock += 60_000;
  failure = true;
  await warm([addresses[0]!]);
  assert.equal(warm.nextRefreshAt?.([addresses[0]!]), clock + 1_000,
    "a skipped request must not count as a failed confirmation or consume the first confirmation turn");
});

test("transient timeouts recover ahead of persistent outages while healthy State retains its original TTL", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: base });
  const addresses = roster(86);
  const permanent = new Set(addresses.slice(0, 12));
  const transient = new Set(addresses.slice(12, 16));
  const stable = addresses.slice(16);
  const attempts = new Map<string, number>();
  const failedAt = new Map<string, number>();
  const recoveredAt = new Map<string, number>();
  const retryStarts: number[] = [];
  const records = new Map<string, NodeInfoRecord>();
  let active = 0;
  let failedActive = 0;
  let maximum = 0;
  let maximumFailed = 0;
  const provider = createNodeInfoProvider({ fetch: async (input, init) => {
    const address = addressFrom(input);
    const attempt = (attempts.get(address) ?? 0) + 1;
    attempts.set(address, attempt);
    const retry = Boolean(records.get(address)?.error);
    if (transient.has(address) && attempt === 3) retryStarts.push(Date.now());
    maximum = Math.max(maximum, ++active);
    if (retry) maximumFailed = Math.max(maximumFailed, ++failedActive);
    try {
      if (transient.has(address) && attempt === 2) await delayed(9000, init?.signal);
      else await delayed(permanent.has(address) ? 1000 : 600 + addresses.indexOf(address) % 4 * 100, init?.signal);
      return permanent.has(address) ? new Response("", { status: 503 }) : Response.json({ node: address, state: "QUEUED" });
    } finally { active--; if (retry) failedActive--; }
  } });
  const controller = new AbortController();
  const pending = provider.watch!(addresses, controller.signal, update => {
    for (const record of update.hosts) {
      records.set(record.address, record);
      if (transient.has(record.address) && record.error) failedAt.set(record.address, Date.now());
      if (!record.error && failedAt.has(record.address) && !recoveredAt.has(record.address)) recoveredAt.set(record.address, Date.now());
    }
  }).catch(() => {});
  for (let elapsed = 0; elapsed < 600_000; elapsed += 100) {
    t.mock.timers.tick(100);
    await setImmediate();
    if (elapsed >= 120_000 && elapsed % 1000 === 0) {
      assert(stable.every(address => projectNodeState(records.get(address), Date.now()).current !== null));
    }
  }
  assert.equal(recoveredAt.size, 4);
  for (const address of transient) {
    const delay = recoveredAt.get(address)! - failedAt.get(address)!;
    assert(delay >= 1_000 && delay < 30_000, `warm confirmation was delayed ${delay}ms by the cold confirmation sweep`);
  }
  for (let index = 1; index < retryStarts.length; index++) assert(retryStarts[index]! - retryStarts[index - 1]! >= 5_000);
  assert([...permanent].every(address => (attempts.get(address) ?? 0) >= 2), "persistent failures retain a fair recovery turn");
  assert.equal(maximum, 4);
  assert.equal(maximumFailed, 1);
  controller.abort();
  await pending;
});

test("canceling a transient recovery turn permits immediate rejoin without a new five-second cooldown", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: base });
  const address = roster(1)[0]!;
  let calls = 0;
  const provider = createNodeInfoProvider({ fetch: async (_input, init) => {
    calls++;
    if (calls === 2) return new Response("", { status: 503 });
    if (calls >= 3) await delayed(calls === 3 ? 5000 : 100, init?.signal);
    return Response.json({ node: address, state: "QUEUED" });
  } });
  await provider([address]);
  t.mock.timers.tick(15_000);
  await provider([address]);
  const first = new AbortController();
  const old = provider.watch!([address], first.signal, () => {}).catch(() => {});
  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(calls, 3);
  first.abort();
  const second = new AbortController();
  const updates: NodeInfoRecord[] = [];
  const resumed = provider.watch!([address], second.signal, update => updates.push(...update.hosts)).catch(() => {});
  await setImmediate();
  assert.equal(calls, 4);
  t.mock.timers.tick(100);
  await setImmediate();
  assert.equal(updates.at(-1)?.error, null);
  assert.equal(updates.at(-1)?.apiCheck?.status, "online");
  second.abort();
  await Promise.all([old, resumed]);
});
