import assert from "node:assert/strict";
import { test } from "node:test";
import { startConnectionIndicator, startConnectionMonitor } from "../src/preview/connection.ts";
import type { ConnectionState } from "../src/preview/connection.ts";

async function settle(): Promise<void> {
  for (let index = 0; index < 30; index++) await Promise.resolve();
}

class Clock {
  now = 0;
  sequence = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  setTimer = (callback: () => void, delayMs: number): number => {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.now + delayMs, callback });
    return id;
  };
  clearTimer = (timer: unknown): void => { this.timers.delete(timer as number); };
  async advance(milliseconds: number): Promise<void> {
    const target = this.now + milliseconds;
    await settle();
    for (let count = 0; count < 200; count++) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (due === undefined) { this.now = target; await settle(); return; }
      this.now = due[1].at;
      this.timers.delete(due[0]);
      due[1].callback();
      await settle();
    }
    assert.fail("Timer loop did not settle");
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function transport(clock: Clock) {
  const requests: { url: string; options: RequestInit; at: number; response: ReturnType<typeof deferred<Response>> }[] = [];
  return {
    requests,
    fetch: (url: string, options: RequestInit): Promise<Response> => {
      const response = deferred<Response>();
      requests.push({ url, options, at: clock.now, response });
      return response.promise;
    },
  };
}

function harness(initiallyActive = true) {
  const clock = new Clock();
  const network = transport(clock);
  const changes: ConnectionState[] = [];
  const monitor = startConnectionMonitor({
    fetch: network.fetch, now: () => clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    onStateChange: state => changes.push(state), initiallyActive,
  });
  return { clock, ...network, changes, monitor };
}

function ok(): Response {
  return Response.json({ status: "ok" });
}

test("connection checks require a complete response and repeat 15 seconds after success", async () => {
  const h = harness();
  assert.deepEqual(h.changes, []);
  assert.equal(h.requests.length, 1);
  const request = h.requests[0]!;
  assert.equal(request.url, "/preview/connection.json");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.cache, "no-store");
  assert.equal(request.options.redirect, "error");
  assert.deepEqual(request.options.headers, { Accept: "application/json" });
  await h.clock.advance(1_000);
  request.response.resolve(ok());
  await settle();
  assert.deepEqual(h.changes, ["connected"]);
  await h.clock.advance(14_999);
  assert.equal(h.requests.length, 1);
  await h.clock.advance(1);
  assert.equal(h.requests.length, 2);
  h.requests[1]!.response.resolve(ok());
  await settle();
  assert.deepEqual(h.changes, ["connected"], "unchanged success must not repeat live announcements");
  h.monitor.dispose();
  await settle();
  assert.equal(h.clock.timers.size, 0);
});

test("network failures retry after five seconds and retain red until actual recovery", async () => {
  const h = harness();
  h.requests[0]!.response.reject(new TypeError("Network unavailable"));
  await settle();
  assert.deepEqual(h.changes, ["unreachable"]);
  await h.clock.advance(4_999);
  assert.equal(h.requests.length, 1);
  await h.clock.advance(1);
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.changes, ["unreachable"]);
  h.requests[1]!.response.resolve(ok());
  await settle();
  assert.deepEqual(h.changes, ["unreachable", "connected"]);
  h.monitor.dispose();
});

test("HTTP, redirect, content type, malformed and oversized responses cannot establish connectivity", async () => {
  const redirected = ok();
  Object.defineProperty(redirected, "redirected", { value: true });
  const cases = [
    new Response("unavailable", { status: 503 }),
    new Response(null, { status: 204 }),
    new Response('{"status":"ok"}', { status: 302, headers: { "content-type": "application/json" } }),
    new Response('{"status":"ok"}', { headers: { "content-type": "text/html" } }),
    new Response('{"status":', { headers: { "content-type": "application/json" } }),
    Response.json({ status: "ok", extra: "unexpected" }),
    Response.json({ status: "unavailable" }), Response.json(["ok"]), Response.json(null),
    new Response('{"status":"ok"}', { headers: { "content-type": "application/json", "content-length": "257" } }),
    new Response(`${" ".repeat(256)}{"status":"ok"}`, { headers: { "content-type": "application/json" } }),
    new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }),
    redirected,
  ];
  for (const response of cases) {
    const h = harness();
    h.requests[0]!.response.resolve(response);
    await settle();
    assert.deepEqual(h.changes, ["unreachable"]);
    h.monitor.dispose();
  }
});

