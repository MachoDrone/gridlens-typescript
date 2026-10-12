import { expect, test } from "@playwright/test";
import type { CDPSession, Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { setBrowserPinchScale } from "./viewport-input.ts";

// Settled DOM bounds miss the compositor panning ahead of JavaScript. Read the
// actual painted surfaces from native-scroll frames, including a busy main thread.
test.use({ isMobile: true, hasTouch: true, deviceScaleFactor: 2, trace: "off" });

type Frame = { data: string; timestamp: number; scrollX: number; scrollY: number };
type Bounds = { left: number; top: number; right: number; bottom: number };
type PaintedFrame = { width: number; height: number; sidebar: Bounds | null; header: Bounds | null; heading: Bounds | null };

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function pinchOut(page: Page, session: CDPSession, target: number): Promise<number> {
  const width = page.viewportSize()!.width;
  let scale = await page.evaluate(() => visualViewport!.scale);
  const points = (spread: number) => [
    { id: 0, x: width * .64 / scale, y: (456 - spread) / scale },
    { id: 1, x: width * .64 / scale, y: (456 + spread) / scale },
  ];
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(160) });
  for (let step = 1; step <= 24; step++) {
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(160 - 150 * step / 24) });
    await settle(page);
    scale = await page.evaluate(() => visualViewport!.scale);
    if (scale <= target) break;
  }
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await settle(page);
  await page.waitForTimeout(150);
  return page.evaluate(() => visualViewport!.scale);
}

async function position(page: Page) {
  return page.evaluate(() => ({
    x: visualViewport!.pageLeft + document.querySelector(".fleet-table-wrap")!.scrollLeft,
    y: visualViewport!.pageTop,
  }));
}

async function recordPan(page: Page, session: CDPSession, axis: "x" | "y") {
  const scale = await page.evaluate(() => visualViewport!.scale), width = page.viewportSize()!.width;
  const before = await position(page), frames: Frame[] = [];
  const listener = (event: { data: string; sessionId: number; metadata: { timestamp?: number; scrollOffsetX: number; scrollOffsetY: number } }) => {
    frames.push({ data: event.data, timestamp: event.metadata.timestamp ?? 0,
      scrollX: event.metadata.scrollOffsetX, scrollY: event.metadata.scrollOffsetY });
    void session.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
  };
  session.on("Page.screencastFrame", listener);
  await session.send("Page.startScreencast", { format: "png", maxWidth: width, maxHeight: 844, everyNthFrame: 1 });
  const points = (fraction: number) => [{ id: 0,
    x: (width * .88 - (axis === "x" ? width * .48 * fraction : 0)) / scale,
    y: (650 - (axis === "y" ? 420 * fraction : 0)) / scale }];
  try {
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(0) });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(.08) });
    await page.waitForTimeout(50);
    await page.evaluate(() => {
      const root = document.documentElement;
      root.removeAttribute("data-test-pressure-ms");
      setTimeout(() => {
        const start = performance.now();
        while (performance.now() - start < 700) { /* Deliberate isolated UI pressure. */ }
        root.setAttribute("data-test-pressure-ms", String(performance.now() - start));
      }, 30);
    });
    // Do not wait for input acknowledgments while the renderer is occupied:
    // compositor scrolling and capture must be free to run ahead of the page.
    const pending: Promise<unknown>[] = [];
    for (let step = 1; step <= 12; step++) {
      pending.push(session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(.08 + .92 * step / 12) }));
      await new Promise(resolve => setTimeout(resolve, 35));
    }
    await Promise.all(pending);
    // End at rest so momentum cannot make the next axis's fixture ambiguous.
    await page.waitForTimeout(100);
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(1) });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(150);
  } finally {
    await session.send("Page.stopScreencast");
    session.off("Page.screencastFrame", listener);
  }
  expect(Number(await page.locator("html").getAttribute("data-test-pressure-ms"))).toBeGreaterThanOrEqual(700);
  const after = await position(page);
  expect(after[axis] - before[axis], `Native ${axis}-pan must move the table or document`).toBeGreaterThan(30);
  expect(frames.length, "Motion evidence requires multiple compositor frames").toBeGreaterThan(5);
  return frames;
}

async function paintedFrames(decoder: Page, frames: Frame[]): Promise<PaintedFrame[]> {
  return decoder.evaluate(async images => {
    const canvas = document.createElement("canvas"), context = canvas.getContext("2d", { willReadFrequently: true })!;
    const results = [];
    for (const image of images) {
      const bitmap = new Image();
      bitmap.src = `data:image/png;base64,${image}`;
      await bitmap.decode();
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const surfaces: Record<"sidebar" | "header" | "heading", Bounds | null> = { sidebar: null, header: null, heading: null };
      for (let index = 0; index < pixels.length; index += 4) {
        const r = pixels[index], g = pixels[index + 1], b = pixels[index + 2];
        const name = r === 255 && g === 0 && b === 255 ? "sidebar" :
          r === 0 && g === 255 && b === 255 ? "header" : r === 255 && g === 255 && b === 0 ? "heading" : null;
        if (!name) continue;
        const x = index / 4 % canvas.width, y = Math.floor(index / 4 / canvas.width), previous = surfaces[name];
        if (previous) {
          previous.left = Math.min(previous.left, x); previous.right = Math.max(previous.right, x);
          previous.top = Math.min(previous.top, y); previous.bottom = Math.max(previous.bottom, y);
        } else surfaces[name] = { left: x, top: y, right: x, bottom: y };
      }
      results.push({ width: canvas.width, height: canvas.height, ...surfaces });
    }
    return results;
  }, frames.map(frame => frame.data));
}

