import { openPreviewTools } from "./helpers.ts";
import { emptyStaking } from "../fixtures/staking.ts";
import { emptyNos } from "../fixtures/nos.ts";
import { emptySol } from "../fixtures/sol.ts";
import { emptyQueue } from "../fixtures/queue.ts";
import { emptyJobs } from "../fixtures/jobs.ts";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPreviewServer } from "../../scripts/preview-server.ts";
import type { HostMetadataSnapshot } from "../../src/fleet/host-metadata.ts";
import type { NodeInfoRecord, NodeInfoSnapshot, NodeInfoValues } from "../../src/fleet/node-info.ts";
import { SYNTHETIC_HOST_ADDRESSES } from "../fixtures/host-addresses.ts";

// Artificial public identities and injected observations only. The test server
// and browser must never query Nosana or a real host.
const addresses = SYNTHETIC_HOST_ADDRESSES;
const states = ["RUNNING_JOB", "QUEUED", "BENCHMARKING", "HEALTHCHECK", "STARTING", "RESTARTING", "JOINING_MARKET", "OTHER"];
const NOW = Date.UTC(2026, 0, 1, 12);
const servers: Server[] = [];
const directories: string[] = [];
const externalRequests: string[] = [];
const browserErrors: string[] = [];
const nodeRequests: string[] = [];
let origin = "";

function record(index: number, values: Partial<NodeInfoValues> | null = {}): NodeInfoRecord {
  return {
    address: addresses[index]!,
    values: values === null ? null : {
      state: states[index]!, dl: 604.49, ul: 36.6, ping: 21.8,
      networkUnavailableReason: null, ...values,
    },
    fetchedAtMs: values === null ? null : NOW,
    validUntilMs: values === null ? null : NOW + 30_000,
    retained: false, error: null,
  };
}

function snapshot(): NodeInfoSnapshot {
  return { hosts: addresses.map((_address, index) => record(index)) };
}

function emptyMetadata(input: readonly string[]): Promise<HostMetadataSnapshot> {
  return Promise.resolve({ hosts: input.map(address => ({
    address, values: null, fetchedAtMs: null, retained: false, error: null, marketError: null,
  })) });
}

async function start(
  provider: (input: readonly string[]) => Promise<NodeInfoSnapshot>,
  metadataProvider = emptyMetadata,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-node-info-browser-"));
  directories.push(directory);
  const hostsFile = join(directory, "hosts.json");
  await writeFile(hostsFile, JSON.stringify(addresses));
  const server = await startPreviewServer({ now: () => NOW, stakingProvider: emptyStaking, nosProvider: emptyNos, solProvider: emptySol, queueProvider: emptyQueue, jobProvider: emptyJobs, hostsFile, port: 0, nodeInfoProvider: provider, metadataProvider });
  servers.push(server);
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("Missing isolated preview port");
  origin = `http://127.0.0.1:${bound.port}`;
  return origin;
}

function cell(page: Page, key: string, index = 0) {
  return page.locator(`#fleet-rows [data-host="${addresses[index]}"] td[data-col="${key}"]`);
}

async function expectUnknown(page: Page, index: number): Promise<void> {
  const state = cell(page, "state", index);
  await expect(state).toHaveAttribute("data-state", "unknown");
  await expect(state).toHaveAttribute("data-state-current", "false");
  await expect(state.getByRole("button")).toHaveAccessibleName(/unknown/i);
  await expect(state.locator(".state-unknown .state-dots")).toBeVisible();
  await expect(state.locator(".state-unknown")).toHaveCSS("color", "rgb(99, 64, 6)");
  await expect(state.locator(".state-running, .state-queued, .state-restarting")).toHaveCount(0);
}

async function hostOrder(page: Page): Promise<string[]> {
  return page.locator("#fleet-rows [data-host]").evaluateAll(rows => rows.map(row => row.getAttribute("data-host") ?? ""));
}

async function setPageHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate(isHidden => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => isHidden ? "hidden" : "visible" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => isHidden });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

