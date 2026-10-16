import { openPreviewTools } from "./helpers.ts";
import { emptyStaking } from "../fixtures/staking.ts";
import { emptyNos } from "../fixtures/nos.ts";
import { emptySol } from "../fixtures/sol.ts";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPreviewServer } from "../../scripts/preview-server.ts";
import type { HostMetadataSnapshot } from "../../src/fleet/host-metadata.ts";
import type { JobSnapshot } from "../../src/fleet/jobs.ts";
import type { NodeInfoSnapshot } from "../../src/fleet/node-info.ts";
import type { QueueSnapshot } from "../../src/fleet/queue.ts";
import { emptyJobs } from "../fixtures/jobs.ts";
import { SYNTHETIC_HOST_ADDRESSES } from "../fixtures/host-addresses.ts";

const addresses = SYNTHETIC_HOST_ADDRESSES;
const market = addresses[7]!;
const NOW = Date.UTC(2026, 0, 1, 12);
const servers: Server[] = [];
const directories: string[] = [];
let origin = "";
let queueRequests = 0;
let stateRequests = 0;
let jobRequests = 0;
const errors: string[] = [];
const externalRequests: string[] = [];

function queues(at = NOW, positions: (number | null)[] = [2, 10], total = 12): QueueSnapshot {
  return { hosts: addresses.map((address, index) => ({
    address, marketAddress: market, position: positions[index] ?? null, total,
    checkedAtMs: at, validUntilMs: at + 30_000, sourceUpdatedAtMs: at - 1_000,
    retained: false, error: null,
  })) };
}

async function metadata(input: readonly string[]): Promise<HostMetadataSnapshot> {
  return { hosts: input.map(address => ({
    address, values: { status: null, marketAddress: market, marketLabel: "synthetic-market",
      ram: null, disk: null, cpu: null, cuda: null, nvidia: null, currentNode: null, system: null },
    fetchedAtMs: NOW, retained: false, error: null, marketError: null,
  })) };
}

async function noState(input: readonly string[]): Promise<NodeInfoSnapshot> {
  return { hosts: input.map(address => ({
    address, values: null, fetchedAtMs: null, validUntilMs: null, retained: false, error: null,
  })) };
}

async function running(index = 2, at = NOW): Promise<JobSnapshot> {
  const result = await emptyJobs(addresses);
  result.hosts[index] = {
    address: addresses[index]!, job: { address: addresses[6]!, node: addresses[index]!, state: "RUNNING",
      timeStart: NOW / 1_000 - 120, timeEnd: 0, timeout: 600 },
    checkedAtMs: at, validUntilMs: at + 180_000, failedAtMs: null,
    retained: false, pending: false, retryAtMs: null, error: null,
  };
  return result;
}

async function start(queueProvider: () => Promise<QueueSnapshot>, options: {
  now?: () => number;
  jobProvider?: () => Promise<JobSnapshot>;
  nodeInfoProvider?: (addresses: readonly string[]) => Promise<NodeInfoSnapshot>;
  metadataProvider?: (addresses: readonly string[]) => Promise<HostMetadataSnapshot>;
} = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-queue-browser-"));
  directories.push(directory);
  const hostsFile = join(directory, "hosts.json");
  await writeFile(hostsFile, JSON.stringify(addresses));
  const server = await startPreviewServer({ now: options.now ?? (() => NOW), stakingProvider: emptyStaking, nosProvider: emptyNos, solProvider: emptySol, hostsFile, port: 0, queueProvider,
    jobProvider: options.jobProvider ?? emptyJobs,
    metadataProvider: options.metadataProvider ?? metadata,
    nodeInfoProvider: options.nodeInfoProvider ?? noState,
  });
  servers.push(server);
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("Missing isolated port");
  origin = `http://127.0.0.1:${bound.port}`;
  return origin;
}

function cell(page: Page, index = 0, column = "queued") {
  return page.locator(`#fleet-rows [data-host="${addresses[index]}"] td[data-col="${column}"]`);
}

async function refresh(page: Page): Promise<void> {
  const response = page.waitForResponse(value => value.url().endsWith("/preview/queue.json"));
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await response;
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
  queueRequests = 0;
  stateRequests = 0;
  jobRequests = 0;
  errors.length = 0;
  externalRequests.length = 0;
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
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path === "/preview/queue.json") queueRequests++;
    if (path === "/preview/node-info.json") stateRequests++;
    if (path === "/preview/jobs.json") jobRequests++;
  });
});

