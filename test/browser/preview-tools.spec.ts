import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPreviewServer } from "../../scripts/preview-server.ts";
import { SYNTHETIC_HOST_ADDRESSES as addresses } from "../fixtures/host-addresses.ts";
import { emptyJobs } from "../fixtures/jobs.ts";
import { emptyQueue } from "../fixtures/queue.ts";
import { emptySol } from "../fixtures/sol.ts";
import { emptyNos } from "../fixtures/nos.ts";
import { emptyStaking } from "../fixtures/staking.ts";

const NOW = Date.UTC(2026, 0, 1, 12);
let responseTime = NOW;
const servers: Server[] = [];
const directories: string[] = [];
const errors: string[] = [];
const externalRequests: string[] = [];
const requests: string[] = [];
const providers: { kind: string; addresses: string[] }[] = [];
const controlIDs = ["advance-time", "refresh-view", "reset-sample", "state-motion", "duration-motion", "column-info"];
const diagnosticIDs = ["data-label", "connection-note", "local-source-note", "inventory-summary", "table-help", "sort-status", "scenario-description", "sol-status", "nos-status", "staking-status", "metadata-status", "node-info-status", "jobs-status", "queue-status", "clock-help", "inventory-details"];
let origin = "";

async function start(page: Page): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-preview-tools-browser-"));
  directories.push(directory);
  const hostsFile = join(directory, "hosts.json");
  const real200HostsFile = join(directory, "real200.json");
  await writeFile(hostsFile, JSON.stringify(addresses));
  await writeFile(real200HostsFile, JSON.stringify(addresses.slice(0, 4)));
  const record = (kind: string, input: readonly string[]) => providers.push({ kind, addresses: [...input] });
  const server = await startPreviewServer({ now: () => responseTime, hostsFile, real200HostsFile, port: 0,
    metadataProvider: async input => {
      record("metadata", input);
      return { hosts: input.map(address => ({ address, values: { status: "PREMIUM", marketAddress: null,
        marketLabel: null, ram: 64, disk: 700, cpu: "Synthetic CPU", cuda: null, nvidia: null, currentNode: null, system: null },
      fetchedAtMs: NOW, retained: false, error: null, marketError: null })) };
    },
    nodeInfoProvider: async input => {
      record("node-info", input);
      const at = await page.evaluate(() => Date.now());
      return { hosts: input.map(address => ({ address,
        values: { state: at > NOW ? "RESTARTING" : "RUNNING_JOB", dl: 100, ul: 20, ping: 8, networkUnavailableReason: null },
        fetchedAtMs: at, validUntilMs: at + 30_000, retained: false, error: null })) };
    },
    jobProvider: async input => { record("jobs", input); return emptyJobs(input); },
    queueProvider: async input => { record("queue", input); return emptyQueue(input); },
    solProvider: async input => { record("sol", input); return emptySol(input); },
    nosProvider: async input => { record("nos", input); return emptyNos(input); },
    stakingProvider: async input => { record("staking", input); return emptyStaking(input); },
  });
  servers.push(server);
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("Missing isolated preview port");
  origin = `http://127.0.0.1:${bound.port}`;
  return origin;
}

function panel(page: Page) { return page.locator("#preview-tools"); }
function summary(page: Page) { return panel(page).locator(":scope > summary"); }

