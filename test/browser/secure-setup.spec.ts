import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createServer as createHTTPServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHTTPSServer } from "node:https";
import type { BrowserSecurityStatus } from "../../src/contracts/browser-security.ts";

// These fixtures exercise browser behavior only. They do not establish OS certificate trust.
const HTTP = "http://192.168.50.2:8789", HTTPS = "https://192.168.50.2:9467";
const SERVER = "00000000-0000-4000-8000-000000000001", CA = "a".repeat(64), LEAF = "b".repeat(64);
const CONNECT_CODE = "syntheticHandoff".padEnd(43, "x");
const PROFILE_PATH = `/secure-setup/apple-ca/${CA}.mobileconfig`;
const PROFILE_BODY = "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>PayloadType</key><string>Configuration</string></dict></plist>";
// WebKit does not emit a native attachment download for route.fulfill here.
// Only these two download cases use real loopback responses. Ignoring their
// generated test TLS certificate is fixture transport, never OS trust evidence.
const nativeProfileTest = test.extend<{ nativeProfileOrigin: (protocol: "http:" | "https:") => Promise<string> }>({
  ignoreHTTPSErrors: true,
  nativeProfileOrigin: async ({}, use) => {
    const servers: (ReturnType<typeof createHTTPServer> | ReturnType<typeof createHTTPSServer>)[] = [];
    const directories: string[] = [];
    try {
      await use(async protocol => {
        const respond = (request: IncomingMessage, response: ServerResponse): void => {
          if (request.method !== "GET" || request.url !== PROFILE_PATH) { response.writeHead(404).end(); return; }
          response.writeHead(200, { "Content-Type": "application/x-apple-aspen-config", "Content-Length": Buffer.byteLength(PROFILE_BODY),
            "Cache-Control": "no-store", ETag: `"${CA}"`, "Content-Disposition": 'attachment; filename="gridlens-synthetic-aaaaaaaa-ca.mobileconfig"' });
          response.end(PROFILE_BODY);
        };
        let server: typeof servers[number];
        if (protocol === "https:") {
          const directory = await mkdtemp(join(tmpdir(), "gridlens-profile-download-")); directories.push(directory);
          execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", join(directory, "key.pem"),
            "-out", join(directory, "cert.pem"), "-days", "1", "-subj", "/CN=Generated loopback profile fixture", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
          server = createHTTPSServer({ key: await readFile(join(directory, "key.pem")), cert: await readFile(join(directory, "cert.pem")) }, respond);
        } else server = createHTTPServer(respond);
        servers.push(server);
        await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
        return `${protocol}//127.0.0.1:${(server.address() as { port: number }).port}`;
      });
    } finally {
      for (const server of servers) {
        server.closeAllConnections();
        await new Promise<void>(done => server.close(() => done()));
      }
      for (const directory of directories) await rm(directory, { recursive: true, force: true });
    }
  },
});
type Metadata = Extract<BrowserSecurityStatus, { available: true }>;
function metadata(): Metadata {
  return { version: 1, available: true, serverId: SERVER, instance: "synthetic", httpOrigin: HTTP, httpsOrigin: HTTPS,
    trustMode: "private-ca", certificateSha256: CA, certificateValidFromMs: 1_700_000_000_000, certificateValidToMs: 2_000_000_000_000,
    serverCertificateSha256: LEAF, serverCertificateValidFromMs: 1_700_000_000_000, serverCertificateValidToMs: 2_000_000_000_000,
    status: "ready", certificateDownloadPath: "/secure-setup/ca.crt", canConnectBrowser: true };
}
interface Mode {
  value: BrowserSecurityStatus; secureValue: BrowserSecurityStatus | undefined; requests: { url: string; method: string }[];
  signedIn: boolean; statusCode: number; accessCode: number; downloads: number; profiles: number; logins: unknown[];
  downloadCode: number; downloadETag: string; downloadBody: string; downloadWait: Promise<void> | undefined;
  issued: number; issueStatus: number; redeems: unknown[]; redeemStatus: number; loseRedeemResponse: boolean;
  fleetEntry: boolean;
  secureStatusWait: Promise<void> | undefined;
}
async function fixture(page: Page, nativeProfileOrigin?: string): Promise<Mode> {
  const mode: Mode = { value: metadata(), secureValue: undefined, requests: [], signedIn: false, statusCode: 200, accessCode: 200, downloads: 0, profiles: 0, logins: [],
    downloadCode: 200, downloadETag: `"${CA}"`, downloadBody: "-----BEGIN CERTIFICATE-----\nMAMCAQE=\n-----END CERTIFICATE-----\n", downloadWait: undefined,
    issued: 0, issueStatus: 200, redeems: [], redeemStatus: 200, loseRedeemResponse: false, fleetEntry: false, secureStatusWait: undefined };
  const assets: Record<string, string> = {
    "/preview/secure-setup.js": "preview/secure-setup.js", "/preview/secure-guides.js": "preview/secure-guides.js",
    "/contracts/browser-security.js": "contracts/browser-security.js", "/shared-setup.js": "preview/shared-setup.js", "/preview/webapp.js": "preview/webapp.js",
    "/fleet/host-metadata.js": "fleet/host-metadata.js",
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
    if (url.pathname === PROFILE_PATH) {
      expect(request.method()).toBe("GET"); expect(request.isNavigationRequest()).toBe(true);
      expect(url.search).toBe(""); mode.profiles++;
      if (nativeProfileOrigin) {
        expect(new URL(nativeProfileOrigin).protocol).toBe(url.protocol);
        await route.continue({ url: nativeProfileOrigin + PROFILE_PATH }); return;
      }
      await route.fulfill({ contentType: "application/x-apple-aspen-config", headers: { ETag: `"${CA}"`,
        "Content-Disposition": 'attachment; filename="gridlens-synthetic-aaaaaaaa-ca.mobileconfig"' },
      body: PROFILE_BODY }); return;
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
    if (url.pathname === "/wallet") { await route.fulfill({ contentType: "text/html", body: "<h1>Synthetic Wallet</h1>" }); return; }
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

test("Secure completes the existing browser handoff and returns to Wallet without storing owner authority", async ({ page }) => {
  const mode = await fixture(page);
  await page.goto(`${HTTP}/secure-setup#return=wallet`);
  await expect(page).toHaveURL(`${HTTP}/secure-setup`);
  await page.getByRole("checkbox", { name: "I am using my trusted private network or VPN." }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await openHTTPS(page);
  await expect(page).toHaveURL(`${HTTPS}/wallet`); await expect(page.getByRole("heading", { name: "Synthetic Wallet" })).toBeVisible();
  expect(mode.issued).toBe(1); expect(mode.redeems).toEqual([{ version: 1, code: CONNECT_CODE }]);
  expect(await page.evaluate(() => sessionStorage.getItem("gridlens.secure-setup.return.v1"))).toBeNull();
  expect(mode.requests.some(request => request.url.includes("ticket="))).toBe(false);
});

test("an already connected HTTPS browser returns directly to Wallet without repeating the guide", async ({ page }) => {
  const mode = await fixture(page); mode.signedIn = true;
  await page.goto(`${HTTPS}/secure-setup#return=wallet`);
  await expect(page).toHaveURL(`${HTTPS}/wallet`); expect(mode.issued).toBe(0); expect(mode.redeems).toHaveLength(0);
});

for (const target of ["https://attacker.invalid/", "//attacker.invalid/", "wallet&return=wallet"]) test(`Secure rejects an unrecognized or repeated return target ${target}`, async ({ page }) => {
  const mode = await fixture(page); mode.signedIn = true;
  await page.goto(`${HTTPS}/secure-setup#return=${target}`);
  await expect(page).toHaveURL(`${HTTPS}/secure-setup`);
  await expect(page.locator("#repair-message")).toContainText("invalid");
  expect(mode.issued).toBe(0); expect(mode.redeems).toHaveLength(0);
});

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
  await expect(page.locator("#guide-instruction")).toHaveText("Open this browser’s Settings and search for “Manage certificates”. Open that result.");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator("#guide-instruction")).toHaveText("In Certificate Manager, select Local certificates, then Installed by you under Custom.");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator("#guide-instruction")).toContainText("Under Trusted certificates, click Import.");
  await expect(page.locator("#guide-help")).not.toHaveAttribute("open");
  await expect(page.locator("#open-panel")).toHaveCount(0); expect(mode.issued).toBe(0);
  await openHTTPS(page); await expectFleet(page); expect(mode.issued).toBe(1);
  expect(mode.redeems).toEqual([{ version: 1, code: CONNECT_CODE }]);
});