test.afterEach(async ({ page }) => {
  // End browser polling before closing its isolated provider server.
  await page.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  expect(errors).toEqual([]);
  expect(externalRequests).toEqual([]);
});

test("ordered queue positions match the compact reference, details and natural sorting", async ({ page }, info) => {
  await page.goto(await start(async () => queues(), { jobProvider: () => running() }));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveText("2/12");
  await expect(cell(page, 1)).toHaveText("10/12");
  await expect(cell(page).getByRole("button")).toHaveCSS("color", "rgb(204, 204, 204)");
  await expect(cell(page).getByRole("button")).toHaveCSS("font-size", "12px");
  await expect(cell(page, 0, "duration")).toHaveText("⟵");
  await expect(cell(page, 0, "duration").getByRole("button")).toHaveCSS("color", "rgb(85, 85, 85)");
  await expect(cell(page, 2)).toHaveText("⟶");
  await expect(cell(page, 2).getByRole("button")).toHaveCSS("color", "rgb(85, 85, 85)");
  await expect(cell(page, 2, "duration").locator(".duration-active")).toHaveCount(1);
  const queueBounds = await cell(page).boundingBox();
  const durationBounds = await cell(page, 0, "duration").boundingBox();
  expect(queueBounds!.x + queueBounds!.width).toBeLessThanOrEqual(durationBounds!.x + 1);
  await page.screenshot({ path: info.outputPath("queue-duration-order.png"), fullPage: true });
  await page.getByRole("button", { name: "Sort by Queued", exact: true }).click();
  await expect(page.locator("#fleet-rows tr").nth(0)).toHaveAttribute("data-host", addresses[0]!);
  await expect(page.locator("#fleet-rows tr").nth(1)).toHaveAttribute("data-host", addresses[1]!);
  await page.getByRole("button", { name: "Sort by Queued", exact: true }).click();
  await expect(page.locator("#fleet-rows tr").nth(0)).toHaveAttribute("data-host", addresses[1]!);
  await expect(page.locator("#fleet-rows tr").nth(1)).toHaveAttribute("data-host", addresses[0]!);
  await expect(page.locator("#fleet-rows tr").nth(2)).toHaveAttribute("data-host", addresses[2]!);
  await cell(page).getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText(addresses[0]!);
  await expect(page.getByRole("dialog")).toContainText(market);
  await expect(page.getByRole("dialog")).toContainText(new Date(NOW).toISOString());
  await expect(page.getByRole("dialog")).toContainText(new Date(NOW - 1000).toISOString());
  await expect(page.getByRole("dialog")).toContainText("not an estimated wait time");
});

test("queue changes and sorting preserve connected buttons, focus and other rows' Duration glare", async ({ page }) => {
  let positions = [2, 10];
  let total = 12;
  await page.goto(await start(async () => queues(await page.evaluate(() => Date.now()), positions, total), { jobProvider: () => running() }));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveText("2/12");
  await expect(cell(page, 2, "duration").locator(".duration-active")).toHaveCount(1);
  const kept = await page.evaluateHandle(() => {
    const queue = document.querySelector(".queue-value")!;
    const fill = document.querySelector(".duration-active")!;
    return { queue, fill, animation: fill.getAnimations({ subtree: true })[0], phase: (fill as HTMLElement).style.getPropertyValue("--duration-delay") };
  });
  await cell(page).getByRole("button").focus();
  await page.keyboard.press("Enter");
  positions = [11, 1];
  total = 15;
  await page.clock.fastForward(20_000);
  await expect(cell(page)).toHaveText("11/15");
  await page.keyboard.press("Escape");
  await expect(cell(page).getByRole("button")).toBeFocused();
  await page.getByRole("button", { name: "Sort by Queued", exact: true }).click();
  await expect(page.locator("#fleet-rows tr").first()).toHaveAttribute("data-host", addresses[1]!);
  expect(await kept.evaluate(value => value.queue.isConnected && value.fill.isConnected &&
    value.fill.getAnimations({ subtree: true }).includes(value.animation!) &&
    (value.fill as HTMLElement).style.getPropertyValue("--duration-delay") === value.phase)).toBe(true);
  expect(jobRequests).toBe(1);
  expect(queueRequests).toBe(2);
  expect(stateRequests).toBe(2);
});

