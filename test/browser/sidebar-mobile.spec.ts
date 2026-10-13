import { expect, test } from "@playwright/test";
import type { CDPSession, Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPreviewServer } from "../../scripts/preview-server.ts";
import { SYNTHETIC_HOST_ADDRESSES as addresses } from "../fixtures/host-addresses.ts";
import { emptyQueue } from "../fixtures/queue.ts";
import { emptySol } from "../fixtures/sol.ts";
import { emptyNos } from "../fixtures/nos.ts";
import { emptyStaking } from "../fixtures/staking.ts";

// The 200-row journeys keep explicit screenshots and geometry diagnostics.
// Repeated whole-DOM trace snapshots otherwise consume their wall-clock budget.
test.use({ isMobile: true, hasTouch: true, deviceScaleFactor: 2, trace: "off" });

const errors: string[] = [];
const external: string[] = [];

test.beforeEach(async ({ page, context }) => {
  errors.length = external.length = 0;
  page.on("pageerror", error => errors.push(error.message));
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1") { external.push(url.href); return route.abort(); }
    return route.continue();
  });
});

test.afterEach(() => {
  expect(errors).toEqual([]);
  expect(external, "Sidebar checks must stay on isolated fixture servers").toEqual([]);
});

async function geometry(page: Page) {
  return page.evaluate(() => {
    const viewport = visualViewport!;
    const sidebar = document.querySelector("#sidebar")!.getBoundingClientRect();
    const first = document.querySelector("#fleet-rows td")!;
    const cell = first.getBoundingClientRect();
    const mainStyle = getComputedStyle(document.querySelector("main")!);
    const header = document.querySelector(".fleet-title-row")!.getBoundingClientRect();
    const issues: string[] = [];
    for (const selector of ["h1", "#host-count", "#clear-sort", "#fleet-connection", ".connection-ball"]) {
      const element = document.querySelector(selector)!;
      const rect = element.getBoundingClientRect();
      const visible = element.checkVisibility({ visibilityProperty: true }) && rect.width > 0 && rect.height > 0;
      const expectedVisible = ["h1", "#host-count"].includes(selector) ? header.width >= 200 : selector === "#clear-sort" ? header.width >= 160 : true;
      if (visible !== expectedVisible) issues.push(`${selector} visibility does not match available header space`);
      if (!visible) continue;
      if (rect.left < viewport.offsetLeft - 1 || rect.right > viewport.offsetLeft + viewport.width + 1 ||
          rect.top < viewport.offsetTop - 1 || rect.bottom > viewport.offsetTop + viewport.height + 1) issues.push(`${selector} outside visual viewport`);
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (hit === null || !element.contains(hit)) issues.push(`${selector} covered`);
    }
    return {
      viewport: { width: viewport.width, height: viewport.height, left: viewport.offsetLeft, pageLeft: viewport.pageLeft },
      tableX: document.querySelector(".fleet-table-wrap")!.scrollLeft,
      sidebarRight: sidebar.right, firstLeft: cell.left,
      firstPainted: first.contains(document.elementFromPoint(cell.left + cell.width / 2, cell.top + cell.height / 2)),
      headerLeft: header.left, headerRight: header.right,
      opacity: mainStyle.opacity, filter: mainStyle.filter, issues,
    };
  });
}

async function expectUncovered(page: Page): Promise<void> {
  await expect.poll(async () => {
    const value = await geometry(page);
    return value.firstLeft - value.sidebarRight;
  }).toBeGreaterThanOrEqual(11);
  await expect.poll(async () => (await geometry(page)).firstPainted).toBe(true);
  await expect.poll(async () => (await geometry(page)).issues).toEqual([]);
  const value = await geometry(page);
  expect(value.opacity).toBe("1");
  expect(value.filter).toBe("none");
  expect(value.headerLeft).toBeGreaterThanOrEqual(value.sidebarRight - 1);
  expect(value.headerRight).toBeCloseTo(value.viewport.left + value.viewport.width, 0);
  await expect(page.locator("#sidebar-backdrop")).toBeHidden();
  expect(await page.locator("main").evaluate(element => (element as HTMLElement).inert)).toBe(false);
}

async function swipe(page: Page, session: CDPSession, reverse = false): Promise<void> {
  const value = await geometry(page);
  const left = Math.max(16, value.sidebarRight - value.viewport.left + 12);
  const right = value.viewport.width - 16;
  const from = { x: reverse ? left : right, y: value.viewport.height * .65 };
  const to = { x: reverse ? right : left, y: from.y };
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
  for (let step = 1; step <= 12; step++) {
    // Chromium needs elapsed gesture time to perform native touch page panning.
    await new Promise(resolve => setTimeout(resolve, 25));
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{
      x: from.x + (to.x - from.x) * step / 12, y: from.y,
    }] });
  }
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

