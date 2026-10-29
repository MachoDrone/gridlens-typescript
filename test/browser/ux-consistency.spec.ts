import { expect, test } from "@playwright/test";
import type { CDPSession, Locator, Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPreviewServer } from "../../scripts/preview-server.ts";
import { SYNTHETIC_HOST_ADDRESSES as addresses } from "../fixtures/host-addresses.ts";
import { emptyQueue } from "../fixtures/queue.ts";
import { emptyJobs } from "../fixtures/jobs.ts";
import { expectFleetDocumentFlow } from "./helpers.ts";
import { setBrowserPinchScale } from "./viewport-input.ts";
import { emptySol } from "../fixtures/sol.ts";
import { emptyNos } from "../fixtures/nos.ts";
import { emptyStaking } from "../fixtures/staking.ts";

// Explicit geometry assertions and boundary screenshots are the evidence here;
// repeated whole-DOM traces of 200 rows make touch/zoom checks needlessly slow.
test.use({ trace: "off" });

// These tests use Chromium's native mobile viewport/touch implementation. Browser
// chrome (address bar) movement and physical safe areas still need a real phone.
const cases = [
  { name: "desktop", width: 1440, height: 900, mobile: false },
  { name: "small portrait", width: 320, height: 844, mobile: true },
  { name: "portrait", width: 390, height: 844, mobile: true },
  { name: "landscape", width: 844, height: 390, mobile: true },
  { name: "short landscape", width: 667, height: 240, mobile: true },
] as const;

// Test expectations follow deliberate gestures/navigation, not the app's mode flag.
const zoomExpectations = new WeakMap<Page, { baselineScale: number; natural: boolean }>();
async function fixedBaseline(page: Page): Promise<void> {
  zoomExpectations.set(page, { baselineScale: (await viewport(page)).scale, natural: false });
}

async function viewport(page: Page) {
  return page.evaluate(() => {
    const v = visualViewport!;
    return { left: v.offsetLeft, top: v.offsetTop, width: v.width, height: v.height,
      pageLeft: v.pageLeft, pageTop: v.pageTop, scale: v.scale };
  });
}

/** No actionability helper here: locator actions can silently scroll away defects. */
async function screenBox(locator: Locator) {
  return locator.evaluate(element => {
    const v = visualViewport!;
    const r = element.getBoundingClientRect();
    const visible = element.checkVisibility({ visibilityProperty: true }) && r.width > 0 && r.height > 0;
    let inside = visible && r.left >= v.offsetLeft - 1 && r.right <= v.offsetLeft + v.width + 1 &&
      r.top >= v.offsetTop - 1 && r.bottom <= v.offsetTop + v.height + 1;
    // A target can fit the screen yet be clipped by its menu/dialog scroll area.
    for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
      const style = getComputedStyle(parent), box = parent.getBoundingClientRect();
      if (/auto|scroll|hidden|clip/.test(style.overflowX)) inside &&=
        r.left >= box.left + parent.clientLeft - 1 && r.right <= box.left + parent.clientLeft + parent.clientWidth + 1;
      if (/auto|scroll|hidden|clip/.test(style.overflowY)) inside &&=
        r.top >= box.top + parent.clientTop - 1 && r.bottom <= box.top + parent.clientTop + parent.clientHeight + 1;
    }
    if (element.closest("main") && !element.closest(".fleet-title-row")) {
      const sidebar = document.querySelector("#sidebar")!.getBoundingClientRect();
      const header = document.querySelector(".fleet-title-row")!.getBoundingClientRect();
      let top = header.bottom;
      if (element.closest("#fleet-rows")) {
        const th = document.querySelector(".fleet-table th")!;
        const heading = th.getBoundingClientRect();
        // Native CSS timeline pinning keeps the original thead connected but
        // its th is position:relative, so inspect the actual painted header band.
        if (heading.bottom > header.bottom && heading.top >= header.bottom - 1) top = Math.max(top, heading.bottom);
      }
      inside &&= r.left >= sidebar.right - 1 && r.top >= top - 1;
    }
    const hit = inside ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
    return { inside, painted: hit !== null && element.contains(hit), x: r.left + r.width / 2,
      y: r.top + r.height / 2, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  });
}

async function expectReachable(locator: Locator): Promise<void> {
  await expect.poll(async () => {
    const r = await screenBox(locator);
    return r.inside && r.painted ? [] : [r];
  }, { message: `${locator} must fit the visible screen before hit testing or automatic scrolling` }).toEqual([]);
}

async function activate(page: Page, locator: Locator, mobile: boolean): Promise<void> {
  await expectReachable(locator);
  // Use the actual visible-screen point. Locator.tap() can change native mobile
  // pan offsets through scrollIntoView even after an element was already visible.
  const box = await screenBox(locator), v = await viewport(page);
  if (mobile) await page.touchscreen.tap(box.x - v.left, box.y - v.top);
  else await page.mouse.click(box.x - v.left, box.y - v.top);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
}

async function drag(session: CDPSession, from: { x: number; y: number }, to: { x: number; y: number }, stop = false): Promise<void> {
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
  for (let step = 1; step <= 8; step++) {
    await new Promise(resolve => setTimeout(resolve, 25));
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{
      x: from.x + (to.x - from.x) * step / 8, y: from.y + (to.y - from.y) * step / 8,
    }] });
  }
  if (stop) {
    await new Promise(resolve => setTimeout(resolve, 100));
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [to] });
  }
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function pan(page: Page, session: CDPSession, axis: "x" | "y", reverse = false, region: "page" | "menu" | "dialog" = "page", distance?: number): Promise<void> {
  const v = await viewport(page);
  const sidebar = await page.locator("#sidebar").boundingBox();
  const zoomed = zoomExpectations.get(page)?.natural ?? false;
  let left = zoomed ? 2 : Math.max(12, (sidebar?.width ?? 56) + 12), right = v.width - (zoomed ? 2 : 14);
  let top = zoomed ? 2 : Math.min(125, v.height * .45), bottom = v.height - (zoomed ? 2 : 20);
  if (region === "page" && !zoomed && v.height < 200) {
    top = (await screenBox(page.locator(".fleet-title-row"))).bottom - v.top + 1;
    bottom = v.height - 1;
  }
  if (region !== "page") {
    const r = await screenBox(page.locator(region === "menu" ? "#sidebar-content" : "#info-body"));
    left = Math.max(r.left - v.left + 8, 8); right = Math.min(r.right - v.left - 8, v.width - 8);
    const inset = region === "menu" ? 1 : 8;
    top = Math.max(r.top - v.top + inset, inset); bottom = Math.min(r.bottom - v.top - inset, v.height - inset);
  }
  const from = axis === "x" ? { x: right, y: (top + bottom) / 2 } : { x: (left + right) / 2, y: bottom };
  const extent = Math.min(distance ?? bottom - top, bottom - top);
  const to = axis === "x" ? { x: right - Math.min(distance ?? right - left, right - left), y: from.y } : { x: from.x, y: bottom - extent };
  await drag(session, reverse ? to : from, reverse ? from : to, region === "menu" || distance !== undefined);
  // A short menu uses native scroll snapping; let its fling settle before the
  // next full-target bound measurement, without changing any application clock.
  if (region === "menu") await new Promise(resolve => setTimeout(resolve, 650));
}

