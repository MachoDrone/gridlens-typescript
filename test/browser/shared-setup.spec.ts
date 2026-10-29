import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 844 }]) {
  test(`one persistent computer selection and terminal-only sign-in at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    let phase = "select", revision = 1, selected: string[] = [];
    const computers = Array.from({ length: 40 }, (_, index) => ({ id: String(index).padStart(64, "a"), name: `Synthetic computer ${index + 1}`,
      host: `192.168.42.${index + 1}`, port: 22, fingerprint: "SHA256:" + "A".repeat(43) }));
    await page.route("**/setup", async route => route.fulfill({ contentType: "text/html", body: await readFile(resolve("dist/shared-setup.html"), "utf8") }));
    await page.route("**/shared-setup.js", async route => route.fulfill({ contentType: "text/javascript", body: await readFile(resolve("dist/preview/shared-setup.js"), "utf8") }));
    await page.route("**/api/shared/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/status")) { await route.fulfill({ json: { role: "operator", serverId: "synthetic-server" } }); return; }
      if (path.endsWith("/devices")) { await route.fulfill({ json: { devices: [] } }); return; }
      if (path.endsWith("/monitoring")) { await route.fulfill({ json: { pcs: [] } }); return; }
      if (path.endsWith("/setup-action")) {
        const body = route.request().postDataJSON() as { action: string; selected?: string[] };
        expect(Object.keys(body)).not.toContain("password");
        if (body.action === "select") { selected = body.selected!; phase = "identities"; }
        if (body.action === "trust") phase = "credentials";
        revision++;
      }
      await route.fulfill({ json: { revision, phase, computers, selected, trusted: [], automaticIp: true, fullMonitoring: false,
        exclusions: [], savedHosts: 0, inspectedPcs: 0, monitoringStatus: "Not configured" } });
    });
    await page.goto("/setup");
    await expect(page.getByRole("heading", { name: "Choose computers once" })).toBeVisible();
    const search = page.getByRole("searchbox", { name: "Find a computer" });
    await search.fill("42.12"); await expect(page.locator(".count")).toHaveText("0 selected · 1 matching computers");
    await page.getByRole("checkbox").check(); await search.fill("computer 2");
    await expect(page.locator(".count")).toHaveText("1 selected · 11 matching computers");
    await page.getByRole("button", { name: "Select matching computers" }).click();
    await expect(page.locator(".count")).toHaveText("12 selected · 11 matching computers");
    await search.fill(""); await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(12);
    const complete = page.getByRole("button", { name: "Selection complete" });
    await complete.focus(); await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Review new SSH identities" })).toBeVisible();
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await page.getByRole("button", { name: "Confirm these new identities" }).click();
    await expect(page.getByRole("heading", { name: "Sign in using the terminal" })).toBeVisible();
    await expect(page.locator("#step input")).toHaveCount(0);
    const bounds = await page.locator("main").boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
  });
}
