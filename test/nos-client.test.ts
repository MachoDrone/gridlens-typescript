import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { address as solanaAddress } from "@solana/kit";
import { AccountState, findAssociatedTokenPda, getMintEncoder, getTokenEncoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { createNosProvider } from "../scripts/nos.ts";
import { createSolProvider } from "../scripts/sol.ts";
import { createSolanaRpc, MAINNET_GENESIS_HASH, SOLANA_PROVIDERS } from "../scripts/solana-rpc.ts";
import type { SolanaRpcOptions } from "../scripts/solana-rpc.ts";
import { isNosRecord, NOS_MINT } from "../src/fleet/nos.ts";
import type { NosSnapshot } from "../src/fleet/nos.ts";
import type { SolSnapshot } from "../src/fleet/sol.ts";

// Isolated public identifiers only; never create or read keys.
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
const accounts = await Promise.all(hosts.map(async owner => (await findAssociatedTokenPda({
  owner: solanaAddress(owner), mint: solanaAddress(NOS_MINT), tokenProgram: TOKEN_PROGRAM_ADDRESS,
}))[0]));
const owners = new Map(accounts.map((account, index) => [String(account), hosts[index]!]));
interface Call { provider: number; method: string; params: unknown[]; id: number; time: number; signal: AbortSignal }
function reply(id: number, result: unknown): Response { return Response.json({ jsonrpc: "2.0", id, result }); }
function accountData(data: ArrayLike<number>) {
  return { owner: TOKEN_PROGRAM_ADDRESS as string, executable: false, lamports: 2039280,
    space: data.length, data: [Buffer.from(data).toString("base64"), "base64"] };
}
function mintData() {
  return accountData(getMintEncoder().encode({ mintAuthority: null, supply: 100_000_000_000_000n,
    decimals: 6, isInitialized: true, freezeAuthority: null }));
}
function tokenData(owner = host, amount = 1_500_000n, state = AccountState.Initialized) {
  return accountData(getTokenEncoder().encode({ mint: solanaAddress(NOS_MINT), owner: solanaAddress(owner), amount,
    delegate: null, state, isNative: null, delegatedAmount: 0n, closeAuthority: null }));
}
function mutateData(data: ReturnType<typeof tokenData>, mutation: (bytes: Buffer) => void) {
  const bytes = Buffer.from(data.data[0]!, "base64");
  mutation(bytes);
  return { ...data, data: [bytes.toString("base64"), "base64"] };
}
const normalAccounts = new Map(hosts.map((owner, index) => [owner, tokenData(owner, BigInt(index + 1) * 1_000_000n)]));
function harness(handler?: (call: Call) => Response | undefined | Promise<Response | undefined>,
  options: Omit<SolanaRpcOptions, "fetch" | "now" | "sleep"> = {}) {
  let time = base;
  const calls: Call[] = [];
  const rpc = createSolanaRpc({ ...options, now: () => time, sleep: async (ms, signal) => { signal.throwIfAborted(); time += ms; },
    fetch: async (input, init) => {
      assert.equal(init?.method, "POST");
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.redirect, "error");
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      const call: Call = { ...body, provider: SOLANA_PROVIDERS.findIndex(value => value.endpoint === String(input)),
        time, signal: init!.signal! };
      assert(call.provider >= 0);
      calls.push(call);
      const overridden = await handler?.(call);
      if (overridden) return overridden;
      if (call.method === "getGenesisHash") return reply(call.id, MAINNET_GENESIS_HASH);
      if (call.method === "getBlockTime") return reply(call.id, Math.floor(time / 1000));
      if (call.method === "getAccountInfo") {
        assert.deepEqual(call.params[0], NOS_MINT);
        return reply(call.id, { context: { slot: Math.floor(time / 1000) }, value: mintData() });
      }
      assert.equal(call.method, "getMultipleAccounts");
      const batch = call.params[0] as string[];
      assert(batch.length > 0 && batch.length <= 100);
      const sol = "dataSlice" in (call.params[1] as object);
      return reply(call.id, { context: { slot: Math.floor(time / 1000) }, value: batch.map(value => {
        if (sol) { assert(hosts.includes(value)); return { lamports: 5_000_000 }; }
        assert(owners.has(value), "NOS requests must use derived accounts belonging only to requested fixture hosts");
        return normalAccounts.get(owners.get(value)!)!;
      }) });
    } });
  return { rpc, provider: createNosProvider({ rpc }), sol: createSolProvider({ rpc }), calls,
    now: () => time, advance: (ms: number) => { time += ms; }, setTime: (value: number) => { time = value; } };
}

