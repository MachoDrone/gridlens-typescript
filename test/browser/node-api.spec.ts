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
import { createReconciledNodeInfoProvider } from "../../scripts/node-activity.ts";
import type { NodeInfoRecord, NodeInfoSnapshot } from "../../src/fleet/node-info.ts";
import { SYNTHETIC_HOST_ADDRESSES as addresses } from "../fixtures/host-addresses.ts";
import { emptyJobs } from "../fixtures/jobs.ts";
import { emptyQueue } from "../fixtures/queue.ts";
import { emptySol } from "../fixtures/sol.ts";

const NOW = Date.UTC(2026, 0, 1, 12);
const servers: Server[] = [];
const directories: string[] = [];
const external: string[] = [];
const errors: string[] = [];
const requests: string[] = [];
let origin = "";
type Options = NonNullable<Parameters<typeof startPreviewServer>[0]>;

function record(index: number, at = NOW): NodeInfoRecord {
  return { address: addresses[index]!, values: { state: "RUNNING_JOB", dl: null, ul: null, ping: null, networkUnavailableReason: null },
    fetchedAtMs: at, validUntilMs: at + 30_000, retained: false, error: null,
    apiCheck: { status: "online", checkedAtMs: at } };
}
function online(at = NOW): NodeInfoSnapshot {
  return { hosts: addresses.map((_address, index) => record(index, at)) };
}
function matrix(): NodeInfoSnapshot {
  const hosts = online().hosts;
  hosts[1] = { ...record(1), values: { ...record(1).values!, state: "OTHER" },
    activity: { state: null, source: "nosana-indexer", checkedAtMs: NOW, validUntilMs: NOW + 30_000, error: "Membership lookup unavailable" } };
  hosts[2] = { ...record(2), values: null, fetchedAtMs: null, validUntilMs: null, error: "Node Info unavailable (HTTP 503)",
    apiCheck: { status: "offline", checkedAtMs: NOW } };
  hosts[3] = { ...record(3), values: null, fetchedAtMs: null, validUntilMs: null, apiCheck: { status: "other", checkedAtMs: NOW } };
  const { apiCheck: _legacyRestarting, ...restarting } = record(4);
  hosts[4] = { ...restarting, values: { ...restarting.values!, state: "RESTARTING" } };
  const { apiCheck: _missing, ...missing } = record(5);
  hosts[5] = { ...missing, values: null, fetchedAtMs: null, validUntilMs: null };
  hosts[6] = { ...record(6), retained: true, error: "Node Info request failed (HTTP 503)", apiCheck: { status: "offline", checkedAtMs: NOW } };
  const { apiCheck: _legacyOther, ...legacyOther } = record(7);
  hosts[7] = { ...legacyOther, values: { ...legacyOther.values!, state: "OTHER" } };
  return { hosts };
}
async function start(nodeInfoProvider: NonNullable<Options["nodeInfoProvider"]>, now = () => NOW): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-node-api-browser-"));
  directories.push(directory);
  const hostsFile = join(directory, "hosts.json");
  await writeFile(hostsFile, JSON.stringify(addresses));
  const server = await startPreviewServer({ now, stakingProvider: emptyStaking, nosProvider: emptyNos, hostsFile, port: 0, nodeInfoProvider,
    solProvider: emptySol, jobProvider: emptyJobs, queueProvider: emptyQueue,
    metadataProvider: async input => ({ hosts: input.map(address => ({
      address, values: null, fetchedAtMs: null, retained: false, error: null, marketError: null,
    })) }),
  });
  servers.push(server);
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("Missing isolated port");
  origin = `http://127.0.0.1:${bound.port}`;
  return origin;
}
function cell(page: Page, index = 0) {
  return page.locator(`#fleet-rows [data-host="${addresses[index]}"] td[data-col="api"]`);
}

