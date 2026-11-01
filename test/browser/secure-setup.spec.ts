import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BrowserSecurityStatus } from "../../src/contracts/browser-security.ts";

// These fixtures exercise browser behavior only. They do not establish OS certificate trust.
const HTTP = "http://192.168.50.2:8789", HTTPS = "https://192.168.50.2:9467";
const SERVER = "00000000-0000-4000-8000-000000000001", CA = "a".repeat(64), LEAF = "b".repeat(64);
const CONNECT_CODE = "syntheticHandoff".padEnd(43, "x");
type Metadata = Extract<BrowserSecurityStatus, { available: true }>;
function metadata(): Metadata {
  return { version: 1, available: true, serverId: SERVER, instance: "synthetic", httpOrigin: HTTP, httpsOrigin: HTTPS,
    trustMode: "private-ca", certificateSha256: CA, certificateValidFromMs: 1_700_000_000_000, certificateValidToMs: 2_000_000_000_000,
    serverCertificateSha256: LEAF, serverCertificateValidFromMs: 1_700_000_000_000, serverCertificateValidToMs: 2_000_000_000_000,
    status: "ready", certificateDownloadPath: "/secure-setup/ca.crt", canConnectBrowser: true };
}
interface Mode {
  value: BrowserSecurityStatus; secureValue: BrowserSecurityStatus | undefined; requests: { url: string; method: string }[];
  signedIn: boolean; statusCode: number; accessCode: number; downloads: number; logins: unknown[];
  downloadCode: number; downloadETag: string; downloadBody: string; downloadWait: Promise<void> | undefined;
  issued: number; issueStatus: number; redeems: unknown[]; redeemStatus: number; loseRedeemResponse: boolean;
  fleetEntry: boolean;
  secureStatusWait: Promise<void> | undefined;
}
async function fixture(page: Page): Promise<Mode> {
  const mode: Mode = { value: metadata(), secureValue: undefined, requests: [], signedIn: false, statusCode: 200, accessCode: 200, downloads: 0, logins: [],
    downloadCode: 200, downloadETag: `"${CA}"`, downloadBody: "-----BEGIN CERTIFICATE-----\nMAMCAQE=\n-----END CERTIFICATE-----\n", downloadWait: undefined,
    issued: 0, issueStatus: 200, redeems: [], redeemStatus: 200, loseRedeemResponse: false, fleetEntry: false, secureStatusWait: undefined };
  const assets: Record<string, string> = {
    "/preview/secure-setup.js": "preview/secure-setup.js", "/preview/secure-guides.js": "preview/secure-guides.js",
    "/contracts/browser-security.js": "contracts/browser-security.js", "/shared-setup.js": "preview/shared-setup.js", "/preview/webapp.js": "preview/webapp.js",
  };
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()); mode.requests.push({ url: url.href, method: request.method() });
    if (![HTTP, HTTPS].includes(url.origin)) throw new Error(`External request in isolated secure setup test: ${url.origin}`);
    if (url.pathname === "/secure-setup") {
      await route.fulfill({ contentType: "text/html", body: await readFile(resolve("dist/secure-setup.html"), "utf8") }); return;
    }
    if (url.pathname === "/secure-setup/status.json") {
      if (url.origin === HTTPS && mode.secureStatusWait) await mode.secureStatusWait;
      const value = url.origin === HTTPS ? mode.secureValue ?? mode.value : mode.value;
      await route.fulfill({ status: mode.statusCode, json: value.available && url.origin === HTTPS ? { ...value, canConnectBrowser: false } : value }); return;
    }
    if (url.pathname === "/secure-setup/connect-code") {
      expect(url.origin).toBe(HTTP); expect(request.method()).toBe("POST"); expect(request.postDataJSON()).toEqual({}); mode.issued++;
      await route.fulfill({ status: mode.issueStatus, json: mode.issueStatus === 200 ? { version: 1, code: CONNECT_CODE, expiresAtMs: Date.now() + 300_000 } : { error: "Fixture unavailable" } }); return;
    }
    if (url.pathname === "/secure-setup/connect") {
      expect(url.origin).toBe(HTTPS); expect(request.method()).toBe("POST"); mode.redeems.push(request.postDataJSON());
      if (mode.redeemStatus === 200) mode.signedIn = true;
      if (mode.loseRedeemResponse) { await route.abort("connectionreset"); return; }
      await route.fulfill({ status: mode.redeemStatus, json: mode.redeemStatus === 200 ? { version: 1, connected: true } : { error: "Fixture invalid connection" } }); return;
    }
    if (url.pathname === "/secure-setup/ca.crt") {
      mode.downloads++;
      expect(request.headers()["if-match"]).toBe(`"${CA}"`);
      if (mode.downloadWait) await mode.downloadWait;
      await route.fulfill({ status: mode.downloadCode, contentType: "application/x-x509-ca-cert", headers: { ETag: mode.downloadETag },
        body: mode.downloadCode === 200 ? mode.downloadBody : "" }); return;
    }
    if (url.pathname === "/api/shared/status") {
      await route.fulfill({ status: mode.accessCode !== 200 ? mode.accessCode : mode.signedIn ? 200 : 401,
        json: mode.signedIn ? { version: 1, serverId: SERVER, role: "viewer" } : { error: "Fixture access required" } }); return;
    }
    if (url.pathname === "/api/shared/login") {
      mode.logins.push(request.postDataJSON()); mode.signedIn = true;
      await route.fulfill({ json: { version: 1, serverId: SERVER, role: "viewer" } }); return;
    }
    if (url.pathname === "/connect") {
      await route.fulfill({ contentType: "text/html", body: await readFile(resolve("dist/shared-setup.html"), "utf8") }); return;
    }
    if (url.pathname === "/") {
      const body = mode.fleetEntry && url.origin === HTTP
        ? (await readFile(resolve("dist/index.html"), "utf8")).replace("</head>", '<meta name="gridlens-shared-backend" content="1"></head>')
        : "<h1>Synthetic Fleet</h1>";
      await route.fulfill({ contentType: "text/html", body }); return;
    }
    if (mode.fleetEntry && url.pathname === "/preview/connection.json") { await route.fulfill({ json: { status: "ok" } }); return; }
    if (mode.fleetEntry && url.pathname === "/preview/hosts.json") { await route.fulfill({ json: { addresses: [], error: null } }); return; }
    if (mode.fleetEntry && url.pathname === "/styles.css") { await route.fulfill({ contentType: "text/css", body: await readFile(resolve("dist/styles.css"), "utf8") }); return; }
    if (assets[url.pathname]) { await route.fulfill({ contentType: "text/javascript", body: await readFile(resolve("dist", assets[url.pathname]!), "utf8") }); return; }
    if (mode.fleetEntry && /^\/(?:preview|fleet|contracts)\/[a-z0-9-]+\.js$/.test(url.pathname)) {
      await route.fulfill({ contentType: "text/javascript", body: await readFile(resolve("dist", url.pathname.slice(1)), "utf8") }); return;
    }
    if (url.pathname === "/manifest.webmanifest" || url.pathname.startsWith("/icons/")) { await route.fulfill({ status: 404, body: "" }); return; }
    throw new Error(`Unexpected secure setup fixture route: ${url.pathname}`);
  });
  return mode;
}
async function begin(page: Page): Promise<void> {
  await page.goto(`${HTTP}/secure-setup`);
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await page.getByRole("checkbox", { name: "I am using my trusted private network or VPN." }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
}
async function chooseInstructions(page: Page, device: string, browser: string): Promise<void> {
  if (!await page.getByRole("combobox", { name: "Device", exact: true }).isVisible()) await page.locator("#device-choice > summary").click();
  await page.getByRole("combobox", { name: "Device", exact: true }).selectOption(device);
  await page.getByRole("combobox", { name: "Browser", exact: true }).selectOption(browser);
}
async function download(page: Page): Promise<void> {
  const waiting = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download certificate", exact: true }).click();
  const file = await waiting;
  expect(file.suggestedFilename()).toBe("gridlens-synthetic-aaaaaaaa-ca.crt");
  expect(file.url()).toMatch(/^blob:/);
  await page.getByRole("button", { name: "File saved — Next" }).click();
}
async function finishGuide(page: Page): Promise<void> {
  for (let step = 0; step < 8 && await page.locator("#guide-next").innerText() !== "I’ve imported it — Open GridLens"; step++) await page.locator("#guide-next").click();
  await expect(page.getByRole("button", { name: "I’ve imported it — Open GridLens", exact: true })).toBeVisible();
}
async function openHTTPS(page: Page): Promise<void> {
  const imported = page.getByRole("button", { name: "I’ve imported it — Open GridLens", exact: true });
  const supplied = page.getByRole("button", { name: "Open GridLens", exact: true });
  if (await imported.isVisible()) await imported.click();
  else if (await supplied.isVisible()) await supplied.click();
  else await page.getByRole("button", { name: "Already imported? Open GridLens", exact: true }).click();
  await expect.poll(() => new URL(page.url()).origin).toBe(HTTPS);
}
async function expectFleet(page: Page): Promise<void> {
  await expect(page).toHaveURL(`${HTTPS}/`);
  await expect(page.getByRole("heading", { name: "Synthetic Fleet" })).toBeVisible();
}

test("the installed Fleet Secure action leads through browser connection to the same HTTPS Fleet", async ({ page }) => {
  const mode = await fixture(page); mode.fleetEntry = true;
  await page.goto(`${HTTP}/?scenario=mixed`);
  await page.getByRole("link", { name: "Secure this device", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Use your trusted network" })).toBeVisible();
  expect(mode.issued).toBe(0);
  await page.getByRole("checkbox", { name: "I am using my trusted private network or VPN." }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await openHTTPS(page); await expectFleet(page);
  expect(mode.issued).toBe(1); expect(mode.redeems).toEqual([{ version: 1, code: CONNECT_CODE }]); expect(mode.logins).toEqual([]);
});

test("detected Linux Chrome uses the exact certificate-manager actions and opens GridLens directly after import", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36" }));
  const mode = await fixture(page); await begin(page);
  await expect(page.locator("#device-summary")).toHaveText("Linux · Chrome / Chromium");
  await expect(page.getByRole("combobox", { name: "Device", exact: true })).toBeHidden();
  await expect(page.getByRole("combobox", { name: "Browser", exact: true })).toBeHidden();
  await download(page);
  await expect(page.getByRole("heading", { name: "Manage certificates", exact: true })).toBeVisible();
  await expect(page.locator("#guide-instruction")).toHaveText("Open Chrome Settings and search for “Manage certificates”. Open that result.");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator("#guide-instruction")).toHaveText("In Certificate Manager, select Local certificates, then Installed by you under Custom.");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator("#guide-instruction")).toContainText("Under Trusted certificates, click Import.");
  await expect(page.locator("#guide-help")).not.toHaveAttribute("open");
  await expect(page.locator("#open-panel")).toHaveCount(0); expect(mode.issued).toBe(0);
  await openHTTPS(page); await expectFleet(page); expect(mode.issued).toBe(1);
  expect(mode.redeems).toEqual([{ version: 1, code: CONNECT_CODE }]);
});

test("Samsung is Android with optional brand guidance and four top-level device choices", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Linux; Android 15; SM-S921B) AppleWebKit/537.36 SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36" }));
  await fixture(page); await begin(page);
  await expect(page.locator("#device-summary")).toHaveText("Android · Samsung Internet");
  expect(await page.locator("#device option").evaluateAll(options => options.map(node => (node as HTMLOptionElement).value))).toEqual(["windows", "macos", "linux", "android"]);
  await expect(page.getByRole("combobox", { name: "Device", exact: true })).toBeHidden();
  await download(page); await expect(page.locator("#android-screen-help")).not.toHaveAttribute("open");
  await expect(page.locator("#android-screen-help p")).toBeHidden();
  await page.getByText("Different Android screen?", { exact: true }).click();
  await expect(page.locator("#android-screen-help p")).toContainText("Samsung Galaxy");
  await page.getByRole("button", { name: "Change instructions" }).click();
  await expect(page.getByRole("combobox", { name: "Device", exact: true })).toHaveValue("android");
});

