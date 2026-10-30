import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { UpdateOperation, UpdateStatus } from "../../src/contracts/updates.ts";

const oldBuild = { version: "0.1.0-dev.9", sequence: 9, buildId: "9:0.1.0-dev.9" };
const newBuild = { version: "0.1.0-dev.10", sequence: 10, buildId: "10:0.1.0-dev.10" };
const candidate = { ...newBuild, id: "a".repeat(64), sizeBytes: 10_000_000 };
function initialStatus(): UpdateStatus {
  return { version: 1, supported: true, canUpdate: true, checking: false, current: oldBuild, candidate,
    checkedAtMs: Date.now() - 1000, nextCheckAtMs: Date.now() + 60_000, checkError: null, operation: null };
}
function operation(phase: UpdateOperation["phase"] = "downloading"): UpdateOperation {
  const now = Date.now();
  return { id: "test-operation", revision: 1, target: newBuild, previous: oldBuild, phase,
    startedAtMs: now, updatedAtMs: now, downloadedBytes: 2_500_000, totalBytes: 10_000_000, error: null,
    result: phase === "complete" ? newBuild : phase === "rolled-back" ? oldBuild : null };
}
interface Mode {
  enabled: boolean; status: UpdateStatus; loadedBuild: string; documents: number; reads: number;
  starts: unknown[]; checks: number; unreachable: boolean; loseStartResponse: boolean; mainUnavailable: boolean;
  checkStatus: number; metadataReady: boolean; metadataWaiters: (() => void)[];
}
async function fixture(page: Page): Promise<Mode> {
  const mode: Mode = { enabled: true, status: initialStatus(), loadedBuild: oldBuild.buildId,
    documents: 0, reads: 0, starts: [], checks: 0, unreachable: false, loseStartResponse: false,
    mainUnavailable: false, checkStatus: 200, metadataReady: true, metadataWaiters: [] };
  await page.clock.install();
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== "http://127.0.0.1:4174") throw new Error("External request in isolated update test.");
    if (request.resourceType() === "document") {
      mode.documents++;
      const response = await route.fetch(); let body = await response.text();
      if (mode.enabled) body = body.replace("</head>", `<meta name="gridlens-shared-backend" content="1">
        <meta name="gridlens-updates" content="1"><meta name="gridlens-build-id" content="${mode.loadedBuild}">
        <meta name="gridlens-api-base" content="/api/fleet"><meta name="gridlens-source-mode" content="snapshot"></head>`);
      await route.fulfill({ response, body }); return;
    }
    if (url.pathname === "/preview/main.js" && mode.mainUnavailable) { await route.fulfill({ status: 503, body: "unavailable" }); return; }
    if (url.pathname.startsWith("/api/shared/updates")) {
      if (mode.unreachable) { await route.abort("connectionrefused"); return; }
      if (url.pathname.endsWith("/start")) {
        mode.starts.push(request.postDataJSON()); mode.status.operation = operation();
        if (mode.loseStartResponse) { await route.abort("connectionreset"); return; }
      } else if (url.pathname.endsWith("/check")) {
        mode.checks++;
        if (mode.checkStatus !== 200) { await route.fulfill({ status: mode.checkStatus, json: { error: "private diagnostic" } }); return; }
      } else mode.reads++;
      await route.fulfill({ json: mode.status }); return;
    }
    if (url.pathname.startsWith("/api/shared/")) { await route.fulfill({ status: 401, json: {} }); return; }
    if (url.pathname.startsWith("/api/fleet/")) {
      if (url.pathname.endsWith("/hosts.json")) { await route.fulfill({ json: { addresses: [], error: null } }); return; }
      if (url.pathname.endsWith("/connection.json")) { await route.fulfill({ json: { status: "ok" } }); return; }
      if (url.pathname.endsWith("/metadata.json") && !mode.metadataReady) await new Promise<void>(resolve => mode.metadataWaiters.push(resolve));
      await route.fulfill({ json: { hosts: [] } }); return;
    }
    await route.continue();
  });
  return mode;
}
async function poll(page: Page): Promise<void> { await page.clock.fastForward(2100); }

