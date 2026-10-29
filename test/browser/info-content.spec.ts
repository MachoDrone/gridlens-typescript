import { openPreviewTools } from "./helpers.ts";
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
import { SYNTHETIC_HOST_ADDRESSES as addresses } from "../fixtures/host-addresses.ts";
import { emptyJobs } from "../fixtures/jobs.ts";
import { emptyNos } from "../fixtures/nos.ts";
import { emptyStaking } from "../fixtures/staking.ts";

const NOW = Date.UTC(2026, 0, 1, 12);
const market = addresses[7]!;
const hostileText = `synthetic-${"long".repeat(24)} <img src=x onerror="window.__infoInjected=true"> & literal`;
const rightColumns = ["nodeRuntime", "dailyUptime", "ram", "disk", "dl", "ul", "ping", "rewards", "nos", "market", "gpuID", "currentNode", "cuda", "nvidia", "cpu", "system", "country"];
const servers: Server[] = [];
const directories: string[] = [];
const errors: string[] = [];
const externalRequests: string[] = [];
const requests: string[] = [];
let origin = "";

function metadata(): HostMetadataSnapshot {
  return { hosts: addresses.map((address, index) => ({
    address, values: { status: index === 1 ? "REJECTED" : "PREMIUM", marketAddress: market,
      marketLabel: "synthetic-market", ram: 63.75, disk: 700.25,
      cpu: index === 6 ? hostileText : "13th Gen Synthetic Processor", cuda: "12.8", nvidia: "580.126.09",
      currentNode: "1.2.3", system: "6.11.0-synthetic" },
    fetchedAtMs: NOW, retained: false, error: null, marketError: null,
  })) };
}

async function jobs(): Promise<JobSnapshot> {
  const result = await emptyJobs(addresses);
  for (const [index, elapsed] of [[2, 60], [3, 960]] as const) result.hosts[index] = {
    address: addresses[index]!, job: { address: addresses[(index + 1) % addresses.length]!,
      node: addresses[index]!, state: "RUNNING", timeStart: NOW / 1000 - elapsed, timeEnd: 0, timeout: 600 },
    checkedAtMs: NOW, validUntilMs: NOW + 180_000, failedAtMs: index === 3 ? NOW : null,
    retained: index === 3, pending: false, retryAtMs: null,
    error: index === 3 ? "Synthetic job refresh unavailable." : null,
  };
  return result;
}

function queue(): QueueSnapshot {
  return { hosts: addresses.map((address, index) => ({
    address, marketAddress: market, position: [2, null, 3, 10][index] ?? null, total: 12,
    checkedAtMs: NOW - 1000, validUntilMs: NOW + 29_000, sourceUpdatedAtMs: NOW - 2000,
    retained: index === 3, error: index === 3 ? "Synthetic queue refresh unavailable." : null,
  })) };
}

function nodeInfo(): NodeInfoSnapshot {
  return { hosts: addresses.map((address, index) => {
    const state = ["QUEUED", "OTHER", "RESTARTING", "RUNNING_JOB", null, null, "HEALTHCHECK", "JOINING_MARKET"][index] ?? null;
    const at = index === 3 ? NOW - 60_000 : NOW;
    return {
      address, values: state === null ? null : { state, dl: 604.49, ul: 36.6, ping: 21.8, networkUnavailableReason: null },
      fetchedAtMs: state === null ? null : at, validUntilMs: state === null ? null : at + 30_000,
      retained: index === 3, error: index === 4 ? "Node Info unavailable (HTTP 503)." : null,
      apiCheck: { status: index === 4 ? "offline" as const : index === 5 ? "other" as const : "online" as const, checkedAtMs: at },
    };
  }) };
}