async function expectSettledColumnHeading(page: Page): Promise<void> {
  await expect.poll(async () => page.evaluate(() => {
    const v = visualViewport!, header = document.querySelector(".fleet-title-row")!.getBoundingClientRect();
    const wrapper = document.querySelector(".fleet-table-wrap")!.getBoundingClientRect();
    const heading = document.querySelector(".fleet-table thead")!.getBoundingClientRect();
    const issues: string[] = [];
    if (wrapper.top >= header.bottom || wrapper.bottom <= v.offsetTop + v.height) issues.push("The fixture must span the visible viewport for pinned-header coverage");
    if (Math.abs(heading.top - header.bottom) > 1.1) issues.push(`Column header top ${heading.top} differs from Fleet header bottom ${header.bottom}`);
    return issues;
  }), { message: "The existing column heading must settle directly below Fleet while the full-height table spans the viewport" }).toEqual([]);
}

async function expectNativeNavigationFrames(page: Page, exercise: () => Promise<void>, name: string, requireVisualPan = false): Promise<void> {
  const observed = await page.evaluateHandle(() => {
    const samples: { event: string; gap: number; scale: number; viewportTop: number; viewportLeft: number;
      scrollY: number; scrollX: number; innerHeight: number; visualHeight: number; tableX: number;
      sidebarTop: number; headerTop: number; headerPosition: string }[] = [];
    const v = visualViewport!, table = document.querySelector<HTMLElement>(".fleet-table-wrap")!;
    const sample = (event: string) => {
      const sidebar = document.querySelector("#sidebar")!.getBoundingClientRect();
      const headerElement = document.querySelector(".fleet-title-row")!, header = headerElement.getBoundingClientRect();
      samples.push({ event, scale: v.scale, viewportTop: v.offsetTop, viewportLeft: v.offsetLeft, scrollY, scrollX,
        innerHeight, visualHeight: v.height, tableX: table.scrollLeft, sidebarTop: sidebar.top, headerTop: header.top,
        headerPosition: getComputedStyle(headerElement).position,
        gap: Math.max(Math.abs(sidebar.left - v.offsetLeft), Math.abs(sidebar.top - v.offsetTop),
          Math.abs(sidebar.bottom - v.offsetTop - v.height), Math.abs(header.top - v.offsetTop),
          Math.abs(header.left - sidebar.right), Math.abs(header.right - v.offsetLeft - v.width)) });
    };
    const documentScroll = () => sample("document"), viewportScroll = () => sample("visual-viewport"), tableScroll = () => sample("table");
    window.addEventListener("scroll", documentScroll, { passive: true });
    v.addEventListener("scroll", viewportScroll, { passive: true });
    table.addEventListener("scroll", tableScroll, { passive: true });
    return { samples, documentScroll, viewportScroll, tableScroll };
  });
  let samples: { event: string; gap: number; viewportTop: number; viewportLeft: number }[] = [];
  try { await exercise(); }
  finally {
    samples = await observed.evaluate(value => {
      window.removeEventListener("scroll", value.documentScroll);
      visualViewport!.removeEventListener("scroll", value.viewportScroll);
      document.querySelector(".fleet-table-wrap")!.removeEventListener("scroll", value.tableScroll);
      return value.samples;
    });
    await observed.dispose();
    const path = test.info().outputPath(`navigation-frames-${name}.json`);
    await writeFile(path, JSON.stringify(samples, null, 2));
    await test.info().attach(`navigation frames ${name}`, { contentType: "application/json", path });
  }
  expect(samples.length, "The native gesture must generate actual scroll samples").toBeGreaterThan(0);
  if (requireVisualPan) {
    expect(samples.filter(sample => sample.event === "visual-viewport").length, "Restored zoom must actually exercise visual-viewport motion").toBeGreaterThan(0);
    expect(Math.max(...samples.map(sample => sample.viewportTop)) - Math.min(...samples.map(sample => sample.viewportTop))).toBeGreaterThan(20);
  }
  const worst = samples.reduce((prior, sample) => sample.gap > prior.gap ? sample : prior, samples[0]!);
  expect(worst.gap, `Navigation must align before rAF correction: ${JSON.stringify(worst)}`).toBeLessThan(1.1);
}

async function settledPinchViewport(page: Page) {
  return page.evaluate(async () => {
    const v = visualViewport!;
    let previous = v.scale, stableFrames = 0;
    // Input dispatch acknowledges the event before every compositor update has
    // necessarily reached visualViewport. Require two quiet animation frames
    // before converting the next physical finger position back to CSS pixels.
    for (let frame = 0; frame < 12 && stableFrames < 2; frame++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const scale = v.scale;
      stableFrames = Math.abs(scale - previous) < .000001 ? stableFrames + 1 : 0;
      previous = scale;
    }
    if (stableFrames < 2) throw new Error("Native pinch viewport did not settle before the next touch sample");
    return { left: v.offsetLeft, top: v.offsetTop, width: v.width, height: v.height,
      pageLeft: v.pageLeft, pageTop: v.pageTop, scale: v.scale };
  });
}

