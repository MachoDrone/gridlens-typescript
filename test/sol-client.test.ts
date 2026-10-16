import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createSolProvider, MAINNET_GENESIS_HASH, SOL_PROVIDERS, SolRequestBudget } from "../scripts/sol.ts";

// Public fixture identifiers from small integers; no keys or real identities.
function address(value: number): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let encoded = "";
  let n = value;
  while (n) { encoded = alphabet[n % 58]! + encoded; n = Math.floor(n / 58); }
  const bytes = value === 0 ? 0 : Math.ceil(Math.log2(value + 1) / 8);
  return "1".repeat(32 - bytes) + encoded;
}
const hosts = Array.from({ length: 201 }, (_, index) => address(index + 1));
const host = hosts[0]!;
const base = 1_800_000_000_000;
interface Call { provider: number; method: string; params: unknown[]; id: number; time: number; signal: AbortSignal }
function reply(id: number, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }).replace(/"__INT:(\d+)"/g, "$1"),
    { headers: { "Content-Type": "application/json" } });
}
function harness(handler?: (call: Call) => Response | undefined | Promise<Response | undefined>,
  options: { timeoutMs?: number; refreshDeadlineMs?: number } = {}) {
  let time = base;
  const calls: Call[] = [];
  const provider = createSolProvider({ ...options, now: () => time,
    sleep: async (ms, signal) => { signal.throwIfAborted(); time += ms; }, fetch: async (input, init) => {
      assert.equal(init?.method, "POST");
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.redirect, "error");
      const body = JSON.parse(String(init?.body)) as { jsonrpc: string; id: number; method: string; params: unknown[] };
      assert.equal(body.jsonrpc, "2.0");
      const call: Call = { ...body, provider: SOL_PROVIDERS.findIndex(value => value.endpoint === String(input)),
        time, signal: init!.signal! };
      assert(call.provider >= 0);
      calls.push(call);
      const overridden = await handler?.(call);
      if (overridden) return overridden;
      if (call.method === "getGenesisHash") return reply(call.id, MAINNET_GENESIS_HASH);
      if (call.method === "getBlockTime") return reply(call.id, Math.floor(time / 1000));
      assert.equal(call.method, "getMultipleAccounts");
      const batch = call.params[0] as string[];
      assert(batch.length > 0 && batch.length <= 100);
      assert.deepEqual({ ...(call.params[1] as object), minContextSlot: undefined }, {
        commitment: "confirmed", encoding: "base64", dataSlice: { offset: 0, length: 0 }, minContextSlot: undefined });
      return reply(call.id, { context: { slot: Math.floor(time / 1000) }, value: batch.map(value => ({ lamports: hosts.indexOf(value) + 1 })) });
    } });
  return { provider, calls, now: () => time, advance: (ms: number) => { time += ms; }, setTime: (value: number) => { time = value; } };
}

test("retired SOL cache eviction preserves chain verification, slot watermarks and request pacing", async () => {
  let regress = false;
  const fixture = harness(call => regress && call.method === "getMultipleAccounts"
    ? reply(call.id, { context: { slot: 1 }, value: (call.params[0] as string[]).map(() => ({ lamports: 99 })) }) : undefined);
  const original = await fixture.provider([host]);
  fixture.advance(3_600_000);
  fixture.provider.retention!.prune({ hosts: new Set(), markets: new Set(), nowMs: fixture.now() });
  assert.equal(fixture.provider.retention!.retryAt!(host), 0);
  const rejoined = await fixture.provider([host]);
  assert.equal(rejoined.hosts[0]!.lamports, original.hosts[0]!.lamports);
  assert.equal(fixture.calls.filter(call => call.method === "getGenesisHash").length, 1);
  const balances = fixture.calls.filter(call => call.method === "getMultipleAccounts");
  assert((balances[1]!.params[1] as { minContextSlot: number }).minContextSlot >= original.hosts[0]!.contextSlot!);
  fixture.advance(3_600_000);
  fixture.provider.retention!.prune({ hosts: new Set(), markets: new Set(), nowMs: fixture.now() });
  regress = true;
  const rejected = await fixture.provider([host]);
  assert.equal(rejected.hosts[0]!.lamports, null, "evicted values cannot return as retained data");
  assert.match(rejected.hosts[0]!.error!, /slot/i);
  for (let index = 1; index < fixture.calls.length; index++) assert(fixture.calls[index]!.time - fixture.calls[index - 1]!.time >= 1_000);
});

