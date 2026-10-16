import { openPreviewTools } from "./helpers.ts";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPreviewServer } from "../../scripts/preview-server.ts";
import type { JobSnapshot } from "../../src/fleet/jobs.ts";
import type { QueueSnapshot } from "../../src/fleet/queue.ts";
import { SYNTHETIC_HOST_ADDRESSES } from "../fixtures/host-addresses.ts";
import { emptyJobs } from "../fixtures/jobs.ts";
import { emptyNos } from "../fixtures/nos.ts";
import { emptySol } from "../fixtures/sol.ts";
import { emptyStaking } from "../fixtures/staking.ts";

const addresses = SYNTHETIC_HOST_ADDRESSES;
const market = addresses[7]!;
const NOW = Date.UTC(2026, 0, 1, 12);
const storageKey = "gridlens.preview.queued-duration-layout.v1";
const sortKey = "gridlens.preview.sort.v1";
const servers: Server[] = [];
const directories: string[] = [];
let origin = "";
const errors: string[] = [];
const externalRequests: string[] = [];
const requests: string[] = [];

function queueSnapshot(): QueueSnapshot {
  return { hosts: addresses.map((address, index) => ({
    address, marketAddress: market, position: [2, null, 3, 10][index] ?? null, total: 12,
    checkedAtMs: NOW - 1_000, validUntilMs: NOW + 29_000, sourceUpdatedAtMs: NOW - 2_000,
    retained: index === 3, error: index === 3 ? "Synthetic queue refresh failed" : null,
  })) };
}

async function jobSnapshot(): Promise<JobSnapshot> {
  const result = await emptyJobs(addresses);
  for (const [index, elapsed, limit] of [[1, 120, 600], [2, 60, 600], [3, 960, 600], [7, 90, 0]] as const) {
    result.hosts[index] = {
      address: addresses[index]!, job: { address: addresses[(index + 1) % addresses.length]!,
        node: addresses[index]!, state: "RUNNING", timeStart: NOW / 1_000 - elapsed, timeEnd: 0, timeout: limit },
      checkedAtMs: NOW, validUntilMs: NOW + 180_000, failedAtMs: index === 3 ? NOW : null,
      retained: index === 3, pending: false, retryAtMs: null,
      error: index === 3 ? "Synthetic job refresh failed" : null,
    };
  }
  result.hosts[6] = { ...result.hosts[6]!, checkedAtMs: NOW, validUntilMs: NOW + 180_000 };
  return result;
}

async function start(options: {
  jobs?: () => Promise<JobSnapshot>;
  queue?: () => Promise<QueueSnapshot>;
} = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-queued-duration-browser-"));
  directories.push(directory);
  const hostsFile = join(directory, "hosts.json");
  await writeFile(hostsFile, JSON.stringify(addresses));
  const server = await startPreviewServer({ now: () => NOW, hostsFile, port: 0,
    stakingProvider: emptyStaking, nosProvider: emptyNos, solProvider: emptySol,
    jobProvider: options.jobs ?? jobSnapshot, queueProvider: options.queue ?? (async () => queueSnapshot()),
    metadataProvider: async input => ({ hosts: input.map(address => ({
      address, values: { status: null, marketAddress: market, marketLabel: "synthetic-market",
        ram: null, disk: null, cpu: null, cuda: null, nvidia: null, currentNode: null, system: null },
      fetchedAtMs: NOW, retained: false, error: null, marketError: null,
    })) }),
    nodeInfoProvider: async input => ({ hosts: input.map((address, index) => ({
      address, values: index === 4
        ? { state: "QUEUED" as const, dl: null, ul: null, ping: null, networkUnavailableReason: null } : null,
      fetchedAtMs: index === 4 ? NOW : null, validUntilMs: index === 4 ? NOW + 30_000 : null,
      retained: false, error: null,
    })) }),
  });
  servers.push(server);
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("Missing isolated port");
  origin = `http://127.0.0.1:${bound.port}`;
  return origin;
}

