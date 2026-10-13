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
import type { SolSnapshot } from "../../src/fleet/sol.ts";
import { SYNTHETIC_HOST_ADDRESSES as addresses } from "../fixtures/host-addresses.ts";
import { emptyJobs } from "../fixtures/jobs.ts";
import { emptyQueue } from "../fixtures/queue.ts";

const NOW = Date.UTC(2026, 0, 1, 12);
const servers: Server[] = [];
const directories: string[] = [];
const errors: string[] = [];
const externalRequests: string[] = [];
let origin = "";
type Options = NonNullable<Parameters<typeof startPreviewServer>[0]>;

function snapshot(at = NOW, amounts: (string | null)[] = ["123456789", "123456788", "0", null, "9007199254740993", "9007199254740992", null, null]): SolSnapshot {
  return { hosts: addresses.map((address, index) => ({
    address, lamports: amounts[index] ?? null, provider: "Injected public RPC", endpoint: "https://rpc.example.invalid",
    contextSlot: 456, blockTimeMs: at - 1_000, checkedAtMs: at, validUntilMs: at + 60_000,
    retained: false, error: null, retryAtMs: null,
  })), nextRefreshAtMs: at + 30_000 };
}

const noMetadata = async (input: readonly string[]) => ({ hosts: input.map(address => ({
  address, values: null, fetchedAtMs: null, retained: false, error: null, marketError: null,
})) });
const noState = async (input: readonly string[]) => ({ hosts: input.map(address => ({
  address, values: null, fetchedAtMs: null, validUntilMs: null, retained: false, error: null,
})) });

async function start(solProvider: NonNullable<Options["solProvider"]>, overrides: Partial<Options> = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-sol-browser-"));
  directories.push(directory);
  const hostsFile = join(directory, "hosts.json");
  await writeFile(hostsFile, JSON.stringify(addresses));
  const server = await startPreviewServer({ now: () => NOW, stakingProvider: emptyStaking, nosProvider: emptyNos, hostsFile, port: 0, solProvider,
    metadataProvider: noMetadata, nodeInfoProvider: noState, jobProvider: emptyJobs, queueProvider: emptyQueue,
    ...overrides,
  });
  servers.push(server);
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("Missing isolated preview port");
  origin = `http://127.0.0.1:${bound.port}`;
  return origin;
}