test.beforeEach(async ({ context, page }) => {
  origin = "";
  externalRequests.length = 0;
  browserErrors.length = 0;
  nodeRequests.length = 0;
  await page.clock.install({ time: NOW });
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) {
      externalRequests.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/preview/node-info.json") nodeRequests.push(request.url());
  });
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") browserErrors.push(message.text()); });
});

test.afterEach(async ({ page }) => {
  // End browser polling before closing its isolated provider server.
  await page.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  expect(externalRequests, "Node Info fixtures must never contact real services").toEqual([]);
  expect(browserErrors, "No browser runtime or loading errors").toEqual([]);
});

test("all eight states preserve exact meanings and compact Fleet artwork without populating unrelated columns", async ({ page }, info) => {
  const calls: string[][] = [];
  await page.goto(await start(async input => { calls.push([...input]); return snapshot(); }));
  await openPreviewTools(page);
  for (const [index, state] of states.entries()) {
    await expect(cell(page, "state", index).getByRole("button")).toHaveAccessibleName(state === "OTHER" ? /unknown/i : new RegExp(state));
  }
  await expect(cell(page, "state").locator(".state-running")).toBeVisible();
  await expect(cell(page, "state", 1).locator(".state-queued")).toBeVisible();
  for (const index of [4, 5]) {
    await expect(cell(page, "state", index).locator(".state-restarting")).toBeVisible();
    await expect(cell(page, "state", index).locator(".state-restarting")).toHaveCSS("color", "rgb(245, 158, 11)");
  }
  for (const [index, letter] of [[2, "B"], [3, "H"], [6, "J"]] as const) {
    await expect(cell(page, "state", index).getByRole("button")).toHaveText(letter);
  }
  await expectUnknown(page, 7);
  await expect(cell(page, "duration")).toHaveText("Populating..");
  for (const key of ["status", "gpuID", "nodeRuntime", "dailyUptime", "latestJob", "queued"]) {
    await expect(key === "latestJob" ? cell(page, key).locator(".job-summary-link") : cell(page, key)).toHaveText("—");
  }
  await expect(page.locator("#column-headings th[data-col]")).toHaveCount(28);
  await expect(page.locator("#fleet-rows [data-host]")).toHaveCount(8);
  for (const row of await page.locator("#fleet-rows [data-host]").all()) {
    expect(await row.evaluate(element => element.getBoundingClientRect().height)).toBe(34);
  }
  expect(calls).toEqual([addresses]);
  await cell(page, "state", 1).getByRole("button").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toContainText("QUEUED");
  await expect(page.getByRole("dialog")).not.toContainText("RESTARTING");
  await page.keyboard.press("Escape");
  await page.screenshot({ path: info.outputPath("node-info-eight-states.png"), fullPage: true });
  await page.getByRole("button", { name: "Sort by State", exact: true }).click();
  expect(await hostOrder(page)).toEqual([2, 3, 6, 1, 5, 0, 4, 7].map(index => addresses[index]));
  await page.getByRole("button", { name: "Sort by State", exact: true }).click();
  expect(await hostOrder(page)).toEqual([4, 0, 5, 1, 6, 3, 2, 7].map(index => addresses[index]));
});

test("Fleet artwork animates fresh observations and remains legible with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(await start(async () => snapshot()));
  await openPreviewTools(page);
  await page.getByLabel("State animation", { exact: true }).selectOption("system");
  const running = cell(page, "state").locator(".state-running-ring");
  const queued = cell(page, "state", 1).locator(".state-queue-dot").first();
  const starting = cell(page, "state", 4).locator(".state-dots");
  const restarting = cell(page, "state", 5).locator(".state-dots");
  const unknown = cell(page, "state", 7).locator(".state-unknown .state-dots");
  for (const animation of [running, queued, starting, restarting, unknown]) await expect(animation).not.toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const animation of [running, queued, starting, restarting, unknown]) {
    await expect(animation).toHaveCSS("animation-name", "none");
    await expect(animation).toBeVisible();
  }
  await expect(queued).toHaveAttribute("cx", "12");
  await expect(queued).toHaveAttribute("cy", "8");
});

