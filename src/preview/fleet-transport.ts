import { createFleetSnapshotValidator, isFleetRoster } from "../contracts/fleet.ts";
import type { FleetResource, FleetSnapshots } from "../contracts/fleet.ts";
import { isServerTimeMs } from "./evidence-clock.ts";
import { isOnlineRosterStatus } from "../contracts/online-hosts.ts";
import type { OnlineRosterStatus } from "../contracts/online-hosts.ts";
import { JOB_HISTORY_REQUEST_LIMIT } from "../fleet/job-history.ts";

type Timer = unknown;
export interface FleetTransportOptions {
  fetch?: typeof globalThis.fetch;
  /** Per-page dispatched reads, held through body completion. Unbounded by default. */
  maximumConcurrentRequests?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  /** Includes response headers, body and finite stream completion. */
  finiteTimeoutMs?: number;
  /** Metadata normally emits only once per five-minute refresh. */
  watchIdleTimeoutMs?: number;
  responseByteLimit?: number;
  frameByteLimit?: number;
  /** Accepted server emission time plus this request's elapsed dispatch-to-frame time. */
  onServerTime?: (serverTimeMs: number, requestElapsedMs: number) => void;
  onRosterMismatch?: () => void;
}
export class FleetTransportError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) { super(message); this.name = "FleetTransportError"; this.status = status; }
}
export function fleetReadError(error: unknown, fallback: string): string {
  return error instanceof FleetTransportError && (error.status === 401 || error.status === 403)
    ? "Fleet access is unavailable. Your current session is not authorized to read this fleet." : fallback;
}

interface ReadOptions<R extends FleetResource> {
  addresses: readonly string[];
  /** Explicit history selection; the server still verifies the authorized roster. */
  hosts?: readonly string[];
  refresh?: boolean;
  signal?: AbortSignal;
  current?: () => boolean;
  onSnapshot?: (snapshot: FleetSnapshots[R], complete: boolean, envelope: Record<string, unknown>) => void;
  progressive?: boolean;
  onlineRevision?: string;
}
export interface FleetRosterSnapshot { addresses: string[]; error: string | null; online?: OnlineRosterStatus }

/** Leave socket capacity for the independent connection probe on large HTTP/1 views. */
function createRequestAdmission(maximum: number) {
  let active = 0;
  const queued: { priority: boolean; signal: AbortSignal; cancel: () => void;
    resolve: (release: () => void) => void; reject: (reason: unknown) => void }[] = [];
  const drain = (): void => {
    while (active < maximum && queued.length) {
      const priority = queued.findIndex(entry => entry.priority);
      const entry = queued.splice(priority < 0 ? 0 : priority, 1)[0]!;
      entry.signal.removeEventListener("abort", entry.cancel);
      if (entry.signal.aborted) { entry.reject(entry.signal.reason); continue; }
      active++;
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        active--;
        drain();
      });
    }
  };
  return (signal: AbortSignal, priority: boolean): Promise<() => void> => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const entry = { priority, signal, resolve, reject, cancel: (): void => {
      const index = queued.indexOf(entry);
      if (index < 0) return;
      queued.splice(index, 1);
      reject(signal.reason);
    } };
    queued.push(entry);
    signal.addEventListener("abort", entry.cancel, { once: true });
    drain();
  });
}

