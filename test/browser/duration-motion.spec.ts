import { openPreviewTools } from "./helpers.ts";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

const storageKey = "gridlens.preview.duration-motion.v1";
const stateStorageKey = "gridlens.preview.state-motion.v1";
const externalRequests: string[] = [];
const providerRequests: string[] = [];
const browserErrors: string[] = [];
let addressRequests = 0;

function control(page: Page): Locator {
  return page.getByLabel("Duration animation", { exact: true });
}

function cell(page: Page, number = 1): Locator {
  return page.locator(`#fleet-rows [data-host="sample-host-${number}-1"] td[data-col="duration"]`);
}

function fill(page: Page, number = 1): Locator {
  return cell(page, number).locator(".duration-fill");
}

async function glareStyle(element: Locator) {
  return element.evaluate(target => {
    const style = getComputedStyle(target, "::after");
    return { animation: style.animationName, content: style.content, left: style.left,
      duration: style.animationDuration, delay: style.animationDelay, background: style.backgroundImage };
  });
}

async function expectMoving(element: Locator): Promise<void> {
  const style = await glareStyle(element);
  expect(style.animation).toBe("duration-sweep");
  expect(style.content).toBe('""');
  expect(style.duration).toBe("10s");
  expect(style.background).toContain("rgb(255, 255, 255)");
  expect(await element.evaluate(target => target.getAnimations({ subtree: true }).length)).toBe(1);
}

async function expectStill(element: Locator): Promise<void> {
  const style = await glareStyle(element);
  expect(style.animation).toBe("none");
  expect(style.content).toBe("none");
  expect(await element.evaluate(target => target.getAnimations({ subtree: true }).length)).toBe(0);
}

// Match the brief sweep at 5–10% of its ten-second cycle. Account
// for each host's negative phase offset so pixel checks do not wait ten seconds
// or mistake an advancing but off-bar animation for a painted white glare.
async function setSweepPhase(element: Locator, phaseMs: number): Promise<void> {
  await element.evaluate(async (target, phase) => {
    const animation = target.getAnimations({ subtree: true })[0]!;
    animation.pause();
    await animation.ready;
    const delay = Number(animation.effect!.getTiming().delay);
    animation.currentTime = 10_000 + delay + phase;
  }, phaseMs);
}

test.beforeEach(async ({ context, page }) => {
  externalRequests.length = providerRequests.length = browserErrors.length = 0;
  addressRequests = 0;
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://127.0.0.1:4174") {
      externalRequests.push(url.href);
      return route.abort();
    }
    if (url.pathname === "/preview/hosts.json") addressRequests++;
    if (/^\/preview\/(metadata|node-info|jobs)\.json$/.test(url.pathname)) providerRequests.push(url.pathname);
    return route.continue();
  });
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") browserErrors.push(message.text()); });
});

test.afterEach(() => {
  expect(externalRequests, "Duration motion checks stay isolated from hosts and external services").toEqual([]);
  expect(providerRequests, "Synthetic motion controls must not request provider data").toEqual([]);
  expect(browserErrors).toEqual([]);
});