test("network numbers round for display and sort by actual readings without row controls", async ({ page }) => {
  await page.goto(await start(async () => ({ hosts: [
    record(0, { dl: 100.4, ul: 0, ping: 0 }),
    record(1, { dl: 100.3, ul: 0.4, ping: 0.4 }),
    record(2, { dl: null, ul: null, ping: null, networkUnavailableReason: "Node reported all-zero network placeholders; measurements unavailable." }),
    ...addresses.slice(3).map((_address, index) => record(index + 3, null)),
  ] })));
  await openPreviewTools(page);
  await expect(cell(page, "dl")).toHaveText("100");
  await expect(cell(page, "dl", 1)).toHaveText("100");
  await expect(cell(page, "ul")).toHaveText("0");
  await expect(cell(page, "ping")).toHaveText("0");
  await page.getByRole("button", { name: "Sort by DL", exact: true }).click();
  expect(await hostOrder(page)).toEqual([addresses[1], addresses[0], ...addresses.slice(2)]);
  await page.getByRole("button", { name: "Sort by DL", exact: true }).click();
  expect(await hostOrder(page)).toEqual(addresses);
  await expect(cell(page, "dl").locator(".node-info-value")).toHaveAttribute("aria-label", /100\.4 Mbps/);
  await expect(cell(page, "ping", 1).locator(".node-info-value")).toHaveAttribute("aria-label", /0\.4 ms/);
  for (const key of ["dl", "ul", "ping"]) {
    await expect(cell(page, key).getByRole("button")).toHaveCount(0);
    await expect(cell(page, key)).not.toHaveAttribute("title");
    await expect(cell(page, key, 2)).toHaveText("—");
    await expect(cell(page, key, 2).locator(".node-info-value")).toHaveAttribute("aria-label", /unknown/i);
    await cell(page, key).click();
    await expect(page.getByRole("dialog")).toBeHidden();
  }
});

test("hidden state resumes with expired dim animated artwork without falsely marking the host stopped", async ({ page }) => {
  let calls = 0;
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(await start(async () => { calls++; return snapshot(); }));
  await openPreviewTools(page);
  await expect(cell(page, "state").locator(".state-running")).toBeVisible();
  await cell(page, "state").getByRole("button").focus();
  await setPageHidden(page, true);
  await page.clock.fastForward(31_000);
  expect(calls).toBe(1);
  expect(nodeRequests).toHaveLength(1);
  await setPageHidden(page, false);
  await expect.poll(() => calls).toBe(2);
  await expect(cell(page, "state").locator(".state-running")).toBeVisible();
  await expect(cell(page, "state").getByRole("button")).toBeFocused();
  await expect(cell(page, "state").locator(".state-running")).toHaveCSS("color", "rgb(36, 78, 148)");
  await cell(page, "state").getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText("RUNNING_JOB");
  await expect(page.getByRole("dialog")).toContainText(/current.*unknown|last reported|retained/i);
  await expect(page.getByRole("dialog")).not.toContainText("STOPPED");
  await page.keyboard.press("Escape");
  const animated = cell(page, "state").locator("*");
  expect(await animated.evaluateAll(elements => elements.some(element => getComputedStyle(element).animationName !== "none"))).toBe(true);
  await expect(page.locator('#column-headings [data-col="hostSignal"]')).toHaveCount(0);
  expect(calls).toBe(2);
  expect(nodeRequests).toHaveLength(2);
});

