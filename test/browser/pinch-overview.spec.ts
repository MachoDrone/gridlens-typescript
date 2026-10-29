import { expect, test } from "@playwright/test";
import type { CDPSession, Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { expectFleetDocumentFlow } from "./helpers.ts";
import { setBrowserPinchScale } from "./viewport-input.ts";

// Use Chromium's native mobile pinch handling, with physical finger positions
// converted to visual CSS pixels after each compositor update. Desktop scale
// emulation alone cannot prove that a phone can expose the complete table.
test.use({ isMobile: true, hasTouch: true, deviceScaleFactor: 2, trace: "off" });

async function settledViewport(page: Page) {
  return page.evaluate(async () => {
    const v = visualViewport!;
    let previous = v.scale, quiet = 0;
    for (let frame = 0; frame < 16 && quiet < 2; frame++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      quiet = Math.abs(v.scale - previous) < .000001 ? quiet + 1 : 0;
      previous = v.scale;
    }
    if (quiet < 2) throw new Error("Native pinch viewport did not settle");
    const tableScroll = document.querySelector<HTMLElement>(".fleet-table-wrap")?.scrollLeft ?? 0;
    return { scale: v.scale, width: v.width, height: v.height,
      left: v.offsetLeft, top: v.offsetTop, pageLeft: v.pageLeft, pageTop: v.pageTop,
      tableScroll, column: v.pageLeft + tableScroll };
  });
}

async function nativePinch(page: Page, session: CDPSession, direction: "out" | "in", targetScale?: number) {
  const before = await settledViewport(page);
  const size = page.viewportSize()!;
  const center = { x: size.width * .64, y: size.height * .54 };
  const start = direction === "out" ? Math.min(160, size.height * .3) : 12;
  const finish = direction === "out" ? 10 : Math.min(165, size.height * .32);
  const points = (spread: number, scale: number) => [
    { id: 0, x: center.x / scale, y: (center.y - spread) / scale },
    { id: 1, x: center.x / scale, y: (center.y + spread) / scale },
  ];
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(start, before.scale) });
  let current = await settledViewport(page);
  for (let step = 1; step <= 24; step++) {
    await session.send("Input.dispatchTouchEvent", { type: "touchMove",
      touchPoints: points(start + (finish - start) * step / 24, current.scale) });
    current = await settledViewport(page);
    if (targetScale !== undefined && (direction === "in" ? current.scale >= targetScale : current.scale <= targetScale)) break;
  }
  const beforeRelease = current;
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  return { before, beforeRelease, after: await settledViewport(page) };
}

async function nativeDrag(page: Page, session: CDPSession, axis: "x" | "y", reverse = false) {
  const v = await settledViewport(page), size = page.viewportSize()!;
  const sign = reverse ? -1 : 1;
  const center = { x: size.width * .72, y: size.height * .58 };
  const distance = axis === "x" ? size.width * .36 : size.height * .48;
  const from = { x: center.x + (axis === "x" ? sign * distance / 2 : 0),
    y: center.y + (axis === "y" ? sign * distance / 2 : 0) };
  const to = { x: center.x - (axis === "x" ? sign * distance / 2 : 0),
    y: center.y - (axis === "y" ? sign * distance / 2 : 0) };
  const point = (fraction: number) => ({ x: (from.x + (to.x - from.x) * fraction) / v.scale,
    y: (from.y + (to.y - from.y) * fraction) / v.scale });
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(0)] });
  for (let step = 1; step <= 10; step++) {
    await page.waitForTimeout(25);
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(step / 10)] });
  }
  await page.waitForTimeout(100);
  await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(1)] });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await settledViewport(page);
}

