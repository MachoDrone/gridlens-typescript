import { expectFleetDocumentFlow, openPreviewTools } from "./helpers.ts";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const columns = [
  {
    key: "nvidia", label: "NVIDIA",
    compact: ["550", "550", "550", "550", "—", "570"],
    expanded: ["550.120.02", "550.120.02", "550.120.02", "550.90.07", "—", "570.86.16"],
  },
  {
    key: "cpu", label: "CPU",
    compact: ["13th", "13th", "13th", "13th", "—", "AMD"],
    expanded: [
      "13th Gen Intel(R) Core(TM) i7-13700K", "13th Gen Intel(R) Core(TM) i7-13700K",
      "13th Gen Intel(R) Core(TM) i7-13700K", "13th Gen Intel(R) Core(TM) i5-13600K",
      "—", "AMD Ryzen 7 7700X 8-Core Processor",
    ],
  },
  {
    key: "system", label: "System",
    compact: ["6.8.0", "6.8.0", "6.8.0", "6.8.0", "—", "6.12.0"],
    expanded: ["6.8.0-52-generic", "6.8.0-52-generic", "6.8.0-52-generic", "6.8.0-9-generic", "—", "6.12.0-4-generic"],
  },
] as const;
type HardwareColumn = typeof columns[number]["key"];

const unexpectedRequests: string[] = [];
const browserErrors: string[] = [];
const ascendingHosts = ["sample-host-2-1", "sample-host-1-1", "sample-host-1-2", "sample-host-1-3", "sample-host-4-1", "sample-host-3-1"];
const descendingHosts = ["sample-host-4-1", "sample-host-1-1", "sample-host-1-2", "sample-host-1-3", "sample-host-2-1", "sample-host-3-1"];

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

function cell(page: Page, key: HardwareColumn, hostId = "sample-host-1-1") {
  return page.locator(`#fleet-rows [data-host="${hostId}"] td[data-col="${key}"]`);
}

function toggle(page: Page, key: HardwareColumn) {
  return page.locator(`#${key}-display-toggle`);
}

function preferenceKey(key: HardwareColumn): string {
  return `gridlens.preview.${key}-mode.v1`;
}

async function hostIDs(page: Page): Promise<(string | null)[]> {
  return page.locator("#fleet-rows [data-host]").evaluateAll(rows => rows.map(row => row.getAttribute("data-host")));
}

