import { address as solanaAddress } from "@solana/kit";
import { AccountState, findAssociatedTokenPda, getMintDecoder, getTokenDecoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { isMetadataAddress } from "../src/fleet/host-metadata.ts";
import { NOS_MINT, NOS_DISPLAY_VALIDITY_MS, NOS_REFRESH_INTERVAL_MS } from "../src/fleet/nos.ts";
import type { NosRecord, NosSnapshot } from "../src/fleet/nos.ts";
import { createSharedOperation, throwIfAborted } from "./shared-read.ts";
import type { SharedOperation } from "./shared-read.ts";
import { createSolanaRpc, SolanaRpcError as NosError, waitForRefresh } from "./solana-rpc.ts";
import type { BalanceProviderOptions, SolanaProviderState as ProviderState } from "./solana-rpc.ts";
import { pruneCacheKeys } from "./online-retention.ts";
import type { ProviderRetention } from "./online-retention.ts";

export type NosProvider = ((addresses: readonly string[], signal?: AbortSignal) => Promise<NosSnapshot>) & { retention?: ProviderRetention };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function blank(address: string): NosRecord {
  return { address, tokenAccount: null, mint: NOS_MINT, amount: null, decimals: 6, accountState: null, provider: null, endpoint: null, contextSlot: null,
    blockTimeMs: null, checkedAtMs: null, validUntilMs: null, retained: false, error: null, retryAtMs: null };
}

/** Reject truncated, noncanonical or wrong-program accounts before official decoding. */
function tokenBytes(account: unknown, size: number, label: string): Uint8Array {
  if (!object(account) || account.owner !== TOKEN_PROGRAM_ADDRESS || account.executable !== false ||
      (account.space !== undefined && account.space !== size) || !Array.isArray(account.data) ||
      account.data.length !== 2 || account.data[1] !== "base64" || typeof account.data[0] !== "string") {
    throw new NosError(`NOS ${label} has an invalid token program or account layout.`);
  }
  const encoded = account.data[0];
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new NosError(`NOS ${label} has invalid base64 account data.`);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== size || bytes.toString("base64") !== encoded) {
    throw new NosError(`NOS ${label} has an invalid token account size or encoding.`);
  }
  // Kit's generic boolean option decoder accepts nonzero tags; classic SPL
  // COption fields have only the two canonical discriminants, 0 and 1.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const optionOffsets = size === 82 ? [0, 46] : [72, 109, 129];
  if (optionOffsets.some(offset => view.getUint32(offset, true) > 1)) {
    throw new NosError(`NOS ${label} has an invalid classic token option tag.`);
  }
  return bytes;
}
function decodeBalance(account: unknown, owner: string): Pick<NosRecord, "amount" | "accountState"> {
  if (account === null) return { amount: "0", accountState: "absent" };
  const bytes = tokenBytes(account, 165, "account");
  try {
    const token = getTokenDecoder().decode(bytes);
    if (token.mint !== NOS_MINT || token.owner !== owner ||
        (token.state !== AccountState.Initialized && token.state !== AccountState.Frozen) ||
        token.isNative.__option !== "None") throw new Error("identity/state");
    return { amount: token.amount.toString(), accountState: token.state === AccountState.Frozen ? "frozen" : "initialized" };
  } catch { throw new NosError("NOS account has an invalid mint, wallet owner or initialized/frozen state."); }
}

