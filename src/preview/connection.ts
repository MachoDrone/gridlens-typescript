export type ConnectionState = "checking" | "connected" | "unreachable";

export interface ConnectionMonitorOptions {
  url?: string;
  fetch: (url: string, options: RequestInit) => Promise<Response>;
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => unknown;
  clearTimer: (timer: unknown) => void;
  onStateChange: (state: ConnectionState) => void;
  initiallyActive?: boolean;
}

export interface ConnectionMonitor {
  setActive(active: boolean): void;
  checkSoon(): void;
  dispose(): void;
}

const CHECK_TIMEOUT_MS = 8_000;
const CONNECTED_INTERVAL_MS = 15_000;
const UNREACHABLE_INTERVAL_MS = 5_000;
const HINT_MINIMUM_GAP_MS = 1_000;
const MAX_RESPONSE_BYTES = 256;

/** A complete, bounded response is required; headers alone do not prove success. */
async function probeConnection(fetcher: ConnectionMonitorOptions["fetch"], signal: AbortSignal, url: string): Promise<void> {
  const response = await fetcher(url, {
    method: "GET", cache: "no-store", redirect: "error", signal,
    headers: { Accept: "application/json" },
  });
  signal.throwIfAborted();
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const length = response.headers.get("content-length");
  if (response.status !== 200 || response.redirected || contentType !== "application/json" ||
      (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Invalid connection response");
  }
  const reader = response.body.getReader();
  const cancel = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("Connection response too large");
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    const value: unknown = JSON.parse(body);
    if (value === null || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).length !== 1 || !("status" in value) || value.status !== "ok") {
      throw new Error("Invalid connection status");
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

/** Service reachability only: no host readings, upstream providers or scenarios. */
export function startConnectionMonitor(options: ConnectionMonitorOptions): ConnectionMonitor {
  let state: ConnectionState = "checking";
  let active = false;
  let disposed = false;
  let timer: unknown = null;
  let lastStartedAt = -Infinity;
  let inFlight: { cancel: () => void } | null = null;

  function render(next: ConnectionState): void {
    if (state === next) return;
    state = next;
    options.onStateChange(next);
  }

  function clearScheduled(): void {
    if (timer !== null) options.clearTimer(timer);
    timer = null;
  }

  function schedule(delayMs: number): void {
    clearScheduled();
    timer = options.setTimer(() => {
      timer = null;
      void check();
    }, delayMs);
  }

  async function check(): Promise<void> {
    if (!active || disposed || inFlight !== null) return;
    clearScheduled();
    lastStartedAt = options.now();
    const abort = new AbortController();
    let cancelResult = (): void => {};
    const canceled = new Promise<boolean>(resolve => { cancelResult = () => resolve(false); });
    const attempt = { cancel: (): void => { abort.abort(); cancelResult(); } };
    inFlight = attempt;
    const deadline = options.setTimer(attempt.cancel, CHECK_TIMEOUT_MS);
    // The explicit race also settles when a transport or body ignores abort.
    const connected = await Promise.race([
      probeConnection(options.fetch, abort.signal, options.url ?? "/preview/connection.json").then(() => true, () => false), canceled,
    ]);
    options.clearTimer(deadline);
    if (inFlight !== attempt || !active || disposed) return;
    inFlight = null;
    render(connected ? "connected" : "unreachable");
    schedule(connected ? CONNECTED_INTERVAL_MS : UNREACHABLE_INTERVAL_MS);
  }

  function setActive(next: boolean): void {
    if (disposed || active === next) return;
    active = next;
    clearScheduled();
    if (!active) {
      const previous = inFlight;
      inFlight = null;
      previous?.cancel();
      return;
    }
    if (state !== "unreachable") render("checking");
    void check();
  }

  setActive(options.initiallyActive ?? true);
  return {
    setActive,
    checkSoon(): void {
      if (!active || disposed || inFlight !== null) return;
      // Repeated network hints coalesce; they can never establish connectivity.
      schedule(Math.max(0, lastStartedAt + HINT_MINIMUM_GAP_MS - options.now()));
    },
    dispose(): void {
      setActive(false);
      disposed = true;
    },
  };
}

/** Bind the monitor to page lifecycle without changing any data-refresh work. */
export function startConnectionIndicator(element: HTMLElement, url = "/preview/connection.json"): () => void {
  const label = element.querySelector<HTMLElement>("[data-connection-label]");
  if (label === null) throw new Error("Connection indicator label is missing");
  const labels: Record<ConnectionState, string> = {
    checking: "Checking…", connected: "Connected", unreachable: "Data Unreachable",
  };
  const document = element.ownerDocument;
  const window = document.defaultView;
  if (window === null) throw new Error("Connection indicator window is missing");
  const monitor = startConnectionMonitor({
    url,
    fetch: (url, init) => window.fetch(url, init),
    now: () => window.performance.now(),
    setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimer: timer => window.clearTimeout(timer as number),
    initiallyActive: !document.hidden,
    onStateChange(state): void {
      if (element.dataset.connectionState === state) return;
      element.dataset.connectionState = state;
      label.textContent = labels[state];
    },
  });
  let pageHidden = false;
  const visibilityChanged = (): void => monitor.setActive(!pageHidden && !document.hidden);
  const pageHiddenHandler = (): void => { pageHidden = true; visibilityChanged(); };
  const pageShownHandler = (): void => { pageHidden = false; visibilityChanged(); };
  const networkHint = (): void => monitor.checkSoon();
  document.addEventListener("visibilitychange", visibilityChanged);
  window.addEventListener("pagehide", pageHiddenHandler);
  window.addEventListener("pageshow", pageShownHandler);
  window.addEventListener("online", networkHint);
  window.addEventListener("offline", networkHint);
  return () => {
    monitor.dispose();
    document.removeEventListener("visibilitychange", visibilityChanged);
    window.removeEventListener("pagehide", pageHiddenHandler);
    window.removeEventListener("pageshow", pageShownHandler);
    window.removeEventListener("online", networkHint);
    window.removeEventListener("offline", networkHint);
  };
}