async function overviewGeometry(page: Page) {
  return page.evaluate(() => {
    const v = visualViewport!, table = document.querySelector<HTMLTableElement>(".fleet-table")!;
    const wrap = document.querySelector<HTMLElement>(".fleet-table-wrap")!;
    const sidebar = document.querySelector<HTMLElement>("#sidebar")!.getBoundingClientRect();
    const header = document.querySelector<HTMLElement>(".fleet-title-row")!.getBoundingClientRect();
    const box = table.getBoundingClientRect(), wrapper = wrap.getBoundingClientRect();
    const headers = [...table.querySelectorAll<HTMLElement>("thead th[data-col]")].filter(e => e.checkVisibility());
    const cells = [...table.querySelectorAll<HTMLElement>("tbody tr:first-child > td[data-col]")].filter(e => e.checkVisibility());
    const issues: string[] = [];
    for (const element of [...headers, ...cells]) {
      const r = element.getBoundingClientRect(), name = `${element.tagName}:${element.dataset.col}`;
      if (r.left < v.offsetLeft - 1 || r.right > v.offsetLeft + v.width + 1) issues.push(`${name} outside visible width`);
      if (r.top < v.offsetTop - 1 || r.bottom > v.offsetTop + v.height + 1) issues.push(`${name} outside visible height`);
      // Root overflow is propagated to the browser viewport; its clientWidth
      // keeps the unzoomed CSS width and is not the visible clipping boundary.
      for (let parent = element.parentElement; parent !== null && parent !== document.documentElement; parent = parent.parentElement) {
        const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
        if (/auto|scroll|hidden|clip/.test(style.overflowX) &&
            (r.left < bounds.left + parent.clientLeft - 1 || r.right > bounds.left + parent.clientLeft + parent.clientWidth + 1)) {
          issues.push(`${name} clipped by ${parent.className || parent.tagName}`);
        }
      }
      if (r.left < sidebar.right - 1 || r.top < header.bottom - 1) issues.push(`${name} overlaps navigation`);
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (hit === null || !element.contains(hit)) issues.push(`${name} is not painted at its visible center`);
    }
    return { issues, columns: headers.map(e => e.dataset.col), cells: cells.length, scale: v.scale,
      tableWidth: box.width, canvasWidth: box.width + sidebar.width, wrapperWidth: wrapper.width, pageWidth: document.documentElement.scrollWidth,
      visibleWidth: v.width, tableScroll: wrap.scrollLeft, pageLeft: v.pageLeft, pageTop: v.pageTop,
      first: headers[0]?.dataset.col, last: headers.at(-1)?.dataset.col };
  });
}

async function showEveryColumn(page: Page, session: CDPSession, combined: boolean) {
  const before = await settledViewport(page);
  for (let gesture = 0; gesture < 4; gesture++) {
    await nativePinch(page, session, "out");
    if ((await overviewGeometry(page)).issues.length === 0) break;
  }
  const evidence = test.info().outputPath("overview-geometry.json");
  await writeFile(evidence, JSON.stringify(await overviewGeometry(page), null, 2));
  await test.info().attach("overview-at-pinch-release", { contentType: "application/json", path: evidence });
  await expect.poll(async () => (await overviewGeometry(page)).issues,
    { message: "A native pinch must show every header and first-row cell at once, with no clipped table window" }).toEqual([]);
  const geometry = await overviewGeometry(page);
  expect(geometry.scale, "The browser must actually zoom out").toBeLessThan(before.scale * .8);
  expect(geometry.columns).toHaveLength(combined ? 27 : 28);
  expect(geometry.cells).toBe(combined ? 27 : 28);
  expect(geometry.first).toBe("stakedNos");
  expect(geometry.last).toBe("country");
  expect(geometry.wrapperWidth + 1).toBeGreaterThanOrEqual(geometry.tableWidth);
  expect(geometry.pageWidth - geometry.visibleWidth, "The final overview must not strand columns beyond blank canvas").toBeLessThan(2);
  return geometry;
}