test("Samsung stays under Android alongside the separate Apple device choice", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Linux; Android 15; SM-S921B) AppleWebKit/537.36 SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36" }));
  await fixture(page); await begin(page);
  await expect(page.locator("#device-summary")).toHaveText("Android · Samsung Internet");
  expect(await page.locator("#device option").evaluateAll(options => options.map(node => (node as HTMLOptionElement).value))).toEqual(["windows", "macos", "linux", "android", "ios"]);
  await expect(page.getByRole("combobox", { name: "Device", exact: true })).toBeHidden();
  await download(page); await expect(page.locator("#android-screen-help")).not.toHaveAttribute("open");
  await expect(page.locator("#android-screen-help p")).toBeHidden();
  await page.getByText("Different Android screen?", { exact: true }).click();
  await expect(page.locator("#android-screen-help p")).toContainText("Samsung Galaxy");
  await page.getByRole("button", { name: "Change instructions" }).click();
  await expect(page.getByRole("combobox", { name: "Device", exact: true })).toHaveValue("android");
});

async function emulateApple(page: Page, chrome = false): Promise<void> {
  await page.addInitScript(isChrome => {
    Object.defineProperty(navigator, "userAgent", { value: isChrome
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/130.0 Mobile/15E148 Safari/604.1"
      : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15" });
    Object.defineProperty(navigator, "platform", { value: isChrome ? "iPhone" : "MacIntel" });
    Object.defineProperty(navigator, "maxTouchPoints", { value: 5 });
  }, chrome);
}

nativeProfileTest("desktop-mode iPad uses a real fingerprint-bound profile link before separate install and full-trust steps", async ({ page, nativeProfileOrigin }) => {
  await emulateApple(page); const mode = await fixture(page, await nativeProfileOrigin("http:")); await begin(page);
  await expect(page.locator("#device-summary")).toHaveText("iPhone / iPad · Safari");
  const link = page.getByRole("link", { name: "Download certificate profile", exact: true });
  const url = `${HTTP}/secure-setup/apple-ca/${CA}.mobileconfig`;
  await expect(link).toHaveAttribute("href", url); await expect(link).not.toHaveAttribute("download");
  await expect(page.locator("#download-approval-notice")).toBeHidden();
  const waiting = page.waitForEvent("download"); await link.click(); const file = await waiting;
  expect(file.url()).toBe(url); expect(file.suggestedFilename()).toBe("gridlens-synthetic-aaaaaaaa-ca.mobileconfig");
  await expect(page.locator("#download-panel")).toBeVisible();
  await expect(page.locator("#ordinary-download-help")).toBeHidden();
  await expect(page.locator("#apple-download-help")).toContainText("Not Signed");
  await expect(page.locator("#apple-download-help")).toContainText("eight minutes");
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem("gridlens.secure-setup.progress.v1")!));
  expect(saved.device).toBe("ios"); expect(saved.stage).toBe("download");
  expect(JSON.stringify(saved)).not.toMatch(/"trusted"|"verified"|"token"|"code"/);
  expect(mode.downloads).toBe(0); expect(mode.profiles).toBe(1); expect(mode.issued).toBe(0); expect(mode.redeems).toEqual([]);
  // Native Settings handoff/Back is modeled only as page lifecycle, not an OS import.
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  await expect(page.locator("#download-panel")).toBeVisible(); expect(mode.issued).toBe(0);
  await page.reload(); await expect(page.locator("#download-panel")).toBeVisible();
  await page.getByRole("button", { name: "Profile downloaded — Next", exact: true }).click();
  const steps: string[] = [];
  for (let step = 0; step < 8; step++) {
    steps.push(await page.locator("#guide-instruction").innerText());
    if (await page.locator("#guide-next").innerText() === "I’ve imported it — Open GridLens") break;
    await page.getByRole("button", { name: "Next", exact: true }).click();
  }
  expect(steps.join(" ")).toContain("Install"); expect(steps.join(" ")).toContain("Certificate Trust Settings");
  expect(steps.join(" ")).toMatch(/full trust/i); expect(mode.issued).toBe(0);
  await expect(page.locator("#guide-final-note")).toContainText(".mobileconfig");
  await expect(page.locator("#guide-final-note")).toContainText("removing that profile removes the certificate");
  await openHTTPS(page); await expectFleet(page);
  expect(mode.issued).toBe(1); expect(mode.redeems).toEqual([{ version: 1, code: CONNECT_CODE }]);
  expect(mode.requests.some(request => request.url.includes(CONNECT_CODE))).toBe(false);
});