test("retained failures recover while OTHER stays distinct from unavailable or unfamiliar states", async ({ page }) => {
  let calls = 0;
  await page.goto(await start(async () => {
    calls++;
    const result = { hosts: [record(0), record(1, { state: "OTHER" }), record(2, null),
      record(3, { state: "FUTURE_STATE" }), ...addresses.slice(4).map((_address, index) => record(index + 4, null))] };
    if (calls === 2) return { hosts: result.hosts.map(host => ({ ...host, retained: host.values !== null, error: "Node Info unavailable (HTTP 503)." })) };
    return result;
  }));
  await openPreviewTools(page);
  for (const index of [1, 2, 3]) await expectUnknown(page, index);
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect(page.locator("#node-info-status")).toContainText(/retained|failed|unavailable/i);
  await expect(cell(page, "state").locator(".state-running")).toBeVisible();
  await expect(cell(page, "state").locator(".state-running-ring")).not.toHaveCSS("animation-name", "none");
  await expect(cell(page, "state").locator(".state-running")).toHaveCSS("color", "rgb(36, 78, 148)");
  for (const index of [1, 2, 3]) await expectUnknown(page, index);
  await cell(page, "state").getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText("503");
  await expect(page.getByRole("dialog")).toContainText(/retained|last reported/i);
  await page.keyboard.press("Escape");
  await expect(cell(page, "dl")).toHaveText("604");
  await expect(cell(page, "dl").locator(".node-info-value")).toHaveClass(/node-network-retained/);
  await expect(cell(page, "dl").locator(".node-info-value")).toHaveAttribute("aria-label", /604\.49 Mbps/);
  await expect(cell(page, "dl").getByRole("button")).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect(page.locator("#node-info-status")).not.toContainText("503");
  await expect(cell(page, "state").locator(".state-running")).toBeVisible();
  for (const index of [1, 2, 3]) await expectUnknown(page, index);
  expect(calls).toBe(3);
});

test("metadata failures do not override current Node Info and synthetic views issue no additional requests", async ({ page }) => {
  let nodeCalls = 0;
  let metadataCalls = 0;
  await page.goto(await start(async () => { nodeCalls++; return snapshot(); }, async input => {
    metadataCalls++;
    const result = await emptyMetadata(input);
    return { hosts: result.hosts.map(host => ({ ...host, error: "Metrics failed (HTTP 429)." })) };
  }));
  await openPreviewTools(page);
  await expect(cell(page, "state").locator(".state-running")).toBeVisible();
  await expect(cell(page, "dl")).toHaveText("604");
  await expect(cell(page, "status")).toHaveText("—");
  await page.getByRole("button", { name: "Sort by State", exact: true }).click();
  await page.getByRole("button", { name: "Toggle Market display", exact: true }).click();
  await page.getByLabel("Scenario", { exact: true }).selectOption("mixed");
  await expect(page.locator("#node-info-status")).toBeHidden();
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await page.clock.fastForward(300_000);
  expect(nodeCalls).toBe(1);
  expect(metadataCalls).toBe(1);
  expect(nodeRequests).toHaveLength(1);
});

test("starting in samples contacts neither provider and an in-flight Node Info response cannot overwrite samples", async ({ page }) => {
  let nodeCalls = 0;
  let metadataCalls = 0;
  let release: ((value: NodeInfoSnapshot) => void) | undefined;
  const pending = new Promise<NodeInfoSnapshot>(resolve => { release = resolve; });
  const url = await start(async () => { nodeCalls++; return pending; }, async input => { metadataCalls++; return emptyMetadata(input); });
  await page.goto(`${url}/?scenario=mixed`);
  await openPreviewTools(page);
  await expect(page.locator("#host-count")).toHaveText("6 hosts");
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  expect(nodeCalls).toBe(0);
  expect(metadataCalls).toBe(0);
  await page.getByLabel("Scenario", { exact: true }).selectOption("supplied");
  await expect.poll(() => nodeCalls).toBe(1);
  const canceled = page.waitForEvent("requestfailed", request =>
    new URL(request.url()).pathname === "/preview/node-info.json");
  await page.getByLabel("Scenario", { exact: true }).selectOption("mixed");
  await canceled;
  // The injected provider deliberately finishes late despite its canceled consumer.
  release!(snapshot());
  await expect(page.locator("#host-count")).toHaveText("6 hosts");
  await expect(page.locator('#fleet-rows [data-source="supplied"]')).toHaveCount(0);
  await expect(page.locator("#node-info-status")).toBeHidden();
});