test("retired NOS cache eviction preserves verified mint, shared transport and slot watermarks", async () => {
  const fixture = harness();
  const original = await fixture.provider([host]);
  fixture.advance(3_600_000);
  fixture.provider.retention!.prune({ hosts: new Set(), markets: new Set(), nowMs: fixture.now() });
  assert.equal(fixture.provider.retention!.retryAt!(host), 0);
  const rejoined = await fixture.provider([host]);
  assert.equal(rejoined.hosts[0]!.amount, original.hosts[0]!.amount);
  assert.equal(rejoined.hosts[0]!.tokenAccount, original.hosts[0]!.tokenAccount);
  assert.equal(fixture.calls.filter(call => call.method === "getGenesisHash").length, 1);
  assert.equal(fixture.calls.filter(call => call.method === "getAccountInfo").length, 1, "mint verification belongs to the provider, not a retired host");
  const balances = fixture.calls.filter(call => call.method === "getMultipleAccounts");
  assert((balances[1]!.params[1] as { minContextSlot: number }).minContextSlot >= original.hosts[0]!.contextSlot!);
});

test("NOS derives standard accounts, verifies the mint and batches 200/201 hosts with one oldest-slot check", async () => {
  assert.equal(accounts[0], "7YRi3YNGuwSQ5rrqRXgRjepE4HW9U7tLYWiRVvYoWcNw");
  for (const count of [200, 201]) {
    const fixture = harness();
    const result = await fixture.provider(hosts.slice(0, count));
    const batches = fixture.calls.filter(call => call.method === "getMultipleAccounts");
    assert.deepEqual(batches.map(call => (call.params[0] as string[]).length), count === 200 ? [100, 100] : [100, 100, 1]);
    assert.deepEqual(batches.flatMap(call => call.params[0]), accounts.slice(0, count));
    assert(batches.every(call => !("dataSlice" in (call.params[1] as object))));
    assert.equal(fixture.calls.filter(call => call.method === "getGenesisHash").length, 1);
    assert.equal(fixture.calls.filter(call => call.method === "getAccountInfo").length, 1);
    assert.equal(fixture.calls.filter(call => call.method === "getBlockTime").length, 1);
    result.hosts.forEach((row, index) => {
      assert.equal(row.address, hosts[index]);
      assert.equal(row.tokenAccount, accounts[index]);
      assert.equal(row.amount, String((index + 1) * 1_000_000));
      assert.equal(row.accountState, "initialized");
      assert.equal(row.mint, NOS_MINT);
      assert.equal(row.decimals, 6);
      assert.equal(row.validUntilMs, row.checkedAtMs! + 180_000);
      assert(isNosRecord(row));
    });
    assert.equal(result.nextRefreshAtMs, base + 120_000);
  }
});

test("absent accounts mean verified standard-account zero; frozen balances and maximum u64 retain exact amounts", async () => {
  const fixture = harness(call => call.method === "getMultipleAccounts" ? reply(call.id, { context: { slot: call.time / 1000 },
    value: [null, tokenData(hosts[1]!, 0n), tokenData(hosts[2]!, 18_446_744_073_709_551_615n, AccountState.Frozen)] }) : undefined);
  const result = await fixture.provider(hosts.slice(0, 3));
  assert.deepEqual(result.hosts.map(row => [row.amount, row.accountState]), [["0", "absent"], ["0", "initialized"], ["18446744073709551615", "frozen"]]);
  assert(result.hosts.every(isNosRecord));
});

test("mint owner, layout, initialized flag and decimals are verified before any token balance request", async () => {
  const cases = [null, { ...mintData(), owner: host }, { ...mintData(), executable: true },
    { ...mintData(), data: [Buffer.alloc(81).toString("base64"), "base64"] },
    mutateData(mintData(), bytes => { bytes[44] = 9; }),
    mutateData(mintData(), bytes => { bytes[45] = 0; }),
    mutateData(mintData(), bytes => { bytes[45] = 2; }),
    mutateData(mintData(), bytes => { bytes[0] = 2; })];
  for (const value of cases) {
    const fixture = harness(call => call.method === "getAccountInfo" ?
      reply(call.id, { context: { slot: call.time / 1000 }, value }) : undefined);
    const result = await fixture.provider([host]);
    assert.equal(result.hosts[0]!.amount, null);
    assert.match(result.hosts[0]!.error!, /mint/);
    assert(!fixture.calls.some(call => call.method === "getMultipleAccounts"));
    assert.equal(new Set(fixture.calls.map(call => call.provider)).size, 2);
  }
});

