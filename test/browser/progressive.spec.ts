import { openPreviewTools } from "./helpers.ts";
import { emptyStaking } from "../fixtures/staking.ts";
import { emptyNos } from "../fixtures/nos.ts";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPreviewServer } from "../../scripts/preview-server.ts";
import type { HostMetadataRecord } from "../../src/fleet/host-metadata.ts";
import type { NodeInfoRecord } from "../../src/fleet/node-info.ts";
import type { JobRecord, JobSnapshot } from "../../src/fleet/jobs.ts";
import type { QueueRecord } from "../../src/fleet/queue.ts";
import { emptySol } from "../fixtures/sol.ts";

const NOW = Date.UTC(2026, 0, 1, 12);
const directories: string[] = [];
const servers: Server[] = [];
const errors: string[] = [];
let origin = "";
type Options = NonNullable<Parameters<typeof startPreviewServer>[0]>;

function fixtureAddress(value: number): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let result = "";
  for (let remaining = value; remaining; remaining = Math.floor(remaining / 58)) result = alphabet[remaining % 58]! + result;
  return "1".repeat(32 - Math.ceil(Math.log2(value + 1) / 8)) + result;
}
const addresses = Array.from({ length: 200 }, (_, index) => fixtureAddress(index + 1));

function metadata(address: string, at: number): HostMetadataRecord {
  return { address, values: { status: "PREMIUM", marketAddress: addresses[199]!, marketLabel: "fixture-market",
    ram: null, disk: null, cpu: null, cuda: null, nvidia: null, currentNode: null, system: null },
  fetchedAtMs: at, retained: false, error: null, marketError: null };
}
function state(address: string, at: number): NodeInfoRecord {
  return { address, values: { state: address === addresses[0] ? "RUNNING_JOB" : "QUEUED",
    dl: null, ul: null, ping: null, networkUnavailableReason: null },
  fetchedAtMs: at, validUntilMs: at + 30_000, retained: false, error: null };
}
function job(address: string, at: number): JobRecord {
  return { address, job: address === addresses[0] ? { address: addresses[198]!, node: address, state: "RUNNING",
    timeStart: (NOW - 120_000) / 1000, timeEnd: 0, timeout: 600 } : null,
  checkedAtMs: at, validUntilMs: at + 180_000, failedAtMs: null, pending: false, retryAtMs: null, retained: false, error: null };
}
function queue(address: string, at: number): QueueRecord {
  return { address, marketAddress: addresses[199]!, position: address === addresses[0] ? null : 1,
    total: 2, checkedAtMs: at, validUntilMs: at + 30_000, sourceUpdatedAtMs: NOW - 60_000,
    retained: false, error: null };
}

async function start(count: number, overrides: Partial<Options>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-progress-browser-"));
  directories.push(directory);
  const hostsFile = join(directory, "hosts.json");
  await writeFile(hostsFile, JSON.stringify(addresses.slice(0, count)));
  const server = await startPreviewServer({ now: () => NOW, stakingProvider: emptyStaking, nosProvider: emptyNos, hostsFile, port: 0, solProvider: emptySol,
    metadataProvider: async input => ({ hosts: input.map(address => ({ ...metadata(address, NOW), values: null, fetchedAtMs: null })) }),
    nodeInfoProvider: async input => ({ hosts: input.map(address => ({ ...state(address, NOW), values: null, fetchedAtMs: null, validUntilMs: null })) }),
    jobProvider: async input => ({ hosts: input.map(address => ({ ...job(address, NOW), job: null, checkedAtMs: null, validUntilMs: null })) }),
    queueProvider: async input => ({ hosts: input.map(address => ({ ...queue(address, NOW), position: null, total: null, marketAddress: null, checkedAtMs: null, validUntilMs: null })) }),
    ...overrides,
  });
  servers.push(server);
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("Missing isolated port");
  origin = `http://127.0.0.1:${bound.port}`;
  return origin;
}
function cell(page: Page, column: string, index = 0) {
  return page.locator(`#fleet-rows [data-host="${addresses[index]}"] td[data-col="${column}"]`);
}
async function flushProgress(page: Page, ready: () => Promise<boolean>): Promise<void> {
  // Network chunks arrive independently of the paused browser clock. Keep the
  // 16ms render coalescer moving until that injected partial has been painted.
  await expect.poll(async () => { await page.clock.runFor(20); return ready(); }).toBe(true);
}
async function visibility(page: Page, value: "visible" | "hidden") {
  await page.evaluate(state => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    document.dispatchEvent(new Event("visibilitychange"));
  }, value);
  if (value === "visible") await page.clock.runFor(20);
}

