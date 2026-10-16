import { randomUUID } from "node:crypto";
import { isMetadataAddress } from "../src/fleet/host-metadata.ts";
import type { OnlineHostsSnapshot } from "../src/contracts/online-hosts.ts";
import { createSharedRead, throwIfAborted } from "./shared-read.ts";

const queuedUrl = "https://blockchain-indexer.k8s.prd.nos.ci/markets/queued-nodes";
const runningUrl = "https://blockchain-indexer.k8s.prd.nos.ci/markets/running-nodes";
const responseByteLimit = 4 * 1024 * 1024;
const rosterLimit = 10_000;
const refreshMs = 60_000;
const maximumBackoffMs = 15 * 60_000;
const maximumTimestamp = 8_640_000_000_000_000;

export interface OnlineHostsProvider {
  read(signal?: AbortSignal): Promise<OnlineHostsSnapshot>;
  peek(): OnlineHostsSnapshot;
}

class DiscoveryError extends Error {
  retryAtMs: number;
  constructor(message: string, retryAtMs = 0) { super(message); this.retryAtMs = retryAtMs; }
}

function retryAt(response: Response, now: number): number {
  const retry = response.headers.get("retry-after")?.trim();
  if (!retry) return 0;
  const seconds = /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) : NaN;
  const until = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(retry);
  return Number.isFinite(until) ? Math.max(0, Math.min(maximumTimestamp, Math.ceil(until))) : 0;
}

function roster(queued: unknown, running: unknown): Set<string> {
  if (!Array.isArray(queued) || !Array.isArray(running)
    || queued.length > rosterLimit || running.length > rosterLimit) {
    throw new DiscoveryError("Nosana host discovery returned an invalid or oversized roster.");
  }
  const addresses = new Set<string>();
  const markets = new Map<string, { nodes: Set<string>; positions: Set<number> }>();
  for (const entry of queued) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new DiscoveryError("Nosana queued-host discovery returned an invalid entry.");
    }
    const { marketAddress, nodeAddress, position } = entry as Record<string, unknown>;
    if (!isMetadataAddress(marketAddress) || !isMetadataAddress(nodeAddress)
      || typeof position !== "number" || !Number.isSafeInteger(position) || position < 0) {
      throw new DiscoveryError("Nosana queued-host discovery returned an invalid entry.");
    }
    const market = markets.get(marketAddress) ?? { nodes: new Set<string>(), positions: new Set<number>() };
    if (market.nodes.has(nodeAddress) || market.positions.has(position)) {
      throw new DiscoveryError("Nosana queued-host discovery returned duplicate queue entries.");
    }
    market.nodes.add(nodeAddress);
    market.positions.add(position);
    markets.set(marketAddress, market);
    addresses.add(nodeAddress);
  }
  for (const { positions } of markets.values()) {
    if ([...positions].some(position => position >= positions.size)) {
      throw new DiscoveryError("Nosana queued-host discovery returned an incomplete queue.");
    }
  }
  const runningAddresses = new Set<string>();
  for (const address of running) {
    if (!isMetadataAddress(address) || runningAddresses.has(address)) {
      throw new DiscoveryError("Nosana running-host discovery returned invalid or duplicate addresses.");
    }
    runningAddresses.add(address);
    addresses.add(address);
  }
  if (addresses.size > rosterLimit) {
    throw new DiscoveryError("Nosana host discovery exceeded the roster capacity.");
  }
  return addresses;
}

