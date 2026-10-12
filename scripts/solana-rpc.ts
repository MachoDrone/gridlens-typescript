import { isLamports } from "../src/fleet/sol.ts";
import { createRequestLimiter, createSharedRead, throwIfAborted } from "./shared-read.ts";

export const SOLANA_PROVIDERS = [
  { name: "Solana Labs", endpoint: "https://api.mainnet-beta.solana.com" },
  { name: "PublicNode", endpoint: "https://solana-rpc.publicnode.com" },
  { name: "Solana Vibe Station", endpoint: "https://public.rpc.solanavibestation.com" },
  { name: "OnFinality", endpoint: "https://solana.api.onfinality.io/public" },
] as const;
export const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const responseByteLimit = 512 * 1024;
const maximumTimestamp = 8_640_000_000_000_000;
const requestLimits = [
  { count: 1, windowMs: 1_000 }, { count: 12, windowMs: 60_000 },
  { count: 600, windowMs: 3_600_000 }, { count: 12_000, windowMs: 86_400_000 },
] as const;

/** One process-local rolling budget for all providers AND all RPC methods. */
export class SolanaRequestBudget {
  private dispatches: number[] = [];
  nextAt(time: number): number {
    while (this.dispatches.length && this.dispatches[0]! <= time - 86_400_000) this.dispatches.shift();
    let next = time;
    for (const { count, windowMs } of requestLimits) {
      const threshold = time - windowMs;
      let low = 0;
      let high = this.dispatches.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (this.dispatches[middle]! <= threshold) low = middle + 1;
        else high = middle;
      }
      if (this.dispatches.length - low >= count) {
        next = Math.max(next, this.dispatches[this.dispatches.length - count]! + windowMs);
      }
    }
    return next;
  }
  reserve(time: number): boolean {
    if (this.nextAt(time) > time) return false;
    this.dispatches.push(time);
    return true;
  }
}

type FailureKind = "provider" | "disabled" | "parameters" | "deferred";
export class SolanaRpcError extends Error {
  kind: FailureKind;
  retryAtMs: number | null;
  scope: "asset" | "transport";
  constructor(message: string, kind: FailureKind = "provider", retryAtMs: number | null = null, scope: "asset" | "transport" = "asset") {
    super(message);
    this.kind = kind;
    this.scope = scope;
    this.retryAtMs = retryAtMs;
  }
}
export interface SolanaProviderState {
  name: string;
  endpoint: string;
  genesisVerified: boolean;
  disabled: boolean;
  failures: number;
  healthVersion: number;
  retryAtMs: number;
}

export function rpcObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const abort = (): void => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Wait without becoming a consumer of unrelated upstream work. */
export function waitForRefresh(completion: Promise<void>, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (!signal) return completion;
  return new Promise((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    void completion.then(() => { signal.removeEventListener("abort", abort); resolve(); });
  });
}

/** Read JSON integer lexemes before IEEE-754 rounding can corrupt u64 balances. */
function parseJson(text: string): unknown {
  const parse = JSON.parse as (text: string, reviver: (key: string, value: unknown,
    context: { source?: string }) => unknown) => unknown;
  return parse(text, (key, value, context) => {
    if (key !== "lamports") return value;
    if (typeof value !== "number" || !context.source || !isLamports(context.source)) {
      throw transportError("Solana response contained invalid integer lamports.");
    }
    return context.source;
  });
}

function transportError(message: string, kind: FailureKind = "provider", retryAtMs: number | null = null): SolanaRpcError {
  return new SolanaRpcError(message, kind, retryAtMs, "transport");
}
export interface SolanaRpcOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  timeoutMs?: number;
  refreshDeadlineMs?: number;
}
export type SolanaRpc = ReturnType<typeof createSolanaRpc>;
export type BalanceProviderOptions = SolanaRpcOptions & { rpc?: SolanaRpc };

