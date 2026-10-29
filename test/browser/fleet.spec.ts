import { expectFleetDocumentFlow, openPreviewTools } from "./helpers.ts";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { SYNTHETIC_HOST_ADDRESSES } from "../fixtures/host-addresses.ts";

const labels = [
  "Staked NOS", "Status", "PC", "IP", "Host Address", "SOL", "API", "State", "Queued", "Duration",
  "Node run time", "Daily uptime %", "Jobs", "RAM",
  "Disk", "DL", "UL", "Ping", "Rewards to claim", "NOS", "Market",
  "GPU ID", "Current Node", "CUDA", "NVIDIA", "CPU", "System", "Country",
];
const unexpectedRequests: string[] = [];
const browserErrors: string[] = [];

test.beforeEach(async ({ context, page }) => {
  unexpectedRequests.length = 0;
  browserErrors.length = 0;
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).origin !== "http://127.0.0.1:4174") {
      unexpectedRequests.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });
  await page.goto("/?scenario=mixed");
  await openPreviewTools(page);
  await expect(page.locator("#host-count")).toHaveText("6 hosts");
});

test.afterEach(() => {
  expect(unexpectedRequests, "The fixture preview must never contact other services").toEqual([]);
  expect(browserErrors, "No browser runtime or loading errors").toEqual([]);
});

async function scenario(page: Page, id: string): Promise<void> {
  await page.getByLabel("Scenario", { exact: true }).selectOption(id);
}

async function visiblePCs(page: Page): Promise<string[]> {
  return page.locator('#fleet-rows td[data-col="pc"]').allTextContents();
}

const defaultPCs = ["sample-01", "sample-01", "sample-01", "sample-02", "sample-03", "sample-04"];
const descendingPCs = ["sample-04", "sample-03", "sample-02", "sample-01", "sample-01", "sample-01"];
const sortPreferenceKey = "gridlens.preview.sort.v1";
const ipPreferenceKey = "gridlens.preview.ip-mode.v1";
const durationPreferenceKey = "gridlens.preview.duration-mode.v1";
const marketPreferenceKey = "gridlens.preview.market-mode.v1";

function marketCell(page: Page, hostId: string) {
  return page.locator(`#fleet-rows [data-host="${hostId}"] td[data-col="market"]`);
}