async function physicalPinch(page: Page, session: CDPSession, center: { x: number; y: number }) {
  const before = await settledPinchViewport(page);
  zoomExpectations.set(page, { baselineScale: before.scale, natural: true });
  const observed = await page.evaluateHandle(() => {
    type Point = { id: number; x: number; y: number };
    const state = {
      step: 0, phase: "start", eventStart: 0,
      identifiers: new Set<number>(), changed: new Map<number, Point>(), released: new Map<number, Point>(),
      samples: [] as { step: number; phase: string; type: string; time: number; scale: number;
        touches: Point[]; changedTouches: Point[] }[],
    };
    const point = (touch: Touch): Point => ({ id: touch.identifier, x: touch.screenX, y: touch.screenY });
    const listener = (event: TouchEvent) => {
      const touches = [...event.touches].map(point), changedTouches = [...event.changedTouches].map(point);
      state.samples.push({ step: state.step, phase: state.phase, type: event.type, time: event.timeStamp,
        scale: visualViewport!.scale, touches, changedTouches });
      if (event.type === "touchstart") for (const touch of touches) state.identifiers.add(touch.id);
      if (event.type === "touchmove") for (const touch of changedTouches) state.changed.set(touch.id, touch);
      if (event.type === "touchend") for (const touch of changedTouches) state.released.set(touch.id, touch);
    };
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"] as const) {
      document.addEventListener(type, listener, { capture: true, passive: true });
    }
    return { state, listener };
  });
  const points = (spread: number, scale: number) => [
    { id: 0, x: center.x / scale, y: (center.y - spread) / scale },
    { id: 1, x: center.x / scale, y: (center.y + spread) / scale },
  ];
  const steps: { step: number; dispatchScale: number; expectedSpread: number; eventCount: number;
    status: "complete" | "coalesced-or-incomplete"; points: { id: number; x: number; y: number }[] }[] = [];
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(30, before.scale) });
  let current = await settledPinchViewport(page);
  for (let step = 1; step <= 12; step++) {
    const dispatchScale = current.scale;
    await observed.evaluate(({ state }, step) => {
      state.step = step;
      state.phase = "move";
      state.eventStart = state.samples.length;
      state.changed.clear();
    }, step);
    // CDP coordinates are visual CSS pixels. Scale-adjust every move so the
    // physical fingers stay on screen instead of racing toward the page corner.
    await session.send("Input.dispatchTouchEvent", { type: "touchMove",
      touchPoints: points(30 + step * 7.5, dispatchScale) });
    current = await settledPinchViewport(page);
    const delivered = await observed.evaluate(({ state }) => ({
      points: [...state.changed.values()], identifiers: [...state.identifiers],
      eventCount: state.samples.length - state.eventStart,
    }));
    // CDP emits one event per changed finger, and Chromium can coalesce DOM
    // delivery. Measure a completed pair using each identifier's latest update;
    // never reuse a previous step's finger or pick a best-looking raw event.
    const complete = delivered.identifiers.length === 2 && delivered.points.length === 2 &&
      delivered.identifiers.every(id => delivered.points.some(point => point.id === id));
    steps.push({ step, dispatchScale, expectedSpread: 30 + step * 7.5,
      eventCount: delivered.eventCount, status: complete ? "complete" : "coalesced-or-incomplete", points: delivered.points });
  }
  await observed.evaluate(({ state }) => { state.step = 13; state.phase = "end"; state.released.clear(); });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(async () => (await viewport(page)).scale / before.scale).toBeGreaterThan(1.25);
  const after = await settledPinchViewport(page);
  const delivered = await observed.evaluate(({ state, listener }) => {
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"] as const) {
      document.removeEventListener(type, listener, { capture: true });
    }
    return { samples: state.samples, identifiers: [...state.identifiers], finalPair: [...state.released.values()] };
  });
  await observed.dispose();
  const centerDrift = (pair: readonly { x: number; y: number }[]) => Math.max(
    Math.abs(pair.reduce((sum, point) => sum + point.x, 0) / pair.length - center.x),
    Math.abs(pair.reduce((sum, point) => sum + point.y, 0) / pair.length - center.y));
  const completed = steps.filter(step => step.status === "complete");
  const maxScreenDrift = Math.max(0, ...completed.map(step => centerDrift(step.points)));
  const maxRawScreenDrift = Math.max(0, ...delivered.samples.filter(sample => sample.touches.length === 2)
    .map(sample => centerDrift(sample.touches)));
  const finalPairComplete = delivered.identifiers.length === 2 && delivered.finalPair.length === 2 &&
    delivered.identifiers.every(id => delivered.finalPair.some(point => point.id === id));
  const finalScreenDrift = finalPairComplete ? centerDrift(delivered.finalPair) : null;
  const drift = {
    x: after.pageLeft + center.x / after.scale - before.pageLeft - center.x / before.scale,
    y: after.pageTop + center.y / after.scale - before.pageTop - center.y / before.scale,
  };
  const evidencePath = test.info().outputPath("pinch-input-quality.json");
  await writeFile(evidencePath, JSON.stringify({ center, before, after, drift, maxScreenDrift, maxRawScreenDrift,
    finalScreenDrift, steps, finalPair: delivered.finalPair, samples: delivered.samples }, null, 2));
  await test.info().attach("pinch-input-quality", { contentType: "application/json", path: evidencePath });
  expect(completed.length, "Native moves must deliver completed two-finger pairs to the page").toBeGreaterThan(0);
  expect(maxScreenDrift, "Completed touch steps must keep the physical pinch center stable").toBeLessThan(1);
  expect(finalPairComplete, "The final released pair must include both original fingers").toBe(true);
  expect(finalScreenDrift!, "The released pair must keep the physical pinch center stable").toBeLessThan(1);
  return { before, after, drift, maxScreenDrift };
}

async function naturalGeometry(page: Page) {
  const baseline = zoomExpectations.get(page)?.baselineScale ?? 1;
  return page.evaluate(baseline => {
    const v = visualViewport!, sidebar = document.querySelector("#sidebar")!.getBoundingClientRect();
    const header = document.querySelector(".fleet-title-row")!.getBoundingClientRect();
    const table = document.querySelector(".fleet-table-wrap")!.getBoundingClientRect();
    const intersects = (one: DOMRect, two: DOMRect) => Math.min(one.right, two.right) - Math.max(one.left, two.left) > 1 &&
      Math.min(one.bottom, two.bottom) - Math.max(one.top, two.top) > 1;
    const covered: string[] = [];
    // Include plain values as well as buttons: a hidden cell is still obscured
    // content, even when some other control can eventually be panned into view.
    for (const element of document.querySelectorAll(".fleet-table td, #column-headings button, #scenario, #preview-tools > summary")) {
      const r = element.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || r.right <= v.offsetLeft || r.left >= v.offsetLeft + v.width ||
          r.bottom <= v.offsetTop || r.top >= v.offsetTop + v.height) continue;
      // Native horizontal scrolling intentionally clips offscreen columns at
      // the wrapper edge. Only their actually paintable area can cover a bar;
      // the wrapper's separate document gaps are asserted independently below.
      let left = Math.max(r.left, v.offsetLeft), right = Math.min(r.right, v.offsetLeft + v.width);
      let top = Math.max(r.top, v.offsetTop), bottom = Math.min(r.bottom, v.offsetTop + v.height);
      for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
        const style = getComputedStyle(parent), box = parent.getBoundingClientRect();
        if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
          left = Math.max(left, box.left + parent.clientLeft);
          right = Math.min(right, box.left + parent.clientLeft + parent.clientWidth);
        }
        if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
          top = Math.max(top, box.top + parent.clientTop);
          bottom = Math.min(bottom, box.top + parent.clientTop + parent.clientHeight);
        }
      }
      if (right <= left || bottom <= top) continue;
      const painted = new DOMRect(left, top, right - left, bottom - top);
      if (intersects(painted, sidebar) || intersects(painted, header)) covered.push(element.getAttribute("aria-label") ?? element.textContent?.slice(0, 50) ?? "table content");
    }
    return { leftGap: table.left - sidebar.right, topGap: table.top - header.bottom,
      sidebarDocumentLeft: sidebar.left + scrollX, sidebarDocumentTop: sidebar.top + scrollY,
      headerDocumentLeft: header.left + scrollX, headerDocumentTop: header.top + scrollY,
      sidebarWidth: sidebar.width, sidebarHeight: sidebar.height, headerWidth: header.width,
      canvasWidth: v.width * v.scale / baseline, canvasHeight: v.height * v.scale / baseline, scale: v.scale,
      sidebarOutsideScreen: sidebar.left < v.offsetLeft - 1 || sidebar.top < v.offsetTop - 1 || sidebar.bottom > v.offsetTop + v.height + 1,
      covered };
  }, baseline);
}