for (const width of [1280, 390, 320]) test(`Update preserves the narrow menu and collapsed icon at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await page.addInitScript(() => localStorage.setItem("gridlens.preview.sidebar.v1", "expanded"));
  const mode = await fixture(page); mode.enabled = false;
  await page.goto("/?scenario=mixed");
  await expect(page.locator("#sidebar-update")).toBeHidden();
  const before = (await page.locator("#sidebar").boundingBox())!.width;
  mode.enabled = true; await page.reload();
  const update = page.getByRole("button", { name: "Update available", exact: true });
  await expect(update).toBeVisible();
  await expect.poll(async () => Math.abs((await page.locator("#sidebar").boundingBox())!.width - before)).toBeLessThanOrEqual(1);
  await expect(update.locator(".sidebar-label")).toBeVisible();
  expect(await update.locator(".sidebar-label").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(update.locator("svg")).toHaveCSS("color", "rgb(16, 232, 12)");
  await expect(update.locator("svg")).toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(update.locator("svg")).toHaveCSS("animation-name", "update-available");
  await page.getByRole("button", { name: "Collapse menu", exact: true }).click();
  await expect(update.locator(".sidebar-label")).toBeHidden();
  await expect.poll(async () => (await page.locator("#sidebar").boundingBox())!.width).toBeLessThanOrEqual(56.1);
  const icon = (await update.locator("svg").boundingBox())!, rail = (await page.locator("#sidebar").boundingBox())!;
  expect(icon.x).toBeGreaterThanOrEqual(rail.x); expect(icon.x + icon.width).toBeLessThanOrEqual(rail.x + rail.width);
  await update.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "GridLens Update" })).toBeVisible();
  await expect(page.locator("#update-installed")).toHaveText(oldBuild.version);
  await expect(page.locator("#update-available")).toHaveText(newBuild.version);
  await page.getByRole("button", { name: "Close update" }).click();
  expect(mode.starts).toHaveLength(0);
});

test("one Update now action retains progress through restart and returns only after the new Fleet renders", async ({ page }) => {
  const mode = await fixture(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Update available" }).click();
  await page.getByRole("button", { name: "Update now", exact: true }).click();
  await expect(page.locator("#update-status")).toHaveText("Downloading update");
  await expect(page.locator("#update-transfer")).toContainText("25%");
  await expect(page.locator("#update-elapsed")).toContainText("Elapsed");
  await page.clock.fastForward(35_000);
  await expect(page.locator("#update-retry-fleet")).toBeHidden();
  await expect(page.locator("#update-error")).toBeHidden();
  expect(mode.starts).toHaveLength(1);
  expect(mode.starts[0]).toEqual({ candidateId: candidate.id, idempotencyKey: expect.stringMatching(/^[a-f0-9-]{36}$/) });
  mode.status.operation = { ...mode.status.operation!, revision: 2, phase: "restarting" };
  mode.unreachable = true; await poll(page);
  await expect(page.locator("#update-status")).toContainText("Reconnecting");
  await expect(page.locator("#update-retry-fleet")).toBeHidden();
  expect(mode.documents).toBe(1);
  mode.unreachable = false; mode.loadedBuild = newBuild.buildId; mode.metadataReady = false;
  mode.status = { ...mode.status, current: newBuild, candidate: null, operation: { ...mode.status.operation!, revision: 3, phase: "complete", result: newBuild } };
  await poll(page);
  await expect.poll(() => mode.documents).toBe(2);
  await expect(page.locator("#update-dialog")).toBeVisible();
  await expect(page.locator("#update-status")).toHaveText("Checking Fleet");
  expect(mode.starts).toHaveLength(1);
  mode.metadataReady = true; mode.metadataWaiters.splice(0).forEach(resolve => resolve());
  await expect(page.locator("html")).toHaveAttribute("data-gridlens-fleet-ready", newBuild.buildId);
  await expect(page.locator("#update-dialog")).not.toBeVisible();
  await page.clock.fastForward(60_100);
  expect(mode.documents).toBe(2);
});

test("lost start response and reload rejoin one durable operation without another install request", async ({ page }) => {
  const mode = await fixture(page); mode.loseStartResponse = true;
  await page.goto("/"); await page.getByRole("button", { name: "Update available" }).click();
  await page.getByRole("button", { name: "Update now", exact: true }).click();
  await expect(page.locator("#update-error")).toContainText("may have been accepted");
  await poll(page);
  await expect(page.locator("#update-status")).toHaveText("Downloading update");
  await page.getByRole("button", { name: "Close update" }).click(); await poll(page);
  await expect(page.locator("#update-dialog")).not.toBeVisible();
  await page.reload();
  await expect(page.locator("#update-dialog")).toBeVisible();
  await expect(page.locator("#update-status")).toHaveText("Downloading update");
  expect(mode.starts).toHaveLength(1);
});

test("failed release check retains the verified notification and viewers cannot start an update", async ({ page }) => {
  const mode = await fixture(page); mode.checkStatus = 429;
  await page.goto("/"); await page.getByRole("button", { name: "Update available" }).click();
  await page.getByRole("button", { name: "Check for updates", exact: true }).click();
  await expect(page.locator("#update-error")).toContainText("retry schedule");
  await expect(page.locator("#update-error")).not.toContainText("private diagnostic");
  await expect(page.locator("#sidebar-update")).toHaveAttribute("data-update-state", "available");
  mode.status.canUpdate = false; await poll(page);
  await expect(page.getByRole("button", { name: "Update now", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Check for updates", exact: true })).toBeHidden();
  expect(mode.starts).toHaveLength(0); expect(mode.checks).toBe(1);
});

test("the recovery controller survives a failed Fleet module and never reloads in a loop", async ({ page }) => {
  const mode = await fixture(page);
  mode.status.operation = operation();
  await page.goto("/"); await expect(page.locator("#update-dialog")).toBeVisible();
  mode.status = { ...mode.status, current: newBuild, candidate: null, operation: operation("complete") };
  // A stale HTML response still carries the old build. One reload must not turn into a loop.
  mode.mainUnavailable = true; await poll(page);
  await expect.poll(() => mode.documents).toBe(2);
  await expect(page.locator("#update-error")).toContainText("did not load the installed version");
  await page.clock.fastForward(10_000); expect(mode.documents).toBe(2);
  mode.loadedBuild = newBuild.buildId;
  await page.getByRole("button", { name: "Retry loading Fleet" }).click();
  await expect.poll(() => mode.documents).toBe(3);
  await expect(page.locator("#update-status")).toHaveText("Checking Fleet");
  await expect(page.locator("#update-dialog")).toBeVisible();
  await page.clock.fastForward(30_100);
  await expect(page.locator("#update-error")).toContainText("has not finished loading");
  await expect(page.getByRole("button", { name: "Retry loading Fleet" })).toBeVisible();
  mode.mainUnavailable = false;
  await page.getByRole("button", { name: "Retry loading Fleet" }).click();
  await expect(page.locator("#update-dialog")).not.toBeVisible();
});

test("rollback reloads the original build and revalidates Fleet while preserving its failure notice", async ({ page }) => {
  const mode = await fixture(page); mode.status.operation = operation("rolling-back");
  await page.goto("/"); await expect(page.locator("#update-status")).toHaveText("Restoring previous version");
  await expect(page.locator("html")).toHaveAttribute("data-gridlens-fleet-ready", oldBuild.buildId);
  mode.metadataReady = false;
  mode.status.operation = { ...mode.status.operation!, revision: 2, phase: "rolled-back", result: oldBuild, error: "The new GridLens service could not start." };
  await poll(page);
  await expect.poll(() => mode.documents).toBe(2);
  await expect(page.locator("#update-status")).toHaveText("Checking Fleet");
  mode.metadataReady = true; mode.metadataWaiters.splice(0).forEach(resolve => resolve());
  await expect(page.locator("#update-status")).toHaveText("Update failed; previous version restored");
  await expect(page.locator("#update-error")).toContainText("could not start");
  await expect(page.locator("#update-dialog")).toBeVisible();
  expect(mode.documents).toBe(2);
});

test("update checks and progress polling pause while hidden and rejoin on return", async ({ page }) => {
  const mode = await fixture(page);
  await page.goto("/"); await page.getByRole("button", { name: "Update available" }).click();
  mode.status.checking = true;
  await page.getByRole("button", { name: "Check for updates", exact: true }).click();
  await expect(page.locator("#update-status")).toHaveText("Checking for updates…");
  await expect(page.locator("#update-check")).toBeDisabled();
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); });
  const reads = mode.reads;
  await page.clock.fastForward(120_000);
  expect(mode.reads).toBe(reads);
  mode.status.checking = false;
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); document.dispatchEvent(new Event("visibilitychange")); });
  await expect.poll(() => mode.reads).toBe(reads + 1);
  await expect(page.locator("#update-status")).toHaveText("A GridLens update is available.");
  expect(mode.checks).toBe(1);
});

for (const width of [320, 390]) test(`touch Update dialog keeps actions reachable through rotation at ${width}px`, async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  const page = await context.newPage();
  try {
    const mode = await fixture(page); await page.goto("http://127.0.0.1:4174/");
    await expect(page.locator("html")).toHaveAttribute("data-sidebar", "collapsed");
    await page.getByRole("button", { name: "Update available" }).tap();
    for (const viewport of [{ width, height: 844 }, { width: 844, height: 390 }, { width: 667, height: 240 }]) {
      await page.setViewportSize(viewport);
      await expect.poll(() => page.locator("#update-dialog").evaluate(element => {
        const box = element.getBoundingClientRect(), view = visualViewport!;
        return box.left >= view.offsetLeft - 1 && box.right <= view.offsetLeft + view.width + 1
          && box.top >= view.offsetTop - 1 && box.bottom <= view.offsetTop + view.height + 1;
      })).toBe(true);
      await expect(page.getByRole("button", { name: "Close update" })).toBeVisible();
      await page.getByRole("button", { name: "Update now", exact: true }).scrollIntoViewIfNeeded();
      await expect(page.getByRole("button", { name: "Update now", exact: true })).toBeInViewport();
    }
    await page.getByRole("button", { name: "Update now", exact: true }).tap();
    await expect(page.locator("#update-status")).toHaveText("Downloading update");
    expect(mode.starts).toHaveLength(1);
    await page.getByRole("button", { name: "Close update" }).tap();
    await expect(page.locator("#update-dialog")).not.toBeVisible();
  } finally { await context.close(); }
});