test("eight-second deadline settles even if fetch ignores abort; late success stays discarded", async () => {
  const h = harness();
  await h.clock.advance(7_999);
  assert.deepEqual(h.changes, []);
  await h.clock.advance(1);
  assert.deepEqual(h.changes, ["unreachable"]);
  assert.equal(h.requests[0]!.options.signal!.aborted, true);
  await h.clock.advance(5_000);
  assert.equal(h.requests.length, 2, "timeout must release the in-flight slot");
  h.requests[0]!.response.resolve(ok());
  await settle();
  assert.deepEqual(h.changes, ["unreachable"]);
  h.requests[1]!.response.resolve(ok());
  await settle();
  assert.deepEqual(h.changes, ["unreachable", "connected"]);
  h.monitor.dispose();
});

test("valid headers and JSON bytes without the completed body remain checking and time out", async () => {
  const h = harness();
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller): void { controller.enqueue(new TextEncoder().encode('{"status":"ok"}')); },
    cancel(): void { canceled = true; },
  });
  h.requests[0]!.response.resolve(new Response(body, { headers: { "content-type": "application/json" } }));
  await settle();
  assert.deepEqual(h.changes, []);
  await h.clock.advance(8_000);
  assert.deepEqual(h.changes, ["unreachable"]);
  assert.equal(canceled, true);
  await h.clock.advance(5_000);
  assert.equal(h.requests.length, 2);
  h.monitor.dispose();
});

test("body size is bounded across chunks even without a trustworthy content length", async () => {
  const h = harness();
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(new Uint8Array(128));
      controller.enqueue(new Uint8Array(129));
    },
    cancel(): void { canceled = true; },
  });
  h.requests[0]!.response.resolve(new Response(body, { headers: { "content-type": "application/json", "content-length": "17" } }));
  await settle();
  assert.deepEqual(h.changes, ["unreachable"]);
  assert.equal(canceled, true);
  h.monitor.dispose();
});

test("network event hints coalesce, never create concurrent checks and do not imply success", async () => {
  const h = harness();
  for (let index = 0; index < 100; index++) h.monitor.checkSoon();
  assert.equal(h.requests.length, 1);
  h.requests[0]!.response.reject(new Error("offline"));
  await settle();
  for (let index = 0; index < 100; index++) h.monitor.checkSoon();
  await h.clock.advance(999);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.changes, ["unreachable"]);
  await h.clock.advance(1);
  assert.equal(h.requests.length, 2);
  for (let index = 0; index < 100; index++) h.monitor.checkSoon();
  h.requests[1]!.response.reject(new Error("still offline"));
  await settle();
  assert.deepEqual(h.changes, ["unreachable"]);
  await h.clock.advance(4_999);
  assert.equal(h.requests.length, 2);
  await h.clock.advance(1);
  assert.equal(h.requests.length, 3);
  h.monitor.dispose();
});

test("inactive startup does not fetch; hiding cancels and returning rechecks connected state", async () => {
  const h = harness(false);
  await h.clock.advance(60_000);
  h.monitor.checkSoon();
  assert.equal(h.requests.length, 0);
  h.monitor.setActive(true);
  assert.equal(h.requests.length, 1);
  h.requests[0]!.response.resolve(ok());
  await settle();
  h.monitor.setActive(false);
  await h.clock.advance(60_000);
  assert.equal(h.requests.length, 1);
  h.monitor.setActive(true);
  assert.deepEqual(h.changes, ["connected", "checking"]);
  assert.equal(h.requests.length, 2);
  h.monitor.setActive(true);
  assert.equal(h.requests.length, 2);
  h.requests[1]!.response.resolve(ok());
  await settle();
  assert.deepEqual(h.changes, ["connected", "checking", "connected"]);
  h.monitor.dispose();
});

