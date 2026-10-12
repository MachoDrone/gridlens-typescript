import { openPreviewTools } from "./helpers.ts";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

const storageKey = "gridlens.preview.state-motion.v1";
const externalRequests: string[] = [];
const providerRequests: string[] = [];
const browserErrors: string[] = [];
let addressRequests = 0;
const artwork = [
  { kind: "running", moving: ".state-running-ring" },
  { kind: "queued", moving: ".state-queued-ring" },
  { kind: "starting", moving: ".state-dots" },
  { kind: "restarting", moving: ".state-dots" },
  { kind: "unknown", moving: ".state-dots" },
] as const;

function control(page: Page): Locator {
  return page.getByLabel("State animation", { exact: true });
}

function icon(page: Page, kind: string): Locator {
  const state = kind === "running" ? "RUNNING_JOB" : kind === "unknown" ? "unknown" : kind.toUpperCase();
  return page.locator(`#fleet-rows td[data-col="state"][data-state="${state}"] .node-state-art`);
}

async function motionFrame(moving: Locator) {
  return moving.evaluate(element => {
    const animation = element.getAnimations()[0];
    const style = getComputedStyle(element);
    return {
      time: typeof animation?.currentTime === "number" ? animation.currentTime : null,
      animationName: style.animationName,
      geometry: `${style.strokeDashoffset};${style.transform}`,
    };
  });
}

async function expectMoving(page: Page): Promise<void> {
  for (const { kind, moving } of artwork) {
    const element = icon(page, kind).locator(moving);
    await expect(element).not.toHaveCSS("animation-name", "none");
    const before = await motionFrame(element);
    expect(before.time).not.toBeNull();
    await expect.poll(async () => {
      const after = await motionFrame(element);
      return after.time !== null && after.time > before.time! && after.geometry !== before.geometry;
    }, { message: `${kind} must change rendered geometry as its timeline advances` }).toBe(true);
  }
}

async function expectStill(page: Page): Promise<void> {
  for (const { kind } of artwork) {
    await expect(icon(page, kind)).toBeVisible();
    expect(await icon(page, kind).locator("*").evaluateAll(elements => elements.every(element =>
      getComputedStyle(element).animationName === "none" && element.getAnimations().length === 0,
    ))).toBe(true);
  }
}

test.beforeEach(async ({ context, page }) => {
  externalRequests.length = providerRequests.length = browserErrors.length = 0;
  addressRequests = 0;
  // These scenarios have a paused sample clock and never request provider data.
  // The startup address snapshot is an isolated test file, not the real list.
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://127.0.0.1:4174") {
      externalRequests.push(url.href);
      return route.abort();
    }
    if (url.pathname === "/preview/hosts.json") addressRequests++;
    if (/^\/preview\/(metadata|node-info)\.json$/.test(url.pathname)) providerRequests.push(url.pathname);
    return route.continue();
  });
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") browserErrors.push(message.text()); });
});

test.afterEach(() => {
  expect(externalRequests, "Motion checks must never access hosts or external services").toEqual([]);
  expect(providerRequests, "Sample motion controls must not read provider endpoints").toEqual([]);
  expect(browserErrors).toEqual([]);
});

test("default On visibly animates useful and dim unknown State artwork despite reduced motion", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?scenario=states");
  await openPreviewTools(page);
  await expect(control(page)).toHaveValue("on");
  await expect(page.locator("html")).toHaveAttribute("data-state-motion", "on");
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  await expectMoving(page);
  for (const kind of ["starting", "restarting"]) await expect(icon(page, kind)).toHaveCSS("color", "rgb(245, 158, 11)");
  await expect(icon(page, "unknown")).toHaveCSS("color", "rgb(99, 64, 6)");
  await expect(icon(page, "unknown").locator("..")).toHaveAccessibleName(/unknown/i);
  await expect(icon(page, "unknown").locator("..")).not.toHaveAccessibleName(/STARTING|RESTARTING/);
  await expect(icon(page, "unknown").locator(".state-dots > span")).toHaveCount(4);
  await expect(page.locator('#fleet-rows td[data-col="state"][data-state="unknown"]')).toHaveAttribute("data-state-current", "false");

  // Advancing animation clocks alone are insufficient: capture the actual icon
  // pixels twice and require changed frames while the OS preference stays reduced.
  for (const { kind } of artwork) {
    const before = await icon(page, kind).screenshot({ animations: "allow" });
    let after = before;
    await expect.poll(async () => {
      after = await icon(page, kind).screenshot({ animations: "allow" });
      return after.equals(before);
    }, { message: `${kind} must paint visibly different frames` }).toBe(false);
    await info.attach(`${kind}-before`, { body: before, contentType: "image/png" });
    await info.attach(`${kind}-after`, { body: after, contentType: "image/png" });
  }
});