test("200/201 hosts use bounded batches, exact positional identity and one oldest-slot freshness read", async () => {
  for (const count of [200, 201]) {
    const fixture = harness();
    const result = await fixture.provider(hosts.slice(0, count));
    const balance = fixture.calls.filter(call => call.method === "getMultipleAccounts");
    assert.deepEqual(balance.map(call => (call.params[0] as string[]).length), count === 200 ? [100, 100] : [100, 100, 1]);
    assert.equal(fixture.calls.filter(call => call.method === "getBlockTime").length, 1);
    assert.deepEqual(fixture.calls.find(call => call.method === "getBlockTime")!.params, [balance[0]!.time / 1000]);
    assert.equal(result.nextRefreshAtMs, base + 30_000);
    result.hosts.forEach((row, index) => {
      assert.equal(row.address, hosts[index]);
      assert.equal(row.lamports, String(index + 1));
      assert.equal(row.provider, "Solana Labs");
      assert.equal(row.error, null);
      assert.equal(row.validUntilMs, row.checkedAtMs! + 60_000);
    });
    for (let index = 1; index < fixture.calls.length; index++) assert(fixture.calls[index]!.time - fixture.calls[index - 1]!.time >= 1000);
    assert(fixture.calls.every(call => call.provider === 0));
  }
});

test("shared viewers and manual refresh reuse work until the upstream deadline; top-ups and decreases both update", async () => {
  let amount = 1_000_000_000;
  const fixture = harness(call => call.method === "getMultipleAccounts" ?
    reply(call.id, { context: { slot: call.time / 1000 }, value: [{ lamports: amount }] }) : undefined);
  const [a, b] = await Promise.all([fixture.provider([host]), fixture.provider([host])]);
  assert.deepEqual(a, b);
  assert.equal(fixture.calls.length, 3);
  a.hosts[0]!.lamports = "99";
  fixture.setTime(base + 29_999);
  assert.equal((await fixture.provider([host])).hosts[0]!.lamports, "1000000000");
  assert.equal(fixture.calls.length, 3);
  fixture.advance(1);
  amount = 2_000_000_000;
  assert.equal((await fixture.provider([host])).hosts[0]!.lamports, "2000000000");
  assert.equal(fixture.calls.length, 5);
  fixture.setTime(base + 60_000);
  amount = 500_000_000;
  assert.equal((await fixture.provider([host])).hosts[0]!.lamports, "500000000");
  assert.equal(fixture.calls.length, 7);
});

test("different live rosters share provider state and overlapping balances without postponing missing hosts", async () => {
  const fixture = harness();
  const first = await fixture.provider(hosts.slice(0, 3));
  assert.deepEqual(fixture.calls.filter(call => call.method === "getMultipleAccounts").flatMap(call => call.params[0]), hosts.slice(0, 3));
  const firstCalls = fixture.calls.length;
  const second = await fixture.provider([hosts[2]!, hosts[3]!]);
  assert.deepEqual(second.hosts.map(row => row.address), [hosts[2], hosts[3]]);
  assert.deepEqual(second.hosts.map(row => row.lamports), ["3", "4"]);
  assert.equal(second.hosts[0]!.checkedAtMs, first.hosts[2]!.checkedAtMs);
  assert.deepEqual(fixture.calls.slice(firstCalls).filter(call => call.method === "getMultipleAccounts").flatMap(call => call.params[0]), [hosts[3]]);
  assert.equal(fixture.calls.filter(call => call.method === "getGenesisHash").length, 1);
  assert.equal(second.nextRefreshAtMs, first.nextRefreshAtMs);
  const calls = fixture.calls.length;
  await fixture.provider(hosts.slice(0, 4));
  assert.equal(fixture.calls.length, calls, "manual reads reuse all still-current addresses");
  fixture.setTime(base + 30_000);
  const refreshed = await fixture.provider([hosts[3]!]);
  assert.equal(fixture.calls.length, calls, "a later roster keeps its own remaining refresh interval");
  fixture.setTime(refreshed.nextRefreshAtMs!);
  await fixture.provider([hosts[3]!]);
  assert.deepEqual(fixture.calls.slice(calls).filter(call => call.method === "getMultipleAccounts").flatMap(call => call.params[0]), [hosts[3]],
    "inactive roster addresses are never pulled into the selected refresh");
});

test("concurrent overlapping rosters serialize missing work and share active requests until the last viewer leaves", async () => {
  let held: Call | undefined;
  let release!: () => void;
  const fixture = harness(async call => {
    if (!held && call.method === "getMultipleAccounts") {
      held = call;
      await new Promise<void>(resolve => { release = resolve; });
    }
    return undefined;
  });
  const first = new AbortController();
  const a = fixture.provider(hosts.slice(0, 2), first.signal);
  const rejected = assert.rejects(a, { name: "AbortError" });
  while (!held) await setImmediate();
  const second = fixture.provider([hosts[1]!, hosts[2]!]);
  first.abort();
  await rejected;
  assert.equal(held.signal.aborted, false, "the second roster still consumes the common address");
  release();
  const snapshot = await second;
  assert.deepEqual(snapshot.hosts.map(row => [row.address, row.lamports]), [[hosts[1], "2"], [hosts[2], "3"]]);
  assert.deepEqual(fixture.calls.filter(call => call.method === "getMultipleAccounts").map(call => call.params[0]),
    [hosts.slice(0, 2), [hosts[2]]]);
  assert.equal(fixture.calls.filter(call => call.method === "getGenesisHash").length, 1);
  for (let index = 1; index < fixture.calls.length; index++) assert(fixture.calls[index]!.time - fixture.calls[index - 1]!.time >= 1000);
});