async function expectNaturalZoom(page: Page, originalSidebarWidth?: number): Promise<void> {
  const prior = zoomExpectations.get(page);
  zoomExpectations.set(page, { baselineScale: prior?.baselineScale ?? 1, natural: true });
  await expect.poll(async () => {
    const value = await naturalGeometry(page), issues: string[] = [];
    if (Math.abs(value.sidebarDocumentLeft) > 1 || Math.abs(value.sidebarDocumentTop) > 1) issues.push("Sidebar moved away from document origin");
    if (Math.abs(value.headerDocumentLeft - value.sidebarWidth) > 1 || Math.abs(value.headerDocumentTop) > 1) issues.push("Header no longer follows the reserved document sidebar column");
    if (value.leftGap < 11 || value.topGap < -1) issues.push(`Reserved table space lost: left=${value.leftGap}, top=${value.topGap}`);
    if (Math.abs(value.sidebarHeight - value.canvasHeight) > 1) issues.push("Sidebar was resized to the zoomed visible screen");
    if (Math.abs(value.headerWidth + value.sidebarWidth - value.canvasWidth) > 1) issues.push("Header was resized to the zoomed visible screen");
    if (originalSidebarWidth !== undefined && Math.abs(value.sidebarWidth - originalSidebarWidth) > 1) issues.push("Zoom changed the natural sidebar width");
    return issues.concat(value.covered);
  }, { message: "Zoom must preserve document layout and keep navigation separate from table content before corrective panning" }).toEqual([]);
}

async function expectShell(page: Page): Promise<void> {
  const prior = zoomExpectations.get(page);
  zoomExpectations.set(page, { baselineScale: prior?.baselineScale ?? 1, natural: false });
  // Read the whole component in one frame; per-element locator assertions add
  // repeated snapshots of the 200-row table and can obscure a moving boundary.
  await expect.poll(async () => page.evaluate(() => {
    const v = visualViewport!, issues: string[] = [];
    const sidebar = document.querySelector("#sidebar")!.getBoundingClientRect();
    const header = document.querySelector(".fleet-title-row")!.getBoundingClientRect();
    const error = Math.max(Math.abs(sidebar.left - v.offsetLeft), Math.abs(sidebar.top - v.offsetTop),
      Math.abs(sidebar.bottom - v.offsetTop - v.height), Math.abs(header.top - v.offsetTop),
      Math.abs(header.left - sidebar.right), Math.abs(header.right - v.offsetLeft - v.width));
    if (error >= 1.1) issues.push(`sidebar/header viewport edge mismatch: ${error}; scale=${v.scale}, ratio=${document.documentElement.dataset.pageZoomRatio}, mode=${document.documentElement.dataset.pageZoomed}, offset=${v.offsetLeft},${v.offsetTop}, scroll=${scrollX},${scrollY}`);
    for (const selector of ["#sidebar-toggle", "#fleet-connection"]) {
      const element = document.querySelector(selector)!, r = element.getBoundingClientRect();
      const inside = r.width > 0 && r.height > 0 && r.left >= v.offsetLeft - 1 && r.right <= v.offsetLeft + v.width + 1 &&
        r.top >= v.offsetTop - 1 && r.bottom <= v.offsetTop + v.height + 1;
      if (!inside) issues.push(`${selector} outside visual viewport`);
      else if (!element.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))) issues.push(`${selector} covered`);
    }
    const main = document.querySelector<HTMLElement>("main")!, style = getComputedStyle(main);
    if (main.inert || style.opacity !== "1" || style.filter !== "none") issues.push("Fleet is dimmed or inert");
    return issues;
  }), { message: "The entire sidebar/header must follow the screen with usable controls and unchanged Fleet brightness" }).toEqual([]);
}

async function footerJourney(page: Page, session: CDPSession, mobile: boolean, screenshotPath?: string): Promise<void> {
  // Observe the unscrolled footer first. Short viewports must deliberately offer
  // menu scrolling; being DOM-visible below the screen does not count.
  const initial = await page.locator("#sidebar-content").evaluate(element => ({
    top: element.scrollTop, client: element.clientHeight, scroll: element.scrollHeight,
    overflow: getComputedStyle(element).overflowY,
  }));
  for (const label of ["Deploy", "Explore", "Host", "Stake"]) {
    const link = page.getByRole("link", { name: label, exact: false });
    for (let i = 0; i < 16 && !(await screenBox(link)).painted; i++) {
      expect(initial.overflow, "A clipped footer needs an explicit menu scroll area").toMatch(/auto|scroll/);
      expect(initial.scroll).toBeGreaterThan(initial.client);
      const target = await screenBox(link), menu = await screenBox(page.locator("#sidebar-content"));
      const delta = target.y - menu.y;
      const reverse = delta < 0;
      if (mobile) await pan(page, session, "y", reverse, "menu", Math.max(24, Math.abs(delta)));
      else {
        const box = await screenBox(page.locator("#sidebar-content"));
        await page.mouse.move(box.x, Math.min(box.bottom - 8, (await viewport(page)).height - 8));
        await page.mouse.wheel(0, reverse ? -60 : 60);
      }
    }
    await expectReachable(link);
    await expect(link).toHaveAttribute("target", "_blank");
  }
  if (screenshotPath) await page.screenshot({ path: screenshotPath });
  // Return with native menu scrolling so the next test action cannot rely on
  // focus or scrollIntoView to resurrect a stranded menu control.
  for (let i = 0; i < 16 && await page.locator("#sidebar-content").evaluate(element => element.scrollTop) > 1; i++) {
    if (mobile) await pan(page, session, "y", true, "menu");
    else await page.mouse.wheel(0, -200);
  }
  await expectShell(page);
}