test("wrong mint, wallet, program, encoding, size and uninitialized account states never establish a balance", async () => {
  const valid = tokenData();
  const cases = [tokenData(hosts[1]!), { ...valid, owner: host }, { ...valid, executable: true }, { ...valid, space: 166 },
    { ...valid, data: [valid.data[0], "base58"] }, { ...valid, data: ["!!!!", "base64"] },
    { ...valid, data: [Buffer.alloc(164).toString("base64"), "base64"] },
    mutateData(valid, bytes => { bytes.fill(0, 0, 32); }), tokenData(host, 1n, AccountState.Uninitialized),
    mutateData(valid, bytes => { bytes[108] = 3; }), mutateData(valid, bytes => { bytes[109] = 1; }),
    mutateData(valid, bytes => { bytes[72] = 2; }), mutateData(valid, bytes => { bytes[129] = 2; })];
  for (const value of cases) {
    const fixture = harness(call => call.method === "getMultipleAccounts" ?
      reply(call.id, { context: { slot: call.time / 1000 }, value: [value] }) : undefined);
    const result = await fixture.provider([host]);
    assert.equal(result.hosts[0]!.amount, null);
    assert.match(result.hosts[0]!.error!, /NOS account/);
    assert.equal(new Set(fixture.calls.map(call => call.provider)).size, 2);
  }
});

test("NOS validates RPC identity, exact batch length and fresh nonregressing context before accepting absent zero", async () => {
  for (const failure of ["identity", "length", "slot", "stale", "future", "missing"]) {
    const fixture = harness(call => {
      if (call.method === "getMultipleAccounts") return reply(failure === "identity" ? -1 : call.id,
        { context: { slot: failure === "slot" ? -1 : call.time / 1000 }, value: failure === "length" ? [] : [null] });
      if (call.method === "getBlockTime" && ["stale", "future", "missing"].includes(failure)) return reply(call.id,
        failure === "missing" ? null : Math.floor(call.time / 1000) + (failure === "stale" ? -61 : 16));
      return undefined;
    });
    const result = await fixture.provider([host]);
    assert.equal(result.hosts[0]!.amount, null);
    assert(result.hosts[0]!.error);
    assert.equal(new Set(fixture.calls.map(call => call.provider)).size, 2);
  }
});

test("NOS viewers share cache; failed refreshes retain dates and recovery can close or recreate the account", async () => {
  let mode = "success";
  const fixture = harness(call => {
    if (mode === "fail") return new Response("down", { status: 503 });
    if (mode === "closed" && call.method === "getMultipleAccounts") return reply(call.id,
      { context: { slot: call.time / 1000 }, value: [null] });
    return undefined;
  });
  const [a, b] = await Promise.all([fixture.provider([host]), fixture.provider([host])]);
  assert.deepEqual(a, b);
  assert.equal(fixture.calls.length, 4);
  a.hosts[0]!.amount = "99";
  fixture.setTime(base + 119_999);
  assert.equal((await fixture.provider([host])).hosts[0]!.amount, "1000000");
  assert.equal(fixture.calls.length, 4);
  fixture.advance(1);
  mode = "fail";
  const retained = (await fixture.provider([host])).hosts[0]!;
  assert.equal(retained.checkedAtMs, b.hosts[0]!.checkedAtMs);
  assert.equal(retained.validUntilMs, b.hosts[0]!.validUntilMs);
  assert.equal(retained.amount, "1000000");
  assert(retained.retained && retained.error);
  mode = "closed";
  fixture.setTime(base + 240_000);
  const closed = (await fixture.provider([host])).hosts[0]!;
  assert.equal(closed.amount, "0");
  assert.equal(closed.accountState, "absent");
  assert.equal(closed.error, null);
  mode = "success";
  fixture.setTime(base + 360_000);
  assert.equal((await fixture.provider([host])).hosts[0]!.amount, "1000000");
});

test("NOS later-batch failover keeps validated batches, rechecks mint on the alternate and respects Retry-After", async () => {
  let batches = 0;
  const fixture = harness(call => call.provider === 0 && call.method === "getMultipleAccounts" && ++batches === 2 ?
    new Response("busy", { status: 429, headers: { "Retry-After": "300" } }) : undefined);
  const result = await fixture.provider(hosts.slice(0, 200));
  assert.equal(result.hosts[0]!.provider, "Solana Labs");
  assert.equal(result.hosts[100]!.provider, "PublicNode");
  assert(result.hosts.every(row => row.error === null));
  assert.deepEqual(fixture.calls.filter(call => call.provider === 1 && call.method === "getMultipleAccounts").flatMap(call => call.params[0]), accounts.slice(100, 200));
  assert.equal(fixture.calls.filter(call => call.method === "getAccountInfo").length, 2);
  fixture.setTime(base + 120_000);
  const count = fixture.calls.length;
  await fixture.provider(hosts.slice(0, 200));
  assert(fixture.calls.slice(count).every(call => call.provider === 1));
});

