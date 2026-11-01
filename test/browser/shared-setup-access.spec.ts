import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createServer } from "node:https";

// Generated loopback TLS exercises real redirect/navigation behavior, not OS trust.
test.use({ ignoreHTTPSErrors: true });
const entryCleanup: (() => Promise<void>)[] = [];
test.afterEach(async () => { for (const cleanup of entryCleanup.splice(0).reverse()) await cleanup(); });

const origin = "https://192.168.50.2:9467";
async function fixture(page: Page, permission: boolean | undefined) {
  const pc = { id: "a".repeat(64), name: "Saved computer", host: "192.168.50.3", port: 22, fingerprint: `SHA256:${"A".repeat(43)}` };
  const mode = { permission, calls: [] as string[], scans: 0 };
  const view = { revision: 1, phase: "done", computers: [pc], managed: [{ ...pc, hostCount: 1, username: "fixture", hasSavedCredential: true, status: "approved" }],
    selected: [], trusted: [pc.id], automaticIp: true, fullMonitoring: false, exclusions: [], savedHosts: 1, inspectedPcs: 1, monitoringStatus: "Approved",
    network: { backendName: "Synthetic backend", backendAddress: "192.168.50.2", suggestedRange: "192.168.50.0/24", verifiedAtMs: Date.now() } };
  await page.clock.install();
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) throw new Error("External request in isolated setup access test.");
    if (url.pathname === "/setup") {
      const body = (await readFile(resolve("dist/shared-setup.html"), "utf8")).replace("</head>", '<meta name="gridlens-setup-mode" content="browser"></head>');
      await route.fulfill({ contentType: "text/html", body }); return;
    }
    if (url.pathname === "/shared-setup.js" || url.pathname === "/preview/webapp.js" || url.pathname === "/contracts/browser-security.js") {
      await route.fulfill({ contentType: "text/javascript", body: await readFile(resolve("dist", url.pathname === "/shared-setup.js" ? "preview/shared-setup.js" : url.pathname.slice(1)), "utf8") }); return;
    }
    if (url.pathname === "/manifest.webmanifest" || url.pathname.startsWith("/icons/")) { await route.fulfill({ status: 404, body: "" }); return; }
    mode.calls.push(url.pathname);
    if (url.pathname === "/api/shared/status") { await route.fulfill({ json: { version: 1, serverId: "synthetic", role: "operator", ...(mode.permission === undefined ? {} : { canManageDevices: mode.permission }) } }); return; }
    if (url.pathname === "/api/shared/setup") { await route.fulfill({ json: view }); return; }
    if (url.pathname === "/api/shared/setup-action") {
      expect(request.postDataJSON().action).toBe("scan"); mode.scans++; await route.fulfill({ json: { ...view, phase: "scanning", revision: 2,
        scan: { range: "192.168.50.0/30", port: 22, total: 4, completed: 0, found: 0, status: "running" } } }); return;
    }
    if (["/api/shared/devices", "/api/shared/pair-code", "/api/shared/revoke"].includes(url.pathname)) {
      if (mode.permission === false) { await route.fulfill({ status: 403, json: {} }); return; }
      await route.fulfill({ json: url.pathname.endsWith("/devices") ? { devices: [{ deviceId: "other-browser", name: "Paired browser", role: "viewer", revokedAtMs: null }] }
        : url.pathname.endsWith("/pair-code") ? { code: "fixture-code", expiresAtMs: Date.now() + 300_000 } : { revoked: true } }); return;
    }
    throw new Error(`Unexpected setup request: ${url.pathname}`);
  });
  return mode;
}