test("iPhone Chrome gives a plain Safari setup address and returns to its own browser connection", async ({ page }) => {
  await emulateApple(page, true);
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: undefined }));
  const mode = await fixture(page); await begin(page);
  await expect(page.locator("#device-summary")).toHaveText("iPhone / iPad · Chrome / Chromium");
  await expect(page.locator("#apple-safari-help")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Setup address for Safari", exact: true })).toHaveValue(`${HTTP}/secure-setup`);
  await page.getByRole("button", { name: "Copy setup address", exact: true }).click();
  await expect(page.locator("#apple-copy-status")).toContainText("address is selected");
  await expect(page.locator("#apple-profile-download")).toBeHidden();
  await chooseInstructions(page, "ios", "safari");
  await expect(page.locator("#apple-safari-help")).toBeVisible();
  await expect(page.locator("#apple-profile-download")).toBeHidden();
  await expect(page.locator("#apple-safari-help")).toContainText("does not switch browsers");
  await chooseInstructions(page, "ios", "chrome");
  expect(mode.profiles).toBe(0); expect(mode.downloads).toBe(0); expect(mode.issued).toBe(0);
  await openHTTPS(page); await expectFleet(page);
  expect(mode.issued).toBe(1); expect(mode.redeems).toHaveLength(1);
});