async function expectCollapsed(page: Page): Promise<void> {
  await expect(panel(page)).not.toHaveAttribute("open");
  await expect(summary(page)).toHaveText("Tools & diagnostics");
  await expect(summary(page)).toBeVisible();
  await expect(page.getByLabel("Scenario", { exact: true })).toBeVisible();
  expect(await page.locator("#scenario").evaluate(element => element.closest("#preview-tools") === null)).toBe(true);
  const hiddenSelectors = [...controlIDs, ...diagnosticIDs].map(id => `#${id}`).concat([".wordmark", ".sample-notice"]);
  // Check every former top status and lower diagnostic in one browser read;
  // repeating separate locator assertions for each scenario makes this slow.
  expect(await page.evaluate(selectors => selectors.map(selector => {
    const matches = [...document.querySelectorAll(selector)];
    return { selector, count: matches.length,
      insideTools: matches.every(element => element.closest("#preview-tools") !== null),
      hidden: matches.every(element => !element.checkVisibility({ visibilityProperty: true })) };
  }), hiddenSelectors)).toEqual(hiddenSelectors.map(selector => ({ selector, count: 1, insideTools: true, hidden: true })));
  await expect(page.locator("footer")).toBeHidden();
  await expect(page.getByRole("button", { name: "Refresh view", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Column info", exact: true })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "State animation", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "Nosana Fleet", exact: true })).toBeVisible();
  await expect(page.locator("#host-count")).toBeVisible();
  await expect(page.getByRole("button", { name: "Clear sort", exact: true })).toBeVisible();
  expect(await page.locator("#sample-clock").evaluate(element => element.closest("#preview-tools") === null)).toBe(true);
  const visibleBelow = await page.locator("main").evaluate(main => {
    const children = [...main.children];
    const table = children.findIndex(element => element.classList.contains("fleet-table-wrap"));
    return children.slice(table + 1).flatMap(element => [...element.querySelectorAll("button, select, summary")])
      .filter(element => {
        const closed = element.closest("details:not([open])");
        return (!closed || closed.firstElementChild === element) &&
          element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
      })
      .map(element => element.id || element.parentElement?.id);
  });
  expect(visibleBelow).toEqual(["scenario", "preview-tools"]);
}

async function evidence(page: Page) {
  return page.evaluate(() => ({
    clock: document.querySelector("#sample-clock")!.textContent,
    rows: [...document.querySelectorAll<HTMLElement>("#fleet-rows tr")].map(row => ({ host: row.dataset.host,
      state: row.querySelector<HTMLElement>('[data-col="state"]')?.dataset,
      duration: row.querySelector<HTMLElement>('[data-col="duration"]')?.dataset,
      observedAt: row.dataset.observedAt })),
  }));
}

test.beforeEach(async ({ context, page }) => {
  origin = "";
  errors.length = externalRequests.length = requests.length = providers.length = 0;
  await page.clock.install({ time: NOW });
  await page.clock.pauseAt(NOW);
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { externalRequests.push(url.href); return route.abort(); }
    // The connection indicator may check the local service without reading data.
    if (url.pathname.startsWith("/preview/") && url.pathname.endsWith(".json") &&
        url.pathname !== "/preview/connection.json") requests.push(url.pathname + url.search);
    // Preserve the fixture clock through reloads after simulated elapsed time.
    if (new URL(route.request().url()).pathname.startsWith("/preview/")) responseTime = await page.evaluate(() => Date.now());
    return route.continue();
  });
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
});

test.afterEach(async ({ page }) => {
  await page.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  expect(errors).toEqual([]);
  expect(externalRequests).toEqual([]);
});

for (const width of [1440, 390]) {
  test(`compact Fleet heading, Clear sort and Scenario stay exposed with tools closed at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const url = await start(page);
    for (const [scenario, count] of [["supplied", 8], ["real200", 4], ["durations", 11]] as const) {
      const beforeProviders = providers.length;
      await page.goto(`${url}/?scenario=${scenario}`);
      await expect(page.locator("#fleet-rows tr[data-host]")).toHaveCount(count);
      if (scenario !== "durations") {
        await expect(page.locator("#fleet-rows .state-running")).toHaveCount(count);
        await expect(page.locator("#inventory-summary")).toContainText(`${count}/${count} host reports available`);
      } else expect(providers.length).toBe(beforeProviders);
      await expectCollapsed(page);
      await expect(page.locator("#host-count")).toHaveText(`${count} hosts`);
      await expect(page.locator("h1")).toHaveCSS("color", "rgb(16, 232, 12)");
      await expect(page.locator("#host-count")).toHaveCSS("color", "rgb(21, 128, 61)");
      if (scenario === "durations") await expect(page.locator("#sample-clock")).toBeVisible();
      const geometry = await page.locator("#preview-tools").evaluate(element => ({
        belowTable: element.getBoundingClientRect().bottom - document.querySelector(".fleet-table-wrap")!.getBoundingClientRect().bottom,
        scenarioFits: document.querySelector("#scenario")!.getBoundingClientRect().width <= innerWidth,
        countAfterTitle: document.querySelector("#host-count")!.getBoundingClientRect().left >= document.querySelector("h1")!.getBoundingClientRect().right,
        countCenterDifference: Math.abs(
          (document.querySelector("#host-count")!.getBoundingClientRect().top + document.querySelector("#host-count")!.getBoundingClientRect().bottom) / 2 -
          (document.querySelector("h1")!.getBoundingClientRect().top + document.querySelector("h1")!.getBoundingClientRect().bottom) / 2),
        clearAboveTable: document.querySelector("#clear-sort")!.getBoundingClientRect().bottom <= document.querySelector(".fleet-table-wrap")!.getBoundingClientRect().top,
        clearOutsideTools: document.querySelector("#clear-sort")!.closest("#preview-tools") === null,
      }));
      expect(geometry.belowTable).toBeLessThan(180);
      expect(geometry.scenarioFits).toBe(true);
      expect(geometry.countAfterTitle).toBe(true);
      expect(geometry.countCenterDifference).toBeLessThanOrEqual(1);
      expect(geometry.clearAboveTable).toBe(true);
      expect(geometry.clearOutsideTools).toBe(true);
      const before = { requests: [...requests], providers: providers.length, evidence: await evidence(page), storage: await page.evaluate(() => ({ ...localStorage })) };
      const diagnostics = await page.locator(diagnosticIDs.map(id => `#${id}`).join(", ")).allTextContents();
      await summary(page).focus();
      await page.keyboard.press("Enter");
      await expect(panel(page)).toHaveAttribute("open", "");
      await expect(summary(page)).toBeFocused();
      for (const id of controlIDs) await expect(page.locator(`#${id}`)).toBeVisible();
      await expect(page.locator(".wordmark")).toBeVisible();
      await expect(page.locator(".sample-notice")).toBeVisible();
      await expect(page.locator("#inventory-summary")).toBeVisible();
      await expect(page.getByText("Click a column to sort; click again to reverse.", { exact: true })).toBeVisible();
      await expect(page.locator("#sort-status")).toBeVisible();
      await expect(page.locator("#scenario-description")).toBeVisible();
      await expect(page.locator("footer")).toBeVisible();
      expect(await page.locator(diagnosticIDs.map(id => `#${id}`).join(", ")).allTextContents()).toEqual(diagnostics);
      expect(await evidence(page)).toEqual(before.evidence);
      expect(requests).toEqual(before.requests);
      expect(providers.length).toBe(before.providers);
      expect(await page.evaluate(() => ({ ...localStorage }))).toEqual(before.storage);
      await summary(page).focus();
      await page.keyboard.press("Space");
      await expectCollapsed(page);
      expect(await evidence(page)).toEqual(before.evidence);
      expect(requests).toEqual(before.requests);
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: info.outputPath(`tools-closed-${scenario}-${width}.png`), fullPage: true });
      await summary(page).click();
      await page.reload();
      await expect(page.locator("#fleet-rows tr[data-host]")).toHaveCount(count);
      await expectCollapsed(page);
    }
    // The dropdown continues to switch scenarios without requiring tools first.
    await page.getByLabel("Scenario", { exact: true }).selectOption("real200");
    await expect(page.locator("#host-count")).toHaveText("4 hosts");
    await expectCollapsed(page);
    await page.getByLabel("Scenario", { exact: true }).selectOption("durations");
    await expect(page.locator("#host-count")).toHaveText("11 hosts");
    await expectCollapsed(page);
  });
}

