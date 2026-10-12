import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createNodeInfoProvider } from "../scripts/node-info.ts";
import { projectNodeApi } from "../src/fleet/node-api.ts";
import type { NodeInfoRecord } from "../src/fleet/node-info.ts";

const base = Date.UTC(2026, 9, 7, 12);
const addresses = Array.from({ length: 8 }, (_, index) => "1".repeat(31) + String(index + 2));
const host = addresses[0]!;
const other = addresses[1]!;
const addressFrom = (input: Parameters<typeof fetch>[0]): string => String(input).split("//")[1]!.split(".")[0]!;
function delayed(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

test("one timeout is confirmed healthy before the original 30-second success expires, without a red result", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: base });
  const updates: NodeInfoRecord[] = [];
  let requests = 0;
  const provider = createNodeInfoProvider({ fetch: async (_input, init) => {
    requests++;
    if (requests === 2) await delayed(9000, init?.signal);
    else if (requests === 3) await delayed(600, init?.signal);
    return Response.json({ node: host, state: "QUEUED" });
  } });
  const controller = new AbortController();
  const pending = provider.watch!([host], controller.signal, update => updates.push(...update.hosts)).catch(() => {});
  for (let elapsed = 0; elapsed < 30_000; elapsed += 100) {
    t.mock.timers.tick(100);
    await setImmediate();
    if (updates.length) {
      assert.equal(projectNodeApi(updates.at(-1), Date.now()).status, "Online");
      assert.equal(projectNodeApi(updates.at(-1), Date.now()).current, true);
    }
  }
  assert.equal(requests, 3);
  assert.equal(updates.length, 3);
  const [original, suspect, recovered] = updates as [NodeInfoRecord, NodeInfoRecord, NodeInfoRecord];
  assert.equal(suspect.apiCheck?.status, "other");
  assert.equal(suspect.apiCheck?.confirmationPending, true);
  assert.equal(suspect.apiCheck?.lastOnlineAtMs, original.fetchedAtMs);
  assert.equal(suspect.fetchedAtMs, original.fetchedAtMs);
  assert.equal(recovered.apiCheck?.status, "online");
  assert(recovered.fetchedAtMs! < original.fetchedAtMs! + 30_000);
  assert(!updates.some(record => record.apiCheck?.status === "offline"));
  controller.abort();
  await pending;
});

test("a warm confirmation beats a twelve-host cold outage sweep without extending its old success deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: base });
  const cold = [..."23456789ABCD"].map(suffix => "1".repeat(31) + suffix);
  const warm = "1".repeat(31) + "E";
  const counts = new Map<string, number>();
  const records: NodeInfoRecord[] = [];
  const provider = createNodeInfoProvider({ fetch: async (input, init) => {
    const address = addressFrom(input);
    const attempt = (counts.get(address) ?? 0) + 1;
    counts.set(address, attempt);
    if (address === warm) {
      await delayed(attempt === 2 ? 9000 : 650, init?.signal);
      return Response.json({ node: address, state: "QUEUED" });
    }
    await delayed(50, init?.signal);
    return new Response("", { status: 503 });
  } });
  const controller = new AbortController();
  const pending = provider.watch!([...cold, warm], controller.signal, update => {
    records.push(...update.hosts.filter(record => record.address === warm));
  }).catch(() => {});
  for (let elapsed = 0; elapsed < 45_000; elapsed += 50) {
    t.mock.timers.tick(50);
    await setImmediate();
    if (records.length) {
      assert.equal(projectNodeApi(records.at(-1), Date.now()).status, "Online");
      assert.equal(projectNodeApi(records.at(-1), Date.now()).current, true);
    }
  }
  const initial = records[0]!;
  const suspect = records.find(record => record.apiCheck?.confirmationPending)!;
  const recovered = records.find(record => record.apiCheck?.status === "online" && record.fetchedAtMs! > initial.fetchedAtMs!)!;
  assert(suspect && recovered);
  assert.equal(suspect.apiCheck?.lastOnlineAtMs, initial.fetchedAtMs);
  assert(recovered.fetchedAtMs! < initial.fetchedAtMs! + 30_000);
  assert(cold.filter(address => (counts.get(address) ?? 0) >= 2).length >= 7,
    "prioritizing the warm host must still advance the cold outage sweep");
  controller.abort();
  await pending;
});

test("cold hosts require two actual reachability failures and success resets confirmation and backoff", async () => {
  let now = base;
  let fail = true;
  let requests = 0;
  const provider = createNodeInfoProvider({ now: () => now, fetch: async () => {
    requests++;
    return fail ? new Response("", { status: 503 }) : Response.json({ node: host, state: "OTHER" });
  } });
  const first = (await provider([host])).hosts[0]!;
  assert.deepEqual(first.apiCheck, { status: "other", checkedAtMs: now, confirmationPending: true,
    firstFailedAtMs: now, failureKind: "http", phase: "headers", httpStatus: 503 });
  assert.equal(provider.nextRefreshAt?.([host]), now + 1000);
  now += 999;
  await provider([host]);
  assert.equal(requests, 1);
  now++;
  const second = (await provider([host])).hosts[0]!;
  assert.deepEqual(second.apiCheck, { status: "offline", checkedAtMs: now, firstFailedAtMs: base,
    failureKind: "http", phase: "headers", httpStatus: 503, nextCheckAtMs: now + 120_000,
    lastConfirmed: { status: "offline", checkedAtMs: now, firstFailedAtMs: base, httpStatus: 503, nextCheckAtMs: now + 120_000 } });
  assert.equal(provider.nextRefreshAt?.([host]), now + 120_000);
  now += 120_000;
  fail = false;
  assert.equal((await provider([host])).hosts[0]?.apiCheck?.status, "online");
  now += 15_000;
  fail = true;
  const reset = (await provider([host])).hosts[0]!;
  assert.equal(reset.apiCheck?.status, "other");
  assert.equal(reset.apiCheck?.confirmationPending, true);
  assert.equal(reset.apiCheck?.lastOnlineAtMs, now - 15_000);
  assert.equal(provider.nextRefreshAt?.([host]), now + 1000);
});