test("a disjoint roster waits without keeping a hidden roster's upstream work alive", async () => {
  let held: Call | undefined;
  const fixture = harness(async call => {
    if (!held && call.method === "getMultipleAccounts") {
      held = call;
      await new Promise<void>((_resolve, reject) => call.signal.addEventListener("abort", () => reject(call.signal.reason), { once: true }));
    }
    return undefined;
  });
  const controller = new AbortController();
  const first = fixture.provider([host], controller.signal);
  const rejected = assert.rejects(first, { name: "AbortError" });
  while (!held) await setImmediate();
  const other = fixture.provider([hosts[1]!]);
  await setImmediate();
  assert.equal(fixture.calls.length, 2, "disjoint work waits for the active refresh");
  controller.abort();
  await rejected;
  assert.equal(held.signal.aborted, true, "a disjoint viewer is not a consumer of this balance");
  const result = await other;
  assert.equal(result.hosts[0]!.address, hosts[1]);
  assert.equal(result.hosts[0]!.lamports, "2");
  assert.equal(result.hosts[0]!.error, null);
  assert.deepEqual(fixture.calls.filter(call => call.method === "getMultipleAccounts").map(call => call.params[0]), [[host], [hosts[1]]]);
  assert(fixture.calls.every(call => call.provider === 0), "cancellation must not create provider cooldown");
});

test("canceling a disjoint waiting roster never dispatches its addresses or cancels another viewer", async () => {
  let held: Call | undefined;
  let release!: () => void;
  const fixture = harness(async call => {
    if (!held && call.method === "getMultipleAccounts") {
      held = call;
      await new Promise<void>(resolve => { release = resolve; });
    }
    return undefined;
  });
  const first = fixture.provider([host]);
  while (!held) await setImmediate();
  const controller = new AbortController();
  const waiting = fixture.provider([hosts[1]!], controller.signal);
  const rejected = assert.rejects(waiting, { name: "AbortError" });
  controller.abort();
  await rejected;
  assert.equal(held.signal.aborted, false);
  release();
  await first;
  assert.deepEqual(fixture.calls.filter(call => call.method === "getMultipleAccounts").flatMap(call => call.params[0]), [host]);
});

test("clock movement during a refresh returns its result without replaying missed intervals", async () => {
  const fixture = harness(call => {
    if (call.method !== "getBlockTime") return undefined;
    fixture.advance(90_000);
    return reply(call.id, fixture.now() / 1000);
  });
  const result = await fixture.provider([host]);
  assert.equal(result.hosts[0]!.lamports, "1");
  assert.equal(result.nextRefreshAtMs, base + 30_000);
  assert.equal(fixture.calls.length, 3);
});

test("provider cooldown and shared dispatch budgets survive switching fixed live rosters", async () => {
  const fixture = harness(call => call.provider === 0 ? new Response("busy", { status: 429, headers: { "Retry-After": "120" } }) : undefined);
  await fixture.provider([host]);
  const before = fixture.calls.length;
  await fixture.provider(hosts.slice(1, 3));
  assert(fixture.calls.slice(before).every(call => call.provider === 1));
  assert.equal(fixture.calls.filter(call => call.provider === 0).length, 1);
  for (let index = 1; index < fixture.calls.length; index++) assert(fixture.calls[index]!.time - fixture.calls[index - 1]!.time >= 1000);
});

test("exact u64 lamports, validated zero and null accounts never shift identities", async () => {
  const fixture = harness(call => call.method === "getMultipleAccounts" ? reply(call.id, {
    context: { slot: 100 }, value: [{ lamports: "__INT:18446744073709551615" }, null, { lamports: 0 }],
  }) : undefined);
  const result = await fixture.provider(hosts.slice(0, 3));
  assert.deepEqual(result.hosts.map(row => [row.address, row.lamports]), [[hosts[0], "18446744073709551615"], [hosts[1], null], [hosts[2], "0"]]);
  assert(result.hosts.every(row => !row.error && !row.retained && row.checkedAtMs !== null));
});

test("batch length, response identity and invalid integer values reject the whole batch", async () => {
  for (const value of [[{ lamports: 1 }], [{ lamports: "1" }, null], [{ lamports: -1 }, null],
    [{ lamports: 0.5 }, null], [{ lamports: "__INT:18446744073709551616" }, null]]) {
    const fixture = harness(call => call.method === "getMultipleAccounts" ? reply(call.id,
      { context: { slot: 100 }, value }) : undefined);
    const result = await fixture.provider(hosts.slice(0, 2));
    assert(result.hosts.every(row => row.lamports === null && row.error));
    assert.equal(new Set(fixture.calls.map(call => call.provider)).size, 2);
  }
  const fixture = harness(call => reply(call.id + 1, MAINNET_GENESIS_HASH));
  const result = await fixture.provider([host]);
  assert.match(result.hosts[0]!.error!, /identity/);
  assert.equal(fixture.calls.length, 2);
});