async function expectSourceDetails(page: Page, pattern: RegExp): Promise<void> {
  // Provider completion and rendering are separate turns. Inspect the current
  // disclosure rather than depending on verbose native hover text to synchronize.
  await expect.poll(async () => {
    await cell(page).getByRole("button").click();
    const source = await page.locator(".info-source-body").textContent();
    await page.keyboard.press("Escape");
    return source;
  }).toMatch(pattern);
}
async function retained(page: Page, index: number, label: "Online" | "Offline", checkedAt = NOW): Promise<void> {
  await expect(cell(page, index)).toHaveText(label);
  await expect(cell(page, index)).toHaveAttribute("data-api-current", "false");
  await expect(cell(page, index)).toHaveAttribute("data-api-checked-at", String(checkedAt));
  await expect(cell(page, index).getByRole("button")).toHaveCSS("color", label === "Online" ? "rgb(16, 232, 12)" : "rgb(255, 0, 0)");
  await expect(cell(page, index).getByRole("button")).toHaveCSS("font-weight", "400");
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
  external.length = errors.length = requests.length = 0;
  await page.clock.install({ time: NOW });
  await page.clock.pauseAt(NOW);
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith(".json")) requests.push(path);
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
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
  expect(requests.filter(path => path !== "/preview/connection.json").every(path =>
    ["hosts", "metadata", "node-info", "jobs", "queue", "sol", "nos", "staking"].some(kind => path === `/preview/${kind}.json`)),
    "API display reuses Node Info; local connection checks must not add another host-data polling endpoint").toBe(true);
});

test("API precedes State, Queued and Duration and uses Nosana green, bold red Offline and amber Populating.. independently of activity", async ({ page }, info) => {
  await page.goto(await start(async () => matrix()));
  await openPreviewTools(page);
  const labels = await page.locator("#column-headings .column-label").allTextContents();
  expect(labels).toHaveLength(28);
  expect(labels.slice(labels.indexOf("SOL"), labels.indexOf("SOL") + 6)).toEqual(["SOL", "API", "State", "Queued", "Duration", "Node run time"]);
  expect(labels).not.toContain("Host");
  const expected = ["Online", "Online", "Offline", "Unknown", "Online", "Unknown", "Offline", "Online"];
  for (const [index, label] of expected.entries()) {
    await expect(cell(page, index)).toHaveText(label === "Unknown" ? "Populating.." : label);
    await expect(cell(page, index)).toHaveAttribute("data-api-status", label);
    await expect(cell(page, index)).toHaveAttribute("data-api-current", String(label !== "Unknown"));
  }
  // Official Host UI variables.scss:$secondary and Nosana's logo SVG both use #10E80C.
  await expect(cell(page).locator(".node-api-value")).toHaveCSS("color", "rgb(16, 232, 12)");
  await expect(cell(page).locator(".node-api-value")).toHaveCSS("font-weight", "700");
  await expect(cell(page, 2).locator(".node-api-value")).toHaveCSS("color", "rgb(255, 0, 0)");
  await expect(cell(page, 2).locator(".node-api-value")).toHaveCSS("font-weight", "700");
  await expect(cell(page, 3).locator(".node-api-value")).toHaveCSS("color", "rgb(245, 158, 11)");
  await expect(cell(page, 3).locator(".node-api-value")).toHaveCSS("font-weight", "400");
  const unknownState = page.locator(`#fleet-rows [data-host="${addresses[1]}"] td[data-col="state"]`);
  await expect(unknownState.locator(".state-unknown .state-dots")).toBeVisible();
  await expect(unknownState).toHaveAttribute("data-state", "unknown");
  await expect(unknownState).toHaveAttribute("data-state-current", "false");
  await expect(unknownState.getByRole("button")).toHaveAccessibleName(/unknown/);
  await expect(cell(page, 1)).toHaveText("Online");
  await expect(cell(page, 7)).toHaveText("Online");
  await cell(page, 1).getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText(/API|reachable|response/i);
  await page.keyboard.press("Escape");
  await expect(cell(page, 1).getByRole("button")).toBeFocused();
  expect(requests.filter(path => path === "/preview/node-info.json")).toHaveLength(1);
  await page.screenshot({ path: info.outputPath("api-online-offline-populating.png"), fullPage: true });
});