test.beforeEach(async ({ page, context }) => {
  origin = "";
  errors.length = 0;
  await page.clock.install({ time: NOW });
  await page.clock.pauseAt(NOW);
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) {
      errors.push(`Unexpected external request: ${route.request().url()}`);
      return route.abort();
    }
    return route.continue();
  });
  page.on("pageerror", error => errors.push(error.message));
});
test.afterEach(async ({ context }) => {
  for (const page of context.pages()) await page.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  expect(errors).toEqual([]);
});

for (const count of [86, 200]) {
  test(`${count} hosts show fast metadata, State, Duration and Queued before a slow tail finishes`, async ({ page }) => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.addInitScript(() => {
      const events: string[] = [];
      (window as unknown as { streamEvents: string[] }).streamEvents = events;
      // Observe the four held feeds in this test. SOL also supports NDJSON,
      // but its empty fixture completes independently before these are released.
      const dataStreams = new WeakSet<ReadableStream<Uint8Array>>();
      const fetch = window.fetch.bind(window);
      window.fetch = async (...args: Parameters<typeof window.fetch>): Promise<Response> => {
        const response = await fetch(...args);
        const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
        if (response.body !== null && contentType === "application/x-ndjson"
          && !new URL(response.url).pathname.endsWith("/sol.json")) dataStreams.add(response.body);
        return response;
      };
      const original = ReadableStream.prototype.getReader as () => ReadableStreamDefaultReader<Uint8Array>;
      ReadableStream.prototype.getReader = function (this: ReadableStream<Uint8Array>) {
        const reader = original.call(this);
        if (!dataStreams.has(this)) return reader;
        const read = reader.read.bind(reader);
        reader.read = async () => {
          try { const result = await read(); events.push(result.done ? "EOF" : "chunk"); return result; }
          catch (error) { events.push(String(error)); throw error; }
        };
        const cancel = reader.cancel.bind(reader);
        reader.cancel = reason => { events.push("CANCEL:" + String(reason)); return cancel(reason); };
        return reader;
      } as typeof ReadableStream.prototype.getReader;
    });
    const started = new Set<string>();
    const finish = async (kind: string) => { started.add(kind); await pending; };
    await page.goto(await start(count, {
      metadataProvider: async (input, _signal, update) => {
        const records = input.map((address, index) => index < 2 ? metadata(address, NOW)
          : { ...metadata(address, NOW), values: null, fetchedAtMs: null });
        update?.({ hosts: records.slice(0, 2) });
        await finish("metadata");
        return { hosts: records };
      },
      nodeInfoProvider: async (input, _signal, update) => {
        const records = input.map((address, index) => index < 2 ? state(address, NOW)
          : { ...state(address, NOW), values: null, fetchedAtMs: null, validUntilMs: null });
        update?.({ hosts: records.slice(0, 2) });
        await finish("state");
        return { hosts: records };
      },
      jobProvider: async (input, _signal, update) => {
        const records = input.map((address, index) => index < 2 ? job(address, NOW)
          : { ...job(address, NOW), job: null, checkedAtMs: null, validUntilMs: null, pending: true, retryAtMs: NOW + 30_000 });
        update?.({ hosts: records.slice(0, 2) });
        await finish("jobs");
        return { hosts: records };
      },
      queueProvider: async (input, _signal, update) => {
        const records = input.map((address, index) => index < 2 ? queue(address, NOW)
          : { ...queue(address, NOW), marketAddress: null, position: null, total: null, checkedAtMs: null, validUntilMs: null });
        update?.({ hosts: records.slice(0, 2) });
        await finish("queue");
        return { hosts: records };
      },
    }));
    await openPreviewTools(page);
    await expect.poll(() => started.size).toBe(4);
    await flushProgress(page, async () => await cell(page, "status").textContent() === "P");
    await expect(cell(page, "status")).toHaveText("P");
    await expect(cell(page, "state").getByRole("button")).toHaveClass(/node-state-animated/);
    await expect(cell(page, "duration")).toHaveAttribute("data-duration-tone", "current");
    await expect(cell(page, "queued", 1)).toHaveText("1/2");
    await expect(cell(page, "queued", 1).getByRole("button")).not.toHaveClass(/queue-retained/);
    await expect(cell(page, "state", 2).locator(".state-unknown .state-dots")).toBeVisible();
    await expect(cell(page, "state", 2)).toHaveAttribute("data-state", "unknown");
    await expect(cell(page, "state", 2)).toHaveAttribute("data-state-current", "false");
    await expect(cell(page, "state", 2).getByRole("button")).toHaveAccessibleName(/unknown/);
    const saved = await cell(page, "state").getByRole("button").elementHandle();
    await cell(page, "state").getByRole("button").focus();
    await page.clock.fastForward(10_000);
    expect(await saved!.evaluate(button => button.isConnected)).toBe(true);
    await expect(cell(page, "state").getByRole("button")).toBeFocused();
    // Node evidence keeps its original deadline; the independent job proof still supports State.
    await page.clock.fastForward(20_001);
    await expect(cell(page, "state").getByRole("button")).toHaveClass(/node-state-animated/);
    await expect(cell(page, "queued", 1).getByRole("button")).toHaveClass(/queue-retained/);
    await expect(cell(page, "duration")).toHaveAttribute("data-job-checked-at", String(NOW));
    await expect(cell(page, "duration")).toHaveAttribute("data-duration-tone", "current");
    release();
    await expect(page.locator("#jobs-status")).toContainText(`${count - 2} lookups pending`);
    // Chromium may report net::ERR_ABORTED to DevTools after a streamed Fetch
    // has reached EOF. Verify the reader lifecycle itself, not that CDP event.
    await expect.poll(async () => {
      const events = await page.evaluate(() => (window as unknown as { streamEvents: string[] }).streamEvents);
      return { completed: events.filter(event => event === "EOF").length,
        failures: events.filter(event => event !== "EOF" && event !== "chunk") };
    }).toEqual({ completed: 4, failures: [] });
    await expect(cell(page, "state").getByRole("button")).toHaveClass(/node-state-animated/);
    expect(await saved!.evaluate(button => button.isConnected)).toBe(true);
  });
}

