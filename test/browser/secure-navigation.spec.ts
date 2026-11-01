import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

async function fixture(page: Page): Promise<{ installed: boolean; secure: boolean }> {
  const mode = { installed: false, secure: false };
  await page.route("http://127.0.0.1:4174/**", async route => {
    if (route.request().resourceType() !== "document") { await route.continue(); return; }
    const response = await route.fetch(); let body = await response.text();
    if (mode.installed) body = body.replace("</head>", '<meta name="gridlens-shared-backend" content="1"><meta name="gridlens-updates" content="1"><meta name="gridlens-build-id" content="1:0.1.0-test"></head>');
    if (!mode.secure) body = body.replace('id="sidebar-secure"', 'id="sidebar-secure-baseline"');
    await route.fulfill({ response, body });
  });
  await page.route("**/api/shared/**", route => route.fulfill({ status: 401, json: {} }));
  return mode;
}
async function installOffer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const event = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(event, { prompt: async () => {}, userChoice: Promise.resolve({ outcome: "dismissed" }) });
    window.dispatchEvent(event);
  });
  await expect(page.getByRole("button", { name: "Install GridLens" })).toBeVisible();
}

for (const width of [1280, 390, 320]) test(`Secure fits beside Hosts, Update and Install without widening the menu at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await page.addInitScript(() => localStorage.setItem("gridlens.preview.sidebar.v1", "expanded"));
  const mode = await fixture(page); mode.secure = true;
  await page.goto("/?scenario=mixed"); await expect(page.locator("#sidebar-secure")).toBeHidden();
  mode.installed = true; mode.secure = false; await page.reload(); await installOffer(page);
  await expect(page.locator("#sidebar-hosts, #sidebar-update")).toHaveCount(2);
  const originalWidth = (await page.locator("#sidebar").boundingBox())!.width;
  mode.secure = true; await page.reload(); await installOffer(page);
  const secure = page.getByRole("link", { name: "Secure this device", exact: true });
  await expect(secure).toBeVisible(); await expect(secure).toHaveAttribute("href", "/secure-setup");
  await expect(secure).toHaveAttribute("title", "Secure this device"); await expect(secure.locator(".sidebar-label")).toHaveText("Secure");
  await expect.poll(async () => Math.abs((await page.locator("#sidebar").boundingBox())!.width - originalWidth)).toBeLessThanOrEqual(1);
  expect(await page.locator(".sidebar-navigation > *").evaluateAll(nodes => nodes.filter(node => !(node as HTMLElement).hidden).map(node => node.id || "alerts")))
    .toEqual(["sidebar-hosts", "sidebar-update", "sidebar-secure", "sidebar-install-app", "alerts"]);
  for (const collapsed of [false, true]) {
    if (collapsed) await page.getByRole("button", { name: "Collapse menu", exact: true }).click();
    const icon = secure.locator("svg"); await expect(icon).toBeVisible(); await expect(icon).toHaveAttribute("width", "20");
    const label = secure.locator(".sidebar-label"); if (collapsed) await expect(label).toBeHidden(); else await expect(label).toBeVisible();
    await expect.poll(async () => secure.evaluate(node => {
      const box = node.getBoundingClientRect(), rail = document.querySelector("#sidebar")!.getBoundingClientRect(), icon = node.querySelector("svg")!.getBoundingClientRect();
      return box.left >= rail.left && box.right <= rail.right + 1 && icon.left >= box.left && icon.right <= box.right + 1;
    })).toBe(true);
  }
  await expect.poll(async () => (await page.locator("#sidebar").boundingBox())!.width).toBeLessThanOrEqual(56.1);
  await page.route("**/secure-setup", async route => route.fulfill({ contentType: "text/html", body: await readFile(resolve("dist/secure-setup.html"), "utf8") }));
  await page.route("**/secure-setup/status.json", route => route.fulfill({ json: { version: 1, available: false, serverId: "synthetic" } }));
  await secure.focus(); await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/secure-setup$/); await expect(page.getByRole("heading", { name: "Secure this device", exact: true })).toBeVisible();
});

test("Secure remains reachable with the other actions in short touch menus", async ({ browser }) => {
  test.skip(browser.browserType().name() === "firefox", "Playwright Firefox has no isMobile emulation; physical Android verification is separate.");
  const context = await browser.newContext({ isMobile: true, hasTouch: true, viewport: { width: 320, height: 844 } });
  const page = await context.newPage();
  try {
    const mode = await fixture(page); mode.installed = true; mode.secure = true;
    await page.goto("http://127.0.0.1:4174/?scenario=mixed");
    const secure = page.getByRole("link", { name: "Secure this device", exact: true });
    await expect(secure).toBeVisible(); await expect(secure.locator(".sidebar-label")).toBeHidden();
    await page.getByRole("button", { name: "Expand menu", exact: true }).tap(); await expect(secure.locator(".sidebar-label")).toBeVisible();
    await installOffer(page); await page.setViewportSize({ width: 667, height: 240 });
    await secure.scrollIntoViewIfNeeded(); await expect(secure).toBeInViewport();
    const bounds = (await secure.boundingBox())!; expect(bounds.height).toBeGreaterThanOrEqual(24); expect(bounds.width).toBeGreaterThanOrEqual(24);
    await page.getByRole("button", { name: "Collapse menu", exact: true }).tap(); await expect(secure.locator("svg")).toBeVisible();
  } finally { await context.close(); }
});