async function prepare(page: Page, options: { expandedMenu: boolean; combined: boolean; expandedFields: boolean; scale?: boolean }) {
  await page.addInitScript(({ expandedMenu, combined, expandedFields }) => {
    localStorage.setItem("gridlens.preview.sidebar.v1", expandedMenu ? "expanded" : "collapsed");
    localStorage.setItem("gridlens.preview.queued-duration-layout.v1", combined ? "combined" : "separate");
    localStorage.setItem("gridlens.preview.host-address-mode.v1", expandedFields ? "full" : "compact");
    localStorage.setItem("gridlens.preview.market-mode.v1", expandedFields ? "full" : "compact");
    localStorage.setItem("gridlens.preview.ip-mode.v1", expandedFields ? "full" : "dot");
    localStorage.setItem("gridlens.preview.staking-mode.v1", expandedFields ? "amounts" : "symbols");
    localStorage.setItem("gridlens.preview.duration-mode.v1", expandedFields ? "text" : "bar");
    localStorage.setItem("gridlens.preview.country-mode.v1", expandedFields ? "full" : "compact");
    for (const field of ["nvidia", "cpu", "system"]) {
      localStorage.setItem(`gridlens.preview.${field}-mode.v1`, expandedFields ? "expanded" : "compact");
    }
  }, options);
  await page.goto(`/?scenario=${options.scale ? "scale" : "mixed"}`);
  await expect(page.locator("#host-count")).toHaveText(options.scale ? "200 hosts" : "6 hosts");
  await expect(page.locator("#sidebar-toggle")).toHaveAttribute("aria-expanded", String(options.expandedMenu));
  await expect(page.locator("#queued-duration-layout-toggle")).toHaveAttribute("aria-pressed", String(options.combined));
  await expectFleetDocumentFlow(page);
  await page.waitForTimeout(350); // Finish baseline browser restoration before trusted pinch input.
}

async function expectNormalShell(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const v = visualViewport!, sidebar = document.querySelector("#sidebar")!.getBoundingClientRect();
    const header = document.querySelector(".fleet-title-row")!.getBoundingClientRect();
    const wrapper = document.querySelector(".fleet-table-wrap")!.getBoundingClientRect();
    return Math.max(Math.abs(sidebar.left - v.offsetLeft), Math.abs(sidebar.top - v.offsetTop),
      Math.abs(sidebar.height - v.height), Math.abs(header.left - sidebar.right),
      Math.abs(header.top - v.offsetTop), Math.abs(header.right - v.offsetLeft - v.width),
      Math.max(0, wrapper.right - v.offsetLeft - v.width));
  }), { message: "Normal-scale navigation and table viewport must return to the phone screen" }).toBeLessThan(1.1);
  await expectFleetDocumentFlow(page);
}

async function zoomOutShellGeometry(page: Page) {
  return page.evaluate(() => {
    const v = visualViewport!;
    const sidebar = document.querySelector<HTMLElement>("#sidebar")!.getBoundingClientRect();
    const header = document.querySelector<HTMLElement>(".fleet-title-row")!.getBoundingClientRect();
    const table = document.querySelector<HTMLTableElement>(".fleet-table")!;
    const heading = table.tHead!.getBoundingClientRect(), tableBox = table.getBoundingClientRect();
    const cells = [...table.querySelectorAll<HTMLElement>("tbody tr:first-child > td[data-col]")];
    const alignment = [...table.querySelectorAll<HTMLElement>("thead th[data-col]")]
      .filter(element => element.checkVisibility()).map(element => {
        const body = cells.find(cell => cell.dataset.col === element.dataset.col)!.getBoundingClientRect();
        const label = element.getBoundingClientRect();
        return { column: element.dataset.col, difference: Math.max(Math.abs(label.left - body.left), Math.abs(label.right - body.right)) };
      });
    const visibleHeadings = [...table.querySelectorAll<HTMLElement>("thead th[data-col]")].filter(element => {
      const r = element.getBoundingClientRect();
      return element.checkVisibility() && r.left >= sidebar.right && r.right <= v.offsetLeft + v.width &&
        r.top >= header.bottom - 1 && r.bottom <= v.offsetTop + v.height;
    });
    const paintedHeadings = visibleHeadings.every(element => {
      const r = element.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit !== null && element.contains(hit);
    });
    const bounds = (r: DOMRect) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height });
    return { scale: v.scale, pageTop: v.pageTop, pageLeft: v.pageLeft,
      viewport: { left: v.offsetLeft, top: v.offsetTop, right: v.offsetLeft + v.width, bottom: v.offsetTop + v.height },
      sidebar: bounds(sidebar), header: bounds(header), heading: bounds(heading), table: bounds(tableBox), alignment,
      visibleHeadings: visibleHeadings.length, paintedHeadings };
  });
}