test("cached queue evidence expires locally without advancing API times or keeping arrows", async ({ page }) => {
  await page.goto(await start(async () => queues(), { jobProvider: () => running() }));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveAttribute("data-queue-current", "true");
  await page.clock.fastForward(30_000);
  await expect(cell(page)).toHaveText("2/12");
  await expect(cell(page)).toHaveAttribute("data-queue-retained", "true");
  await expect(cell(page).getByRole("button")).toHaveCSS("color", "rgb(119, 119, 119)");
  await expect(cell(page)).toHaveAttribute("data-queue-checked-at", String(NOW));
  await expect(cell(page, 0, "duration")).toHaveText("Populating..");
  await expect(cell(page, 2)).toHaveText("—");
  await expect(cell(page, 2, "duration").locator(".duration-active")).toHaveCount(1);
  await cell(page).getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText("expired");
});

test("transport failures retain gray positions and recover without background loading text", async ({ page }) => {
  let fail = false;
  await page.goto(await start(async () => {
    if (fail) throw new Error("Synthetic failure");
    return queues(await page.evaluate(() => Date.now()));
  }));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveText("2/12");
  const button = await cell(page).getByRole("button").elementHandle();
  await page.evaluate(() => {
    const notice = document.getElementById("queue-status")!;
    (window as unknown as { queueMessages: string[] }).queueMessages = [];
    new MutationObserver(() => (window as unknown as { queueMessages: string[] }).queueMessages.push(notice.textContent!))
      .observe(notice, { childList: true, subtree: true, characterData: true });
  });
  fail = true;
  await refresh(page);
  await expect(cell(page)).toHaveAttribute("data-queue-retained", "true");
  await expect(cell(page, 0, "duration")).toHaveText("Populating..");
  await expect(page.locator("#queue-status")).toContainText("Queue refresh failed");
  fail = false;
  await refresh(page);
  await expect(cell(page)).toHaveAttribute("data-queue-current", "true");
  await expect(cell(page, 0, "duration")).toHaveText("⟵");
  expect(await button!.evaluate(value => value.isConnected)).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { queueMessages: string[] }).queueMessages.some(value => value.includes("Reading")))).toBe(false);
});

test("successful absence clears prior positions and queued/running transitions update arrows", async ({ page }) => {
  let queued = true;
  await page.goto(await start(async () => queues(await page.evaluate(() => Date.now()), queued ? [2] : []), {
    jobProvider: async () => queued ? emptyJobs(addresses) : running(0, await page.evaluate(() => Date.now())),
  }));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveText("2/12");
  const button = await cell(page).getByRole("button").elementHandle();
  queued = false;
  await page.clock.runFor(1_000);
  await refresh(page);
  await expect(cell(page)).toHaveText("⟶");
  await expect(cell(page, 0, "duration").locator(".duration-active")).toHaveCount(1);
  queued = true;
  await page.clock.runFor(1_000);
  await refresh(page);
  await expect(cell(page)).toHaveText("2/12");
  await expect(cell(page, 0, "duration")).toHaveText("⟵");
  expect(await button!.evaluate(value => value.isConnected)).toBe(true);
  await page.route("**/preview/queue.json", async route => route.fulfill({ json: queues(await page.evaluate(() => Date.now()), [], 0) }));
  await refresh(page);
  await expect(cell(page)).toHaveText("—");
  await expect(cell(page, 0, "duration")).toHaveText("Populating..");
});

test("host identity, duplicate positions and inconsistent market snapshots fail closed", async ({ page }) => {
  let invalid = 0;
  await page.goto(await start(async () => {
    const snapshot = queues();
    if (invalid === 1) snapshot.hosts[0]!.address = addresses[1]!;
    if (invalid === 2) snapshot.hosts[1]!.position = snapshot.hosts[0]!.position;
    if (invalid === 3) snapshot.hosts[1]!.total = 20;
    return snapshot;
  }));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveText("2/12");
  for (invalid of [1, 2, 3]) {
    await refresh(page);
    await expect(cell(page)).toHaveText("2/12");
    await expect(cell(page)).toHaveAttribute("data-queue-retained", "true");
    await expect(cell(page, 0, "duration")).toHaveText("Populating..");
  }
});

