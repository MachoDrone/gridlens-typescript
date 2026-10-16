import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { address as solanaAddress, getAddressEncoder } from "@solana/kit";
import { AccountState, getMintEncoder, getTokenEncoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { createStakingProvider, deriveStakingAccounts } from "../scripts/staking.ts";
import { createSolanaRpc, MAINNET_GENESIS_HASH, SOLANA_PROVIDERS } from "../scripts/solana-rpc.ts";
import { NOS_MINT } from "../src/fleet/nos.ts";
import { blankStakingRecord, isStakingRecord, NOSANA_JOBS_PROGRAM, STAKING_PROGRAM, STAKING_REFRESH_INTERVAL_MS } from "../src/fleet/staking.ts";
import { SYNTHETIC_HOST_ADDRESSES as hosts } from "./fixtures/host-addresses.ts";
import type { HostMetadataProvider } from "../scripts/host-metadata.ts";

const base = 1_800_000_000_000;
const host = hosts[0]!;
const market = "11111111111111111111111111111112";
const otherMarket = "11111111111111111111111111111113";
const derived = new Map(await Promise.all(hosts.map(async host => [host, await deriveStakingAccounts(host)] as const)));
const encoder = getAddressEncoder();
function account(owner: string, bytes: ArrayLike<number>) {
  return { owner, executable: false, space: bytes.length, data: [Buffer.from(bytes).toString("base64"), "base64"] };
}
function mintData(decimals = 6) {
  return account(TOKEN_PROGRAM_ADDRESS, getMintEncoder().encode({ mintAuthority: null, supply: 100_000_000_000_000n,
    decimals, isInitialized: true, freezeAuthority: null }));
}
function write128(bytes: Buffer, offset: number, value: bigint): void {
  bytes.writeBigUInt64LE(value & ((1n << 64n) - 1n), offset);
  bytes.writeBigUInt64LE(value >> 64n, offset + 8);
}
function stakeData(host: string, amount = 12_000_000n, unstake = 0n, xnos = 13_000_000n) {
  const bytes = Buffer.alloc(120);
  createHash("sha256").update("account:StakeAccount").digest().copy(bytes, 0, 0, 8);
  bytes.writeBigUInt64LE(amount, 8);
  bytes.set(encoder.encode(solanaAddress(host)), 16);
  bytes.writeBigUInt64LE(1_209_600n, 48);
  bytes.writeBigInt64LE(unstake, 56);
  bytes.set(encoder.encode(solanaAddress(derived.get(host)!.vaultAccount)), 64);
  bytes[96] = derived.get(host)!.vaultBump;
  write128(bytes, 97, xnos);
  return account(STAKING_PROGRAM, bytes);
}
function vaultData(host: string, amount = 12_000_000n, state: AccountState = AccountState.Initialized) {
  return account(TOKEN_PROGRAM_ADDRESS, getTokenEncoder().encode({ mint: solanaAddress(NOS_MINT),
    owner: solanaAddress(derived.get(host)!.vaultAccount), amount, delegate: null, state,
    isNative: null, delegatedAmount: 0n, closeAuthority: null }));
}
function marketData(amount = 10_000_000n) {
  const bytes = Buffer.alloc(151);
  createHash("sha256").update("account:MarketAccount").digest().copy(bytes, 0, 0, 8);
  write128(bytes, 130, amount);
  bytes[146] = 255;
  return account(NOSANA_JOBS_PROGRAM, bytes);
}
interface Call { method: string; params: unknown[]; id: number; provider: number; time: number }
function reply(id: number, result: unknown): Response { return Response.json({ jsonrpc: "2.0", id, result }); }
function harness(handler?: (call: Call) => Response | undefined | Promise<Response | undefined>) {
  let time = base;
  const data = new Map<string, unknown>([[market, marketData()], [otherMarket, marketData(20_000_000n)]]);
  for (const host of hosts) {
    data.set(derived.get(host)!.stakeAccount, stakeData(host));
    data.set(derived.get(host)!.vaultAccount, vaultData(host));
  }
  const assignments = new Map(hosts.map(host => [host, market]));
  let metadataError = false;
  const metadataProvider: HostMetadataProvider = async addresses => ({ hosts: addresses.map(address => ({ address,
    fetchedAtMs: time, retained: metadataError, error: metadataError ? "Metadata unavailable" : null, marketError: null,
    values: { status: null, marketAddress: assignments.get(address) ?? null, marketLabel: null,
      ram: null, disk: null, cpu: null, cuda: null, nvidia: null, currentNode: null, system: null } })) });
  const calls: Call[] = [];
  const rpc = createSolanaRpc({ now: () => time, sleep: async milliseconds => { time += milliseconds; },
    fetch: async (input, init) => {
      const body = JSON.parse(String(init!.body)) as Omit<Call, "provider" | "time">;
      const call = { ...body, provider: SOLANA_PROVIDERS.findIndex(value => value.endpoint === input), time };
      calls.push(call);
      const overridden = await handler?.(call);
      if (overridden) return overridden;
      if (call.method === "getGenesisHash") return reply(call.id, MAINNET_GENESIS_HASH);
      if (call.method === "getBlockTime") return reply(call.id, Math.floor(time / 1000));
      if (call.method === "getAccountInfo") { assert.equal(call.params[0], NOS_MINT); return reply(call.id, { context: { slot: Math.floor(time / 1000) }, value: mintData() }); }
      assert.equal(call.method, "getMultipleAccounts");
      const requested = call.params[0] as string[];
      assert(requested.length <= 100);
      for (const key of requested) assert(data.has(key), "Only supplied fixture host PDAs or assigned markets may be requested");
      return reply(call.id, { context: { slot: Math.floor(time / 1000) }, value: requested.map(key => data.get(key)) });
    } });
  return { provider: createStakingProvider({ rpc, metadataProvider }), calls, data, assignments,
    now: () => time, advance: (ms: number) => { time += ms; }, failMetadata: () => { metadataError = true; } };
}

test("retired stake/account/market eviction preserves provider chain state and watermark", async () => {
  const fixture = harness();
  const original = await fixture.provider([host]);
  fixture.advance(3_600_000);
  fixture.provider.retention!.prune({ hosts: new Set(), markets: new Set(), nowMs: fixture.now() });
  assert.equal(fixture.provider.retention!.retryAt!(host), 0);
  assert.equal(fixture.provider.retention!.marketRetryAt!(market), 0);
  assert.deepEqual([...fixture.provider.retention!.markets!(new Set([host]))], []);
  const rejoined = await fixture.provider([host]);
  assert.equal(rejoined.hosts[0]!.stake.amount, original.hosts[0]!.stake.amount);
  assert.equal(rejoined.hosts[0]!.requirement.targetAmount, original.hosts[0]!.requirement.targetAmount);
  assert.equal(fixture.calls.filter(call => call.method === "getGenesisHash").length, 1);
  const batches = fixture.calls.filter(call => call.method === "getMultipleAccounts");
  assert((batches[2]!.params[1] as { minContextSlot: number }).minContextSlot >= original.hosts[0]!.requirement.contextSlot!);
});

test("stake/vault pairs stay together and market requirements deduplicate with independent evidence", async () => {
  const fixture = harness();
  const result = await fixture.provider(hosts);
  const batches = fixture.calls.filter(call => call.method === "getMultipleAccounts");
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[0]!.params[0], hosts.flatMap(host => [derived.get(host)!.stakeAccount, derived.get(host)!.vaultAccount]));
  assert.deepEqual(batches[1]!.params[0], [market]);
  assert.deepEqual((batches[1]!.params[1] as { dataSlice: unknown }).dataSlice, { offset: 0, length: 151 });
  assert.equal(fixture.calls.filter(call => call.method === "getBlockTime").length, 1);
  assert(result.hosts.every(isStakingRecord));
  assert.equal(result.hosts[0]!.stake.amount, "12000000");
  assert.equal(result.hosts[0]!.requirement.targetAmount, "10000000");
  assert.notEqual(result.hosts[0]!.stake.checkedAtMs, result.hosts[0]!.requirement.checkedAtMs);
  assert.equal(result.nextRefreshAtMs, base + STAKING_REFRESH_INTERVAL_MS);
  const count = fixture.calls.length;
  const cached = await fixture.provider(hosts);
  assert.deepEqual(cached.hosts.map(row => [row.stake, row.requirement]), result.hosts.map(row => [row.stake, row.requirement]));
  assert.equal(fixture.calls.length, count);
});

