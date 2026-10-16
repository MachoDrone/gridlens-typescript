import { isMetadataAddress } from "../src/fleet/host-metadata.ts";
import { isLamports, SOL_DISPLAY_VALIDITY_MS, SOL_REFRESH_INTERVAL_MS } from "../src/fleet/sol.ts";
import type { SolRecord, SolSnapshot } from "../src/fleet/sol.ts";
import { createSharedOperation, throwIfAborted } from "./shared-read.ts";
import type { SharedOperation } from "./shared-read.ts";
import { createSolanaRpc, SolanaRpcError as SolError, waitForRefresh } from "./solana-rpc.ts";
import type { BalanceProviderOptions, SolanaProviderState as ProviderState } from "./solana-rpc.ts";
import { pruneCacheKeys } from "./online-retention.ts";
import type { ProviderRetention } from "./online-retention.ts";
export { SOLANA_PROVIDERS as SOL_PROVIDERS, MAINNET_GENESIS_HASH, SolanaRequestBudget as SolRequestBudget } from "./solana-rpc.ts";

export type SolProvider = ((addresses: readonly string[], signal?: AbortSignal,
  onUpdate?: (snapshot: SolSnapshot) => void) => Promise<SolSnapshot>) & { retention?: ProviderRetention };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function blank(address: string): SolRecord {
  return { address, lamports: null, provider: null, endpoint: null, contextSlot: null,
    blockTimeMs: null, checkedAtMs: null, validUntilMs: null, retained: false, error: null, retryAtMs: null };
}
/** Anonymous, on-demand reads; asset caches and validation are separate from shared RPC health. */
export function createSolProvider(options: BalanceProviderOptions = {}): SolProvider {
  const transport = options.rpc ?? createSolanaRpc(options);
  const { now, rpc, refreshDeadlineMs } = transport;
  const { eligible, nextEligibleAt, failure: providerFailure, success: providerSuccess } = transport.createSession();
  const records = new Map<string, SolRecord>();
  const dueAt = new Map<string, number>();
  const attemptedAt = new Map<string, number>();
  const insertionOrder = new Map<string, number>();
  let insertionSequence = 0;
  const listeners = new Set<{ addresses: ReadonlySet<string>; signal: AbortSignal | undefined;
    onUpdate: (snapshot: SolSnapshot) => void }>();
  let activeRefresh: {
    addresses: ReadonlySet<string>;
    operation: SharedOperation<void>;
    completion: Promise<void>;
  } | undefined;
  let highWaterSlot = 0;
  let stoppedForParameters = false;

  function snapshot(addresses: readonly string[]): SolSnapshot {
    const earliest = addresses.reduce((next, address) => Math.min(next, dueAt.get(address) ?? now()), Infinity);
    return { hosts: addresses.map(address => ({ ...(records.get(address) ?? blank(address)) })),
      nextRefreshAtMs: !stoppedForParameters && Number.isFinite(earliest) ? earliest : null };
  }

  function publish(addresses: readonly string[]): void {
    for (const listener of listeners) {
      if (listener.signal?.aborted) continue;
      const matching = addresses.filter(address => listener.addresses.has(address));
      if (matching.length) {
        try { listener.onUpdate(snapshot(matching)); } catch { /* The final read remains authoritative. */ }
      }
    }
  }

  async function attempt(provider: ProviderState, batches: string[][], signal: AbortSignal,
    deadline: number, minimumSlot: number, refreshDue: number): Promise<{ remaining: string[][]; error: SolError | null; accepted: boolean }> {
    const healthVersion = provider.healthVersion;
    let remaining = batches;
    let failure: SolError | null = null;
    let accepted = false;
    let oldestSlot: number | null = null;
    let blockTimeMs: number | null = null;
    try {
      await transport.verifyMainnet(provider, signal, deadline);
      for (let index = 0; index < batches.length; index++) {
        remaining = batches.slice(index);
        if (provider.retryAtMs > now()) throw new SolError("SOL provider requested a Retry-After pause.", "deferred", provider.retryAtMs);
        const addresses = batches[index]!;
        // After the first batch, this constraint makes it the provider's oldest
        // returned slot. Its one freshness read can finish before a later 429,
        // allowing already validated batches to survive failover without rereads.
        const floor = Math.max(minimumSlot, highWaterSlot, oldestSlot ?? 0);
        let payload: unknown;
        try {
          payload = await rpc(provider, "getMultipleAccounts", [addresses, { commitment: "confirmed", encoding: "base64",
            dataSlice: { offset: 0, length: 0 }, ...(floor ? { minContextSlot: floor } : {}) }], signal, deadline);
        } catch (error) {
          throwIfAborted(signal);
          // Quota/provider pauses and cancellation do not consume a host's
          // initial attempt. Actual failed responses do, avoiding a permanent
          // first-read lane for an unresolved account batch.
          if (!(error instanceof SolError) || error.kind !== "deferred") {
            addresses.forEach(address => attemptedAt.set(address, now()));
          }
          throw error;
        }
        addresses.forEach(address => attemptedAt.set(address, now()));
        if (!object(payload) || !object(payload.context) || typeof payload.context.slot !== "number" ||
            !Number.isSafeInteger(payload.context.slot) || payload.context.slot < floor ||
            !Array.isArray(payload.value) || payload.value.length !== addresses.length) {
          throw new SolError("SOL account response had an invalid slot, regressed slot or mismatched batch length.");
        }
        const lamports = payload.value.map(account => {
          if (account === null) return null;
          if (!object(account) || !isLamports(account.lamports)) throw new SolError("SOL account response contained invalid lamports.");
          return account.lamports;
        });
        const checkedAtMs = now();
        if (oldestSlot === null) {
          oldestSlot = payload.context.slot;
          if (provider.retryAtMs > now()) throw new SolError("SOL provider requested a Retry-After pause.", "deferred", provider.retryAtMs);
          const seconds = await rpc(provider, "getBlockTime", [oldestSlot], signal, deadline);
          if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds < 0 || !Number.isSafeInteger(seconds * 1000)) {
            throw new SolError("SOL provider's oldest batch block time is missing or invalid.");
          }
          blockTimeMs = seconds * 1000;
        }
        if (blockTimeMs === null || now() - blockTimeMs > 60_000 || blockTimeMs - now() > 15_000) {
          throw new SolError("SOL provider's oldest batch block time is stale or in the future.");
        }
        throwIfAborted(signal);
        const contextSlot = payload.context.slot;
        addresses.forEach((address, position) => {
          dueAt.set(address, refreshDue);
          records.set(address, { address,
          lamports: lamports[position]!, provider: provider.name, endpoint: provider.endpoint,
          contextSlot, blockTimeMs, checkedAtMs,
          validUntilMs: checkedAtMs + SOL_DISPLAY_VALIDITY_MS, retained: false, error: null, retryAtMs: null });
        });
        highWaterSlot = Math.max(highWaterSlot, payload.context.slot);
        accepted = true;
        remaining = batches.slice(index + 1);
        // The first batch has passed genesis, identity, slot and block-time
        // validation. Later batches reuse that oldest-slot proof and can be
        // delivered independently of slower or failing remaining accounts.
        publish(addresses);
      }
    } catch (error) {
      throwIfAborted(signal);
      failure = error instanceof SolError ? error : new SolError("SOL refresh could not be completed.");
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
    const overdue = addresses.filter(address => (dueAt.get(address) ?? 0) <= now()).sort((left, right) => {
      const firstPass = Number(attemptedAt.has(left)) - Number(attemptedAt.has(right));
      if (firstPass) return firstPass;
      // Rotating by original evidence prevents a large roster's prefix from
      // consuming every quota window. Caller ordering cannot restart rotation.
      const oldest = (records.get(left)?.checkedAtMs ?? attemptedAt.get(left) ?? 0) -
        (records.get(right)?.checkedAtMs ?? attemptedAt.get(right) ?? 0);
      return oldest || (dueAt.get(left) ?? 0) - (dueAt.get(right) ?? 0) || insertionOrder.get(left)! - insertionOrder.get(right)!;
    });
    for (let index = 0; index < overdue.length; index += 100) batches.push(overdue.slice(index, index + 100));
    if (!batches.length) return;
    let remaining = batches;
    let failure: SolError | null = null;
    let accepted = false;
    const primary = eligible();
    if (primary) {
      const result = await attempt(primary, remaining, signal, deadline, highWaterSlot, start + SOL_REFRESH_INTERVAL_MS);
      ({ remaining, error: failure, accepted } = result);
      // A provider's Retry-After pauses that provider, while a quota deferral
      // pauses everybody. One otherwise-eligible alternate may finish the
      // unvalidated remainder; its RPCs still use the same budget and deadline.
      const providerPaused = failure?.kind === "deferred" && primary.retryAtMs > now();
      if (remaining.length && failure?.kind !== "parameters" && (failure?.kind !== "deferred" || providerPaused)) {
        const alternate = eligible(primary);
        if (alternate) {
          // Successful batches are retained; never race providers or reread them.
          const result = await attempt(alternate, remaining, signal, deadline, highWaterSlot, start + SOL_REFRESH_INTERVAL_MS);
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
      Math.max(start + SOL_REFRESH_INTERVAL_MS, nextEligible);
    if (!remaining.length && accepted) nextRefreshAtMs = Math.max(start + SOL_REFRESH_INTERVAL_MS, nextEligible ?? 0);
    for (const address of remaining.flat()) {
      dueAt.set(address, nextRefreshAtMs ?? Infinity);
      const previous = records.get(address) ?? blank(address);
      records.set(address, { ...previous, retained: previous.lamports !== null,
        error: failure?.message ?? "Every SOL provider is unavailable; previous readings are retained.", retryAtMs: nextRefreshAtMs });
    }
    publish(remaining.flat());
  }

  const provider: SolProvider = async (addresses, signal, onUpdate) => {
    throwIfAborted(signal);
    if (new Set(addresses).size !== addresses.length || addresses.some(address => !isMetadataAddress(address))) {
      throw new Error("SOL reads require unique valid startup Host Addresses.");
    }
    if (!addresses.length) return { hosts: [], nextRefreshAtMs: null };
    for (const address of addresses) if (!insertionOrder.has(address)) insertionOrder.set(address, insertionSequence++);
    const listener = onUpdate ? { addresses: new Set(addresses), signal, onUpdate } : undefined;
    if (listener) listeners.add(listener);
    try {
      // Replaying only established records lets new viewers receive validated
      // shared batches immediately without inventing source times or requests.
      const cached = addresses.filter(address => records.has(address));
      if (onUpdate && cached.length) {
        try { onUpdate(snapshot(cached)); } catch { /* Observer failure must not affect shared RPC health or work. */ }
      }
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
      return snapshot(addresses);
    } finally {
      if (listener) listeners.delete(listener);
    }
  };
  provider.retention = {
    retryAt: address => Number.isFinite(dueAt.get(address)) ? dueAt.get(address)! : 0,
    prune: ({ hosts }) => {
      const keep = new Set([...hosts, ...activeRefresh?.addresses ?? [],
        ...[...listeners].flatMap(listener => [...listener.addresses])]);
      pruneCacheKeys(keep, records, dueAt, attemptedAt, insertionOrder);
    },
  };
  return provider;
}