test("a failed later batch retries once on an alternate without rereading successful hosts or violating Retry-After", async () => {
  let primaryBatches = 0;
  const fixture = harness(call => {
    if (call.provider === 0 && call.method === "getMultipleAccounts" && ++primaryBatches === 2) {
      return new Response("busy", { status: 429, headers: { "Retry-After": "120" } });
    }
    return undefined;
  });
  const result = await fixture.provider(hosts.slice(0, 200));
  assert.equal(result.hosts[0]!.provider, "Solana Labs");
  assert.equal(result.hosts[100]!.provider, "PublicNode");
  assert.equal(result.hosts[199]!.lamports, "200");
  assert(result.hosts.every(row => row.error === null));
  const failedAt = fixture.calls.findIndex(call => call.provider === 0 && call.method === "getMultipleAccounts" && (call.params[0] as string[])[0] === hosts[100]);
  assert(fixture.calls.slice(failedAt + 1).every(call => call.provider !== 0));
  assert.deepEqual(fixture.calls.filter(call => call.provider === 1 && call.method === "getMultipleAccounts")
    .flatMap(call => call.params[0]), hosts.slice(100, 200));
  fixture.setTime(base + 30_000);
  await fixture.provider(hosts.slice(0, 200));
  assert(fixture.calls.slice(7).every(call => call.provider === 1));
});

test("failed refreshes retain dated values instead of substituting zero; later null is honestly unknown", async () => {
  let fail = false;
  let missing = false;
  const fixture = harness(call => fail ? new Response("down", { status: 503 }) : missing && call.method === "getMultipleAccounts" ?
    reply(call.id, { context: { slot: call.time / 1000 }, value: [null] }) : undefined);
  const first = (await fixture.provider([host])).hosts[0]!;
  fail = true;
  fixture.setTime(base + 30_000);
  const retained = (await fixture.provider([host])).hosts[0]!;
  assert.equal(retained.lamports, first.lamports);
  assert.equal(retained.checkedAtMs, first.checkedAtMs);
  assert.equal(retained.validUntilMs, first.validUntilMs);
  assert(retained.retained && retained.error);
  fail = false;
  missing = true;
  fixture.setTime(base + 60_000);
  const cleared = (await fixture.provider([host])).hosts[0]!;
  assert.equal(cleared.lamports, null);
  assert.equal(cleared.error, null);
});

test("wrong genesis, access denial and unsupported methods disable providers for process lifetime", async () => {
  for (const denial of ["chain", "method", "401", "403", "405", "501"]) {
    const fixture = harness(call => {
      if (call.provider !== 0) return undefined;
      if (denial === "chain") return reply(call.id, "wrong-network");
      if (denial === "method") return Response.json({ jsonrpc: "2.0", id: call.id, error: { code: -32601 } });
      return new Response("denied", { status: Number(denial) });
    });
    const first = await fixture.provider([host]);
    assert.equal(first.hosts[0]!.provider, "PublicNode");
    fixture.setTime(base + 30_000);
    await fixture.provider([host]);
    assert.equal(fixture.calls.filter(call => call.provider === 0).length, 1);
  }
});

test("invalid application parameters stop the request without rotating providers", async () => {
  for (const status of ["rpc", "http"]) {
    const fixture = harness(call => status === "rpc" ?
      Response.json({ jsonrpc: "2.0", id: call.id, error: { code: -32602 } }) : new Response("bad params", { status: 400 }));
    assert((await fixture.provider([host])).hosts[0]!.error);
    fixture.advance(120_000);
    assert.equal((await fixture.provider([host])).nextRefreshAtMs, null);
    assert.equal(fixture.calls.length, 1);
  }
});

test("all disabled providers keep a finite-or-null deadline across repeated reads", async () => {
  const fixture = harness(() => new Response("denied", { status: 403 }));
  await fixture.provider([host]);
  fixture.setTime(base + 30_000);
  for (let index = 0; index < 3; index++) {
    const result = await fixture.provider([host]);
    assert.equal(result.nextRefreshAtMs, null);
    assert.equal(result.hosts[0]!.retryAtMs, null);
  }
  assert.equal(fixture.calls.length, 4);
});

test("Retry-After on a successful RPC pauses that provider while one eligible alternate validates the remaining batch", async () => {
  const fixture = harness(call => {
    if (call.provider === 0 && call.method === "getMultipleAccounts") {
      const response = reply(call.id, { context: { slot: 100 }, value: [{ lamports: 1 }] });
      response.headers.set("Retry-After", "120");
      return response;
    }
    return undefined;
  });
  const result = await fixture.provider([host]);
  assert.equal(result.hosts[0]!.lamports, "1");
  assert.equal(result.hosts[0]!.provider, "PublicNode");
  assert.equal(result.hosts[0]!.error, null);
  assert(!fixture.calls.some(call => call.provider === 0 && call.method === "getBlockTime"));
  assert.equal(new Set(fixture.calls.map(call => call.provider)).size, 2);
});