test("both absent accounts establish zero; one absent remains unknown without poisoning healthy pairs or markets", async () => {
  const fixture = harness();
  fixture.data.set(derived.get(hosts[0]!)!.stakeAccount, null);
  fixture.data.set(derived.get(hosts[0]!)!.vaultAccount, null);
  fixture.data.set(derived.get(hosts[1]!)!.vaultAccount, null);
  const result = await fixture.provider(hosts.slice(0, 3));
  assert.equal(result.hosts[0]!.stake.amount, "0");
  assert.equal(result.hosts[0]!.stake.accountState, "absent");
  assert.equal(result.hosts[1]!.stake.amount, null);
  assert.match(result.hosts[1]!.stake.error!, /inconsistent/);
  assert.equal(result.hosts[2]!.stake.amount, "12000000");
  assert(result.hosts.every(row => row.requirement.targetAmount === "10000000"));
  const fallbackBatches = fixture.calls.filter(call => call.provider === 1 && call.method === "getMultipleAccounts");
  assert.deepEqual(fallbackBatches[0]!.params[0], [derived.get(hosts[1]!)!.stakeAccount, derived.get(hosts[1]!)!.vaultAccount]);
  assert(result.hosts.every(isStakingRecord));
});

test("vault balances preserve withdrawals and unstaking independently from the original ledger amount and xNOS", async () => {
  const fixture = harness();
  fixture.data.set(derived.get(host)!.stakeAccount, stakeData(host, 12_000_000n, 1_799_000_000n, 0n));
  fixture.data.set(derived.get(host)!.vaultAccount, vaultData(host, 5_999_999n, AccountState.Frozen));
  const result = (await fixture.provider([host])).hosts[0]!;
  assert.equal(result.stake.amount, "5999999");
  assert.equal(result.stake.recordedAmount, "12000000");
  assert.equal(result.stake.unstakeAtSeconds, "1799000000");
  assert.equal(result.stake.xnos, "0");
  assert.equal(result.stake.accountState, "frozen");
  fixture.advance(STAKING_REFRESH_INTERVAL_MS);
  fixture.data.set(derived.get(host)!.vaultAccount, vaultData(host, 0n));
  assert.equal((await fixture.provider([host])).hosts[0]!.stake.amount, "0");
});