test("canceling an unfinished stream permits immediate resume and ignores its late partial callbacks", async ({ page }) => {
  let calls = 0;
  let serverNow = NOW;
  let firstSignal: AbortSignal | undefined;
  let oldUpdate: ((snapshot: JobSnapshot) => void) | undefined;
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  await page.goto(await start(86, { now: () => serverNow, jobProvider: async (input, signal, update) => {
    calls++;
    if (calls === 1) {
      firstSignal = signal;
      oldUpdate = update;
      update?.({ hosts: [job(input[0]!, NOW)] });
      await delayed;
    }
    return { hosts: input.map(address => ({ ...job(address, NOW), job: null })), nextRefreshAtMs: NOW + 120_000 };
  } }));
  await openPreviewTools(page);
  await expect.poll(() => calls).toBe(1);
  await flushProgress(page, async () => await cell(page, "duration").getAttribute("data-duration-tone") === "current");
  await expect(cell(page, "duration")).toHaveAttribute("data-duration-tone", "current");
  await visibility(page, "hidden");
  await expect.poll(() => firstSignal?.aborted).toBe(true);
  // The resumed response is emitted now, while its cached job proof keeps NOW.
  serverNow = await page.evaluate(() => Date.now());
  await visibility(page, "visible");
  await expect.poll(() => calls).toBe(2);
  await expect(cell(page, "duration")).toHaveText("—");
  oldUpdate?.({ hosts: [job(addresses[0]!, NOW)] });
  release();
  await page.clock.runFor(50);
  await expect(cell(page, "duration")).toHaveText("—");
  expect(calls).toBe(2);
});