test("market changes reject prior membership and conflicting running State keeps queue positions gray", async ({ page }) => {
  let marketChanged = false;
  let conflict = false;
  await page.goto(await start(async () => queues(), {
    metadataProvider: async input => {
      const result = await metadata(input);
      if (marketChanged) result.hosts[0]!.values!.marketAddress = addresses[6]!;
      return result;
    },
    nodeInfoProvider: async input => ({ hosts: input.map(address => ({
      address, values: { state: conflict ? "RUNNING_JOB" : "QUEUED", dl: null, ul: null, ping: null, networkUnavailableReason: null },
      fetchedAtMs: NOW, validUntilMs: NOW + 30_000, retained: false, error: null,
    })) }),
  }));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveAttribute("data-queue-current", "true");
  conflict = true;
  await refresh(page);
  await expect(cell(page)).toHaveAttribute("data-queue-retained", "true");
  await expect(cell(page, 0, "duration")).toHaveText("Populating..");
  marketChanged = true;
  await refresh(page);
  await expect(cell(page)).toHaveText("—");
  await cell(page).getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText("matching current market");
});

test("hidden/synthetic views and pagehide pause queue reads, then resume overdue checks", async ({ page }) => {
  let calls = 0;
  let serverNow = NOW;
  await page.goto(await start(async () => {
    calls++;
    const at = await page.evaluate(() => Date.now());
    serverNow = at;
    return queues(at);
  }, { now: () => serverNow }));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveText("2/12");
  await visibility(page, "hidden");
  await page.clock.fastForward(70_000);
  expect(calls).toBe(1);
  await visibility(page, "visible");
  await expect.poll(() => calls).toBe(2);
  await expect(cell(page)).toHaveAttribute("data-queue-current", "true");
  await page.getByLabel("Scenario", { exact: true }).selectOption("durations");
  await page.clock.fastForward(40_000);
  expect(calls).toBe(2);
  await expect(page.locator("#queue-status")).toBeHidden();
  await page.getByLabel("Scenario", { exact: true }).selectOption("supplied");
  await page.clock.runFor(1);
  await expect.poll(() => calls).toBe(3);
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await page.clock.fastForward(40_000);
  expect(calls).toBe(3);
  await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
  await page.clock.runFor(1);
  await expect.poll(() => calls).toBe(4);
});

test("queue refresh stays independent when State fails and cannot reuse failed job timing for a running arrow", async ({ page }) => {
  let stateFails = false;
  let jobsFail = false;
  await page.goto(await start(async () => queues(await page.evaluate(() => Date.now())), {
    nodeInfoProvider: async input => {
      if (stateFails) throw new Error("Synthetic State read failed");
      return { hosts: input.map(address => ({
        address, values: { state: "HEALTHCHECK", dl: null, ul: null, ping: null, networkUnavailableReason: null },
        fetchedAtMs: NOW, validUntilMs: NOW + 30_000, retained: false, error: null,
      })) };
    },
    jobProvider: async () => {
      if (jobsFail) throw new Error("Synthetic job read failed");
      const result = await running(2, await page.evaluate(() => Date.now()));
      result.hosts[2]!.job!.timeout = 60;
      result.hosts[2]!.job!.timeStart = NOW / 1_000 - 420;
      return result;
    },
  }));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveAttribute("data-queue-retained", "true");
  stateFails = true;
  await page.clock.fastForward(20_000);
  await expect(page.locator("#node-info-status")).toContainText("Node Info refresh failed");
  await expect(cell(page)).toHaveAttribute("data-queue-current", "true");
  await expect(cell(page, 0, "duration")).toHaveText("⟵");
  // Equal-time contrary State remains a barrier after its refresh fails. The
  // independent timing is still usable, but cannot reestablish activity alone.
  await expect(cell(page, 2)).toHaveText("—");
  await expect(cell(page, 2, "duration")).toHaveAttribute("data-duration-freshness", "current");
  await expect(cell(page, 2, "duration")).toHaveAttribute("data-duration-tone", "exceeded");
  expect(jobRequests).toBe(1);
  await page.clock.runFor(1_000);
  await refresh(page);
  await expect(cell(page, 2)).toHaveText("⟶");
  expect(jobRequests).toBe(2);
  jobsFail = true;
  await refresh(page);
  await expect(page.locator("#jobs-status")).toContainText("Job refresh failed");
  await expect(cell(page, 2)).toHaveText("—");
  await expect(cell(page, 2, "duration")).toHaveAttribute("data-duration-freshness", "retained");
  await expect(cell(page, 2, "duration")).toHaveAttribute("data-duration-tone", "exceeded");
  await expect(cell(page, 2, "duration").locator(".duration-fill")).toHaveCSS("background-color", "rgb(150, 48, 48)");
  await expect(cell(page)).toHaveAttribute("data-queue-current", "true");
});