test("a gateway-derived HTTPS operator keeps PC setup without independent device administration", async ({ page }) => {
  const mode = await fixture(page, false); await page.goto(`${origin}/setup`);
  await expect(page.locator("#pc-manager")).toBeVisible(); await expect(page.locator("#pc-manager-summary")).toContainText("1 computer in the fleet");
  await expect(page.locator("#devices")).toBeHidden(); await expect(page.locator("#new-code")).toBeDisabled();
  await expect(page.locator("main")).not.toContainText("Run the latest GridLens installer");
  await page.getByRole("button", { name: "Find PCs on network", exact: true }).click();
  await page.getByLabel("Network or IP address", { exact: true }).fill("192.168.50.0/30");
  await page.getByRole("button", { name: "Search network", exact: true }).click();
  await expect(page.locator("#scan-status")).toHaveText("0 of 4 addresses checked · 0 computers found"); expect(mode.scans).toBe(1);
  await page.locator("#new-code").evaluate(button => (button as HTMLButtonElement).click());
  await page.clock.fastForward(3100); await expect(page.locator("#pc-manager")).toBeVisible();
  expect(mode.calls.some(path => /\/(?:devices|pair-code|revoke)$/.test(path))).toBe(false);
  await expect(page.locator("#message")).not.toContainText("sign-in link");
});

for (const capability of [true, undefined]) test(`independent and legacy operator device access remains available (${String(capability)})`, async ({ page }) => {
  const mode = await fixture(page, capability); await page.goto(`${origin}/setup`);
  await expect(page.locator("#devices")).toBeVisible(); await expect(page.locator("#device-list")).toContainText("Paired browser");
  await page.getByRole("button", { name: "Connect another browser" }).click(); await expect(page.locator("#pair-code a")).toBeVisible();
  expect(mode.calls).toContain("/api/shared/pair-code");
  mode.permission = false; await page.clock.fastForward(3100);
  await expect(page.locator("#devices")).toBeHidden(); await expect(page.locator("#device-list")).toBeEmpty(); await expect(page.locator("#pair-code")).toBeEmpty();
  await expect(page.locator("#pc-manager")).toBeVisible();
  const previous = mode.calls.length; await page.locator("#new-code").evaluate(button => (button as HTMLButtonElement).click());
  expect(mode.calls.slice(previous).some(path => /\/(?:devices|pair-code|revoke)$/.test(path))).toBe(false);
});

const publicMetadata = (httpsOrigin = origin) => ({ version: 1, available: true, serverId: "synthetic", instance: "synthetic",
  httpsOrigin, httpOrigin: `http://${new URL(httpsOrigin).hostname}:8789`, trustMode: "private-ca", certificateSha256: "a".repeat(64),
  certificateValidFromMs: 1_700_000_000_000, certificateValidToMs: 2_000_000_000_000, serverCertificateSha256: "b".repeat(64),
  serverCertificateValidFromMs: 1_700_000_000_000, serverCertificateValidToMs: 2_000_000_000_000,
  status: "ready", certificateDownloadPath: "/secure-setup/ca.crt", canConnectBrowser: false });