test("NOS semantic validation failures and high-water slots cannot contaminate SOL", async () => {
  const fixture = harness(call => {
    if (call.method === "getAccountInfo") return reply(call.id, { context: { slot: call.time / 1000 }, value: { ...mintData(), owner: host } });
    return undefined;
  });
  assert((await fixture.provider([host])).hosts[0]!.error);
  const before = fixture.calls.length;
  const sol = (await fixture.sol([host])).hosts[0]!;
  assert.equal(sol.error, null);
  assert.equal(sol.provider, "Solana Labs");
  assert(fixture.calls.slice(before).every(call => call.provider === 0));
  assert.equal(fixture.calls.filter(call => call.method === "getGenesisHash" && call.provider === 0).length, 1);

  const high = harness(call => call.method === "getMultipleAccounts" && !("dataSlice" in (call.params[1] as object)) ?
    reply(call.id, { context: { slot: 9_000_000_000 }, value: [tokenData()] }) : undefined);
  assert.equal((await high.provider([host])).hosts[0]!.contextSlot, 9_000_000_000);
  assert.equal((await high.sol([host])).hosts[0]!.error, null);
  const solCall = high.calls.find(call => call.method === "getMultipleAccounts" && "dataSlice" in (call.params[1] as object))!;
  assert(!("minContextSlot" in (solCall.params[1] as object)));
});

test("SOL and NOS share actual provider failure cooldown and mainnet verification", async () => {
  const fixture = harness(call => call.provider === 0 && call.method === "getAccountInfo" ?
    new Response("denied", { status: 403 }) : undefined);
  assert.equal((await fixture.provider([host])).hosts[0]!.provider, "PublicNode");
  const before = fixture.calls.length;
  assert.equal((await fixture.sol([host])).hosts[0]!.provider, "PublicNode");
  assert(fixture.calls.slice(before).every(call => call.provider === 1 && call.method !== "getGenesisHash"));

  const concurrent = harness();
  const [nos, sol] = await Promise.all([concurrent.provider([host]), concurrent.sol([host])]);
  assert.equal(nos.hosts[0]!.error, null);
  assert.equal(sol.hosts[0]!.error, null);
  assert.equal(concurrent.calls.filter(call => call.method === "getGenesisHash").length, 1);
  assert.equal(concurrent.calls.filter(call => call.method === "getBlockTime").length, 2);
  for (let index = 1; index < concurrent.calls.length; index++) assert(concurrent.calls[index]!.time - concurrent.calls[index - 1]!.time >= 1000);
});