test("identity, discriminator, canonical padding, mint and initialized token checks reject wrong accounts", async () => {
  const corruptions: ((fixture: ReturnType<typeof harness>) => void)[] = [
    fixture => { const value = stakeData(host); value.owner = TOKEN_PROGRAM_ADDRESS; fixture.data.set(derived.get(host)!.stakeAccount, value); },
    fixture => fixture.data.set(derived.get(host)!.stakeAccount, stakeData(hosts[1]!)),
    fixture => { const value = stakeData(host); const bytes = Buffer.from(value.data[0]!, "base64"); bytes[0] = bytes[0]! ^ 1; value.data[0] = bytes.toString("base64"); fixture.data.set(derived.get(host)!.stakeAccount, value); },
    fixture => { const value = stakeData(host); const bytes = Buffer.from(value.data[0]!, "base64"); bytes[119] = 1; value.data[0] = bytes.toString("base64"); fixture.data.set(derived.get(host)!.stakeAccount, value); },
    fixture => fixture.data.set(derived.get(host)!.vaultAccount, vaultData(hosts[1]!)),
    fixture => { const value = vaultData(host); const bytes = Buffer.from(value.data[0]!, "base64"); bytes[0] = bytes[0]! ^ 1; value.data[0] = bytes.toString("base64"); fixture.data.set(derived.get(host)!.vaultAccount, value); },
    fixture => fixture.data.set(derived.get(host)!.vaultAccount, vaultData(host, 1n, AccountState.Uninitialized)),
  ];
  for (const corrupt of corruptions) {
    const fixture = harness(); corrupt(fixture);
    const result = (await fixture.provider([host])).hosts[0]!;
    assert.equal(result.stake.amount, null);
    assert(result.stake.error);
    assert.equal(result.requirement.targetAmount, "10000000");
    assert(isStakingRecord(result));
  }
});

test("market ownership/layout failures affect only requirement and do not establish zero", async () => {
  for (const invalid of [null, { ...marketData(), owner: STAKING_PROGRAM }, { ...marketData(), space: 100 }, account(NOSANA_JOBS_PROGRAM, Buffer.alloc(151))]) {
    const fixture = harness(); fixture.data.set(market, invalid);
    const result = (await fixture.provider([host])).hosts[0]!;
    assert.equal(result.stake.amount, "12000000");
    assert.equal(result.requirement.targetAmount, null);
    assert(result.requirement.error);
    assert.equal(result.stake.error, null);
  }
});