test("Node states scenario demonstrates all eight categories and expires independently of supplied data", async ({ page }) => {
  let calls = 0;
  const url = await start(async () => { calls++; return snapshot(); }, async input => { calls++; return emptyMetadata(input); });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(`${url}/?scenario=states`);
  await openPreviewTools(page);
  await expect(page.locator("#host-count")).toHaveText("8 hosts");
  await expect(page.getByText("Sample data", { exact: true })).toBeVisible();
  const stateCells = page.locator('#fleet-rows td[data-col="state"]');
  for (const [index, state] of states.entries()) {
    await expect(stateCells.nth(index).getByRole("button")).toHaveAccessibleName(state === "OTHER" ? /unknown/i : new RegExp(state));
  }
  await expect(page.locator('#fleet-rows td[data-col="dl"]').first()).toHaveText("101");
  await expect(page.locator('#fleet-rows td[data-col="ul"]').first()).toHaveText("51");
  await expect(page.locator('#fleet-rows td[data-col="ping"]').first()).toHaveText("10");
  await expect(stateCells.first().locator(".state-running")).toBeVisible();
  await page.getByRole("button", { name: "Advance 30s", exact: true }).click();
  await expect(stateCells.first().locator(".state-running")).toBeVisible();
  await expect(stateCells.first().locator(".state-running-ring")).not.toHaveCSS("animation-name", "none");
  await expect(stateCells.first().locator(".state-running")).toHaveCSS("color", "rgb(36, 78, 148)");
  await expect(stateCells.first().getByRole("button")).toHaveAccessibleName(/stale|retained/i);
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect(stateCells.first().getByRole("button")).toHaveAccessibleName(/stale|retained/i);
  await page.getByRole("button", { name: "Reset sample", exact: true }).click();
  await expect(stateCells.first().locator(".state-running")).toBeVisible();
  expect(calls).toBe(0);
  expect(nodeRequests).toEqual([]);
});

function activity(
  state: "RUNNING_JOB" | "QUEUED" | null,
  overrides: Partial<NonNullable<NodeInfoRecord["activity"]>> = {},
): NonNullable<NodeInfoRecord["activity"]> {
  return {
    state, source: "nosana-indexer", checkedAtMs: NOW, validUntilMs: NOW + 30_000,
    error: null, ...overrides,
  };
}

test("indexer membership resolves OTHER with Fleet artwork while preserving raw state and full-state sorting", async ({ page }) => {
  const observations = snapshot();
  observations.hosts[0] = { ...record(0, { state: "OTHER" }), activity: activity("RUNNING_JOB") };
  observations.hosts[1] = { ...record(1, { state: "OTHER" }), activity: activity("QUEUED") };
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(await start(async () => observations));
  await openPreviewTools(page);
  await expect(cell(page, "state").getByRole("button")).toHaveAccessibleName(/RUNNING_JOB/);
  await expect(cell(page, "state").locator(".state-running")).toBeVisible();
  await expect(cell(page, "state").locator(".state-running-ring")).not.toHaveCSS("animation-name", "none");
  await expect(cell(page, "state", 1).locator(".state-queued")).toBeVisible();
  await cell(page, "state").getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText("RUNNING_JOB");
  await expect(page.getByRole("dialog")).toContainText("OTHER");
  await expect(page.getByRole("dialog")).toContainText(/indexer/i);
  await expect(page.getByRole("dialog")).toContainText(/watermark|source.*time|timestamp/i);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Sort by State", exact: true }).click();
  expect(await hostOrder(page)).toEqual([2, 3, 6, 1, 5, 0, 4, 7].map(index => addresses[index]));
  await page.getByRole("button", { name: "Sort by State", exact: true }).click();
  expect(await hostOrder(page)).toEqual([4, 0, 5, 1, 6, 3, 2, 7].map(index => addresses[index]));
  for (const key of ["latestJob", "queued"]) await expect(key === "latestJob" ? cell(page, key).locator(".job-summary-link") : cell(page, key)).toHaveText("—");
  expect(observations.hosts[0]!.values!.state).toBe("OTHER");
  expect(observations.hosts[0]!.fetchedAtMs).toBe(NOW);
  expect(nodeRequests).toHaveLength(1);
});

