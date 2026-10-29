import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateKeyPairSync } from "node:crypto";

async function connectPage(page: Page): Promise<void> {
  await page.route("**/connect", async route => route.fulfill({ contentType: "text/html", body: await readFile(resolve("dist/shared-setup.html"), "utf8") }));
  await page.route("**/shared-setup.js", async route => route.fulfill({ contentType: "text/javascript", body: await readFile(resolve("dist/preview/shared-setup.js"), "utf8") }));
}

test("installed Fleet exposes Manage computers above the table on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("http://127.0.0.1:4174/", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace("</head>", '<meta name="gridlens-shared-backend" content="1"></head>') });
  });
  await page.route("**/api/shared/**", route => route.fulfill({ status: 401, json: {} }));
  await page.goto("/");
  const search = page.getByRole("link", { name: "Manage computers", exact: true });
  await expect(search).toBeVisible(); await expect(search).toHaveAttribute("href", "/setup");
  const action = await search.boundingBox(), table = await page.locator(".fleet-table-wrap").boundingBox();
  expect(action!.height).toBeGreaterThanOrEqual(44); expect(action!.y + action!.height).toBeLessThanOrEqual(table!.y);
  expect(action!.x + action!.width).toBeLessThanOrEqual(390);
  await search.focus(); await expect(search).toBeFocused();
});

for (const width of [1280, 390]) test(`terminal setup is read-only in the browser through every phase at ${width}px`, async ({ page }) => {
  await page.clock.install(); await page.setViewportSize({ width, height: 900 });
  let phase = "scan", revision = 1;
  const requests: string[] = [];
  await page.route("**/setup", async route => route.fulfill({ contentType: "text/html", body:
    (await readFile(resolve("dist/shared-setup.html"), "utf8")).replace("</head>", '<meta name="gridlens-private-network" content="1"><meta name="gridlens-setup-mode" content="terminal"></head>') }));
  await page.route("**/shared-setup.js", async route => route.fulfill({ contentType: "text/javascript", body: await readFile(resolve("dist/preview/shared-setup.js"), "utf8") }));
  await page.route("**/api/shared/**", async route => {
    expect(route.request().method()).toBe("GET");
    const path = new URL(route.request().url()).pathname; requests.push(path);
    if (path.endsWith("/status")) { await route.fulfill({ json: { role: "operator", serverId: "synthetic" } }); return; }
    if (path.endsWith("/monitoring")) { await route.fulfill({ json: { pcs: [] } }); return; }
    expect(path).toBe("/api/shared/setup");
    await route.fulfill({ json: { revision, phase, computers: [], selected: [], trusted: [], automaticIp: true, fullMonitoring: false,
      exclusions: phase === "done" ? ["Synthetic incomplete host excluded"] : [], savedHosts: phase === "done" ? 3 : 0,
      inspectedPcs: phase === "done" ? 2 : 0, monitoringStatus: "Automatic IP approved.", terminalConnected: true,
      network: { backendName: "fixture-backend", backendAddress: "192.168.42.10", suggestedRange: "192.168.42.0/24",
        verifiedAtMs: Date.now(), releaseTag: "modern-v0.1.0-dev.6" } } });
  });
  await page.goto("/setup");
  for (const next of ["scan", "scanning", "select", "identities", "credentials", "review", "inspecting"]) {
    phase = next; revision++; await page.clock.fastForward(3100);
    await expect(page.getByRole("heading", { name: "Finish setup in the terminal" })).toBeVisible();
    await expect(page.locator("#network-search")).toBeHidden();
    await expect(page.locator("#step input, #step button")).toHaveCount(0);
    await expect(page.locator("#login")).toBeHidden();
    await expect(page.locator("#step code")).toHaveText("bash <(curl -fsSL https://github.com/MachoDrone/gridlens-typescript/releases/download/modern-v0.1.0-dev.6/modern-start.sh) --vpn-web");
    await expect(page.locator("#step-description")).toContainText("Complete setup in one terminal");
  }
  phase = "done"; revision++; await page.clock.fastForward(3100);
  await expect(page.getByRole("heading", { name: "Fleet ready" })).toBeVisible();
  await expect(page.locator("#step-description")).toHaveText("3 hosts saved · 2 computers inspected");
  await expect(page.locator("#step summary")).toContainText("1 exclusions or incomplete checks");
  await expect(page.locator("#step").getByRole("link", { name: "Open Fleet" })).toHaveAttribute("href", "/");
  expect(requests.every(path => !/setup-action|login|pair|devices/.test(path))).toBe(true);
  const bounds = await page.locator("main").boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
});