for (const width of [320, 390]) {
  test(`expanded mobile menu leaves the table usable and first column reachable at ${width}px`, async ({ page, context }, info) => {
    // Use the fixed-navigation journey allowance; per-action assertions stay unchanged.
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/?scenario=scale");
    await expect(page.locator("#fleet-rows tr")).toHaveCount(200);
    await expect(page.locator("#fleet-connection")).toHaveText("Connected");
    const toggle = page.locator("#sidebar-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const collapsed = await geometry(page);
    await toggle.tap();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expectUncovered(page);
    const expanded = await geometry(page);
    expect(expanded.firstLeft - collapsed.firstLeft).toBeCloseTo(expanded.sidebarRight - collapsed.sidebarRight, 0);
    expect(expanded.firstLeft).toBeGreaterThan(collapsed.firstLeft + 40);

    // An expanded nonmodal menu must not trap keyboard users or block column taps.
    await page.locator(".sidebar-link:last-child a").focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Clear sort", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Sort by Staked NOS", exact: true }).tap();
    await expect(page.locator('th[data-col="stakedNos"]')).toHaveAttribute("aria-sort", "ascending");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");

    const session = await context.newCDPSession(page);
    await swipe(page, session);
    await expect.poll(async () => (await geometry(page)).tableX).toBeGreaterThan(40);
    await expect.poll(async () => (await geometry(page)).issues).toEqual([]);
    for (let attempt = 0; attempt < 4 && (await geometry(page)).tableX > 1; attempt++) await swipe(page, session, true);
    await expect.poll(async () => (await geometry(page)).tableX).toBeLessThan(1);
    await expectUncovered(page);
    await page.screenshot({ path: info.outputPath(`expanded-mobile-menu-${width}.png`) });

    await page.reload();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expectUncovered(page);
    await toggle.tap();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await page.reload();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(await page.locator(".sidebar-footer").evaluate(element => (element as HTMLElement).inert)).toBe(true);
    await expectUncovered(page);
  });
}

test("expanded phone menu preserves live Duration ticks and scheduled State refresh without extra reads", async ({ page }) => {
  const now = Date.UTC(2026, 0, 1, 12);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  const directory = await mkdtemp(join(tmpdir(), "gridlens-sidebar-browser-"));
  const hostsFile = join(directory, "hosts.json");
  const real200HostsFile = join(directory, "real200.json");
  await writeFile(hostsFile, JSON.stringify([addresses[0]]));
  await writeFile(real200HostsFile, "[]\n");
  let stateCalls = 0;
  const reads: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/preview/") && path.endsWith(".json") && path !== "/preview/connection.json") reads.push(path);
  });
  const server = await startPreviewServer({ now: () => now, hostsFile, real200HostsFile, port: 0,
    metadataProvider: async input => ({ hosts: input.map(address => ({ address, values: null, fetchedAtMs: null,
      retained: false, error: null, marketError: null })) }),
    nodeInfoProvider: async input => {
      stateCalls++;
      const at = await page.evaluate(() => Date.now());
      return { hosts: input.map(address => ({ address,
        values: { state: stateCalls === 1 ? "RUNNING_JOB" : "RESTARTING", dl: 100, ul: 20, ping: 8, networkUnavailableReason: null },
        fetchedAtMs: at, validUntilMs: at + 30_000, retained: false, error: null })) };
    },
    jobProvider: async input => ({ hosts: input.map(address => ({ address,
      job: { address: addresses[1]!, node: address, state: "RUNNING", timeStart: (now - 120_000) / 1000, timeEnd: 0, timeout: 600 },
      checkedAtMs: now, validUntilMs: now + 180_000, failedAtMs: null, retained: false, pending: false, retryAtMs: null, error: null })) }),
    queueProvider: emptyQueue, solProvider: emptySol, nosProvider: emptyNos, stakingProvider: emptyStaking,
  });
  try {
    const bound = server.address();
    if (!bound || typeof bound === "string") throw new Error("Missing isolated preview port");
    await page.goto(`http://127.0.0.1:${bound.port}/`);
    const duration = page.locator('td[data-col="duration"] button');
    await expect(duration).toHaveAccessibleName(/2m \/ 10m/);
    await expect(page.locator("#fleet-rows .state-running")).toHaveCount(1);
    const before = [...reads];
    await page.locator("#sidebar-toggle").tap();
    await expect(page.locator("#sidebar-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(reads, "Opening the menu must not dispatch a data refresh").toEqual(before);
    await page.clock.runFor(1_000);
    await expect(duration).toHaveAccessibleName(/2m 1s \/ 10m/);
    await page.clock.runFor(20_000);
    await expect.poll(() => stateCalls).toBe(2);
    await expect(page.locator("#fleet-rows .state-restarting")).toHaveCount(1);
    await expect(page.locator("#sidebar-toggle")).toHaveAttribute("aria-expanded", "true");
    const after = [...reads];
    await page.locator("#sidebar-toggle").tap();
    expect(reads, "Closing the menu must not dispatch a data refresh").toEqual(after);
  } finally {
    await page.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