test("unconfirmed, conflicting and failed indexer evidence leave OTHER activity unknown without overriding explicit states", async ({ page }) => {
  const observations = { hosts: [
    { ...record(0, { state: "OTHER" }), activity: activity(null) },
    { ...record(1, { state: "OTHER" }), activity: activity(null, { error: "Conflicting running and queued membership." }) },
    { ...record(2, { state: "OTHER" }), activity: activity("RUNNING_JOB", { error: "Indexer unavailable (HTTP 503)." }) },
    { ...record(3, { state: "OTHER" }), activity: activity("RUNNING_JOB", { checkedAtMs: null, validUntilMs: null }) },
    { ...record(4, { state: "QUEUED" }), activity: activity("RUNNING_JOB") },
    { ...record(5, { state: "RESTARTING" }), activity: activity(null, { error: "Indexer unavailable (HTTP 429)." }) },
    record(6, { state: "OTHER" }),
    record(7, null),
  ] };
  await page.goto(await start(async () => observations));
  await openPreviewTools(page);
  for (const index of [0, 1, 2, 3]) {
    await expectUnknown(page, index);
    await expect(cell(page, "dl", index)).toHaveText("604");
    await cell(page, "state", index).getByRole("button").click();
    await expect(page.getByRole("dialog")).toContainText("OTHER");
    await expect(page.getByRole("dialog")).toContainText(/unknown/i);
    if (index === 1) await expect(page.getByRole("dialog")).toContainText(/conflict/i);
    if (index === 2) await expect(page.getByRole("dialog")).toContainText("503");
    await page.keyboard.press("Escape");
  }
  await expect(cell(page, "state", 4).locator(".state-queued")).toBeVisible();
  await expect(cell(page, "state", 4).locator(".state-running")).toHaveCount(0);
  await expect(cell(page, "state", 5).locator(".state-restarting")).toBeVisible();
  await expectUnknown(page, 6);
  await expectUnknown(page, 7);
  await page.getByRole("button", { name: "Sort by State", exact: true }).click();
  expect(await hostOrder(page)).toEqual([4, 5, 0, 1, 2, 3, 6, 7].map(index => addresses[index]));
});

