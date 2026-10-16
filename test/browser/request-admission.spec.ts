import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { BROWSER_ASSETS } from "../../src/server/browser-assets.ts";
import { SYNTHETIC_HOST_ADDRESSES as addresses } from "../fixtures/host-addresses.ts";

test("native HTTP/1 admission keeps connection probes reachable and prioritizes queued rosters", async ({ page }) => {
  const hosts = addresses.slice(0, 2);
  const snapshot = { hosts: hosts.map(address => ({ address, values: null, fetchedAtMs: 1_000,
    retained: false, error: null, marketError: null })) };
  const held = new Map<string, ServerResponse>();
  const received: string[] = [];
  const errors: string[] = [];
  const requests: string[] = [];
  let maximumHeld = 0;
  const server = createServer((request, response) => {
    const path = request.url!;
    received.push(path);
    response.setHeader("Cache-Control", "no-store");
    if (path === "/") {
      response.setHeader("Content-Type", "text/html");
      response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'");
      response.end('<!doctype html><title>Isolated HTTP/1 admission test</title><link rel="icon" href="data:,">');
    } else if (path === "/preview/connection.json" || path === "/hosts") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(path === "/hosts" ? { addresses: hosts, error: null } : { status: "ok" }));
    } else if (path.startsWith("/held/")) {
      held.set(path, response);
      maximumHeld = Math.max(maximumHeld, held.size);
      response.writeHead(200, { "Content-Type": "application/x-ndjson" });
      response.write(JSON.stringify({ ...snapshot, complete: false, ...(path.includes("watch") ? { watching: true } : {}) }) + "\n");
      response.once("close", () => held.delete(path));
    } else {
      const asset = BROWSER_ASSETS[path as keyof typeof BROWSER_ASSETS];
      if (!asset || !path.endsWith(".js")) { response.writeHead(404); response.end(); return; }
      response.setHeader("Content-Type", asset[1]);
      response.end(readFileSync(new URL(`../../dist/${asset[0]}`, import.meta.url)));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("Missing isolated HTTP/1 port.");
  const origin = `http://127.0.0.1:${bound.port}`;
  page.on("pageerror", error => errors.push(error.message));
  // Do not intercept requests: native Chromium socket pooling is what this test exercises.
  page.on("request", request => requests.push(request.url()));
  try {
    await page.goto(origin);
    await page.evaluate(async hosts => {
      const transportPath = "/preview/fleet-transport.js", connectionPath = "/preview/connection.js";
      const { createFleetTransport } = await import(transportPath) as typeof import("../../src/preview/fleet-transport.ts");
      const { startConnectionMonitor } = await import(connectionPath) as typeof import("../../src/preview/connection.ts");
      const state = { controllers: [] as AbortController[], connection: "checking", results: [] as Promise<unknown>[],
        monitor: undefined as ReturnType<typeof startConnectionMonitor> | undefined,
        transport: createFleetTransport(),
        startProbe() {
          state.monitor = startConnectionMonitor({ fetch: (url, init) => fetch(url, init), now: () => performance.now(),
            setTimer: (callback, delay) => setTimeout(callback, delay), clearTimer: timer => clearTimeout(timer as number),
            onStateChange: value => { state.connection = value; },
          });
        },
        read(path: string) {
          const controller = new AbortController();
          state.controllers.push(controller);
          state.results.push(state.transport.read("metadata", path, { addresses: hosts, signal: controller.signal }).catch(() => undefined));
        },
      };
      Object.assign(window, { admissionTest: state });
      for (let index = 0; index < 6; index++) state.read(`/held/control-${index}`);
    }, hosts);
    await expect.poll(() => held.size).toBe(6);
    await page.evaluate(() => (window as unknown as { admissionTest: { startProbe(): void } }).admissionTest.startProbe());
    await expect.poll(() => page.evaluate(() => (window as unknown as {
      admissionTest: { connection: string };
    }).admissionTest.connection), { timeout: 12_000 }).toBe("unreachable");
    expect(received).not.toContain("/preview/connection.json");
    const blocked = await page.evaluate(() => performance.getEntriesByType("resource")
      .filter(entry => entry.name.endsWith("/preview/connection.json"))
      .map(entry => ({ requestStart: (entry as PerformanceResourceTiming).requestStart,
        responseStart: (entry as PerformanceResourceTiming).responseStart })));
    expect(blocked).toEqual([{ requestStart: 0, responseStart: 0 }]);

    await page.evaluate(async () => {
      const state = (window as unknown as { admissionTest: { controllers: AbortController[]; results: Promise<unknown>[];
        monitor: { dispose(): void }; connection: string; transport: unknown; read(path: string): void } }).admissionTest;
      state.monitor.dispose();
      state.controllers.forEach(controller => controller.abort());
      await Promise.all(state.results);
      state.controllers = []; state.results = []; state.connection = "checking";
      const path = "/preview/fleet-transport.js";
      const { createFleetTransport } = await import(path) as typeof import("../../src/preview/fleet-transport.ts");
      state.transport = createFleetTransport({ maximumConcurrentRequests: 5 });
    });
    await expect.poll(() => held.size).toBe(0);
    received.length = 0;
    maximumHeld = 0;
    await page.evaluate(() => {
      const state = (window as unknown as { admissionTest: { read(path: string): void; results: Promise<unknown>[];
        transport: { roster(path: string): Promise<unknown> }; startProbe(): void } }).admissionTest;
      for (let index = 0; index < 3; index++) state.read(`/held/watch-${index}`);
      for (let index = 0; index < 4; index++) state.read(`/held/finite-${index}`);
      state.results.push(state.transport.roster("/hosts"));
      state.startProbe();
    });
    await expect.poll(() => held.size).toBe(5);
    await expect.poll(() => page.evaluate(() => (window as unknown as {
      admissionTest: { connection: string };
    }).admissionTest.connection)).toBe("connected");
    expect(received.filter(path => path.startsWith("/held/"))).toHaveLength(5);
    expect(received).not.toContain("/hosts");
    expect(maximumHeld).toBe(5);

    held.get("/held/finite-0")!.end(JSON.stringify({ ...snapshot, complete: true }) + "\n");
    await expect.poll(() => received.includes("/held/finite-2")).toBe(true);
    expect(received.indexOf("/hosts")).toBeLessThan(received.indexOf("/held/finite-2"));
    expect(received.indexOf("/hosts")).toBeGreaterThan(-1);
    expect(received).not.toContain("/held/finite-3");
    expect(maximumHeld).toBe(5);
    expect(requests.every(url => new URL(url).origin === origin)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