nativeProfileTest("connected Apple profile recovery stays ready and disables direct navigation while setup is being checked", async ({ page, nativeProfileOrigin }) => {
  await emulateApple(page); const mode = await fixture(page, await nativeProfileOrigin("https:")); mode.signedIn = true;
  await page.goto(`${HTTPS}/secure-setup`); await expect(page.locator("#ready-panel")).toBeVisible();
  const link = page.getByRole("link", { name: "Download certificate profile again", exact: true });
  const url = `${HTTPS}/secure-setup/apple-ca/${CA}.mobileconfig`;
  await expect(link).toHaveAttribute("href", url);
  const waiting = page.waitForEvent("download"); await link.click(); const file = await waiting;
  expect(file.url()).toBe(url); await expect(page.locator("#ready-panel")).toBeVisible();
  await expect(page.locator("#download-panel")).toBeHidden(); await expect(page.locator("#guide-panel")).toBeHidden();
  await expect(page.locator("#ready-certificate-help")).toContainText("installed GridLens profile");
  let release = () => {}; mode.secureStatusWait = new Promise<void>(resolve => { release = resolve; });
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect(page.locator("#ready-apple-download")).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator("#ready-apple-download")).not.toHaveAttribute("href");
  await page.locator("#ready-apple-download").evaluate(node => (node as HTMLAnchorElement).click());
  expect(mode.profiles).toBe(1);
  release(); mode.secureStatusWait = undefined;
  await expect(link).toHaveAttribute("href", url);
  expect(mode.downloads).toBe(0); expect(mode.issued).toBe(0); expect(mode.redeems).toEqual([]); expect(mode.logins).toEqual([]);
});