test("NOS mint validation precedes pair requests", async () => {
  const fixture = harness(call => call.method === "getAccountInfo" ? reply(call.id, { context: { slot: 1 }, value: mintData(9) }) : undefined);
  const result = (await fixture.provider([host])).hosts[0]!;
  assert(result.stake.error && result.requirement.error);
  assert.equal(result.stake.amount, null);
  assert.equal(fixture.calls.filter(call => call.method === "getMultipleAccounts").length, 0);
});

test("market changes request only the new requirement and immediately drop the old identity", async () => {
  const fixture = harness();
  const initial = (await fixture.provider([host])).hosts[0]!;
  const count = fixture.calls.length;
  fixture.assignments.set(host, otherMarket);
  const changed = (await fixture.provider([host])).hosts[0]!;
  assert.deepEqual(changed.stake, initial.stake);
  assert.equal(changed.marketAddress, otherMarket);
  assert.equal(changed.requirement.marketAddress, otherMarket);
  assert.equal(changed.requirement.targetAmount, "20000000");
  assert(fixture.calls.slice(count).filter(call => call.method === "getMultipleAccounts").every(call => (call.params[0] as string[]).every(key => key === otherMarket)));
  fixture.assignments.delete(host);
  const unknown = (await fixture.provider([host])).hosts[0]!;
  assert.equal(unknown.requirement.targetAmount, null);
  assert.equal(unknown.marketAddress, null);
  assert.equal(unknown.stake.amount, initial.stake.amount);
});

test("retained metadata cannot authorize a previously unread market requirement", async () => {
  const fixture = harness();
  await fixture.provider([host]);
  fixture.failMetadata(); fixture.assignments.set(host, otherMarket);
  const before = fixture.calls.length;
  const result = (await fixture.provider([host])).hosts[0]!;
  assert.equal(result.marketRetained, true);
  assert(result.marketError);
  assert.equal(result.stake.amount, "12000000");
  assert.equal(result.requirement.targetAmount, null);
  assert.equal(fixture.calls.length, before);
});

test("failed refresh retains exact previous values and source times with immediate failure states", async () => {
  let fail = false;
  const fixture = harness(call => fail && call.method === "getMultipleAccounts" ? new Response("failed", { status: 503 }) : undefined);
  const before = (await fixture.provider([host])).hosts[0]!;
  fail = true; fixture.advance(STAKING_REFRESH_INTERVAL_MS);
  const after = (await fixture.provider([host])).hosts[0]!;
  assert.equal(after.stake.amount, before.stake.amount);
  assert.equal(after.stake.checkedAtMs, before.stake.checkedAtMs);
  assert.equal(after.requirement.checkedAtMs, before.requirement.checkedAtMs);
  assert(after.stake.retained && after.requirement.retained);
  assert(after.stake.error && after.requirement.error);
  assert(isStakingRecord(after));
});

test("stale oldest-slot block times cannot establish balances or targets", async () => {
  const fixture = harness(call => call.method === "getBlockTime" ? reply(call.id, Math.floor(call.time / 1000) - 61) : undefined);
  const result = (await fixture.provider([host])).hosts[0]!;
  assert.equal(result.stake.amount, null);
  assert.equal(result.requirement.targetAmount, null);
  assert.match(result.stake.error!, /stale/);
});

test("exact u64 vault and u128 target amounts survive JSON boundaries", async () => {
  const fixture = harness();
  fixture.data.set(derived.get(host)!.vaultAccount, vaultData(host, (1n << 64n) - 1n));
  fixture.data.set(market, marketData((1n << 128n) - 1n));
  const result = (await fixture.provider([host])).hosts[0]!;
  assert.equal(result.stake.amount, "18446744073709551615");
  assert.equal(result.requirement.targetAmount, "340282366920938463463374607431768211455");
  assert(isStakingRecord(JSON.parse(JSON.stringify(result))));
});

test("empty and invalid rosters never reach RPC and blank records remain unknown", async () => {
  const fixture = harness();
  assert.deepEqual(await fixture.provider([]), { hosts: [], nextRefreshAtMs: null });
  await assert.rejects(fixture.provider(["bad"]));
  await assert.rejects(fixture.provider([host, host]));
  assert.equal(fixture.calls.length, 0);
  assert(isStakingRecord(blankStakingRecord(host)));
});