test("stale, future, missing and malformed block times never validate a balance", async () => {
  for (const time of [base / 1000 - 61, base / 1000 + 100, null, -1, 0.1, "1800000000"]) {
    const fixture = harness(call => call.method === "getBlockTime" ? reply(call.id, time) : undefined);
    const result = await fixture.provider([host]);
    assert.equal(result.hosts[0]!.lamports, null);
    assert.match(result.hosts[0]!.error!, /block time/);
    assert.equal(new Set(fixture.calls.map(call => call.provider)).size, 2);
  }
});

test("failover rejects regressing slots and supplies the previous accepted high-water slot", async () => {
  let failPrimary = false;
  const fixture = harness(call => {
    if (failPrimary && call.provider === 0) return new Response("down", { status: 503 });
    if (call.method === "getMultipleAccounts") {
      if (call.provider === 1) assert.equal((call.params[1] as { minContextSlot: number }).minContextSlot, 100);
      return reply(call.id, { context: { slot: call.provider === 1 ? 99 : 100 }, value: [{ lamports: 1 }] });
    }
    return undefined;
  });
  await fixture.provider([host]);
  failPrimary = true;
  fixture.setTime(base + 30_000);
  const result = await fixture.provider([host]);
  assert.equal(result.hosts[0]!.contextSlot, 100);
  assert(result.hosts[0]!.retained);
  assert.match(result.hosts[0]!.error!, /regressed/);
});

test("all methods and providers share second, minute, hour and day dispatch budgets", () => {
  const second = new SolRequestBudget();
  assert(second.reserve(0));
  assert.equal(second.nextAt(1), 1000);
  assert(!second.reserve(999));
  assert(second.reserve(1000));
  const minute = new SolRequestBudget();
  for (let index = 0; index < 12; index++) assert(minute.reserve(index * 1000));
  assert.equal(minute.nextAt(12_000), 60_000);
  const hour = new SolRequestBudget();
  for (let group = 0; group < 50; group++) for (let index = 0; index < 12; index++) assert(hour.reserve(group * 60_000 + index * 1000));
  assert.equal(hour.nextAt(3_000_000), 3_600_000);
  const day = new SolRequestBudget();
  for (let block = 0; block < 20; block++) for (let group = 0; group < 50; group++) {
    for (let index = 0; index < 12; index++) assert(day.reserve(block * 3_600_000 + group * 60_000 + index * 1000));
  }
  assert.equal(day.nextAt(72_000_000), 86_400_000);
  assert(day.reserve(86_400_000));
});

test("exhausted budgets retain partial validated batches and report the shared next retry", async () => {
  const fixture = harness();
  // 1 genesis + 1 freshness + 10 batches consumes the 12/minute allowance.
  const manyHosts = Array.from({ length: 1001 }, (_, index) => address(index + 1));
  const result = await fixture.provider(manyHosts);
  assert.equal(fixture.calls.length, 12);
  assert.equal(result.hosts[999]!.error, null);
  assert.match(result.hosts[1000]!.error!, /budget/);
  assert.equal(result.hosts[1000]!.lamports, null);
  assert.equal(result.hosts[1000]!.retryAtMs, base + 60_000);
  assert.equal(result.nextRefreshAtMs, base + 30_000);
});

test("Retry-After dates and seconds apply to each provider without postponing eligible alternatives", async () => {
  const fixture = harness(call => new Response("busy", { status: 429, headers: {
    "Retry-After": call.provider === 0 ? "600" : new Date(base + 900_000).toUTCString(),
  } }));
  assert.equal((await fixture.provider([host])).nextRefreshAtMs, base + 30_000);
  fixture.setTime(base + 30_000);
  const unavailable = await fixture.provider([host]);
  assert.deepEqual(fixture.calls.map(call => call.provider), [0, 1, 2, 3]);
  assert.equal(unavailable.nextRefreshAtMs, base + 600_000);
  fixture.setTime(base + 599_999);
  await fixture.provider([host]);
  assert.equal(fixture.calls.length, 4);
  fixture.advance(1);
  await fixture.provider([host]);
  assert.equal(fixture.calls.at(-1)!.provider, 0);
});

test("huge Retry-After values remain paused at a representable deadline instead of overflowing", async () => {
  const fixture = harness(() => new Response("busy", { status: 429,
    headers: { "Retry-After": "9".repeat(400) } }));
  await fixture.provider([host]);
  fixture.setTime(base + 30_000);
  const result = await fixture.provider([host]);
  assert.equal(result.nextRefreshAtMs, 8_640_000_000_000_000);
  assert.equal(result.hosts[0]!.retryAtMs, 8_640_000_000_000_000);
  fixture.advance(900_000);
  await fixture.provider([host]);
  assert.equal(fixture.calls.length, 4);
});