async function expectZoomOutShell(page: Page) {
  await expect.poll(async () => {
    const g = await zoomOutShellGeometry(page);
    return Math.max(Math.abs(g.sidebar.left - g.viewport.left), Math.abs(g.sidebar.top - g.viewport.top),
      Math.abs(g.sidebar.bottom - g.viewport.bottom), Math.abs(g.header.left - g.sidebar.right),
      Math.abs(g.header.top - g.viewport.top), Math.abs(g.header.right - g.viewport.right),
      Math.abs(g.heading.top - Math.max(g.table.top, g.header.bottom)),
      ...g.alignment.map(column => column.difference));
  }, { message: "Zoomed-out navigation must fill the visible phone and keep aligned column headings below the Fleet header" }).toBeLessThan(1.1);
  const g = await zoomOutShellGeometry(page);
  expect(g.visibleHeadings, "A zoomed-out scrolled Fleet must retain visible column headings").toBeGreaterThan(0);
  expect(g.paintedHeadings, "Visible column headings must paint above their body rows and remain touch targets").toBe(true);
}

async function tapVisible(page: Page, selector: string) {
  const point = await page.locator(selector).evaluate(element => {
    const r = element.getBoundingClientRect(), v = visualViewport!;
    if (r.left < v.offsetLeft || r.right > v.offsetLeft + v.width ||
        r.top < v.offsetTop || r.bottom > v.offsetTop + v.height) throw new Error("Tap target is outside the visible overview");
    return { x: r.left + r.width / 2 - v.offsetLeft, y: r.top + r.height / 2 - v.offsetTop };
  });
  await page.touchscreen.tap(point.x, point.y);
  await settledViewport(page);
}

