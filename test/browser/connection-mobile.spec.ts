import { expectFleetDocumentFlow } from "./helpers.ts";
import { setBrowserPinchScale } from "./viewport-input.ts";
import { expect, test } from "@playwright/test";
import type { CDPSession, Page } from "@playwright/test";

test.use({ isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

const indicator = (page: Page) => page.locator("#fleet-connection");

async function geometry(page: Page) {
  return page.evaluate(() => {
    const viewport = visualViewport!;
    const badge = document.getElementById("fleet-connection")!;
    const rect = badge.getBoundingClientRect();
    const label = badge.querySelector<HTMLElement>("[data-connection-label]")!;
    const labelRect = label.getBoundingClientRect();
    const ball = badge.querySelector(".connection-ball")!.getBoundingClientRect();
    const header = document.querySelector<HTMLElement>(".fleet-title-row")!;
    const headerRect = header.getBoundingClientRect();
    const titleRect = header.querySelector("h1")!.getBoundingClientRect();
    const unreachable = badge.dataset.connectionState === "unreachable";
    const headingExpected = headerRect.width >= 200 && (!unreachable || headerRect.width >= 300);
    const clearExpected = headerRect.width >= 160;
    const contentStyle = getComputedStyle(header.querySelector(".fleet-title-content")!);
    const badgeStyle = getComputedStyle(badge);
    const issues: string[] = [];
    const textBoxes = (element: Element, bounds: DOMRect): DOMRect[] => {
      const range = document.createRange();
      range.selectNodeContents(element);
      // Ellipsized text retains its full DOM range; sample only its painted box.
      return [...range.getClientRects()].map(rect => {
        const left = Math.max(rect.left, bounds.left), top = Math.max(rect.top, bounds.top);
        return new DOMRect(left, top, Math.min(rect.right, bounds.right) - left, Math.min(rect.bottom, bounds.bottom) - top);
      }).filter(rect => rect.width > 1 && rect.height > 1);
    };
    const overlaps = (left: DOMRect, right: DOMRect): boolean =>
      left.left < right.right - 1 && left.right > right.left + 1 && left.top < right.bottom - 1 && left.bottom > right.top + 1;
    const clear = header.querySelector("#clear-sort")!.getBoundingClientRect();
    for (const selector of [".fleet-title-row", "h1", "#host-count", "#clear-sort", "#fleet-connection", "[data-connection-label]", ".connection-ball"]) {
      const element = document.querySelector<HTMLElement>(selector)!;
      const bounds = element.getBoundingClientRect();
      const expectedVisible = ["h1", "#host-count"].includes(selector) ? headingExpected : selector === "#clear-sort" ? clearExpected : true;
      const visible = bounds.width > 0 && bounds.height > 0 && getComputedStyle(element).visibility !== "hidden";
      if (visible !== expectedVisible) issues.push(`${selector} visibility does not match available header width ${headerRect.width}`);
      if (!visible) continue;
      if (bounds.left < viewport.offsetLeft - 1 ||
          bounds.right > viewport.offsetLeft + viewport.width + 1 || bounds.top < viewport.offsetTop - 1 ||
          bounds.bottom > viewport.offsetTop + viewport.height + 1) issues.push(`${selector} outside visible viewport`);
      if (selector === ".fleet-title-row") continue;
      const boxes = [".connection-ball", "#clear-sort"].includes(selector) ? [bounds] : textBoxes(element, bounds);
      for (const box of boxes) {
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        if (hit === null || !element.contains(hit)) issues.push(`${selector} covered at its text/ball center`);
        if (["h1", "#host-count", "#clear-sort"].includes(selector) && overlaps(box, rect)) issues.push(`${selector} overlaps indicator`);
        if (["h1", "#host-count"].includes(selector) && overlaps(box, clear)) issues.push(`${selector} overlaps Clear sort`);
      }
      if (Math.abs((bounds.top + bounds.bottom) / 2 - (rect.top + rect.bottom) / 2) > 1) {
        issues.push(`${selector} is not centered on the single header row`);
      }
    }
    return {
      innerWidth, clientWidth: document.documentElement.clientWidth, scrollX, scrollY,
      tableX: document.querySelector(".fleet-table-wrap")!.scrollLeft,
      viewport: { width: viewport.width, height: viewport.height, scale: viewport.scale,
        left: viewport.offsetLeft, top: viewport.offsetTop, pageLeft: viewport.pageLeft, pageTop: viewport.pageTop },
      rightGap: viewport.offsetLeft + viewport.width - rect.right,
      topGap: rect.top - viewport.offsetTop,
      leftGap: rect.left - viewport.offsetLeft,
      labelOverflow: label.scrollWidth - label.clientWidth,
      labelBeforeBall: labelRect.right <= ball.left + 1,
      badgeHeight: rect.height, labelHeight: labelRect.height,
      labelWhiteSpace: getComputedStyle(label).whiteSpace,
      labelTextOverflow: getComputedStyle(label).textOverflow,
      headingExpected, unreachable, headerHeight: headerRect.height,
      statusHasRoom: headerRect.width - parseFloat(contentStyle.paddingLeft) - parseFloat(contentStyle.paddingRight) -
        (clearExpected ? clear.width + parseFloat(contentStyle.columnGap) : 0) >=
        label.scrollWidth + ball.width + parseFloat(badgeStyle.columnGap) + parseFloat(badgeStyle.paddingLeft) +
        parseFloat(badgeStyle.paddingRight) + parseFloat(badgeStyle.borderLeftWidth) + parseFloat(badgeStyle.borderRightWidth),
      issues,
      headerTopGap: headerRect.top - viewport.offsetTop,
      titleBadgeVerticalOverlap: Math.min(titleRect.bottom, rect.bottom) - Math.max(titleRect.top, rect.top),
      headerLayer: Number(getComputedStyle(document.querySelector(".fleet-title-row")!).zIndex),
      highestTableLayer: Math.max(...[...document.querySelectorAll(".fleet-table th")]
        .map(element => Number(getComputedStyle(element).zIndex))),
    };
  });
}

async function expectAnchored(page: Page, sameRow = false): Promise<void> {
  // Ordinary page/rotation navigation must stay fixed even if Chromium has
  // restored a non-1 browser scale. Intentional zoom is asserted separately.
  // Mobile horizontal pan changes visualViewport offsets even when scrollX is zero.
  await expect.poll(async () => (await geometry(page)).issues).toEqual([]);
  await expect.poll(async () => {
    const value = await geometry(page);
    return Math.max(Math.abs(value.rightGap - 12), Math.abs(value.headerTopGap));
  }).toBeLessThan(1);
  const value = await geometry(page);
  if (sameRow && value.headingExpected) expect(value.titleBadgeVerticalOverlap).toBeGreaterThan(0);
  expect(value.leftGap).toBeGreaterThanOrEqual(11);
  expect(value.labelBeforeBall).toBe(true);
  expect(value.headerHeight).toBe(value.unreachable ? 40 : 32);
  expect(value.labelHeight).toBe(value.unreachable ? 22 : 18);
  expect(value.labelWhiteSpace).toBe("nowrap");
  if (value.statusHasRoom) expect(value.labelOverflow, "Connection text takes priority over secondary header text").toBeLessThanOrEqual(1);
  if (value.labelOverflow > 1) expect(value.labelTextOverflow).toBe("ellipsis");
  expect(value.headerLayer, "Sticky data headers must not paint over the viewport-anchored badge")
    .toBeGreaterThan(value.highestTableLayer);
}

async function expectNaturalHeader(page: Page, baselineScale: number): Promise<void> {
  await expect.poll(async () => page.evaluate(baselineScale => {
    const viewport = visualViewport!, sidebar = document.querySelector("#sidebar")!.getBoundingClientRect();
    const header = document.querySelector(".fleet-title-row")!.getBoundingClientRect();
    const table = document.querySelector(".fleet-table-wrap")!.getBoundingClientRect();
    const badge = document.querySelector("#fleet-connection")!.getBoundingClientRect();
    const issues: string[] = [];
    if (Math.abs(sidebar.left + scrollX) > 1 || Math.abs(header.left + scrollX - sidebar.width) > 1 || Math.abs(header.top + scrollY) > 1)
      issues.push("Zoomed navigation moved away from its document layout");
    if (table.left < sidebar.right + 11 || table.top < header.bottom - 1) issues.push("Zoomed navigation overlaps the table");
    if (Math.abs(header.width + sidebar.width - viewport.width * viewport.scale / baselineScale) > 1) issues.push("Zoom shrank the header to the visible screen");
    for (const selector of ["h1", "#host-count", "#clear-sort", "#fleet-connection"]) {
      const element = document.querySelector(selector)!, r = element.getBoundingClientRect();
      if (!element.checkVisibility({ visibilityProperty: true }) || r.width <= 0 || r.height <= 0) continue;
      if (r.left < header.left - 1 || r.right > header.right + 1 || r.top < header.top - 1 || r.bottom > header.bottom + 1)
        issues.push(`${selector} leaves its header layout`);
      if (selector !== "#fleet-connection" && Math.min(r.right, badge.right) - Math.max(r.left, badge.left) > 1 &&
          Math.min(r.bottom, badge.bottom) - Math.max(r.top, badge.top) > 1) issues.push(`${selector} overlaps the connection status`);
    }
    return issues;
  }, baselineScale), { message: "At native zoom, header content may leave the visible screen but must retain non-overlapping document layout" }).toEqual([]);
}

async function swipe(page: Page, session: CDPSession, axis: "horizontal" | "vertical", reverse = false): Promise<void> {
  const { viewport } = await geometry(page);
  const start = axis === "horizontal"
    ? { x: viewport.width - 28, y: viewport.height * .7 }
    : { x: viewport.width * .6, y: viewport.height * .85 };
  const end = axis === "horizontal"
    ? { x: 24, y: start.y }
    : { x: start.x, y: viewport.height * .4 };
  const from = reverse ? end : start;
  const to = reverse ? start : end;
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
  for (let step = 1; step <= 12; step++) {
    // Native touch scrolling needs real gesture time, unlike window.scrollTo().
    await new Promise(resolve => setTimeout(resolve, 25));
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{
      x: from.x + (to.x - from.x) * step / 12,
      y: from.y + (to.y - from.y) * step / 12,
    }] });
  }
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