/** One transport owns pacing, limits and provider/network health for every asset and viewer. */
export function createSolanaRpc({ fetch: fetcher = globalThis.fetch, now = Date.now, sleep = pause,
  timeoutMs = 8_000, refreshDeadlineMs = 28_000 }: SolanaRpcOptions = {}) {
  const providers: SolanaProviderState[] = SOLANA_PROVIDERS.map(provider => ({ ...provider,
    genesisVerified: false, disabled: false, failures: 0, healthVersion: 0, retryAtMs: 0 }));
  const budget = new SolanaRequestBudget();
  const limited = createRequestLimiter(2);
  const genesisReads = createSharedRead<SolanaProviderState, void>();
  const handledFailures = new WeakSet<SolanaRpcError>();
  let preferred: SolanaProviderState | undefined;
  let requestId = 0;
  function retryHeader(response: Response): number | null {
    const value = response.headers.get("retry-after")?.trim();
    if (!value) return null;
    const numeric = /^\d+(?:\.\d+)?$/.test(value);
    const date = numeric ? now() + Number(value) * 1000 : Date.parse(value);
    // Very large numeric pauses remain paused through the representable horizon;
    // overflow must never turn a provider's long delay into the default retry.
    return numeric || Number.isFinite(date) ? Math.min(maximumTimestamp, Math.ceil(Math.max(now(), date))) : null;
  }

  async function rpc(provider: SolanaProviderState, method: string, params: unknown[],
    signal: AbortSignal, deadline: number): Promise<unknown> {
    return limited(async () => {
      // Pacing is shared with queued work and validation/failover, never per viewer.
      for (;;) {
        throwIfAborted(signal);
        if (provider.disabled) throw transportError("Solana provider is disabled for this process.", "disabled");
        if (provider.retryAtMs > now()) throw transportError("Solana provider requested a Retry-After pause.", "deferred", provider.retryAtMs);
        const dispatchAt = budget.nextAt(now());
        if (dispatchAt >= deadline) throw transportError("Solana reads are pending within the shared request budget.", "deferred", dispatchAt);
        if (dispatchAt > now()) await sleep(dispatchAt - now(), signal);
        throwIfAborted(signal);
        if (now() >= deadline) throw transportError("Solana refresh deadline elapsed before dispatch.", "deferred", budget.nextAt(now()));
        if (provider.disabled) throw transportError("Solana provider is disabled for this process.", "disabled");
        if (provider.retryAtMs > now()) throw transportError("Solana provider requested a Retry-After pause.", "deferred", provider.retryAtMs);
        if (budget.reserve(now())) break;
      }
      const controller = new AbortController();
      const abort = (): void => controller.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(timeoutMs, 8_000, deadline - now())));
      const id = ++requestId;
      try {
        const response = await fetcher(provider.endpoint, { method: "POST", credentials: "omit", redirect: "error",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: controller.signal });
        throwIfAborted(signal);
        const retryAt = retryHeader(response);
        if (retryAt !== null) provider.retryAtMs = Math.max(provider.retryAtMs, retryAt);
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          const kind = [401, 403, 405, 501].includes(response.status) ? "disabled" : response.status === 400 ? "parameters" : "provider";
          const scope = method === "getAccountInfo" && [405, 501].includes(response.status) ? "asset" : "transport";
          throw new SolanaRpcError(`Solana ${provider.name} request failed (HTTP ${response.status}).`, kind, retryAt, scope);
        }
        if (Number(response.headers.get("content-length")) > responseByteLimit) {
          void response.body?.cancel().catch(() => {});
          throw transportError("Solana response exceeded the size limit.");
        }
        const reader = response.body?.getReader();
        if (!reader) throw transportError("Solana response did not contain JSON.");
        const chunks: Uint8Array[] = [];
        let length = 0;
        const cancel = (): void => { void reader.cancel().catch(() => {}); };
        controller.signal.addEventListener("abort", cancel, { once: true });
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > responseByteLimit) { cancel(); throw transportError("Solana response exceeded the size limit."); }
            chunks.push(value);
          }
        } finally { controller.signal.removeEventListener("abort", cancel); reader.releaseLock(); }
        throwIfAborted(signal);
        if (controller.signal.aborted) throw transportError("Solana request timed out.");
        let payload: unknown;
        try { payload = parseJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
        catch (error) { throw error instanceof SolanaRpcError ? error : transportError("Solana response did not contain valid JSON."); }
        if (!rpcObject(payload) || payload.jsonrpc !== "2.0" || payload.id !== id) {
          throw transportError("Solana response did not match the requested RPC identity.");
        }
        if (rpcObject(payload.error)) {
          const code = payload.error.code;
          const kind = code === -32601 ? "disabled" : code === -32602 || code === -32600 ? "parameters" : "provider";
          const scope = method === "getAccountInfo" && code === -32601 ? "asset" : "transport";
          throw new SolanaRpcError(`Solana ${provider.name} RPC failed (${typeof code === "number" ? code : "unknown code"}).`, kind, retryAt, scope);
        }
        if (!("result" in payload)) throw transportError("Solana response omitted its result.");
        return payload.result;
      } catch (error) {
        throwIfAborted(signal);
        if (error instanceof SolanaRpcError) throw error;
        throw transportError(controller.signal.aborted ? "Solana request timed out." : "Solana request could not be completed.");
      } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
    }, signal);
  }


  async function verifyMainnet(provider: SolanaProviderState, signal: AbortSignal, deadline: number): Promise<void> {
    if (provider.genesisVerified) return;
    await genesisReads(provider, async sharedSignal => {
      if (provider.genesisVerified) return;
      const genesis = await rpc(provider, "getGenesisHash", [], sharedSignal, deadline);
      if (genesis !== MAINNET_GENESIS_HASH) {
        throw transportError("Solana provider did not identify the mainnet genesis hash.", "disabled");
      }
      provider.genesisVerified = true;
    }, signal);
  }

  // Semantic validation failures (mint/owner/layout/slot) belong to their asset.
  // Actual transport failures and wrong-chain identities affect both assets.
  function createSession() {
    const local = new Map<SolanaProviderState, { failures: number; retryAtMs: number; disabled: boolean }>();
    const state = (provider: SolanaProviderState) => {
      let value = local.get(provider);
      if (!value) { value = { failures: 0, retryAtMs: 0, disabled: false }; local.set(provider, value); }
      return value;
    };
    const enabled = (provider: SolanaProviderState): boolean => !provider.disabled && !state(provider).disabled;
    const eligible = (exclude?: SolanaProviderState): SolanaProviderState | undefined => {
      const ready = (provider: SolanaProviderState): boolean => provider !== exclude && enabled(provider) &&
        Math.max(provider.retryAtMs, state(provider).retryAtMs) <= now();
      if (preferred && ready(preferred)) return preferred;
      return providers.find(ready);
    };
    const nextEligibleAt = (): number | null => {
      const candidates = providers.filter(enabled);
      return candidates.length ? Math.max(now(), budget.nextAt(now()),
        Math.min(...candidates.map(provider => Math.max(provider.retryAtMs, state(provider).retryAtMs)))) : null;
    };
    const failure = (provider: SolanaProviderState, error: SolanaRpcError): void => {
      if (error.kind === "deferred" || error.kind === "parameters") return;
      if (error.scope === "transport") {
        if (handledFailures.has(error)) return;
        handledFailures.add(error);
        provider.healthVersion++;
      }
      const health = error.scope === "transport" ? provider : state(provider);
      if (error.kind === "disabled") { health.disabled = true; return; }
      health.failures++;
      // Retry-After may extend the pause; a short or elapsed header cannot erase
      // the local failure floor or its exponential increase across retries.
      health.retryAtMs = Math.max(health.retryAtMs, error.retryAtMs ?? 0,
        now() + Math.min(900_000, 60_000 * 2 ** Math.min(4, health.failures - 1)));
    };
    const success = (provider: SolanaProviderState, healthVersion: number): void => {
      // Earlier valid batches cannot erase a newer overlapping asset failure.
      if (provider.healthVersion === healthVersion) {
        provider.failures = 0;
        preferred = provider;
      }
      state(provider).failures = 0;
      state(provider).retryAtMs = 0;
    };
    return { eligible, nextEligibleAt, failure, success };
  }
  return { now, rpc, verifyMainnet, createSession, refreshDeadlineMs: Math.min(refreshDeadlineMs, 28_000) };
}