test("keyboard On, Off and System changes preserve table artwork and evidence without requesting data", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?scenario=states");
  await openPreviewTools(page);
  await expectMoving(page);
  const initialAddressRequests = addressRequests;
  const retained = await page.locator("#fleet-rows").evaluateHandle(table => ({
    table,
    rows: [...table.children],
    icons: [...table.querySelectorAll(".node-state-art")],
    markup: table.innerHTML,
    sampleClock: document.querySelector("#sample-clock")!.textContent,
    changes: [] as string[],
    observer: new MutationObserver(() => {}),
  }));
  await retained.evaluate(saved => {
    saved.observer = new MutationObserver(records => saved.changes.push(...records.map(record => record.type)));
    saved.observer.observe(saved.table, { childList: true, subtree: true, attributes: true, characterData: true });
  });
  await control(page).focus();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(control(page)).toHaveValue("off");
  await expect(control(page)).toBeFocused();
  await expectStill(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expectStill(page);
  await control(page).selectOption("system");
  await expectMoving(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expectStill(page);
  await control(page).focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await expect(control(page)).toHaveValue("on");
  await expectMoving(page);
  expect(await retained.evaluate(saved => {
    saved.observer.disconnect();
    return {
      sameTable: document.querySelector("#fleet-rows") === saved.table,
      sameRows: saved.rows.every((row, index) => row.isConnected && saved.table.children[index] === row),
      sameIcons: saved.icons.every((icon, index) => icon.isConnected && saved.table.querySelectorAll(".node-state-art")[index] === icon),
      sameMarkup: saved.table.innerHTML === saved.markup,
      sameSampleClock: document.querySelector("#sample-clock")!.textContent === saved.sampleClock,
      mutations: saved.changes,
    };
  })).toEqual({ sameTable: true, sameRows: true, sameIcons: true, sameMarkup: true, sameSampleClock: true, mutations: [] });
  expect(addressRequests).toBe(initialAddressRequests);
});

test("saved modes survive reload and invalid saved input falls back to usable On", async ({ page }) => {
  await page.goto("/?scenario=states");
  await openPreviewTools(page);
  for (const mode of ["off", "system", "on"]) {
    await control(page).selectOption(mode);
    expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(mode);
    await page.reload();
    await openPreviewTools(page);
    await expect(control(page)).toHaveValue(mode);
    await expect(page.locator("html")).toHaveAttribute("data-state-motion", mode);
  }
  await page.evaluate(key => localStorage.setItem(key, "unrecognized-value"), storageKey);
  await page.reload();
  await openPreviewTools(page);
  await expect(control(page)).toHaveValue("on");
  await expectMoving(page);
  await control(page).selectOption("off");
  await expectStill(page);
});

test("denied localStorage defaults to On and controls remain usable", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() { throw new DOMException("Storage denied by isolated test", "SecurityError"); },
    });
  });
  await page.goto("/?scenario=states");
  await openPreviewTools(page);
  await expect(control(page)).toHaveValue("on");
  await expectMoving(page);
  await control(page).selectOption("off");
  await expectStill(page);
  await control(page).selectOption("on");
  await expectMoving(page);
  await page.reload();
  await openPreviewTools(page);
  await expect(control(page)).toHaveValue("on");
});

test("retained State stays dim while On, Off and System continue to control its animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?scenario=states");
  await openPreviewTools(page);
  await expectMoving(page);
  await page.getByRole("button", { name: "Advance 30s", exact: true }).click();
  const colors = { running: "rgb(36, 78, 148)", queued: "rgb(40, 122, 71)", starting: "rgb(139, 89, 6)", restarting: "rgb(139, 89, 6)", unknown: "rgb(99, 64, 6)" };
  for (const mode of ["on", "off", "system"]) {
    await control(page).selectOption(mode);
    if (mode === "on") await expectMoving(page);
    else await expectStill(page);
    for (const { kind } of artwork) {
      await expect(icon(page, kind)).toHaveCSS("color", colors[kind]);
      await expect(icon(page, kind).locator("..")).toHaveAccessibleName(kind === "unknown" ? /unknown/i : /stale|retained/i);
    }
  }
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expectMoving(page);
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expectMoving(page);
  await page.getByRole("button", { name: "Reset sample", exact: true }).click();
  await expectMoving(page);
});

test("explicit State motion does not override reduced motion for Duration artwork", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?scenario=durations");
  await openPreviewTools(page);
  await page.getByLabel("Duration animation", { exact: true }).selectOption("system");
  await expect(control(page)).toHaveValue("on");
  // This scenario has no Node Info at all; the same dim spinner and motion
  // preference apply without inventing OTHER, restart activity or a request.
  const missing = page.locator('.state-unknown .state-dots').first();
  await expect(missing).toBeVisible();
  await expect(missing).toHaveCSS("color", "rgb(99, 64, 6)");
  await expect(missing).not.toHaveCSS("animation-name", "none");
  await control(page).selectOption("off");
  await expect(missing).toHaveCSS("animation-name", "none");
  await control(page).selectOption("system");
  await expect(missing).toHaveCSS("animation-name", "none");
  await control(page).selectOption("on");
  await expect(missing).not.toHaveCSS("animation-name", "none");
  const fill = page.locator(".duration-fill.duration-active").first();
  await expect(fill).toBeVisible();
  expect(await fill.evaluate(element => ({
    animation: getComputedStyle(element, "::after").animationName,
    content: getComputedStyle(element, "::after").content,
  }))).toEqual({ animation: "none", content: "none" });
});