const cases = [
  ...[320, 390].flatMap(width => [false, true].flatMap(expanded => [.75, .55].map(target => ({ width, expanded, target, fractional: false })))),
  // This native endpoint leaves a one-CSS-pixel visual pan unless the adopted
  // canvas accounts for Chromium's fractional layout-viewport rounding.
  { width: 390, expanded: false, target: .8133232593536377, fractional: true },
];
for (const { width, expanded, target, fractional } of cases) {
  test(`intermediate phone zoom ${width}px, ${expanded ? "expanded" : "collapsed"} menu, ${fractional ? "fractional endpoint" : `${target} scale`} keeps navigation painted during both-axis pans`, async ({ page, context }, info) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 844 });
    const unexpected: string[] = [];
    const origin = new URL(info.project.use.baseURL!).origin;
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { unexpected.push(url.href); return route.abort(); }
      return route.continue();
    });
    await page.addInitScript(value => localStorage.setItem("gridlens.preview.sidebar.v1", value ? "expanded" : "collapsed"), expanded);
    await page.goto("/?scenario=scale");
    await expect(page.locator("#host-count")).toHaveText("200 hosts");
    await page.waitForTimeout(350);
    const session = await context.newCDPSession(page), baseline = await page.evaluate(() => visualViewport!.scale);
    let scale = await pinchOut(page, session, baseline * (fractional ? .55 : target));
    if (fractional) {
      // First enter overview with moving native fingers, then choose the exact
      // troublesome fractional endpoint using the shared trusted pinch cue.
      await setBrowserPinchScale(page, session, baseline * target);
      await page.waitForTimeout(350);
      scale = await page.evaluate(() => visualViewport!.scale);
    }
    expect(scale / baseline).toBeLessThan(fractional ? .9 : .8);
    expect(scale / baseline).toBeGreaterThan(.4);
    await page.evaluate(() => {
      document.querySelector<HTMLElement>("#sidebar")!.style.setProperty("background", "rgb(255, 0, 255)", "important");
      document.querySelector<HTMLElement>(".fleet-title-row")!.style.setProperty("background", "rgb(0, 255, 255)", "important");
      for (const cell of document.querySelectorAll<HTMLElement>("thead th")) cell.style.setProperty("background", "rgb(255, 255, 0)", "important");
      scrollTo(0, 800);
    });
    await settle(page);
    await page.waitForTimeout(100);
    const recordings: { axis: "x" | "y"; frames: Frame[] }[] = [];
    const residualPans: { axis: "x" | "y"; left: number; top: number }[] = [];
    for (const axis of ["x", "y"] as const) {
      recordings.push({ axis, frames: await recordPan(page, session, axis) });
      residualPans.push({ axis, ...await page.evaluate(() => ({ left: visualViewport!.offsetLeft, top: visualViewport!.offsetTop })) });
    }
    const decoder = await context.newPage();
    const motionFailures: { axis: "x" | "y"; frames: number; first: unknown }[] = [];
    try {
      for (const { axis, frames } of recordings) {
        const painted = await paintedFrames(decoder, frames);
        const failures = painted.flatMap((frame, index) => {
          const { sidebar, header, heading } = frame;
          const missing = !sidebar || !header || !heading;
          const drift = missing ? Number.POSITIVE_INFINITY : Math.max(
            Math.abs(sidebar.left), Math.abs(sidebar.top), Math.abs(sidebar.bottom + 1 - frame.height),
            Math.abs(header.top), Math.abs(header.left - sidebar.right - 1), Math.abs(header.right + 1 - frame.width),
            Math.abs(heading.top - header.bottom - 1),
          );
          return drift > 2 ? [{ index, drift, painted: frame, timestamp: frames[index]!.timestamp }] : [];
        });
        const evidence = info.outputPath(`${axis}-pan-compositor-bounds.json`);
        await writeFile(evidence, JSON.stringify({ scale, painted,
          frames: frames.map(({ data: _data, ...frame }) => frame), failures }, null, 2));
        await info.attach(`${axis}-pan-compositor-bounds`, { contentType: "application/json", path: evidence });
        if (failures[0]) {
          const screenshot = info.outputPath(`${axis}-pan-first-navigation-gap.png`);
          await writeFile(screenshot, Buffer.from(frames[failures[0].index]!.data, "base64"));
          await info.attach(`${axis}-pan-first-navigation-gap`, { contentType: "image/png", path: screenshot });
        }
        if (failures.length) motionFailures.push({ axis, frames: failures.length, first: failures[0] });
      }
    } finally { await decoder.close(); }
    expect(motionFailures, "Every captured pan frame must retain full-height navigation and the pinned headings").toEqual([]);
    if (fractional) {
      const evidence = info.outputPath("fractional-native-pan-origins.json");
      await writeFile(evidence, JSON.stringify({ scale, residualPans }, null, 2));
      await info.attach("fractional-native-pan-origins", { contentType: "application/json", path: evidence });
      expect(residualPans.map(({ left, top }) => Math.max(Math.abs(left), Math.abs(top))),
        "Fractional overview must not leave even a one-pixel visual pan for JavaScript to chase on every scroll").toEqual([0, 0]);
    }
    expect(unexpected).toEqual([]);
  });
}
