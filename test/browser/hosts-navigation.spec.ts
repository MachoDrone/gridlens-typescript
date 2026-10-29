import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

async function routeMode(page: Page, mode: { installed: boolean }): Promise<void> {
  await page.route("http://127.0.0.1:4174/**", async route => {
    if (route.request().resourceType() !== "document") { await route.continue(); return; }
    const response = await route.fetch(), original = await response.text();
    await route.fulfill({ response, body: mode.installed
      ? original.replace("</head>", '<meta name="gridlens-shared-backend" content="1"></head>') : original });
  });
  await page.route("**/api/shared/**", route => route.fulfill({ status: 401, json: {} }));
}

async function expectHostsFits(page: Page, labelVisible: boolean): Promise<void> {
  const hosts = page.getByRole("link", { name: "Hosts", exact: true });
  await expect(hosts).toBeVisible(); await expect(hosts).toHaveAttribute("href", "/setup");
  await expect(hosts).toHaveAttribute("title", "Hosts");
  await expect(hosts.locator("svg")).toBeVisible();
  if (labelVisible) await expect(hosts.locator(".sidebar-label")).toBeVisible();
  else await expect(hosts.locator(".sidebar-label")).toBeHidden();
  await expect.poll(async () => hosts.evaluate(node => {
    const link = node.getBoundingClientRect(), sidebar = document.querySelector("#sidebar")!.getBoundingClientRect(), icon = node.querySelector("svg")!.getBoundingClientRect();
    return link.left >= sidebar.left && link.right <= sidebar.right + 1 && icon.left >= link.left && icon.right <= link.right + 1;
  })).toBe(true);
}

for (const width of [1280, 390, 320]) test(`Hosts fits the existing left menu expanded and collapsed at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(() => localStorage.setItem("gridlens.preview.sidebar.v1", "expanded"));
  const mode = { installed: false }; await routeMode(page, mode);
  await page.goto("/?scenario=mixed");
  await expect(page.locator("html")).toHaveAttribute("data-sidebar", "expanded");
  await expect(page.locator("#sidebar-hosts")).toBeHidden();
  await page.waitForTimeout(220);
  const oldWidth = (await page.locator("#sidebar").boundingBox())!.width;
  mode.installed = true; await page.reload();
  await expectHostsFits(page, true);
  await expect.poll(async () => Math.abs((await page.locator("#sidebar").boundingBox())!.width - oldWidth)).toBeLessThanOrEqual(1);
  const hosts = page.getByRole("link", { name: "Hosts", exact: true });
  await expect(hosts).toHaveCount(1);
  await expect(page.locator(".sidebar-navigation").getByRole("link", { name: "Hosts", exact: true })).toBeVisible();
  await expect(page.locator("#shared-setup-actions, .shared-search-link")).toHaveCount(0);
  await expect(page.getByText("Add or change computers using the terminal setup.", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Scenario", { exact: true })).toHaveCount(0);
  await expect(page.locator(".scenario-controls")).toBeHidden();
  expect(await hosts.evaluate(node => getComputedStyle(node).backgroundColor)).toBe("rgb(24, 120, 62)");
  await page.getByRole("button", { name: "Collapse menu", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-sidebar", "collapsed");
  await expectHostsFits(page, false);
  await expect.poll(async () => (await page.locator("#sidebar").boundingBox())!.width).toBeLessThanOrEqual(56.1);
  await hosts.focus(); await expect(hosts).toBeFocused();
  await page.route("**/setup", route => route.fulfill({ contentType: "text/html", body: "<title>Hosts</title><h1>Hosts</h1>" }));
  await page.keyboard.press("Enter"); await expect(page).toHaveURL(/\/setup$/);
});

test("Hosts remains contained in narrow and zoomed menus while Scenario remains a usable preview selector", async ({ page }) => {
  const mode = { installed: false }; await routeMode(page, mode);
  await page.goto("/?scenario=mixed");
  const scenario = page.getByRole("combobox", { name: "Scenario", exact: true });
  await expect(scenario).toBeVisible(); await expect(page.getByText("Scenario", { exact: true })).toHaveCount(0);
  await scenario.selectOption("durations"); await expect(scenario).toHaveValue("durations");
  await expect(page.locator("#sidebar-hosts")).toBeHidden();
  mode.installed = true;
  await page.setViewportSize({ width: 160, height: 400 }); await page.goto("/?scenario=mixed");
  await expectHostsFits(page, false);
  await page.getByRole("button", { name: "Expand menu", exact: true }).click(); await expectHostsFits(page, true);
  await page.evaluate(() => { document.documentElement.style.zoom = "1.5"; });
  await expectHostsFits(page, true);
  await page.getByRole("button", { name: "Collapse menu", exact: true }).click(); await expectHostsFits(page, false);
});
