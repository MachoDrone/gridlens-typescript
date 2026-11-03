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
import type { JobRecord } from "../../src/fleet/jobs.ts";
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