function cell(page: Page, index: number, column = "queued-duration") {
  return page.locator(`#fleet-rows [data-host="${addresses[index]}"] td[data-col="${column}"]`);
}

function toggle(page: Page) { return page.locator("#queued-duration-layout-toggle"); }

async function expectLayoutIcon(page: Page, combined: boolean): Promise<void> {
  const label = combined ? "Separate Queued + Duration" : "Combine Queued + Duration";
  await expect(toggle(page)).toHaveCount(1);
  await expect(toggle(page)).toHaveAccessibleName(label);
  await expect(toggle(page)).toHaveAttribute("title", label);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", String(combined));
  await expect(toggle(page).locator("svg")).toHaveCount(1);
  await expect(toggle(page).locator("svg")).toBeVisible();
}

async function expectIconCentered(page: Page): Promise<void> {
  const positions = await toggle(page).evaluate(element => {
    const queue = document.querySelector('[aria-label="Sort by Queued"]')!.getBoundingClientRect();
    const duration = document.querySelector('[aria-label="Sort by Duration"]')!.getBoundingClientRect();
    const display = document.querySelector("#duration-display-toggle")!.getBoundingClientRect();
    const icon = element.querySelector("svg")!.getBoundingClientRect();
    const button = element.getBoundingClientRect();
    const headings = document.querySelector("#column-headings")!.getBoundingClientRect();
    return {
      expectedCenter: (queue.left + queue.width / 2 + duration.left + duration.width / 2) / 2,
      buttonCenter: button.left + button.width / 2,
      iconCenter: icon.left + icon.width / 2,
      betweenTitles: icon.left >= queue.right && icon.right <= duration.left,
      insideHeader: button.top >= headings.top && button.bottom <= headings.bottom,
      clearOfDisplay: button.right <= display.left || button.left >= display.right ||
        button.bottom <= display.top || button.top >= display.bottom,
      separateTargets: button.left >= queue.right && button.right <= duration.left &&
        display.bottom <= duration.top,
      minimumTargets: [queue, duration, display, button].every(rect => rect.width >= 24 && rect.height >= 24),
    };
  });
  expect(Math.abs(positions.buttonCenter - positions.expectedCenter)).toBeLessThanOrEqual(1);
  expect(Math.abs(positions.iconCenter - positions.expectedCenter)).toBeLessThanOrEqual(1);
  expect(positions.betweenTitles).toBe(true);
  expect(positions.insideHeader).toBe(true);
  expect(positions.clearOfDisplay).toBe(true);
  expect(positions.separateTargets).toBe(true);
  expect(positions.minimumTargets).toBe(true);
  await expect(page.getByRole("button", { name: "Toggle Duration display", exact: true })).toHaveText("🔄");
  await toggle(page).hover();
  await expect(toggle(page).getByRole("tooltip")).toBeVisible();
  await expect(toggle(page).getByRole("tooltip")).toHaveText((await toggle(page).getAttribute("aria-label"))!);
  await page.mouse.move(0, 0);
}

async function ready(page: Page): Promise<void> {
  await expect(cell(page, 0, "queued")).toHaveText("2/12", { useInnerText: true });
  await expect(cell(page, 1, "duration").locator(".duration-active")).toHaveCount(1);
  await expect(cell(page, 4, "duration")).toHaveText("⟵", { useInnerText: true });
  await expect(cell(page, 6, "duration")).toHaveText("—", { useInnerText: true });
}

async function order(page: Page): Promise<(string | null)[]> {
  return page.locator("#fleet-rows tr[data-host]").evaluateAll(rows => rows.map(row => row.getAttribute("data-host")));
}

async function sources(page: Page) {
  return page.locator('#fleet-rows td[data-col="queued"], #fleet-rows td[data-col="duration"]').evaluateAll(cells =>
    cells.map(element => ({ host: element.parentElement!.getAttribute("data-host"),
      column: element.getAttribute("data-col"), title: element.getAttribute("title"),
      data: { ...(element as HTMLElement).dataset } })),
  );
}

