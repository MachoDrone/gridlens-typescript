import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { SYNTHETIC_HOST_ADDRESSES as addresses } from "../fixtures/host-addresses.ts";

const NOW = Date.UTC(2026, 0, 1, 12);
const endpoint = "**/preview/connection.json";
const errors: string[] = [];
const external: string[] = [];
const indicator = (page: Page) => page.locator("#fleet-connection");
const ok = (route: Route) => route.fulfill({ json: { status: "ok" } });

async function visibility(page: Page, state: "visible" | "hidden"): Promise<void> {
  await page.evaluate(value => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => value === "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

async function expectCompleteHeaderVisible(page: Page): Promise<void> {
  await expect.poll(async () => {
    await page.clock.runFor(32);
    return page.evaluate(() => {
      const viewport = visualViewport!;
      const issues: string[] = [];
      const indicator = document.getElementById("fleet-connection")!;
      const badge = indicator.getBoundingClientRect();
      const header = document.querySelector(".fleet-title-row")!.getBoundingClientRect();
      const unreachable = indicator.dataset.connectionState === "unreachable";
      const headingExpected = header.width >= 200 && (!unreachable || header.width >= 300);
      const clearExpected = header.width >= 160;
      const title = document.querySelector(".fleet-title-row h1")!.getBoundingClientRect();
      if (header.height !== (unreachable ? 40 : 32)) issues.push("header exceeds its single-row height");
      for (const selector of [".fleet-title-row", ".fleet-title-row h1", "#host-count", "#clear-sort", "#fleet-connection", ".connection-ball"]) {
        const element = document.querySelector<HTMLElement>(selector)!;
        const bounds = element.getBoundingClientRect();
        const expectedVisible = [".fleet-title-row h1", "#host-count"].includes(selector) ? headingExpected : selector === "#clear-sort" ? clearExpected : true;
        const visible = bounds.width > 0 && bounds.height > 0 && getComputedStyle(element).visibility !== "hidden";
        if (visible !== expectedVisible) issues.push(`${selector} visibility does not match available header width ${header.width}`);
        if (!visible) continue;
        if (bounds.left < viewport.offsetLeft - 1 ||
            bounds.right > viewport.offsetLeft + viewport.width + 1 || bounds.top < viewport.offsetTop - 1 ||
            bounds.bottom > viewport.offsetTop + viewport.height + 1) issues.push(`${selector} outside visible viewport`);
        if (selector === ".fleet-title-row") continue;
        const range = document.createRange();
        range.selectNodeContents(element);
        const boxes = [".connection-ball", "#clear-sort"].includes(selector) ? [bounds] : [...range.getClientRects()];
        for (const raw of boxes) {
          // Full text stays accessible when CSS ellipsizes its painted area.
          const left = Math.max(raw.left, bounds.left), top = Math.max(raw.top, bounds.top);
          const box = new DOMRect(left, top, Math.min(raw.right, bounds.right) - left, Math.min(raw.bottom, bounds.bottom) - top);
          if (box.width <= 1 || box.height <= 1) continue;
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          if (hit === null || !element.contains(hit)) issues.push(`${selector} covered`);
          if ([".fleet-title-row h1", "#host-count", "#clear-sort"].includes(selector) && box.left < badge.right - 1 && box.right > badge.left + 1 &&
              box.top < badge.bottom - 1 && box.bottom > badge.top + 1) issues.push(`${selector} overlaps indicator`);
        }
        if (Math.abs((bounds.top + bounds.bottom) / 2 - (badge.top + badge.bottom) / 2) > 1) {
          issues.push(`${selector} is not centered on the single header row`);
        }
      }
      if (headingExpected && Math.min(title.bottom, badge.bottom) <= Math.max(title.top, badge.top)) issues.push("title and indicator are not on the same row");
      return issues;
    });
  }).toEqual([]);
}

test.beforeEach(async ({ page, context }) => {
  errors.length = external.length = 0;
  page.on("pageerror", error => errors.push(error.message));
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin !== "http://127.0.0.1:4174") {
      external.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  await page.clock.install({ time: NOW });
  await page.clock.pauseAt(NOW);
});

test.afterEach(async ({ page }) => {
  await page.close();
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test("checks before claiming Connected and leaves a stable accessible status on repeated success", async ({ page }) => {
  let pending: Route | undefined;
  let checks = 0;
  await page.route(endpoint, route => { checks++; pending = route; });
  await page.goto("/?scenario=fresh");
  await expect(indicator(page)).toHaveText("Checking…");
  await expect(indicator(page)).toHaveAttribute("data-connection-state", "checking");
  await expect(indicator(page)).toHaveAttribute("role", "status");
  await expect(indicator(page)).toHaveAttribute("aria-live", "polite");
  await expect(indicator(page).locator(".connection-ball")).toHaveAttribute("aria-hidden", "true");
  await expect.poll(() => checks).toBe(1);
  await ok(pending!);
  await expect(indicator(page)).toHaveText("Connected");
  await expect(indicator(page).locator(".connection-ball")).toHaveCSS("background-color", "rgb(16, 232, 12)");
  await expect(page.locator("#preview-tools")).not.toHaveAttribute("open");
  await page.evaluate(() => {
    const element = document.getElementById("fleet-connection")!;
    element.dataset.testMutations = "0";
    const observer = new MutationObserver(records => {
      const meaningful = records.filter(record => record.attributeName !== "data-test-mutations");
      if (meaningful.length) element.dataset.testMutations = String(Number(element.dataset.testMutations) + meaningful.length);
    });
    observer.observe(element, { attributes: true, childList: true, characterData: true, subtree: true });
  });
  await page.clock.runFor(15_000);
  await expect.poll(() => checks).toBe(2);
  await ok(pending!);
  await page.clock.runFor(1);
  await expect(indicator(page)).toHaveAttribute("data-test-mutations", "0");
});

test("an offline phone turns red and only a successful retry restores green", async ({ page, context }) => {
  await page.goto("/?scenario=fresh");
  await expect(indicator(page)).toHaveText("Connected");
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await page.clock.runFor(15_001);
  await expect(indicator(page)).toHaveText("Data Unreachable");
  await expect(indicator(page)).toHaveAttribute("data-connection-state", "unreachable");
  await expect(indicator(page).locator(".connection-ball")).toHaveCSS("background-color", "rgb(255, 0, 0)");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(indicator(page)).toHaveText("Data Unreachable");
  await context.setOffline(false);
  await page.clock.runFor(5_001);
  await expect(indicator(page)).toHaveText("Connected");
});

test("a hanging service becomes unreachable after eight seconds and recovers without reloading", async ({ page }) => {
  let pending: Route | undefined;
  let calls = 0;
  await page.route(endpoint, route => { calls++; pending = route; });
  await page.goto("/?scenario=fresh");
  await expect.poll(() => calls).toBe(1);
  await page.clock.runFor(7_999);
  await expect(indicator(page)).toHaveText("Checking…");
  await page.clock.runFor(1);
  await expect(indicator(page)).toHaveText("Data Unreachable");
  // The canceled older response cannot restore green.
  await ok(pending!);
  await expect(indicator(page)).toHaveText("Data Unreachable");
  await page.clock.runFor(5_000);
  await expect.poll(() => calls).toBe(2);
  await ok(pending!);
  await expect(indicator(page)).toHaveText("Connected");
});

test("hidden pages stop checking and revalidate before claiming a resumed connection", async ({ page }) => {
  let calls = 0;
  let hold = false;
  let pending: Route | undefined;
  await page.route(endpoint, route => {
    calls++;
    if (hold) { pending = route; return; }
    return ok(route);
  });
  await page.goto("/?scenario=fresh");
  await expect(indicator(page)).toHaveText("Connected");
  await visibility(page, "hidden");
  await page.clock.runFor(60_000);
  expect(calls).toBe(1);
  hold = true;
  await visibility(page, "visible");
  await expect(indicator(page)).toHaveText("Checking…");
  await expect.poll(() => calls).toBe(2);
  await ok(pending!);
  await expect(indicator(page)).toHaveText("Connected");
  await visibility(page, "hidden");
  await visibility(page, "visible");
  await expect.poll(() => calls).toBe(3);
  await pending!.fulfill({ status: 503, body: "unavailable" });
  await expect(indicator(page)).toHaveText("Data Unreachable");
  await visibility(page, "hidden");
  await page.clock.runFor(60_000);
  expect(calls).toBe(3);
  await visibility(page, "visible");
  await expect.poll(() => calls).toBe(4);
  await expect(indicator(page)).toHaveText("Data Unreachable");
  await ok(pending!);
  await expect(indicator(page)).toHaveText("Connected");
});

test("host Offline and source failures remain separate from Fleet connection and keep their evidence", async ({ page }) => {
  await page.route("**/preview/node-info.json", route => route.fulfill({ json: {
    hosts: addresses.map(address => ({ address, values: null, fetchedAtMs: null, validUntilMs: null,
      retained: false, error: "Node Info unavailable (HTTP 503)", apiCheck: { status: "offline", checkedAtMs: NOW } })),
  } }));
  await page.route("**/preview/sol.json", route => route.fulfill({ status: 503, body: "unavailable" }));
  let reachable = true;
  await page.route(endpoint, route => reachable ? ok(route) : route.fulfill({ status: 503, body: "unavailable" }));
  await page.goto("/");
  const cell = page.locator(`#fleet-rows [data-host="${addresses[0]}"] td[data-col="api"]`);
  await expect(cell).toHaveText("Offline");
  await expect(indicator(page)).toHaveText("Connected");
  await page.clock.runFor(31_000);
  await expect(cell).toHaveAttribute("data-api-current", "false");
  await expect(cell).toHaveAttribute("data-api-checked-at", String(NOW));
  reachable = false;
  await page.clock.runFor(15_001);
  await expect(indicator(page)).toHaveText("Data Unreachable");
  reachable = true;
  await page.clock.runFor(5_001);
  await expect(indicator(page)).toHaveText("Connected");
  await expect(cell).toHaveText("Offline");
  await expect(cell).toHaveAttribute("data-api-current", "false");
  await expect(cell).toHaveAttribute("data-api-checked-at", String(NOW));
});

for (const width of [320, 390, 1440]) {
  test(`complete Fleet header stays visible while scrolling without covering controls at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    let reachable = true;
    await page.route(endpoint, route => reachable ? ok(route) : route.fulfill({ status: 502, body: "unavailable" }));
    await page.goto("/?scenario=scale");
    await expect(indicator(page)).toHaveText("Connected");
    await expect(indicator(page).locator(".connection-ball")).toHaveCSS("width", "8px");
    await expectCompleteHeaderVisible(page);
    for (const position of [[0, 500], [0, 0], [100_000, 500], [0, 0]]) {
      await page.evaluate(([left, top]) => {
        document.querySelector(".fleet-table-wrap")!.scrollLeft = left!;
        window.scrollTo(0, top!);
      }, position);
      await expectCompleteHeaderVisible(page);
      expect(await page.evaluate(() => window.scrollX)).toBe(0);
      if (position[0] && width < 1440) {
        expect(await page.locator(".fleet-table-wrap").evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
        await expect(page.getByRole("button", { name: "Sort by Country", exact: true })).toBeInViewport();
      }
    }
    reachable = false;
    await page.clock.runFor(15_001);
    await expect(indicator(page)).toHaveText("Data Unreachable");
    await expect(indicator(page)).toHaveCSS("font-size", "16px");
    await expect(indicator(page)).toHaveCSS("font-weight", "700");
    await expect(indicator(page).locator(".connection-ball")).toHaveCSS("width", "20px");
    const geometry = await page.evaluate(() => {
      const badge = document.getElementById("fleet-connection")!.getBoundingClientRect();
      const label = document.querySelector("[data-connection-label]")!.getBoundingClientRect();
      const ball = document.querySelector(".connection-ball")!.getBoundingClientRect();
      const controls = [".fleet-heading", "#clear-sort"].map(selector => document.querySelector(selector)!.getBoundingClientRect());
      return { right: badge.right, left: badge.left, top: badge.top, wordsLeft: label.right <= ball.left,
        overlap: controls.some(rect => rect.left < badge.right && rect.right > badge.left && rect.top < badge.bottom && rect.bottom > badge.top) };
    });
    expect(geometry.right).toBeLessThanOrEqual(width - 10);
    expect(geometry.left).toBeGreaterThanOrEqual(56);
    expect(geometry.top).toBe(4);
    expect(geometry.wordsLeft).toBe(true);
    expect(geometry.overlap).toBe(false);
    await page.evaluate(() => { document.querySelector(".fleet-table-wrap")!.scrollLeft = 100_000; window.scrollTo(0, 500); });
    await expectCompleteHeaderVisible(page);
    const afterScroll = await indicator(page).boundingBox();
    expect(afterScroll!.x).toBe(geometry.left);
    expect(afterScroll!.y).toBe(geometry.top);
    expect(await page.locator(".fleet-table th").first().evaluate(element =>
      element.getBoundingClientRect().top >= document.querySelector(".fleet-title-row")!.getBoundingClientRect().bottom)).toBe(true);
    await page.evaluate(() => { document.querySelector(".fleet-table-wrap")!.scrollLeft = 0; window.scrollTo(0, 0); });
    await expectCompleteHeaderVisible(page);
    await expect(page.getByRole("button", { name: "Sort by Staked NOS", exact: true })).toBeInViewport();
    await page.getByRole("button", { name: "Expand menu", exact: true }).count().then(async count => {
      if (!count) return;
      await page.getByRole("button", { name: "Expand menu", exact: true }).click();
      await expect(page.getByRole("button", { name: "Collapse menu", exact: true })).toBeFocused();
      await page.keyboard.press("Escape");
    });
    await expectCompleteHeaderVisible(page);
    if (width === 390) await page.screenshot({ path: info.outputPath("android-unreachable.png") });
  });
}