test("default On paints the reference white glare on green and red bars even with reduced motion", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?scenario=durations");
  await openPreviewTools(page);
  await expect(control(page)).toHaveValue("on");
  await expect(page.locator("html")).toHaveAttribute("data-duration-motion", "on");
  // The red example is six minutes over its ten-minute limit, beyond the
  // five-minute grace period; the reference glare still paints both tones.
  await expect(cell(page, 2)).toHaveAttribute("data-duration-tone", "exceeded");
  await expect(cell(page, 2)).toHaveAttribute("data-duration-freshness", "current");
  await expect(cell(page, 2).getByRole("button")).toHaveAccessibleName(/16m \/ 10m/);
  await expect(fill(page)).toHaveCSS("background-color", "rgb(74, 222, 128)");
  await expect(fill(page, 2)).toHaveCSS("background-color", "rgb(239, 68, 68)");
  expect(await fill(page, 2).evaluate(element => (element as HTMLElement).style.width)).toBe("100%");
  for (const number of [1, 2]) {
    const bar = fill(page, number);
    await expectMoving(bar);
    const delay = (await glareStyle(bar)).delay;
    await setSweepPhase(bar, 1_250);
    const withoutGlare = await bar.screenshot({ animations: "allow" });
    await setSweepPhase(bar, 750);
    expect(Number.parseFloat((await glareStyle(bar)).left)).toBeCloseTo(0, 1);
    const withGlare = await bar.screenshot({ animations: "allow" });
    expect(withGlare.equals(withoutGlare), `Duration bar ${number} must paint a visible white sweep`).toBe(false);
    expect((await glareStyle(bar)).delay).toBe(delay);
    await info.attach(`duration-${number}-without-glare`, { body: withoutGlare, contentType: "image/png" });
    await info.attach(`duration-${number}-with-glare`, { body: withGlare, contentType: "image/png" });
  }
  await expect(cell(page).locator(".duration-track")).toHaveCSS("height", "8px");
  await expect(cell(page, 2).locator(".duration-track")).toHaveCSS("height", "12px");
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
});

test("the sweep naturally advances without replacing its connected bar or animation", async ({ page }) => {
  await page.goto("/?scenario=durations");
  await openPreviewTools(page);
  const bar = fill(page, 2);
  await expectMoving(bar);
  await setSweepPhase(bar, 550);
  const saved = await bar.evaluateHandle(target => ({ target, animation: target.getAnimations({ subtree: true })[0]! }));
  const before = await saved.evaluate(kept => {
    kept.animation.play();
    return { time: Number(kept.animation.currentTime), left: getComputedStyle(kept.target, "::after").left };
  });
  await expect.poll(() => saved.evaluate((kept, first) => ({
    advanced: Number(kept.animation.currentTime) > first.time,
    moved: getComputedStyle(kept.target, "::after").left !== first.left,
    connected: kept.target.isConnected,
    sameAnimation: kept.target.getAnimations({ subtree: true })[0] === kept.animation,
  }), before)).toEqual({ advanced: true, moved: true, connected: true, sameAnimation: true });
  await cell(page, 2).getByRole("button").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toContainText("EXCEEDED");
  await page.keyboard.press("Escape");
  await expect(cell(page, 2).getByRole("button")).toBeFocused();
  expect(await saved.evaluate(kept => kept.target.getAnimations({ subtree: true })[0] === kept.animation)).toBe(true);
});