test("closed tools keep source updates running and opening never refreshes data or changes saved controls", async ({ page }) => {
  await page.goto(await start(page));
  const firstState = page.locator(`#fleet-rows [data-host="${addresses[0]}"] td[data-col="state"]`);
  await expect(firstState).toHaveAttribute("data-state", "RUNNING_JOB");
  await expectCollapsed(page);
  const originalStatus = await page.locator("#node-info-status").textContent();
  await page.clock.fastForward(20_000);
  await expect(firstState).toHaveAttribute("data-state", "RESTARTING");
  await expect(firstState).toHaveAttribute("data-state-checked-at", String(NOW + 20_000));
  await expect(page.locator("#node-info-status")).toBeHidden();
  expect(await page.locator("#node-info-status").textContent()).not.toBe(originalStatus);
  await expect(page.locator("#node-info-status")).toContainText(new Date(NOW + 20_000).toISOString());
  const before = { requests: [...requests], providers: providers.length, evidence: await evidence(page) };
  await summary(page).click();
  await expect(page.locator("#node-info-status")).toBeVisible();
  expect(requests).toEqual(before.requests);
  expect(providers.length).toBe(before.providers);
  expect(await evidence(page)).toEqual(before.evidence);
  await page.getByLabel("State animation", { exact: true }).selectOption("off");
  await page.getByLabel("Duration animation", { exact: true }).selectOption("system");
  await summary(page).click();
  await expectCollapsed(page);
  await summary(page).click();
  await expect(page.getByLabel("State animation", { exact: true })).toHaveValue("off");
  await expect(page.getByLabel("Duration animation", { exact: true })).toHaveValue("system");
  expect(requests).toEqual(before.requests);
  await page.reload();
  await expect(firstState).toHaveAttribute("data-state", "RESTARTING");
  await expectCollapsed(page);
  await summary(page).click();
  await expect(page.getByLabel("State animation", { exact: true })).toHaveValue("off");
  await expect(page.getByLabel("Duration animation", { exact: true })).toHaveValue("system");
  await page.getByLabel("Scenario", { exact: true }).selectOption("durations");
  await expect(page.locator("#inventory-details")).toBeVisible();
  await expect(page.locator("#clock-help")).toBeVisible();
  const originalClock = await page.locator("#sample-clock").textContent();
  const syntheticReads = [...requests];
  await page.getByRole("button", { name: "Advance 30s", exact: true }).click();
  expect(await page.locator("#sample-clock").textContent()).not.toBe(originalClock);
  await page.getByRole("button", { name: "Reset sample", exact: true }).click();
  await expect(page.locator("#sample-clock")).toHaveText(originalClock!);
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect(page.locator("#sample-clock")).toHaveText(originalClock!);
  expect(requests).toEqual(syntheticReads);
});