test("canceling the last NOS viewer aborts upstream without cooling down SOL or blocking immediate NOS resume", async () => {
  let held: Call | undefined;
  let hold = true;
  const fixture = harness(async call => {
    if (hold && call.method === "getMultipleAccounts" && !("dataSlice" in (call.params[1] as object))) {
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
  const sol = await fixture.sol([host]);
  assert.equal(sol.hosts[0]!.error, null);
  second.abort();
  hold = false;
  const resumed = fixture.provider([host]);
  await rejectedB;
  assert.equal(held.signal.aborted, true);
  assert.equal((await resumed).hosts[0]!.error, null);
  assert(fixture.calls.every(call => call.provider === 0));
});

test("concurrent genesis consumers do not cancel each other's verification", async () => {
  let release!: () => void;
  let held: Call | undefined;
  const fixture = harness(async call => {
    if (call.method === "getGenesisHash") {
      held = call;
      await new Promise<void>(resolve => { release = resolve; });
    }
    return undefined;
  });
  const controller = new AbortController();
  const canceled = assert.rejects(fixture.provider([host], controller.signal), { name: "AbortError" });
  const sol = fixture.sol([host]);
  while (!held) await setImmediate();
  controller.abort();
  await canceled;
  assert.equal(held.signal.aborted, false);
  release();
  assert.equal((await sol).hosts[0]!.error, null);
  assert.equal(fixture.calls.filter(call => call.method === "getGenesisHash").length, 1);
});

test("empty and invalid NOS address inputs never contact upstream", async () => {
  const fixture = harness();
  assert.deepEqual(await fixture.provider([]), { hosts: [], nextRefreshAtMs: null });
  await assert.rejects(fixture.provider(["bad"]));
  await assert.rejects(fixture.provider([host, host]));
  assert.equal(fixture.calls.length, 0);
});

function assertBudgets(calls: Call[]): void {
  for (const [count, window] of [[1, 1000], [12, 60_000], [600, 3_600_000], [12_000, 86_400_000]]) {
    for (let index = count!; index < calls.length; index++) {
      assert(calls[index]!.time - calls[index - count!]!.time >= window!, `${count}/${window} rolling budget exceeded`);
    }
  }
}
async function simulateDay(count: number) {
  const fixture = harness();
  const roster = hosts.slice(0, count);
  let solDue = base;
  let nosDue = base;
  let sol!: SolSnapshot;
  let nos!: NosSnapshot;
  let deferrals = 0;
  let stale = 0;
  while (Math.min(solDue, nosDue) < base + 86_400_000) {
    fixture.setTime(Math.max(fixture.now(), Math.min(solDue, nosDue)));
    if (solDue <= fixture.now()) {
      sol = await fixture.sol(roster);
      solDue = sol.nextRefreshAtMs ?? Infinity;
      deferrals += sol.hosts.filter(row => row.error !== null).length;
      stale += sol.hosts.filter(row => row.validUntilMs !== null && row.validUntilMs < fixture.now()).length;
    }
    if (nosDue <= fixture.now()) {
      nos = await fixture.provider(roster);
      nosDue = nos.nextRefreshAtMs ?? Infinity;
      deferrals += nos.hosts.filter(row => row.error !== null).length;
      stale += nos.hosts.filter(row => row.validUntilMs !== null && row.validUntilMs < fixture.now()).length;
    }
  }
  fixture.setTime(base + 86_400_000 - 1);
  sol = await fixture.sol(roster);
  nos = await fixture.provider(roster);
  stale += sol.hosts.filter(row => row.validUntilMs !== null && row.validUntilMs < fixture.now()).length;
  stale += nos.hosts.filter(row => row.validUntilMs !== null && row.validUntilMs < fixture.now()).length;
  assertBudgets(fixture.calls);
  return { ...fixture, sol, nos, deferrals, stale };
}

test("200 hosts sustain a full day of SOL and NOS schedules within one shared budget", async () => {
  const fixture = await simulateDay(200);
  assert.equal(fixture.calls.length, 10_802); // 10,800 balance/freshness calls + genesis + mint.
  assert.equal(fixture.deferrals, 0);
  assert.equal(fixture.stale, 0);
  assert(fixture.sol.hosts.every(row => row.error === null));
  assert(fixture.nos.hosts.every(row => row.error === null));
});

test("201 hosts obey shared hour/day caps and expose honest deferral and staleness instead of raising limits", async () => {
  const fixture = await simulateDay(201);
  assert.equal(fixture.calls.length, 12_000);
  assert(fixture.deferrals > 0);
  assert(fixture.stale > 0);
  assert(fixture.sol.hosts.some(row => row.retained && row.error));
  assert(fixture.nos.hosts.some(row => row.retained && row.error));
  assert(fixture.calls.every(call => call.provider === 0), "budget deferrals must not penalize or rotate providers");
});

test("unsupported NOS mint method disables only NOS capability while SOL stays on Labs", async () => {
  for (const status of ["rpc", "405", "501"]) {
    const fixture = harness(call => call.method === "getAccountInfo" ? status === "rpc" ?
      Response.json({ jsonrpc: "2.0", id: call.id, error: { code: -32601 } }) :
      new Response("unsupported", { status: Number(status) }) : undefined);
    assert((await fixture.provider([host])).hosts[0]!.error);
    const before = fixture.calls.length;
    const sol = await fixture.sol([host]);
    assert.equal(sol.hosts[0]!.provider, "Solana Labs");
    assert.equal(sol.hosts[0]!.error, null);
    assert(fixture.calls.slice(before).every(call => call.provider === 0));
  }
});

test("later batches in one NOS refresh cannot regress behind an already validated later slot", async () => {
  let primaryBatch = 0;
  const minimums: unknown[] = [];
  const fixture = harness(call => {
    if (call.method !== "getMultipleAccounts") return undefined;
    minimums.push((call.params[1] as { minContextSlot?: number }).minContextSlot);
    const slot = call.provider === 0 ? [100, 200, 150][primaryBatch++] : 200;
    return reply(call.id, { context: { slot }, value: (call.params[0] as string[]).map(account => tokenData(owners.get(account)!)) });
  });
  const result = await fixture.provider(hosts);
  assert.deepEqual(minimums, [undefined, 100, 200, 200]);
  assert.equal(result.hosts[200]!.provider, "PublicNode");
  assert.equal(result.hosts[200]!.contextSlot, 200);
  assert(result.hosts.every(row => row.error === null));
});