test("Market samples are visible immediately and toggle from full names to two characters", async ({ page }, info) => {
  const toggle = page.getByRole("button", { name: "Toggle Market display", exact: true });
  await expect(toggle).toHaveAttribute("data-mode", "full");
  expect(await page.locator('#fleet-rows td[data-col="market"]').allTextContents()).toEqual([
    "amber-demo-4090", "amber-demo-4080", "cobalt-demo-a4000", "maple-demo-3060", "—", "birch-demo-3090",
  ]);
  await page.screenshot({ path: info.outputPath("market-full.png"), fullPage: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute("data-mode", "compact");
  expect(await page.locator('#fleet-rows td[data-col="market"]').allTextContents()).toEqual(["am", "am", "co", "ma", "—", "bi"]);
  await expect(marketCell(page, "sample-host-1-1")).not.toHaveAttribute("title");
  await expect(marketCell(page, "sample-host-1-1").locator(".market-value")).toHaveAttribute("aria-label", /amber-demo-4090/);
  await expect(page.getByRole("button", { name: "Sort by Market", exact: true })).not.toHaveCSS("color", "rgb(248, 113, 113)");
  await expect(page.locator('#column-headings th[data-col="pc"]')).toHaveAttribute("aria-sort", "ascending");
  expect(await visiblePCs(page)).toEqual(defaultPCs);
  await page.screenshot({ path: info.outputPath("market-compact.png"), fullPage: true });
  await toggle.click();
  await expect(marketCell(page, "sample-host-1-1")).toHaveText("amber-demo-4090");
});

test("Market sorting uses full identities even when compact prefixes collide", async ({ page }) => {
  const hostIDs = () => page.locator('#fleet-rows [data-host]').evaluateAll(rows => rows.map(row => row.getAttribute("data-host")));
  const sort = page.getByRole("button", { name: "Sort by Market", exact: true });
  const toggle = page.getByRole("button", { name: "Toggle Market display", exact: true });
  await sort.click();
  const ascending = ["sample-host-1-2", "sample-host-1-1", "sample-host-4-1", "sample-host-1-3", "sample-host-2-1", "sample-host-3-1"];
  expect(await hostIDs()).toEqual(ascending);
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute("data-mode", "compact");
  expect(await hostIDs()).toEqual(ascending);
  await expect(page.locator('#column-headings th[data-col="market"]')).toHaveAttribute("aria-sort", "ascending");
  await sort.click();
  expect(await hostIDs()).toEqual(["sample-host-2-1", "sample-host-1-3", "sample-host-4-1", "sample-host-1-1", "sample-host-1-2", "sample-host-3-1"]);
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("data-mode", "full");
  await expect(page.locator('#column-headings th[data-col="market"]')).toHaveAttribute("aria-sort", "descending");
  await expect(marketCell(page, "sample-host-1-1").locator(".market-value")).toHaveAttribute("aria-label", /amber-demo-4090/);
  await expect(marketCell(page, "sample-host-1-1").getByRole("button")).toHaveCount(0);
  await marketCell(page, "sample-host-1-1").click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByRole("button", { name: "Column info", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveAccessibleName("Market");
  await expect(page.getByRole("dialog")).toContainText("physical GPU");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Column info", exact: true })).toBeFocused();
});

test("Market freshness is independent and display changes never renew its source time", async ({ page }) => {
  const sourceTimes = () => page.locator('#fleet-rows [data-host]').evaluateAll(rows =>
    Object.fromEntries(rows.map(row => [row.getAttribute("data-host"), row.getAttribute("data-market-observed-at")])));
  const originalTimes = await sourceTimes();
  await expect(page.locator('#fleet-rows [data-host="sample-host-1-3"]')).toHaveAttribute("data-freshness", "fresh");
  await expect(marketCell(page, "sample-host-1-3")).toHaveAttribute("data-market-freshness", "retained");
  await expect(page.locator('#fleet-rows [data-host="sample-host-1-3"]')).toHaveAttribute("data-market-observed-at", String(Date.UTC(2026, 0, 1, 11, 57)));
  await expect(marketCell(page, "sample-host-1-3")).not.toHaveAttribute("title");
  await expect(page.locator('#fleet-rows [data-host="sample-host-4-1"]')).toHaveAttribute("data-freshness", "stale");
  await expect(marketCell(page, "sample-host-4-1")).toHaveAttribute("data-market-freshness", "current");
  await expect(marketCell(page, "sample-host-3-1")).toHaveText("—");
  const labelsBefore = await page.locator('#fleet-rows td[data-col="market"]').allTextContents();
  for (let i = 0; i < 2; i++) await page.getByRole("button", { name: "Advance 30s", exact: true }).click();
  await expect(page.locator('#fleet-rows td[data-market-freshness="retained"]')).toHaveCount(5);
  await expect(page.locator('#fleet-rows td[data-market-freshness="unknown"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  expect(await page.locator('#fleet-rows td[data-col="market"]').allTextContents()).toEqual(labelsBefore);
  await page.getByRole("button", { name: "Toggle Market display", exact: true }).click();
  expect(await sourceTimes()).toEqual(originalTimes);
  expect(await page.locator('#fleet-rows td[data-col="gpuID"]').allTextContents()).toEqual(Array(6).fill("—"));
});

test("Market preference persists separately from other displays and supports empty scenarios", async ({ page }) => {
  const toggle = page.getByRole("button", { name: "Toggle Market display", exact: true });
  await toggle.click();
  await page.getByRole("button", { name: "Toggle IP display", exact: true }).click();
  await page.getByRole("button", { name: "Toggle Duration display", exact: true }).click();
  await page.getByRole("button", { name: "Sort by Market", exact: true }).click();
  await page.reload();
  await openPreviewTools(page);
  await expect(toggle).toHaveAttribute("data-mode", "compact");
  await expect(page.getByRole("button", { name: "Toggle IP display", exact: true })).toHaveAttribute("data-mode", "full");
  await expect(page.getByRole("button", { name: "Toggle Duration display", exact: true })).toHaveAttribute("data-mode", "text");
  await expect(page.locator('#column-headings th[data-col="market"]')).toHaveAttribute("aria-sort", "ascending");
  expect(await page.evaluate(key => localStorage.getItem(key), marketPreferenceKey)).toBe("compact");
  await scenario(page, "fresh");
  await expect(toggle).toHaveAttribute("data-mode", "compact");
  await page.getByRole("button", { name: "Clear sort", exact: true }).click();
  await expect(marketCell(page, "sample-host-1-1")).toHaveText("am");
  for (const id of ["empty", "missing"]) {
    await scenario(page, id);
    const message = await page.locator(".empty-message").textContent();
    await toggle.click();
    await expect(page.locator(".empty-message")).toHaveText(message ?? "");
  }
});

test("Market mode tolerates invalid or denied preference storage", async ({ page }) => {
  const toggle = page.getByRole("button", { name: "Toggle Market display", exact: true });
  await page.evaluate(key => localStorage.setItem(key, "invalid"), marketPreferenceKey);
  await page.reload();
  await openPreviewTools(page);
  await expect(toggle).toHaveAttribute("data-mode", "full");
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Storage unavailable", "SecurityError"); } });
  });
  await page.reload();
  await openPreviewTools(page);
  await toggle.click();
  await expect(toggle).toHaveAttribute("data-mode", "compact");
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect(marketCell(page, "sample-host-1-1")).toHaveText("am");
});

function durationCell(page: Page, number: number) {
  return page.locator(`#fleet-rows [data-host="sample-host-${number}-1"] td[data-col="duration"]`);
}

test("Duration defaults to the reference bar and toggles to compact elapsed/limit text", async ({ page }, info) => {
  await scenario(page, "durations");
  const toggle = page.getByRole("button", { name: "Toggle Duration display", exact: true });
  await expect(toggle).toHaveAttribute("data-mode", "bar");
  const track = await durationCell(page, 1).locator(".duration-track").boundingBox();
  expect(track?.width).toBe(30);
  expect(track?.height).toBe(8);
  expect(await durationCell(page, 1).locator(".duration-fill").evaluate(element => (element as HTMLElement).style.width)).toBe("20%");
  await expect(durationCell(page, 2)).toHaveAttribute("data-duration-tone", "exceeded");
  await expect(durationCell(page, 2).locator(".duration-fill")).toHaveCSS("background-color", "rgb(239, 68, 68)");
  expect(await durationCell(page, 2).locator(".duration-fill").evaluate(element => (element as HTMLElement).style.width)).toBe("100%");
  await expect(durationCell(page, 2).getByRole("button")).toHaveAccessibleName(/16m \/ 10m/);
  await durationCell(page, 2).getByRole("button").click();
  await expect(page.locator(".info-source-body")).toContainText("EXCEEDED");
  await page.keyboard.press("Escape");
  expect(await durationCell(page, 3).locator(".duration-fill").evaluate(element => (element as HTMLElement).style.width)).toBe("0%");
  await expect(durationCell(page, 4)).toHaveAttribute("data-duration-tone", "unbounded");
  await durationCell(page, 4).getByRole("button").click();
  await expect(page.locator(".info-source-body")).toContainText("No valid positive duration limit");
  await page.keyboard.press("Escape");
  await expect(durationCell(page, 6)).toHaveText("—");
  await expect(durationCell(page, 7)).toHaveText("⟵");
  await expect(page.locator('#fleet-rows [data-host="sample-host-7-1"] td[data-col="queued"]')).toHaveText("2/8");
  await expect(durationCell(page, 10)).toHaveAttribute("data-duration-tone", "current");
  for (const row of await page.locator('#fleet-rows [data-host]').all()) {
    expect(await row.evaluate(element => element.getBoundingClientRect().height)).toBe(34);
  }
  await page.screenshot({ path: info.outputPath("duration-bars.png"), fullPage: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute("data-mode", "text");
  for (const [number, text] of [
    [1, "2m / 10m"], [2, "16m / 10m"], [3, "0s / 10m"],
    [4, "1m 30s"], [5, "5m / 10m"], [6, "—"], [7, "⟵"],
    [8, "8m / 10m"], [10, "10m / 10m"],
  ] as const) await expect(durationCell(page, number)).toHaveText(text);
  await expect(page.locator(".duration-track")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("duration-text.png"), fullPage: true });
  await toggle.click();
  await expect(durationCell(page, 1).locator(".duration-track")).toBeVisible();
});

test("Duration toggles by keyboard without changing numeric sorting or source timestamps", async ({ page }) => {
  await scenario(page, "durations");
  const timestamps = () => page.locator('#fleet-rows [data-host]').evaluateAll(rows =>
    Object.fromEntries(rows.map(row => [row.getAttribute("data-host"), row.getAttribute("data-job-observed-at")])));
  const originalTimes = await timestamps();
  const toggle = page.getByRole("button", { name: "Toggle Duration display", exact: true });
  const sort = page.getByRole("button", { name: "Sort by Duration", exact: true });
  await sort.click();
  const expected = [3, 4, 1, 9, 11, 5, 8, 10, 2, 6, 7].map(number => `sample-${String(number).padStart(2, "0")}`);
  expect(await visiblePCs(page)).toEqual(expected);
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute("data-mode", "text");
  await expect(page.locator('#column-headings th[data-col="duration"]')).toHaveAttribute("aria-sort", "ascending");
  expect(await visiblePCs(page)).toEqual(expected);
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("data-mode", "bar");
  await sort.click();
  expect(await visiblePCs(page)).toEqual([2, 10, 8, 5, 1, 9, 11, 4, 3, 6, 7].map(number => `sample-${String(number).padStart(2, "0")}`));
  expect(await timestamps()).toEqual(originalTimes);
  await durationCell(page, 2).getByRole("button").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toContainText("EXCEEDED");
  await expect(page.getByRole("dialog")).toContainText("2026-01-01T12:00:00.000Z");
  await page.keyboard.press("Escape");
  await expect(durationCell(page, 2).getByRole("button")).toBeFocused();
});

test("only fresh matching bounded jobs animate and expiry freezes retained evidence", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await scenario(page, "durations");
  const animation = (number: number) => durationCell(page, number).locator(".duration-fill")
    .evaluate(element => getComputedStyle(element, "::after").animationName);
  expect(await animation(1)).toBe("duration-sweep");
  expect(await animation(2)).toBe("duration-sweep");
  // Fresh backend job evidence stays current even when unrelated local inventory is old.
  await expect(page.locator('#fleet-rows [data-host="sample-host-11-1"]')).toHaveAttribute("data-freshness", "stale");
  expect(await animation(11)).toBe("duration-sweep");
  for (const number of [4, 5, 8, 9]) {
    expect(await animation(number)).toBe("none");
    await expect(durationCell(page, number).locator(".duration-fill")).toHaveCSS("background-color", "rgb(119, 119, 119)");
  }
  const phases = await page.locator(".duration-active").evaluateAll(elements => elements.map(element => (element as HTMLElement).style.getPropertyValue("--duration-delay")));
  expect(new Set(phases).size).toBeGreaterThan(1);
  const originalTime = await page.locator('#fleet-rows [data-host="sample-host-1-1"]').getAttribute("data-job-observed-at");
  await page.getByRole("button", { name: "Advance 30s", exact: true }).click();
  expect(await animation(1)).toBe("duration-sweep");
  await page.getByRole("button", { name: "Advance 30s", exact: true }).click();
  await expect(page.locator(".duration-active")).toHaveCount(0);
  await expect(durationCell(page, 1)).toHaveAttribute("data-duration-tone", "retained");
  await expect(durationCell(page, 2).locator(".duration-fill")).toHaveCSS("background-color", "rgb(119, 119, 119)");
  await expect(durationCell(page, 7)).toHaveText("—");
  await expect(page.locator('#fleet-rows [data-host="sample-host-7-1"] td[data-col="queued"]')).toHaveText("—");
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect(durationCell(page, 1)).toHaveAttribute("data-duration-tone", "retained");
  await page.getByRole("button", { name: "Toggle Duration display", exact: true }).click();
  await expect(durationCell(page, 1)).toHaveText("2m / 10m");
  await expect(page.locator('#fleet-rows [data-host="sample-host-1-1"]')).toHaveAttribute("data-job-observed-at", originalTime ?? "");
});

test("Duration System mode respects reduced motion without hiding measured progress", async ({ page }) => {
  await scenario(page, "durations");
  await page.getByLabel("Duration animation", { exact: true }).selectOption("system");
  await expect(durationCell(page, 1).locator(".duration-active")).toHaveCount(1);
  expect(await durationCell(page, 1).locator(".duration-fill").evaluate(element => getComputedStyle(element, "::after").animationName)).toBe("none");
  expect(await durationCell(page, 1).locator(".duration-fill").evaluate(element => (element as HTMLElement).style.width)).toBe("20%");
  expect(await page.locator(".duration-fill").evaluateAll(elements => elements.flatMap(element => element.getAnimations({ subtree: true })).length)).toBe(0);
  // State's separate default On still animates the unknown spinner.
  await expect(page.locator(".state-unknown .state-dots").first()).not.toHaveCSS("animation-name", "none");
});

test("Duration mode persists separately from IP mode and sorting, including empty scenarios", async ({ page }) => {
  await scenario(page, "durations");
  await page.getByRole("button", { name: "Toggle Duration display", exact: true }).click();
  await page.getByRole("button", { name: "Toggle IP display", exact: true }).click();
  await page.getByRole("button", { name: "Sort by Duration", exact: true }).click();
  await page.reload();
  await openPreviewTools(page);
  await expect(page.getByRole("button", { name: "Toggle Duration display", exact: true })).toHaveAttribute("data-mode", "text");
  await expect(page.getByRole("button", { name: "Toggle IP display", exact: true })).toHaveAttribute("data-mode", "full");
  await expect(page.locator('#column-headings th[data-col="duration"]')).toHaveAttribute("aria-sort", "ascending");
  expect(await page.evaluate(key => localStorage.getItem(key), durationPreferenceKey)).toBe("text");
  await scenario(page, "durations");
  await expect(durationCell(page, 1)).toHaveText("2m / 10m");
  await page.getByRole("button", { name: "Clear sort", exact: true }).click();
  await expect(durationCell(page, 1)).toHaveText("2m / 10m");
  for (const value of ["empty", "missing"]) {
    await scenario(page, value);
    const message = await page.locator(".empty-message").textContent();
    await page.getByRole("button", { name: "Toggle Duration display", exact: true }).click();
    await expect(page.locator(".empty-message")).toHaveText(message ?? "");
  }
});

test("invalid or denied Duration storage leaves a working bar/text control", async ({ page }) => {
  await page.evaluate(key => localStorage.setItem(key, "invalid"), durationPreferenceKey);
  await page.reload();
  await openPreviewTools(page);
  const toggle = page.getByRole("button", { name: "Toggle Duration display", exact: true });
  await expect(toggle).toHaveAttribute("data-mode", "bar");
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Storage unavailable", "SecurityError"); } });
  });
  await page.reload();
  await openPreviewTools(page);
  await scenario(page, "durations");
  await toggle.click();
  await expect(toggle).toHaveAttribute("data-mode", "text");
  await expect(durationCell(page, 1)).toHaveText("2m / 10m");
});

test("IP toggle matches the reference cycle with dotted compact octets", async ({ page }) => {
  const toggle = page.getByRole("button", { name: "Toggle IP display", exact: true });
  const firstIP = page.locator('#fleet-rows [data-host="sample-host-1-1"] td[data-col="ip"]');
  const noGlobal = page.locator('#fleet-rows [data-pc="sample-03"] td[data-col="ip"]');
  await expect(toggle).toHaveAttribute("data-mode", "dot");
  await expect(firstIP).toHaveText("•");
  await expect(firstIP).toHaveAttribute("title", "IP addresses hidden.");
  await toggle.click();
  await expect(toggle).toHaveAttribute("data-mode", "full");
  await expect(firstIP).toHaveText("198.51.100.200 / 192.0.2.10");
  await expect(noGlobal).toHaveText("192.0.2.12");
  await toggle.click();
  await expect(toggle).toHaveAttribute("data-mode", "ext");
  await expect(firstIP).toHaveText(".200");
  await expect(noGlobal).toHaveText("—");
  await expect(noGlobal).toHaveAttribute("aria-label", /Global: not reported/);
  await toggle.click();
  await expect(toggle).toHaveAttribute("data-mode", "int");
  await expect(firstIP).toHaveText(".10");
  await expect(noGlobal).toHaveText(".12");
  await toggle.click();
  await expect(toggle).toHaveAttribute("data-mode", "dot");
  await expect(firstIP).toHaveText("•");
  await expect(page.locator('#column-headings th[data-col="pc"]')).toHaveAttribute("aria-sort", "ascending");
  await expect(page.getByRole("button", { name: "Sort by IP", exact: true })).toHaveCSS("color", "rgb(248, 113, 113)");
});

test("keyboard IP toggles preserve full-address sorting and observation times", async ({ page }) => {
  const timestamps = () => page.locator('#fleet-rows [data-host]').evaluateAll((rows) =>
    Object.fromEntries(rows.map(row => [row.getAttribute("data-host"), row.getAttribute("data-observed-at")])));
  const original = await timestamps();
  const sort = page.getByRole("button", { name: "Sort by IP", exact: true });
  const toggle = page.getByRole("button", { name: "Toggle IP display", exact: true });
  await sort.click();
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute("data-mode", "full");
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("data-mode", "ext");
  expect(await visiblePCs(page)).toEqual(defaultPCs);
  await expect(page.locator('#column-headings th[data-col="ip"]')).toHaveAttribute("aria-sort", "ascending");
  await sort.click();
  expect(await visiblePCs(page)).toEqual(descendingPCs);
  await expect(page.locator('#fleet-rows td[data-col="ip"]').first()).toHaveText(".197");
  await expect(toggle).toHaveAttribute("data-mode", "ext");
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator('#fleet-rows td[data-col="ip"]').first()).toHaveText(".13");
  expect(await visiblePCs(page)).toEqual(descendingPCs);
  expect(await timestamps()).toEqual(original);
});

test("IP display choice survives refresh, scenario changes and reload independently of sorting", async ({ page }) => {
  const toggle = page.getByRole("button", { name: "Toggle IP display", exact: true });
  for (let i = 0; i < 3; i++) await toggle.click();
  await expect(toggle).toHaveAttribute("data-mode", "int");
  await scenario(page, "fresh");
  const missingInternal = page.locator('#fleet-rows [data-pc="sample-05"] td[data-col="ip"]');
  await expect(missingInternal).toHaveText("—");
  await expect(missingInternal).toHaveAttribute("title", /Internal.*not reported/i);
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await page.getByRole("button", { name: "Advance 30s", exact: true }).click();
  await expect(toggle).toHaveAttribute("data-mode", "int");
  await page.getByRole("button", { name: "Sort by PC", exact: true }).click();
  await page.reload();
  await openPreviewTools(page);
  await expect(toggle).toHaveAttribute("data-mode", "int");
  await expect(page.locator('#column-headings th[data-col="pc"]')).toHaveAttribute("aria-sort", "descending");
  expect(await page.evaluate(key => localStorage.getItem(key), ipPreferenceKey)).toBe("int");
  await expect(page.locator('#fleet-rows td[data-col="ip"]').first()).toHaveText(".13");
  await page.getByRole("button", { name: "Clear sort", exact: true }).click();
  await expect(toggle).toHaveAttribute("data-mode", "int");
  await scenario(page, "empty");
  await toggle.click();
  await expect(page.locator(".empty-message")).toHaveText("The sample runtime reported no hosts.");
});

test("invalid and unavailable IP preference storage fall back without disabling the toggle", async ({ page }) => {
  const toggle = page.getByRole("button", { name: "Toggle IP display", exact: true });
  await page.evaluate(key => localStorage.setItem(key, "bad-mode"), ipPreferenceKey);
  await page.reload();
  await openPreviewTools(page);
  await expect(toggle).toHaveAttribute("data-mode", "dot");
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Storage unavailable", "SecurityError"); } });
  });
  await page.reload();
  await openPreviewTools(page);
  await toggle.click();
  await expect(toggle).toHaveAttribute("data-mode", "full");
  await expect(page.locator('#fleet-rows td[data-col="ip"]').first()).toHaveText("198.51.100.200 / 192.0.2.10");
  await toggle.click();
  await expect(toggle).toHaveAttribute("data-mode", "ext");
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect(toggle).toHaveAttribute("data-mode", "ext");
});