test("invalid, denied and rate-limited responses cannot confirm a previous reachability failure", async () => {
  for (const middle of [
    () => new Response("not-json"),
    () => Response.json({ node: other, state: "QUEUED" }),
    () => new Response("", { status: 401 }),
    () => new Response("", { status: 403 }),
    () => new Response("", { status: 429, headers: { "Retry-After": "120" } }),
  ]) {
    let now = base;
    let requests = 0;
    const provider = createNodeInfoProvider({ now: () => now, fetch: async () => ++requests === 2
      ? middle() : new Response("", { status: 503 }) });
    assert.equal((await provider([host])).hosts[0]?.apiCheck?.confirmationPending, true);
    now = provider.nextRefreshAt!([host])!;
    const unknown = (await provider([host])).hosts[0]!;
    assert.equal(unknown.apiCheck?.status, "other");
    assert.equal(unknown.apiCheck?.confirmationPending, undefined);
    now = provider.nextRefreshAt!([host])!;
    const next = (await provider([host])).hosts[0]!;
    assert.equal(next.apiCheck?.status, "other");
    assert.equal(next.apiCheck?.confirmationPending, true, "a different response must reset the reachability streak");
    assert.equal(provider.nextRefreshAt!([host]), now + 1000);
    now += 1000;
    assert.equal((await provider([host])).hosts[0]?.apiCheck?.status, "offline");
  }
});

test("Retry-After defers confirmation without supplying another failure or changing its actual check time", async () => {
  let now = base;
  let requests = 0;
  const provider = createNodeInfoProvider({ now: () => now, fetch: async input => {
    requests++;
    return addressFrom(input) === other
      ? new Response("", { status: 429, headers: { "Retry-After": "60" } })
      : new Response("", { status: 503 });
  } });
  const first = (await provider([host])).hosts[0]!;
  await provider([other]);
  now += 2000;
  assert.deepEqual((await provider([host])).hosts[0], first);
  assert.equal(requests, 2);
  assert.equal(provider.nextRefreshAt!([host]), base + 60_000);
  now = base + 60_000;
  const confirmed = (await provider([host])).hosts[0]!;
  assert.equal(confirmed.apiCheck?.status, "other");
  assert.equal(confirmed.apiCheck?.confirmationPending, true);
  assert.equal(confirmed.apiCheck?.firstFailedAtMs, now);
  assert.equal(confirmed.apiCheck?.checkedAtMs, now);
  assert.equal(provider.nextRefreshAt!([host]), now + 1000);
  now += 1000;
  const freshPair = (await provider([host])).hosts[0]!;
  assert.equal(freshPair.apiCheck?.status, "offline");
  assert.equal(freshPair.apiCheck?.firstFailedAtMs, base + 60_000);
});

test("cold confirmations share five-second pacing and one retry slot within the four-request pool", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: base });
  const counts = new Map<string, number>();
  const starts: number[] = [];
  const records = new Map<string, NodeInfoRecord>();
  let active = 0, maximum = 0, confirming = 0, maximumConfirming = 0;
  const provider = createNodeInfoProvider({ fetch: async (input, init) => {
    const address = addressFrom(input);
    const attempt = (counts.get(address) ?? 0) + 1;
    counts.set(address, attempt);
    if (attempt > 1) { starts.push(Date.now()); maximumConfirming = Math.max(maximumConfirming, ++confirming); }
    maximum = Math.max(maximum, ++active);
    try { await delayed(100, init?.signal); return new Response("", { status: 503 }); }
    finally { active--; if (attempt > 1) confirming--; }
  } });
  const controller = new AbortController();
  const pending = provider.watch!(addresses, controller.signal, update => {
    for (const record of update.hosts) records.set(record.address, record);
  }).catch(() => {});
  for (let elapsed = 0; elapsed < 50_000; elapsed += 100) { t.mock.timers.tick(100); await setImmediate(); }
  assert(starts.length >= 8 && starts.length <= 10,
    "expired cold evidence needs a fresh pair without exceeding the shared confirmation cadence");
  for (let index = 1; index < starts.length; index++) assert(starts[index]! - starts[index - 1]! >= 5000);
  assert([...records.values()].every(record => record.apiCheck?.status === "offline"));
  assert.equal(maximum, 4);
  assert.equal(maximumConfirming, 1);
  controller.abort();
  await pending;
});

test("canceling confirmation cannot establish Offline or increment failure backoff", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: base });
  let requests = 0;
  const provider = createNodeInfoProvider({ fetch: async (_input, init) => {
    requests++;
    if (requests === 2) await delayed(5000, init?.signal);
    return new Response("", { status: 503 });
  } });
  await provider([host]);
  const first = new AbortController();
  const updates: NodeInfoRecord[] = [];
  const old = provider.watch!([host], first.signal, update => updates.push(...update.hosts)).catch(() => {});
  t.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(requests, 2);
  first.abort();
  assert(!updates.some(record => record.apiCheck?.status === "offline"));
  const second = new AbortController();
  const current = provider.watch!([host], second.signal, update => updates.push(...update.hosts)).catch(() => {});
  await setImmediate();
  assert.equal(requests, 3);
  assert.equal(updates.at(-1)?.apiCheck?.status, "offline");
  assert.equal(provider.nextRefreshAt!([host]), Date.now() + 120_000,
    "the canceled request must not count as a third failed check");
  second.abort();
  await Promise.all([old, current]);
});