async function visibility(page: Page, state: "visible" | "hidden"): Promise<void> {
  await page.evaluate(value => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => value === "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
  if (state === "visible") await page.clock.runFor(1);
}

test.beforeEach(async ({ context, page }) => {
  origin = "";
  errors.length = externalRequests.length = requests.length = 0;
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
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    // Layout changes must preserve data reads; local liveness checks are separate.
    if (path.startsWith("/preview/") && path !== "/preview/connection.json") requests.push(path);
  });
});

test.afterEach(async ({ page }) => {
  await page.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  expect(errors).toEqual([]);
  expect(externalRequests, "Combined presentation uses only isolated synthetic providers").toEqual([]);
});

test("combined values retain both sources and distinguish population, absence and queued without rank", async ({ page }) => {
  await page.goto(await start());
  await openPreviewTools(page);
  await ready(page);
  await expectLayoutIcon(page, false);
  await expect(cell(page, 0)).toBeHidden();
  await page.getByRole("button", { name: "Toggle Duration display", exact: true }).click();
  const original = await sources(page);
  const sourceDescriptions = new Map<string, string>();
  for (const index of [0, 1, 2, 4, 5, 6]) for (const column of ["queued", "duration"]) {
    await cell(page, index, column).getByRole("button").click();
    sourceDescriptions.set(`${index}:${column}`, (await page.locator(".info-source-body").textContent())!);
    await page.keyboard.press("Escape");
  }
  const originalRequests = [...requests];
  const statuses = await page.locator("#queue-status, #jobs-status, #node-info-status").allTextContents();
  await toggle(page).click();
  await expectLayoutIcon(page, true);
  await expect(cell(page, 0)).toHaveText("2/12", { useInnerText: true });
  await expect(cell(page, 1)).toHaveText("2m / 10m", { useInnerText: true });
  await expect(cell(page, 2)).toContainText("3/12");
  await expect(cell(page, 2)).toContainText("1m / 10m");
  await expect(cell(page, 2)).toHaveAttribute("data-stacked", "true");
  expect(await cell(page, 2).locator('.queued-duration-source[data-source="queued"]').evaluate(element =>
    getComputedStyle(element, "::before").content)).toBe('"Q"');
  expect(await cell(page, 2).locator('.queued-duration-source[data-source="duration"]').evaluate(element =>
    getComputedStyle(element, "::before").content)).toBe('"D"');
  await expect(cell(page, 3)).toContainText("10/12");
  await expect(cell(page, 3)).toContainText("16m / 10m");
  await expect(cell(page, 4)).toHaveText("Queued", { useInnerText: true });
  await expect(cell(page, 5)).toHaveText("Populating..", { useInnerText: true });
  await expect(cell(page, 6)).toHaveText("—", { useInnerText: true });
  await expect(cell(page, 7)).toHaveText("1m 30s", { useInnerText: true });
  await expect(cell(page, 2).locator(".queue-value")).toHaveCSS("color", "rgb(119, 119, 119)");
  await expect(cell(page, 2).locator(".duration-value")).toHaveCSS("color", "rgb(74, 222, 128)");
  await expect(cell(page, 3).locator(".duration-value")).toHaveCSS("color", "rgb(150, 48, 48)");
  for (const index of [0, 1, 2, 3, 4, 5, 6, 7]) {
    await expect(cell(page, index)).not.toContainText("⟵", { useInnerText: true });
    await expect(cell(page, index)).not.toContainText("⟶", { useInnerText: true });
  }
  for (const index of [0, 1, 2, 4, 5, 6]) {
    await cell(page, index).getByRole("button").first().click();
    await expect(page.getByRole("dialog")).toHaveAccessibleName("Queued / Duration");
    await expect(page.locator(".info-source-body")).toContainText(sourceDescriptions.get(`${index}:queued`)!);
    await expect(page.locator(".info-source-body")).toContainText(sourceDescriptions.get(`${index}:duration`)!);
    await expect(page.getByRole("dialog")).toContainText(new Date(NOW - 1_000).toISOString());
    await page.keyboard.press("Escape");
  }
  expect(await sources(page)).toEqual(original);
  expect(await page.locator("#queue-status, #jobs-status, #node-info-status").allTextContents()).toEqual(statuses);
  expect(requests).toEqual(originalRequests);
  await toggle(page).click();
  await expect(cell(page, 0, "duration")).toHaveText("⟵", { useInnerText: true });
  await expect(cell(page, 1, "queued")).toHaveText("⟶", { useInnerText: true });
  await expect(cell(page, 4, "queued")).toHaveText("—", { useInnerText: true });
  await expect(cell(page, 4, "duration")).toHaveText("⟵", { useInnerText: true });
  expect(await sources(page)).toEqual(original);
  expect(requests).toEqual(originalRequests);
});