test("hardware samples begin compact and each reference toggle expands only its own column", async ({ page }, info) => {
  const originalHosts = await hostIDs(page);
  for (const column of columns) {
    await expect(toggle(page, column.key)).toHaveAttribute("data-mode", "compact");
    await expect(toggle(page, column.key)).toHaveAccessibleName(`Toggle ${column.label} display`);
    await expect(toggle(page, column.key)).toHaveAttribute("aria-describedby", `${column.key}-mode-status`);
    await expect(page.locator(`#${column.key}-mode-status`)).toContainText(/compact/i);
    expect(await page.locator(`#fleet-rows td[data-col="${column.key}"]`).allTextContents()).toEqual(column.compact);
    await expect(cell(page, column.key)).not.toHaveAttribute("title");
    await expect(cell(page, column.key).locator("span.hardware-value")).toHaveAttribute("aria-label", new RegExp(column.expanded[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await expect(cell(page, column.key).getByRole("button")).toHaveCount(0);
    await expect(cell(page, column.key, "sample-host-3-1").locator("button")).toHaveCount(0);
    await expect(page.getByRole("button", { name: `Sort by ${column.label}`, exact: true })).not.toHaveCSS("color", "rgb(248, 113, 113)");
  }
  await page.screenshot({ path: info.outputPath("hardware-compact.png"), fullPage: true });
  for (const [index, column] of columns.entries()) {
    await toggle(page, column.key).click();
    await expect(toggle(page, column.key)).toHaveAttribute("data-mode", "expanded");
    for (const [otherIndex, other] of columns.entries()) {
      expect(await page.locator(`#fleet-rows td[data-col="${other.key}"]`).allTextContents())
        .toEqual(otherIndex <= index ? other.expanded : other.compact);
    }
    expect(await hostIDs(page)).toEqual(originalHosts);
    await expect(page.locator('#column-headings th[data-col="pc"]')).toHaveAttribute("aria-sort", "ascending");
  }
  for (const row of await page.locator("#fleet-rows [data-host]").all()) {
    expect(await row.evaluate(element => element.getBoundingClientRect().height)).toBe(34);
  }
  await page.screenshot({ path: info.outputPath("hardware-expanded.png"), fullPage: true });
});

for (const column of columns) {
  test(`${column.label} sorts full plain values in both modes and supports keyboard header help`, async ({ page }) => {
    const sort = page.getByRole("button", { name: `Sort by ${column.label}`, exact: true });
    const header = page.locator(`#column-headings th[data-col="${column.key}"]`);
    await sort.click();
    expect(await hostIDs(page)).toEqual(ascendingHosts);
    await toggle(page, column.key).focus();
    await page.keyboard.press("Enter");
    await expect(toggle(page, column.key)).toBeFocused();
    await expect(toggle(page, column.key)).toHaveAttribute("data-mode", "expanded");
    await expect(header).toHaveAttribute("aria-sort", "ascending");
    expect(await hostIDs(page)).toEqual(ascendingHosts);
    await sort.click();
    expect(await hostIDs(page)).toEqual(descendingHosts);
    await toggle(page, column.key).focus();
    await page.keyboard.press("Space");
    await expect(toggle(page, column.key)).toBeFocused();
    await expect(toggle(page, column.key)).toHaveAttribute("data-mode", "compact");
    await expect(header).toHaveAttribute("aria-sort", "descending");
    expect(await hostIDs(page)).toEqual(descendingHosts);
    const value = cell(page, column.key).locator("span.hardware-value");
    expect(await value.getAttribute("aria-label")).toContain(column.expanded[0]);
    expect(await value.getAttribute("aria-label")).not.toContain("Open details");
    await value.click();
    await expect(page.getByRole("dialog")).toBeHidden();
    const columnInfo = page.getByRole("button", { name: "Column info", exact: true });
    await columnInfo.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toHaveAccessibleName(column.label);
    await expect(page.locator(".info-source-body")).toContainText("Sorting uses the full");
    await page.keyboard.press("Escape");
    await expect(columnInfo).toBeFocused();
  });
}

test("hardware preferences persist independently across reloads, other settings and empty scenarios", async ({ page }) => {
  await toggle(page, "nvidia").click();
  await toggle(page, "system").click();
  for (const label of ["IP", "Duration", "Market"]) {
    await page.getByRole("button", { name: `Toggle ${label} display`, exact: true }).click();
  }
  await page.getByRole("button", { name: "Sort by CPU", exact: true }).click();
  await page.reload();
  await openPreviewTools(page);
  await expect(toggle(page, "nvidia")).toHaveAttribute("data-mode", "expanded");
  await expect(toggle(page, "cpu")).toHaveAttribute("data-mode", "compact");
  await expect(toggle(page, "system")).toHaveAttribute("data-mode", "expanded");
  await expect(page.getByRole("button", { name: "Toggle IP display", exact: true })).toHaveAttribute("data-mode", "full");
  await expect(page.getByRole("button", { name: "Toggle Duration display", exact: true })).toHaveAttribute("data-mode", "text");
  await expect(page.getByRole("button", { name: "Toggle Market display", exact: true })).toHaveAttribute("data-mode", "compact");
  await expect(page.locator('#column-headings th[data-col="cpu"]')).toHaveAttribute("aria-sort", "ascending");
  expect(await hostIDs(page)).toEqual(ascendingHosts);
  await toggle(page, "nvidia").click();
  await toggle(page, "cpu").click();
  await page.reload();
  await openPreviewTools(page);
  for (const column of columns) {
    const mode = column.key === "nvidia" ? "compact" : "expanded";
    await expect(toggle(page, column.key)).toHaveAttribute("data-mode", mode);
    expect(await page.evaluate(key => localStorage.getItem(key), preferenceKey(column.key))).toBe(mode);
  }
  await page.getByLabel("Scenario", { exact: true }).selectOption("fresh");
  await page.getByRole("button", { name: "Clear sort", exact: true }).click();
  await expect(cell(page, "nvidia")).toHaveText(columns[0].compact[0]);
  await expect(cell(page, "cpu")).toHaveText(columns[1].expanded[0]);
  await expect(cell(page, "system")).toHaveText(columns[2].expanded[0]);
  for (const id of ["empty", "missing"]) {
    await page.getByLabel("Scenario", { exact: true }).selectOption(id);
    const message = await page.locator(".empty-message").textContent();
    for (const column of columns) await toggle(page, column.key).click();
    await expect(page.locator(".empty-message")).toHaveText(message ?? "");
    await expect(page.locator("#fleet-rows [data-host]")).toHaveCount(0);
  }
});

test("invalid and denied hardware preference storage leave all three controls usable", async ({ page }) => {
  await page.evaluate(keys => {
    for (const key of keys) localStorage.setItem(key, "invalid");
  }, columns.map(column => preferenceKey(column.key)));
  await page.reload();
  await openPreviewTools(page);
  for (const column of columns) await expect(toggle(page, column.key)).toHaveAttribute("data-mode", "compact");
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Storage unavailable", "SecurityError"); } });
  });
  await page.reload();
  await openPreviewTools(page);
  for (const column of columns) {
    await expect(toggle(page, column.key)).toHaveAttribute("data-mode", "compact");
    await toggle(page, column.key).click();
    await expect(toggle(page, column.key)).toHaveAttribute("data-mode", "expanded");
  }
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  for (const column of columns) {
    expect(await page.locator(`#fleet-rows td[data-col="${column.key}"]`).allTextContents()).toEqual(column.expanded);
  }
});

test("hardware observations retain their timestamps independently of local inventory age", async ({ page }) => {
  const sourceTimes = () => page.locator("#fleet-rows [data-host]").evaluateAll(rows =>
    Object.fromEntries(rows.map(row => [row.getAttribute("data-host"), row.getAttribute("data-hardware-observed-at")])));
  const originalTimes = await sourceTimes();
  expect(originalTimes["sample-host-1-1"]).toBe(String(Date.UTC(2026, 0, 1, 12)));
  expect(originalTimes["sample-host-4-1"]).not.toBeNull();
  expect(originalTimes["sample-host-4-1"]).not.toBe("");
  expect(Number(originalTimes["sample-host-4-1"])).toBeLessThan(Number(originalTimes["sample-host-1-1"]));
  await expect(page.locator('#fleet-rows [data-host="sample-host-4-1"]')).toHaveAttribute("data-freshness", "stale");
  for (const column of columns) {
    await expect(cell(page, column.key, "sample-host-4-1")).toHaveText(column.compact[5]);
    expect(await cell(page, column.key).locator("span.hardware-value").getAttribute("aria-label")).toContain(column.expanded[0]);
    await expect(cell(page, column.key)).not.toHaveAttribute("title");
    await toggle(page, column.key).click();
  }
  for (let index = 0; index < 4; index++) await page.getByRole("button", { name: "Advance 30s", exact: true }).click();
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  expect(await sourceTimes()).toEqual(originalTimes);
  for (const column of columns) {
    expect(await page.locator(`#fleet-rows td[data-col="${column.key}"]`).allTextContents()).toEqual(column.expanded);
    await toggle(page, column.key).click();
    expect(await page.locator(`#fleet-rows td[data-col="${column.key}"]`).allTextContents()).toEqual(column.compact);
  }
  expect(await sourceTimes()).toEqual(originalTimes);
  expect(await page.locator('#fleet-rows td[data-col="gpuID"]').allTextContents()).toEqual(Array(6).fill("—"));
});

test.describe("hardware touch controls", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("hardware toggles expose full plain values on a narrow page without opening row details", async ({ page }) => {
    for (const column of columns) {
      await toggle(page, column.key).tap();
      await expect(toggle(page, column.key)).toHaveAttribute("data-mode", "expanded");
      await expect(cell(page, column.key)).toHaveText(column.expanded[0]);
      await toggle(page, column.key).tap();
      await expect(toggle(page, column.key)).toHaveAttribute("data-mode", "compact");
      await expect(cell(page, column.key)).toHaveText(column.compact[0]);
      await cell(page, column.key).locator("span.hardware-value").tap();
      await expect(page.getByRole("dialog")).toBeHidden();
      await expect(cell(page, column.key).getByRole("button")).toHaveCount(0);
    }
    await expect(page.locator('#column-headings th[data-col="pc"]')).toHaveAttribute("aria-sort", "ascending");
    await expectFleetDocumentFlow(page);
  });
});
