import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

async function connectPage(page: Page): Promise<void> {
  await page.route("**/connect", async route => route.fulfill({ contentType: "text/html", body: await readFile(resolve("dist/shared-setup.html"), "utf8") }));
  await page.route("**/shared-setup.js", async route => route.fulfill({ contentType: "text/javascript", body: await readFile(resolve("dist/preview/shared-setup.js"), "utf8") }));
}

test("private-network setup opens without codes, cookies or device pairing and keeps denial explicit", async ({ page }) => {
  await page.clock.install();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/setup", async route => route.fulfill({ contentType: "text/html", body:
    (await readFile(resolve("dist/shared-setup.html"), "utf8")).replace("</head>", '<meta name="gridlens-private-network" content="1"></head>') }));
  await page.route("**/shared-setup.js", async route => route.fulfill({ contentType: "text/javascript", body: await readFile(resolve("dist/preview/shared-setup.js"), "utf8") }));
  let denied = false; const paths: string[] = [];
  await page.route("**/api/shared/**", async route => {
    const path = new URL(route.request().url()).pathname; paths.push(path);
    expect(route.request().headers().authorization).toBeUndefined(); expect(route.request().headers().cookie).toBeUndefined();
    if (denied) { await route.fulfill({ status: 401, json: { error: "denied" } }); return; }
    if (path.endsWith("/status")) { await route.fulfill({ json: { role: "operator", serverId: "synthetic-server" } }); return; }
    if (path.endsWith("/monitoring")) { await route.fulfill({ json: { pcs: [] } }); return; }
    expect(path).toBe("/api/shared/setup");
    await route.fulfill({ json: { revision: 1, phase: "scan", computers: [], selected: [], trusted: [], automaticIp: false,
      fullMonitoring: false, exclusions: [], savedHosts: 0, inspectedPcs: 0, monitoringStatus: "Not configured" } });
  });
  await page.goto("/setup#code=oldlink_1234");
  await expect(page.getByRole("heading", { name: "Search from the backend computer" })).toBeVisible();
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByLabel("Connection code")).toBeHidden();
  await expect(page.getByRole("button", { name: "Connect another browser" })).toBeHidden();
  await page.clock.fastForward(600_000);
  await expect(page.getByRole("heading", { name: "Search from the backend computer" })).toBeVisible();
  denied = true; await page.clock.fastForward(3100);
  await expect(page.getByRole("status")).toHaveText("Private-network access is disabled. Contact the backend operator.");
  await expect(page.getByLabel("Connection code")).toBeHidden();
  expect(paths.every(path => !/login|pair|devices|revoke/.test(path))).toBe(true);
});

test("one-use sign-in link connects on mobile and clears its secret before the request", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await connectPage(page);
  const code = "synthetic_12", requests: { url: string; referer: string }[] = [];
  let logins = 0;
  page.on("request", request => requests.push({ url: request.url(), referer: request.headers().referer ?? "" }));
  await page.route("**/api/shared/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/login")) {
      logins++;
      expect(await page.evaluate(() => location.hash)).toBe("");
      expect(route.request().postDataJSON()).toEqual({ version: 1, code, deviceName: "Web browser" });
      await route.fulfill({ json: { serverId: "synthetic-server" } }); return;
    }
    expect(logins).toBe(1);
    await route.fulfill({ json: { role: "viewer", serverId: "synthetic-server" } });
  });
  await page.goto(`/connect#code=${code}`);
  await expect(page.getByRole("status")).toHaveText("Shared cache connected. Open Fleet to view authorized readings.");
  await expect(page.locator("#login")).toBeHidden();
  await expect(page).toHaveURL(/\/connect$/);
  expect(requests.every(request => !request.url.includes(code) && !request.referer.includes(code))).toBe(true);
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, state: history.state }))).not.toContain(code);
  await page.reload();
  await expect(page.locator("#login")).toBeHidden();
  expect(logins).toBe(1);
});

test("rejected link stays explained without retries and manual code entry still works", async ({ page }) => {
  await page.clock.install();
  await connectPage(page);
  const badCode = "expired_1234", goodCode = "current_1234";
  let logins = 0, statuses = 0;
  await page.route("**/api/shared/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/login")) {
      logins++;
      const body = route.request().postDataJSON() as { code: string; deviceName: string };
      if (body.code === badCode) { await route.fulfill({ status: 401, json: { error: "denied" } }); return; }
      expect(body).toEqual({ version: 1, code: goodCode, deviceName: "My browser" });
      await route.fulfill({ json: { serverId: "synthetic-server" } }); return;
    }
    statuses++; await route.fulfill({ json: { role: "viewer", serverId: "synthetic-server" } });
  });
  await page.goto(`/connect#code=${badCode}`);
  await expect(page.getByRole("status")).toContainText("expired, was already used, or is not valid");
  await page.clock.fastForward(15_000);
  await expect(page.getByRole("status")).toContainText("expired, was already used, or is not valid");
  expect(logins).toBe(1); expect(statuses).toBe(0);
  await expect(page.getByLabel("Connection code")).toHaveValue("");
  await page.getByLabel("Connection code").fill(goodCode);
  await page.getByLabel("Device name").fill("My browser");
  await page.getByRole("button", { name: "Connect", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#login")).toBeHidden();
  expect(logins).toBe(2); expect(statuses).toBe(1);
});

test("malformed sign-in fragment is cleared without sending or retrying a code", async ({ page }) => {
  await page.clock.install();
  await connectPage(page);
  let requests = 0;
  await page.route("**/api/shared/**", async route => { requests++; await route.fulfill({ status: 401, json: {} }); });
  await page.goto("/connect#code=bad&code=synthetic_12");
  await expect(page.getByRole("status")).toHaveText("This sign-in link is not valid. Run GridLens setup again and open its new sign-in link.");
  await expect(page).toHaveURL(/\/connect$/);
  await page.clock.fastForward(15_000);
  expect(requests).toBe(0);
});

test("connected operator creates a private browser link with its code only in the fragment", async ({ page }) => {
  await connectPage(page);
  const code = "viewer__1234";
  await page.route("**/api/shared/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/status")) { await route.fulfill({ json: { role: "operator", serverId: "synthetic-server" } }); return; }
    if (path.endsWith("/devices")) { await route.fulfill({ json: { devices: [] } }); return; }
    if (path.endsWith("/monitoring")) { await route.fulfill({ json: { pcs: [] } }); return; }
    if (path.endsWith("/pair-code")) { await route.fulfill({ json: { code, expiresAtMs: Date.now() + 300_000, serverId: "synthetic-server" } }); return; }
    await route.fulfill({ json: { revision: 1, phase: "scan", computers: [], selected: [], trusted: [], automaticIp: false,
      fullMonitoring: false, exclusions: [], savedHosts: 0, inspectedPcs: 0, monitoringStatus: "Not configured" } });
  });
  await page.goto("/connect");
  await page.getByRole("button", { name: "Connect another browser" }).click();
  const link = page.getByRole("link", { name: "Open GridLens on the other device" });
  await expect(link).toBeVisible();
  const address = new URL((await link.getAttribute("href"))!);
  expect(address.origin).toBe(new URL(page.url()).origin);
  expect(address.pathname).toBe("/connect"); expect(address.search).toBe(""); expect(address.hash).toBe(`#code=${code}`);
  await expect(page.locator("#pair-code")).toContainText("Keep this link private. It works once and expires at");
  await expect(page.locator("#pair-code")).not.toContainText(code);
  await expect(page.locator("#pair-code")).not.toContainText("synthetic-server");
});

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