async function reachByPan(page: Page, session: CDPSession, target: Locator, axis: "x" | "y" = "y"): Promise<void> {
  for (let attempt = 0; attempt < 40 && !(await screenBox(target)).painted; attempt++) {
    const r = await screenBox(target), v = await viewport(page);
    const sidebar = await screenBox(page.locator("#sidebar"));
    const zoomed = zoomExpectations.get(page)?.natural ?? false;
    const pageTop = zoomed ? v.top : v.height < 200 ? (await screenBox(page.locator(".fleet-title-row"))).bottom : v.top + Math.min(125, v.height * .45);
    const pageBottom = v.top + v.height - (zoomed || v.height < 200 ? 0 : 20);
    // In natural zoom the bars may be outside view, while the complete target
    // still has to fit the visible screen before any touch action.
    const availableLeft = zoomed ? v.left : Math.max(v.left, sidebar.right);
    const direction = r.left < availableLeft - 1 || r.right > v.left + v.width + 1 ? "x" : axis;
    const middle = direction === "x" ? (availableLeft + v.left + v.width) / 2 : (pageTop + pageBottom) / 2;
    const delta = (direction === "x" ? r.x : r.y) - middle;
    // Chromium consumes the first ~15 screen CSS pixels as touch slop. Include
    // that travel so the final small correction can expose an entire 24px target
    // in the 48px screen, instead of oscillating by a full scroll-area stroke.
    await pan(page, session, direction, delta < 0, "page", Math.abs(delta) + 15 / v.scale);
    if (zoomed) await expectNaturalZoom(page);
    else await expectShell(page);
  }
  await expectReachable(target);
}

async function expectDialog(page: Page): Promise<void> {
  await expectReachable(page.locator("#info-dialog"));
  await expectReachable(page.locator("#close-info"));
  const sizes = await page.locator("#info-body").evaluate(element => ({ client: element.clientWidth,
    scroll: element.scrollWidth, overflow: getComputedStyle(element).overflowY, height: element.clientHeight }));
  expect(sizes.scroll, "Dialog prose must wrap inside the visible screen").toBeLessThanOrEqual(sizes.client + 1);
  expect(sizes.height, "The dialog must reserve readable content space").toBeGreaterThan(20);
  expect(sizes.overflow).toMatch(/auto|scroll/);
}

async function expectTargets(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const controls = [...document.querySelectorAll<HTMLElement>("#column-headings button, #fleet-rows tr:first-child button, #fleet-rows tr:first-child a, #clear-sort, #sidebar-toggle, #sidebar-clear-sort")]
      .filter(element => !element.closest("[inert]") && element.checkVisibility({ visibilityProperty: true }) && element.getBoundingClientRect().width > 0)
      .map(element => ({ label: element.getAttribute("aria-label") ?? element.textContent ?? element.id, r: element.getBoundingClientRect() }));
    const small = controls.filter(({ r }) => r.width < 24 || r.height < 24).map(({ label, r }) => `${label}: ${r.width}×${r.height}`);
    const overlap: string[] = [];
    for (let a = 0; a < controls.length; a++) for (let b = a + 1; b < controls.length; b++) {
      const one = controls[a]!, two = controls[b]!;
      if (Math.min(one.r.right, two.r.right) - Math.max(one.r.left, two.r.left) > .5 &&
          Math.min(one.r.bottom, two.r.bottom) - Math.max(one.r.top, two.r.top) > .5) overlap.push(`${one.label} / ${two.label}`);
    }
    return { small, overlap, height: document.querySelector("#fleet-rows tr")!.getBoundingClientRect().height };
  });
  expect(result.small).toEqual([]);
  expect(result.overlap).toEqual([]);
  expect(result.height, "Compact separate rows stay compact").toBeLessThanOrEqual(36);
}