test("job pending work follows 30-second progress and a later shared quota deadline without cache polling", async ({ page }) => {
  let calls = 0;
  await page.goto(await start(86, { jobProvider: async input => {
    calls++;
    const at = await page.evaluate(() => Date.now());
    const retryAtMs = calls === 1 ? NOW + 30_000 : NOW + 3_600_000;
    return { hosts: input.map(address => ({ ...job(address, at), job: null, checkedAtMs: null,
      validUntilMs: null, pending: true, retryAtMs, error: "Shared request budget" })), nextRefreshAtMs: retryAtMs };
  } }));
  await openPreviewTools(page);
  await expect(page.locator("#jobs-status")).toContainText("86 lookups pending");
  await expect(page.locator("#jobs-status")).toContainText("Known job timings refresh every 120 seconds");
  await expect(page.locator("#jobs-status")).toContainText("pending discovery follows the permitted retry deadline");
  await expect(page.locator("#jobs-status")).toContainText("Next permitted check: 2026-01-01T12:00:30.000Z");
  const status = await page.locator("#jobs-status").textContent();
  await page.clock.fastForward(29_999);
  await expect(page.locator("#jobs-status")).toHaveText(status!);
  expect(calls).toBe(1);
  await page.clock.fastForward(1);
  await expect.poll(() => calls).toBe(2);
  await expect(page.locator("#jobs-status")).toContainText("Next permitted check: 2026-01-01T13:00:00.000Z");
  await page.clock.fastForward(600_000);
  expect(calls).toBe(2);
  await visibility(page, "hidden");
  await page.clock.fastForward(3_000_000);
  await visibility(page, "visible");
  await expect.poll(() => calls).toBe(3);
});

test("an unexpected stream failure retains fast successful values instead of replacing them with fallback blanks", async ({ page }) => {
  let fail!: () => void;
  const held = new Promise<void>(resolve => { fail = resolve; });
  await page.goto(await start(86, { nodeInfoProvider: async (input, _signal, update) => {
    update?.({ hosts: [state(input[0]!, NOW)] });
    await held;
    throw new Error("Injected final stream failure");
  } }));
  await openPreviewTools(page);
  await flushProgress(page, async () => (await cell(page, "state").getByRole("button").getAttribute("class"))?.includes("node-state-animated") === true);
  await expect(cell(page, "state").getByRole("button")).toHaveClass(/node-state-animated/);
  fail();
  await expect(page.locator("#node-info-status")).toContainText("refresh failed");
  await expect(cell(page, "state").locator(".state-running")).toBeVisible();
  await expect(cell(page, "state").getByRole("button")).toHaveClass(/node-state-animated/);
});