async function start(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-info-content-browser-"));
  directories.push(directory);
  const hostsFile = join(directory, "hosts.json");
  await writeFile(hostsFile, JSON.stringify(addresses));
  const server = await startPreviewServer({ now: () => NOW, hostsFile, port: 0,
    metadataProvider: async () => metadata(), nodeInfoProvider: async () => nodeInfo(),
    jobProvider: jobs, queueProvider: async () => queue(), nosProvider: emptyNos, stakingProvider: emptyStaking,
    solProvider: async input => ({ hosts: input.map((address, index) => ({
      address, lamports: index === 7 ? "0" : "5000000000", provider: index === 6 ? hostileText : "Synthetic RPC", endpoint: "https://rpc.example.invalid",
      contextSlot: 456, blockTimeMs: NOW - 1000, checkedAtMs: NOW, validUntilMs: NOW + 60_000,
      retained: index === 3, error: index === 3 ? "Synthetic RPC refresh unavailable." : null, retryAtMs: null,
    })), nextRefreshAtMs: NOW + 30_000 }),
  });
  servers.push(server);
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("Missing isolated preview port");
  origin = `http://127.0.0.1:${bound.port}`;
  return origin;
}

function cell(page: Page, column: string, index = 0) {
  return page.locator(`#fleet-rows [data-host="${addresses[index]}"] td[data-col="${column}"]`);
}

async function ready(page: Page): Promise<void> {
  await expect(cell(page, "queued")).toHaveText("2/12");
  await expect(cell(page, "duration", 2).locator(".duration-fill")).toHaveCount(1);
  await expect(cell(page, "sol")).toHaveText("5.000");
  await expect(page.locator("#inventory-summary")).toContainText("8/8 host reports available");
}

async function expectConciseDialog(page: Page): Promise<void> {
  const body = page.locator("#info-body");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(body.locator(":scope > .info-summary")).toHaveCount(1);
  await expect(body.locator(".info-summary")).toBeVisible();
  const summary = (await body.locator(".info-summary").innerText()).trim();
  expect(summary.length).toBeGreaterThan(0);
  expect(summary.length).toBeLessThanOrEqual(240);
  expect(summary).not.toMatch(/[\r\n]/);
  expect(await body.locator(".info-facts > li").count()).toBeLessThanOrEqual(4);
  await expect(body.locator(".info-source")).toHaveCount(1);
  await expect(body.locator(".info-source")).not.toHaveAttribute("open");
  await expect(body.locator(".info-source > summary")).toHaveText("Source details");
  await expect(body.locator(".info-source-body")).toBeHidden();
  expect((await body.locator(".info-source-body").textContent())!.length).toBeGreaterThan(0);
}

test.beforeEach(async ({ context, page }) => {
  origin = "";
  errors.length = externalRequests.length = requests.length = 0;
  await page.clock.install({ time: NOW });
  await page.clock.pauseAt(NOW);
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { externalRequests.push(url.href); return route.abort(); }
    // Service connectivity checks are independent of column-data reads.
    if (url.pathname.startsWith("/preview/") && url.pathname.endsWith(".json") &&
        url.pathname !== "/preview/connection.json") requests.push(url.pathname);
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
  expect(externalRequests, "Info tests must never contact real hosts or providers").toEqual([]);
});

test("every column hover and help dialog stays concise while retaining its full source explanation", async ({ page }) => {
  await page.goto(await start());
  await openPreviewTools(page);
  await ready(page);
  const before = [...requests];
  const headings = page.locator("#column-headings th[data-col] .column-label");
  expect(await headings.count()).toBe(28);
  for (const heading of await headings.all()) {
    const title = (await heading.getAttribute("title"))!;
    expect(title.length).toBeGreaterThan(0);
    expect(title.length).toBeLessThanOrEqual(240);
    expect(title).not.toMatch(/[\r\n]/);
    await heading.click();
    await page.getByRole("button", { name: "Column info", exact: true }).click();
    await expectConciseDialog(page);
    await page.keyboard.press("Escape");
  }
  const hoverText = await page.locator("#fleet-rows [title], #column-headings [title]").evaluateAll(elements =>
    elements.map(element => element.getAttribute("title") ?? ""));
  expect(hoverText.length).toBeGreaterThan(28);
  for (const title of hoverText) {
    expect(title.length).toBeLessThanOrEqual(240);
    expect(title).not.toMatch(/[\r\n]/);
  }
  for (const column of ["api", "state", "queued", "duration", "sol", "stakedNos", "status"]) {
    await cell(page, column).getByRole("button").click();
    await expectConciseDialog(page);
    if (column === "duration") {
      // Queued activity can come from Node Info or the queue. It must not be
      // attributed to an assignment lookup merely because it appears here.
      expect(await page.locator("#info-body").innerText()).not.toMatch(/assigned job|job checked/i);
      await expect(page.locator(".info-source-body")).toContainText(/QUEUED|queued/);
    }
    await page.keyboard.press("Escape");
  }
  await page.getByLabel("Scenario", { exact: true }).selectOption("mixed");
  await page.locator("#fleet-rows .host-details").first().click();
  await expectConciseDialog(page);
  await expect(page.locator(".info-source-body")).toContainText("Inventory observation:");
  await page.keyboard.press("Escape");
  expect(requests).toEqual(before);
});