async function signedOutEntry(page: Page) {
  const mode = { origin: "", signedIn: false, deniedStatus: 401, metadata: undefined as unknown, metadataStatus: 200, metadataReads: 0,
    statusWait: undefined as Promise<void> | undefined, metadataWait: undefined as Promise<void> | undefined,
    loginStatus: 200, logins: [] as unknown[], requests: [] as { method: string; url: string }[] };
  const assets: Record<string, string> = { "/shared-setup.js": "preview/shared-setup.js", "/preview/webapp.js": "preview/webapp.js",
    "/contracts/browser-security.js": "contracts/browser-security.js", "/preview/secure-setup.js": "preview/secure-setup.js", "/preview/secure-guides.js": "preview/secure-guides.js" };
  const directory = await mkdtemp(join(tmpdir(), "gridlens-https-entry-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", join(directory, "key.pem"),
    "-out", join(directory, "cert.pem"), "-days", "1", "-subj", "/CN=Generated loopback entry fixture", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  const server = createServer({ key: await readFile(join(directory, "key.pem")), cert: await readFile(join(directory, "cert.pem")) }, (request, response) => {
    void (async () => {
    const url = new URL(request.url!, mode.origin); mode.requests.push({ method: request.method!, url: url.href });
    const send = (code: number, contentType: string, body: string, headers: Record<string, string> = {}) => {
      response.writeHead(code, { "Content-Type": contentType, "Cache-Control": "no-store", ...headers }); response.end(body);
    };
    const json = (code: number, value: unknown) => send(code, "application/json", JSON.stringify(value));
    if (assets[url.pathname]) { send(200, "text/javascript", await readFile(resolve("dist", assets[url.pathname]!), "utf8")); return; }
    if (["/connect", "/setup"].includes(url.pathname)) {
      send(200, "text/html", (await readFile(resolve("dist/shared-setup.html"), "utf8"))
        .replace("</head>", '<meta name="gridlens-setup-mode" content="browser"></head>')); return;
    }
    if (url.pathname === "/") {
      if (!mode.signedIn) send(302, "text/html", "", { Location: "/connect" });
      else send(200, "text/html", "<h1>Authorized Fleet</h1>");
      return;
    }
    if (url.pathname === "/secure-setup") { send(200, "text/html", await readFile(resolve("dist/secure-setup.html"), "utf8")); return; }
    if (url.pathname === "/secure-setup/status.json") { mode.metadataReads++; await mode.metadataWait; json(mode.metadataStatus, mode.metadata); return; }
    if (url.pathname === "/api/shared/status") {
      await mode.statusWait;
      json(mode.signedIn ? 200 : mode.deniedStatus, mode.signedIn ? { version: 1, serverId: "synthetic", role: "viewer" } : {}); return;
    }
    if (url.pathname === "/api/shared/login") {
      let body = ""; for await (const chunk of request) body += String(chunk);
      mode.logins.push(JSON.parse(body));
      if (mode.loginStatus === 200) mode.signedIn = true;
      json(mode.loginStatus, mode.signedIn ? { version: 1, serverId: "synthetic", role: "viewer" } : {}); return;
    }
    send(404, "text/plain", "Not found");
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  entryCleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await rm(directory, { recursive: true, force: true }); });
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  mode.origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`; mode.metadata = publicMetadata(mode.origin);
  // Even an unexpected browser request cannot leave the isolated loopback origin.
  await page.route("**/*", route => new URL(route.request().url()).origin === mode.origin ? route.continue() : route.abort("blockedbyclient"));
  return mode;
}

for (const path of ["/", "/connect", "/setup"]) test(`signed-out HTTPS entry ${path} resumes the guide without browser authentication`, async ({ page }) => {
  const mode = await signedOutEntry(page); if (path === "/setup") mode.deniedStatus = 403;
  await page.goto(`${mode.origin}${path}`);
  await expect(page).toHaveURL(`${mode.origin}/secure-setup`);
  await expect(page.locator("#https-address")).toHaveText(mode.origin);
  await expect(page.locator("#login-form")).toHaveCount(0);
  expect(mode.metadataReads).toBeGreaterThanOrEqual(2); // Entry validates first; guide independently revalidates.
  expect(mode.requests.every(request => request.method === "GET" && new URL(request.url).origin === mode.origin)).toBe(true);
  expect(await page.context().cookies()).toEqual([]);
  await page.reload(); await expect(page).toHaveURL(`${mode.origin}/secure-setup`);
  await expect(page.locator("#https-address")).toHaveText(mode.origin);
  expect(mode.logins).toEqual([]);
});

test("a PWA start URL reload after session loss follows the actual signed-out root and connect pages", async ({ page }) => {
  const mode = await signedOutEntry(page); mode.signedIn = true;
  await page.goto(`${mode.origin}/`); await expect(page.getByRole("heading", { name: "Authorized Fleet" })).toBeVisible();
  mode.signedIn = false; await page.reload();
  await expect(page).toHaveURL(`${mode.origin}/secure-setup`); await expect(page.locator("#https-address")).toHaveText(mode.origin);
  expect(mode.requests.some(request => new URL(request.url).pathname === "/connect")).toBe(true);
  expect(mode.requests.some(request => request.method === "POST")).toBe(false);
  expect(await page.context().cookies()).toEqual([]);
});

test("no-code HTTPS entry keeps the legacy form hidden throughout delayed access and metadata checks", async ({ page }) => {
  const mode = await signedOutEntry(page);
  let releaseStatus!: () => void, releaseMetadata!: () => void;
  mode.statusWait = new Promise<void>(done => { releaseStatus = done; });
  mode.metadataWait = new Promise<void>(done => { releaseMetadata = done; });
  await page.goto(`${mode.origin}/connect`);
  await expect(page.locator("#message")).toHaveText("Checking access…");
  await expect(page.locator("#login-form")).toBeHidden(); expect(mode.metadataReads).toBe(0);
  releaseStatus(); await expect.poll(() => mode.metadataReads).toBe(1);
  await expect(page.locator("#login-form")).toBeHidden();
  releaseMetadata(); await expect(page).toHaveURL(`${mode.origin}/secure-setup`);
  await expect(page.locator("#login-form")).toHaveCount(0); expect(mode.logins).toEqual([]);
});

test("failed metadata restores the deliberate legacy fallback after the hidden checking state", async ({ page }) => {
  const mode = await signedOutEntry(page); mode.metadataStatus = 404;
  let release!: () => void; mode.metadataWait = new Promise<void>(done => { release = done; });
  await page.goto(`${mode.origin}/setup`); await expect.poll(() => mode.metadataReads).toBe(1);
  await expect(page.locator("#login-form")).toBeHidden();
  release(); await expect(page.locator("#login-form")).toBeVisible();
  await expect(page.locator("#message")).toContainText("enter its connection code below");
});

test("an unavailable backend does not flash a code form during no-code HTTPS entry", async ({ page }) => {
  const mode = await signedOutEntry(page); mode.deniedStatus = 503;
  await page.goto(`${mode.origin}/connect`);
  await expect(page.locator("#message")).toContainText("Backend unavailable");
  await expect(page.locator("#login-form")).toBeHidden(); expect(mode.metadataReads).toBe(0);
});

for (const state of ["unprepared", "missing", "wrong-origin", "expired", "https-only", "unavailable"] as const)
  test(`signed-out entry preserves legacy fallback when secure metadata is ${state}`, async ({ page }) => {
    const mode = await signedOutEntry(page);
    if (state === "unprepared") mode.metadata = { version: 1, available: false, serverId: "synthetic" };
    if (state === "missing") mode.metadataStatus = 404;
    if (state === "wrong-origin") mode.metadata = { ...publicMetadata(mode.origin), httpsOrigin: "https://127.0.0.1:9468" };
    if (state === "expired") mode.metadata = { ...publicMetadata(mode.origin), status: "expired" };
    if (state === "https-only") mode.metadata = { ...publicMetadata(mode.origin), httpOrigin: null };
    if (state === "unavailable") mode.metadataStatus = 503;
    await page.goto(`${mode.origin}/connect`);
    await expect(page.locator("#message")).toContainText("enter its connection code below");
    await expect(page.locator("#login-form")).toBeVisible(); await expect(page).toHaveURL(`${mode.origin}/connect`);
    expect(mode.metadataReads).toBe(1); expect(mode.requests.some(request => request.method === "POST")).toBe(false);
  });

test("valid terminal fragments keep first priority over available guided setup", async ({ page }) => {
  const mode = await signedOutEntry(page), code = "synthetic_12";
  await page.goto(`${mode.origin}/connect#code=${code}`);
  await expect(page.locator("#message")).toHaveText("Shared cache connected. Open Fleet to view authorized readings.");
  await expect(page).toHaveURL(`${mode.origin}/connect`); await expect(page.locator("#login")).toBeHidden();
  expect(mode.logins).toEqual([{ version: 1, code, deviceName: "Web browser" }]); expect(mode.metadataReads).toBe(0);
  expect(mode.requests.every(request => !request.url.includes(code))).toBe(true);
  await page.reload(); await expect(page.locator("#login")).toBeHidden(); expect(mode.logins).toHaveLength(1); expect(mode.metadataReads).toBe(0);
});

for (const fragment of ["#code=synthetic_12", "#code=bad&code=synthetic_12"]) test(`rejected supplied terminal fragment stays explicit (${fragment})`, async ({ page }) => {
  const mode = await signedOutEntry(page); mode.loginStatus = 401;
  await page.goto(`${mode.origin}/connect${fragment}`);
  await expect(page.locator("#message")).toContainText(fragment.includes("&") ? "not valid" : "expired");
  await expect(page).toHaveURL(`${mode.origin}/connect`); await expect(page.locator("#login-form")).toBeVisible();
  expect(mode.metadataReads).toBe(0); expect(mode.logins).toHaveLength(fragment.includes("&") ? 0 : 1);
});