for (const count of [86, 200]) {
  test(`${count} visible hosts sustain independent State and Queued cohorts for thirteen minutes while Duration explains a shared quota pause`, async ({ page }) => {
    test.setTimeout(360_000);
    const input = addresses.slice(0, count);
    const markets = [fixtureAddress(1001), fixtureAddress(1002)];
    const states = new Map<string, NodeInfoRecord>();
    const queues = new Map<string, QueueRecord>();
    let statePush: ((snapshot: { hosts: NodeInfoRecord[]; nextRefreshAtMs: number }) => void) | undefined;
    let queuePush: ((snapshot: { hosts: QueueRecord[]; nextRefreshAtMs: number }) => void) | undefined;
    let watchStarts = 0;
    let watchStops = 0;
    let jobCalls = 0;
    let cachedJobs: JobRecord[] = [];
    const stateAt = (address: string, index: number, at: number): NodeInfoRecord => index === count - 1
      ? { ...state(address, at), values: null, fetchedAtMs: null, validUntilMs: null, error: "Node Info unavailable (HTTP 503)." }
      : { ...state(address, at), values: { ...state(address, at).values!, state: index % 2 === 0 ? "QUEUED" : "RUNNING_JOB" } };
    const queueAt = (address: string, index: number, at: number): QueueRecord => ({
      ...queue(address, at), marketAddress: markets[index % 2]!,
      position: index % 2 === 0 ? index / 2 + 1 : null, total: index % 2 === 0 ? count / 2 : 0,
    });
    input.forEach((address, index) => { states.set(address, stateAt(address, index, NOW)); queues.set(address, queueAt(address, index, NOW)); });
    const nodeInfoProvider = Object.assign(async () => ({ hosts: [...states.values()] }), {
      watch: (_input: readonly string[], signal: AbortSignal, update: (snapshot: { hosts: NodeInfoRecord[]; nextRefreshAtMs: number }) => void) => new Promise<never>((_resolve, reject) => {
        watchStarts++;
        statePush = update;
        update({ hosts: [...states.values()], nextRefreshAtMs: NOW + 15_000 });
        signal.addEventListener("abort", () => { watchStops++; reject(signal.reason); }, { once: true });
      }),
    });
    const queueProvider = Object.assign(async () => ({ hosts: [...queues.values()] }), {
      watch: (_input: readonly string[], signal: AbortSignal, update: (snapshot: { hosts: QueueRecord[]; nextRefreshAtMs: number }) => void) => new Promise<never>((_resolve, reject) => {
        watchStarts++;
        queuePush = update;
        update({ hosts: [...queues.values()], nextRefreshAtMs: NOW + 15_000 });
        signal.addEventListener("abort", () => { watchStops++; reject(signal.reason); }, { once: true });
      }),
    });
    await page.goto(await start(count, {
      metadataProvider: async () => ({ hosts: input.map((address, index) => ({
        ...metadata(address, NOW), values: { ...metadata(address, NOW).values!, marketAddress: markets[index % 2]! },
      })) }),
      nodeInfoProvider, queueProvider,
      jobProvider: async () => {
        jobCalls++;
        const at = await page.evaluate(() => Date.now());
        if (at >= NOW + 360_000 && at < NOW + 720_000) return {
          hosts: cachedJobs.map(record => ({ ...record, pending: true, retryAtMs: NOW + 720_000 })),
          nextRefreshAtMs: NOW + 720_000, waitReason: "local-budget", waitUntilMs: NOW + 720_000,
        };
        cachedJobs = input.map((address, index) => ({ ...job(address, at), job: index % 2 === 0 ? null : {
          address: fixtureAddress(2001 + index), node: address, state: "RUNNING", timeStart: (NOW - 120_000) / 1000, timeEnd: 0, timeout: 3600,
        } }));
        return { hosts: cachedJobs, nextRefreshAtMs: at + 120_000, waitReason: null, waitUntilMs: null };
      },
    }));
    await openPreviewTools(page);
    await expect.poll(() => watchStarts).toBe(2);
    await flushProgress(page, async () => await page.locator('td[data-col="state"][data-state-current="true"]').count() === count);
    await expect(page.locator('td[data-col="queued"][data-queue-check-current="true"]')).toHaveCount(count);
    await expect(page.locator("#queue-status")).toContainText(`${count / 2} current positions · ${count / 2} confirmed absent`);
    await expect(page.locator("#node-info-status")).toContainText("HTTP 503");
    await expect(page.locator("#node-info-status")).toContainText("Visible feed active");
    const kept = await cell(page, "state").getByRole("button").elementHandle();
    await cell(page, "state").getByRole("button").focus();

    for (let cycle = 1; cycle <= 78; cycle++) {
      await page.clock.fastForward(10_000);
      const at = await page.evaluate(() => Date.now());
      const cohort = cycle % 2;
      const updatedQueue: QueueRecord[] = [];
      const updatedStates: NodeInfoRecord[] = [];
      input.forEach((address, index) => {
        if (index % 2 !== cohort) return;
        const record = stateAt(address, index, at);
        states.set(address, record);
        // The 86-host case exercises thousands of individual frames; the 200-host
        // case also covers atomic cohort frames, which the wire protocol allows.
        if (count === 86) statePush!({ hosts: [record], nextRefreshAtMs: at + 15_000 });
        else updatedStates.push(record);
        const checked = queueAt(address, index, at);
        queues.set(address, checked);
        updatedQueue.push(checked);
      });
      if (updatedStates.length) statePush!({ hosts: updatedStates, nextRefreshAtMs: at + 15_000 });
      queuePush!({ hosts: updatedQueue, nextRefreshAtMs: at + 15_000 });
      await flushProgress(page, async () => await cell(page, "queued", cohort).getAttribute("data-queue-checked-at") === String(at));
      const lastJob = cachedJobs.at(-1)!;
      const freshJobFallback = lastJob.checkedAtMs !== null && at < lastJob.validUntilMs!;
      await expect(page.locator('td[data-col="state"][data-state-current="true"]')).toHaveCount(freshJobFallback ? count : count - 1);
      await expect(page.locator('td[data-col="queued"][data-queue-check-current="true"]')).toHaveCount(count);
      await expect(page.locator('td[data-col="queued"][data-queue-current="true"][data-queue-kind="position"]')).toHaveCount(count / 2);
      expect(watchStarts, "A healthy visible feed must not restart at each cohort/window").toBe(2);
      if (cycle === 38) {
        await expect(page.locator("#jobs-status")).toContainText("Shared request budget pause until 2026-01-01T12:12:00.000Z");
        await expect(cell(page, "duration", 1)).toHaveAttribute("data-duration-tone", "current");
      }
      if (cycle === 48) {
        await expect(cell(page, "duration", 1)).toHaveAttribute("data-duration-freshness", "retained");
        await expect(page.locator("#jobs-status")).toContainText(`${count / 2} retained`);
        const checkedAt = await cell(page, "duration", 1).getAttribute("data-job-checked-at");
        expect(Number(checkedAt)).toBeLessThan(NOW + 360_000);
      }
      if (cycle === 76) {
        await expect(cell(page, "duration", 1)).toHaveAttribute("data-duration-tone", "current");
        await expect(page.locator("#jobs-status")).not.toContainText("Shared request budget pause");
      }
    }
    expect(jobCalls).toBeLessThanOrEqual(6);
    expect(await kept!.evaluate(button => button.isConnected)).toBe(true);
    await expect(cell(page, "state").getByRole("button")).toBeFocused();
    await visibility(page, "hidden");
    await expect.poll(() => watchStops).toBe(2);
    const stoppedCalls = jobCalls;
    await page.clock.fastForward(180_000);
    expect(jobCalls).toBe(stoppedCalls);
  });
}