/** A demand-only, process-wide roster source; no host files or individual nodes are read. */
export function createOnlineHostsProvider({ fetch: fetcher = globalThis.fetch, now = Date.now,
  timeoutMs = 8_000, admit = () => true }: {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  timeoutMs?: number;
  admit?: (addresses: readonly string[]) => boolean;
} = {}): OnlineHostsProvider {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Invalid discovery timeout.");
  let snapshot: OnlineHostsSnapshot = {
    addresses: [], error: null,
    online: { revision: null, checkedAtMs: null, nextRefreshAtMs: 0, retained: false, discoveryError: null },
  };
  let failures = 0;
  let absences = new Map<string, number>();
  const shared = createSharedRead<string, OnlineHostsSnapshot>();
  const copy = (): OnlineHostsSnapshot => ({ ...snapshot, addresses: [...snapshot.addresses], online: { ...snapshot.online } });

  async function json(url: typeof queuedUrl | typeof runningUrl, signal: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let onAbort = (): void => {};
    try {
      // Race the deadline as well as passing the signal: an injected fetch or
      // stalled body must not keep the shared operation alive indefinitely.
      const canceled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(combined.reason);
        combined.addEventListener("abort", onAbort, { once: true });
        if (combined.aborted) onAbort();
      });
      const response = await Promise.race([fetcher(url, {
        method: "GET", headers: { Accept: "application/json" }, credentials: "omit", redirect: "error", signal: combined,
      }), canceled]);
      throwIfAborted(combined);
      if (!response.ok || response.redirected) {
        void response.body?.cancel().catch(() => {});
        throw new DiscoveryError(`Nosana host discovery failed (HTTP ${response.status}).`, retryAt(response, now()));
      }
      if (Number(response.headers.get("content-length")) > responseByteLimit) {
        void response.body?.cancel().catch(() => {});
        throw new DiscoveryError("Nosana host discovery response exceeded the size limit.");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new DiscoveryError("Nosana host discovery did not return valid JSON.");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const { value, done } = await Promise.race([reader.read(), canceled]);
          throwIfAborted(combined);
          if (done) break;
          bytes += value.byteLength;
          if (bytes > responseByteLimit) throw new DiscoveryError("Nosana host discovery response exceeded the size limit.");
          chunks.push(value);
        }
      } catch (error) {
        void reader.cancel().catch(() => {});
        throw error;
      } finally { reader.releaseLock(); }
      try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw new DiscoveryError("Nosana host discovery did not return valid JSON."); }
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof DiscoveryError) throw error;
      throw new DiscoveryError(controller.signal.aborted
        ? "Nosana host discovery timed out." : "Nosana host discovery could not be completed.");
    } finally {
      clearTimeout(timer);
      combined.removeEventListener("abort", onAbort);
    }
  }

  async function refresh(signal: AbortSignal): Promise<OnlineHostsSnapshot> {
    try {
      const results = await Promise.allSettled([json(queuedUrl, signal), json(runningUrl, signal)]);
      throwIfAborted(signal);
      const errors = results.filter(result => result.status === "rejected");
      if (errors.length) {
        const error = errors[0]!.reason;
        throw new DiscoveryError(error instanceof DiscoveryError ? error.message : "Nosana host discovery failed.",
          Math.max(0, ...errors.map(result => result.reason instanceof DiscoveryError ? result.reason.retryAtMs : 0)));
      }
      const queued = results[0]!;
      const running = results[1]!;
      if (queued.status !== "fulfilled" || running.status !== "fulfilled") throw new DiscoveryError("Nosana host discovery failed.");
      const discovered = roster(queued.value, running.value);
      const nextAbsences = new Map<string, number>();
      const addresses = snapshot.addresses.filter(address => {
        if (discovered.has(address)) return true;
        const count = (absences.get(address) ?? 0) + 1;
        if (count < 2) { nextAbsences.set(address, count); return true; }
        return false;
      });
      const previous = new Set(snapshot.addresses);
      addresses.push(...[...discovered].filter(address => !previous.has(address)).sort());
      if (addresses.length > rosterLimit) throw new DiscoveryError("Nosana host discovery exceeded the roster capacity.");
      const changed = snapshot.online.revision === null || addresses.length !== snapshot.addresses.length
        || addresses.some((address, index) => address !== snapshot.addresses[index]);
      if (changed && !admit(Object.freeze([...addresses]))) {
        throw new DiscoveryError("Online GPU Hosts could not fit within the shared preview cache capacity.");
      }
      throwIfAborted(signal);
      const checkedAtMs = now();
      snapshot = {
        addresses, error: null,
        online: { revision: changed ? randomUUID() : snapshot.online.revision, checkedAtMs,
          nextRefreshAtMs: Math.min(maximumTimestamp, checkedAtMs + refreshMs), retained: false, discoveryError: null },
      };
      absences = nextAbsences;
      failures = 0;
    } catch (error) {
      throwIfAborted(signal);
      failures++;
      const message = error instanceof DiscoveryError ? error.message : "Nosana host discovery failed.";
      const backoff = Math.min(maximumBackoffMs, refreshMs * 2 ** Math.min(failures - 1, 4));
      snapshot = { ...snapshot, error: snapshot.online.revision === null ? message : null,
        online: { ...snapshot.online, retained: snapshot.online.revision !== null, discoveryError: message,
          nextRefreshAtMs: Math.min(maximumTimestamp, Math.max(now() + backoff,
            error instanceof DiscoveryError ? error.retryAtMs : 0)) } };
    }
    return snapshot;
  }

  return {
    async read(signal) {
      throwIfAborted(signal);
      if (now() >= snapshot.online.nextRefreshAtMs) await shared("online", refresh, signal);
      throwIfAborted(signal);
      return copy();
    },
    peek: copy,
  };
}