test("both original sorts remain available and preserve their active order across layouts", async ({ page }) => {
  await page.goto(await start());
  await openPreviewTools(page);
  await ready(page);
  await page.getByRole("button", { name: "Sort by Queued", exact: true }).click();
  const queuedOrder = await order(page);
  expect(queuedOrder.slice(0, 3)).toEqual([addresses[0], addresses[2], addresses[3]]);
  const sort = await page.evaluate(key => localStorage.getItem(key), sortKey);
  await toggle(page).click();
  expect(await order(page)).toEqual(queuedOrder);
  expect(await page.evaluate(key => localStorage.getItem(key), sortKey)).toBe(sort);
  for (const label of ["Queued", "Duration"]) {
    const control = page.getByRole("button", { name: `Sort by ${label}`, exact: true });
    await expect(control).toHaveCount(1);
    await expect(control).toBeVisible();
    expect(await control.evaluate(element => element.closest("th")?.getAttribute("data-col"))).toBe("queued-duration");
  }
  await page.getByRole("button", { name: "Sort by Duration", exact: true }).click();
  const durationOrder = await order(page);
  expect(durationOrder.slice(0, 4)).toEqual([addresses[2], addresses[7], addresses[1], addresses[3]]);
  await toggle(page).click();
  expect(await order(page)).toEqual(durationOrder);
  await expect(page.locator('th[data-col="duration"]')).toHaveAttribute("aria-sort", "ascending");
  await page.getByRole("button", { name: "Sort by Duration", exact: true }).click();
  expect((await order(page)).slice(0, 4)).toEqual([addresses[3], addresses[1], addresses[7], addresses[2]]);
});

