import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BROWSER_ASSETS } from "../../src/server/browser-assets.ts";

const privateOrigin = "http://192.168.50.2:8789";
async function privateHttp(page: Page): Promise<string[]> {
  const requests: string[] = [];
  await page.route("**/*", async route => {
    const url = new URL(route.request().url()); requests.push(url.href);
    if (url.origin !== privateOrigin) throw new Error(`Unexpected external fixture request: ${url.origin}`);
    if (url.pathname === "/preview/connection.json") { await route.fulfill({ json: { status: "ok" } }); return; }
    if (url.pathname === "/preview/hosts.json") { await route.fulfill({ json: { addresses: [], error: null } }); return; }
    const asset = BROWSER_ASSETS[url.pathname as keyof typeof BROWSER_ASSETS];
    if (!asset) throw new Error(`Unexpected private fixture request: ${url.pathname}`);
    await route.fulfill({ contentType: asset[1], body: await readFile(resolve("dist", asset[0])) });
  });
  return requests;
}

async function offerInstall(page: Page, outcome: "accepted" | "dismissed" | "failure" = "dismissed"): Promise<void> {
  await page.evaluate(outcome => {
    const event = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(event, {
      prompt: async () => {
        const root = document.documentElement;
        root.dataset.installPromptCalls = String(Number(root.dataset.installPromptCalls ?? "0") + 1);
        if (outcome === "failure") throw new Error("Isolated browser installation failure");
      },
      userChoice: Promise.resolve({ outcome: outcome === "failure" ? "dismissed" : outcome }),
    });
    window.dispatchEvent(event);
  }, outcome);
}

async function fleetRemainsUsable(page: Page, rows: number): Promise<void> {
  expect(await page.locator("#fleet-rows tr").count()).toBe(rows);
  const toggle = page.locator("#sidebar-toggle"), previous = await toggle.getAttribute("aria-expanded");
  await toggle.click(); await expect(toggle).toHaveAttribute("aria-expanded", previous === "true" ? "false" : "true");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
}

test("the same-origin app retains valid installability metadata without offering HTTPS setup", async ({ page, context }) => {
  const external: string[] = [];
  await page.route("**/*", async route => {
    if (new URL(route.request().url()).origin !== "http://127.0.0.1:4174") {
      external.push(route.request().url()); await route.abort(); return;
    }
    await route.continue();
  });
  await page.goto("/?scenario=mixed");
  await expect(page.locator("#sidebar-install-app")).toBeHidden();
  const client = await context.newCDPSession(page);
  const manifestResult = await client.send("Page.getAppManifest");
  expect(manifestResult.errors).toEqual([]);
  expect(new URL(manifestResult.url).origin).toBe("http://127.0.0.1:4174");
  const manifest = JSON.parse(manifestResult.data!);
  expect(manifest.name).toBe("GridLens"); expect(manifest.display).toBe("standalone");
  for (const field of ["id", "scope", "start_url"]) expect(new URL(manifest[field], manifestResult.url).href).toBe("http://127.0.0.1:4174/");
  await expect.poll(async () => (await client.send("Page.getInstallabilityErrors")).installabilityErrors).toEqual([]);
  expect(await page.evaluate(() => navigator.serviceWorker.getRegistrations().then(records => records.length))).toBe(0);
  await expect(page.locator("#webapp-install-dialog")).toHaveCount(0);
  expect(external).toEqual([]);
});

test("private HTTP has no Install action, certificate instructions or automatic HTTPS navigation", async ({ page }) => {
  const requests = await privateHttp(page);
  await page.goto(`${privateOrigin}/?scenario=mixed`);
  expect(await page.evaluate(() => isSecureContext)).toBe(false);
  await expect(page.locator("#sidebar-install-app")).toBeHidden();
  const rows = await page.locator("#fleet-rows tr").count();
  await offerInstall(page);
  await expect(page.locator("#sidebar-install-app")).toBeHidden();
  // Even a programmatic click cannot manufacture an install offer on an insecure origin.
  await page.locator("#sidebar-install-app").evaluate(button => (button as HTMLButtonElement).click());
  await expect(page.locator("html")).not.toHaveAttribute("data-install-prompt-calls");
  expect(page.url()).toBe(`${privateOrigin}/?scenario=mixed`);
  expect(requests.every(url => new URL(url).origin === privateOrigin)).toBe(true);
  await expect(page.locator("#webapp-install-dialog")).toHaveCount(0);
  await fleetRemainsUsable(page, rows);
});

for (const outcome of ["dismissed", "failure"] as const) test(`browser installation ${outcome} leaves Fleet usable and waits for a new offer`, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/?scenario=mixed");
  await expect(page.locator("#sidebar-install-app")).toBeHidden();
  const rows = await page.locator("#fleet-rows tr").count(), address = page.url();
  await offerInstall(page, outcome);
  await expect(page.locator("#sidebar-install-app")).toBeVisible();
  await page.locator("#sidebar-install-app").click();
  await expect(page.locator("html")).toHaveAttribute("data-install-prompt-calls", "1");
  await expect(page.locator("#sidebar-install-app")).toBeHidden();
  await expect(page.locator("#sidebar-install-app")).toBeEnabled();
  expect(page.url()).toBe(address);
  await fleetRemainsUsable(page, rows);
  await offerInstall(page);
  await expect(page.locator("#sidebar-install-app")).toBeVisible();
  expect(errors).toEqual([]);
});

test("accepting installation and appinstalled hide the redundant action", async ({ page }) => {
  await page.goto("/?scenario=mixed");
  await offerInstall(page, "accepted");
  await page.locator("#sidebar-install-app").click();
  await expect(page.locator("#sidebar-install-app")).toBeHidden();
  await expect(page.locator("#sidebar-install-app")).toBeEnabled();
  await offerInstall(page);
  await expect(page.locator("#sidebar-install-app")).toBeHidden();
  await page.reload();
  await offerInstall(page);
  await expect(page.locator("#sidebar-install-app")).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
  await expect(page.locator("#sidebar-install-app")).toBeHidden();
});

test("installed standalone mode never exposes an install offer", async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = query => {
      const result = original(query);
      if (query === "(display-mode: standalone)") Object.defineProperty(result, "matches", { value: true });
      return result;
    };
  });
  await page.goto("/?scenario=mixed");
  await offerInstall(page);
  await expect(page.locator("#sidebar-install-app")).toBeHidden();
  await expect(page.locator("#fleet-rows tr")).not.toHaveCount(0);
});

test("only a valid offered action is exposed and remains reachable on a narrow phone", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/?scenario=mixed");
  await page.evaluate(() => window.dispatchEvent(new Event("beforeinstallprompt", { cancelable: true })));
  await expect(page.locator("#sidebar-install-app")).toBeHidden();
  await offerInstall(page);
  const button = page.locator("#sidebar-install-app");
  await expect(button).toBeVisible(); await expect(button).toBeInViewport();
  const bounds = (await button.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(321);
  expect(bounds.y).toBeGreaterThanOrEqual(0); expect(bounds.y + bounds.height).toBeLessThanOrEqual(641);
  await button.click(); await expect(button).toBeHidden();
});