test("legacy Samsung progress resumes as Android without restoring trust or issuing a link", async ({ page }) => {
  const progress = { version: 1, expected: { serverId: SERVER, instance: "synthetic", certificateSha256: CA, serverCertificateSha256: LEAF },
    device: "samsung", browser: "samsung", stage: "open", guideIndex: 5 };
  await page.addInitScript(value => { if (location.protocol === "http:") sessionStorage.setItem("gridlens.secure-setup.progress.v1", JSON.stringify(value)); }, progress);
  const mode = await fixture(page); await page.goto(`${HTTP}/secure-setup`);
  await expect(page.locator("#guide-step")).toContainText("Android · Samsung Internet");
  await expect(page.getByRole("button", { name: "I’ve imported it — Open GridLens", exact: true })).toBeVisible();
  expect(mode.issued).toBe(0); expect(mode.redeems).toEqual([]);
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem("gridlens.secure-setup.progress.v1")!));
  expect(saved.device).toBe("android"); expect(saved.stage).toBe("guide"); expect(saved).not.toHaveProperty("trusted");
  await openHTTPS(page); await expectFleet(page); expect(mode.redeems).toHaveLength(1);
});

test("legacy Samsung continuation preserves a strict memory-only handoff", async ({ page }) => {
  const mode = await fixture(page);
  const parameters = new URLSearchParams({ server: SERVER, instance: "synthetic", certificate: CA, leaf: LEAF, device: "samsung", browser: "chrome", connect: CONNECT_CODE });
  await page.goto(`${HTTPS}/secure-setup#${parameters}`);
  await expectFleet(page);
  const saved = await page.evaluate(() => sessionStorage.getItem("gridlens.secure-setup.progress.v1"));
  expect(saved).not.toContain(CONNECT_CODE); expect(JSON.parse(saved!).device).toBe("android");
  expect(mode.redeems).toEqual([{ version: 1, code: CONNECT_CODE }]);
  await page.goto(`${HTTPS}/secure-setup#${parameters}&device=android`);
  await expect(page.locator("#repair-message")).toContainText("link is invalid"); expect(mode.redeems).toHaveLength(1);
});