for (const fallback of [false, true]) {
  test(`layout moves preserve source controls, focus and animation ${fallback ? "with the moveBefore fallback" : "with native moves"}`, async ({ page }) => {
    if (fallback) await page.addInitScript(() => {
      Object.defineProperty(Element.prototype, "moveBefore", { configurable: true, value: undefined });
    });
    await page.goto(await start());
    await openPreviewTools(page);
    await ready(page);
    const saved = await cell(page, 1, "duration").evaluateHandle(element => {
      const button = element.querySelector<HTMLButtonElement>(".duration-value")!;
      const fill = button.querySelector(".duration-fill")!;
      const animation = fill.getAnimations({ subtree: true })[0]!;
      animation.pause();
      animation.currentTime = 3_123;
      button.focus();
      return { row: element.parentElement!, button, fill, animation,
        phase: (fill as HTMLElement).style.getPropertyValue("--duration-delay") };
    });
    const original = await sources(page);
    const originalRequests = [...requests];
    for (let index = 0; index < 4; index++) {
      // Programmatic activation lets us observe the focused source surviving a
      // move; a mouse click would intentionally focus the layout toggle itself.
      await toggle(page).evaluate(element => (element as HTMLButtonElement).click());
      expect(await saved.evaluate(kept => ({
        connected: kept.row.isConnected && kept.button.isConnected && kept.fill.isConnected,
        sameButton: kept.row.querySelector(".duration-value") === kept.button,
        sameFill: kept.row.querySelector(".duration-fill") === kept.fill,
        focused: document.activeElement === kept.button,
        time: Number(kept.fill.getAnimations({ subtree: true })[0]?.currentTime),
        playState: kept.fill.getAnimations({ subtree: true })[0]?.playState,
        phase: (kept.fill as HTMLElement).style.getPropertyValue("--duration-delay") === kept.phase,
      })), `Layout toggle ${index + 1} preserves source nodes and its animation timeline`).toEqual({
        connected: true, sameButton: true, sameFill: true, focused: true, time: 3_123, playState: "paused", phase: true,
      });
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      expect(await saved.evaluate(kept => document.activeElement === kept.button)).toBe(true);
    }
    expect(await sources(page)).toEqual(original);
    expect(requests).toEqual(originalRequests);
    await cell(page, 1, "queued").getByRole("button").focus();
    await toggle(page).evaluate(element => (element as HTMLButtonElement).click());
    await expect(cell(page, 1).locator(".duration-value")).toBeFocused();
    await expect(cell(page, 1).getByRole("button")).toHaveCount(1);
    await toggle(page).evaluate(element => (element as HTMLButtonElement).click());
    await cell(page, 0, "duration").getByRole("button").focus();
    await toggle(page).evaluate(element => (element as HTMLButtonElement).click());
    await expect(cell(page, 0).locator(".queue-value")).toBeFocused();
    await expect(cell(page, 0).getByRole("button")).toHaveCount(1);
    const layoutButton = await toggle(page).elementHandle();
    await toggle(page).focus();
    for (const [key, combined] of [["Enter", false], ["Space", true]] as const) {
      await page.keyboard.press(key);
      await expectLayoutIcon(page, combined);
      await expect(toggle(page)).toBeFocused();
      await expect(toggle(page).getByRole("tooltip")).toBeVisible();
      expect(await layoutButton!.evaluate(element => element.isConnected &&
        document.querySelector("#queued-duration-layout-toggle") === element)).toBe(true);
    }
    expect(await sources(page)).toEqual(original);
    expect(requests).toEqual(originalRequests);
    await toggle(page).evaluate(element => (element as HTMLButtonElement).click());
    for (const column of ["queued", "duration"]) {
      const source = cell(page, 2, column).getByRole("button");
      await source.focus();
      const kept = await cell(page, 2, "duration").evaluateHandle(element => {
        const button = element.querySelector<HTMLButtonElement>(".duration-value")!;
        const fill = button.querySelector(".duration-fill")!;
        const animation = fill.getAnimations({ subtree: true })[0]!;
        animation.pause();
        animation.currentTime = 2_456;
        return { button, fill, focused: document.activeElement };
      });
      await toggle(page).evaluate(element => (element as HTMLButtonElement).click());
      const shared = cell(page, 2).getByRole("button");
      await expect(shared).toHaveCount(1);
      await expect(shared).toHaveClass("queued-duration-details");
      await expect(shared).toHaveAccessibleName(/Queued \/ Duration\..*Open details\./);
      await expect(shared).toBeFocused();
      const bounds = (await shared.boundingBox())!;
      expect(bounds.width).toBeGreaterThanOrEqual(24);
      expect(bounds.height).toBeGreaterThanOrEqual(24);
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog")).toHaveAccessibleName("Queued / Duration");
      await page.keyboard.press("Escape");
      await expect(shared).toBeFocused();
      await page.clock.runFor(1_000);
      await expect(shared).toBeFocused();
      expect(await kept.evaluate(saved => ({
        connected: saved.button.isConnected && saved.fill.isConnected,
        sameFill: saved.button.querySelector(".duration-fill") === saved.fill,
        animationTime: Number(saved.fill.getAnimations({ subtree: true })[0]?.currentTime),
        animationState: saved.fill.getAnimations({ subtree: true })[0]?.playState,
        hiddenFromNavigation: saved.button.closest(".queued-duration-source")?.hasAttribute("inert"),
      }))).toEqual({ connected: true, sameFill: true, animationTime: 2_456,
        animationState: "paused", hiddenFromNavigation: true });
      await toggle(page).evaluate(element => (element as HTMLButtonElement).click());
      await expect(source).toBeFocused();
      expect(await kept.evaluate(saved => saved.focused === document.activeElement)).toBe(true);
      await expect(source).not.toHaveAttribute("tabindex");
    }
  });
}