test.describe("touch display controls", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("the header toggle is reachable on a narrow touch viewport and does not sort", async ({ page }) => {
    const toggle = page.getByRole("button", { name: "Toggle IP display", exact: true });
    await toggle.tap();
    await expect(toggle).toHaveAttribute("data-mode", "full");
    await expect(page.locator('#column-headings th[data-col="pc"]')).toHaveAttribute("aria-sort", "ascending");
    await expect(page.locator('#column-headings th[data-col="ip"]')).toHaveAttribute("aria-sort", "none");
    await toggle.tap();
    await expect(page.locator('#fleet-rows td[data-col="ip"]').first()).toHaveText(".200");
    await expectFleetDocumentFlow(page);
  });
  test("Duration toggles and details remain reachable on a narrow touch viewport", async ({ page }) => {
    await scenario(page, "durations");
    const toggle = page.getByRole("button", { name: "Toggle Duration display", exact: true });
    await toggle.tap();
    await expect(toggle).toHaveAttribute("data-mode", "text");
    await expect(page.locator('#column-headings th[data-col="pc"]')).toHaveAttribute("aria-sort", "ascending");
    await durationCell(page, 1).getByRole("button").tap();
    await expect(page.getByRole("dialog")).toContainText("2m / 10m");
    await page.getByRole("button", { name: "Close", exact: true }).tap();
    await expectFleetDocumentFlow(page);
  });
  test("Market toggles and header help work on a narrow touch viewport while row values stay inert", async ({ page }) => {
    const toggle = page.getByRole("button", { name: "Toggle Market display", exact: true });
    await toggle.tap();
    await expect(toggle).toHaveAttribute("data-mode", "compact");
    await marketCell(page, "sample-host-1-1").tap();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(marketCell(page, "sample-host-1-1").locator(".market-value")).toHaveAttribute("aria-label", /amber-demo-4090/);
    await expect(page.locator('#column-headings th[data-col="pc"]')).toHaveAttribute("aria-sort", "ascending");
    await page.getByRole("button", { name: "Sort by Market", exact: true }).tap();
    await page.getByRole("button", { name: "Column info", exact: true }).tap();
    await expect(page.getByRole("dialog")).toHaveAccessibleName("Market");
    await expect(page.getByRole("dialog")).toContainText("full reported market label");
    await page.getByRole("button", { name: "Close", exact: true }).tap();
    await expect(page.locator('#column-headings th[data-col="market"]')).toHaveAttribute("aria-sort", "ascending");
    await expectFleetDocumentFlow(page);
  });
});