test("failed providers back off exponentially to fifteen minutes without racing alternatives", async () => {
  const fixture = harness(call => call.provider === 0 ? new Response("unavailable", { status: 503 }) : new Response("denied", { status: 403 }));
  await fixture.provider([host]);
  fixture.setTime(base + 30_000);
  await fixture.provider([host]);
  fixture.setTime(base + 60_000);
  let result = await fixture.provider([host]);
  // Attempts of provider zero occur at 0, 60s, 180s, 420s, 900s, 1800s.
  assert.equal(result.nextRefreshAtMs, base + 180_000);
  for (const [at, next] of [[180_000, 420_000], [420_000, 900_000], [900_000, 1_800_000], [1_800_000, 2_700_000]]) {
    fixture.setTime(base + at!);
    result = await fixture.provider([host]);
    assert.equal(result.nextRefreshAtMs, base + next!);
  }
});

test("only the last consumer cancels upstream; cancellation does not start cooldown and immediate rejoin works", async () => {
  let held: Call | undefined;
  let hold = true;
  const fixture = harness(async call => {
    if (hold && call.method === "getMultipleAccounts") {
      held = call;
      await new Promise<void>((_resolve, reject) => call.signal.addEventListener("abort", () => reject(call.signal.reason), { once: true }));
    }
    return undefined;
  });
  const first = new AbortController();
  const second = new AbortController();
  const a = fixture.provider([host], first.signal);
  const b = fixture.provider([host], second.signal);
  const rejectedA = assert.rejects(a, { name: "AbortError" });
  const rejectedB = assert.rejects(b, { name: "AbortError" });
  while (!held) await setImmediate();
  first.abort();
  await rejectedA;
  assert.equal(held.signal.aborted, false);
  second.abort();
  hold = false;
  const resumed = fixture.provider([host]);
  await rejectedB;
  assert.equal(held.signal.aborted, true);
  const result = await resumed;
  assert.equal(result.hosts[0]!.provider, "Solana Labs");
  assert.equal(result.hosts[0]!.error, null);
  assert(fixture.calls.every(call => call.provider === 0));
});

test("resume preserves batches already validated before cancellation and only reads missing hosts", async () => {
  let held: Call | undefined;
  let hold = true;
  const fixture = harness(async call => {
    if (hold && call.method === "getMultipleAccounts" && (call.params[0] as string[])[0] === hosts[100]) {
      held = call;
      await new Promise<void>((_resolve, reject) => call.signal.addEventListener("abort", () => reject(call.signal.reason), { once: true }));
    }
    return undefined;
  });
  const controller = new AbortController();
  const work = fixture.provider(hosts.slice(0, 200), controller.signal);
  const rejected = assert.rejects(work, { name: "AbortError" });
  while (!held) await setImmediate();
  controller.abort();
  hold = false;
  const resumed = fixture.provider(hosts.slice(0, 200));
  await rejected;
  const result = await resumed;
  assert(result.hosts.every(row => row.lamports !== null && row.error === null));
  assert.equal(fixture.calls.filter(call => call.method === "getMultipleAccounts" && (call.params[0] as string[])[0] === host).length, 1);
});

test("canceling paced queued work prevents dispatch and does not penalize the provider", async () => {
  let now = base;
  let sleeping = false;
  let calls = 0;
  const controller = new AbortController();
  const provider = createSolProvider({ now: () => now,
    sleep: async (_ms, signal) => { sleeping = true; await new Promise<void>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })); },
    fetch: async (_input, init) => { calls++; const { id } = JSON.parse(String(init?.body)) as { id: number }; return reply(id, MAINNET_GENESIS_HASH); } });
  const work = provider([host], controller.signal);
  const rejected = assert.rejects(work, { name: "AbortError" });
  while (!sleeping) await setImmediate();
  controller.abort();
  await rejected;
  now += 1000;
  assert.equal(calls, 1);
});

test("timeout and refresh deadline bound work, with no more than one alternate", async () => {
  const fixture = harness(async call => {
    await new Promise<void>((_resolve, reject) => call.signal.addEventListener("abort", () => reject(call.signal.reason), { once: true }));
    return undefined;
  }, { timeoutMs: 5 });
  const result = await fixture.provider([host]);
  assert.match(result.hosts[0]!.error!, /timed out/);
  assert.equal(fixture.calls.length, 2);
  const short = harness(undefined, { refreshDeadlineMs: 1500 });
  const pending = await short.provider([host]);
  assert.equal(short.calls.length, 2);
  assert.equal(pending.hosts[0]!.lamports, null);
  assert.match(pending.hosts[0]!.error!, /budget/);
});