test("API sorts its displayed statuses while retaining connected controls and exact host bindings", async ({ page }) => {
  await page.goto(await start(async () => matrix()));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveText("Online");
  const saved = await cell(page).getByRole("button").elementHandle();
  await page.getByRole("button", { name: "Sort by API", exact: true }).click();
  expect(await order(page)).toEqual([2, 6, 0, 1, 4, 7, 3, 5].map(index => addresses[index]));
  await page.getByRole("button", { name: "Sort by API", exact: true }).click();
  expect(await order(page)).toEqual([3, 5, 0, 1, 4, 7, 2, 6].map(index => addresses[index]));
  expect(await saved!.evaluate(button => button.isConnected)).toBe(true);
  await page.getByRole("button", { name: "Clear sort", exact: true }).click();
  expect(await order(page)).toEqual(addresses);
  expect(requests.filter(path => path === "/preview/node-info.json")).toHaveLength(1);
});

test("expired Online and Offline retain their labels in regular weight with unchanged source check times", async ({ page }) => {
  let calls = 0;
  await page.goto(await start(async () => { calls++; return matrix(); }));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveText("Online");
  await expect(cell(page, 2)).toHaveText("Offline");
  await page.clock.fastForward(20_000);
  await expect.poll(() => calls).toBe(2);
  await page.clock.fastForward(10_001);
  for (const index of [0, 1, 4, 7]) await retained(page, index, "Online");
  for (const index of [2, 6]) await retained(page, index, "Offline");
  for (const index of [3, 5]) {
    await expect(cell(page, index)).toHaveText("Populating..");
    await expect(cell(page, index)).toHaveAttribute("data-api-checked-at", "");
    await expect(cell(page, index).getByRole("button")).toHaveCSS("color", "rgb(245, 158, 11)");
  }
  await cell(page, 2).getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText("2026-01-01T12:00:00.000Z");
  await expect(page.getByRole("dialog")).toContainText(/expired|retained|last/i);
  await expect(page.getByRole("dialog")).toContainText("503");
  expect(calls).toBe(2);
});

test("existing visible Node Info refresh detects API failure and recovery while keeping focus and dialog targets", async ({ page }) => {
  let calls = 0;
  await page.goto(await start(async () => {
    calls++;
    const at = await page.evaluate(() => Date.now());
    if (calls === 2) return { hosts: online().hosts.map(record => ({ ...record, retained: true,
      error: "Node Info unavailable (HTTP 503)", apiCheck: { status: "offline" as const, checkedAtMs: at } })) };
    return online(at);
  }));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveText("Online");
  const saved = await cell(page).getByRole("button").elementHandle();
  await cell(page).getByRole("button").click();
  await page.evaluate(() => {
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
    window.dispatchEvent(new Event("blur"));
  });
  await page.clock.fastForward(20_000);
  await expect(cell(page)).toHaveText("Offline");
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await saved!.evaluate(button => button.isConnected)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(cell(page).getByRole("button")).toBeFocused();
  await page.clock.fastForward(20_000);
  await expect(cell(page)).toHaveText("Online");
  await expect(cell(page).getByRole("button")).toBeFocused();
  expect(calls).toBe(3);
  expect(requests.filter(path => path === "/preview/node-info.json")).toHaveLength(3);
});