test("sort headers toggle by mouse and keyboard, persist, and clear to PC order", async ({ page }) => {
  const pcHeader = page.locator('#column-headings th[data-col="pc"]');
  const pcButton = page.getByRole("button", { name: "Sort by PC", exact: true });
  await expect(pcHeader).toHaveAttribute("aria-sort", "ascending");
  expect(await visiblePCs(page)).toEqual(defaultPCs);
  await pcButton.click();
  await expect(pcHeader).toHaveAttribute("aria-sort", "descending");
  expect(await visiblePCs(page)).toEqual(descendingPCs);
  // Equal primary PC values keep their natural host order even descending.
  expect(await page.locator('#fleet-rows [data-pc="sample-01"]').evaluateAll((rows) => rows.map((row) => row.getAttribute("data-host"))))
    .toEqual(["sample-host-1-1", "sample-host-1-2", "sample-host-1-3"]);
  await page.keyboard.press("Enter");
  await expect(pcButton).toBeFocused();
  await expect(pcHeader).toHaveAttribute("aria-sort", "ascending");
  await page.keyboard.press("Space");
  await expect(pcHeader).toHaveAttribute("aria-sort", "descending");
  await page.reload();
  await openPreviewTools(page);
  await expect(pcHeader).toHaveAttribute("aria-sort", "descending");
  expect(await visiblePCs(page)).toEqual(descendingPCs);
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), sortPreferenceKey))
    .toEqual({ column: "pc", direction: "desc" });
  await page.getByRole("button", { name: "Clear sort", exact: true }).click();
  await expect(pcHeader).toHaveAttribute("aria-sort", "ascending");
  expect(await visiblePCs(page)).toEqual(defaultPCs);
  await page.reload();
  await openPreviewTools(page);
  await expect(pcHeader).toHaveAttribute("aria-sort", "ascending");
  expect(await visiblePCs(page)).toEqual(defaultPCs);
});