test("signed-out HTTPS has one Finish connecting route and public resume state never mints a link automatically", async ({ page }) => {
  const mode = await fixture(page); await page.goto(`${HTTPS}/secure-setup`);
  await expect(page.getByRole("link", { name: "Finish connecting", exact: true })).toHaveAttribute("href", `${HTTP}/secure-setup#resume=1`);
  await expect(page.locator("#pair-summary")).toHaveText("Finish connecting this browser to your GridLens dashboard.");
  await expect(page.locator("#recheck-session")).toBeHidden();
  await expect(page.locator("#pair-terminal")).toBeHidden(); expect(mode.issued).toBe(0); expect(mode.redeems).toEqual([]);
  await page.getByRole("link", { name: "Finish connecting", exact: true }).click();
  await expect(page.locator("#resume-panel")).toBeVisible(); await expect(page).toHaveURL(`${HTTP}/secure-setup`);
  expect(mode.issued).toBe(0); expect(mode.downloads).toBe(0);
  await expect(page.getByRole("combobox", { name: "Device", exact: true })).toBeHidden();
  await openHTTPS(page); await expectFleet(page); expect(mode.issued).toBe(1); expect(mode.redeems).toHaveLength(1);
});

test("HTTPS handoff cannot redeem in an insecure browser context", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "isSecureContext", { value: false }));
  const mode = await fixture(page);
  const parameters = new URLSearchParams({ server: SERVER, instance: "synthetic", certificate: CA, leaf: LEAF, device: "linux", browser: "chrome", connect: CONNECT_CODE });
  await page.goto(`${HTTPS}/secure-setup#${parameters}`);
  await expect(page.locator("#repair-message")).toContainText("does not report a secure connection");
  expect(mode.redeems).toEqual([]); expect(mode.requests.some(request => request.url.includes("/api/shared/"))).toBe(false);
  expect(page.url()).toBe(`${HTTPS}/secure-setup`);
});