test("preview transport failure retains the last Online in regular weight and a confirmed refresh restores green", async ({ page }) => {
  let calls = 0;
  await page.goto(await start(async () => {
    calls++;
    if (calls === 2) throw new Error("Injected preview failure before any host check");
    return online(await page.evaluate(() => Date.now()));
  }));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveText("Online");
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await retained(page, 0, "Online");
  await expect(page.locator('td[data-col="api"][data-api-status="Offline"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect(cell(page)).toHaveText("Online");
  await expect(cell(page)).toHaveAttribute("data-api-current", "true");
  await expect(cell(page).getByRole("button")).toHaveCSS("color", "rgb(16, 232, 12)");
  expect(calls).toBe(3);
});

test("hide aborts existing Node Info work; immediate resume removes bold from the retained API label and ignores the canceled failure", async ({ page }) => {
  let calls = 0;
  let serverNow = NOW;
  let pendingSignal: AbortSignal | undefined;
  let releaseOld!: () => void;
  let releaseNew!: () => void;
  const old = new Promise<void>(resolve => { releaseOld = resolve; });
  const resumed = new Promise<void>(resolve => { releaseNew = resolve; });
  await page.goto(await start(async (_input, signal) => {
    const call = ++calls;
    if (call === 2) { pendingSignal = signal; await old; }
    if (call === 3) await resumed;
    const at = await page.evaluate(() => Date.now());
    // Emission time advances with this new check; earlier proof dates stay intact.
    serverNow = at;
    return call === 2 ? { hosts: online().hosts.map(record => ({ ...record, error: "Canceled HTTP 503",
      retained: true, apiCheck: { status: "offline" as const, checkedAtMs: at } })) } : online(at);
  }, () => serverNow));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveText("Online");
  await page.clock.fastForward(20_000);
  await expect.poll(() => calls).toBe(2);
  await visibility(page, "hidden");
  await expect.poll(() => pendingSignal?.aborted).toBe(true);
  await page.clock.fastForward(60_000);
  expect(calls).toBe(2);
  await visibility(page, "visible");
  await expect.poll(() => calls).toBe(3);
  await retained(page, 0, "Online");
  releaseOld();
  await retained(page, 0, "Online");
  releaseNew();
  await expect(cell(page)).toHaveText("Online");
  await expect(cell(page)).toHaveAttribute("data-api-current", "true");
  expect(requests.filter(path => path === "/preview/node-info.json")).toHaveLength(3);
});

test("a valid raw OTHER response shows API Online before independent activity proof finishes", async ({ page }) => {
  let rawCalls = 0;
  let activityCalls = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const provider = createReconciledNodeInfoProvider({
    now: () => NOW,
    nodeInfoProvider: async input => {
      rawCalls++;
      return { hosts: input.map((address, index) => ({ ...record(index), address,
        values: { ...record(index).values!, state: "OTHER" } })) };
    },
    metadataProvider: async input => ({ hosts: input.map(address => ({ address,
      values: { status: null, marketAddress: addresses[7]!, marketLabel: null, ram: null, disk: null,
        cpu: null, cuda: null, nvidia: null, currentNode: null, system: null },
      fetchedAtMs: NOW, retained: false, error: null, marketError: null,
    })) }),
    activityProvider: async input => {
      activityCalls++;
      await held;
      return new Map(input.map(({ address }) => [address, {
        state: "QUEUED" as const, source: "nosana-indexer" as const,
        checkedAtMs: NOW, validUntilMs: NOW + 30_000, error: null,
      }]));
    },
  });
  await page.goto(await start(provider));
  await openPreviewTools(page);
  await expect.poll(() => activityCalls).toBeGreaterThan(0);
  await expect.poll(async () => { await page.clock.runFor(20); return cell(page).textContent(); }).toBe("Online");
  const unknownState = page.locator(`#fleet-rows [data-host="${addresses[0]}"] td[data-col="state"]`);
  await expect(unknownState.locator(".state-unknown .state-dots")).toBeVisible();
  await expect(unknownState).toHaveAttribute("data-state", "unknown");
  await expect(unknownState).toHaveAttribute("data-state-current", "false");
  await expect(unknownState.getByRole("button")).toHaveAccessibleName(/unknown/);
  const saved = await cell(page).getByRole("button").elementHandle();
  release();
  await expect(page.locator(`#fleet-rows [data-host="${addresses[0]}"] td[data-col="state"] .state-queued`)).toBeVisible();
  await expect(cell(page)).toHaveText("Online");
  expect(await saved!.evaluate(button => button.isConnected)).toBe(true);
  expect(rawCalls).toBe(1);
  expect(requests.filter(path => path === "/preview/node-info.json")).toHaveLength(1);
});

test("failed checks expire without any successful State evidence or another network read", async ({ page }) => {
  let calls = 0;
  const failed: NodeInfoSnapshot = { hosts: addresses.map((address, index) => ({ ...record(index), address,
    values: null, fetchedAtMs: null, validUntilMs: null, error: "Node API timed out",
    apiCheck: { status: "offline", checkedAtMs: NOW },
  })), nextRefreshAtMs: NOW + 60_000 };
  await page.goto(await start(async () => { calls++; return failed; }));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveText("Offline");
  const button = await cell(page).getByRole("button").elementHandle();
  await page.clock.fastForward(29_999);
  await expect(cell(page)).toHaveText("Offline");
  await page.clock.fastForward(2);
  await retained(page, 0, "Offline");
  expect(await button!.evaluate(value => value.isConnected)).toBe(true);
  expect(calls).toBe(1);
  expect(requests.filter(path => path === "/preview/node-info.json")).toHaveLength(1);
  await cell(page).getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText("2026-01-01T12:00:00.000Z");
  await expect(page.getByRole("dialog")).toContainText("timed out");
});

test("returning from a hidden view immediately removes bold from stale Offline before a new check completes", async ({ page }) => {
  let calls = 0;
  let serverNow = NOW;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.goto(await start(async () => {
    calls++;
    if (calls === 1) return { hosts: addresses.map((address, index) => ({ ...record(index), address,
      values: null, fetchedAtMs: null, validUntilMs: null, error: "Node API timed out",
      apiCheck: { status: "offline" as const, checkedAtMs: NOW },
    })), nextRefreshAtMs: NOW + 60_000 };
    await held;
    const at = await page.evaluate(() => Date.now());
    serverNow = at;
    return online(at);
  }, () => serverNow));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveText("Offline");
  await page.clock.fastForward(5_000);
  await visibility(page, "hidden");
  await page.clock.fastForward(300_000);
  expect(calls).toBe(1);
  await visibility(page, "visible");
  await expect.poll(() => calls).toBe(2);
  await retained(page, 0, "Offline");
  await cell(page).getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText("2026-01-01T12:00:00.000Z");
  await expect(page.getByRole("dialog")).toContainText(/expired|retained|last/i);
  release();
  await expect(cell(page)).toHaveText("Online");
  await expect(cell(page)).toHaveAttribute("data-api-current", "true");
  expect(calls).toBe(2);
});

test("a legacy failure retains verified earlier Online without inventing an Offline timestamp", async ({ page }) => {
  await page.goto(await start(async () => ({ hosts: online().hosts.map(record => {
    const { apiCheck: _check, ...legacy } = record;
    return { ...legacy, retained: true, error: "Node API request failed; attempt time unavailable" };
  }) })));
  await openPreviewTools(page);
  for (let index = 0; index < addresses.length; index++) await retained(page, index, "Online");
  await expect(page.locator('td[data-col="api"][data-api-status="Offline"]')).toHaveCount(0);
  await cell(page).getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText(/time|timestamp/i);
  expect(requests.filter(path => path === "/preview/node-info.json")).toHaveLength(1);
});

function pendingConfirmation(at: number): NodeInfoSnapshot {
  return { hosts: online().hosts.map(record => ({ ...record, retained: true,
    error: "Node Info request timed out.", apiCheck: {
      status: "other" as const, checkedAtMs: at, confirmationPending: true, lastOnlineAtMs: NOW,
      lastConfirmed: { status: "online" as const, checkedAtMs: NOW },
    },
  })), nextRefreshAtMs: at + 1_000 };
}

test("one eight-second timeout followed by a successful one-second confirmation retry never loses its confirmed Online label or flashes Offline", async ({ page }) => {
  let calls = 0;
  let releaseTimeout!: () => void;
  let releaseSuccess!: () => void;
  const timeout = new Promise<void>(resolve => { releaseTimeout = resolve; });
  const success = new Promise<void>(resolve => { releaseSuccess = resolve; });
  await page.goto(await start(async () => {
    const call = ++calls;
    if (call === 1) return { ...online(), nextRefreshAtMs: NOW + 15_000 };
    if (call === 2) { await timeout; return pendingConfirmation(await page.evaluate(() => Date.now())); }
    await success;
    const at = await page.evaluate(() => Date.now());
    return { ...online(at), nextRefreshAtMs: at + 15_000 };
  }));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveText("Online");
  const button = await cell(page).getByRole("button").elementHandle();
  await cell(page).evaluate(element => {
    const events: string[] = [];
    (window as unknown as { apiTransitions: string[] }).apiTransitions = events;
    new MutationObserver(changes => {
      for (const change of changes) {
        if (change.oldValue !== null) events.push(change.oldValue);
        events.push((change.target as HTMLElement).dataset.apiStatus ?? "");
      }
    }).observe(element, { attributes: true, attributeFilter: ["data-api-status"], attributeOldValue: true });
  });
  await page.clock.fastForward(15_000);
  await expect.poll(() => calls).toBe(2);
  await page.clock.fastForward(8_000);
  releaseTimeout();
  await expectSourceDetails(page, /confirm/i);
  await expect(cell(page)).toHaveText("Online");
  await expectSourceDetails(page, /12:00:00\.000Z/);
  await expectSourceDetails(page, /12:00:30\.000Z/);
  await page.clock.fastForward(1_000);
  await expect.poll(() => calls).toBe(3);
  await page.clock.fastForward(600);
  releaseSuccess();
  await expectSourceDetails(page, /12:00:24\.600Z/);
  await expect(cell(page)).toHaveText("Online");
  expect(await page.evaluate(() => (window as unknown as { apiTransitions: string[] }).apiTransitions.every(value => value === "Online"))).toBe(true);
  expect(await button!.evaluate(value => value.isConnected)).toBe(true);
  expect(requests.filter(path => path === "/preview/node-info.json")).toHaveLength(3);
});

test("unfinished timeout confirmation expires at the original success deadline and a second timeout keeps the last Online in regular weight", async ({ page }) => {
  let calls = 0;
  let releaseTimeout!: () => void;
  let releaseSecondFailure!: () => void;
  const timeout = new Promise<void>(resolve => { releaseTimeout = resolve; });
  const secondFailure = new Promise<void>(resolve => { releaseSecondFailure = resolve; });
  await page.goto(await start(async () => {
    const call = ++calls;
    if (call === 1) return { ...online(), nextRefreshAtMs: NOW + 15_000 };
    if (call === 2) { await timeout; return pendingConfirmation(await page.evaluate(() => Date.now())); }
    await secondFailure;
    const at = await page.evaluate(() => Date.now());
    return { hosts: online().hosts.map(record => ({ ...record, retained: true, error: "The confirmation request also timed out.",
      apiCheck: { status: "other" as const, checkedAtMs: at, failureKind: "timeout" as const,
        lastConfirmed: { status: "online" as const, checkedAtMs: NOW } },
    })), nextRefreshAtMs: at + 60_000 };
  }));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveText("Online");
  await page.clock.fastForward(15_000);
  await expect.poll(() => calls).toBe(2);
  await page.clock.fastForward(8_000);
  releaseTimeout();
  await expectSourceDetails(page, /confirm/i);
  await expect(cell(page)).toHaveText("Online");
  await page.clock.fastForward(1_000);
  await expect.poll(() => calls).toBe(3);
  await page.clock.fastForward(6_001);
  await retained(page, 0, "Online");
  await expectSourceDetails(page, /confirmation|confirm/i);

  await page.clock.fastForward(2_000);
  releaseSecondFailure();
  await retained(page, 0, "Online");
  await expectSourceDetails(page, /12:00:32\.001Z/);

  expect(requests.filter(path => path === "/preview/node-info.json")).toHaveLength(3);
});

test("confirmed Offline expires with the first HTTP 503 rather than receiving thirty more seconds from the second", async ({ page }) => {
  let calls = 0;
  await page.clock.fastForward(29_000);
  await page.goto(await start(async () => {
    calls++;
    return { hosts: online().hosts.map(record => ({ ...record, values: null, fetchedAtMs: null, validUntilMs: null,
      error: "Two node API checks returned HTTP 503", apiCheck: {
        status: "offline" as const, checkedAtMs: NOW + 29_000, firstFailedAtMs: NOW, failureKind: "http" as const, httpStatus: 503,
      },
    })), nextRefreshAtMs: NOW + 60_000 };
  }, () => NOW + 29_000));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveText("Offline");
  await expect(cell(page).getByRole("button")).toHaveCSS("color", "rgb(255, 0, 0)");
  await page.clock.fastForward(999);
  await expect(cell(page)).toHaveText("Offline");
  await page.clock.fastForward(2);
  await retained(page, 0, "Offline", NOW + 29_000);
  expect(calls).toBe(1);
  await cell(page).getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText(/503|expired/);
});

test("a fresh failure after a hidden interval cannot reuse an old first failure to flash Offline", async ({ page }) => {
  let calls = 0;
  await page.goto(await start(async () => {
    const at = await page.evaluate(() => Date.now());
    calls++;
    return { hosts: online().hosts.map(record => ({ ...record, values: null, fetchedAtMs: null, validUntilMs: null,
      error: "Node API returned HTTP 503", apiCheck: calls === 1 ? {
        status: "other" as const, checkedAtMs: NOW, firstFailedAtMs: NOW, confirmationPending: true,
      } : {
        status: "offline" as const, checkedAtMs: at, firstFailedAtMs: NOW, failureKind: "http" as const, httpStatus: 503,
      },
    })), nextRefreshAtMs: at + 1_000 };
  }));
  await openPreviewTools(page);
  await expect.poll(() => calls).toBe(1);
  await expect(cell(page)).toHaveText("Populating..");
  await cell(page).evaluate(element => {
    const observed: string[] = [];
    (window as unknown as { apiObserved: string[] }).apiObserved = observed;
    new MutationObserver(changes => {
      for (const change of changes) {
        if (change.oldValue !== null) observed.push(change.oldValue);
        observed.push((change.target as HTMLElement).dataset.apiStatus ?? "");
      }
    }).observe(element, { attributes: true, attributeFilter: ["data-api-status"], attributeOldValue: true });
  });
  await visibility(page, "hidden");
  await page.clock.fastForward(300_000);
  expect(calls).toBe(1);
  await visibility(page, "visible");
  await expect.poll(() => calls).toBe(2);
  await expect(cell(page)).toHaveText("Populating..");
  await expectSourceDetails(page, /503|expired/);
  expect(await page.evaluate(() => (window as unknown as { apiObserved: string[] }).apiObserved.includes("Offline"))).toBe(false);
  expect(requests.filter(path => path === "/preview/node-info.json")).toHaveLength(2);
});

test("a joining viewer restores a retained Offline from lastConfirmed without any previous browser snapshot", async ({ page }) => {
  let calls = 0;
  const checkedAtMs = NOW - 60_000;
  await page.goto(await start(async () => {
    calls++;
    return { hosts: online().hosts.map(record => ({ ...record, values: null, fetchedAtMs: null, validUntilMs: null,
      error: "A newer request was inconclusive", apiCheck: { status: "other" as const, checkedAtMs: NOW,
        lastConfirmed: { status: "offline" as const, checkedAtMs, firstFailedAtMs: checkedAtMs - 1_000, httpStatus: 503, nextCheckAtMs: NOW + 120_000 },
      },
    })) };
  }));
  await openPreviewTools(page);
  await retained(page, 0, "Offline", checkedAtMs);
  await cell(page).getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText("2026-01-01T11:59:00.000Z");
  await expect(page.getByRole("dialog")).toContainText(/inconclusive|retained|last/i);
  await page.keyboard.press("Escape");
  await page.reload();
  await openPreviewTools(page);
  await retained(page, 0, "Offline", checkedAtMs);
  expect(calls).toBe(2);
});

test("API colors identify outcomes while bold and regular weight distinguish all four freshness combinations", async ({ page }, info) => {
  await page.goto(await start(async () => {
    const hosts = online().hosts;
    hosts[1] = record(1, NOW - 60_000);
    hosts[2] = { ...record(2), values: null, fetchedAtMs: null, validUntilMs: null, error: "HTTP 503", apiCheck: {
      status: "offline", checkedAtMs: NOW, firstFailedAtMs: NOW - 1_000, httpStatus: 503, nextCheckAtMs: NOW + 120_000,
    } };
    hosts[3] = { ...record(3), values: null, fetchedAtMs: null, validUntilMs: null, error: "Earlier HTTP 503", apiCheck: {
      status: "offline", checkedAtMs: NOW - 60_000, firstFailedAtMs: NOW - 61_000, httpStatus: 503, nextCheckAtMs: NOW - 10_000,
    } };
    hosts[4] = { ...record(4), values: null, fetchedAtMs: null, validUntilMs: null, apiCheck: { status: "other", checkedAtMs: NOW } };
    return { hosts, nextRefreshAtMs: NOW + 150_000 };
  }));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveText("Online");
  await expect(cell(page)).toHaveAttribute("data-api-current", "true");
  await expect(cell(page).getByRole("button")).toHaveCSS("color", "rgb(16, 232, 12)");
  await expect(cell(page).getByRole("button")).toHaveCSS("font-weight", "700");
  await retained(page, 1, "Online", NOW - 60_000);
  await expect(cell(page, 2)).toHaveText("Offline");
  await expect(cell(page, 2)).toHaveAttribute("data-api-current", "true");
  await expect(cell(page, 2).getByRole("button")).toHaveCSS("color", "rgb(255, 0, 0)");
  await expect(cell(page, 2).getByRole("button")).toHaveCSS("font-weight", "700");
  await retained(page, 3, "Offline", NOW - 60_000);
  await expect(cell(page, 4)).toHaveText("Populating..");
  await expect(cell(page, 4).getByRole("button")).toHaveCSS("color", "rgb(245, 158, 11)");
  await expect(cell(page, 4).getByRole("button")).toHaveCSS("font-weight", "400");
  await page.screenshot({ path: info.outputPath("api-status-weight-freshness.png"), fullPage: true });
});

test("scheduled Offline remains bold past thirty seconds and becomes regular red at retry plus eight seconds", async ({ page }) => {
  let calls = 0;
  const snapshot: NodeInfoSnapshot = { hosts: online().hosts.map(record => ({ ...record,
    values: null, fetchedAtMs: null, validUntilMs: null, error: "HTTP 503", apiCheck: {
      status: "offline", checkedAtMs: NOW, firstFailedAtMs: NOW - 1_000, httpStatus: 503, nextCheckAtMs: NOW + 120_000,
    },
  })), nextRefreshAtMs: NOW + 300_000 };
  await page.goto(await start(async () => { calls++; return snapshot; }));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveText("Offline");
  await expect(cell(page).getByRole("button")).toHaveCSS("font-weight", "700");
  await page.clock.fastForward(31_000);
  await expect(cell(page)).toHaveAttribute("data-api-current", "true");
  await expect(cell(page).getByRole("button")).toHaveCSS("color", "rgb(255, 0, 0)");
  await expect(cell(page).getByRole("button")).toHaveCSS("font-weight", "700");
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect.poll(() => calls).toBe(2);
  await page.clock.fastForward(96_999);
  await expect(cell(page)).toHaveAttribute("data-api-current", "true");
  await page.clock.fastForward(2);
  await retained(page, 0, "Offline");
  await cell(page).getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText("2026-01-01T12:00:00.000Z");
  expect(calls).toBe(2);
});