for (const width of [320, 390]) {
  test(`mobile Fleet header stays fixed normally and preserves natural document layout when zoomed at ${width}px`, async ({ page, context }, info) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 844 });
    const errors: string[] = [];
    const external: string[] = [];
    const dataReads: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin !== "http://127.0.0.1:4174") {
        external.push(url.href);
        return route.abort();
      }
      if (url.pathname.endsWith(".json") &&
          !["/preview/hosts.json", "/preview/connection.json"].includes(url.pathname)) dataReads.push(url.pathname);
      return route.continue();
    });
    let reachable = true;
    await page.route("**/preview/connection.json", route => reachable
      ? route.fulfill({ json: { status: "ok" } })
      : route.fulfill({ status: 503, body: "unavailable" }));
    await page.goto("/?scenario=scale");
    await expect(page.locator("#fleet-rows tr")).toHaveCount(200);
    await expect(indicator(page)).toHaveText("Connected");
    await expect(page.locator(".fleet-title-row h1")).toHaveText("Nosana Fleet");
    await expect(page.locator("#host-count")).toHaveText("200 hosts");
    await expect(page.getByRole("button", { name: "Clear sort", exact: true })).toBeVisible();
    const initial = await geometry(page);
    expect(initial.clientWidth).toBe(width);
    expect(initial.viewport.width).toBeCloseTo(width, 0);
    expect(initial.innerWidth).toBe(width);
    await expectAnchored(page, true);

    const session = await context.newCDPSession(page);
    await swipe(page, session, "vertical");
    await expect.poll(async () => (await geometry(page)).viewport.pageTop).toBeGreaterThan(initial.viewport.pageTop + 30);
    await expectAnchored(page, true);
    const greenDown = await geometry(page);
    await swipe(page, session, "vertical", true);
    await expect.poll(async () => (await geometry(page)).viewport.pageTop).toBeLessThan(greenDown.viewport.pageTop - 30);
    await expectAnchored(page, true);
    await swipe(page, session, "horizontal");
    await expect.poll(async () => (await geometry(page)).tableX).toBeGreaterThan(initial.tableX + 40);
    expect((await geometry(page)).viewport.left).toBeCloseTo(initial.viewport.left, 0);
    expect((await geometry(page)).scrollX).toBe(0);
    await expectAnchored(page, true);
    await page.screenshot({ path: info.outputPath("mobile-green-header-panned.png") });
    await page.setViewportSize({ width: 844, height: 390 });
    await expect.poll(async () => (await geometry(page)).clientWidth).toBe(844);
    await expectAnchored(page);
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(async () => (await geometry(page)).clientWidth).toBe(width);
    await expectAnchored(page);

    reachable = false;
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await expect(indicator(page)).toHaveText("Data Unreachable");
    await expectAnchored(page);
    const redStart = await geometry(page);
    await swipe(page, session, "vertical");
    await expect.poll(async () => (await geometry(page)).viewport.pageTop).toBeGreaterThan(redStart.viewport.pageTop + 30);
    await expectAnchored(page);
    const redDown = await geometry(page);
    await swipe(page, session, "vertical", true);
    await expect.poll(async () => (await geometry(page)).viewport.pageTop).toBeLessThan(redDown.viewport.pageTop - 30);
    await expectAnchored(page);
    await page.screenshot({ path: info.outputPath("mobile-red-portrait.png") });

    await page.setViewportSize({ width: 844, height: 390 });
    // Chromium can preserve zoom during orientation changes; use its actual viewport.
    await expect.poll(async () => (await geometry(page)).clientWidth).toBe(844);
    await expectAnchored(page);
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(async () => (await geometry(page)).clientWidth).toBe(width);
    await expectAnchored(page);

    await page.waitForTimeout(350); // Finish browser rotation/restoration before independent zoom input.
    const baselineViewport = (await geometry(page)).viewport;
    const baselineScale = baselineViewport.scale;
    await setBrowserPinchScale(page, session, baselineScale * 2);
    await expect.poll(async () => (await geometry(page)).viewport.scale).toBeCloseTo(baselineScale * 2, 2);
    await expectNaturalHeader(page, baselineScale);
    const zoomed = await geometry(page);
    expect(zoomed.viewport.width).toBeCloseTo(baselineViewport.width / 2, 0);
    expect(zoomed.labelHeight).toBe(22);
    await expect(indicator(page)).toHaveText("Data Unreachable");
    await expect(indicator(page)).toHaveCSS("font-size", "16px");
    await expect(indicator(page).locator(".connection-ball")).toHaveCSS("width", "20px");
    await swipe(page, session, "horizontal");
    await expect.poll(async () => (await geometry(page)).tableX).toBeGreaterThan(zoomed.tableX + 30);
    await expectNaturalHeader(page, baselineScale);
    const beforeVertical = await geometry(page);
    await swipe(page, session, "vertical");
    await expect.poll(async () => (await geometry(page)).viewport.pageTop).toBeGreaterThan(beforeVertical.viewport.pageTop + 30);
    await expectNaturalHeader(page, baselineScale);
    expect((await geometry(page)).viewport.scale).toBeCloseTo(baselineScale * 2, 2);
    await page.screenshot({ path: info.outputPath("mobile-red-zoomed.png") });
    reachable = true;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(indicator(page)).toHaveText("Connected");
    await expectNaturalHeader(page, baselineScale);
    const greenZoomed = await geometry(page);
    await swipe(page, session, "vertical", true);
    await expect.poll(async () => (await geometry(page)).viewport.pageTop).toBeLessThan(greenZoomed.viewport.pageTop - 30);
    await expectNaturalHeader(page, baselineScale);
    await page.screenshot({ path: info.outputPath("mobile-green-header-zoomed.png") });
    await setBrowserPinchScale(page, session, baselineScale);
    await expectAnchored(page);

    await expectFleetDocumentFlow(page);
    expect(dataReads, "Synthetic viewport tests must not dispatch provider reads").toEqual([]);
    expect(external).toEqual([]);
    expect(errors).toEqual([]);
  });
}