test("returning preserves a previous red indicator while rechecking", async () => {
  const h = harness();
  h.requests[0]!.response.reject(new Error("unreachable"));
  await settle();
  h.monitor.setActive(false);
  await h.clock.advance(60_000);
  h.monitor.setActive(true);
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.changes, ["unreachable"]);
  h.requests[1]!.response.resolve(ok());
  await settle();
  assert.deepEqual(h.changes, ["unreachable", "connected"]);
  h.monitor.dispose();
});

test("canceled checks cannot overwrite a resumed result and disposal stops future work", async () => {
  const h = harness();
  h.monitor.setActive(false);
  assert.equal(h.requests[0]!.options.signal!.aborted, true);
  h.monitor.setActive(true);
  assert.equal(h.requests.length, 2);
  h.requests[1]!.response.resolve(ok());
  await settle();
  h.requests[0]!.response.reject(new Error("late canceled failure"));
  await settle();
  assert.deepEqual(h.changes, ["connected"]);
  h.monitor.dispose();
  h.monitor.setActive(true);
  h.monitor.checkSoon();
  await h.clock.advance(60_000);
  assert.equal(h.requests.length, 2);
  assert.equal(h.clock.timers.size, 0);
});

test("DOM lifecycle binding pauses pagehide, handles visibility and updates text only on transitions", async () => {
  const clock = new Clock();
  const network = transport(clock);
  const window = Object.assign(new EventTarget(), {
    fetch: network.fetch, performance: { now: () => clock.now },
    setTimeout: clock.setTimer, clearTimeout: clock.clearTimer,
  });
  const document = Object.assign(new EventTarget(), { hidden: false, defaultView: window });
  const labels: string[] = [];
  const element = {
    ownerDocument: document, dataset: { connectionState: "checking" },
    querySelector: () => ({ set textContent(value: string) { labels.push(value); } }),
  };
  const stop = startConnectionIndicator(element as unknown as HTMLElement);
  network.requests[0]!.response.resolve(ok());
  await settle();
  assert.equal(element.dataset.connectionState, "connected");
  assert.deepEqual(labels, ["Connected"]);
  window.dispatchEvent(new Event("pagehide"));
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("online"));
  await clock.advance(60_000);
  assert.equal(network.requests.length, 1, "visibility hints cannot reactivate pagehide");
  window.dispatchEvent(new Event("pageshow"));
  assert.equal(network.requests.length, 2);
  assert.deepEqual(labels, ["Connected", "Checking…"]);
  network.requests[1]!.response.reject(new Error("disconnected"));
  await settle();
  assert.equal(element.dataset.connectionState, "unreachable");
  assert.deepEqual(labels, ["Connected", "Checking…", "Data Unreachable"]);
  document.hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("pageshow"));
  await clock.advance(60_000);
  assert.equal(network.requests.length, 2, "pageshow does not override document.hidden");
  document.hidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(network.requests.length, 3);
  assert.equal(element.dataset.connectionState, "unreachable");
  network.requests[2]!.response.resolve(ok());
  await settle();
  window.dispatchEvent(new Event("offline"));
  await clock.advance(1_000);
  assert.equal(network.requests.length, 4);
  assert.equal(element.dataset.connectionState, "connected", "offline event alone is not a failed probe");
  network.requests[3]!.response.resolve(ok());
  await settle();
  assert.deepEqual(labels, ["Connected", "Checking…", "Data Unreachable", "Connected"]);
  stop();
  window.dispatchEvent(new Event("pagehide"));
  window.dispatchEvent(new Event("pageshow"));
  window.dispatchEvent(new Event("online"));
  window.dispatchEvent(new Event("offline"));
  document.dispatchEvent(new Event("visibilitychange"));
  await clock.advance(60_000);
  assert.equal(network.requests.length, 4);
  assert.equal(clock.timers.size, 0);
});