test("removed Monitor HB sorting falls back to PC without changing observations", async ({ page }) => {
  const originalTimes = await page.locator("#fleet-rows [data-host]").evaluateAll(rows => rows.map(row => row.getAttribute("data-observed-at")));
  await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ column: "heartbeat", direction: "desc" })), sortPreferenceKey);
  await page.reload();
  await openPreviewTools(page);
  await expect(page.getByRole("button", { name: "Sort by Monitor HB", exact: true })).toHaveCount(0);
  await expect(page.locator('[data-col="heartbeat"], .heartbeat')).toHaveCount(0);
  await expect(page.locator('#column-headings th[data-col="pc"]')).toHaveAttribute("aria-sort", "ascending");
  expect(await visiblePCs(page)).toEqual(defaultPCs);
  expect(await page.locator("#fleet-rows [data-host]").evaluateAll(rows => rows.map(row => row.getAttribute("data-observed-at")))).toEqual(originalTimes);
});


test("unknown columns keep deterministic ties and never manufacture values", async ({ page }) => {
  await page.getByRole("button", { name: "Sort by PC", exact: true }).click();
  for (const label of ["Rewards to claim", "Duration", "GPU ID"]) {
    const button = page.getByRole("button", { name: `Sort by ${label}`, exact: true });
    await button.click();
    expect(await visiblePCs(page)).toEqual(defaultPCs);
    await button.click();
    expect(await visiblePCs(page)).toEqual(defaultPCs);
  }
  for (const key of ["rewards", "duration", "gpuID"]) {
    expect(await page.locator(`#fleet-rows td[data-col="${key}"]`).allTextContents()).toEqual(Array(6).fill("—"));
  }
});