test("saved layout is independent of Duration text and both motion preferences, while invalid storage defaults separate", async ({ page }) => {
  await page.goto(await start());
  await openPreviewTools(page);
  await ready(page);
  await page.getByRole("button", { name: "Toggle Duration display", exact: true }).click();
  await page.getByLabel("Duration animation", { exact: true }).selectOption("off");
  await page.getByLabel("State animation", { exact: true }).selectOption("system");
  const originalStorage = await page.evaluate(() => ({ ...localStorage }));
  await toggle(page).click();
  expect(await page.evaluate(() => ({ ...localStorage }))).toEqual({ ...originalStorage, [storageKey]: "combined" });
  await page.reload();
  await openPreviewTools(page);
  await expectLayoutIcon(page, true);
  await expect(cell(page, 1)).toHaveText("2m / 10m", { useInnerText: true });
  await expect(page.getByLabel("Duration animation", { exact: true })).toHaveValue("off");
  await expect(page.getByLabel("State animation", { exact: true })).toHaveValue("system");
  await expect(page.locator("#duration-display-toggle")).toHaveAttribute("data-mode", "text");
  await page.getByRole("button", { name: "Toggle Duration display", exact: true }).click();
  expect(await cell(page, 1).locator(".duration-fill").evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
  await page.getByLabel("Duration animation", { exact: true }).selectOption("on");
  expect(await cell(page, 1).locator(".duration-fill").evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(1);
  await page.getByLabel("Duration animation", { exact: true }).selectOption("system");
  expect(await cell(page, 1).locator(".duration-fill").evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  expect(await cell(page, 1).locator(".duration-fill").evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(1);
  await page.evaluate(key => localStorage.setItem(key, "not-a-layout"), storageKey);
  await page.reload();
  await openPreviewTools(page);
  await expectLayoutIcon(page, false);
  await expect(cell(page, 1, "duration")).toBeVisible();
  await expect(cell(page, 1)).toBeHidden();
});

test("denied browser storage still permits toggling and defaults separate again after reload", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { configurable: true,
      get() { throw new DOMException("Storage denied by isolated test", "SecurityError"); } });
  });
  await page.goto(await start());
  await openPreviewTools(page);
  await ready(page);
  await expectLayoutIcon(page, false);
  await toggle(page).click();
  await expect(cell(page, 0)).toHaveText("2/12", { useInnerText: true });
  await toggle(page).click();
  await expect(cell(page, 0, "queued")).toBeVisible();
  await toggle(page).click();
  await page.reload();
  await openPreviewTools(page);
  await expectLayoutIcon(page, false);
});

test("hidden-page resume preserves stale overlap and source deadlines without layout-triggered reads", async ({ page }) => {
  let queueCalls = 0;
  let jobCalls = 0;
  await page.goto(await start({
    queue: async () => { queueCalls++; return queueSnapshot(); },
    jobs: async () => { jobCalls++; return jobSnapshot(); },
  }));
  await openPreviewTools(page);
  await ready(page);
  await toggle(page).click();
  await visibility(page, "hidden");
  await page.clock.fastForward(190_000);
  expect(queueCalls).toBe(1);
  expect(jobCalls).toBe(1);
  await visibility(page, "visible");
  await expect.poll(() => queueCalls).toBe(2);
  await expect.poll(() => jobCalls).toBe(2);
  await expect(cell(page, 2).locator(".queue-value")).toHaveCSS("color", "rgb(119, 119, 119)");
  await expect(cell(page, 2).locator(".duration-value")).toHaveClass(/duration-stale/);
  await expect(cell(page, 2, "queued")).toHaveAttribute("data-queue-checked-at", String(NOW - 1_000));
  await expect(cell(page, 2, "duration")).toHaveAttribute("data-job-checked-at", String(NOW));
  const original = await sources(page);
  const originalRequests = [...requests];
  await toggle(page).click();
  await toggle(page).click();
  expect(await sources(page)).toEqual(original);
  expect(requests).toEqual(originalRequests);
  await cell(page, 2).getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText("local evidence expired");
  await expect(page.getByRole("dialog")).toContainText(new Date(NOW).toISOString());
  await expect(page.getByRole("dialog")).toContainText(new Date(NOW - 1_000).toISOString());
});