test("a streamed metadata market change clears the old queue until matching new-market evidence arrives", async ({ page }) => {
  const input = addresses.slice(0, 2);
  let metadataPush: ((snapshot: { hosts: HostMetadataRecord[] }) => void) | undefined;
  let queuePush: ((snapshot: { hosts: QueueRecord[]; nextRefreshAtMs: number }) => void) | undefined;
  let stopped = 0;
  const initialMetadata = input.map(address => metadata(address, NOW));
  const initialQueue = input.map((address, index) => ({ ...queue(address, NOW), position: index + 1 }));
  const metadataProvider = Object.assign(async () => ({ hosts: initialMetadata }), {
    watch: (_input: readonly string[], signal: AbortSignal, update: (snapshot: { hosts: HostMetadataRecord[] }) => void) => new Promise<never>((_resolve, reject) => {
      metadataPush = update;
      update({ hosts: initialMetadata });
      signal.addEventListener("abort", () => { stopped++; reject(signal.reason); }, { once: true });
    }),
  });
  const queueProvider = Object.assign(async () => ({ hosts: initialQueue }), {
    watch: (_input: readonly string[], signal: AbortSignal, update: (snapshot: { hosts: QueueRecord[]; nextRefreshAtMs: number }) => void) => new Promise<never>((_resolve, reject) => {
      queuePush = update;
      update({ hosts: initialQueue, nextRefreshAtMs: NOW + 15_000 });
      signal.addEventListener("abort", () => { stopped++; reject(signal.reason); }, { once: true });
    }),
  });
  await page.goto(await start(2, { metadataProvider, queueProvider }));
  await openPreviewTools(page);
  await expect.poll(() => metadataPush !== undefined && queuePush !== undefined).toBe(true);
  await flushProgress(page, async () => await cell(page, "queued").textContent() === "1/2");
  await expect(page.locator("#queue-status")).toContainText("2/2 current queue checks");
  const marketAddress = fixtureAddress(5001);
  const updated = { ...metadata(input[0]!, NOW), values: { ...metadata(input[0]!, NOW).values!, marketAddress, marketLabel: "changed-market" } };
  metadataPush!({ hosts: [updated] });
  await flushProgress(page, async () => await cell(page, "market").textContent() === "changed-market");
  await expect(cell(page, "queued")).toHaveText("—");
  await expect(cell(page, "queued")).toHaveAttribute("data-queue-check-current", "false");
  await expect(cell(page, "queued", 1)).toHaveText("2/2");
  await expect(page.locator("#queue-status")).toContainText("1/2 current queue checks");
  queuePush!({ hosts: [{ ...queue(input[0]!, NOW), marketAddress, position: 4, total: 8 }], nextRefreshAtMs: NOW + 15_000 });
  await flushProgress(page, async () => await cell(page, "queued").textContent() === "4/8");
  await expect(cell(page, "queued")).toHaveAttribute("data-queue-check-current", "true");
  await expect(page.locator("#queue-status")).toContainText("2/2 current queue checks");
  await visibility(page, "hidden");
  await expect.poll(() => stopped).toBe(2);
});