for (const width of [320, 390]) test.describe(`phone overview ${width}px`, () => {
  test.use({ viewport: { width, height: 844 } });
  let errors: string[], unexpected: string[], providerReads: string[];
  test.beforeEach(async ({ context, page }) => {
    errors = []; unexpected = []; providerReads = [];
    page.on("pageerror", error => errors.push(error.message));
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin !== "http://127.0.0.1:4174") { unexpected.push(url.href); return route.abort(); }
      if (url.pathname.endsWith(".json") && !["/preview/hosts.json", "/preview/connection.json"].includes(url.pathname)) providerReads.push(url.pathname);
      return route.continue();
    });
  });
  test.afterEach(() => {
    expect(errors).toEqual([]);
    expect(unexpected).toEqual([]);
    expect(providerReads, "Synthetic pinch gestures must not start provider reads").toEqual([]);
  });

  for (const expandedMenu of [false, true]) for (const combined of [false, true]) for (const expandedFields of [false, true]) {
    test(`${expandedMenu ? "expanded" : "collapsed"} menu, ${combined ? "combined" : "separate"} Q/D, ${expandedFields ? "expanded" : "compact"} fields`, async ({ page, context }, info) => {
      test.setTimeout(60_000);
      await prepare(page, { expandedMenu, combined, expandedFields });
      const original = await page.evaluate(() => ({ ...localStorage }));
      const session = await context.newCDPSession(page);
      const geometry = await showEveryColumn(page, session, combined);
      await info.attach("native-overview-geometry", { contentType: "application/json", body: JSON.stringify(geometry, null, 2) });
      await page.screenshot({ path: info.outputPath("all-columns.png") });
      expect(await page.evaluate(() => ({ ...localStorage })), "Native overview must not save a zoom preference").toEqual(original);
    });
  }

  for (const expandedMenu of [false, true]) {
    test(`${expandedMenu ? "expanded" : "collapsed"} zoomed-out navigation and column headings stay visible through 200-row touch scrolling`, async ({ page, context }, info) => {
      test.setTimeout(90_000);
      await prepare(page, { expandedMenu, combined: !expandedMenu, expandedFields: false, scale: true });
      const session = await context.newCDPSession(page), baseline = await settledViewport(page);
      await expectNormalShell(page);
      await nativePinch(page, session, "out", baseline.scale * .65);
      const partial = await settledViewport(page);
      expect(partial.scale).toBeLessThan(baseline.scale * .8);
      await expectZoomOutShell(page);
      await nativeDrag(page, session, "y");
      expect((await settledViewport(page)).pageTop).toBeGreaterThan(100);
      const evidence = info.outputPath("zoomed-out-scrolled-shell.json");
      await writeFile(evidence, JSON.stringify(await zoomOutShellGeometry(page), null, 2));
      await info.attach("zoomed-out-scrolled-shell", { contentType: "application/json", path: evidence });
      await page.screenshot({ path: info.outputPath("zoomed-out-scrolled-shell.png") });
      await expectZoomOutShell(page);
      const horizontal = (await settledViewport(page)).column;
      await nativeDrag(page, session, "x");
      expect((await settledViewport(page)).column, "Touch movement must actually scroll across the zoomed-out table").toBeGreaterThan(horizontal + 30);
      await expectZoomOutShell(page);
      await page.evaluate(() => scrollTo(0, 0));
      await showEveryColumn(page, session, !expandedMenu);
      await expectZoomOutShell(page);
      await nativeDrag(page, session, "y");
      await expectZoomOutShell(page);
      await nativeDrag(page, session, "y", true);
      await expectZoomOutShell(page);
      await setBrowserPinchScale(page, session, baseline.scale);
      await expectNormalShell(page);
    });
  }

  test("ordinary two-finger movement and dialogs keep their layout, while overview follows display changes", async ({ page, context }) => {
    test.setTimeout(90_000);
    await prepare(page, { expandedMenu: false, combined: true, expandedFields: false });
    const session = await context.newCDPSession(page), baseline = await settledViewport(page);
    const point = (y: number, id: number) => ({ id, x: width * .66 / baseline.scale, y: y / baseline.scale });
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(340, 0), point(460, 1)] });
    for (let step = 1; step <= 8; step++) {
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(340 - step * 5, 0), point(460 - step * 5, 1)] });
      await settledViewport(page);
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(page.locator("html")).not.toHaveAttribute("data-fleet-overview", "true");
    await nativePinch(page, session, "in", baseline.scale * 1.6);
    await expect(page.locator("html")).not.toHaveAttribute("data-fleet-overview", "true");
    await setBrowserPinchScale(page, session, baseline.scale);
    await expectNormalShell(page);
    await page.evaluate(() => scrollTo(0, 0));
    await page.locator('#fleet-rows tr:first-child td[data-col="stakedNos"] button').tap();
    await expect(page.locator("dialog[open]")).toBeVisible();
    await nativePinch(page, session, "out");
    await expect(page.locator("html")).not.toHaveAttribute("data-fleet-overview", "true");
    await page.getByRole("button", { name: "Close", exact: true }).tap();
    await setBrowserPinchScale(page, session, baseline.scale);
    await page.evaluate(() => scrollTo(0, 0));
    await showEveryColumn(page, session, true);
    for (const selector of ["#cpu-display-toggle", "#sidebar-toggle", "#queued-duration-layout-toggle"]) {
      const before = await overviewGeometry(page);
      await tapVisible(page, selector);
      await expect.poll(async () => (await overviewGeometry(page)).canvasWidth).toBeGreaterThan(before.canvasWidth);
      await expect.poll(async () => {
        const after = await overviewGeometry(page);
        return Math.abs(after.pageWidth - after.visibleWidth);
      }, { message: "Display changes must settle into a canvas matching the visible width" }).toBeLessThan(2);
      expect((await overviewGeometry(page)).scale, "Growing fields may retain native minimum fit, without zooming in or resetting the chosen overview").toBeLessThanOrEqual(before.scale + .001);
      await nativePinch(page, session, "out");
      await expect.poll(async () => (await overviewGeometry(page)).issues).toEqual([]);
    }
    expect((await overviewGeometry(page)).columns).toHaveLength(28);
  });

  test("a second native contraction preserves the scrolled column and row when reopening the overview", async ({ page, context }) => {
    test.setTimeout(60_000);
    await prepare(page, { expandedMenu: true, combined: false, expandedFields: false, scale: true });
    const session = await context.newCDPSession(page), baseline = await settledViewport(page);
    await nativePinch(page, session, "out", baseline.scale * .75);
    await nativeDrag(page, session, "x");
    await nativeDrag(page, session, "y");
    const before = await settledViewport(page);
    expect(before.column).toBeGreaterThan(30);
    expect(before.pageTop).toBeGreaterThan(30);
    await expectZoomOutShell(page);
    await expectFleetDocumentFlow(page);
    await page.evaluate(() => {
      const root = document.documentElement;
      const reopened = (): void => {
        if (root.dataset.fleetOverviewExposed !== "true") return;
        root.dataset.testReopenedLeft = String(visualViewport!.pageLeft);
        root.dataset.testReopenedTop = String(visualViewport!.pageTop);
        document.removeEventListener("touchmove", reopened);
      };
      // Registered after the application listener: this records the actual
      // viewport transfer in the opening touch event, before more pinch steps.
      document.addEventListener("touchmove", reopened, { passive: true });
    });
    const repeated = await nativePinch(page, session, "out", before.scale * .8);
    const reopened = await page.locator("html").evaluate(root => ({
      left: Number(root.dataset.testReopenedLeft), top: Number(root.dataset.testReopenedTop),
    }));
    expect(Math.abs(reopened.left - before.column), "Reopening must carry the scrolled table column into the native viewport").toBeLessThan(1.1);
    expect(Math.abs(reopened.top - before.pageTop), "Reopening must preserve the viewed row").toBeLessThan(1.1);
    expect(repeated.after.scale).toBeLessThan(before.scale * .85);
    expect(Math.abs(repeated.after.scale / repeated.beforeRelease.scale - 1), "Releasing the gesture allows only subpixel canvas rounding").toBeLessThan(.005);
    expect(Math.max(Math.abs(repeated.after.left), Math.abs(repeated.after.top))).toBeLessThan(1.1);
    await expectFleetDocumentFlow(page);
    await expectZoomOutShell(page);
    const column = (await settledViewport(page)).column;
    await nativeDrag(page, session, "x");
    expect((await settledViewport(page)).column).toBeGreaterThan(column + 30);
    await expectZoomOutShell(page);
  });

  test("zoom endpoints just below and above normal size retain their native navigation behavior", async ({ page, context }) => {
    test.setTimeout(60_000);
    await prepare(page, { expandedMenu: true, combined: false, expandedFields: false, scale: true });
    const session = await context.newCDPSession(page), baseline = await settledViewport(page);
    await nativePinch(page, session, "out", baseline.scale * .75);
    // Select exact boundary endpoints after actual native overview entry. The
    // moving gestures elsewhere continue to cover native scale and focal point.
    await setBrowserPinchScale(page, session, baseline.scale * .995);
    const below = await settledViewport(page);
    expect(below.scale).toBeGreaterThanOrEqual(baseline.scale * .9949);
    expect(below.scale, "A small zoom-out must keep its chosen canvas until native pixel rounding actually reaches normal size").toBeLessThan(baseline.scale * .9999);
    await expectFleetDocumentFlow(page);
    await nativeDrag(page, session, "y");
    await expectZoomOutShell(page);
    const nearNormal = await settledViewport(page);
    expect(Math.max(Math.abs(nearNormal.left), Math.abs(nearNormal.top)), "The contained endpoint below normal must scroll without visual viewport panning").toBeLessThan(.1);

    for (const ratio of [1.003, 1.009]) {
      await page.evaluate(() => scrollTo(0, 0));
      await setBrowserPinchScale(page, session, baseline.scale * ratio);
      await settledViewport(page);
      await expect(page.locator("#sidebar")).toHaveCSS("position", "absolute");
      await expect(page.locator(".fleet-title-row")).toHaveCSS("position", "absolute");
      await nativeDrag(page, session, "y");
      const magnified = await page.evaluate(() => {
        const sidebar = document.querySelector("#sidebar")!.getBoundingClientRect();
        const header = document.querySelector(".fleet-title-row")!.getBoundingClientRect();
        const table = document.querySelector<HTMLTableElement>(".fleet-table")!;
        return { pageTop: visualViewport!.pageTop, sidebarTop: sidebar.top, headerTop: header.top,
          documentOriginError: Math.max(Math.abs(sidebar.top + scrollY), Math.abs(sidebar.left + scrollX),
            Math.abs(header.top + scrollY), Math.abs(header.left + scrollX - sidebar.width)),
          columnFlowError: Math.abs(table.tHead!.getBoundingClientRect().top - table.getBoundingClientRect().top) };
      });
      expect(magnified.pageTop).toBeGreaterThan(100);
      expect(magnified.sidebarTop).toBeLessThan(-100);
      expect(magnified.headerTop).toBeLessThan(-100);
      expect(magnified.documentOriginError, "Above normal size navigation must pan from its original document position, including close zoom endpoints").toBeLessThan(1.1);
      expect(magnified.columnFlowError, "Magnified column headings retain their natural table position").toBeLessThan(1.1);
    }

    await setBrowserPinchScale(page, session, baseline.scale);
    await expectNormalShell(page);
    expect((await settledViewport(page)).pageTop, "Returning to normal must preserve the viewed rows").toBeGreaterThan(100);
  });

  test("sideways scrolling, zoom return, rotation, reload and page resume preserve usable table navigation", async ({ page, context }, info) => {
    test.setTimeout(120_000);
    await prepare(page, { expandedMenu: true, combined: false, expandedFields: true, scale: true });
    const session = await context.newCDPSession(page), baseline = await settledViewport(page);
    const wrapper = page.locator(".fleet-table-wrap");
    await nativeDrag(page, session, "x");
    await expect.poll(() => wrapper.evaluate(element => element.scrollLeft)).toBeGreaterThan(30);
    await showEveryColumn(page, session, false);
    const fullWidth = (await overviewGeometry(page)).wrapperWidth;

    await nativePinch(page, session, "in", baseline.scale * .55);
    await nativeDrag(page, session, "x");
    await nativeDrag(page, session, "y");
    const panned = await settledViewport(page);
    expect(panned.column).toBeGreaterThan(30);
    expect(panned.pageTop).toBeGreaterThan(30);
    expect((await overviewGeometry(page)).wrapperWidth).toBeLessThan(fullWidth);
    await expectFleetDocumentFlow(page);
    expect(Math.max(Math.abs(panned.left), Math.abs(panned.top)), "Native intermediate scrolling must not leave a visual viewport pan").toBeLessThan(1.1);
    await page.screenshot({ path: info.outputPath("overview-panned.png") });

    const returned = await nativePinch(page, session, "in", baseline.scale * 1.04);
    await expect.poll(() => wrapper.evaluate(element => element.clientWidth)).toBeLessThan(width);
    const restored = await wrapper.evaluate(element => ({ scroll: element.scrollLeft,
      maxScroll: element.scrollWidth - element.clientWidth }));
    expect(Math.abs(restored.scroll + returned.after.pageLeft - Math.min(returned.beforeRelease.column, restored.maxScroll)),
      "The released pinch must preserve the viewed table position while transferring document pan to its scroller").toBeLessThan(2);
    expect(Math.abs(returned.after.pageTop - returned.beforeRelease.pageTop),
      "Returning to the table scroller must preserve vertical position at release").toBeLessThan(2);
    // The real expanding gesture crosses the transition. Use the shared trusted
    // input helper only to select an exact normal-scale endpoint for fixed-bar
    // assertions; Chromium's finite touch samples normally overshoot it.
    await setBrowserPinchScale(page, session, baseline.scale);
    await expectNormalShell(page);
    expect(await wrapper.evaluate(element => element.scrollLeft), "Returning to normal preserves the viewed columns").toBeGreaterThan(30);
    expect((await settledViewport(page)).pageTop, "Returning to normal does not reset the viewed rows").toBeGreaterThan(30);
    const scroll = await wrapper.evaluate(element => element.scrollLeft);
    await nativeDrag(page, session, "x", true);
    await expect.poll(() => wrapper.evaluate(element => element.scrollLeft)).toBeLessThan(scroll - 20);

    await page.reload();
    await page.waitForTimeout(350);
    await expectNormalShell(page);
    await page.evaluate(() => scrollTo(0, 0));
    await showEveryColumn(page, session, false);
    await page.evaluate(() => {
      dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await expect.poll(async () => (await overviewGeometry(page)).issues).toEqual([]);
    await page.setViewportSize({ width: 844, height: width });
    await page.waitForTimeout(350);
    await expect.poll(async () => (await overviewGeometry(page)).issues).toEqual([]);
    const rotated = await overviewGeometry(page);
    expect(rotated.pageWidth - rotated.visibleWidth, "A fitting rotated table must not leave blank horizontal canvas").toBeLessThan(2);
    expect(Math.max(Math.abs(rotated.pageLeft), Math.abs(rotated.tableScroll)), "A fitting rotated table retains its horizontal origin").toBeLessThan(1.1);
    // The table can fit while a deliberate near-minimum endpoint still leaves
    // part of its unused gutter outside the viewport. Keep that endpoint in the
    // normal contained scroller instead of retaining blank document panning.
    const nearMinimumWidth = Math.floor(rotated.visibleWidth) - 10;
    await setBrowserPinchScale(page, session, page.viewportSize()!.width / nearMinimumWidth);
    await settledViewport(page);
    await expect(page.locator("html")).not.toHaveAttribute("data-fleet-overview-exposed", "true");
    const nearMinimum = await overviewGeometry(page);
    expect(nearMinimum.pageWidth - nearMinimum.visibleWidth, "A deliberate near-minimum zoom must not retain blank document pan").toBeLessThan(2);
    expect(Math.abs(nearMinimum.pageLeft)).toBeLessThan(1.1);
    expect(nearMinimum.wrapperWidth).toBeLessThan(nearMinimum.tableWidth);
    await nativePinch(page, session, "out");
    await expect.poll(async () => (await overviewGeometry(page)).issues).toEqual([]);
    await page.setViewportSize({ width, height: 844 });
    await page.waitForTimeout(350);
    await expect.poll(async () => (await overviewGeometry(page)).issues).toEqual([]);
    const portrait = await overviewGeometry(page);
    expect(portrait.pageWidth - portrait.visibleWidth, "Returning to portrait keeps the natural full-table fit").toBeLessThan(2);
    await page.reload();
    await page.waitForTimeout(350);
    await expectNormalShell(page);
    await page.screenshot({ path: info.outputPath("normal-after-overview-reload.png") });
  });
});