for (const stackedInitially of [true, false]) {
  test(`an open popup returns to the surviving action after ${stackedInitially ? "stacked to single" : "single to stacked"} background readings`, async ({ page }) => {
    let changed = false;
    const resumedAt = NOW + 190_000;
    await page.goto(await start({
      queue: async () => {
        const snapshot = queueSnapshot();
        if (changed && stackedInitially) {
          // One market snapshot gives every member the same source deadline.
          for (const record of snapshot.hosts) {
            record.checkedAtMs = resumedAt;
            record.validUntilMs = resumedAt + 30_000;
            record.sourceUpdatedAtMs = resumedAt - 1_000;
          }
        }
        return snapshot;
      },
      jobs: async () => {
        const snapshot = await jobSnapshot();
        if (!stackedInitially && !changed) snapshot.hosts[2] = (await emptyJobs(addresses)).hosts[2]!;
        if (!stackedInitially && changed) {
          snapshot.hosts[2]!.checkedAtMs = resumedAt;
          snapshot.hosts[2]!.validUntilMs = resumedAt + 180_000;
        }
        return snapshot;
      },
    }));
    await ready(page);
    await toggle(page).click();
    await expect(cell(page, 2)).toHaveAttribute("data-stacked", String(stackedInitially));
    await cell(page, 2).getByRole("button").click();
    const inspected = await page.locator("#info-body").textContent();
    await visibility(page, "hidden");
    changed = true;
    // Resume after the existing source deadlines so both reads are eligible;
    // merely reopening a visible page never bypasses their refresh schedules.
    await page.clock.fastForward(190_000);
    await visibility(page, "visible");
    await expect(cell(page, 2)).toHaveAttribute("data-stacked", String(!stackedInitially));
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await page.locator("#info-body").textContent()).toBe(inspected);
    if (stackedInitially) await page.getByRole("button", { name: "Close", exact: true }).click();
    else await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(cell(page, 2).getByRole("button")).toBeFocused();
    if (!stackedInitially) {
      await expect(cell(page, 2).getByRole("button")).toHaveClass("queued-duration-details");
      await toggle(page).evaluate(element => (element as HTMLButtonElement).click());
      await expect(cell(page, 2, "queued").getByRole("button")).toBeFocused();
    }
  });
}

test("changing layouts cannot revive a retired job after its newer queue evidence expires", async ({ page }) => {
  let replaced = false;
  await page.goto(await start({ queue: async () => {
    const snapshot = queueSnapshot();
    if (replaced) for (const record of snapshot.hosts) {
      record.checkedAtMs = NOW + 1_000;
      record.validUntilMs = NOW + 31_000;
      record.sourceUpdatedAtMs = NOW;
    }
    return snapshot;
  } }));
  await openPreviewTools(page);
  await ready(page);
  await toggle(page).click();
  await expect(cell(page, 2).locator(".duration-fill")).toHaveCount(1);
  replaced = true;
  await page.clock.runFor(1_000);
  const refreshed = page.waitForResponse(response => response.url().endsWith("/preview/queue.json"));
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await refreshed;
  await expect(cell(page, 2)).toHaveText("3/12", { useInnerText: true });
  await expect(cell(page, 2).locator(".duration-fill")).toHaveCount(0);
  await visibility(page, "hidden");
  await page.clock.fastForward(190_000);
  await visibility(page, "visible");
  await expect(cell(page, 2)).toHaveText("3/12", { useInnerText: true });
  await toggle(page).click();
  await expect(cell(page, 2, "duration")).toHaveText("Populating..", { useInnerText: true });
  await expect(cell(page, 2, "duration").locator(".duration-fill")).toHaveCount(0);
  await cell(page, 2, "duration").getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText("previous counter was superseded");
  await expect(page.getByRole("dialog")).toContainText(new Date(NOW + 1_000).toISOString());
  await page.keyboard.press("Escape");
  await toggle(page).click();
  await cell(page, 2).getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText("previous counter was superseded");
  await expect(page.getByRole("dialog")).toContainText(new Date(NOW + 1_000).toISOString());
});