/** Anonymous, on-demand reads; asset caches and validation are separate from shared RPC health. */
export function createNosProvider(options: BalanceProviderOptions = {}): NosProvider {
  const transport = options.rpc ?? createSolanaRpc(options);
  const { now, rpc, refreshDeadlineMs } = transport;
  const { eligible, nextEligibleAt, failure: providerFailure, success: providerSuccess } = transport.createSession();
  const records = new Map<string, NosRecord>();
  const tokenAccounts = new Map<string, string>();
  const verifiedMints = new Set<ProviderState>();
  const dueAt = new Map<string, number>();
  let activeRefresh: {
    addresses: ReadonlySet<string>;
    operation: SharedOperation<void>;
    completion: Promise<void>;
  } | undefined;
  let highWaterSlot = 0;
  let stoppedForParameters = false;

  async function tokenAccountFor(owner: string): Promise<string> {
    const cached = tokenAccounts.get(owner);
    if (cached) return cached;
    const [account] = await findAssociatedTokenPda({ owner: solanaAddress(owner),
      tokenProgram: TOKEN_PROGRAM_ADDRESS, mint: solanaAddress(NOS_MINT) });
    tokenAccounts.set(owner, account);
    return account;
  }

  async function verifyMint(provider: ProviderState, signal: AbortSignal, deadline: number, floor: number): Promise<void> {
    if (verifiedMints.has(provider)) return;
    const payload = await rpc(provider, "getAccountInfo", [NOS_MINT, { commitment: "confirmed", encoding: "base64",
      ...(floor ? { minContextSlot: floor } : {}) }], signal, deadline);
    if (!object(payload) || !object(payload.context) || typeof payload.context.slot !== "number" ||
        !Number.isSafeInteger(payload.context.slot) || payload.context.slot < floor) {
      throw new NosError("NOS mint response had an invalid or regressed slot.");
    }
    const bytes = tokenBytes(payload.value, 82, "mint");
    try {
      const mint = getMintDecoder().decode(bytes);
      if (mint.decimals !== 6 || !mint.isInitialized || bytes[45] !== 1) throw new Error("mint");
    } catch { throw new NosError("NOS mint is not an initialized classic token mint with six decimals."); }
    throwIfAborted(signal);
    verifiedMints.add(provider);
  }

  async function attempt(provider: ProviderState, batches: string[][], signal: AbortSignal,
    deadline: number, minimumSlot: number, refreshDue: number): Promise<{ remaining: string[][]; error: NosError | null; accepted: boolean }> {
    const healthVersion = provider.healthVersion;
    let remaining = batches;
    let failure: NosError | null = null;
    let accepted = false;
    let oldestSlot: number | null = null;
    let blockTimeMs: number | null = null;
    try {
      await transport.verifyMainnet(provider, signal, deadline);
      await verifyMint(provider, signal, deadline, minimumSlot);
      for (let index = 0; index < batches.length; index++) {
        remaining = batches.slice(index);
        if (provider.retryAtMs > now()) throw new NosError("NOS provider requested a Retry-After pause.", "deferred", provider.retryAtMs);
        const addresses = batches[index]!;
        const accounts = await Promise.all(addresses.map(tokenAccountFor));
        throwIfAborted(signal);
        // After the first batch, this constraint makes it the provider's oldest
        // returned slot. Its one freshness read can finish before a later 429,
        // allowing already validated batches to survive failover without rereads.
        const floor = Math.max(minimumSlot, highWaterSlot, oldestSlot ?? 0);
        const payload = await rpc(provider, "getMultipleAccounts", [accounts, { commitment: "confirmed", encoding: "base64", ...(floor ? { minContextSlot: floor } : {}) }], signal, deadline);
        if (!object(payload) || !object(payload.context) || typeof payload.context.slot !== "number" ||
            !Number.isSafeInteger(payload.context.slot) || payload.context.slot < floor ||
            !Array.isArray(payload.value) || payload.value.length !== addresses.length) {
          throw new NosError("NOS account response had an invalid slot, regressed slot or mismatched batch length.");
        }
        const balances = payload.value.map((account, index) => decodeBalance(account, addresses[index]!));
        const checkedAtMs = now();
        if (oldestSlot === null) {
          oldestSlot = payload.context.slot;
          if (provider.retryAtMs > now()) throw new NosError("NOS provider requested a Retry-After pause.", "deferred", provider.retryAtMs);
          const seconds = await rpc(provider, "getBlockTime", [oldestSlot], signal, deadline);
          if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds < 0 || !Number.isSafeInteger(seconds * 1000)) {
            throw new NosError("NOS provider's oldest batch block time is missing or invalid.");
          }
          blockTimeMs = seconds * 1000;
        }
        if (blockTimeMs === null || now() - blockTimeMs > 60_000 || blockTimeMs - now() > 15_000) {
          throw new NosError("NOS provider's oldest batch block time is stale or in the future.");
        }
        throwIfAborted(signal);
        const contextSlot = payload.context.slot;
        addresses.forEach((address, position) => {
          dueAt.set(address, refreshDue);
          records.set(address, { address, tokenAccount: accounts[position]!, mint: NOS_MINT, decimals: 6,
          ...balances[position]!, provider: provider.name, endpoint: provider.endpoint,
          contextSlot, blockTimeMs, checkedAtMs,
          validUntilMs: checkedAtMs + NOS_DISPLAY_VALIDITY_MS, retained: false, error: null, retryAtMs: null });
        });
        highWaterSlot = Math.max(highWaterSlot, payload.context.slot);
        accepted = true;
        remaining = batches.slice(index + 1);
      }
    } catch (error) {
      throwIfAborted(signal);
      failure = error instanceof NosError ? error : new NosError("NOS refresh could not be completed.");
    }
    throwIfAborted(signal);
    if (failure) providerFailure(provider, failure);
    // A shared budget deferral is not a provider failure. Keep an already
    // validated alternate selected even when the remaining fleet must wait.
    if (accepted && (!failure || failure.kind === "deferred")) {
      providerSuccess(provider, healthVersion);
    }
    return { remaining, error: failure, accepted };
  }

  async function refresh(addresses: readonly string[], signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (stoppedForParameters) return;
    const start = now();
    const deadline = start + Math.min(refreshDeadlineMs, 28_000);
    const batches: string[][] = [];
    const overdue = addresses.filter(address => (dueAt.get(address) ?? 0) <= now());
    for (let index = 0; index < overdue.length; index += 100) batches.push(overdue.slice(index, index + 100));
    if (!batches.length) return;
    let remaining = batches;
    let failure: NosError | null = null;
    let accepted = false;
    const primary = eligible();
    if (primary) {
      const result = await attempt(primary, remaining, signal, deadline, highWaterSlot, start + NOS_REFRESH_INTERVAL_MS);
      ({ remaining, error: failure, accepted } = result);
      if (remaining.length && failure?.kind !== "parameters" && failure?.kind !== "deferred") {
        const alternate = eligible(primary);
        if (alternate) {
          // Successful batches are retained; never race providers or reread them.
          const result = await attempt(alternate, remaining, signal, deadline, highWaterSlot, start + NOS_REFRESH_INTERVAL_MS);
          remaining = result.remaining;
          failure = result.error;
          accepted ||= result.accepted;
        }
      }
    }
    throwIfAborted(signal);
    stoppedForParameters = failure?.kind === "parameters";
    const nextEligible = nextEligibleAt();
    let nextRefreshAtMs = stoppedForParameters || nextEligible === null ? null :
      Math.max(start + NOS_REFRESH_INTERVAL_MS, nextEligible);
    if (!remaining.length && accepted) nextRefreshAtMs = Math.max(start + NOS_REFRESH_INTERVAL_MS, nextEligible ?? 0);
    for (const address of remaining.flat()) {
      dueAt.set(address, nextRefreshAtMs ?? Infinity);
      const previous = records.get(address) ?? blank(address);
      records.set(address, { ...previous, retained: previous.amount !== null,
        error: failure?.message ?? "Every NOS provider is unavailable; previous readings are retained.", retryAtMs: nextRefreshAtMs });
    }
  }

  const provider: NosProvider = async (addresses, signal) => {
    throwIfAborted(signal);
    if (new Set(addresses).size !== addresses.length || addresses.some(address => !isMetadataAddress(address))) {
      throw new Error("NOS reads require unique valid startup Host Addresses.");
    }
    if (!addresses.length) return { hosts: [], nextRefreshAtMs: null };
    // Fixed rosters share one refresh at a time. Only overlapping consumers keep
    // active work alive; disjoint viewers wait without owning its cancellation.
    // Track the initial missing/overdue set so clock movement while waiting never
    // replays refresh intervals or repeatedly refreshes this same request.
    let pending = addresses.filter(address => (dueAt.get(address) ?? 0) <= now());
    const previous = new Map(pending.map(address => [address, records.get(address)]));
    while (!stoppedForParameters && pending.length) {
      throwIfAborted(signal);
      let current = activeRefresh;
      if (current) {
        const activeAddresses = current.addresses;
        if (!pending.some(address => activeAddresses.has(address))) {
          await waitForRefresh(current.completion, signal);
          continue;
        }
      }
      const startsOwnRefresh = current === undefined;
      if (!current) {
        let completed!: () => void;
        const completion = new Promise<void>(resolve => { completed = resolve; });
        const refreshAddresses = [...pending];
        const entry = {
          addresses: new Set(refreshAddresses), completion,
          operation: createSharedOperation(workSignal => refresh(refreshAddresses, workSignal), () => {
            if (activeRefresh === entry) activeRefresh = undefined;
            completed();
          }),
        };
        activeRefresh = entry;
        current = entry;
      }
      await current.operation.read(signal);
      throwIfAborted(signal);
      pending = pending.filter(address => records.get(address) === previous.get(address));
      if (startsOwnRefresh) break;
    }
    throwIfAborted(signal);
    const earliest = Math.min(...addresses.map(address => dueAt.get(address) ?? now()));
    const nextRefreshAtMs = !stoppedForParameters && Number.isFinite(earliest) ? earliest : null;
    return { hosts: addresses.map(address => ({ ...(records.get(address) ?? blank(address)) })), nextRefreshAtMs };
  };
  provider.retention = {
    retryAt: address => Number.isFinite(dueAt.get(address)) ? dueAt.get(address)! : 0,
    prune: ({ hosts }) => pruneCacheKeys(new Set([...hosts, ...activeRefresh?.addresses ?? []]), records, tokenAccounts, dueAt),
  };
  return provider;
}
