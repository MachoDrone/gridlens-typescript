import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BROWSER_ASSETS } from "../../src/server/browser-assets.ts";

const ORIGIN = "https://owner-protection.gridlens.invalid", PASSWORD = "generated owner password";
const SOURCE = "11111111111111111111111111111111", DESTINATION = "So11111111111111111111111111111111111111112";
const TOKEN = "generated-owner-unlock".padEnd(43, "x");
async function fixture(page: Page) {
  const state = { enrolled: false, running: false, enrollCalls: 0, ownerCalls: 0, inviteCalls: 0, financialCalls: 0, paths: [] as string[] };
  const configuration = () => ({ version: 1, revision: 1, destinationAddress: DESTINATION, hosts: [{ address: SOURCE, label: "Generated source" }],
    amountBaseUnits: "1000000", reserveLamports: "50000000", maxCostLamports: "5000000", pilotConsumed: false,
    guardian: { required: true, authorityId: state.enrolled || state.running ? "a".repeat(64) : null, state: state.enrolled ? "ready" : state.running ? "enrolling" : "not-enrolled" } });
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()); expect(url.origin).toBe(ORIGIN);
    const file = url.pathname === "/wallet" ? "wallet.html" : url.pathname.slice(1);
    if (url.pathname === "/wallet" || Object.hasOwn(BROWSER_ASSETS, url.pathname)) {
      await route.fulfill({ contentType: file.endsWith(".html") ? "text/html" : file.endsWith(".css") ? "text/css" : "text/javascript", body: await readFile(resolve("dist", file), "utf8") }); return;
    }
    if (url.pathname === "/connect") { await route.fulfill({ contentType: "text/html", body: "<h1>Generated owner administration</h1>" }); return; }
    if (!url.pathname.startsWith("/api/shared/treasury/")) { await route.fulfill({ status: 404 }); return; }
    const path = url.pathname.slice("/api/shared/treasury/".length); state.paths.push(path);
    const body = request.postDataJSON() as Record<string, unknown> | undefined;
    const send = (json: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", json });
    if (path === "status") return send({ version: 1, supported: true, state: "locked", pilotConsumed: false, serverId: "generated-owner", scopeId: "fleet", revision: 1 });
    if (path === "unlock") return body?.password === PASSWORD ? send({ version: 1, unlockToken: TOKEN, expiresAtMs: Date.now() + 300_000, configuration: configuration() }) : send({}, 401);
    if (request.headers()["x-gridlens-wallet"] !== TOKEN) return send({}, 401);
    if (path === "configuration") return send(configuration());
    if (path === "operations") return send({ version: 1, operations: [] });
    if (path === "claims/status") return send({ version: 1, supported: true, state: "ready", unresolvedOperationId: null, attemptedHosts: [], eligibleHosts: [{ address: SOURCE, label: "Generated source" }] });
    if (path === "claims/operations") return send({ version: 1, operations: [], total: 0 });
    if (path === "guardians/status") return send({ version: 1, required: true, authorityId: state.enrolled || state.running ? "a".repeat(64) : null,
      state: state.enrolled ? "ready" : "not-enrolled", ...(state.running ? { job: { state: "running", total: 2, completed: 1 } } : {}) });
    if (path === "guardians/enroll") { state.enrollCalls++; state.running = true; return send({ version: 1, state: "not-enrolled" }); }
    if (path === "owner-browser") { state.ownerCalls++; return send({ version: 1, expiresAtMs: Date.now() + 300_000 }); }
    if (path === "viewer-invite") { state.inviteCalls++; return send({ version: 1, kind: "gridlens-viewer-invite", ownerOrigin: ORIGIN, serverId: "generated-owner",
      caCertificatePem: "generated-public-certificate", serverCertificateSha256: "b".repeat(64), code: "generated-view-code", expiresAtMs: Date.now() + 300_000 }); }
    if (path === "lock") return send({ version: 1, locked: true });
    if (["prepare", "confirm", "claims/prepare", "claims/confirm"].includes(path)) state.financialCalls++;
    return send({}, 409);
  });
  await page.goto(ORIGIN + "/wallet"); await expect(page.locator("#wallet-locked")).toBeVisible();
  return state;
}
test("owner protection requires explicit enrollment confirmation and leaves financial controls blocked while incomplete", async ({ page }) => {
  const state = await fixture(page);
  await expect(page.locator("#owner-protection")).toBeHidden();
  await page.locator("#unlock-password").fill(PASSWORD); await page.locator("#wallet-unlock-form").evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(page.locator("#owner-protection")).toBeVisible(); await expect(page.locator("#guardian-state")).toContainText("Protect the source PCs");
  await page.selectOption("#wallet-source", SOURCE); await page.selectOption("#claim-source", SOURCE);
  await expect(page.locator("#prepare-transfer")).toBeDisabled(); await expect(page.locator("#prepare-claim")).toBeDisabled();
  await page.locator("#guardian-enroll").click(); await expect(page.locator("#guardian-review")).toBeVisible(); expect(state.enrollCalls).toBe(0);
  await page.locator("#guardian-confirm").click(); await expect(page.locator("#guardian-state")).toContainText("1 of 2");
  await expect(page.locator("#guardian-enroll")).toBeDisabled(); expect(state.enrollCalls).toBe(1); expect(state.financialCalls).toBe(0);
  state.running = false; state.enrolled = true;
  await page.locator("#guardian-refresh").click(); await expect(page.locator("#guardian-state")).toContainText("Each financial action rechecks");
  await expect(page.locator("#prepare-transfer")).toBeEnabled(); await expect(page.locator("#prepare-claim")).toBeEnabled();
  await page.locator("#wallet-lock").click(); await expect(page.locator("#owner-protection")).toBeHidden(); expect(state.financialCalls).toBe(0);
});
test("owner can export a short-lived monitoring invitation without exposing the Wallet session", async ({ page }) => {
  const state = await fixture(page); await page.locator("#unlock-password").fill(PASSWORD); await page.locator("#wallet-unlock-form").evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(page.locator("#owner-protection")).toBeVisible(); await expect(page.locator("#viewer-invite")).toBeEnabled();
  const downloaded = page.waitForEvent("download"); await page.locator("#viewer-invite").click();
  const file = await downloaded; expect(file.suggestedFilename()).toBe("gridlens-viewer-invite.json");
  const text = await readFile((await file.path())!, "utf8"); expect(text).not.toContain(TOKEN); expect(JSON.parse(text).kind).toBe("gridlens-viewer-invite");
  expect(state.inviteCalls).toBe(1); expect(state.financialCalls).toBe(0);
  await page.locator("#owner-admin").click(); await expect(page).toHaveURL(ORIGIN + "/connect?manage=1"); expect(state.ownerCalls).toBe(1);
});