for (const width of [1280, 390, 320]) test(`guided certificate setup connects HTTP to HTTPS after browser trust at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 }); const mode = await fixture(page);
  await begin(page); await chooseInstructions(page, "android", "chrome");
  await download(page);
  await expect(page.locator("#guide-instruction")).toContainText("Install a certificate");
  await page.reload(); await expect(page.locator("#guide-panel")).toBeVisible(); expect(mode.downloads).toBe(1);
  await finishGuide(page);
  expect(mode.requests.every(request => new URL(request.url).origin === HTTP && request.method === "GET")).toBe(true);
  expect(mode.requests.some(request => request.url.includes("/api/shared/"))).toBe(false);
  expect(mode.issued).toBe(0);
  await openHTTPS(page); await expectFleet(page);
  expect(mode.issued).toBe(1);
  expect(mode.logins).toEqual([]);
  expect(mode.redeems).toEqual([{ version: 1, code: CONNECT_CODE }]);
  await page.goto(`${HTTPS}/secure-setup`);
  await expect(page.getByRole("heading", { name: "Secure connection ready" })).toBeVisible();
  const stored = await page.evaluate(() => Object.fromEntries(Object.keys(sessionStorage).map(key => [key, sessionStorage.getItem(key)])));
  expect(JSON.stringify(stored)).not.toContain(CONNECT_CODE);
  expect(JSON.stringify(stored)).not.toMatch(/password|"verified"|"trusted"|"token"|"signedIn"/);
  expect(mode.requests.every(request => !request.url.includes(CONNECT_CODE))).toBe(true);
  const main = (await page.locator("main").boundingBox())!; expect(main.x).toBeGreaterThanOrEqual(0); expect(main.x + main.width).toBeLessThanOrEqual(width);
});

test("all offered device and browser guides lead to a real HTTPS check without automating settings", async ({ page }) => {
  test.setTimeout(60_000); const mode = await fixture(page); await begin(page);
  const cases: [string, string[]][] = [["windows", ["chrome", "edge", "firefox"]], ["macos", ["safari", "chrome", "edge", "firefox"]],
    ["linux", ["chrome", "edge", "firefox"]], ["android", ["chrome", "samsung", "edge", "firefox"]]];
  for (const [device, browsers] of cases) for (const browser of browsers) {
    if (!await page.locator("#device-panel").isVisible()) await page.getByRole("button", { name: "Change instructions" }).click();
    await chooseInstructions(page, device, browser);
    expect(await page.locator("#browser option").evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).toEqual(browsers);
    await download(page);
    const instructions: string[] = [];
    for (let step = 0; step < 8 && await page.locator("#guide-panel").isVisible(); step++) {
      instructions.push(await page.locator("#guide-instruction").innerText());
      if (await page.locator("#guide-next").innerText() === "I’ve imported it — Open GridLens") break;
      await page.locator("#guide-next").click();
    }
    const guide = instructions.join(" "); expect(guide).toContain("gridlens-synthetic-aaaaaaaa-ca.crt"); expect(guide).toMatch(/trust|intended/);
    if (device === "linux" && browser === "firefox") expect(guide).toContain("Authorities");
    if (device === "macos") expect(guide).toContain("Keychain Access");
    if (device === "android") expect(guide).toContain("CA certificate");
    await expect(page.locator("#guide-final-note")).toContainText("Do not bypass");
    await expect(page.locator("#open-panel")).toHaveCount(0);
  }
  expect(mode.downloads).toBe(14); expect(mode.requests.every(request => new URL(request.url).origin === HTTP)).toBe(true);
  expect(mode.requests.some(request => request.url.includes("/api/shared/"))).toBe(false);
});

test("supplied certificate skips CA import and rechecks even an existing browser session", async ({ page }) => {
  const mode = await fixture(page); mode.value = { ...metadata(), trustMode: "provided-certificate", certificateDownloadPath: null }; mode.signedIn = true;
  await begin(page); await expect(page.locator("#provided-help")).toBeVisible();
  await expect(page.getByRole("button", { name: "Already imported? Open GridLens" })).toBeHidden();
  await openHTTPS(page);
  await expectFleet(page); expect(mode.downloads).toBe(0);
  expect(mode.issued).toBe(1); expect(mode.redeems).toEqual([]);
  await page.goto(`${HTTPS}/secure-setup`); await expect(page.locator("#ready-panel")).toBeVisible();
  mode.accessCode = 401;
  await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })); window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); });
  await expect(page.locator("#pair-panel")).toBeVisible(); await expect(page.locator("#ready-panel")).toBeHidden(); expect(mode.redeems).toEqual([]);
});

test("HTTPS-only installations retain their separate terminal pairing fallback", async ({ page }) => {
  const mode = await fixture(page); mode.value = { ...metadata(), httpOrigin: null, canConnectBrowser: false };
  await page.goto(`${HTTPS}/secure-setup`);
  await expect(page.locator("#pair-terminal")).toBeVisible(); await expect(page.locator("#restart-http")).toBeHidden();
  await page.getByText("Advanced connection help", { exact: true }).click();
  await page.getByRole("link", { name: "Connect browser", exact: true }).click();
  await page.getByRole("textbox", { name: "Connection code", exact: true }).fill("fixture-code");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("#message")).toContainText("Shared cache connected");
  expect(mode.logins).toEqual([{ version: 1, code: "fixture-code", deviceName: "Web browser" }]);
  expect(mode.issued).toBe(0); expect(mode.redeems).toEqual([]);
});

for (const rejected of [403, 409, 410]) test(`a rejected ${rejected} browser connection discards its code and offers the saved HTTP guide`, async ({ page }) => {
  const mode = await fixture(page); mode.redeemStatus = rejected;
  await begin(page); await openHTTPS(page);
  await expect(page.locator("#pair-http")).toBeVisible(); await expect(page.locator("#pair-terminal")).toBeHidden();
  await expect(page.getByRole("link", { name: "Finish connecting", exact: true })).toHaveAttribute("href", `${HTTP}/secure-setup#resume=1`);
  expect(mode.redeems).toEqual([{ version: 1, code: CONNECT_CODE }]);
  await page.reload(); await expect(page.locator("#pair-panel")).toBeVisible(); expect(mode.redeems).toHaveLength(1);
  await page.getByRole("link", { name: "Finish connecting", exact: true }).click();
  await expect(page.locator("#resume-panel")).toBeVisible(); expect(mode.issued).toBe(1);
  mode.redeemStatus = 200; await openHTTPS(page); await expectFleet(page); expect(mode.issued).toBe(2);
});

