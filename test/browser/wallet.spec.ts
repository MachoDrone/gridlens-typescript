import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { TreasuryConfiguration, TreasuryOperation, TreasuryPlan } from "../../src/contracts/treasury.ts";

const ORIGIN = "https://wallet.gridlens.invalid";
const SOURCE = "11111111111111111111111111111111";
const DESTINATION = "So11111111111111111111111111111111111111112";
const ALTERNATE = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN = "isolated-owner-session".padEnd(43, "x");
const TICKET = "isolated-setup-ticket".padEnd(43, "x");
const PASSWORD = "isolated-wallet-owner-password";
const SIGNATURE = "1".repeat(88);
interface RequestRecord { path: string; method: string; body: Record<string, unknown> | undefined; token: string | undefined }
interface Fixture {
  configured: boolean; consumed: boolean; destination: string; requests: RequestRecord[]; operations: TreasuryOperation[];
  confirmCalls: number; lockCalls: number; loseConfirmReply: boolean; rejectUnlock: boolean;
  quoteDestination: string | undefined; amount: string; lastPlan: TreasuryPlan | undefined; clockOffsetMs: number;
}
async function fixture(page: Page): Promise<Fixture> {
  const state: Fixture = { configured: true, consumed: false, destination: DESTINATION, requests: [], operations: [], confirmCalls: 0,
    lockCalls: 0, loseConfirmReply: false, rejectUnlock: false, quoteDestination: undefined, amount: "1000000", lastPlan: undefined, clockOffsetMs: 0 };
  const configuration = (): TreasuryConfiguration => ({ version: 1, revision: 1, destinationAddress: state.destination,
    hosts: [{ address: SOURCE, label: "Synthetic host" }], amountBaseUnits: "1000000", reserveLamports: "50000000", maxCostLamports: "5000000", pilotConsumed: state.consumed });
  const assets: Record<string, string> = { "/wallet": "wallet.html", "/wallet.css": "wallet.css", "/preview/wallet.js": "preview/wallet.js",
    "/contracts/treasury.js": "contracts/treasury.js", "/fleet/host-metadata.js": "fleet/host-metadata.js" };
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (![ORIGIN, ORIGIN.replace("https:", "http:")].includes(url.origin)) throw new Error(`Unexpected external request: ${url.origin}`);
    const asset = assets[url.pathname];
    if (asset) {
      await route.fulfill({ contentType: asset.endsWith(".html") ? "text/html" : asset.endsWith(".css") ? "text/css" : "text/javascript", body: await readFile(resolve("dist", asset), "utf8") }); return;
    }
    if (url.pathname === "/") { await route.fulfill({ contentType: "text/html", body: "<h1>Synthetic Fleet</h1>" }); return; }
    if (url.pathname === "/secure-setup") { await route.fulfill({ contentType: "text/html", body: "<h1>Synthetic Secure guide</h1>" }); return; }
    if (!url.pathname.startsWith("/api/shared/treasury/")) { await route.fulfill({ status: 404 }); return; }
    const path = url.pathname.slice("/api/shared/treasury".length), body = request.postDataJSON() as Record<string, unknown> | undefined;
    const token = request.headers()["x-gridlens-wallet"];
    state.requests.push({ path, method: request.method(), body, token });
    const send = async (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", json: value });
    if (path === "/status") { await send({ version: 1, supported: true, state: state.configured ? "locked" : "setup-required", pilotConsumed: state.consumed, serverId: "synthetic-server", scopeId: "synthetic-fleet", revision: 1 }); return; }
    if (path === "/unlock" || path === "/setup") {
      if (state.rejectUnlock || body?.password !== PASSWORD || path === "/setup" && body?.ticket !== TICKET) { await send({ version: 1, error: "denied" }, 403); return; }
      if (path === "/setup") { state.configured = true; state.destination = String(body?.destinationAddress); }
      await send({ version: 1, unlockToken: TOKEN, expiresAtMs: Date.now() + 300_000, configuration: configuration() }); return;
    }
    if (token !== TOKEN) { await send({ version: 1, error: "denied" }, 403); return; }
    if (path === "/lock") { state.lockCalls++; await send({ version: 1, locked: true }); return; }
    if (path === "/configuration") {
      if (request.method() === "POST") { state.destination = String(body?.destinationAddress); await send({ version: 1, locked: true }); }
      else await send(configuration());
      return;
    }
    if (path === "/operations") { await send({ version: 1, operations: state.operations }); return; }
    if (path === "/prepare") {
      const now = Date.now() + state.clockOffsetMs;
      state.lastPlan = { version: 1, planId: "synthetic-plan", reviewDigest: "b".repeat(64), expiresAtMs: now + 120_000,
        quote: { sourceAddress: SOURCE, destinationAddress: state.quoteDestination ?? state.destination, sourceTokenAddress: SOURCE,
          destinationTokenAddress: DESTINATION, mintAddress: "nosXBVoaCTtYdLvKY6Csb4AC8JCdQKKAaWYtx2ZMoo7", amountBaseUnits: state.amount as "1000000", decimals: 6,
          feeLamports: "5000", rentLamports: "2039280", reserveLamports: "50000000", maxCostLamports: "5000000",
          preparedAtMs: now, expiresAtMs: now + 120_000, createDestinationAta: true, sourceNosBaseUnits: "2500000", sourceSolLamports: "100000000" } };
      await send(state.lastPlan); return;
    }
    if (path === "/confirm") {
      state.confirmCalls++; state.consumed = true;
      const now = Date.now();
      const operation: TreasuryOperation = { id: "synthetic-operation", phase: state.loseConfirmReply ? "uncertain" : "confirmed", sourceAddress: SOURCE,
        destinationAddress: state.destination, amountBaseUnits: "1000000", signature: SIGNATURE, startedAtMs: now, updatedAtMs: now,
        confirmedAtMs: state.loseConfirmReply ? null : now, slot: state.loseConfirmReply ? null : 1234, error: null };
      state.operations = [operation];
      if (state.loseConfirmReply) { await route.abort("failed"); return; }
      await send({ version: 1, operation }); return;
    }
    await send({ version: 1, error: "unavailable" }, 404);
  });
  return state;
}
async function unlock(page: Page): Promise<void> {
  await page.goto(`${ORIGIN}/wallet`);
  await page.getByLabel("Owner password", { exact: true }).filter({ visible: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Unlock Wallet", exact: true }).click();
  await expect(page.locator("#wallet-unlocked")).toBeVisible();
}
async function prepare(page: Page): Promise<void> {
  await page.getByLabel("Source host", { exact: true }).selectOption(SOURCE);
  await page.getByRole("button", { name: "Review 1 NOS transfer", exact: true }).click();
}

test("Wallet blocks password entry and every financial API read on HTTP", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`${ORIGIN.replace("https:", "http:")}/wallet#ticket=${TICKET}`);
  await expect(page.getByRole("heading", { name: "Secure this device first" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Complete Secure setup" })).toHaveAttribute("href", "/secure-setup#return=wallet");
  await expect(page.locator('input[type="password"]:visible')).toHaveCount(0);
  expect(state.requests).toHaveLength(0); await expect(page).not.toHaveURL(/ticket/);
});

test("owner setup scrubs its one-use ticket and retains no password or unlock credential in storage", async ({ page }) => {
  const state = await fixture(page); state.configured = false;
  await page.goto(`${ORIGIN}/wallet#ticket=${TICKET}`);
  await expect(page).toHaveURL(`${ORIGIN}/wallet`);
  await expect(page.getByRole("heading", { name: "Set up your Wallet" })).toBeVisible();
  await page.locator("#setup-destination").fill(DESTINATION); await page.locator("#setup-password").fill(PASSWORD);
  await page.locator("#setup-password-confirm").fill(PASSWORD);
  await page.getByRole("button", { name: "Save Wallet", exact: true }).click();
  await expect(page.locator("#receiving-address")).toHaveText(DESTINATION);
  const setup = state.requests.find(request => request.path === "/setup");
  expect(setup?.body).toEqual({ version: 1, ticket: TICKET, password: PASSWORD, destinationAddress: DESTINATION });
  await expect(page.locator("#setup-password")).toHaveValue("");
  expect(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))).toEqual({ local: {}, session: {} });
  expect(state.requests.filter(request => request.path !== "/setup").every(request => !JSON.stringify(request.body ?? {}).includes(TICKET))).toBe(true);
  await page.reload(); await expect(page.getByRole("heading", { name: "Unlock Wallet" })).toBeVisible();
  await expect(page.locator("#receiving-address")).toHaveText("");
});

test("ordinary dashboard visitors cannot start owner setup", async ({ page }) => {
  const state = await fixture(page); state.configured = false;
  await page.goto(`${ORIGIN}/wallet`);
  await expect(page.getByRole("heading", { name: "Set up the owner", exact: true })).toBeVisible();
  await expect(page.locator("#wallet-setup-form")).toBeHidden();
  expect(state.requests.map(request => request.path)).toEqual(["/status"]);
});

test("missing Wallet encryption state shows recovery instead of unavailable capability", async ({ page }) => {
  await fixture(page);
  await page.route("**/api/shared/treasury/status", route => route.fulfill({ json: { version: 1, supported: false,
    state: "recovery-required", pilotConsumed: true, serverId: "synthetic-server", scopeId: "synthetic-fleet", revision: 0 } }));
  await page.goto(`${ORIGIN}/wallet`);
  await expect(page.getByRole("heading", { name: "Wallet needs recovery", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Wallet is unavailable", exact: true })).toBeHidden();
  await expect(page.locator('input[type="password"]:visible')).toHaveCount(0);
});

test("exact 1 NOS review shows full addresses and costs, sends once, then disables another test", async ({ page }) => {
  const state = await fixture(page); await unlock(page); await prepare(page);
  const review = page.locator("#wallet-review"); await expect(review).toBeVisible();
  await expect(review).toContainText(SOURCE); await expect(review).toContainText(DESTINATION);
  await expect(review).toContainText("0.000005 SOL"); await expect(review).toContainText("0.00203928 SOL");
  await expect(review).toContainText("0.005 SOL"); await expect(review).toContainText("0.05 SOL");
  await expect(page.locator("#review-heading")).toBeFocused();
  const send = page.getByRole("button", { name: "Send exactly 1 NOS", exact: true });
  await send.click();
  await expect(page.getByRole("heading", { name: "Confirmed · 1 NOS received", exact: true })).toBeVisible();
  await expect(page.locator("#prepare-transfer")).toBeDisabled();
  const confirms = state.requests.filter(request => request.path === "/confirm"); expect(confirms).toHaveLength(1);
  expect(confirms[0]?.token).toBe(TOKEN); expect(confirms[0]?.body?.planId).toBe(state.lastPlan?.planId);
  expect(confirms[0]?.body?.reviewDigest).toBe(state.lastPlan?.reviewDigest); expect(confirms[0]?.body?.idempotencyKey).toMatch(/^[a-f0-9-]{36}$/);
  await page.getByRole("button", { name: "Lock Wallet", exact: true }).click();
  await expect(page.locator("#wallet-unlocked")).toBeHidden(); await expect(page.locator("#wallet-operations")).toBeEmpty();
  await expect.poll(() => state.lockCalls).toBe(1);
  expect(state.confirmCalls).toBe(1);
});

test("a lost confirmation response never causes an automatic resend and history recovers the result", async ({ page }) => {
  const state = await fixture(page); state.loseConfirmReply = true;
  await unlock(page); await prepare(page); await page.getByRole("button", { name: "Send exactly 1 NOS", exact: true }).click();
  await expect(page.locator("#wallet-message")).toContainText("do not send again");
  await expect(page.locator("#prepare-transfer")).toBeDisabled();
  await page.getByRole("button", { name: "Refresh activity", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Result not yet verified", exact: true })).toBeVisible();
  expect(state.confirmCalls).toBe(1);
  state.operations[0] = { ...state.operations[0]!, phase: "confirmed", confirmedAtMs: Date.now(), slot: 1234 };
  await page.getByRole("button", { name: "Refresh activity", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Confirmed · 1 NOS received", exact: true })).toBeVisible();
  expect(state.confirmCalls).toBe(1);
});

for (const change of ["destination", "amount"] as const) test(`a changed ${change} in the transfer review blocks confirmation`, async ({ page }) => {
  const state = await fixture(page);
  if (change === "destination") state.quoteDestination = ALTERNATE; else state.amount = "2000000";
  await unlock(page); await prepare(page);
  await expect(page.locator("#wallet-message")).toContainText("could not complete");
  await expect(page.locator("#wallet-review")).toBeHidden(); expect(state.confirmCalls).toBe(0);
});

test("five-minute expiry locks even when activity is being polled", async ({ page }) => {
  await page.clock.install({ time: new Date() });
  const state = await fixture(page); state.loseConfirmReply = true;
  await unlock(page); await prepare(page); await page.getByRole("button", { name: "Send exactly 1 NOS", exact: true }).click();
  await page.getByRole("button", { name: "Refresh activity", exact: true }).click();
  await page.clock.fastForward(300_010);
  await expect(page.getByRole("heading", { name: "Unlock Wallet", exact: true })).toBeVisible();
  await expect(page.locator("#wallet-unlocked")).toBeHidden(); await expect.poll(() => state.lockCalls).toBe(1);
  expect(state.confirmCalls).toBe(1);
});

test("a deliberate fresh review renews the unlock while background reads do not", async ({ page }) => {
  await page.clock.install({ time: new Date() });
  const state = await fixture(page); await unlock(page);
  await page.clock.fastForward(200_000); state.clockOffsetMs = 200_000;
  await prepare(page); await expect(page.locator("#wallet-review")).toBeVisible();
  await page.clock.fastForward(110_000); await expect(page.locator("#wallet-unlocked")).toBeVisible();
  await page.clock.fastForward(190_010); await expect(page.getByRole("heading", { name: "Unlock Wallet", exact: true })).toBeVisible();
  await expect.poll(() => state.lockCalls).toBe(1); expect(state.confirmCalls).toBe(0);
});

test("changing receiving wallet requires the current password and locks the current review", async ({ page }) => {
  const state = await fixture(page); await unlock(page); await prepare(page);
  await page.getByText("Change wallet or password", { exact: true }).click();
  await page.locator("#change-destination").fill(ALTERNATE); await page.locator("#change-current-password").fill(PASSWORD);
  await page.getByRole("button", { name: "Save changes and lock", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Unlock Wallet", exact: true })).toBeVisible();
  await expect(page.locator("#wallet-review")).toBeHidden(); await expect(page.locator("#change-current-password")).toHaveValue("");
  expect(state.requests.find(request => request.path === "/configuration" && request.method === "POST")?.body)
    .toEqual({ version: 1, currentPassword: PASSWORD, destinationAddress: ALTERNATE });
  expect(state.confirmCalls).toBe(0);
});

for (const viewport of [{ width: 320, height: 844 }, { width: 667, height: 240 }]) test(`Wallet setup and transfer review fit ${viewport.width}×${viewport.height}`, async ({ page }) => {
  await page.setViewportSize(viewport); await fixture(page); await unlock(page); await prepare(page);
  await expect(page.locator("#wallet-review")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator("#confirm-transfer").focus(); await expect(page.locator("#confirm-transfer")).toBeFocused();
  await page.locator("#cancel-transfer").click(); await expect(page.locator("#wallet-review")).toBeHidden();
  await page.getByRole("button", { name: "Lock Wallet", exact: true }).click();
  await page.locator("#unlock-password").fill("visible-test-password");
  await page.locator('[data-password="unlock-password"]').click(); await expect(page.locator("#unlock-password")).toHaveAttribute("type", "text");
});

test("Wallet sidebar item is installed-only and keeps the existing expanded and 56px collapsed widths", async ({ page }) => {
  let installed = false;
  await page.route("http://127.0.0.1:4174/**", async route => {
    if (route.request().resourceType() !== "document") { await route.continue(); return; }
    const response = await route.fetch(), original = await response.text();
    await route.fulfill({ response, body: installed ? original.replace("</head>", '<meta name="gridlens-shared-backend" content="1"></head>') : original });
  });
  await page.route("**/api/shared/**", route => route.fulfill({ status: 401, json: {} }));
  await page.addInitScript(() => localStorage.setItem("gridlens.preview.sidebar.v1", "expanded"));
  await page.goto("/?scenario=mixed"); await expect(page.locator("#sidebar-wallet")).toBeHidden();
  const before = (await page.locator("#sidebar").boundingBox())!.width;
  installed = true; await page.reload();
  const wallet = page.getByRole("link", { name: "Wallet", exact: true });
  await expect(wallet).toBeVisible(); await expect(wallet).toHaveAttribute("href", "/wallet");
  await expect.poll(async () => Math.abs((await page.locator("#sidebar").boundingBox())!.width - before)).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "Collapse menu", exact: true }).click();
  await expect(wallet.locator(".sidebar-label")).toBeHidden(); await expect(wallet.locator("svg")).toBeVisible();
  await expect.poll(async () => (await page.locator("#sidebar").boundingBox())!.width).toBeLessThanOrEqual(56.1);
  await wallet.focus(); await expect(wallet).toBeFocused();
});