test("dialog colors distinguish current outcomes from stale or unknown readings without inventing health", async ({ page }) => {
  await page.goto(await start());
  await openPreviewTools(page);
  await ready(page);
  let positiveColor = "";
  let negativeColor = "";
  for (const [index, tone, word] of [[0, "positive", "Online"], [4, "negative", "Offline"], [3, "positive", "Online"], [5, "warning", "unknown"]] as const) {
    await cell(page, "api", index).getByRole("button").click();
    await expectConciseDialog(page);
    await expect(page.locator(".info-summary")).toContainText(word);
    const value = page.locator(`.info-summary .info-tone-${tone}`).first();
    await expect(value).toBeVisible();
    if (index === 0) positiveColor = await value.evaluate(element => getComputedStyle(element).color);
    if (index === 4) negativeColor = await value.evaluate(element => getComputedStyle(element).color);
    if (index === 3) {
      await expect(page.locator(".info-summary")).toContainText(/last confirmed|unconfirmed|stale/i);
      await expect(page.locator(".info-facts .info-tone-warning").first()).toBeVisible();
    }
    await page.keyboard.press("Escape");
  }
  expect(positiveColor).not.toBe(negativeColor);
  for (const [column, index] of [["state", 5], ["stakedNos", 7]] as const) {
    await cell(page, column, index).getByRole("button").click();
    await expectConciseDialog(page);
    await expect(page.locator(".info-summary")).toContainText(/unknown|unavailable|not reported|populating/i);
    await expect(page.locator(".info-summary .info-tone-positive")).toHaveCount(0);
    await page.keyboard.press("Escape");
  }
  await cell(page, "duration", 3).getByRole("button").click();
  await expectConciseDialog(page);
  await expect(page.locator(".info-summary .info-tone-muted").first()).toBeVisible();
  await expect(page.locator(".info-summary, .info-facts")).toContainText([/retained|stale|estimate/i, /limit|overrun|exceeded/i]);
  await expect(page.locator(".info-summary .info-tone-positive")).toHaveCount(0);
});