for (const size of cases) test.describe(`UX consistency: ${size.name}`, () => {
  test.use({ viewport: { width: size.width, height: size.height }, isMobile: size.mobile, hasTouch: size.mobile, deviceScaleFactor: size.mobile ? 2 : 1 });
  const errors: string[] = [];
  const external: string[] = [];
  const reads: string[] = [];
  test.beforeEach(async ({ page, context }) => {
    errors.length = external.length = reads.length = 0;
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin !== "http://127.0.0.1:4174") { external.push(url.href); return route.abort(); }
      if (url.pathname.endsWith(".json") && !["/preview/hosts.json", "/preview/connection.json"].includes(url.pathname)) reads.push(url.pathname);
      return route.continue();
    });
  });
  test.afterEach(() => {
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
    expect(reads, "Synthetic UX navigation cannot read live providers").toEqual([]);
  });

  test("normal navigation stays reachable and browser zoom preserves its separate natural layout", async ({ page, context }, info) => {
    // Full native journeys include deliberate scrolling and whole-component checks;
    // the shared run measured up to 80s of gesture/verification work.
    test.setTimeout(120_000);
    await page.goto("/?scenario=scale");
    await expect(page.locator("#fleet-rows tr")).toHaveCount(200);
    await expect(page.locator("#fleet-connection")).toHaveText("Connected");
    const session = await context.newCDPSession(page);
    const toggle = page.locator("#sidebar-toggle");
    await expectShell(page);
    await expect(toggle).toHaveAttribute("aria-expanded", String(size.width > 760));
    if (await toggle.getAttribute("aria-expanded") === "false") await activate(page, toggle, size.mobile);
    await expectShell(page);
    const firstCell = await screenBox(page.locator("#fleet-rows tr:first-child td:first-child"));
    const sidebar = await screenBox(page.locator("#sidebar"));
    expect(firstCell.left - sidebar.right).toBeGreaterThanOrEqual(11);
    await expectReachable(page.locator('#fleet-rows tr:first-child td[data-col="pc"] button'));
    await footerJourney(page, session, size.mobile);
    await page.screenshot({ path: info.outputPath("expanded-before-page-pan.png") });
    if (size.mobile) {
      const before = await viewport(page);
      await pan(page, session, "y");
      await expect.poll(async () => (await viewport(page)).pageTop).toBeGreaterThan(before.pageTop + 15);
      await expectShell(page);
      await pan(page, session, "x");
      await expect.poll(async () => page.locator(".fleet-table-wrap").evaluate(element => element.scrollLeft)).toBeGreaterThan(15);
      expect((await viewport(page)).pageLeft).toBeCloseTo(before.pageLeft, 0);
    } else {
      await page.mouse.move(size.width - 60, size.height / 2);
      // Native scroll containers choose an axis for a diagonal wheel event.
      // Exercise each real input separately: X belongs to the table, Y to the document.
      await page.mouse.wheel(300, 0);
      await page.mouse.wheel(0, 700);
      await expect.poll(async () => (await viewport(page)).pageTop).toBeGreaterThan(15);
    }
    await expectShell(page);
    await page.reload();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expectShell(page); // Immediate bounds, before any action can auto-scroll.
    await page.screenshot({ path: info.outputPath("reloaded-after-pan.png") });
    await activate(page, toggle, size.mobile);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expectShell(page);
    await activate(page, toggle, size.mobile);
    const originalWidth = (await naturalGeometry(page)).sidebarWidth;
    await page.waitForTimeout(350); // Finish page restoration before independent zoom input.
    for (const scale of [2, 5, .5, 1]) {
      await setBrowserPinchScale(page, session, scale);
      const actual = (await viewport(page)).scale;
      if (size.mobile && scale >= 2) expect(actual).toBeCloseTo(scale, 2);
      if (scale === .5) expect(actual).toBeLessThanOrEqual(1);
      if (actual > 1.01) {
        await expectNaturalZoom(page, originalWidth);
        if (size.mobile) await pan(page, session, "x");
        else await page.mouse.wheel(180, 120);
        await expectNaturalZoom(page, originalWidth);
        await page.screenshot({ path: info.outputPath(`natural-zoom-${scale}x.png`) });
      } else await expectShell(page);
    }
    await expectShell(page);
    await expectReachable(toggle);
    await activate(page, toggle, size.mobile);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await page.setViewportSize(size.mobile ? { width: size.height, height: size.width } : { width: 1100, height: 650 });
    await expectShell(page);
    await fixedBaseline(page);
    await page.setViewportSize({ width: size.width, height: size.height });
    await expectShell(page);
    await fixedBaseline(page);
    await page.reload();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expectShell(page);
  });

  test("detail dialog and Close fit the visible screen through zoom and content scrolling", async ({ page, context }, info) => {
    test.setTimeout(60_000);
    await page.goto("/?scenario=mixed");
    await expect(page.locator("#fleet-rows tr")).toHaveCount(6);
    const session = await context.newCDPSession(page);
    await activate(page, page.locator('#fleet-rows tr:first-child td[data-col="pc"] button'), size.mobile);
    await expectDialog(page);
    await page.waitForTimeout(350);
    for (const scale of [2, 5, .5, 1]) {
      await setBrowserPinchScale(page, session, scale);
      await expectDialog(page);
    }
    const source = page.locator(".info-source > summary");
    for (let i = 0; i < 16 && !(await screenBox(source)).painted; i++) {
      if (size.mobile) await pan(page, session, "y", false, "dialog");
      else { const r = await screenBox(page.locator("#info-body")); await page.mouse.move(r.x, r.y); await page.mouse.wheel(0, 150); }
      await expectReachable(page.locator("#close-info"));
    }
    await activate(page, source, size.mobile);
    await expect(page.locator(".info-source")).toHaveAttribute("open", "");
    for (let i = 0; i < 3; i++) {
      if (size.mobile) await pan(page, session, "y", false, "dialog");
      else await page.mouse.wheel(0, 150);
      await expectDialog(page);
    }
    await page.screenshot({ path: info.outputPath("detail-source-scrolled.png") });
    await activate(page, page.locator("#close-info"), size.mobile);
    await expect(page.locator("#info-dialog")).not.toBeVisible();
    await expectShell(page);
  });

  test("compact controls have separate 24px targets and narrow headers retain Clear sort", async ({ page }) => {
    await page.goto("/?scenario=mixed");
    await expect(page.locator("#fleet-rows tr")).toHaveCount(6);
    await expectTargets(page);
    await activate(page, page.getByRole("button", { name: "Sort by PC", exact: true }), size.mobile);
    await expect(page.locator('th[data-col="pc"]')).toHaveAttribute("aria-sort", "descending");
    const toggle = page.locator("#sidebar-toggle");
    if (await toggle.getAttribute("aria-expanded") === "true") await activate(page, toggle, size.mobile);
    await activate(page, toggle, size.mobile); // Save the expanded choice across the narrow reload.
    // Chromium may preserve its old visible CSS width when resizing a wide
    // mobile context. Establish an actual 240 CSS-pixel unzoomed baseline before
    // asserting the width-based fallback, while retaining the saved menu/sort.
    await page.setViewportSize({ width: 240, height: size.height });
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
    await page.reload();
    await expect(page.locator("#fleet-rows tr")).toHaveCount(6);
    await fixedBaseline(page);
    await expect.poll(async () => (await viewport(page)).width).toBeCloseTo(240, 0);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator('th[data-col="pc"]')).toHaveAttribute("aria-sort", "descending");
    await expectShell(page);
    await expect(page.locator("#clear-sort")).not.toBeVisible();
    const clear = page.locator("#sidebar-clear-sort");
    await activate(page, clear, size.mobile);
    await expect(page.locator('th[data-col="pc"]')).toHaveAttribute("aria-sort", "ascending");
  });
});

for (const device of [{ name: "phone", width: 390, height: 844, mobile: true }, { name: "laptop", width: 1440, height: 900, mobile: false }]) {
  test.describe(`native focal pinch: ${device.name}`, () => {
    test.use({ viewport: { width: device.width, height: device.height }, isMobile: device.mobile, hasTouch: true });
    test("pinch keeps navigation and table separate before corrective pan and after zoomed reload", async ({ page, context }, info) => {
      test.setTimeout(90_000);
      const external: string[] = [];
      await context.route("**/*", route => {
        if (new URL(route.request().url()).origin !== "http://127.0.0.1:4174") { external.push(route.request().url()); return route.abort(); }
        return route.continue();
      });
      await page.goto("/?scenario=scale");
      await expect(page.locator("#fleet-rows tr")).toHaveCount(200);
      const toggle = page.locator("#sidebar-toggle");
      if (await toggle.getAttribute("aria-expanded") !== "true") await activate(page, toggle, true);
      await expectShell(page);
      const width = (await naturalGeometry(page)).sidebarWidth;
      const session = await context.newCDPSession(page);
      // A focal pinch moves the visual viewport as well as changing scale. A
      // scale-factor-only test missed the physical report's coordinate mismatch.
      const pinch = await physicalPinch(page, session, { x: device.width * .65, y: device.height * .55 });
      expect(pinch.after.scale / pinch.before.scale).toBeGreaterThan(1.25);
      expect(Math.abs(pinch.drift.x)).toBeLessThan(6);
      expect(Math.abs(pinch.drift.y)).toBeLessThan(6);
      await expectNaturalZoom(page, width); // No corrective pan is allowed first.
      const reference = await naturalGeometry(page);
      await page.screenshot({ path: info.outputPath("focal-pinch-before-corrective-pan.png") });
      for (const axis of ["x", "y"] as const) {
        await pan(page, session, axis);
        await expectNaturalZoom(page, width);
        const value = await naturalGeometry(page);
        expect(Math.abs(value.leftGap - reference.leftGap)).toBeLessThan(1.1);
        expect(Math.abs(value.topGap - reference.topGap)).toBeLessThan(1.1);
      }
      if (device.mobile) {
        const relative = (await viewport(page)).scale / (zoomExpectations.get(page)?.baselineScale ?? 1);
        await page.setViewportSize({ width: device.height, height: device.width });
        await page.waitForTimeout(350); // Browser orientation/viewport events settle before rebasing.
        zoomExpectations.set(page, { baselineScale: (await viewport(page)).scale / relative, natural: true });
        await expectNaturalZoom(page, width);
        await page.setViewportSize({ width: device.width, height: device.height });
        await page.waitForTimeout(350);
        zoomExpectations.set(page, { baselineScale: (await viewport(page)).scale / relative, natural: true });
        await expectNaturalZoom(page, width);
      }
      await page.reload();
      await expect(page.locator("#fleet-rows tr")).toHaveCount(200);
      await fixedBaseline(page);
      await expectShell(page); // A fresh load adopts the browser's restored scale.
      await page.screenshot({ path: info.outputPath("reloaded-after-zoomed-pan.png") });
      await expectReachable(toggle);
      await activate(page, toggle, true);
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(external).toEqual([]);
    });
  });
}