test("keyboard On, Off and System preserve bars, evidence and focus without requesting data", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?scenario=durations");
  await openPreviewTools(page);
  await expectMoving(fill(page));
  const initialAddressRequests = addressRequests;
  const saved = await page.locator("#fleet-rows").evaluateHandle(table => ({
    table, rows: [...table.children], bars: [...table.querySelectorAll(".duration-fill")],
    markup: table.innerHTML, clock: document.querySelector("#sample-clock")!.textContent,
    mutations: [] as string[], observer: new MutationObserver(() => {}),
  }));
  await saved.evaluate(kept => {
    kept.observer = new MutationObserver(records => kept.mutations.push(...records.map(record => record.type)));
    kept.observer.observe(kept.table, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  await control(page).focus();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(control(page)).toHaveValue("off");
  await expect(control(page)).toBeFocused();
  await expectStill(fill(page));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expectStill(fill(page));
  await control(page).selectOption("system");
  await expectMoving(fill(page));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expectStill(fill(page));
  await control(page).focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await expect(control(page)).toHaveValue("on");
  await expect(control(page)).toBeFocused();
  await expectMoving(fill(page));
  expect(await saved.evaluate(kept => {
    kept.observer.disconnect();
    return {
      sameTable: document.querySelector("#fleet-rows") === kept.table,
      sameRows: kept.rows.every((row, index) => row.isConnected && kept.table.children[index] === row),
      sameBars: kept.bars.every((bar, index) => bar.isConnected && kept.table.querySelectorAll(".duration-fill")[index] === bar),
      sameMarkup: kept.table.innerHTML === kept.markup,
      sameClock: document.querySelector("#sample-clock")!.textContent === kept.clock,
      mutations: kept.mutations,
    };
  })).toEqual({ sameTable: true, sameRows: true, sameBars: true, sameMarkup: true, sameClock: true, mutations: [] });
  expect(addressRequests).toBe(initialAddressRequests);
});

test("saved Duration motion is independent of State and bar/text mode, with invalid input defaulting to On", async ({ page }) => {
  await page.goto("/?scenario=durations");
  await openPreviewTools(page);
  await page.getByLabel("State animation", { exact: true }).selectOption("off");
  await page.getByRole("button", { name: "Toggle Duration display", exact: true }).click();
  for (const mode of ["off", "system", "on"]) {
    await control(page).selectOption(mode);
    expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(mode);
    await page.reload();
    await openPreviewTools(page);
    await expect(control(page)).toHaveValue(mode);
    await expect(page.locator("html")).toHaveAttribute("data-duration-motion", mode);
    await expect(page.getByLabel("State animation", { exact: true })).toHaveValue("off");
    await expect(page.getByRole("button", { name: "Toggle Duration display", exact: true })).toHaveAttribute("data-mode", "text");
  }
  expect(await page.evaluate(key => localStorage.getItem(key), stateStorageKey)).toBe("off");
  await page.evaluate(key => localStorage.setItem(key, "unrecognized-value"), storageKey);
  await page.reload();
  await openPreviewTools(page);
  await expect(control(page)).toHaveValue("on");
  await page.getByRole("button", { name: "Toggle Duration display", exact: true }).click();
  await expectMoving(fill(page));
  await page.getByLabel("Scenario", { exact: true }).selectOption("states");
  expect(await page.locator(".node-state-art *").evaluateAll(elements => elements.every(element =>
    getComputedStyle(element).animationName === "none",
  ))).toBe(true);
  await expect(control(page)).toHaveValue("on");
});

test("denied storage leaves a working Duration motion control and defaults to On", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() { throw new DOMException("Storage denied by isolated test", "SecurityError"); },
    });
  });
  await page.goto("/?scenario=durations");
  await openPreviewTools(page);
  await expect(control(page)).toHaveValue("on");
  await expectMoving(fill(page));
  await control(page).selectOption("off");
  await expectStill(fill(page));
  await control(page).selectOption("on");
  await expectMoving(fill(page));
  await page.reload();
  await openPreviewTools(page);
  await expect(control(page)).toHaveValue("on");
  await expectMoving(fill(page));
});

test("no animation choice can revive stale, conflicting or unbounded jobs", async ({ page }) => {
  await page.goto("/?scenario=durations");
  await openPreviewTools(page);
  for (const mode of ["on", "off", "system"]) {
    await control(page).selectOption(mode);
    for (const number of [4, 5, 8, 9]) {
      await expectStill(fill(page, number));
      await expect(fill(page, number)).toHaveCSS("background-color", "rgb(119, 119, 119)");
    }
  }
  await control(page).selectOption("on");
  await expectMoving(fill(page));
  await page.getByRole("button", { name: "Advance 30s", exact: true }).click();
  await page.getByRole("button", { name: "Advance 30s", exact: true }).click();
  for (const mode of ["on", "off", "system"]) {
    await control(page).selectOption(mode);
    await expectStill(fill(page));
    await expectStill(fill(page, 2));
    await expect(fill(page)).toHaveCSS("background-color", "rgb(119, 119, 119)");
  }
  await control(page).selectOption("on");
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expectStill(fill(page));
  await page.getByRole("button", { name: "Reset sample", exact: true }).click();
  await expectMoving(fill(page));
});
