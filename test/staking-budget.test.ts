import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { AccountState, findAssociatedTokenPda, getMintEncoder, getTokenEncoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { createNosProvider } from "../scripts/nos.ts";
import { createSolProvider } from "../scripts/sol.ts";
import { createStakingProvider } from "../scripts/staking.ts";
import { createSolanaRpc, MAINNET_GENESIS_HASH, SOLANA_PROVIDERS } from "../scripts/solana-rpc.ts";
import type { HostMetadataProvider } from "../scripts/host-metadata.ts";
import { normalizeHostMetadata } from "../src/fleet/host-metadata.ts";
import { NOS_MINT } from "../src/fleet/nos.ts";

const base = 1_800_000_000_000;
const day = 86_400_000;
const stakingProgram = address("nosScmHY2uR24Zh751PmGj9ww9QRNHewh9H59AfrTJE");
const jobsProgram = "nosJhNRqr2bc9g1nfGDcXXTXvYUmxD4cVwy2pMWhrYM";

// Deterministic, isolated public identities; no wallet, signer or live roster.
function fixtureAddress(value: number): string {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(value, 28);
  return getAddressDecoder().decode(bytes);
}
const hosts = Array.from({ length: 200 }, (_, index) => fixtureAddress(index + 1));
const markets = Array.from({ length: 200 }, (_, index) => fixtureAddress(index + 1001));
const accountEncoder = getAddressEncoder();
const pairs = await Promise.all(hosts.map(async host => {
  const derive = (prefix: string) => getProgramDerivedAddress({ programAddress: stakingProgram,
    seeds: [new TextEncoder().encode(prefix), accountEncoder.encode(address(NOS_MINT)), accountEncoder.encode(address(host))] });
  const [stake, vault] = await Promise.all([derive("stake"), derive("vault")]);
  return { host, stake: stake[0], vault: vault[0] };
}));
const stakingAccounts = new Set(pairs.flatMap(pair => [String(pair.stake), String(pair.vault)]));
const atas = await Promise.all(hosts.map(async host => (await findAssociatedTokenPda({
  owner: address(host), mint: address(NOS_MINT), tokenProgram: TOKEN_PROGRAM_ADDRESS,
}))[0]));
const ataOwners = new Map(atas.map((ata, index) => [String(ata), hosts[index]!]));
const hostMarkets = new Map(hosts.map((host, index) => [host, markets[index]!]));

interface Call { provider: number; method: string; params: unknown[]; id: number; time: number; signal: AbortSignal }
function reply(id: number, result: unknown): Response { return Response.json({ jsonrpc: "2.0", id, result }); }
function account(data: ArrayLike<number>, owner = String(TOKEN_PROGRAM_ADDRESS), space = data.length) {
  return { owner, executable: false, lamports: 2039280, space, data: [Buffer.from(data).toString("base64"), "base64"] };
}
const mint = account(getMintEncoder().encode({ mintAuthority: null, supply: 100_000_000_000_000n,
  decimals: 6, isInitialized: true, freezeAuthority: null }));
const balances = new Map(hosts.map(host => [host, account(getTokenEncoder().encode({
  mint: address(NOS_MINT), owner: address(host), amount: 1_000_000n, delegate: null,
  state: AccountState.Initialized, isNative: null, delegatedAmount: 0n, closeAuthority: null,
}))]));
function marketAccount(length: number) {
  const bytes = Buffer.alloc(151);
  Buffer.from("c94ebbe1f0c6c9fb", "hex").copy(bytes);
  bytes[146] = 255;
  return account(bytes.subarray(0, length), jobsProgram, 10_240);
}
function isStakeBatch(call: Call): boolean {
  return call.method === "getMultipleAccounts" && stakingAccounts.has((call.params[0] as string[])[0]!);
}

function harness(handler?: (call: Call) => Response | undefined | Promise<Response | undefined>) {
  let time = base;
  let onTime: (() => void) | undefined;
  const calls: Call[] = [];
  const rpc = createSolanaRpc({ now: () => time, sleep: async (ms, signal) => { signal.throwIfAborted(); time += ms; onTime?.(); },
    fetch: async (input, init) => {
      const request = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      const call = { ...request, provider: SOLANA_PROVIDERS.findIndex(provider => provider.endpoint === String(input)),
        time, signal: init!.signal! };
      assert(call.provider >= 0);
      assert.equal(init?.method, "POST");
      assert.equal(init?.credentials, "omit");
      calls.push(call);
      const overridden = await handler?.(call);
      if (overridden) return overridden;
      if (call.method === "getGenesisHash") return reply(call.id, MAINNET_GENESIS_HASH);
      if (call.method === "getBlockTime") return reply(call.id, Math.floor(time / 1000));
      if (call.method === "getAccountInfo") {
        assert.equal(call.params[0], NOS_MINT);
        return reply(call.id, { context: { slot: Math.floor(time / 1000) }, value: mint });
      }
      assert.equal(call.method, "getMultipleAccounts");
      const batch = call.params[0] as string[];
      const config = call.params[1] as { dataSlice?: { offset: number; length: number } };
      assert(batch.length > 0 && batch.length <= 100);
      const value = batch.map(key => {
        if (hosts.includes(key)) { assert.equal(config.dataSlice?.length, 0); return { lamports: 5_000_000 }; }
        if (ataOwners.has(key)) return balances.get(ataOwners.get(key)!);
        if (stakingAccounts.has(key)) return null;
        assert(markets.includes(key), "every account must belong to this isolated fixture");
        assert.equal(config.dataSlice?.offset, 0);
        return marketAccount(config.dataSlice?.length ?? 151);
      });
      if (isStakeBatch(call)) {
        assert.equal(batch.length % 2, 0);
        for (let index = 0; index < batch.length; index += 2) {
          assert(pairs.some(pair => pair.stake === batch[index] && pair.vault === batch[index + 1]), "stake/vault pairs stay together");
        }
      }
      return reply(call.id, { context: { slot: Math.floor(time / 1000) }, value });
    } });
  const metadataProvider: HostMetadataProvider = async addresses => ({ hosts: addresses.map(host => ({
    address: host, values: normalizeHostMetadata(host, { nodeAddress: host, marketAddress: hostMarkets.get(host), metrics: {} }),
    fetchedAtMs: time, retained: false, error: null, marketError: null,
  })) });
  return { rpc, sol: createSolProvider({ rpc }), nos: createNosProvider({ rpc }),
    staking: createStakingProvider({ rpc, metadataProvider }), calls, now: () => time,
    observeTime: (observer: () => void) => { onTime = observer; },
    setTime: (value: number) => { assert(value >= time, "simulation clock must move forward"); time = value; onTime?.(); } };
}

function assertBudgets(calls: Call[]): void {
  for (const [count, window] of [[1, 1000], [12, 60_000], [600, 3_600_000], [12_000, day]] as const) {
    for (let index = count; index < calls.length; index++) {
      assert(calls[index]!.time - calls[index - count]!.time >= window, `${count}/${window} rolling budget exceeded`);
    }
  }
}

test("200 hosts and 200 markets sustain a simulated day through the shared SOL/NOS/staking limits", async () => {
  const fixture = harness();
  let solDue = base;
  let nosDue = base + 10_000;
  // Stagger only the initial read; all later deadlines come from the real providers.
  let stakingDue = base + 100_000;
  let deferred = 0;
  let stale = 0;
  const displayed = new Map<string, readonly { checkedAtMs: number | null; validUntilMs: number | null }[]>();
  const maximumExpiryOverrun = new Map<string, number>([["sol", 0], ["nos", 0], ["staking", 0]]);
  const validity = new Map([["sol", 60_000], ["nos", 180_000], ["staking", 2_100_000]]);
  fixture.observeTime(() => {
    for (const [asset, readings] of displayed) for (const reading of readings) {
      if (reading.validUntilMs !== null) {
        assert.equal(reading.validUntilMs, reading.checkedAtMs! + validity.get(asset)!, "pacing never extends source validity");
        maximumExpiryOverrun.set(asset, Math.max(maximumExpiryOverrun.get(asset)!, fixture.now() - reading.validUntilMs));
      }
    }
  });
  while (Math.min(solDue, nosDue, stakingDue) < base + day) {
    fixture.setTime(Math.max(fixture.now(), Math.min(solDue, nosDue, stakingDue)));
    if (solDue <= fixture.now()) {
      const snapshot = await fixture.sol(hosts);
      displayed.set("sol", snapshot.hosts);
      solDue = snapshot.nextRefreshAtMs ?? Infinity;
      deferred += snapshot.hosts.filter(row => row.error !== null).length;
      stale += snapshot.hosts.filter(row => row.validUntilMs !== null && row.validUntilMs < fixture.now()).length;
    }
    if (nosDue <= fixture.now()) {
      const snapshot = await fixture.nos(hosts);
      displayed.set("nos", snapshot.hosts);
      nosDue = snapshot.nextRefreshAtMs ?? Infinity;
      deferred += snapshot.hosts.filter(row => row.error !== null).length;
      stale += snapshot.hosts.filter(row => row.validUntilMs !== null && row.validUntilMs < fixture.now()).length;
    }
    if (stakingDue <= fixture.now()) {
      const snapshot = await fixture.staking(hosts);
      displayed.set("staking", snapshot.hosts.flatMap(row => [row.stake, row.requirement]));
      stakingDue = snapshot.nextRefreshAtMs ?? Infinity;
      deferred += snapshot.hosts.filter(row => row.stake.error !== null || row.requirement.error !== null).length;
      stale += snapshot.hosts.filter(row => [row.stake, row.requirement].some(reading =>
        reading.validUntilMs !== null && reading.validUntilMs < fixture.now())).length;
      assert(snapshot.hosts.every(row => row.stake.amount === "0" && row.requirement.targetAmount === "0"),
        JSON.stringify({ at: fixture.now() - base, next: stakingDue - base,
          states: [...new Set(snapshot.hosts.map(row => `${row.stake.amount}/${row.requirement.targetAmount}: ${row.stake.error}; ${row.requirement.error}`))],
          calls: fixture.calls.slice(-15).map(call => [call.time - base, call.method, (call.params[0] as string[])?.length]) }));
    }
  }
  assertBudgets(fixture.calls);
  // The 12/minute window can split staking work despite nominal daily headroom.
  // Deferred reads retain their original deadlines. Published SOL/NOS can expire
  // gray between responses; returned snapshots recover without extending TTLs.
  assert(deferred > 0);
  assert.equal(stale, 0);
  assert.equal(maximumExpiryOverrun.get("staking"), 0);
  assert(maximumExpiryOverrun.get("nos")! > 0);
  assert(maximumExpiryOverrun.get("nos")! <= 120_000, JSON.stringify([...maximumExpiryOverrun]));
  assert(maximumExpiryOverrun.get("sol")! <= 30_000, JSON.stringify([...maximumExpiryOverrun]));
  assert(fixture.calls.length > 10_800 && fixture.calls.length < 12_000);
  assert.equal(fixture.calls.filter(call => call.method === "getGenesisHash").length, 1);
  assert.equal(fixture.calls.filter(isStakeBatch).length, 48 * 4);
  assert(fixture.calls.every(call => call.provider === 0));
});

test("the nominal 200-host/market staking cadence adds 384 daily reads plus startup verification", async () => {
  const fixture = harness();
  let due = base;
  for (let index = 0; index < 48; index++) {
    fixture.setTime(due);
    const result = await fixture.staking(hosts);
    assert(result.hosts.every(row => row.stake.amount === "0" && row.requirement.targetAmount === "0" &&
      row.stake.error === null && row.requirement.error === null));
    assert.equal(result.nextRefreshAtMs, due + 1_800_000);
    due = result.nextRefreshAtMs!;
  }
  assert.equal(fixture.calls.length, 385);
  assert.equal(fixture.calls.filter(call => call.method === "getGenesisHash").length, 1);
  assert.equal(fixture.calls.filter(call => call.method === "getAccountInfo").length, 48);
  assert.equal(fixture.calls.filter(call => call.method === "getBlockTime").length, 48);
  assert.equal(fixture.calls.filter(isStakeBatch).length, 192);
  assert.equal(fixture.calls.filter(call => call.method === "getMultipleAccounts" && !isStakeBatch(call)).length, 96);
  assertBudgets(fixture.calls);
});

test("staking viewers share work and last-viewer cancellation does not cool down SOL or NOS", async () => {
  let held: Call | undefined;
  let hold = true;
  const fixture = harness(async call => {
    if (hold && isStakeBatch(call)) {
      held = call;
      await new Promise<void>((_resolve, reject) => call.signal.addEventListener("abort", () => reject(call.signal.reason), { once: true }));
    }
    return undefined;
  });
  const first = new AbortController();
  const second = new AbortController();
  const a = assert.rejects(fixture.staking([hosts[0]!], first.signal), { name: "AbortError" });
  const b = assert.rejects(fixture.staking([hosts[0]!], second.signal), { name: "AbortError" });
  while (!held) await setImmediate();
  first.abort();
  await a;
  assert.equal(held.signal.aborted, false);
  assert.equal(fixture.calls.filter(isStakeBatch).length, 1);
  assert.equal((await fixture.sol([hosts[0]!])).hosts[0]!.error, null);
  second.abort();
  hold = false;
  const resumed = fixture.staking([hosts[0]!]);
  await b;
  assert.equal(held.signal.aborted, true);
  const snapshot = await resumed;
  assert.equal(snapshot.hosts[0]!.stake.error, null);
  assert.equal(snapshot.hosts[0]!.requirement.error, null);
  fixture.setTime(base + 60_000);
  assert.equal((await fixture.nos([hosts[0]!])).hosts[0]!.error, null);
  assert(fixture.calls.every(call => call.provider === 0));
  assertBudgets(fixture.calls);
});

test("a simultaneous cold 200-host/market read defers under the shared minute cap without rotating providers", async () => {
  const fixture = harness();
  const [sol, nos, staking] = await Promise.all([fixture.sol(hosts), fixture.nos(hosts), fixture.staking(hosts)]);
  assertBudgets(fixture.calls);
  assert(fixture.calls.length <= 12, "cold demand cannot create a second RPC allowance");
  assert(fixture.calls.every(call => call.provider === 0), "budget pressure must not count as provider failure");
  const deferred = [...sol.hosts, ...nos.hosts, ...staking.hosts.flatMap(row => [row.stake, row.requirement])]
    .filter(row => row.error !== null);
  assert(deferred.length > 0, "the cold request burst exceeds the bounded refresh window");
  assert(deferred.every(row => row.checkedAtMs === null && row.validUntilMs === null && !row.retained));
  assert(deferred.every(row => row.retryAtMs !== null && row.retryAtMs > fixture.now()));
});

test("a staking provider denial is shared with SOL/NOS and a working alternate stays selected", async () => {
  const fixture = harness(call => call.provider === 0 && isStakeBatch(call) ? new Response("denied", { status: 403 }) : undefined);
  const result = await fixture.staking([hosts[0]!]);
  assert.equal(result.hosts[0]!.stake.provider, "PublicNode");
  assert.equal(result.hosts[0]!.stake.error, null);
  fixture.setTime(base + 60_000);
  const before = fixture.calls.length;
  assert.equal((await fixture.sol([hosts[0]!])).hosts[0]!.provider, "PublicNode");
  assert.equal((await fixture.nos([hosts[0]!])).hosts[0]!.provider, "PublicNode");
  assert(fixture.calls.slice(before).every(call => call.provider === 1 && call.method !== "getGenesisHash"));
  assertBudgets(fixture.calls);
});