for (const width of [320, 390]) test.describe(`complete touch journey ${width}px`, () => {
  test.use({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  test("all 200 rows, both table edges, Scenario, diagnostics and details are reachable by touch", async ({ page, context }, info) => {
    // Full native journeys include deliberate scrolling and whole-component checks;
    // the shared run measured up to 80s of gesture/verification work.
    test.setTimeout(120_000);
    const external: string[] = [];
    await context.route("**/*", route => {
      if (new URL(route.request().url()).origin !== "http://127.0.0.1:4174") { external.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    await page.goto("/?scenario=scale");
    await expect(page.locator("#fleet-rows tr")).toHaveCount(200);
    const session = await context.newCDPSession(page);
    const first = page.locator('#fleet-rows tr:first-child td[data-col="pc"] button');
    await expectReachable(first);
    await activate(page, page.locator("#sidebar-toggle"), true);
    await expectShell(page);
    await expectReachable(first);
    const right = page.locator('#column-headings th[data-col="country"] .column-label');
    await reachByPan(page, session, right, "x");
    await page.screenshot({ path: info.outputPath("rightmost-column-menu-expanded.png") });
    await activate(page, right, true);
    await expect(page.locator('th[data-col="country"]')).toHaveAttribute("aria-sort", "ascending");
    await reachByPan(page, session, first, "x");
    await activate(page, page.locator("#clear-sort"), true);
    const last = page.locator('#fleet-rows tr:last-child td[data-col="pc"] button');
    await reachByPan(page, session, last);
    await activate(page, last, true);
    await expectDialog(page);
    await activate(page, page.locator("#close-info"), true);
    const scenario = page.locator("#scenario");
    await reachByPan(page, session, scenario);
    await expectReachable(scenario);
    await expect(scenario).toHaveValue("scale");
    const tools = page.locator("#preview-tools > summary");
    await reachByPan(page, session, tools);
    await activate(page, tools, true);
    await expect(page.locator("#preview-tools")).toHaveAttribute("open", "");
    const columnInfo = page.locator("#column-info");
    await reachByPan(page, session, columnInfo);
    await activate(page, columnInfo, true);
    await expectDialog(page);
    await activate(page, page.locator("#close-info"), true);
    const refresh = page.locator("#refresh-view");
    await reachByPan(page, session, refresh);
    await activate(page, refresh, true);
    await expect(page.locator("#fleet-rows tr")).toHaveCount(200);
    await expectShell(page);
    await page.screenshot({ path: info.outputPath("diagnostics-reached-by-touch.png") });
    expect(external).toEqual([]);
  });
});

test.describe("short zoomed screen", () => {
  test.use({ viewport: { width: 667, height: 240 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  test("body details remain reachable by native touch with a 120px or 48px visible height", async ({ page, context }, info) => {
    test.setTimeout(60_000);
    await context.route("**/*", route => new URL(route.request().url()).origin === "http://127.0.0.1:4174" ? route.continue() : route.abort());
    const session = await context.newCDPSession(page);
    for (const scale of [2, 5]) {
      await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
      await page.goto("/?scenario=mixed");
      await expect(page.locator("#fleet-rows tr")).toHaveCount(6);
      await fixedBaseline(page);
      const baseline = (await viewport(page)).scale;
      await page.waitForTimeout(350);
      await setBrowserPinchScale(page, session, baseline * scale);
      await expect.poll(async () => (await viewport(page)).scale).toBeCloseTo(baseline * scale, 2);
      await expectNaturalZoom(page);
      const target = page.locator('#fleet-rows tr:first-child td[data-col="stakedNos"] button');
      await reachByPan(page, session, target);
      await activate(page, target, true);
      await expectDialog(page);
      await page.screenshot({ path: info.outputPath(`short-screen-body-detail-${scale}x.png`) });
      await activate(page, page.locator("#close-info"), true);
      await expect(page.locator("#info-dialog")).not.toBeVisible();
    }
  });
});

test.describe("Real200 browser scale baseline", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  for (const count of [86, 200]) test(`${count} isolated Real200 rows keep fixed navigation after restored zoom, reload and unpinched rotation`, async ({ page, context }, info) => {
    test.setTimeout(90_000);
    const fixtureAddress = (value: number): string => {
      const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
      let encoded = "";
      for (let remaining = value; remaining; remaining = Math.floor(remaining / 58)) encoded = alphabet[remaining % 58]! + encoded;
      return "1".repeat(32 - Math.ceil(Math.log2(value + 1) / 8)) + encoded;
    };
    const directory = await mkdtemp(join(tmpdir(), "gridlens-real200-zoom-baseline-"));
    const hostsFile = join(directory, "hosts.json"), real200HostsFile = join(directory, "real200.json");
    await writeFile(hostsFile, JSON.stringify(addresses));
    await writeFile(real200HostsFile, JSON.stringify(Array.from({ length: count }, (_, index) => fixtureAddress(index + 1))));
    const server = await startPreviewServer({ hostsFile, real200HostsFile, port: 0,
      metadataProvider: async input => ({ hosts: input.map(address => ({ address, values: null, fetchedAtMs: null,
        retained: false, error: null, marketError: null })) }),
      nodeInfoProvider: async input => ({ hosts: input.map(address => ({ address, values: null, fetchedAtMs: null,
        validUntilMs: null, retained: false, error: null })) }),
      jobProvider: emptyJobs, queueProvider: emptyQueue, solProvider: emptySol, nosProvider: emptyNos, stakingProvider: emptyStaking,
    });
    const bound = server.address();
    if (!bound || typeof bound === "string") throw new Error("Missing isolated preview port");
    const origin = `http://127.0.0.1:${bound.port}`, external: string[] = [];
    await context.route("**/*", route => {
      if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    await context.addInitScript(wide => {
      localStorage.setItem("gridlens.preview.sidebar.v1", wide ? "expanded" : "collapsed");
      if (wide) localStorage.setItem("gridlens.preview.host-address-mode.v1", "full");
    }, count === 200);
    try {
      await page.goto(`${origin}/?scenario=real200`);
      await expect(page.locator("#fleet-rows tr")).toHaveCount(count);
      await fixedBaseline(page);
      await expectShell(page);
      await expectFleetDocumentFlow(page);
      const session = await context.newCDPSession(page);
      await expectNativeNavigationFrames(page, async () => {
        await pan(page, session, "y");
        await pan(page, session, "x");
        await expectShell(page);
      }, "fresh");
      await expectSettledColumnHeading(page);
      const pinch = await physicalPinch(page, session, { x: 390 * .8, y: 844 * .55 });
      expect(pinch.after.scale / pinch.before.scale).toBeGreaterThan(1.25);
      await expectNaturalZoom(page);
      await pan(page, session, "y");
      await expectNaturalZoom(page);
      await page.reload();
      await expect(page.locator("#fleet-rows tr")).toHaveCount(count);
      await expect.poll(async () => Math.abs((await viewport(page)).scale - 1)).toBeGreaterThan(.1);
      await fixedBaseline(page);
      await page.screenshot({ path: info.outputPath("real200-restored-nondefault-scale.png") });
      // Fresh/reloaded pages are fixed even when the browser restores ~2x scale.
      // This expectation comes from the journey, never the app's mode attribute.
      await expectShell(page);
      await expectNativeNavigationFrames(page, async () => {
        // Forward gestures alone can leave the visual viewport at its maximum
        // offset and scroll only the document. Reverse to the true page origin
        // first, proving the restored baseline also handles vv-only movement.
        for (let gesture = 0; gesture < 20 && (await viewport(page)).pageTop > 1; gesture++) await pan(page, session, "y", true);
        await expect.poll(async () => (await viewport(page)).pageTop).toBeLessThan(1);
        for (let gesture = 0; gesture < 3; gesture++) { await pan(page, session, "y"); await expectShell(page); }
        await pan(page, session, "x");
        await expectShell(page);
      }, "restored-scale", true);
      expect((await viewport(page)).pageTop).toBeGreaterThan(30);
      await expectSettledColumnHeading(page);
      await page.screenshot({ path: info.outputPath("real200-fixed-after-normal-scroll.png") });
      for (const dimensions of [{ width: 844, height: 390 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(dimensions);
        await page.waitForTimeout(350); // Orientation can change browser scale without a pinch.
        await expectShell(page);
        await fixedBaseline(page);
        await pan(page, session, "y");
        await expectShell(page);
      }
      await page.reload();
      await expect(page.locator("#fleet-rows tr")).toHaveCount(count);
      await fixedBaseline(page);
      await expectShell(page);
      expect(external).toEqual([]);
    } finally {
      await page.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test.describe("mobile refresh consistency", () => {
  test.use({ viewport: { width: 667, height: 240 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  test("expanded navigation preserves offscreen State and Duration refresh and hide/resume recovery", async ({ page, context }) => {
    const now = Date.UTC(2026, 0, 1, 12);
    const directory = await mkdtemp(join(tmpdir(), "gridlens-ux-refresh-"));
    const hostsFile = join(directory, "hosts.json"), real200HostsFile = join(directory, "real200.json");
    await writeFile(hostsFile, JSON.stringify(addresses));
    await writeFile(real200HostsFile, "[]\n");
    await page.clock.install({ time: now });
    await page.clock.pauseAt(now);
    let stateCalls = 0;
    const reads: string[] = [];
    const external: string[] = [];
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
      jobProvider: async input => ({ hosts: input.map((address, index) => ({ address,
        job: { address: addresses[(index + 1) % addresses.length]!, node: address, state: "RUNNING", timeStart: (now - 120_000) / 1000, timeEnd: 0, timeout: 600 },
        checkedAtMs: now, validUntilMs: now + 180_000, failedAtMs: null, retained: false, pending: false, retryAtMs: null, error: null })) }),
      queueProvider: emptyQueue, solProvider: emptySol, nosProvider: emptyNos, stakingProvider: emptyStaking,
    });
    const bound = server.address();
    if (!bound || typeof bound === "string") throw new Error("Missing isolated preview port");
    const origin = `http://127.0.0.1:${bound.port}`;
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { external.push(url.href); return route.abort(); }
      if (url.pathname.endsWith(".json") && url.pathname !== "/preview/connection.json") reads.push(url.pathname);
      return route.continue();
    });
    const visibility = async (state: "visible" | "hidden") => {
      await page.evaluate(value => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
        Object.defineProperty(document, "hidden", { configurable: true, get: () => value === "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
      }, state);
      if (state === "visible") await page.clock.runFor(17);
    };
    try {
      await page.goto(origin);
      await expect(page.locator('#fleet-rows td[data-col="state"][data-state="RUNNING_JOB"]')).toHaveCount(8);
      await expectTargets(page);
      const lastState = page.locator('#fleet-rows tr:last-child td[data-col="state"]');
      const lastDuration = page.locator('#fleet-rows tr:last-child td[data-col="duration"] button');
      expect((await screenBox(lastState)).inside, "The last live row starts off screen").toBe(false);
      await expect(lastDuration).toHaveAccessibleName(/2m \/ 10m/);
      const before = [...reads];
      // The paused page clock also pauses requestAnimationFrame; use tap directly
      // after geometry, with no animation-dependent helper or synthetic scrolling.
      await expectReachable(page.locator("#sidebar-toggle"));
      await page.locator("#sidebar-toggle").tap();
      await expect(page.locator("#sidebar-toggle")).toHaveAttribute("aria-expanded", "true");
      expect(reads).toEqual(before);
      await page.clock.runFor(1_000);
      await expect(lastDuration).toHaveAccessibleName(/2m 1s \/ 10m/);
      await page.clock.runFor(19_000);
      await expect.poll(() => stateCalls).toBe(2);
      await expect(lastState).toHaveAttribute("data-state", "RESTARTING");
      await expect(lastState).toHaveAttribute("data-state-checked-at", String(now + 20_000));
      expect((await screenBox(lastState)).inside).toBe(false);
      await visibility("hidden");
      const stopped = [...reads], calls = stateCalls;
      await page.clock.runFor(60_000);
      expect(reads).toEqual(stopped);
      expect(stateCalls).toBe(calls);
      await visibility("visible");
      await expect.poll(() => stateCalls).toBe(calls + 1);
      // Dispatch starts before the response reaches the row. Observe the
      // completed render, keeping the same source-time window below.
      await expect.poll(async () => Number(await lastState.getAttribute("data-state-checked-at")))
        .toBeGreaterThanOrEqual(now + 80_000);
      const resumedAt = Number(await lastState.getAttribute("data-state-checked-at"));
      // The provider completes during the explicit 17ms resume/frame flush.
      expect(resumedAt).toBeGreaterThanOrEqual(now + 80_000);
      expect(resumedAt).toBeLessThanOrEqual(now + 80_017);
      await expect(page.locator("#sidebar-toggle")).toHaveAttribute("aria-expanded", "true");
      await expectShell(page);
      expect(external).toEqual([]);
    } finally {
      await page.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