test("supporting State updates fit the watch frame allowance and an overdue feed deadline reports queued work without changing source time", async ({ page }) => {
  let push: ((snapshot: { hosts: NodeInfoRecord[]; nextRefreshAtMs: number }) => void) | undefined;
  let watchStarts = 0;
  const reading = (at: number): NodeInfoRecord => ({ ...state(addresses[0]!, at),
    values: { ...state(addresses[0]!, at).values!, state: "OTHER" },
    activity: { state: "QUEUED", source: "nosana-indexer", checkedAtMs: at, validUntilMs: at + 30_000, error: null },
  });
  const nodeInfoProvider = Object.assign(async () => ({ hosts: [reading(NOW)] }), {
    watch: (_input: readonly string[], signal: AbortSignal, update: (snapshot: { hosts: NodeInfoRecord[]; nextRefreshAtMs: number }) => void) => new Promise<never>((_resolve, reject) => {
      watchStarts++;
      push = update;
      update({ hosts: [reading(NOW)], nextRefreshAtMs: NOW + 15_000 });
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  await page.goto(await start(1, { nodeInfoProvider }));
  await openPreviewTools(page);
  await expect.poll(() => push !== undefined).toBe(true);
  // Raw State, running membership and queue evidence can each publish a resolved
  // view; unchanged cached evidence must preserve its own observation times.
  for (let index = 0; index < 30; index++) push!({ hosts: [reading(NOW)], nextRefreshAtMs: NOW + 15_000 });
  await flushProgress(page, async () => await cell(page, "state").getAttribute("data-state-current") === "true");
  await expect(page.locator("#node-info-status")).toContainText("Next permitted check: 2026-01-01T12:00:15.000Z");
  await page.clock.fastForward(16_000);
  push!({ hosts: [reading(NOW)], nextRefreshAtMs: NOW + 15_000 });
  await flushProgress(page, async () => (await page.locator("#node-info-status").textContent())?.includes("Eligible checks queued/in progress") === true);
  await expect(page.locator("#node-info-status")).toContainText("Latest successful API check: 2026-01-01T12:00:00.000Z");
  await expect(page.locator("#node-info-status")).not.toContainText("Next permitted check:");
  const status = await page.locator("#node-info-status").textContent();
  await page.clock.fastForward(2_000);
  await expect(page.locator("#node-info-status")).toHaveText(status!);
  await page.clock.fastForward(43_000);
  await expect(cell(page, "state")).toHaveAttribute("data-state-current", "false");
  const renewedAt = await page.evaluate(() => Date.now());
  for (let index = 0; index < 30; index++) push!({ hosts: [reading(renewedAt)], nextRefreshAtMs: renewedAt + 15_000 });
  await flushProgress(page, async () => await cell(page, "state").getAttribute("data-state-current") === "true");
  await expect(page.locator("#node-info-status")).not.toContainText("refresh failed");
  expect(watchStarts).toBe(1);
});

test("an eligible finite job read shows fixed in-progress wording instead of a past retry timestamp", async ({ page }) => {
  let calls = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.goto(await start(1, { jobProvider: async input => {
    calls++;
    if (calls === 2) await held;
    const at = await page.evaluate(() => Date.now());
    return { hosts: input.map(address => job(address, at)), nextRefreshAtMs: at + 10_000 };
  } }));
  await openPreviewTools(page);
  await expect(cell(page, "duration")).toHaveAttribute("data-duration-tone", "current");
  await page.clock.fastForward(10_000);
  await expect.poll(() => calls).toBe(2);
  await expect(page.locator("#jobs-status")).toContainText("Checking eligible jobs");
  await expect(page.locator("#jobs-status")).not.toContainText("Next permitted check:");
  const status = await page.locator("#jobs-status").textContent();
  await page.clock.fastForward(2_000);
  await expect(page.locator("#jobs-status")).toHaveText(status!);
  release();
  await expect(page.locator("#jobs-status")).toContainText("Next permitted check:");
  await expect(page.locator("#jobs-status")).not.toContainText("Checking eligible jobs");
});