function cell(page: Page, index = 0) {
  return page.locator(`#fleet-rows [data-host="${addresses[index]}"] td[data-col="sol"]`);
}
async function order(page: Page): Promise<string[]> {
  return page.locator("#fleet-rows [data-host]").evaluateAll(rows => rows.map(row => row.getAttribute("data-host")!));
}
async function visibility(page: Page, state: "visible" | "hidden"): Promise<void> {
  await page.evaluate(value => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => value === "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
  if (state === "visible") await page.clock.runFor(1);
}

test.beforeEach(async ({ page, context }) => {
  origin = "";
  errors.length = externalRequests.length = 0;
  await page.clock.install({ time: NOW });
  await page.clock.pauseAt(NOW);
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) {
      externalRequests.push(route.request().url());
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
  expect(externalRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test("SOL truncates compactly, sorts exact lamports, retains zero and explains complete provenance", async ({ page }) => {
  await page.goto(await start(async () => snapshot()));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveText("0.123");
  await expect(cell(page, 1)).toHaveText("0.123");
  await expect(cell(page, 2)).toHaveText("0.000");
  await expect(cell(page, 3)).toHaveText("—");
  await expect(cell(page, 4)).toHaveText("9007199.254");
  await expect(cell(page, 5)).toHaveText("9007199.254");
  await page.getByRole("button", { name: "Sort by SOL", exact: true }).click();
  expect(await order(page)).toEqual([addresses[2], addresses[1], addresses[0], addresses[5], addresses[4], addresses[3], addresses[6], addresses[7]]);
  await page.getByRole("button", { name: "Sort by SOL", exact: true }).click();
  expect(await order(page)).toEqual([addresses[4], addresses[5], addresses[0], addresses[1], addresses[2], addresses[3], addresses[6], addresses[7]]);
  await cell(page, 4).getByRole("button").click();
  const dialog = page.getByRole("dialog");
  for (const text of [addresses[4]!, "9007199.254740993", "9007199254740993", "Injected public RPC", "456", "confirmed", "Oldest provider batch estimated block time", "API check time"]) {
    await expect(dialog).toContainText(text);
  }
  await page.keyboard.press("Escape");
  await expect(cell(page, 4).getByRole("button")).toBeFocused();
});

test("shared deadlines detect top-ups and decreases while manual reads preserve focus and reuse current balances", async ({ page }) => {
  let calls = 0;
  await page.goto(await start(async () => {
    const amounts = calls++ === 0 ? ["1000000000"] : calls === 2 ? ["2500000000"] : ["750000000"];
    return snapshot(await page.evaluate(() => Date.now()), amounts);
  }));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveText("1.000");
  const saved = await cell(page).getByRole("button").elementHandle();
  await cell(page).getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText("1000000000");
  await page.clock.fastForward(30_000);
  await expect(cell(page)).toHaveText("2.500");
  expect(await saved!.evaluate(node => node.isConnected)).toBe(true);
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(cell(page).getByRole("button")).toBeFocused();
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await page.clock.fastForward(29_999);
  expect(calls).toBe(2);
  await page.clock.fastForward(1);
  await expect(cell(page)).toHaveText("0.750");
  expect(calls).toBe(3);
});

test("failed reads retain gray values and unfinished refreshes expire locally without loading-message churn", async ({ page }) => {
  let calls = 0;
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  await page.goto(await start(async () => {
    calls++;
    if (calls === 2) await delayed;
    const result = snapshot(calls === 1 ? NOW : await page.evaluate(() => Date.now()));
    if (calls === 2) return { hosts: snapshot().hosts.map(record => ({ ...record, retained: record.lamports !== null,
      error: "Injected RPC unavailable (429)", retryAtMs: NOW + 90_000,
    })), nextRefreshAtMs: NOW + 90_000 };
    return result;
  }));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveAttribute("data-sol-state", "current");
  const initialStatus = await page.locator("#sol-status").textContent();
  await page.clock.fastForward(30_000);
  await expect.poll(() => calls).toBe(2);
  await expect(page.locator("#sol-status")).toHaveText(initialStatus!);
  await page.clock.fastForward(30_000);
  await expect(cell(page)).toHaveText("0.123");
  await expect(cell(page)).toHaveAttribute("data-sol-state", "retained");
  await expect(cell(page).getByRole("button")).toHaveCSS("color", "rgb(136, 136, 136)");
  release();
  await expect(page.locator("#sol-status")).toContainText("Next eligible retry");
  await cell(page).getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText("429");
  await expect(page.getByRole("dialog")).toContainText("2026-01-01T12:00:00.000Z");
  await page.keyboard.press("Escape");
  await page.clock.fastForward(30_000);
  await expect(cell(page)).toHaveAttribute("data-sol-state", "current");
  expect(calls).toBe(3);
});

test("visible unfocused pages poll; hidden work aborts all consumers and immediate resume ignores unfinished responses", async ({ page }) => {
  const reads = { metadata: 0, state: 0, jobs: 0, queue: 0, sol: 0, nos: 0, staking: 0 };
  let serverNow = NOW;
  const aborted = new Set<string>();
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  let delayAll = false;
  async function reading(kind: keyof typeof reads, signal?: AbortSignal): Promise<void> {
    reads[kind]++;
    if (delayAll) {
      signal?.addEventListener("abort", () => aborted.add(kind), { once: true });
      await delayed; // Deliberately ignore cancellation to test stale-result guards too.
    }
  }
  await page.goto(await start(async (_input, signal) => {
    const slow = delayAll;
    await reading("sol", signal);
    const at = await page.evaluate(() => Date.now());
    serverNow = at;
    return snapshot(at, [slow ? "99000000000" : "1000000000"]);
  }, {
    now: () => serverNow,
    metadataProvider: async (input, signal) => { await reading("metadata", signal); return noMetadata(input); },
    nodeInfoProvider: async (input, signal) => { await reading("state", signal); return noState(input); },
    jobProvider: async (input, signal) => { await reading("jobs", signal); return emptyJobs(input); },
    queueProvider: async (input, signal) => { await reading("queue", signal); return emptyQueue(input); },
    nosProvider: async (input, signal) => { await reading("nos", signal); return emptyNos(input); },
    stakingProvider: async (input, signal) => { await reading("staking", signal); return emptyStaking(input); },
  }));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveText("1.000");
  await expect(page.locator("#staking-status")).toContainText("0/8 current staking vault amounts");
  await page.evaluate(() => {
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
    window.dispatchEvent(new Event("blur"));
  });
  await page.clock.fastForward(30_000);
  await expect.poll(() => reads.sol).toBe(2);
  await expect(cell(page)).toHaveAttribute("data-sol-state", "current");
  delayAll = true;
  await page.clock.fastForward(30_000);
  await expect.poll(() => reads.sol).toBe(3);
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect.poll(() => reads.metadata).toBe(2);
  await expect.poll(() => reads.jobs).toBe(2);
  await expect.poll(() => reads.nos).toBe(2);
  await visibility(page, "hidden");
  // Chromium may queue the seventh route behind its six HTTP/1 connections.
  // Every dispatched provider must abort; queued browser work must not dispatch.
  // Request delivery and close events reach the server asynchronously; compare
  // both live snapshots together instead of freezing the expected list early.
  await expect.poll(() => {
    const dispatched = Object.entries(reads).filter(([, count]) => count > 1).map(([kind]) => kind);
    return {
      missing: dispatched.filter(kind => !aborted.has(kind)).sort(),
      unexpected: [...aborted].filter(kind => !dispatched.includes(kind)).sort(),
    };
  }).toEqual({ missing: [], unexpected: [] });
  const paused = { ...reads };
  await page.clock.fastForward(60_000);
  expect(reads).toEqual(paused);
  delayAll = false;
  await visibility(page, "visible");
  await expect.poll(() => reads.sol).toBe(4);
  await expect.poll(() => reads.metadata).toBe(3);
  await expect(cell(page)).toHaveText("1.000");
  release();
  await expect(cell(page)).toHaveAttribute("data-sol-state", "current");
  await expect(cell(page)).toHaveText("1.000");
  const resumed = { ...reads };
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await page.clock.fastForward(120_000);
  expect(reads).toEqual(resumed);
});

test("two viewers share pending work and hiding one preserves the other viewer's request", async ({ page, context }) => {
  let calls = 0;
  let canceled = false;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.goto(await start(async (_input, signal) => {
    calls++;
    signal?.addEventListener("abort", () => { canceled = true; }, { once: true });
    await pending;
    return snapshot();
  }));
  await openPreviewTools(page);
  await expect.poll(() => calls).toBe(1);
  const other = await context.newPage();
  await other.goto(origin);
  await openPreviewTools(other);
  await expect(other.locator("#sol-status")).toContainText("Reading confirmed SOL balances");
  await visibility(page, "hidden");
  expect(canceled).toBe(false);
  expect(calls).toBe(1);
  await visibility(page, "visible");
  release();
  await expect(cell(page)).toHaveText("0.123");
  await expect(cell(other)).toHaveText("0.123");
  expect(calls).toBe(1);
  expect(canceled).toBe(false);
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await other.getByRole("button", { name: "Refresh view", exact: true }).click();
  expect(calls).toBe(1);
});

test("resume fetches overdue metadata once without replaying hidden refresh intervals", async ({ page }) => {
  let metadataCalls = 0;
  let solCalls = 0;
  let serverNow = NOW;
  await page.goto(await start(async () => {
    solCalls++;
    const at = await page.evaluate(() => Date.now());
    serverNow = at;
    return snapshot(at);
  }, { now: () => serverNow, metadataProvider: async input => {
    metadataCalls++;
    const at = await page.evaluate(() => Date.now());
    serverNow = at;
    return { hosts: input.map(address => ({ address, values: null, fetchedAtMs: at,
      retained: false, error: null, marketError: null })) };
  } }));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveText("0.123");
  await expect.poll(() => metadataCalls).toBe(1);
  await visibility(page, "hidden");
  await page.clock.fastForward(300_001);
  expect(metadataCalls).toBe(1);
  expect(solCalls).toBe(1);
  await visibility(page, "visible");
  await expect.poll(() => metadataCalls).toBe(2);
  await expect.poll(() => solCalls).toBe(2);
  await expect(cell(page)).toHaveAttribute("data-sol-state", "current");
  await page.clock.runFor(1);
  expect(metadataCalls).toBe(2);
  expect(solCalls).toBe(2);
});

test("invalid identities and future times cannot replace balances; partial failure preserves each host's evidence", async ({ page }) => {
  let calls = 0;
  await page.goto(await start(async () => {
    calls++;
    const at = await page.evaluate(() => Date.now());
    const result = snapshot(at);
    if (calls === 2) result.hosts[1]!.address = result.hosts[0]!.address;
    if (calls === 3) {
      result.hosts[0]!.checkedAtMs = at + 16_000;
      result.hosts[0]!.validUntilMs = at + 76_000;
    }
    if (calls === 4) {
      result.hosts[0] = { ...snapshot().hosts[0]!, retained: true, error: "Only this batch failed", retryAtMs: at + 30_000 };
      result.hosts[1]!.lamports = "4000000000";
      result.hosts.reverse(); // The browser binds exact addresses, never array position.
    }
    return result;
  }));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveText("0.123");
  for (let attempt = 2; attempt <= 3; attempt++) {
    await page.clock.fastForward(30_000);
    await expect.poll(() => calls).toBe(attempt);
    await expect(cell(page)).toHaveAttribute("data-sol-state", "retained");
    await expect(cell(page)).toHaveText("0.123");
    await expect(cell(page, 1)).toHaveText("0.123");
  }
  await page.clock.fastForward(30_000);
  await expect(cell(page, 1)).toHaveText("4.000");
  await expect(cell(page, 1)).toHaveAttribute("data-sol-state", "current");
  await expect(cell(page)).toHaveText("0.123");
  await expect(cell(page)).toHaveAttribute("data-sol-state", "retained");
  await expect(cell(page, 2)).toHaveText("0.000");
  await expect(cell(page, 3)).toHaveText("—");
});

async function flushSolProgress(page: Page, ready: () => Promise<boolean>): Promise<void> {
  await expect.poll(async () => { await page.clock.runFor(20); return ready(); }).toBe(true);
}

test("200 SOL rows publish the first verified batch before a slow tail and preserve sorting, focus and check times", async ({ page }) => {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const roster = [...addresses, ...Array.from({ length: 192 }, (_, index) =>
    "1".repeat(30) + alphabet[Math.floor((index + 256) / 58)] + alphabet[(index + 256) % 58])];
  const directory = await mkdtemp(join(tmpdir(), "gridlens-sol-progress-"));
  directories.push(directory);
  const hostsFile = join(directory, "hosts.json");
  await writeFile(hostsFile, JSON.stringify(roster));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let finished = false;
  const records = roster.map((address, index) => ({ ...snapshot().hosts[0]!, address,
    lamports: String((index + 1) * 1_000_000_000) }));
  await page.goto(await start(async (_input, _signal, onUpdate) => {
    onUpdate?.({ hosts: records.slice(0, 100), nextRefreshAtMs: NOW + 30_000 });
    await held;
    finished = true;
    return { hosts: records, nextRefreshAtMs: NOW + 30_000 };
  }, { hostsFile }));
  await flushSolProgress(page, async () => await page.locator('[data-sol-state="current"]').count() === 100);
  expect(finished).toBe(false);
  await expect(cell(page)).toHaveText("1.000");
  const last = page.locator(`#fleet-rows [data-host="${roster[199]}"] td[data-col="sol"]`);
  await expect(last).toHaveText("—");
  await page.getByRole("button", { name: "Sort by SOL", exact: true }).click();
  await page.getByRole("button", { name: "Sort by SOL", exact: true }).click();
  expect((await order(page))[0]).toBe(roster[99]);
  const saved = await cell(page).getByRole("button").elementHandle();
  await cell(page).getByRole("button").click();
  await page.clock.runFor(5_000);
  release();
  await expect(last).toHaveText("200.000");
  expect((await order(page))[0]).toBe(roster[199]);
  expect(await saved!.evaluate(node => node.isConnected)).toBe(true);
  await expect(page.getByRole("dialog")).toContainText("2026-01-01T12:00:00.000Z");
  await page.keyboard.press("Escape");
  await expect(cell(page).getByRole("button")).toBeFocused();
});

test("a completed SOL batch expires locally while the tail waits and survives an explicit stream failure", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  await page.goto(await start(async (_input, _signal, onUpdate) => {
    calls++;
    onUpdate?.({ hosts: snapshot().hosts.slice(0, 1), nextRefreshAtMs: NOW + 30_000 });
    await held;
    throw new Error("private fixture failure");
  }));
  await flushSolProgress(page, async () => await cell(page).getAttribute("data-sol-state") === "current");
  await page.clock.fastForward(60_001);
  await expect(cell(page)).toHaveAttribute("data-sol-state", "retained");
  await expect(cell(page)).toHaveText("0.123");
  expect(calls).toBe(1);
  release();
  await openPreviewTools(page);
  await expect(page.locator("#sol-status")).toContainText("Some reads are unavailable");
  await expect(cell(page)).toHaveText("0.123");
  await expect(cell(page, 1)).toHaveText("—");
  await cell(page).getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText("2026-01-01T12:00:00.000Z");
  await expect(page.getByRole("dialog")).not.toContainText("private fixture failure");
});

test("hiding a partial SOL stream cancels its last viewer and resume ignores late obsolete balances", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  let signal: AbortSignal | undefined;
  await page.goto(await start(async (_input, currentSignal, onUpdate) => {
    if (++calls === 1) {
      signal = currentSignal;
      onUpdate?.({ hosts: snapshot(NOW, ["1000000000"]).hosts.slice(0, 1), nextRefreshAtMs: NOW + 30_000 });
      await held;
      onUpdate?.({ hosts: snapshot(NOW, ["99000000000"]).hosts, nextRefreshAtMs: NOW + 30_000 });
      return snapshot(NOW, ["99000000000"]);
    }
    return snapshot(await page.evaluate(() => Date.now()), ["2000000000"]);
  }));
  await flushSolProgress(page, async () => await cell(page).textContent() === "1.000");
  await visibility(page, "hidden");
  await expect.poll(() => signal?.aborted).toBe(true);
  await visibility(page, "visible");
  await expect(cell(page)).toHaveText("2.000");
  release();
  await page.clock.runFor(100);
  await expect(cell(page)).toHaveText("2.000");
  expect(calls).toBe(2);
});