/** One bounded browser transport; provider adapters and domain projections stay separate. */
export function createFleetTransport(options: FleetTransportOptions = {}) {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? (() => performance.now());
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const finiteTimeout = options.finiteTimeoutMs ?? 120_000;
  const idleTimeout = options.watchIdleTimeoutMs ?? 360_000;
  const responseLimit = options.responseByteLimit ?? 16 * 1024 * 1024;
  const frameLimit = options.frameByteLimit ?? 2 * 1024 * 1024;
  // Online discovery can produce a network-wide cohort. Its bounded full-frame
  // replay needs more room than a fixed fleet; the total body cap is unchanged.
  const onlineFrameLimit = Math.min(responseLimit, options.frameByteLimit ?? 8 * 1024 * 1024);
  const maximumRequests = options.maximumConcurrentRequests ?? Infinity;
  if (maximumRequests !== Infinity && (!Number.isSafeInteger(maximumRequests) || maximumRequests < 1)) {
    throw new Error("Fleet request concurrency must be a positive integer or Infinity.");
  }
  const admit = maximumRequests === Infinity ? undefined : createRequestAdmission(maximumRequests);
  for (const limit of [finiteTimeout, idleTimeout, responseLimit, frameLimit]) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Fleet transport limits must be positive integers.");
  }
  const acceptServerTime = (payload: Record<string, unknown>, requestElapsedMs: () => number): void => {
    if (!("serverTimeMs" in payload)) return;
    if (!isServerTimeMs(payload.serverTimeMs)) throw new FleetTransportError("Fleet response contained an invalid server time.");
    const elapsed = requestElapsedMs();
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 8_640_000_000_000_000) {
      throw new FleetTransportError("Fleet response contained invalid elapsed timing.");
    }
    options.onServerTime?.(payload.serverTimeMs, elapsed);
  };

  async function request<T>(url: string, external: AbortSignal | undefined, current: (() => boolean) | undefined,
    progressive: boolean, consume: (response: Response, control: {
      wait: <V>(pending: Promise<V>) => Promise<V>; check: () => void; watch: () => void; progress: () => void;
      requestElapsedMs: () => number;
    }) => Promise<T>, rosterFailure = false): Promise<T> {
    if (!/^\/(?!\/)/.test(url) || /[\\#\u0000-\u0020]/.test(url)) {
      throw new FleetTransportError("Fleet requests require a same-origin path.");
    }
    const abort = new AbortController();
    let rejectCanceled!: (reason: unknown) => void;
    const canceled = new Promise<never>((_resolve, reject) => { rejectCanceled = reject; });
    void canceled.catch(() => {});
    let timer: Timer;
    let watching = false;
    const stop = (reason: unknown): void => { abort.abort(reason); rejectCanceled(reason); };
    const cancel = (): void => stop(external?.reason ?? new DOMException("Fleet read canceled.", "AbortError"));
    const timeout = (): void => stop(new FleetTransportError("Fleet response timed out."));
    const schedule = (ms: number): void => { if (timer !== undefined) clearTimer(timer); timer = setTimer(timeout, ms); };
    const check = (): void => {
      abort.signal.throwIfAborted();
      if (current && !current()) throw new DOMException("Fleet read is no longer active.", "AbortError");
    };
    const wait = <V>(pending: Promise<V>): Promise<V> => Promise.race([pending, canceled]);
    if (external?.aborted) cancel();
    else external?.addEventListener("abort", cancel, { once: true });
    let response: Response | undefined;
    let completed = false;
    let release: (() => void) | undefined;
    try {
      check();
      if (admit) release = await admit(abort.signal, rosterFailure);
      // A revision or page lifecycle can change while waiting for a socket slot.
      check();
      schedule(finiteTimeout);
      const dispatchedAt = now();
      response = await wait(fetcher(url, { method: "GET", cache: "no-store", redirect: "error",
        credentials: "same-origin", signal: abort.signal,
        headers: { Accept: progressive ? "application/x-ndjson, application/json" : "application/json" } }));
      check();
      if (response.redirected || !response.ok && (!rosterFailure || response.status === 401 || response.status === 403)) {
        throw new FleetTransportError(`Fleet request failed (HTTP ${response.status}).`, response.status);
      }
      const value = await consume(response, { wait, check,
        watch: () => { watching = true; schedule(idleTimeout); },
        progress: () => { if (watching) schedule(idleTimeout); },
        requestElapsedMs: () => now() - dispatchedAt,
      });
      completed = true;
      return value;
    } finally {
      if (timer !== undefined) clearTimer(timer);
      external?.removeEventListener("abort", cancel);
      // Successful EOF already releases the transport. Only unfinished or
      // rejected work is canceled; a completed feed must not appear aborted.
      if (!completed) {
        abort.abort();
        if (!response?.body?.locked) void response?.body?.cancel().catch(() => {});
      }
      release?.();
    }
  }

  async function parse(response: Response, control: {
    wait: <V>(pending: Promise<V>) => Promise<V>; check: () => void; watch: () => void; progress: () => void;
  }, allowStream: boolean, accept: (value: unknown, streaming: boolean) => boolean,
  hostCount: number, maximumFrameBytes = frameLimit): Promise<void> {
    const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    const streaming = type === "application/x-ndjson";
    if (streaming && !allowStream || !streaming && type !== "application/json") throw new FleetTransportError("Fleet response has an unsupported content type.");
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > responseLimit)) {
      throw new FleetTransportError("Fleet response exceeded its size limit.");
    }
    if (!response.body) throw new FleetTransportError("Fleet response body is missing.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const encoder = new TextEncoder();
    let buffer = "";
    let bytes = 0;
    let frames = 0;
    let watching = false;
    let reachedEOF = false;
    let accountingAt = now();
    const line = (value: string): void => {
      if (!value.trim()) return;
      const maximumFrames = watching ? hostCount * 20 + 20 : hostCount * 10 + 10;
      if (++frames > maximumFrames || encoder.encode(value).byteLength > maximumFrameBytes) {
        throw new FleetTransportError("Fleet stream exceeded its frame limit.");
      }
      const payload: unknown = JSON.parse(value);
      const becameWatch = accept(payload, true);
      if (becameWatch && !watching) { watching = true; control.watch(); }
      control.progress();
    };
    try {
      for (;;) {
        control.check();
        const chunk = await control.wait(reader.read());
        control.check();
        if (chunk.done) { reachedEOF = true; break; }
        if (watching && now() - accountingAt >= 60_000) { accountingAt = now(); bytes = 0; frames = 0; }
        bytes += chunk.value.byteLength;
        if (bytes > responseLimit) throw new FleetTransportError("Fleet response exceeded its size limit.");
        buffer += decoder.decode(chunk.value, { stream: true });
        if (streaming) {
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) { line(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
          if (encoder.encode(buffer).byteLength > maximumFrameBytes) throw new FleetTransportError("Fleet stream exceeded its frame limit.");
        }
      }
      buffer += decoder.decode();
      if (streaming) line(buffer);
      else accept(JSON.parse(buffer), false);
    } finally {
      // Never await an uncooperative producer's cancellation promise.
      if (!reachedEOF) void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  return {
    async read<R extends FleetResource>(resource: R, url: string, readOptions: ReadOptions<R>): Promise<FleetSnapshots[R]> {
      if (!isFleetRoster(readOptions.addresses)) throw new FleetTransportError("Fleet roster identities are invalid.");
      if (readOptions.hosts !== undefined || readOptions.refresh !== undefined) {
        const hosts = readOptions.hosts;
        if (resource !== "job-history" || !hosts || !isFleetRoster(hosts) || hosts.length === 0 ||
            hosts.length > JOB_HISTORY_REQUEST_LIMIT || hosts.length !== readOptions.addresses.length ||
            hosts.some((address, index) => address !== readOptions.addresses[index])) {
          throw new FleetTransportError("Job history requires a bounded selection of the expected hosts.");
        }
        const parameters = new URLSearchParams();
        for (const address of hosts) parameters.append("host", address);
        if (readOptions.refresh) parameters.set("refresh", "1");
        url += `${url.includes("?") ? "&" : "?"}${parameters}`;
      }
      const validSnapshot = createFleetSnapshotValidator(readOptions.addresses);
      return request(url, readOptions.signal, readOptions.current, readOptions.progressive ?? true, async (response, control) => {
        let final: FleetSnapshots[R] | undefined;
        let completed = false;
        await parse(response, control, readOptions.progressive ?? true, (value, streaming) => {
          control.check();
          const payload = value as Record<string, unknown>;
          if (readOptions.onlineRevision !== undefined && payload?.onlineRevision !== readOptions.onlineRevision) {
            throw new FleetTransportError("Online GPU host membership changed.", 409);
          }
          const complete = streaming ? payload?.complete : true;
          if (completed || typeof complete !== "boolean" || !validSnapshot(resource, value, complete)) {
            throw new FleetTransportError("Fleet response contained invalid observations or identities.");
          }
          if (payload.failed === true) throw new FleetTransportError("Fleet source could not complete its response.");
          acceptServerTime(payload, control.requestElapsedMs);
          readOptions.onSnapshot?.(value, complete, payload);
          completed = complete;
          if (complete) final = value;
          return payload.watching === true;
        }, readOptions.addresses.length, readOptions.onlineRevision === undefined ? frameLimit : onlineFrameLimit);
        if (!completed || !final) throw new FleetTransportError("Fleet stream ended before its final snapshot.");
        return final;
      }).catch((error: unknown) => {
        if (readOptions.onlineRevision !== undefined && error instanceof FleetTransportError && error.status === 409 &&
            !readOptions.signal?.aborted && (!readOptions.current || readOptions.current())) options.onRosterMismatch?.();
        throw error;
      });
    },
    async roster(url: string, signal?: AbortSignal): Promise<FleetRosterSnapshot> {
      return request(url, signal, undefined, false, async (response, control) => {
        let roster: FleetRosterSnapshot | undefined;
        await parse(response, control, false, value => {
          if (!value || typeof value !== "object" || !("addresses" in value) || !isFleetRoster(value.addresses) ||
              !("error" in value) || value.error !== null && (typeof value.error !== "string" || value.error.length > 1024)) {
            throw new FleetTransportError("Fleet host roster is invalid.");
          }
          roster = { addresses: value.addresses, error: value.error };
          if ("online" in value) {
            if (!isOnlineRosterStatus(value.online) ||
                (value.error === null) !== (value.online.revision !== null) ||
                value.error !== null && value.addresses.length !== 0) {
              throw new FleetTransportError("Online GPU host roster status is invalid.");
            }
            const { revision, checkedAtMs, nextRefreshAtMs, retained, discoveryError } = value.online;
            roster.online = { revision, checkedAtMs, nextRefreshAtMs, retained, discoveryError };
          }
          if (!response.ok && roster.error === null) throw new FleetTransportError(`Fleet request failed (HTTP ${response.status}).`, response.status);
          control.check();
          if (response.ok && roster.error === null) acceptServerTime(value, control.requestElapsedMs);
          else if ("serverTimeMs" in value && !isServerTimeMs(value.serverTimeMs)) {
            throw new FleetTransportError("Fleet response contained an invalid server time.");
          }
          return false;
        }, 0);
        return roster!;
      }, true);
    },
  };
}