test("right-side row values have no hover or keyboard controls in either layout, across live and synthetic refreshes", async ({ page }) => {
  await page.goto(await start());
  await openPreviewTools(page);
  await ready(page);
  const rightCells = page.locator(rightColumns.map(key => `#fleet-rows td[data-col="${key}"]`).join(", "));
  const assertPlainCells = async () => {
    expect(await rightCells.count()).toBe(await page.locator("#fleet-rows tr[data-host]").count() * rightColumns.length);
    const violations = await rightCells.evaluateAll(cells => cells.flatMap(cell => {
      const elements = [cell, ...cell.querySelectorAll("*")];
      return elements.filter(element => element.matches("button, a[href], input, select, textarea, summary, [tabindex], [role=button], [role=link], [role=tooltip], [contenteditable]") ||
        element.hasAttribute("title") || element.hasAttribute("aria-description") ||
        /open details/i.test(element.getAttribute("aria-label") ?? "") ||
        (element as HTMLElement).onclick !== null || (element as HTMLElement).tabIndex >= 0)
        .map(element => ({ column: cell.getAttribute("data-col"), markup: element.outerHTML }));
    }));
    expect(violations).toEqual([]);
  };
  for (const scenario of ["supplied", "durations"]) {
    if (scenario !== "supplied") await page.getByLabel("Scenario", { exact: true }).selectOption(scenario);
    for (const combined of [false, true]) {
      if (combined) await page.locator("#queued-duration-layout-toggle").click();
      await assertPlainCells();
      const before = [...requests];
      for (const column of rightColumns) {
        const target = page.locator("#fleet-rows tr[data-host]").first().locator(`td[data-col="${column}"]`);
        await target.click();
        await expect(page.getByRole("dialog")).toBeHidden();
        await expect(page.getByRole("tooltip")).toHaveCount(0);
        const focused = await target.evaluate(element => {
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          (element as HTMLElement).focus();
          return element.contains(document.activeElement);
        });
        expect(focused).toBe(false);
        await page.keyboard.press("Enter");
        await expect(page.getByRole("dialog")).toBeHidden();
      }
      expect(requests).toEqual(before);
      const spans = await page.locator("#fleet-rows").evaluateHandle((table, columns) =>
        [...table.querySelectorAll<HTMLTableCellElement>("td[data-col]")]
          .filter(cell => columns.includes(cell.dataset.col!)).flatMap(cell => [...cell.querySelectorAll("span")]), rightColumns);
      if (scenario === "supplied") {
        const response = page.waitForResponse(value => value.url().endsWith("/preview/queue.json"));
        await page.getByRole("button", { name: "Refresh view", exact: true }).click();
        await response;
        await page.clock.runFor(1);
        expect(await spans.evaluate(elements => elements.every(element => element.isConnected))).toBe(true);
      } else await page.getByRole("button", { name: "Refresh view", exact: true }).click();
      await spans.dispose();
      await assertPlainCells();
      await expect(page.getByRole("button", { name: "Sort by System", exact: true })).toHaveAttribute("title", /.+/);
      for (const label of ["Market", "NVIDIA", "CPU", "System", "Country"]) {
        await expect(page.getByRole("button", { name: `Toggle ${label} display`, exact: true })).toBeVisible();
      }
      await page.locator("#fleet-rows .node-state-value").first().click();
      await expectConciseDialog(page);
      await page.keyboard.press("Escape");
    }
    await page.locator("#queued-duration-layout-toggle").click();
  }
});

test("combined details preserve both full source descriptions and timestamps behind a closed disclosure", async ({ page }) => {
  await page.goto(await start());
  await openPreviewTools(page);
  await ready(page);
  const before = [...requests];
  const originals: string[] = [];
  for (const column of ["queued", "duration"]) {
    await cell(page, column, 2).getByRole("button").click();
    await expectConciseDialog(page);
    originals.push((await page.locator(".info-source-body").textContent())!);
    await page.keyboard.press("Escape");
  }
  await page.locator("#queued-duration-layout-toggle").click();
  await cell(page, "queued-duration", 2).getByRole("button").click();
  await expectConciseDialog(page);
  const source = page.locator(".info-source-body");
  for (const original of originals) expect(await source.textContent()).toContain(original);
  await expect(page.locator(".info-summary, .info-facts")).toContainText([/3\/12|Queued/i, /1m|Duration/i]);
  await page.locator(".info-source > summary").click();
  await expect(source).toBeVisible();
  await expect(source).toContainText(new Date(NOW - 1000).toISOString());
  await expect(source).toContainText(new Date(NOW - 2000).toISOString());
  await expect(source).toContainText(new Date(NOW).toISOString());
  await expect(source).toContainText(new Date(NOW + 180_000).toISOString());
  await page.keyboard.press("Escape");
  await expect(cell(page, "queued-duration", 2).getByRole("button")).toBeFocused();
  await cell(page, "queued-duration", 2).getByRole("button").click();
  await expectConciseDialog(page);
  expect(requests).toEqual(before);
  await page.keyboard.press("Escape");

  // A newer queue proof supersedes this job. Its original check must never be
  // advertised as provenance for the resulting queued or expired placeholder.
  const newerQueue = queue();
  for (const record of newerQueue.hosts) {
    record.checkedAtMs = NOW + 1000;
    record.validUntilMs = NOW + 31_000;
    record.sourceUpdatedAtMs = NOW;
  }
  await page.route("**/preview/queue.json", route => route.fulfill({ json: newerQueue }));
  await page.clock.runFor(1000);
  const refreshed = page.waitForResponse(response => response.url().endsWith("/preview/queue.json"));
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await refreshed;
  await expect(cell(page, "duration", 2)).toHaveAttribute("data-duration-kind", "queue");
  await cell(page, "queued-duration", 2).getByRole("button").click();
  await expectConciseDialog(page);
  expect(await page.locator("#info-body").innerText()).not.toMatch(/assigned job|job checked/i);
  await expect(source).toContainText(new Date(NOW + 1000).toISOString());
  await page.keyboard.press("Escape");
  await page.clock.fastForward(31_000);
  await page.locator("#queued-duration-layout-toggle").click();
  await expect(cell(page, "duration", 2)).toHaveText("Populating..");
  await cell(page, "duration", 2).getByRole("button").click();
  await expectConciseDialog(page);
  await expect(page.locator(".info-summary")).toContainText("no useful timing is available yet");
  expect(await page.locator("#info-body").innerText()).not.toMatch(/assigned job|job checked|no running assignment/i);
  await expect(source).toContainText("previous counter was superseded");
  await expect(source).toContainText(new Date(NOW + 1000).toISOString());
});