test("sorting preserves empty and missing explanations across scenario changes", async ({ page }) => {
  for (const id of ["missing", "empty"]) {
    await scenario(page, id);
    const message = await page.locator(".empty-message").textContent();
    await page.getByRole("button", { name: "Sort by IP", exact: true }).click();
    await expect(page.locator(".empty-message")).toHaveText(message ?? "");
    await expect(page.locator('#fleet-rows [data-host]')).toHaveCount(0);
    await page.getByRole("button", { name: "Clear sort", exact: true }).click();
    await expect(page.locator(".empty-message")).toHaveText(message ?? "");
  }
  await page.getByRole("button", { name: "Sort by PC", exact: true }).click();
  await scenario(page, "fresh");
  await expect(page.locator('#column-headings th[data-col="pc"]')).toHaveAttribute("aria-sort", "descending");
  await expect(page.locator('#fleet-rows [data-host]')).toHaveCount(8);
  expect((await visiblePCs(page))[0]).toBe("sample-06");
});

test("corrupt saved sorts fall back safely and blocked storage still allows sorting", async ({ page }) => {
  for (const raw of ['not-json', '{"column":"__proto__","direction":"asc"}', '{"column":"pc","direction":"invalid"}', '{"column":"hostSignal","direction":"desc"}']) {
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: sortPreferenceKey, value: raw });
    await page.reload();
    await openPreviewTools(page);
    await expect(page.locator('#column-headings th[data-col="pc"]')).toHaveAttribute("aria-sort", "ascending");
    expect(await visiblePCs(page)).toEqual(defaultPCs);
  }
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Storage unavailable", "SecurityError"); } });
  });
  await page.reload();
  await openPreviewTools(page);
  await page.getByRole("button", { name: "Sort by PC", exact: true }).click();
  await expect(page.locator('#column-headings th[data-col="pc"]')).toHaveAttribute("aria-sort", "descending");
  expect(await visiblePCs(page)).toEqual(descendingPCs);
  await page.getByRole("button", { name: "Clear sort", exact: true }).click();
  expect(await visiblePCs(page)).toEqual(defaultPCs);
});

test("the 28-column table starts with Staked NOS, omits Monitor HB and keeps activity columns together", async ({ page }, info) => {
  await expect(page.getByText("Sample data", { exact: true })).toBeVisible();
  await expect(page.locator("#column-headings th[data-col]")).toHaveCount(28);
  expect(await page.locator("#column-headings .column-label").allTextContents()).toEqual(labels);
  await expect(page.getByRole("button", { name: "Sort by Host", exact: true })).toHaveCount(0);
  await expect(page.locator('[data-col="hostSignal"], .host-indicator')).toHaveCount(0);
  const localHeaders = page.locator('#column-headings th[data-source="local"] .column-label');
  expect(await localHeaders.allTextContents()).toEqual(["PC", "IP", "GPU ID"]);
  for (const header of await localHeaders.all()) {
    await expect(header).toHaveCSS("color", "rgb(248, 113, 113)");
    await expect(header).toHaveAttribute("aria-describedby", "local-source-note");
  }
  // Active and hovered sorting styles must not erase the local-source marker.
  const pcSort = page.getByRole("button", { name: "Sort by PC", exact: true });
  await pcSort.hover();
  await pcSort.click();
  await expect(pcSort).toHaveCSS("color", "rgb(248, 113, 113)");
  await page.getByRole("button", { name: "Column info", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("connection to hosted app pending");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Clear sort", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sort by RAM", exact: true })).not.toHaveCSS("color", "rgb(248, 113, 113)");
  await expect(page.getByRole("button", { name: "Sort by Node run time", exact: true })).not.toHaveCSS("color", "rgb(248, 113, 113)");
  await expect(page.locator("#fleet-rows [data-host]")).toHaveCount(6);
  for (const row of await page.locator("#fleet-rows [data-host]").all()) {
    await expect(row.locator("td[data-col]")).toHaveCount(28);
    expect(await row.evaluate((element) => element.getBoundingClientRect().height)).toBe(34);
  }
  const geometry = await page.locator(".fleet-table").boundingBox();
  expect(geometry?.y).toBeLessThan(130);
  await expect(page.locator("#inventory-summary")).toHaveText("6 PCs · 4 current · 2 retained · 1 unknown inventory");
  await page.screenshot({ path: info.outputPath("desktop.png"), fullPage: true });
});

test("fresh container inventory never fabricates Nosana or hardware metrics", async ({ page }) => {
  await scenario(page, "fresh");
  await expect(page.locator("#inventory-summary")).toHaveText("6 PCs · 8 current · 0 retained");
  for (const [name, state] of [["Sample host 1.1 on sample-01", "running"], ["Sample host 2.1 on sample-02", "stopped"]]) {
    await page.getByRole("button", { name: `Observation details for ${name}`, exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText(`Current container state: ${state}`);
    await page.keyboard.press("Escape");
  }
  for (const key of ["status", "state", "nodeRuntime", "dailyUptime", "latestJob", "duration", "rewards", "stakedNos", "gpuID"]) {
    const cells = page.locator(`#fleet-rows td[data-col="${key}"]`);
    if (key === "state") {
      await expect(cells.locator(".state-unknown .state-dots")).toHaveCount(8);
      expect(await cells.evaluateAll(elements => elements.every(element =>
        element.getAttribute("data-state") === "unknown" && element.getAttribute("data-state-current") === "false"))).toBe(true);
    } else if (key === "latestJob") expect(await cells.locator(".job-summary-link").allTextContents()).toEqual(Array(8).fill("—"));
    else expect(await cells.allTextContents()).toEqual(Array(8).fill("—"));
  }
});

test("ageing and repeated refresh preserve timestamps and turn current state unknown", async ({ page }) => {
  await scenario(page, "fresh");
  const originalTimes = await page.locator("#fleet-rows [data-host]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-observed-at")));
  for (let step = 0; step < 3; step++) await page.getByRole("button", { name: "Advance 30s", exact: true }).click();
  await expect(page.locator("#inventory-summary")).toHaveText("6 PCs · 0 current · 8 retained");
  await expect(page.locator('#fleet-rows [data-freshness="stale"]')).toHaveCount(8);
  await page.getByRole("button", { name: "Observation details for Sample host 1.1 on sample-01", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Current container state: unknown");
  await expect(page.getByRole("dialog")).toContainText("Last observed container state: running");
  await page.keyboard.press("Escape");
  for (let read = 0; read < 3; read++) await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  expect(await page.locator("#fleet-rows [data-host]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-observed-at")))).toEqual(originalTimes);
  await page.getByRole("button", { name: "Reset sample", exact: true }).click();
  await expect(page.locator("#inventory-summary")).toHaveText("6 PCs · 8 current · 0 retained");
});