test("event-loop suspension while pacing cannot dispatch after the refresh deadline", async () => {
  let now = base;
  let calls = 0;
  const provider = createSolProvider({ now: () => now, sleep: async () => { now += 29_000; },
    fetch: async (_input, init) => {
      calls++;
      const { id } = JSON.parse(String(init?.body)) as { id: number };
      return reply(id, MAINNET_GENESIS_HASH);
    } });
  const result = await provider([host]);
  assert.equal(calls, 1);
  assert.equal(result.hosts[0]!.lamports, null);
  assert.match(result.hosts[0]!.error!, /deadline/);
});

test("bounded response bodies reject declared and streamed oversize data", async () => {
  for (const declared of [true, false]) {
    const fixture = harness(() => declared ? new Response("{}", { headers: { "content-length": "999999" } }) :
      new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(600_000)); controller.close(); } })));
    const result = await fixture.provider([host]);
    assert.match(result.hosts[0]!.error!, /size limit/);
    assert.equal(fixture.calls.length, 2);
  }
});

test("empty and invalid address inputs never contact any provider", async () => {
  const fixture = harness();
  assert.deepEqual(await fixture.provider([]), { hosts: [], nextRefreshAtMs: null });
  await assert.rejects(fixture.provider(["bad"]));
  await assert.rejects(fixture.provider([host, host]));
  assert.equal(fixture.calls.length, 0);
});


test("a validated alternate stays selected after shared budget deferral", async () => {
  const fixture = harness(call => call.provider === 0 ? new Response("unavailable", { status: 503 }) : undefined);
  const manyHosts = Array.from({ length: 1001 }, (_, index) => address(index + 1));
  const first = await fixture.provider(manyHosts);
  assert.equal(first.hosts[0]!.provider, "PublicNode");
  fixture.setTime(base + 30_000);
  await fixture.provider(manyHosts);
  const before = fixture.calls.length;
  fixture.setTime(base + 60_000); // Solana Labs' cooldown has now expired.
  await fixture.provider(manyHosts);
  assert(fixture.calls.length > before);
  assert(fixture.calls.slice(before).every(call => call.provider === 1));
});

test("later SOL batches must not regress behind a previously accepted batch in the same refresh", async () => {
  let primaryBatch = 0;
  const minimums: unknown[] = [];
  const fixture = harness(call => {
    if (call.method !== "getMultipleAccounts") return undefined;
    minimums.push((call.params[1] as { minContextSlot?: number }).minContextSlot);
    return reply(call.id, { context: { slot: call.provider === 0 ? [100, 200, 150][primaryBatch++] : 200 },
      value: (call.params[0] as string[]).map(() => ({ lamports: 5 })) });
  });
  const result = await fixture.provider(hosts);
  assert.deepEqual(minimums, [undefined, 100, 200, 200]);
  assert.equal(result.hosts[200]!.provider, "PublicNode");
  assert.equal(result.hosts[200]!.contextSlot, 200);
  assert(result.hosts.every(row => row.error === null));
});

test("SOL budget rollovers populate unattempted hosts before rereading the roster prefix", async () => {
  const fixture = harness();
  const manyHosts = Array.from({ length: 2001 }, (_, index) => address(index + 1));
  const first = await fixture.provider(manyHosts);
  assert.equal(first.hosts.filter(row => row.checkedAtMs !== null).length, 1000);
  fixture.setTime(base + 30_000);
  await fixture.provider(manyHosts);
  fixture.setTime(base + 60_000);
  const second = await fixture.provider(manyHosts);
  assert.equal(second.hosts.filter(row => row.checkedAtMs !== null).length, 2001,
    "deferred first reads must survive the next ordinary refresh deadline");
  assert.equal(fixture.calls.length, 24, "first population preserves the existing two minute-window allowances");
  assert.equal(fixture.now(), base + 71_000);
  const firstRolloverBatch = fixture.calls.find(call => call.time >= base + 60_000 && call.method === "getMultipleAccounts")!;
  assert.deepEqual(firstRolloverBatch.params[0], manyHosts.slice(1000, 1100));
  assert.equal(second.hosts[999]!.checkedAtMs, first.hosts[999]!.checkedAtMs,
    "first population does not manufacture a newer timestamp for a retained cached row");
});

test("SOL overdue maintenance rotates by oldest evidence even when a viewer reverses its roster", async () => {
  const fixture = harness();
  const manyHosts = Array.from({ length: 1200 }, (_, index) => address(index + 1));
  const populated = await fixture.provider(manyHosts);
  fixture.setTime(base + 60_000);
  await fixture.provider(manyHosts);
  const before = fixture.calls.length;
  fixture.setTime(base + 120_000);
  const result = await fixture.provider([...manyHosts].reverse());
  const batches = fixture.calls.slice(before).filter(call => call.method === "getMultipleAccounts");
  assert.deepEqual(batches[0]!.params[0], manyHosts.slice(900, 1000),
    "oldest deferred evidence outranks the latest caller's order");
  const original = populated.hosts[0]!;
  assert(result.hosts.find(row => row.address === original.address)!.checkedAtMs! > original.checkedAtMs!);
});

