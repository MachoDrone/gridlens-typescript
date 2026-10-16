import { createHash } from "node:crypto";
import { address as solanaAddress, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { AccountState, getMintDecoder, getTokenDecoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { isMetadataAddress } from "../src/fleet/host-metadata.ts";
import { NOS_MINT } from "../src/fleet/nos.ts";
import { blankStakingEvidence, blankStakingRecord, NOSANA_JOBS_PROGRAM, STAKING_PROGRAM,
  STAKING_DISPLAY_VALIDITY_MS, STAKING_REFRESH_INTERVAL_MS } from "../src/fleet/staking.ts";
import type { StakingEvidence, StakingReading, StakingRequirement, StakingSnapshot } from "../src/fleet/staking.ts";
import type { HostMetadataRecord } from "../src/fleet/host-metadata.ts";
import type { HostMetadataProvider } from "./host-metadata.ts";
import { createSharedOperation, throwIfAborted } from "./shared-read.ts";
import type { SharedOperation } from "./shared-read.ts";
import { createSolanaRpc, rpcObject, SolanaRpcError, waitForRefresh } from "./solana-rpc.ts";
import type { BalanceProviderOptions, SolanaProviderState } from "./solana-rpc.ts";
import { pruneCacheKeys } from "./online-retention.ts";
import type { ProviderRetention } from "./online-retention.ts";

export type StakingProvider = ((addresses: readonly string[], signal?: AbortSignal) => Promise<StakingSnapshot>) & { retention?: ProviderRetention };
type Task = { kind: "stake" | "market"; keys: string[] };
type DerivedAccounts = { stakeAccount: string; vaultAccount: string; vaultBump: number };
const addressEncoder = getAddressEncoder();
const addressDecoder = getAddressDecoder();
const stakeDiscriminator = createHash("sha256").update("account:StakeAccount").digest().subarray(0, 8);
const marketDiscriminator = createHash("sha256").update("account:MarketAccount").digest().subarray(0, 8);

/** Official program PDA seeds; installed Solana library owns curve/address derivation. */
export async function deriveStakingAccounts(host: string): Promise<DerivedAccounts> {
  const seeds = [addressEncoder.encode(solanaAddress(NOS_MINT)), addressEncoder.encode(solanaAddress(host))];
  const [[stakeAccount], [vaultAccount, vaultBump]] = await Promise.all([
    getProgramDerivedAddress({ programAddress: solanaAddress(STAKING_PROGRAM), seeds: [new TextEncoder().encode("stake"), ...seeds] }),
    getProgramDerivedAddress({ programAddress: solanaAddress(STAKING_PROGRAM), seeds: [new TextEncoder().encode("vault"), ...seeds] }),
  ]);
  return { stakeAccount, vaultAccount, vaultBump };
}
function bytes(account: unknown, owner: string, sizes: readonly number[], label: string): Buffer {
  if (!rpcObject(account) || account.owner !== owner || account.executable !== false ||
      !Array.isArray(account.data) || account.data.length !== 2 || account.data[1] !== "base64" || typeof account.data[0] !== "string") {
    throw new SolanaRpcError(`Staking ${label} has an invalid program or account layout.`);
  }
  const encoded = account.data[0];
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new SolanaRpcError(`Staking ${label} has invalid base64 data.`);
  }
  const decoded = Buffer.from(encoded, "base64");
  if (!sizes.includes(decoded.length) || decoded.toString("base64") !== encoded ||
      (label !== "market" && account.space !== undefined && account.space !== decoded.length)) {
    throw new SolanaRpcError(`Staking ${label} has an invalid account size or encoding.`);
  }
  return decoded;
}
function classicBytes(account: unknown, size: 82 | 165, label: string): Buffer {
  const decoded = bytes(account, TOKEN_PROGRAM_ADDRESS, [size], label);
  if ((size === 82 ? [0, 46] : [72, 109, 129]).some(offset => decoded.readUInt32LE(offset) > 1)) {
    throw new SolanaRpcError(`Staking ${label} has invalid classic token option tags.`);
  }
  return decoded;
}
function unsigned128(data: Buffer, offset: number): string {
  return (data.readBigUInt64LE(offset) + (data.readBigUInt64LE(offset + 8) << 64n)).toString();
}
function decodeStake(host: string, derived: DerivedAccounts, stakeAccount: unknown, vaultAccount: unknown):
  Pick<StakingReading, "amount" | "recordedAmount" | "xnos" | "durationSeconds" | "unstakeAtSeconds" | "accountState"> {
  if (stakeAccount === null && vaultAccount === null) {
    return { amount: "0", recordedAmount: "0", xnos: "0", durationSeconds: "0", unstakeAtSeconds: "0", accountState: "absent" };
  }
  if (stakeAccount === null || vaultAccount === null) throw new SolanaRpcError("Staking account and vault existence are inconsistent.");
  // Borsh serializes 113 bytes. Historic/compiler-aligned allocation can add
  // zero padding; never use Rust struct offsets or the generated docs' i64 typo.
  const stake = bytes(stakeAccount, STAKING_PROGRAM, [113, 120, 128, 136], "account");
  if (!stake.subarray(0, 8).equals(stakeDiscriminator) || stake.subarray(113).some(value => value !== 0) ||
      addressDecoder.decode(stake.subarray(16, 48)) !== host ||
      addressDecoder.decode(stake.subarray(64, 96)) !== derived.vaultAccount || stake[96] !== derived.vaultBump ||
      stake.readBigInt64LE(56) < 0n || stake.readBigUInt64LE(48) < 1_209_600n || stake.readBigUInt64LE(48) > 31_536_000n) {
    throw new SolanaRpcError("Staking account has an invalid discriminator, host authority, vault identity or duration.");
  }
  const rawVault = classicBytes(vaultAccount, 165, "vault");
  try {
    const vault = getTokenDecoder().decode(rawVault);
    if (vault.mint !== NOS_MINT || vault.owner !== derived.vaultAccount || vault.isNative.__option !== "None" ||
        (vault.state !== AccountState.Initialized && vault.state !== AccountState.Frozen)) throw new Error("identity");
    return { amount: vault.amount.toString(), recordedAmount: stake.readBigUInt64LE(8).toString(),
      durationSeconds: stake.readBigUInt64LE(48).toString(), unstakeAtSeconds: stake.readBigInt64LE(56).toString(),
      xnos: unsigned128(stake, 97), accountState: vault.state === AccountState.Frozen ? "frozen" : "initialized" };
  } catch { throw new SolanaRpcError("Staking vault has an invalid NOS mint, self authority or token state."); }
}
function decodeMarket(account: unknown): string {
  // Market headers avoid fetching the potentially large queue body. Exact Borsh
  // offsets are from nosana-programs@7247414d: u128 threshold at 130, queue at151.
  const header = bytes(account, NOSANA_JOBS_PROGRAM, [151], "market");
  if (!header.subarray(0, 8).equals(marketDiscriminator) || ![0, 1, 255].includes(header[146]!) ||
      !rpcObject(account) || typeof account.space !== "number" || !Number.isSafeInteger(account.space) ||
      account.space < 151 + header.readUInt32LE(147) * 32) {
    throw new SolanaRpcError("Staking market has an invalid discriminator or header layout.");
  }
  return unsigned128(header, 130);
}
function slot(payload: unknown, floor: number, count?: number): number {
  if (!rpcObject(payload) || !rpcObject(payload.context) || typeof payload.context.slot !== "number" ||
      !Number.isSafeInteger(payload.context.slot) || payload.context.slot < floor ||
      (count !== undefined && (!Array.isArray(payload.value) || payload.value.length !== count))) {
    throw new SolanaRpcError("Staking RPC returned an invalid/regressed slot or mismatched batch length.");
  }
  return payload.context.slot;
}

/** One on-demand staking cache; all methods consume the existing shared RPC budget. */
export function createStakingProvider(options: BalanceProviderOptions & { metadataProvider: HostMetadataProvider }): StakingProvider {
  const transport = options.rpc ?? createSolanaRpc(options);
  const { now, rpc, refreshDeadlineMs } = transport;
  const session = transport.createSession();
  const stakes = new Map<string, StakingReading>();
  const markets = new Map<string, StakingRequirement>();
  const accounts = new Map<string, DerivedAccounts>();
  const stakeDue = new Map<string, number>();
  const marketDue = new Map<string, number>();
  const hostMarkets = new Map<string, string>();
  let highWaterSlot = 0;
  let stoppedForParameters = false;
  let active: { keys: ReadonlySet<string>; operation: SharedOperation<void>; completion: Promise<void> } | undefined;

  async function derive(host: string): Promise<DerivedAccounts> {
    const cached = accounts.get(host);
    if (cached) return cached;
    const value = await deriveStakingAccounts(host);
    accounts.set(host, value);
    return value;
  }
  function evidence(provider: SolanaProviderState, contextSlot: number, blockTimeMs: number, checkedAtMs: number): StakingEvidence {
    return { provider: provider.name, endpoint: provider.endpoint, contextSlot, blockTimeMs, checkedAtMs,
      validUntilMs: checkedAtMs + STAKING_DISPLAY_VALIDITY_MS, retained: false, error: null, retryAtMs: null };
  }
  async function attempt(provider: SolanaProviderState, tasks: Task[], signal: AbortSignal, deadline: number, due: number):
    Promise<{ remaining: Task[]; error: SolanaRpcError | null }> {
    let remaining = tasks;
    let error: SolanaRpcError | null = null;
    let accepted = false;
    let oldestSlot: number | null = null;
    let blockTimeMs: number | null = null;
    const failedTasks: Task[] = [];
    let semanticError: SolanaRpcError | undefined;
    const healthVersion = provider.healthVersion;
    try {
      await transport.verifyMainnet(provider, signal, deadline);
      // Revalidate mint in each refresh; the one-per-refresh read is in the budget.
      const mintPayload = await rpc(provider, "getAccountInfo", [NOS_MINT, { commitment: "confirmed", encoding: "base64",
        ...(highWaterSlot ? { minContextSlot: highWaterSlot } : {}) }], signal, deadline);
      slot(mintPayload, highWaterSlot);
      const mintBytes = classicBytes((mintPayload as Record<string, unknown>).value, 82, "mint");
      const mint = getMintDecoder().decode(mintBytes);
      if (mint.decimals !== 6 || !mint.isInitialized || mintBytes[45] !== 1) throw new SolanaRpcError("Staking NOS mint must be initialized with six decimals.");
      for (let index = 0; index < tasks.length; index++) {
        remaining = [...failedTasks, ...tasks.slice(index)];
        const task = tasks[index]!;
        const derived = task.kind === "stake" ? await Promise.all(task.keys.map(derive)) : [];
        const requested = task.kind === "stake" ? derived.flatMap(value => [value.stakeAccount, value.vaultAccount]) : task.keys;
        const floor = Math.max(highWaterSlot, oldestSlot ?? 0);
        const payload = await rpc(provider, "getMultipleAccounts", [requested, { commitment: "confirmed", encoding: "base64",
          ...(task.kind === "market" ? { dataSlice: { offset: 0, length: 151 } } : {}),
          ...(floor ? { minContextSlot: floor } : {}) }], signal, deadline);
        const contextSlot = slot(payload, floor, requested.length);
        const values = (payload as { value: unknown[] }).value;
        const checkedAtMs = now();
        if (oldestSlot === null) {
          oldestSlot = contextSlot;
          const seconds = await rpc(provider, "getBlockTime", [oldestSlot], signal, deadline);
          if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds < 0 || !Number.isSafeInteger(seconds * 1000)) {
            throw new SolanaRpcError("Staking provider returned an invalid oldest-slot block time.");
          }
          blockTimeMs = seconds * 1000;
        }
        if (blockTimeMs === null || now() - blockTimeMs > 60_000 || blockTimeMs - now() > 15_000) {
          throw new SolanaRpcError("Staking provider's oldest-slot block time is stale or in the future.");
        }
        throwIfAborted(signal);
        const failed: string[] = [];
        task.keys.forEach((key, position) => {
          try {
            const proof = evidence(provider, contextSlot, blockTimeMs!, checkedAtMs);
            if (task.kind === "stake") {
              const value = decodeStake(key, derived[position]!, values[position * 2], values[position * 2 + 1]);
              stakes.set(key, { ...proof, stakeAccount: derived[position]!.stakeAccount,
                vaultAccount: derived[position]!.vaultAccount, mint: NOS_MINT, ...value });
              stakeDue.set(key, due);
            } else {
              const targetAmount = decodeMarket(values[position]);
              markets.set(key, { ...proof, marketAddress: key, targetAmount, xnosMinimum: targetAmount });
              marketDue.set(key, due);
            }
            accepted = true;
          } catch (caught) {
            failed.push(key);
            semanticError = caught instanceof SolanaRpcError ? caught : new SolanaRpcError("Staking account validation failed.");
          }
        });
        highWaterSlot = Math.max(highWaterSlot, contextSlot);
        if (failed.length) failedTasks.push({ ...task, keys: failed });
        remaining = [...failedTasks, ...tasks.slice(index + 1)];
      }
      if (semanticError) throw semanticError;
    } catch (caught) {
      throwIfAborted(signal);
      error = caught instanceof SolanaRpcError ? caught : new SolanaRpcError("Staking refresh could not be completed.");
    }
    throwIfAborted(signal);
    if (error) session.failure(provider, error);
    if (accepted && (!error || error.kind === "deferred")) session.success(provider, healthVersion);
    return { remaining, error };
  }
  async function refresh(tasks: Task[], signal: AbortSignal): Promise<void> {
    const start = now();
    const deadline = start + refreshDeadlineMs;
    let remaining = tasks;
    let error: SolanaRpcError | null = null;
    const primary = session.eligible();
    if (primary) {
      ({ remaining, error } = await attempt(primary, remaining, signal, deadline, start + STAKING_REFRESH_INTERVAL_MS));
      if (remaining.length && error?.kind !== "parameters" && error?.kind !== "deferred") {
        const alternate = session.eligible(primary);
        if (alternate) ({ remaining, error } = await attempt(alternate, remaining, signal, deadline, start + STAKING_REFRESH_INTERVAL_MS));
      }
    }
    throwIfAborted(signal);
    stoppedForParameters = error?.kind === "parameters";
    const eligibleAt = session.nextEligibleAt();
    // Budget deferrals are scheduling, not a 30-minute failure. A cold fleet can
    // use the next available shared window without manufacturing an error proof.
    const retryAtMs = stoppedForParameters || eligibleAt === null ? null : Math.max(eligibleAt,
      error?.kind === "deferred" ? Math.max(now() + 1000, error.retryAtMs ?? 0) : start + STAKING_REFRESH_INTERVAL_MS);
    for (const task of remaining) for (const key of task.keys) {
      const message = error?.message ?? "Every staking RPC provider is unavailable; prior readings are retained.";
      if (task.kind === "stake") {
        const previous = stakes.get(key) ?? blankStakingRecord(key).stake;
        stakes.set(key, { ...previous, retained: previous.amount !== null, error: message, retryAtMs });
        stakeDue.set(key, retryAtMs ?? Infinity);
      } else {
        const previous = markets.get(key) ?? { ...blankStakingEvidence(), marketAddress: key, targetAmount: null, xnosMinimum: null };
        markets.set(key, { ...previous, retained: previous.targetAmount !== null, error: message, retryAtMs });
        marketDue.set(key, retryAtMs ?? Infinity);
      }
    }
  }
  function tasksFor(addresses: readonly string[], marketAddresses: readonly string[]): Task[] {
    const tasks: Task[] = [];
    for (const [kind, keys, due, size] of [["stake", addresses, stakeDue, 50], ["market", marketAddresses, marketDue, 100]] as const) {
      const overdue = keys.filter(key => (due.get(key) ?? 0) <= now());
      for (let i = 0; i < overdue.length; i += size) tasks.push({ kind, keys: overdue.slice(i, i + size) });
    }
    return tasks;
  }
  const taskKeys = (tasks: Task[]): string[] => tasks.flatMap(task => task.keys.map(key => `${task.kind}:${key}`));
  const provider: StakingProvider = async (addresses, signal) => {
    throwIfAborted(signal);
    if (new Set(addresses).size !== addresses.length || addresses.some(address => !isMetadataAddress(address))) {
      throw new Error("Staking reads require unique valid startup Host Addresses.");
    }
    if (!addresses.length) return { hosts: [], nextRefreshAtMs: null };
    let metadata: HostMetadataRecord[];
    try { metadata = (await options.metadataProvider(addresses, signal)).hosts; }
    catch {
      throwIfAborted(signal);
      metadata = addresses.map(address => ({ address, values: null, fetchedAtMs: null, retained: false, error: "Current market assignment is unavailable.", marketError: null }));
    }
    throwIfAborted(signal);
    const assignments = new Map(metadata.filter(row => addresses.includes(row.address)).map(row => [row.address, row]));
    for (const address of addresses) {
      const market = assignments.get(address)?.values?.marketAddress;
      if (market) hostMarkets.set(address, market);
      else hostMarkets.delete(address);
    }
    const currentMarkets = [...new Set(metadata.filter(row => addresses.includes(row.address) && !row.retained && !row.error &&
      row.fetchedAtMs !== null && row.fetchedAtMs <= now() && now() - row.fetchedAtMs <= 5 * 60_000)
      .map(row => row.values?.marketAddress).filter((market): market is string => isMetadataAddress(market)))];
    let tasks = tasksFor(addresses, currentMarkets);
    while (!stoppedForParameters && tasks.length) {
      throwIfAborted(signal);
      let current = active;
      const activeKeys = current?.keys;
      if (current && activeKeys && !taskKeys(tasks).some(key => activeKeys.has(key))) {
        await waitForRefresh(current.completion, signal);
        tasks = tasksFor(addresses, currentMarkets);
        continue;
      }
      const startsOwn = current === undefined;
      if (!current) {
        let completed!: () => void;
        const completion = new Promise<void>(resolve => { completed = resolve; });
        const entry = { keys: new Set(taskKeys(tasks)), completion,
          operation: createSharedOperation(workSignal => refresh(tasks, workSignal), () => {
            if (active === entry) active = undefined;
            completed();
          }) };
        active = entry;
        current = entry;
      }
      await current.operation.read(signal);
      throwIfAborted(signal);
      if (startsOwn) break;
      tasks = tasksFor(addresses, currentMarkets);
    }
    throwIfAborted(signal);
    const earliest = Math.min(...addresses.map(address => stakeDue.get(address) ?? now()),
      ...currentMarkets.map(market => marketDue.get(market) ?? now()));
    return { hosts: addresses.map(address => {
      const assignment = assignments.get(address);
      const marketAddress = assignment?.values?.marketAddress ?? null;
      const blank = blankStakingRecord(address);
      return { address, marketAddress, marketFetchedAtMs: assignment?.fetchedAtMs ?? null,
        marketRetained: assignment?.retained ?? false, marketError: assignment?.error ?? (assignment ? null : "Current market assignment is unavailable."),
        stake: { ...(stakes.get(address) ?? blank.stake) },
        requirement: { ...(marketAddress ? markets.get(marketAddress) ?? { ...blank.requirement, marketAddress } : blank.requirement) } };
    }), nextRefreshAtMs: !stoppedForParameters && Number.isFinite(earliest) ? earliest : null };
  };
  provider.retention = {
    retryAt: address => Number.isFinite(stakeDue.get(address)) ? stakeDue.get(address)! : 0,
    markets: hosts => [...hosts].flatMap(address => {
      const market = hostMarkets.get(address);
      return market ? [market] : [];
    }),
    marketRetryAt: market => Number.isFinite(marketDue.get(market)) ? marketDue.get(market)! : 0,
    prune: ({ hosts, markets: retainedMarkets, nowMs }) => {
      const keepHosts = new Set(hosts);
      const keepMarkets = new Set(retainedMarkets);
      for (const key of active?.keys ?? []) {
        if (key.startsWith("stake:")) keepHosts.add(key.slice(6));
        else if (key.startsWith("market:")) keepMarkets.add(key.slice(7));
      }
      for (const [market, due] of marketDue) if (Number.isFinite(due) && due > nowMs) keepMarkets.add(market);
      pruneCacheKeys(keepHosts, stakes, accounts, stakeDue, hostMarkets);
      pruneCacheKeys(keepMarkets, markets, marketDue);
    },
  };
  return provider;
}