for (const width of [1280, 390, 320]) test(`browser search, cancel, recovery and complete setup at ${width}px`, async ({ page }) => {
  await page.clock.install(); await page.setViewportSize({ width, height: 900 });
  const computers = [1, 2].map(number => ({ id: String(number).repeat(64), name: `Synthetic computer ${number}`,
    host: `192.168.42.${number + 1}`, port: 22, fingerprint: "SHA256:" + "A".repeat(43) }));
  let phase = "scan", revision = 1, selected: string[] = [], trusted: string[] = [], rows: typeof computers = [];
  let terminalConnected = false, savedHosts = 0, inspectedPcs = 0, exclusions: string[] = [], scans = 0;
  let scan: { range: string; port: number; total: number; completed: number; found: number; status: string } | undefined;
  const network = { backendName: "Synthetic backend", backendAddress: "192.168.42.10", suggestedRange: "192.168.42.0/24",
    verifiedAtMs: Date.now(), releaseTag: "modern-v0.1.0-dev.5" };
  const view = () => ({ revision, phase, computers: rows, selected, trusted, automaticIp: true, fullMonitoring: false,
    exclusions, savedHosts, inspectedPcs, monitoringStatus: savedHosts ? "Automatic IP approved. Other monitoring not approved." : "Not configured",
    terminalConnected, network, ...(scan ? { scan } : {}) });
  await page.route("**/setup", async route => route.fulfill({ contentType: "text/html", body:
    (await readFile(resolve("dist/shared-setup.html"), "utf8")).replace("</head>", '<meta name="gridlens-private-network" content="1"></head>') }));
  await page.route("**/shared-setup.js", async route => route.fulfill({ contentType: "text/javascript", body: await readFile(resolve("dist/preview/shared-setup.js"), "utf8") }));
  await page.route("**/api/shared/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/status")) { await route.fulfill({ json: { role: "operator", serverId: "synthetic" } }); return; }
    if (path.endsWith("/monitoring")) { await route.fulfill({ json: { pcs: [] } }); return; }
    if (path.endsWith("/setup-action")) {
      const body = route.request().postDataJSON() as { action: string; revision: number; range?: string; port?: number;
        selected?: string[]; automaticIp?: boolean; fullMonitoring?: boolean };
      expect(body.revision).toBe(revision); expect(Object.keys(body)).not.toContain("password");
      if (body.action === "scan") {
        expect(body.range).toBe("192.168.42.0/30"); expect(body.port).toBe(22); scans++; phase = "scanning"; exclusions = [];
        scan = { range: body.range!, port: body.port!, total: 4, completed: 0, found: 0, status: "running" };
      } else if (body.action === "cancel-scan") { phase = "scan"; scan = { ...scan!, status: "cancelled" }; }
      else if (body.action === "select") { selected = body.selected!; phase = "identities"; }
      else if (body.action === "trust") { trusted = [...selected]; phase = "credentials"; terminalConnected = false; }
      else if (body.action === "inspect") { expect(body.automaticIp).toBe(true); expect(body.fullMonitoring).toBe(false); phase = "inspecting"; }
      else throw new Error(`Unexpected synthetic action ${body.action}`);
      revision++;
    } else expect(path).toBe("/api/shared/setup");
    await route.fulfill({ json: view() });
  });
  await page.goto("/setup");
  const range = page.getByRole("textbox", { name: "Network or IP address" });
  await expect(range).toHaveValue("192.168.42.0/24");
  await expect(page.locator("#search-location")).toContainText("Synthetic backend (192.168.42.10)");
  await range.fill("192.168.42.0/30"); const original = await range.elementHandle();
  terminalConnected = true; revision++; await page.clock.fastForward(3100);
  await expect(range).toHaveValue("192.168.42.0/30"); await expect(range).toBeFocused();
  expect(await range.evaluate((node, prior) => node === prior, original)).toBe(true);
  await range.press("Enter"); await expect(page.getByRole("button", { name: "Cancel search" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Search network", exact: true })).toBeDisabled();
  await page.clock.fastForward(18_000); expect(scans).toBe(1);
  scan = { ...scan!, completed: 2, found: 1 }; await page.clock.fastForward(3100);
  await expect(page.locator("#scan-status")).toHaveText("2 of 4 addresses checked · 1 computers found");
  await page.getByRole("button", { name: "Cancel search" }).click();
  await expect(page.locator("#scan-status")).toContainText("Search cancelled");
  await page.getByRole("button", { name: "Search network", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cancel search" })).toBeVisible();
  phase = "select"; scan = { ...scan!, status: "complete", completed: 4, found: 0 }; revision++; await page.clock.fastForward(3100);
  await expect(page.locator("#scan-status")).toContainText("No SSH computers found");
  await expect(page.getByRole("button", { name: "Selection complete" })).toBeDisabled();
  await page.getByRole("button", { name: "Search network", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cancel search" })).toBeVisible();
  phase = "scan"; scan = { ...scan!, status: "failed" }; exclusions = ["Synthetic connection interrupted"]; revision++; await page.clock.fastForward(3100);
  await expect(page.locator("#scan-status")).toContainText("Search could not finish");
  await page.getByRole("button", { name: "Search network", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cancel search" })).toBeVisible();
  phase = "select"; rows = computers; scan = { ...scan!, status: "complete", completed: 4, found: 2 }; revision++; await page.clock.fastForward(3100);
  await expect(page.locator(".count")).toHaveText("0 selected · 2 matching computers");
  const filter = page.getByRole("searchbox", { name: "Find a computer" }); await filter.fill("42.2");
  await page.getByRole("checkbox").check(); await filter.fill("computer 2"); await expect(page.locator(".count")).toHaveText("1 selected · 1 matching computers");
  await page.getByRole("button", { name: "Selection complete" }).click(); await page.getByRole("button", { name: "Confirm these new identities" }).click();
  await expect(page.locator("#step")).toContainText("setup terminal is not connected");
  await expect(page.locator("#step code")).toContainText("/modern-v0.1.0-dev.5/modern-start.sh) --vpn-web");
  expect(await page.locator("#step input").count()).toBe(0);
  terminalConnected = true; phase = "review"; revision++; await page.clock.fastForward(3100);
  await page.getByRole("button", { name: "Inspect + automatic IP", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Inspecting computers" })).toBeVisible();
  phase = "done"; savedHosts = 3; inspectedPcs = 1; exclusions = ["Synthetic unresolved node excluded"]; revision++; await page.clock.fastForward(3100);
  await expect(page.getByRole("heading", { name: "Fleet saved" })).toBeVisible();
  await expect(page.locator("#step-description")).toHaveText("3 hosts saved · 1 computers inspected");
  await expect(page.locator("#scan-exclusions")).toBeEmpty();
  await expect(page.locator("#step summary")).toContainText("1 exclusions or incomplete checks");
  await expect(page.getByRole("button", { name: "Search network", exact: true })).toBeVisible();
  expect(scans).toBe(4);
  const bounds = await page.locator("main").boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
});

test("setup leaves range empty without a verified suggestion and preserves rejected search input", async ({ page }) => {
  await page.route("**/setup", async route => route.fulfill({ contentType: "text/html", body: await readFile(resolve("dist/shared-setup.html"), "utf8") }));
  await page.route("**/shared-setup.js", async route => route.fulfill({ contentType: "text/javascript", body: await readFile(resolve("dist/preview/shared-setup.js"), "utf8") }));
  await page.route("**/api/shared/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/status")) { await route.fulfill({ json: { role: "operator" } }); return; }
    if (path.endsWith("/devices")) { await route.fulfill({ json: { devices: [] } }); return; }
    if (path.endsWith("/monitoring")) { await route.fulfill({ json: { pcs: [] } }); return; }
    if (path.endsWith("/setup-action")) { await route.fulfill({ status: 400, json: {} }); return; }
    await route.fulfill({ json: { revision: 1, phase: "scan", computers: [], selected: [], trusted: [], automaticIp: true,
      fullMonitoring: false, exclusions: [], savedHosts: 0, inspectedPcs: 0, monitoringStatus: "Not configured" } });
  });
  await page.goto("/setup"); const input = page.getByRole("textbox", { name: "Network or IP address" });
  await expect(input).toHaveValue(""); await expect(page.locator("#network-suggestion")).toContainText("No network suggestion has been verified");
  await input.fill("8.8.8.8"); await page.getByRole("button", { name: "Search network", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Check the private IP"); await expect(input).toHaveValue("8.8.8.8");
  await expect(page.getByRole("button", { name: "Search network", exact: true })).toBeEnabled();
});

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

for (const width of [1280, 390, 320]) test(`browser PC manager adds, updates and removes computers without terminal handoff at ${width}px`, async ({ page }) => {
  await page.clock.install(); await page.setViewportSize({ width, height: 900 });
  const a = { id: "a".repeat(64), name: "Saved computer", host: "192.168.42.2", port: 22, fingerprint: "SHA256:" + "A".repeat(43) };
  const b = { id: "b".repeat(64), name: "New computer", host: "192.168.42.3", port: 22, fingerprint: "SHA256:" + "B".repeat(43) };
  let phase = "done", revision = 1, savedHosts = 2, computers = [a];
  let managed = [{ ...a, hostCount: 2, username: "fixture", hasSavedCredential: true, status: "approved" }];
  let scan: Record<string, unknown> | undefined, report: Record<string, unknown> | undefined;
  const configurations: Record<string, unknown>[] = [], removals: unknown[] = [];
  const view = () => ({ revision, phase, computers, managed, selected: [], trusted: [a.id], automaticIp: true, fullMonitoring: false,
    exclusions: [], savedHosts, inspectedPcs: managed.filter(pc => pc.status !== "revoked").length, monitoringStatus: "Approved",
    network: { backendName: "Synthetic backend", backendAddress: "192.168.42.10", suggestedRange: "192.168.42.0/24", verifiedAtMs: Date.now() },
    ...(scan ? { scan } : {}), ...(report ? { report } : {}) });
  await page.route("**/setup", async route => route.fulfill({ contentType: "text/html", body:
    (await readFile(resolve("dist/shared-setup.html"), "utf8")).replace("</head>", '<meta name="gridlens-private-network" content="1"><meta name="gridlens-setup-mode" content="browser"></head>') }));
  await page.route("**/shared-setup.js", async route => route.fulfill({ contentType: "text/javascript", body: await readFile(resolve("dist/preview/shared-setup.js"), "utf8") }));
  await page.route("**/api/shared/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/status")) { await route.fulfill({ json: { role: "operator" } }); return; }
    if (path.endsWith("/setup-action")) {
      const body = route.request().postDataJSON(); expect(body).toEqual({ revision, action: "scan", range: "192.168.42.0/30", port: 22 });
      phase = "scanning"; scan = { range: body.range, port: 22, total: 4, completed: 0, found: 0, status: "running" }; revision++;
    } else if (path.endsWith("/setup-configure")) {
      const body = route.request().postDataJSON(); expect(body.revision).toBe(revision); configurations.push(body);
      expect(body).not.toHaveProperty("privateKey"); expect(body).not.toHaveProperty("sudoPassword");
      phase = "inspecting"; report = { status: "running", total: 1, completed: 0, results: [] }; revision++;
    } else if (path.endsWith("/setup-remove")) {
      const body = route.request().postDataJSON(); expect(body).toEqual({ revision, pcId: a.id }); removals.push(body);
      managed = managed.map(pc => pc.id === a.id ? { ...pc, hostCount: 0, hasSavedCredential: false, status: "revoked" } : pc);
      savedHosts = 1; revision++;
    } else expect(path).toBe("/api/shared/setup");
    await route.fulfill({ json: view() });
  });
  await page.goto("/setup");
  await expect(page.locator("#pc-manager-summary")).toContainText("1 computer in the fleet");
  await expect(page.locator("#network-search")).toBeHidden();
  await expect(page.locator("#setup")).toBeHidden();
  await expect(page.locator("main")).not.toContainText("Run the latest GridLens installer");
  await page.getByRole("button", { name: "Find PCs on network", exact: true }).click();
  await page.getByLabel("Network or IP address", { exact: true }).fill("192.168.42.0/30");
  await page.getByRole("button", { name: "Search network", exact: true }).click();
  computers = [a, b]; phase = "select"; scan = { ...scan!, completed: 4, found: 2, status: "complete" }; revision++;
  await page.clock.fastForward(3100);
  await expect(page.locator("#scan-status")).toContainText("Select the PCs below, then choose Add Selected PCs.");
  const addSelected = page.getByRole("button", { name: "Add Selected PCs", exact: true });
  await expect(addSelected).toBeDisabled();
  expect(await addSelected.evaluate(node => !!(document.querySelector("#pc-list")!.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await page.locator(`[data-pc-id="${b.id}"]`).getByRole("checkbox").check();
  await expect(page.locator("#pc-signin")).toBeHidden();
  expect(configurations).toHaveLength(0);
  await addSelected.focus(); await page.keyboard.press("Enter");
  await expect(page.getByLabel("Computer username", { exact: true })).toBeFocused();
  await page.getByLabel("Computer username", { exact: true }).fill("fixture");
  await page.getByLabel("Computer password", { exact: true }).fill("generated-browser-password");
  await page.clock.fastForward(3100);
  await expect(page.getByLabel("Computer password", { exact: true })).toHaveValue("generated-browser-password");
  await expect(page.getByLabel("Also enable rewards and GPU monitoring")).toBeChecked();
  await page.getByRole("button", { name: "Set up selected computers", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Setting up computers…" })).toBeVisible();
  await expect(page.locator("#open-fleet-result")).toBeHidden();
  expect(configurations[0]).toEqual({ revision: revision - 1, selected: [b.id], username: "fixture", password: "generated-browser-password", fullMonitoring: true, restorePcIds: [] });
  await expect(page.getByLabel("Computer password", { exact: true })).toHaveValue("");
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain("generated-browser-password");
  managed.push({ ...b, hostCount: 1, username: "fixture", hasSavedCredential: true, status: "approved" });
  phase = "done"; savedHosts = 3; report = { status: "complete", total: 1, completed: 1, results: [{ pcId: b.id, name: b.name, status: "success", hosts: 1, message: "Verified and monitoring." }] }; revision++;
  await page.clock.fastForward(3100);
  await expect(page.getByRole("heading", { name: "Setup results", exact: true })).toBeVisible();
  await expect(page.locator("#pc-report-summary")).toHaveText("1 of 1 computers checked · 3 hosts in the fleet");
  await expect(page.locator("#pc-report-results .success")).toHaveText("Ready · 1 hosts");
  await expect(page.locator("#pc-report-next")).toContainText("Next: Open Fleet");
  await expect(page.locator("#open-fleet-result")).toBeVisible();
  await expect(page.locator("#open-fleet-result")).toHaveClass("primary-link");
  await expect(page.locator("#open-fleet-result")).toHaveAttribute("href", "/");
  await page.locator(`[data-pc-id="${a.id}"]`).getByRole("button", { name: "Update sign-in" }).click();
  await expect(page.getByLabel("Computer username", { exact: true })).toHaveValue("fixture");
  await expect(page.locator("#pc-signin-help")).toContainText("saved sign-in");
  await page.getByLabel("Also enable rewards and GPU monitoring").uncheck();
  await page.getByRole("button", { name: "Set up selected computers", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Setting up computers…" })).toBeVisible();
  expect(configurations[1]).not.toHaveProperty("password");
  expect(configurations[1]!.fullMonitoring).toBe(false);
  phase = "done"; report = { status: "complete", total: 1, completed: 1, results: [{ pcId: a.id, name: a.name, status: "success", hosts: 2, message: "Saved sign-in verified." }] }; revision++;
  await page.clock.fastForward(3100);
  const oldRow = page.locator(`[data-pc-id="${a.id}"]`);
  await oldRow.getByRole("button", { name: "Remove", exact: true }).click();
  await oldRow.getByRole("button", { name: "Keep computer" }).click(); expect(removals).toHaveLength(0);
  await oldRow.getByRole("button", { name: "Remove", exact: true }).click();
  await oldRow.getByRole("button", { name: "Remove computer", exact: true }).click();
  await expect(page.locator("#pc-manager-summary")).toContainText("1 computer in the fleet · 1 hosts saved");
  await expect(page.locator(`[data-pc-id="${a.id}"]`)).toHaveCount(0); expect(removals).toHaveLength(1);
  await page.getByLabel("Show removed computers").check();
  await page.locator(`[data-pc-id="${a.id}"]`).getByRole("button", { name: "Re-add computer" }).click();
  await expect(page.getByLabel(`Re-enable monitoring for ${a.name}`)).not.toBeChecked();
  await page.getByLabel(`Re-enable monitoring for ${a.name}`).check();
  await page.getByLabel("Computer password", { exact: true }).fill("generated-restored-password");
  await page.getByRole("button", { name: "Set up selected computers", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Setting up computers…" })).toBeVisible();
  expect(configurations[2]!.restorePcIds).toEqual([a.id]);
  await expect(page.getByLabel("Computer password", { exact: true })).toHaveValue("");
  const bounds = await page.locator("main").boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
});

test("browser manager clears rejected passwords and presents actionable failed-computer results", async ({ page }) => {
  await page.clock.install();
  const computer = { id: "c".repeat(64), name: "Unconfigured computer", host: "192.168.42.4", port: 22, fingerprint: "SHA256:" + "C".repeat(43) };
  let revision = 1, report: Record<string, unknown> | undefined;
  await page.route("**/setup", async route => route.fulfill({ contentType: "text/html", body:
    (await readFile(resolve("dist/shared-setup.html"), "utf8")).replace("</head>", '<meta name="gridlens-private-network" content="1"><meta name="gridlens-setup-mode" content="browser"></head>') }));
  await page.route("**/shared-setup.js", async route => route.fulfill({ contentType: "text/javascript", body: await readFile(resolve("dist/preview/shared-setup.js"), "utf8") }));
  await page.route("**/api/shared/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/status")) { await route.fulfill({ json: { role: "operator" } }); return; }
    if (path.endsWith("/setup-configure")) { await route.fulfill({ status: 400, json: { error: "Never expose this raw failure" } }); return; }
    expect(path).toBe("/api/shared/setup");
    await route.fulfill({ json: { revision, phase: "select", computers: [computer], managed: [], selected: [], trusted: [], automaticIp: false,
      fullMonitoring: false, exclusions: [], savedHosts: 0, inspectedPcs: 0, monitoringStatus: "Not configured", ...(report ? { report } : {}) } });
  });
  await page.goto("/setup"); await page.locator(`[data-pc-id="${computer.id}"]`).getByRole("checkbox").check();
  await page.getByRole("button", { name: "Add Selected PCs", exact: true }).click();
  await page.getByLabel("Computer username", { exact: true }).fill("fixture");
  await page.getByLabel("Computer password", { exact: true }).fill("generated-bad-password");
  await page.getByRole("button", { name: "Set up selected computers", exact: true }).click();
  await expect(page.locator("#message")).toContainText("Check the selected computers");
  await expect(page.getByLabel("Computer password", { exact: true })).toHaveValue("");
  await expect(page.locator("main")).not.toContainText("Never expose this raw failure");
  report = { status: "complete", total: 1, completed: 1, results: [{ pcId: computer.id, name: computer.name, status: "failed", hosts: 0, message: "Computer sign-in was rejected. Update the username or password and retry." }] }; revision++;
  await page.clock.fastForward(3100);
  await expect(page.locator("#pc-report-results .failure")).toHaveText("Failed · 0 hosts");
  await page.getByRole("button", { name: "Update sign-in and retry" }).click();
  await expect(page.getByLabel("Computer password", { exact: true })).toBeFocused();
  await expect(page.getByLabel("Computer username", { exact: true })).toHaveValue("fixture");
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain("generated-bad-password");
});

for (const width of [390, 320]) test(`SSH key sign-in is explicit and clears key, passphrase and administrator password at ${width}px`, async ({ page }) => {
  await page.clock.install(); await page.setViewportSize({ width, height: 900 });
  const pc = { id: "d".repeat(64), name: "Key computer", host: "192.168.42.5", port: 22, fingerprint: "SHA256:" + "D".repeat(43) };
  const passphrase = "generated-key-passphrase", sudoPassword = "generated-administrator-password";
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem", cipher: "aes-256-cbc", passphrase },
    publicKeyEncoding: { type: "pkcs1", format: "pem" } }).privateKey;
  let phase = "select", revision = 1, report: Record<string, unknown> | undefined, saved = false;
  const requests: Record<string, unknown>[] = [];
  const view = () => ({ revision, phase, computers: [pc], managed: saved ? [{ ...pc, hostCount: 1, username: "fixture", hasSavedCredential: true, status: "approved" }] : [],
    selected: [], trusted: [], automaticIp: true, fullMonitoring: true, exclusions: [], savedHosts: saved ? 1 : 0, inspectedPcs: saved ? 1 : 0,
    monitoringStatus: saved ? "Monitoring approved." : "Not configured", ...(report ? { report } : {}) });
  await page.route("**/setup", async route => route.fulfill({ contentType: "text/html", body:
    (await readFile(resolve("dist/shared-setup.html"), "utf8")).replace("</head>", '<meta name="gridlens-private-network" content="1"><meta name="gridlens-setup-mode" content="browser"></head>') }));
  await page.route("**/shared-setup.js", async route => route.fulfill({ contentType: "text/javascript", body: await readFile(resolve("dist/preview/shared-setup.js"), "utf8") }));
  await page.route("**/api/shared/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/status")) { await route.fulfill({ json: { role: "operator" } }); return; }
    if (path.endsWith("/setup-configure")) {
      const body = route.request().postDataJSON(); requests.push(body); expect(body).not.toHaveProperty("password");
      phase = "inspecting"; report = { status: "running", total: 1, completed: 0, results: [] }; revision++;
    } else expect(path).toBe("/api/shared/setup");
    await route.fulfill({ json: view() });
  });
  await page.goto("/setup");
  await page.locator(`[data-pc-id="${pc.id}"]`).getByRole("checkbox").check();
  await page.getByRole("button", { name: "Add Selected PCs", exact: true }).click();
  await page.getByLabel("Computer username", { exact: true }).fill("fixture");
  await page.getByRole("combobox", { name: "Sign-in method", exact: true }).selectOption("key");
  await expect(page.getByLabel("Computer password", { exact: true })).toBeHidden();
  await page.getByLabel("SSH private key file", { exact: true }).setInputFiles({ name: "fixture-key.pem", mimeType: "application/octet-stream", buffer: Buffer.from(privateKey) });
  await page.getByLabel("SSH key passphrase (optional)", { exact: true }).fill(passphrase);
  await page.getByText("Administrator access", { exact: true }).click();
  await page.getByLabel("Computer administrator password (if required)", { exact: true }).fill(sudoPassword);
  await expect(page.getByLabel("Also enable rewards and GPU monitoring")).toBeChecked();
  await page.getByRole("button", { name: "Set up selected computers", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Setting up computers…" })).toBeVisible();
  expect(requests[0]).toEqual({ revision: 1, selected: [pc.id], username: "fixture", privateKey, passphrase, sudoPassword, fullMonitoring: true, restorePcIds: [] });
  for (const id of ["pc-password", "pc-key-file", "pc-key-passphrase", "pc-key-sudo-password"]) await expect(page.locator(`#${id}`)).toHaveValue("");
  await expect(page.locator("#open-fleet-result")).toBeHidden();
  const state = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, url: location.href, html: document.documentElement.outerHTML }));
  for (const secret of [privateKey, passphrase, sudoPassword]) expect(state).not.toContain(secret);
  saved = true; phase = "done"; report = { status: "complete", total: 1, completed: 1, results: [{ pcId: pc.id, name: pc.name, status: "success", hosts: 1, message: "Ready." }] }; revision++;
  await page.clock.fastForward(3100);
  await expect(page.locator("#open-fleet-result")).toBeVisible();
  await expect(page.locator("#pc-report-next")).toContainText("Next: Open Fleet");
  await page.locator(`[data-pc-id="${pc.id}"]`).getByRole("button", { name: "Update sign-in", exact: true }).click();
  await expect(page.locator("#pc-signin-help")).toContainText("saved sign-in");
  await page.getByRole("button", { name: "Set up selected computers", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Setting up computers…" })).toBeVisible();
  expect(requests[1]).not.toHaveProperty("privateKey"); expect(requests[1]).not.toHaveProperty("passphrase"); expect(requests[1]).not.toHaveProperty("sudoPassword");
  const bounds = await page.locator("main").boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
});

test("SSH key file bounds and method changes prevent an unintended credential upload", async ({ page }) => {
  const pc = { id: "e".repeat(64), name: "Generated PC", host: "192.168.42.6", port: 22, fingerprint: "SHA256:" + "E".repeat(43) };
  let configured = 0;
  await page.route("**/setup", async route => route.fulfill({ contentType: "text/html", body:
    (await readFile(resolve("dist/shared-setup.html"), "utf8")).replace("</head>", '<meta name="gridlens-private-network" content="1"><meta name="gridlens-setup-mode" content="browser"></head>') }));
  await page.route("**/shared-setup.js", async route => route.fulfill({ contentType: "text/javascript", body: await readFile(resolve("dist/preview/shared-setup.js"), "utf8") }));
  await page.route("**/api/shared/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/status")) { await route.fulfill({ json: { role: "operator" } }); return; }
    if (path.endsWith("/setup-configure")) configured++;
    await route.fulfill({ json: { revision: 1, phase: "select", computers: [pc], managed: [], selected: [], trusted: [], automaticIp: true, fullMonitoring: true,
      exclusions: [], savedHosts: 0, inspectedPcs: 0, monitoringStatus: "Not configured" } });
  });
  await page.goto("/setup"); await page.locator(`[data-pc-id="${pc.id}"]`).getByRole("checkbox").check();
  await page.getByRole("button", { name: "Add Selected PCs", exact: true }).click();
  await page.getByLabel("Computer username", { exact: true }).fill("fixture");
  await page.getByRole("combobox", { name: "Sign-in method", exact: true }).selectOption("key");
  await page.getByLabel("SSH private key file", { exact: true }).setInputFiles({ name: "oversized.key", mimeType: "application/octet-stream", buffer: Buffer.alloc(64 * 1024 + 1, 65) });
  await page.getByRole("button", { name: "Set up selected computers", exact: true }).click();
  expect(configured).toBe(0); await expect(page.locator("#message")).toContainText("no larger than 64 KB");
  await page.getByLabel("SSH key passphrase (optional)", { exact: true }).fill("generated-passphrase");
  await page.getByRole("combobox", { name: "Sign-in method", exact: true }).selectOption("password");
  await expect(page.locator("#pc-key-file")).toHaveValue(""); await expect(page.locator("#pc-key-passphrase")).toHaveValue("");
  await expect(page.getByLabel("Computer password", { exact: true })).toBeVisible();
  expect(configured).toBe(0);
  await page.getByRole("combobox", { name: "Sign-in method", exact: true }).selectOption("key");
  for (const file of [{ name: "public.pub", contents: "ssh-ed25519 AAAA generated-public-fixture" },
    { name: "wallet.json", contents: "[1,2,3,4]" }]) {
    await page.getByLabel("SSH private key file", { exact: true }).setInputFiles({ name: file.name, mimeType: "application/octet-stream", buffer: Buffer.from(file.contents) });
    await page.getByRole("button", { name: "Set up selected computers", exact: true }).click();
    await expect(page.locator("#message")).toContainText("not a .pub public key or wallet file");
    await expect(page.locator("#pc-key-file")).toHaveValue("");
    expect(configured).toBe(0);
  }
});