test("SOL emits validated batches before a slow later batch, replays to shared viewers and preserves source times", async () => {
  let held: Call | undefined;
  let release!: () => void;
  const fixture = harness(async call => {
    if (call.method === "getMultipleAccounts" && (call.params[0] as string[])[0] === hosts[100]) {
      held = call;
      await new Promise<void>(resolve => { release = resolve; });
    }
    return undefined;
  });
  const updates: { at: number; addresses: string[]; checkedAtMs: number | null }[] = [];
  let completed = false;
  const first = fixture.provider(hosts.slice(0, 200), undefined, update => {
    updates.push({ at: fixture.now(), addresses: update.hosts.map(row => row.address), checkedAtMs: update.hosts[0]!.checkedAtMs });
  }).then(result => { completed = true; return result; });
  while (!held) await setImmediate();
  assert.equal(completed, false);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0]!.addresses, hosts.slice(0, 100));
  assert.equal(updates[0]!.at, base + 2000, "first results need genesis, first batch and block-time only");
  assert.equal(updates[0]!.checkedAtMs, base + 1000, "publication must retain the account-read time");
  const joined: string[][] = [];
  const second = fixture.provider([host, hosts[100]!], undefined, update => {
    joined.push(update.hosts.map(row => row.address));
    update.hosts[0]!.lamports = "999999";
  });
  assert.deepEqual(joined, [[host]], "a joining viewer immediately receives its verified cache subset");
  fixture.advance(8000);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(joined, [[host], [hosts[100]]]);
  assert.equal(a.hosts[0]!.lamports, "1");
  assert.equal(b.hosts[0]!.lamports, "1");
  assert.equal(a.hosts[0]!.checkedAtMs, base + 1000);
  assert.equal(fixture.now(), base + 11_000, "a slow second batch no longer holds the first 100 results until this time");
  assert.equal(fixture.calls.filter(call => call.method === "getMultipleAccounts").length, 2);
});

test("SOL never publishes an unvalidated batch and canceled consumers receive no late updates", async () => {
  let held: Call | undefined;
  let release!: () => void;
  const fixture = harness(async call => {
    if (call.method === "getBlockTime" && !held) {
      held = call;
      await new Promise<void>(resolve => { release = resolve; });
    }
    return undefined;
  });
  const canceled: unknown[] = [];
  const surviving: unknown[] = [];
  const controller = new AbortController();
  const first = fixture.provider([host], controller.signal, update => { canceled.push(update); });
  const rejected = assert.rejects(first, { name: "AbortError" });
  const second = fixture.provider([host], undefined, update => { surviving.push(update); });
  while (!held) await setImmediate();
  assert.equal(canceled.length, 0, "balances cannot publish before freshness validation");
  controller.abort();
  await rejected;
  release();
  await second;
  assert.equal(canceled.length, 0);
  assert.equal(surviving.length, 1);
});

test("failed SOL account responses count as attempts while untouched batches stay in the initial pass", async () => {
  const fixture = harness(call => call.method === "getMultipleAccounts" &&
    (call.params[0] as string[]).includes(host) ?
    reply(call.id, { context: { slot: call.time / 1000 }, value: [] }) : undefined);
  const initial = await fixture.provider(hosts.slice(0, 200));
  assert(initial.hosts.every(row => row.checkedAtMs === null));
  const before = fixture.calls.length;
  fixture.setTime(base + 30_000);
  const result = await fixture.provider(hosts.slice(0, 200));
  const retried = fixture.calls.slice(before).filter(call => call.method === "getMultipleAccounts");
  assert.deepEqual(retried[0]!.params[0], hosts.slice(100, 200),
    "the failed leading batch cannot trap untouched hosts behind repeated invalid responses");
  assert.equal(result.hosts[100]!.lamports, "101");
  assert.equal(result.hosts[0]!.lamports, null);
});

test("a failed SOL progress observer cannot interrupt another viewer or poison provider health, including cache replay", async () => {
  const fixture = harness();
  const received: string[] = [];
  const brokenObserver = (): never => { throw new Error("viewer disconnected"); };
  const [a, b] = await Promise.all([
    fixture.provider(hosts, undefined, brokenObserver),
    fixture.provider(hosts, undefined, update => { received.push(...update.hosts.map(row => row.address)); }),
  ]);
  assert.deepEqual(a, b);
  assert.deepEqual(received, hosts);
  assert(a.hosts.every(row => row.error === null && row.provider === "Solana Labs"));
  assert.equal(fixture.calls.length, 5);
  assert.deepEqual(await fixture.provider(hosts, undefined, brokenObserver), a,
    "cached callbacks must not reject an otherwise valid finite result");
  fixture.setTime(base + 30_000);
  const refreshed = await fixture.provider(hosts);
  assert(refreshed.hosts.every(row => row.error === null && row.provider === "Solana Labs"));
  assert(fixture.calls.every(call => call.provider === 0), "observer failures must not impose a provider cooldown");
});