test("background refresh keeps the open dialog and return control stable without rewriting inspected source times", async ({ page }) => {
  await page.goto(await start());
  await openPreviewTools(page);
  await ready(page);
  const button = await cell(page, "duration", 2).getByRole("button").elementHandle();
  await cell(page, "duration", 2).getByRole("button").focus();
  await page.keyboard.press("Enter");
  await expectConciseDialog(page);
  await page.locator(".info-source > summary").click();
  const source = await page.locator(".info-source-body").textContent();
  const disclosure = await page.locator(".info-source").elementHandle();
  await page.clock.fastForward(20_000);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".info-source")).toHaveAttribute("open", "");
  expect(await page.locator(".info-source-body").textContent()).toBe(source);
  expect(await disclosure!.evaluate(element => element.isConnected && element === document.querySelector(".info-source"))).toBe(true);
  expect(await button!.evaluate(element => element.isConnected)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(cell(page, "duration", 2).getByRole("button")).toBeFocused();
  await page.keyboard.press("Enter");
  await expectConciseDialog(page);
  await expect(page.locator(".info-source-body")).toContainText(new Date(NOW).toISOString());
  await expect(page.locator(".info-source-body")).toContainText("1m 20s / 10m");
});

for (const width of [1440, 390]) {
  test(`literal provider text and long identifiers stay safe and wrap inside details at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(await start());
    await openPreviewTools(page);
    await ready(page);
    await expect(cell(page, "cpu", 6).locator("img, script, iframe")).toHaveCount(0);
    await cell(page, "cpu", 6).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await cell(page, "sol", 6).getByRole("button").click();
    await expectConciseDialog(page);
    await expect(page.getByRole("dialog").locator("img, script, iframe")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __infoInjected?: boolean }).__infoInjected)).toBeUndefined();
    await page.locator(".info-source > summary").click();
    await expect(page.locator(".info-source-body")).toContainText(hostileText);
    expect(await page.getByRole("dialog").evaluate(element => ({
      fits: element.getBoundingClientRect().width <= innerWidth,
      wraps: element.scrollWidth <= element.clientWidth,
      sourceWraps: element.querySelector(".info-source-body")!.scrollWidth <= element.querySelector(".info-source-body")!.clientWidth,
    }))).toEqual({ fits: true, wraps: true, sourceWraps: true });
    await page.screenshot({ path: info.outputPath(`info-literal-source-${width}.png`), fullPage: true });
    await page.keyboard.press("Escape");
    await expect(cell(page, "sol", 6).getByRole("button")).toBeFocused();
    await cell(page, "sol").getByRole("button").click();
    await expectConciseDialog(page);
    await page.locator(".info-source > summary").click();
    await expect(page.locator(".info-source-body")).toContainText(addresses[0]!);
    await expect(page.locator(".info-source-body")).toContainText("5000000000");
    await expect(page.locator(".info-source-body")).toContainText(new Date(NOW).toISOString());
    expect(await page.getByRole("dialog").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  });
}