for (const width of [1440, 390]) {
  test(`combined table preserves compact rows and the divider at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(await start());
    await openPreviewTools(page);
    await ready(page);
    await expectLayoutIcon(page, false);
    await expectIconCentered(page);
    const initialHeight = (await cell(page, 2, "duration").boundingBox())!.height;
    const initialWidth = await page.locator(".fleet-table").evaluate(element => element.getBoundingClientRect().width);
    await toggle(page).click();
    await expectLayoutIcon(page, true);
    await expectIconCentered(page);
    await expect(cell(page, 2)).toBeVisible();
    await expect(cell(page, 2, "queued")).toBeHidden();
    await expect(cell(page, 2, "duration")).toBeHidden();
    for (const index of [0, 1, 2, 3, 4, 5, 6]) {
      const geometry = await cell(page, index).evaluate(element => {
        const rect = element.getBoundingClientRect();
        const row = element.parentElement!;
        const state = row.querySelector('[data-col="state"]')!.getBoundingClientRect();
        const divider = row.querySelector(".column-divider")!;
        const dividerRect = divider.getBoundingClientRect();
        const next = divider.nextElementSibling!.getBoundingClientRect();
        const buttons = [...element.querySelectorAll("button")].filter(button => button.getClientRects().length > 0);
        return { height: rect.height, stateEnd: state.right, left: rect.left, right: rect.right,
          dividerLeft: dividerRect.left, dividerRight: dividerRect.right, nextLeft: next.left,
          dividerWidth: dividerRect.width, lineWidth: getComputedStyle(divider, "::before").width,
          buttonsInside: buttons.every(button => {
            const box = button.getBoundingClientRect();
            return box.top >= rect.top && box.bottom <= rect.bottom && box.left >= rect.left && box.right <= rect.right;
          }) };
      });
      expect(geometry.height).toBeLessThanOrEqual(initialHeight + 1);
      expect(geometry.height).toBe(34);
      expect(geometry.left).toBeCloseTo(geometry.stateEnd, 0);
      expect(geometry.right).toBeCloseTo(geometry.dividerLeft, 0);
      expect(geometry.dividerRight).toBeCloseTo(geometry.nextLeft, 0);
      expect(geometry.dividerWidth).toBeCloseTo(34, 0);
      expect(geometry.lineWidth).toBe("1px");
      expect(geometry.buttonsInside).toBe(true);
    }
    expect(await page.locator(".fleet-table").evaluate(element => element.getBoundingClientRect().width)).toBeLessThan(initialWidth);
    const combinedHeader = page.locator('th[data-col="queued-duration"]');
    await expect(combinedHeader).toBeVisible();
    expect(await combinedHeader.evaluate(element => element.nextElementSibling!.classList.contains("column-divider"))).toBe(true);
    // Suppressed source placeholders and hidden cells must not be reachable by
    // accessibility navigation; each useful source appears only once.
    await expect(cell(page, 0).getByRole("button")).toHaveCount(1);
    await expect(cell(page, 1).getByRole("button")).toHaveCount(1);
    await expect(cell(page, 2).getByRole("button")).toHaveCount(1);
    await expect(cell(page, 2).getByRole("button")).toHaveClass("queued-duration-details");
    await expect(cell(page, 0, "duration").getByRole("button")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`queued-duration-${width}.png`), fullPage: true });
    await toggle(page).click();
    await expectLayoutIcon(page, false);
    await expectIconCentered(page);
    await expect(cell(page, 0, "duration").getByRole("button")).toHaveCount(1);
    await expect(cell(page, 0).getByRole("button")).toHaveCount(0);
  });
}