test("failed reads retain original observed state and error without declaring stopped", async ({ page }) => {
  await scenario(page, "failed");
  await expect(page.locator("#fleet-rows [data-host]")).toHaveCount(2);
  await expect(page.locator("#inventory-summary")).toHaveText("1 PC · 0 current · 2 retained");
  await expect(page.locator("#runtime-scopes")).toContainText("Sample inventory read failed");
  await page.getByRole("button", { name: "Observation details for Sample host 1.1 on sample-01", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Current container state: unknown");
  await expect(page.getByRole("dialog")).toContainText("Last observed container state: running");
  await expect(page.getByRole("dialog")).toContainText("Inventory observation: 2026-01-01T11:59:30.000Z");
  await expect(page.getByRole("dialog")).toContainText("Latest attempt: 2026-01-01T12:00:00.000Z");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
});

test("missing and successful-empty inventory have different explanations", async ({ page }) => {
  await scenario(page, "missing");
  await expect(page.locator("#fleet-rows [data-host]")).toHaveCount(0);
  await expect(page.locator(".empty-message")).toHaveText("No inventory received yet. Host count is unknown.");
  await expect(page.locator("#runtime-scopes")).toContainText("Host count unknown");
  await expect(page.locator("#runtime-scopes")).not.toContainText("Confirmed empty");
  await scenario(page, "empty");
  await expect(page.locator("#fleet-rows [data-host]")).toHaveCount(0);
  await expect(page.locator(".empty-message")).toHaveText("The sample runtime reported no hosts.");
  await expect(page.locator("#runtime-scopes")).toContainText("Confirmed empty");
  for (let step = 0; step < 4; step++) await page.getByRole("button", { name: "Advance 30s", exact: true }).click();
  await expect(page.locator("#runtime-scopes")).toContainText("Last reading empty · now stale");
  await expect(page.locator(".empty-message")).toHaveText("The last sample reading was empty. Current inventory is unknown.");
});

test("each sample PC/runtime keeps independent health", async ({ page }) => {
  const scopes = page.locator("#runtime-scopes");
  await expect(scopes.locator('[data-pc="sample-01"]')).toContainText("Current inventory");
  await expect(scopes.locator('[data-pc="sample-03"]')).toContainText("Read failed · last observation retained");
  await expect(scopes.locator('[data-pc="sample-04"]')).toContainText("Stale inventory");
  await expect(scopes.locator('[data-pc="sample-05"]')).toContainText("No observation yet");
  await expect(scopes.locator('[data-pc="sample-06"]')).toContainText("Confirmed empty");
  await expect(page.locator('#fleet-rows [data-pc="sample-01"][data-freshness="fresh"]')).toHaveCount(3);
});

test("column explanations and observation details support keyboard use", async ({ page }) => {
  const column = page.getByRole("button", { name: "Sort by Rewards to claim", exact: true });
  await column.focus();
  await page.keyboard.press("Enter");
  const info = page.getByRole("button", { name: "Column info", exact: true });
  await info.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toContainText("exact claimable host-uptime amount");
  await page.keyboard.press("Escape");
  await expect(info).toBeFocused();
  const details = page.getByRole("button", { name: "Observation details for Sample host 1.1 on sample-01", exact: true });
  await details.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toContainText("Sample host 1.1");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(details).toBeFocused();
});

for (const width of [320, 390]) {
  test(`at ${width}px native horizontal table scrolling reaches both outer columns`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    const region = page.getByRole("region", { name: "Fleet table", exact: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await region.evaluate((element) => getComputedStyle(element).overflowX)).toBe("auto");
    const firstHeader = page.getByRole("button", { name: "Sort by Staked NOS", exact: true });
    await firstHeader.focus();
    await expect(firstHeader).toBeInViewport();
    await expect(page.locator('#fleet-rows tr:first-child td[data-col="stakedNos"]')).toBeInViewport();
    const keyboardScroll = await region.evaluateHandle(element => {
      const completion = { ended: false };
      element.addEventListener("scrollend", () => { completion.ended = true; }, { once: true });
      return completion;
    });
    await page.keyboard.press("ArrowRight");
    // Native keyboard movement continues after keyup. Finish that input before
    // moving to another control, as an operator opening Scenario would do.
    await expect.poll(() => keyboardScroll.evaluate(completion => completion.ended),
      { message: "Native keyboard scrolling must finish before the next action" }).toBe(true);
    await keyboardScroll.dispose();
    expect(await region.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    await region.evaluate(element => { element.scrollLeft = element.scrollWidth; });
    expect(await page.evaluate(() => window.scrollX)).toBe(0);
    await expect(page.getByRole("button", { name: "Sort by Country", exact: true })).toBeInViewport();
    await expect(page.locator('#fleet-rows tr:first-child td[data-col="country"]')).toBeInViewport();
    await page.getByLabel("Scenario", { exact: true }).focus();
    await scenario(page, "missing");
    expect(await page.evaluate(() => window.scrollX)).toBe(0);
    expect(await region.evaluate(element => element.scrollLeft)).toBe(0);
    await expect(firstHeader).toBeInViewport();
    await expect(page.locator(".empty-message")).toBeVisible();
    await page.screenshot({ path: info.outputPath(`mobile-${width}.png`), fullPage: true });
  });
}

for (const zoom of [1.25, 1.5, 2]) {
  test(`CSS zoom ${zoom}x approximates reflow without losing controls or columns`, async ({ page }) => {
    // CSS zoom is a layout check, not proof of native browser-zoom acceptance.
    await page.evaluate((factor) => { document.documentElement.style.zoom = String(factor); }, zoom);
    await expect(page.locator("#column-headings th[data-col]")).toHaveCount(28);
    await page.getByRole("button", { name: "Advance 30s", exact: true }).click();
    await expect(page.locator("#sample-clock")).toHaveText("Sample clock 12:00:30 UTC");
    expect(await page.evaluate(() => document.body.getBoundingClientRect().width <= window.innerWidth + 1)).toBe(true);
    await page.evaluate(() => { window.scrollTo(0, 0); const region = document.querySelector(".fleet-table-wrap")!; region.scrollLeft = region.scrollWidth; });
    await expect(page.getByRole("button", { name: "Sort by Country", exact: true })).toBeInViewport();
  });
}

test("unsupported scroll timelines retain the legacy heading and document scroll fallback", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const supports = CSS.supports.bind(CSS);
    Object.defineProperty(CSS, "supports", { configurable: true,
      value: (property: string, value?: string) => property === "view-timeline-name" ? false
        : value === undefined ? supports(property) : supports(property, value) });
  });
  await page.reload();
  await openPreviewTools(page);
  await scenario(page, "scale");
  await expectFleetDocumentFlow(page, { native: false });
  const region = page.getByRole("region", { name: "Fleet table", exact: true });
  const first = page.getByRole("button", { name: "Sort by Staked NOS", exact: true });
  const last = page.getByRole("button", { name: "Sort by Country", exact: true });
  await first.focus();
  await expect(first).toBeInViewport();
  await last.focus();
  await expect(last).toBeInViewport();
  expect(await page.evaluate(() => window.scrollX)).toBeGreaterThan(0);
  expect(await region.evaluate(element => element.scrollLeft)).toBe(0);
  await page.evaluate(() => window.scrollTo({ top: 500 }));
  await expect(last).toBeInViewport();
  await expect(page.locator('.fleet-table th[data-col="country"]')).toHaveCSS("position", "sticky");
  await page.locator('#fleet-rows [data-host="sample-host-50-4"]').scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  expect(await region.evaluate(element => element.scrollTop)).toBe(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(first).toBeInViewport();
});

test("open diagnostics wrap complete source identifiers inside the narrow main column", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const address = SYNTHETIC_HOST_ADDRESSES[0]!;
  await page.route("**/preview/metadata.json", route => route.fulfill({ json: {
    hosts: SYNTHETIC_HOST_ADDRESSES.map(value => ({ address: value, values: null, fetchedAtMs: null,
      retained: false, error: `Synthetic metadata unavailable for ${address}`, marketError: null })),
  } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Expand menu", exact: true }).click();
  await openPreviewTools(page);
  const paragraph = page.locator("#queue-status");
  await expect(paragraph).toContainText(address);
  const geometry = await paragraph.evaluate((element, token) => {
    const node = element.firstChild!;
    const start = node.textContent!.indexOf(token);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + token.length);
    const bounds = element.closest(".preview-tools-content")!.getBoundingClientRect();
    return { lines: [...range.getClientRects()].map(rect => ({ left: rect.left, right: rect.right })),
      left: bounds.left, right: bounds.right, width: element.clientWidth, scrollWidth: element.scrollWidth };
  }, address);
  expect(geometry.lines.length, "The complete identifier wraps instead of clipping or ellipsizing").toBeGreaterThan(1);
  for (const line of geometry.lines) {
    expect(line.left).toBeGreaterThanOrEqual(geometry.left - 1);
    expect(line.right).toBeLessThanOrEqual(geometry.right + 1);
  }
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
  await paragraph.scrollIntoViewIfNeeded();
  await expect(paragraph).toBeInViewport();
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1080, height: 1920 }]) {
  test(`200 hosts extend the page at ${viewport.width}×${viewport.height} without an inner scroll window`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await scenario(page, "scale");
    await expect(page.locator("#fleet-rows [data-host]")).toHaveCount(200);
    await expect(page.locator("#fleet-rows [data-host] td[data-col]")).toHaveCount(200 * 28);
    expect(await page.locator("#column-headings .column-label").allTextContents()).toEqual(labels);
    await expect(page.locator('[data-col="hostSignal"], .host-indicator')).toHaveCount(0);
    await expect(page.locator("#inventory-summary")).toHaveText("50 PCs · 200 current · 0 retained");
    await page.getByRole("button", { name: "Sort by PC", exact: true }).click();
    expect((await visiblePCs(page))[0]).toBe("sample-50");
    await page.getByRole("button", { name: "Clear sort", exact: true }).click();
    const region = page.getByRole("region", { name: "Fleet table", exact: true });
    const table = await region.boundingBox();
    expect(table?.height).toBeGreaterThan(200 * 33);
    await expectFleetDocumentFlow(page);
    const last = page.locator('#fleet-rows [data-host="sample-host-50-4"]');
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    expect(await region.evaluate((element) => element.scrollTop)).toBe(0);
    const lastRow = await last.boundingBox();
    const controls = await page.getByRole("region", { name: "Sample controls" }).boundingBox();
    expect(controls?.y).toBeGreaterThan((lastRow?.y ?? 0) + (lastRow?.height ?? 0));
    const runtimeScopes = page.locator("#runtime-scopes");
    expect(await runtimeScopes.evaluate((element) => element.clientHeight >= element.scrollHeight)).toBe(true);
    expect(await runtimeScopes.evaluate((element) => getComputedStyle(element).overflowY)).toBe("visible");
    await scenario(page, "fresh");
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await scenario(page, "scale");
    await page.screenshot({ path: info.outputPath(`scale-${viewport.width}.png`) });
  });
}

test("State System mode follows reduced motion without claiming activity or making live requests", async ({ page }) => {
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  await page.getByLabel("State animation", { exact: true }).selectOption("system");
  expect(await page.evaluate(() => document.getAnimations().filter(animation => !(animation instanceof CSSAnimation &&
    animation.animationName === "fleet-column-pin" && animation.timeline !== document.timeline)).length)).toBe(0);
  await scenario(page, "stale");
  await expect(page.locator('#fleet-rows [data-freshness="stale"]')).toHaveCount(2);
  await expect(page.locator("#runtime-scopes")).toContainText("Stale inventory");
  expect(await page.evaluate(() => document.getAnimations().filter(animation => !(animation instanceof CSSAnimation &&
    animation.animationName === "fleet-column-pin" && animation.timeline !== document.timeline)).length)).toBe(0);
  const resources = await page.evaluate(() => performance.getEntriesByType("resource").map((entry) => entry.name));
  expect(resources.every((url) => url.startsWith("http://127.0.0.1:4174/") || url.startsWith("data:"))).toBe(true);
});