test("connected iPhone Chrome offers Safari profile recovery without changing its current session", async ({ page }) => {
  await emulateApple(page, true);
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: undefined }));
  const mode = await fixture(page); mode.signedIn = true;
  await page.goto(`${HTTPS}/secure-setup`); await expect(page.locator("#ready-panel")).toBeVisible();
  await expect(page.locator("#ready-apple-download")).toBeHidden();
  await expect(page.locator("#ready-download")).toBeHidden();
  await expect(page.locator("#ready-apple-safari-help")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Setup address for Safari", exact: true })).toHaveValue(`${HTTP}/secure-setup`);
  await page.getByRole("button", { name: "Copy setup address", exact: true }).click();
  await expect(page.locator("#ready-apple-copy-status")).toContainText("address is selected");
  await expect(page.locator("#ready-panel")).toBeVisible();
  expect(mode.profiles).toBe(0); expect(mode.downloads).toBe(0); expect(mode.issued).toBe(0);
  expect(mode.redeems).toEqual([]); expect(mode.logins).toEqual([]);
  expect(mode.requests.every(request => request.method === "GET")).toBe(true);
  await page.getByRole("link", { name: "Open Fleet", exact: true }).click(); await expectFleet(page);
});

test("Apple supplied-certificate setup offers no profile or CA installation", async ({ page }) => {
  await emulateApple(page); const mode = await fixture(page);
  mode.value = { ...metadata(), trustMode: "provided-certificate", certificateDownloadPath: null }; mode.signedIn = true;
  await begin(page); await expect(page.locator("#provided-help")).toBeVisible();
  await expect(page.locator("#apple-profile-download")).toBeHidden(); await expect(page.locator("#apple-profile-notice")).toBeHidden();
  await expect(page.locator("#apple-safari-help")).toBeHidden(); await openHTTPS(page); await expectFleet(page);
  await page.goto(`${HTTPS}/secure-setup`); await expect(page.locator("#ready-panel")).toBeVisible();
  await expect(page.locator("#ready-apple-download")).toBeHidden(); await expect(page.locator("#ready-certificate-help")).toBeHidden();
  expect(mode.profiles).toBe(0); expect(mode.downloads).toBe(0);
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

test("desktop and Android guides lead to a real HTTPS check without automating settings", async ({ page }) => {
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

test("a connected HTTPS browser can recover its public certificate without repeating setup or changing access", async ({ page }) => {
  const mode = await fixture(page); mode.signedIn = true;
  await page.goto(`${HTTPS}/secure-setup`); await expect(page.locator("#ready-panel")).toBeVisible();
  const waiting = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download certificate again", exact: true }).click();
  const file = await waiting;
  expect(file.suggestedFilename()).toBe("gridlens-synthetic-aaaaaaaa-ca.crt");
  expect(await readFile((await file.path())!, "utf8")).toBe(mode.downloadBody);
  await expect(page).toHaveURL(`${HTTPS}/secure-setup`);
  await expect(page.locator("#ready-panel")).toBeVisible();
  await expect(page.locator("#download-panel")).toBeHidden(); await expect(page.locator("#guide-panel")).toBeHidden();
  await expect(page.locator("#wizard-message")).toContainText("download requested");
  expect(mode.downloads).toBe(1); expect(mode.requests.every(request => request.method === "GET")).toBe(true);
  expect(mode.issued).toBe(0); expect(mode.redeems).toEqual([]); expect(mode.logins).toEqual([]);
  // The recovery button retains the same identity gate as the initial download.
  mode.value = { ...metadata(), certificateSha256: "d".repeat(64) };
  await page.getByRole("button", { name: "Download certificate again", exact: true }).click();
  await expect(page.locator("#repair-message")).toContainText("certificate changed");
  expect(mode.downloads).toBe(1);
});

test("supplied certificate skips CA import and rechecks even an existing browser session", async ({ page }) => {
  const mode = await fixture(page); mode.value = { ...metadata(), trustMode: "provided-certificate", certificateDownloadPath: null }; mode.signedIn = true;
  await begin(page); await expect(page.locator("#provided-help")).toBeVisible();
  await expect(page.getByRole("button", { name: "Already imported? Open GridLens" })).toBeHidden();
  await openHTTPS(page);
  await expectFleet(page); expect(mode.downloads).toBe(0);
  expect(mode.issued).toBe(1); expect(mode.redeems).toEqual([]);
  await page.goto(`${HTTPS}/secure-setup`); await expect(page.locator("#ready-panel")).toBeVisible();
  await expect(page.getByRole("button", { name: "Download certificate again", exact: true })).toBeHidden();
  await expect(page.locator("#ready-certificate-help")).toBeHidden();
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
  await expectFleet(page);
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