test("a revoked HTTP grant cannot mint a link and a reload never recovers the one-use secret", async ({ page }) => {
  const mode = await fixture(page); mode.issueStatus = 403;
  await begin(page); await page.getByRole("button", { name: "Already imported? Open GridLens", exact: true }).click();
  await expect(page.locator("#repair-message")).toContainText("could not be created"); expect(page.url()).toBe(`${HTTP}/secure-setup`);
  expect(mode.redeems).toEqual([]); mode.issueStatus = 200;
  await page.getByRole("button", { name: "Check again", exact: true }).click();
  await page.getByRole("checkbox", { name: "I am using my trusted private network or VPN." }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  let release = () => {}; mode.secureStatusWait = new Promise<void>(resolve => { release = resolve; });
  await openHTTPS(page); await expect(page).toHaveURL(`${HTTPS}/secure-setup`);
  await page.reload(); release(); mode.secureStatusWait = undefined;
  await expect(page.locator("#pair-http")).toBeVisible(); expect(mode.redeems).toEqual([]);
  expect(await page.evaluate(() => JSON.stringify(history.state))).not.toContain(CONNECT_CODE);
  expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain(CONNECT_CODE);
});

test("a lost connection reply rechecks the installed session without redeeming twice", async ({ page }) => {
  const mode = await fixture(page); mode.loseRedeemResponse = true;
  await begin(page); await openHTTPS(page); await expectFleet(page); expect(mode.redeems).toHaveLength(1);
  await page.goto(`${HTTPS}/secure-setup`); await expect(page.locator("#ready-panel")).toBeVisible(); expect(mode.redeems).toHaveLength(1);
});

for (const changed of ["serverId", "certificateSha256", "serverCertificateSha256"] as const) test(`HTTPS ${changed} mismatch blocks pairing and resets public progress`, async ({ page }) => {
  const mode = await fixture(page); await begin(page);   mode.secureValue = { ...metadata(), [changed]: changed === "serverId" ? "different-installation" : "c".repeat(64) };
  await page.getByRole("button", { name: "Already imported? Open GridLens", exact: true }).click();
  await expect(page.locator("#repair-message")).toContainText("installation or certificate changed");
  expect(mode.requests.some(request => request.url.includes("/api/shared/"))).toBe(false);
  expect(await page.evaluate(() => sessionStorage.getItem("gridlens.secure-setup.progress.v1"))).toBeNull();
  await expect(page.locator("#pair-panel")).toBeHidden(); await expect(page.locator("#ready-panel")).toBeHidden();
});

for (const state of ["expired", "not-yet-valid"] as const) test(`a ${state} certificate gives repair guidance without a download or bypass`, async ({ page }) => {
  const mode = await fixture(page); mode.value = { ...metadata(), status: state };
  await page.goto(`${HTTP}/secure-setup`);
  await expect(page.locator("#repair-message")).toContainText(state === "expired" ? "expired" : "not valid yet");
  expect(mode.downloads).toBe(0); await expect(page.locator("#device-panel")).toBeHidden(); await expect(page.locator("#open-panel")).toBeHidden();
  mode.value = metadata(); await page.getByRole("button", { name: "Check again", exact: true }).click();
  await expect(page.locator("#trust-panel")).toBeVisible();
});

test("failed checks and changed certificates cannot reuse earlier confirmation", async ({ page }) => {
  const mode = await fixture(page); mode.signedIn = true; mode.accessCode = 503;
  await page.goto(`${HTTPS}/secure-setup`);
  await expect(page.locator("#repair-panel")).toBeVisible(); await expect(page.locator("#ready-panel")).toBeHidden();
  mode.accessCode = 200; await page.getByRole("button", { name: "Check again", exact: true }).click();
  await expect(page.locator("#ready-panel")).toBeVisible();
  mode.value = { ...metadata(), certificateSha256: "d".repeat(64) }; await page.reload();
  await expect(page.locator("#repair-message")).toContainText("certificate changed");
  await page.getByRole("button", { name: "Start again", exact: true }).click();
  await expect(page.locator("#ready-panel")).toBeVisible();
});

test("unavailable setup, malformed continuation and foreign endpoints fail closed", async ({ page }) => {
  const mode = await fixture(page); mode.value = { version: 1, available: false, serverId: SERVER };
  await page.goto(`${HTTP}/secure-setup`); await expect(page.locator("#repair-message")).toContainText("not prepared");
  mode.value = metadata(); await page.goto(`${HTTPS}/secure-setup#token=never-accept-this`);
  await expect(page.locator("#repair-message")).toContainText("link is invalid"); expect(page.url()).toBe(`${HTTPS}/secure-setup`);
  expect(mode.requests.some(request => request.url.includes("/api/shared/"))).toBe(false);
  await page.getByRole("button", { name: "Start again", exact: true }).click(); await expect(page.locator("#pair-panel")).toBeVisible();
  mode.value = { ...metadata(), httpsOrigin: "https://public.example:9467" }; await page.reload();
  await expect(page.locator("#repair-panel")).toBeVisible();
  expect(mode.requests.every(request => [HTTP, HTTPS].includes(new URL(request.url).origin))).toBe(true);
});

test("denied browser storage still supports setup without remembering trust", async ({ page }) => {
  await page.addInitScript(() => { Storage.prototype.getItem = () => { throw new Error("Storage denied"); }; Storage.prototype.setItem = () => { throw new Error("Storage denied"); }; Storage.prototype.removeItem = () => { throw new Error("Storage denied"); }; });
  const mode = await fixture(page); mode.signedIn = true;
  await begin(page); await openHTTPS(page); await expectFleet(page);
  await page.goto(`${HTTPS}/secure-setup`); await expect(page.locator("#ready-panel")).toBeVisible();
  expect(mode.redeems).toEqual([]);
});

for (const failure of ["rotated", "wrong-etag", "private-key", "oversized"] as const) test(`a ${failure} certificate download is never saved`, async ({ page }) => {
  const mode = await fixture(page); const saved: string[] = []; page.on("download", item => saved.push(item.suggestedFilename()));
  if (failure === "rotated") mode.downloadCode = 412;
  if (failure === "wrong-etag") mode.downloadETag = `"${"c".repeat(64)}"`;
  if (failure === "private-key") mode.downloadBody = "-----BEGIN PRIVATE KEY-----\nMAMCAQE=\n-----END PRIVATE KEY-----\n";
  if (failure === "oversized") mode.downloadBody = `-----BEGIN CERTIFICATE-----\n${"A".repeat(33000)}\n-----END CERTIFICATE-----\n`;
  await begin(page); await page.getByRole("button", { name: "Download certificate", exact: true }).click();
  await expect(page.locator("#repair-panel")).toBeVisible();
  if (failure === "rotated" || failure === "wrong-etag") await expect(page.locator("#repair-message")).toContainText("No file was saved");
  expect(saved).toEqual([]); expect(mode.downloads).toBe(1);
  await expect(page.locator("#download-panel")).toBeHidden();
});

test("leaving during a certificate download cancels saving and resume rechecks setup", async ({ page }) => {
  const mode = await fixture(page); const saved: string[] = []; page.on("download", item => saved.push(item.suggestedFilename()));
  let release = () => {}; mode.downloadWait = new Promise<void>(resolve => { release = resolve; });
  await begin(page); await page.getByRole("button", { name: "Download certificate", exact: true }).click();
  await expect.poll(() => mode.downloads).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  release(); mode.downloadWait = undefined;
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect(page.locator("#trust-panel")).toBeVisible();
  expect(saved).toEqual([]); await expect(page.locator("#download-panel")).toBeHidden();
});

for (const width of [320, 390]) test(`touch certificate guidance keeps controls reachable through rotation at ${width}px`, async ({ browser }) => {
  test.skip(browser.browserType().name() === "firefox", "Playwright Firefox has no isMobile emulation; physical Android verification is separate.");
  const context = await browser.newContext({ isMobile: true, hasTouch: true, viewport: { width, height: 844 } });
  const page = await context.newPage();
  try {
    await fixture(page); await begin(page); await chooseInstructions(page, "android", "chrome"); await download(page);
    for (const viewport of [{ width, height: 844 }, { width: 844, height: 390 }, { width: 667, height: 240 }]) {
      await page.setViewportSize(viewport); await page.locator("#guide-next").scrollIntoViewIfNeeded();
      const bounds = (await page.locator("#guide-next").boundingBox())!;
      expect(bounds.width).toBeGreaterThanOrEqual(44); expect(bounds.height).toBeGreaterThanOrEqual(44);
      expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
      const finalStep = await page.locator("#guide-next").innerText() === "I’ve imported it — Open GridLens";
      await page.locator("#guide-next").tap();
      if (finalStep) await expectFleet(page); else await expect(page.locator("#guide-panel")).toBeVisible();
    }
  } finally { await context.close(); }
});