test("reconciled state expires at its earliest evidence deadline during a pending read without losing keyboard focus", async ({ page }) => {
  let calls = 0;
  let release!: (value: NodeInfoSnapshot) => void;
  const pending = new Promise<NodeInfoSnapshot>(resolve => { release = resolve; });
  const observations = { hosts: [
    { ...record(0, { state: "OTHER" }), activity: activity("RUNNING_JOB", { validUntilMs: NOW + 5_000 }) },
    { ...record(1, { state: "OTHER" }), validUntilMs: NOW + 8_000, activity: activity("RUNNING_JOB") },
    { ...record(2, { state: "OTHER" }), activity: activity("RUNNING_JOB", { checkedAtMs: NOW - 20_000 }) },
    ...addresses.slice(3).map((_address, index) => record(index + 3, null)),
  ] };
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(await start(async () => ++calls === 1 ? observations : pending));
  await openPreviewTools(page);
  for (const index of [0, 1, 2]) await expect(cell(page, "state", index).locator(".state-running")).toBeVisible();
  await cell(page, "state").getByRole("button").focus();
  await page.clock.fastForward(5_100);
  await expect(cell(page, "state").getByRole("button")).toBeFocused();
  await expect(cell(page, "state").locator(".state-running")).toBeVisible();
  await expect(cell(page, "state").locator(".state-running-ring")).not.toHaveCSS("animation-name", "none");
  await expect(cell(page, "state").getByRole("button")).toHaveAccessibleName(/stale|retained/i);
  await expect(cell(page, "state", 1).locator(".state-running")).toBeVisible();
  await expect(cell(page, "state", 2).locator(".state-running")).toBeVisible();
  await page.clock.fastForward(3_000);
  await expect(cell(page, "state", 1).locator(".state-running")).toBeVisible();
  await expect(cell(page, "state", 1).locator(".state-running-ring")).not.toHaveCSS("animation-name", "none");
  await expect(cell(page, "state", 2).locator(".state-running")).toBeVisible();
  await page.clock.fastForward(2_000);
  await expect(cell(page, "state", 2).locator(".state-running")).toBeVisible();
  await expect(cell(page, "state", 2).locator(".state-running-ring")).not.toHaveCSS("animation-name", "none");
  for (const index of [0, 1, 2]) {
    await expect(cell(page, "state", index).locator(".state-running")).toHaveCSS("color", "rgb(36, 78, 148)");
    expect(await cell(page, "state", index).locator("*").evaluateAll(elements => elements.some(element => getComputedStyle(element).animationName !== "none"))).toBe(true);
    await expect(cell(page, "dl", index)).toHaveText("604");
  }
  expect(calls).toBe(2);
  expect(nodeRequests).toHaveLength(2);
  expect(observations.hosts[0]!.fetchedAtMs).toBe(NOW);
  expect(observations.hosts[0]!.values!.state).toBe("OTHER");
  release(observations);
  await expect(page.locator("#node-info-status")).not.toContainText(/loading/i);
});

test("fresh indexer evidence cannot revive failed or expired Node Info and metadata failure stays independent", async ({ page }) => {
  const observations = { hosts: [
    { ...record(0, { state: "OTHER" }), activity: activity("RUNNING_JOB") },
    { ...record(1, { state: "OTHER" }), error: "Node Info unavailable (HTTP 502).", retained: true, activity: activity("RUNNING_JOB") },
    { ...record(2, { state: "OTHER" }), fetchedAtMs: NOW - 30_000, validUntilMs: NOW, activity: activity("RUNNING_JOB") },
    { ...record(3, { state: "OTHER" }), activity: activity("RUNNING_JOB", { checkedAtMs: NOW - 30_000, validUntilMs: NOW }) },
    ...addresses.slice(4).map((_address, index) => record(index + 4, null)),
  ] };
  await page.goto(await start(async () => observations, async input => {
    const result = await emptyMetadata(input);
    return { hosts: result.hosts.map(host => ({ ...host, error: "Metrics unavailable (HTTP 429)." })) };
  }));
  await openPreviewTools(page);
  await expect(cell(page, "state").locator(".state-running")).toBeVisible();
  await expect(cell(page, "status")).toHaveText("—");
  for (const index of [1, 2, 3]) {
    await expect(cell(page, "state", index).locator(".state-running")).toBeVisible();
    await expect(cell(page, "state", index).locator(".state-running-ring")).not.toHaveCSS("animation-name", "none");
    await expect(cell(page, "state", index).locator(".state-running")).toHaveCSS("color", "rgb(36, 78, 148)");
    await expect(cell(page, "state", index).getByRole("button")).toHaveAccessibleName(/stale|retained/i);
    await expect(cell(page, "dl", index)).toHaveText("604");
  }
  await cell(page, "state", 1).getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText("502");
  await expect(page.getByRole("dialog")).toContainText("OTHER");
  await page.keyboard.press("Escape");
  await expect(cell(page, "dl", 1).locator(".node-info-value")).toHaveClass(/node-network-retained/);
  await expect(cell(page, "dl", 1).locator(".node-info-value")).toHaveAttribute("aria-label", /604\.49 Mbps/);
  await expect(cell(page, "dl", 1).getByRole("button")).toHaveCount(0);
  expect(nodeRequests).toHaveLength(1);
});
