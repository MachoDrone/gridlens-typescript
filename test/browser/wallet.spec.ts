import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { treasuryPreflightStatus } from "../../src/contracts/treasury.ts";
import type { TreasuryConfiguration, TreasuryOperation, TreasuryPlan, TreasuryPreflightCode } from "../../src/contracts/treasury.ts";

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
  password: string; recoveryQuestions: { id: string; question: string; answer: string }[]; recoveryLimited: boolean; loseResetReply: boolean;
  configured: boolean; consumed: boolean; destination: string; requests: RequestRecord[]; operations: TreasuryOperation[];
  confirmCalls: number; lockCalls: number; loseConfirmReply: boolean; rejectUnlock: boolean;
  quoteDestination: string | undefined; amount: string; lastPlan: TreasuryPlan | undefined; clockOffsetMs: number;
  prepareWait: Promise<void> | undefined; unlockWait: Promise<void> | undefined;
  prepareFailure: { status: number; value: unknown } | undefined; confirmFailure: { status: number; value: unknown } | undefined;
}
async function fixture(page: Page): Promise<Fixture> {
  const state: Fixture = { password: PASSWORD, recoveryQuestions: [], recoveryLimited: false, loseResetReply: false, configured: true, consumed: false, destination: DESTINATION, requests: [], operations: [], confirmCalls: 0,
    lockCalls: 0, loseConfirmReply: false, rejectUnlock: false, quoteDestination: undefined, amount: "1000000", lastPlan: undefined, clockOffsetMs: 0,
    prepareWait: undefined, unlockWait: undefined, prepareFailure: undefined, confirmFailure: undefined };
  const configuration = (): TreasuryConfiguration => ({ version: 1, revision: 1, destinationAddress: state.destination,
    hosts: [{ address: SOURCE, label: "Synthetic host" }], amountBaseUnits: "1000000", reserveLamports: "50000000", maxCostLamports: "5000000", pilotConsumed: state.consumed });
  const assets: Record<string, string> = { "/wallet": "wallet.html", "/wallet.css": "wallet.css", "/preview/wallet.js": "preview/wallet.js",
    "/contracts/treasury.js": "contracts/treasury.js", "/contracts/treasury-claims.js": "contracts/treasury-claims.js",
    "/fleet/nos.js": "fleet/nos.js", "/fleet/sol.js": "fleet/sol.js", "/fleet/host-metadata.js": "fleet/host-metadata.js" };
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
      if (state.unlockWait) await state.unlockWait;
      if (state.rejectUnlock || body?.password !== state.password || path === "/setup" && body?.ticket !== TICKET) { await send({ version: 1, error: "denied" }, 403); return; }
      if (path === "/setup") { state.configured = true; state.destination = String(body?.destinationAddress); }
      await send({ version: 1, unlockToken: TOKEN, expiresAtMs: Date.now() + 300_000, configuration: configuration() }); return;
    }
    if (path === "/recovery/challenge") {
      await send({ version: 1, enrolled: state.recoveryQuestions.length === 6, questions: [4, 0, 2].flatMap(i => {
        const q = state.recoveryQuestions[i]; return q ? [{ id: q.id, question: q.question }] : [];
      }) }); return;
    }
    if (path === "/recovery/verify") {
      if (state.recoveryLimited) { await send({ version: 1, error: "limited" }, 429); return; }
      const answers = body?.answers as { id: string; answer: string }[];
      if (!answers || answers.length !== 3 || answers.some(a => state.recoveryQuestions.find(q => q.id === a.id)?.answer !== a.answer)) { await send({ version: 1, error: "denied" }, 401); return; }
      await send({ version: 1, resetToken: "synthetic-reset-grant".padEnd(43, "r"), expiresAtMs: Date.now() + 300_000 }); return;
    }
    if (path === "/recovery/reset") {
      if (body?.resetToken !== "synthetic-reset-grant".padEnd(43, "r")) { await send({ version: 1, error: "denied" }, 401); return; }
      state.password = String(body.newPassword);
      if (state.loseResetReply) { await route.abort("failed"); return; }
      await send({ version: 1, locked: true }); return;
    }
    if (token !== TOKEN) { await send({ version: 1, error: "denied" }, 403); return; }
    if (path === "/recovery/status") {
      await send({ version: 1, enrolled: state.recoveryQuestions.length === 6, questions: state.recoveryQuestions.map(({ id, question }) => ({ id, question })) }); return;
    }
    if (path === "/recovery/enroll") {
      const questions = body?.questions as { question: string; answer: string }[];
      if (body?.currentPassword !== state.password || questions.length !== 6) { await send({ version: 1, error: "denied" }, 401); return; }
      state.recoveryQuestions = questions.map((q, i) => ({ ...q, id: `saved-question-${i}` })); await send({ version: 1, locked: true }); return;
    }
    if (path === "/claims/status") { await send({ version: 1, supported: true, state: "ready", unresolvedOperationId: null, attemptedHosts: [], eligibleHosts: [] }); return; }
    if (path === "/claims/operations") { await send({ version: 1, operations: [], total: 0 }); return; }
    if (path === "/lock") { state.lockCalls++; await send({ version: 1, locked: true }); return; }
    if (path === "/configuration") {
      if (request.method() === "POST") { state.destination = String(body?.destinationAddress); await send({ version: 1, locked: true }); }
      else await send(configuration());
      return;
    }
    if (path === "/operations") { await send({ version: 1, operations: state.operations }); return; }
    if (path === "/prepare") {
      if (state.prepareWait) await state.prepareWait;
      if (state.prepareFailure) { await send(state.prepareFailure.value, state.prepareFailure.status); return; }
      const now = Date.now() + state.clockOffsetMs;
      state.lastPlan = { version: 1, planId: "synthetic-plan", reviewDigest: "b".repeat(64), expiresAtMs: now + 120_000,
        quote: { sourceAddress: SOURCE, destinationAddress: state.quoteDestination ?? state.destination, sourceTokenAddress: SOURCE,
          destinationTokenAddress: DESTINATION, mintAddress: "nosXBVoaCTtYdLvKY6Csb4AC8JCdQKKAaWYtx2ZMoo7", amountBaseUnits: state.amount as "1000000", decimals: 6,
          feeLamports: "5000", rentLamports: "2039280", reserveLamports: "50000000", maxCostLamports: "5000000",
          preparedAtMs: now, expiresAtMs: now + 120_000, createDestinationAta: true, sourceNosBaseUnits: "2500000", sourceSolLamports: "100000000" } };
      await send(state.lastPlan); return;
    }
    if (path === "/confirm") {
      state.confirmCalls++;
      if (state.confirmFailure) { await send(state.confirmFailure.value, state.confirmFailure.status); return; }
      state.consumed = true;
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
function delayedResponse(): { promise: Promise<void>; finish(): void } {
  let finish!: () => void;
  const promise = new Promise<void>(resolve => { finish = resolve; });
  return { promise, finish };
}

test("a delayed balance review remains pending past twenty seconds and completes without another request", async ({ page }) => {
  await page.clock.install({ time: new Date() });
  const state = await fixture(page), gate = delayedResponse(); state.prepareWait = gate.promise;
  try {
    await unlock(page); await prepare(page);
    await expect.poll(() => state.requests.filter(request => request.path === "/prepare").length).toBe(1);
    await page.clock.fastForward(25_000); state.clockOffsetMs = 25_000;
    await expect(page.locator("#prepare-transfer")).toBeDisabled(); await expect(page.locator("#wallet-review")).toBeHidden();
    await expect(page.locator("#wallet-message")).toHaveText("Checking balances and costs…");
    gate.finish(); await expect(page.locator("#wallet-review")).toBeVisible();
    expect(state.requests.filter(request => request.path === "/prepare")).toHaveLength(1);
    expect(state.confirmCalls).toBe(0); expect(state.consumed).toBe(false);
  } finally { gate.finish(); }
});

test("balance review stops at its fifty-five second deadline without automatic retry or authorization", async ({ page }) => {
  const at = Date.now(); await page.clock.install({ time: new Date(at) });
  await page.clock.pauseAt(new Date(at + 1000));
  const state = await fixture(page), gate = delayedResponse(); state.prepareWait = gate.promise;
  try {
    await unlock(page); await prepare(page);
    await expect.poll(() => state.requests.filter(request => request.path === "/prepare").length).toBe(1);
    await page.clock.fastForward(54_999); await expect(page.locator("#prepare-transfer")).toBeDisabled();
    await page.clock.fastForward(2); await expect(page.locator("#wallet-message")).toContainText("could not complete");
    await expect(page.locator("#prepare-transfer")).toBeEnabled(); await expect(page.locator("#wallet-review")).toBeHidden();
    expect(state.requests.filter(request => request.path === "/prepare")).toHaveLength(1);
    expect(state.confirmCalls).toBe(0); expect(state.consumed).toBe(false);
  } finally { gate.finish(); }
});

test("ordinary Wallet requests retain their twenty second deadline", async ({ page }) => {
  await page.clock.install({ time: new Date() });
  const state = await fixture(page), gate = delayedResponse(); state.unlockWait = gate.promise;
  try {
    await page.goto(`${ORIGIN}/wallet`); await page.locator("#unlock-password").fill(PASSWORD);
    await page.getByRole("button", { name: "Unlock Wallet", exact: true }).click();
    await expect.poll(() => state.requests.filter(request => request.path === "/unlock").length).toBe(1);
    await page.clock.fastForward(20_001); await expect(page.locator("#wallet-message")).toContainText("could not complete");
    await expect(page.locator("#wallet-unlocked")).toBeHidden();
    expect(state.requests.filter(request => request.path === "/unlock")).toHaveLength(1);
  } finally { gate.finish(); }
});

const preflightCopy: [TreasuryPreflightCode, string][] = [
  ["budget-wait", "GridLens is waiting for enough shared blockchain request capacity"], ["provider-unavailable", "balance provider could not complete"],
  ["insufficient-nos", "does not have 1 NOS available"], ["insufficient-sol-reserve", "retain its 0.05 SOL reserve"],
  ["cost-limit", "above the amount you reviewed or the 0.005 SOL limit"], ["account-invalid", "token account could not be validated"],
  ["source-changed", "host's identity or access changed"], ["review-expired", "review can no longer be used"],
  ["preflight-unavailable", "could not finish checking this transfer"],
];
for (const [code, copy] of preflightCopy) test(`a ${code} review failure gives a precise reason without consuming the pilot`, async ({ page }) => {
  const state = await fixture(page);
  state.prepareFailure = { status: treasuryPreflightStatus(code), value: { version: 1, kind: "preflight-failure", code,
    ...(code === "budget-wait" ? { retryAtMs: Date.now() + 60_000 } : {}) } };
  await unlock(page); await prepare(page);
  await expect(page.locator("#wallet-message")).toContainText(copy);
  await expect(page.locator("#wallet-message")).toContainText("No transfer was authorized.");
  await expect(page.locator("#wallet-message")).not.toContainText("Check your connection");
  if (code === "budget-wait") await expect(page.locator("#wallet-message")).toContainText("Try again after");
  await expect(page.locator("#prepare-transfer")).toBeEnabled(); await expect(page.locator("#pilot-finished")).toBeHidden();
  expect(state.requests.filter(request => request.path === "/prepare")).toHaveLength(1); expect(state.confirmCalls).toBe(0);
  expect(state.consumed).toBe(false); expect(state.operations).toHaveLength(0);
});

test("a known confirmation admission failure preserves the review and permits only an explicit retry", async ({ page }) => {
  const state = await fixture(page); await unlock(page); await prepare(page);
  state.confirmFailure = { status: 429, value: { version: 1, kind: "preflight-failure", code: "budget-wait", retryAtMs: Date.now() + 1000 } };
  await page.getByRole("button", { name: "Send exactly 1 NOS", exact: true }).click();
  await expect(page.locator("#wallet-message")).toContainText("No transfer was authorized.");
  await expect(page.locator("#wallet-message")).not.toContainText("do not send again");
  await expect(page.locator("#wallet-review")).toBeVisible(); await expect(page.locator("#confirm-transfer")).toBeEnabled();
  await expect(page.locator("#pilot-finished")).toBeHidden(); expect(state.consumed).toBe(false); expect(state.operations).toHaveLength(0);
  expect(state.confirmCalls).toBe(1); state.confirmFailure = undefined;
  await page.getByRole("button", { name: "Send exactly 1 NOS", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Confirmed · 1 NOS received", exact: true })).toBeVisible();
  expect(state.confirmCalls).toBe(2);
  const confirms = state.requests.filter(request => request.path === "/confirm");
  expect(confirms[0]?.body?.planId).toBe(confirms[1]?.body?.planId);
  expect(confirms[0]?.body?.reviewDigest).toBe(confirms[1]?.body?.reviewDigest);
});

test("an explicitly expired review keeps its details but requires a new review before confirmation", async ({ page }) => {
  const state = await fixture(page); await unlock(page); await prepare(page);
  state.confirmFailure = { status: 409, value: { version: 1, kind: "preflight-failure", code: "review-expired" } };
  await page.getByRole("button", { name: "Send exactly 1 NOS", exact: true }).click();
  await expect(page.locator("#wallet-review")).toBeVisible(); await expect(page.locator("#confirm-transfer")).toBeDisabled();
  await expect(page.locator("#prepare-transfer")).toBeEnabled(); expect(state.consumed).toBe(false);
  expect(state.confirmCalls).toBe(1); expect(state.operations).toHaveLength(0);
});

for (const oversized of [false, true]) test(`untrusted ${oversized ? "oversized" : "extended"} error data is never rendered or accepted as a preauthorization result`, async ({ page }) => {
  const state = await fixture(page); await unlock(page); await prepare(page);
  const malicious = "<img src=x onerror=alert(1)>secret-provider-token";
  state.confirmFailure = { status: 429, value: { version: 1, kind: "preflight-failure", code: "budget-wait", message: malicious.repeat(oversized ? 300 : 1) } };
  await page.getByRole("button", { name: "Send exactly 1 NOS", exact: true }).click();
  await expect(page.locator("#wallet-message")).toContainText("result is not yet known");
  await expect(page.locator("body")).not.toContainText("secret-provider-token"); await expect(page.locator("#wallet-message img")).toHaveCount(0);
  await expect(page.locator("#prepare-transfer")).toBeDisabled(); expect(state.confirmCalls).toBe(1);
});

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

test("Wallet enrolls six editable recovery questions and recovers through three prompts without changing the destination", async ({ page }) => {
  const state = await fixture(page); await unlock(page);
  await page.getByRole("button", { name: "Set or change recovery questions" }).click();
  await expect(page.locator("#recovery-editor fieldset")).toHaveCount(6);
  await expect(page.locator("#recovery-preset-0 option")).toHaveCount(13);
  await page.locator("#recovery-preset-0").selectOption("custom");
  await page.getByLabel("Question 1 wording", { exact: true }).fill("What detail do I remember about our first event?");
  for (let i = 0; i < 6; i++) await page.getByLabel(`Answer ${i + 1}`, { exact: true }).fill(`Private answer ${i}`);
  await page.getByLabel("Current password to save questions").fill(PASSWORD);
  await page.getByRole("button", { name: "Save six questions and lock" }).click();
  await expect(page.locator("#wallet-locked")).toBeVisible();
  expect(state.recoveryQuestions).toHaveLength(6);
  expect(state.recoveryQuestions[0]?.question).toBe("What detail do I remember about our first event?");
  await page.getByRole("button", { name: "Forgot password?", exact: true }).click();
  await expect(page.locator("#recovery-answers input")).toHaveCount(3);
  const firstPrompts = await page.locator("#recovery-answers label").allTextContents();
  await page.reload(); await page.getByRole("button", { name: "Forgot password?", exact: true }).click();
  await expect(page.locator("#recovery-answers label")).toHaveText(firstPrompts);
  for (const i of [4, 0, 2]) await page.getByLabel(state.recoveryQuestions[i]!.question, { exact: true }).fill(`Private answer ${i}`);
  await page.getByRole("button", { name: "Check answers", exact: true }).click();
  await expect(page.locator("#wallet-reset")).toBeVisible();
  expect(await page.locator("#recovery-answers input").evaluateAll(nodes => nodes.every(node => (node as HTMLInputElement).value === ""))).toBe(true);
  await page.getByLabel("New owner password", { exact: true }).fill("a changed synthetic password");
  await page.getByLabel("Confirm new owner password", { exact: true }).fill("a changed synthetic password");
  await page.getByRole("button", { name: "Reset password", exact: true }).click();
  await expect(page.locator("#wallet-locked")).toBeVisible();
  await page.getByLabel("Owner password", { exact: true }).filter({ visible: true }).fill(state.password);
  await page.getByRole("button", { name: "Unlock Wallet", exact: true }).click();
  await expect(page.locator("#receiving-address")).toHaveText(DESTINATION);
  expect(state.requests.filter(r => r.path === "/configuration" && r.method === "POST")).toHaveLength(0);
  expect(await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage), url: location.href }))).toEqual({ local: [], session: [], url: `${ORIGIN}/wallet` });
  expect(state.confirmCalls).toBe(0);
});
test("Wallet recovery explains unavailable questions and recovery-only pacing without partial answer feedback", async ({ page }) => {
  const state = await fixture(page); await page.goto(`${ORIGIN}/wallet`);
  await page.getByRole("button", { name: "Forgot password?", exact: true }).click();
  await expect(page.locator("#recovery-instructions")).toContainText("not available");
  await expect(page.getByRole("button", { name: "Check answers", exact: true })).toBeHidden();
  state.recoveryQuestions = Array.from({ length: 6 }, (_, i) => ({ id: `saved-question-${i}`, question: `Synthetic private question ${i}?`, answer: `Private answer ${i}` }));
  await page.getByRole("button", { name: "Back to password", exact: true }).filter({ visible: true }).click();
  await page.getByRole("button", { name: "Forgot password?", exact: true }).click();
  for (const i of [4, 0, 2]) await page.getByLabel(`Synthetic private question ${i}?`, { exact: true }).fill(i === 0 ? "wrong answer" : `Private answer ${i}`);
  await page.getByRole("button", { name: "Check answers", exact: true }).click();
  await expect(page.locator("#wallet-message")).toHaveText("The answers or recovery authorization were not accepted. Answer all three questions again.");
  state.recoveryLimited = true;
  for (const i of [4, 0, 2]) await page.getByLabel(`Synthetic private question ${i}?`, { exact: true }).fill(`Private answer ${i}`);
  await page.getByRole("button", { name: "Check answers", exact: true }).click();
  await expect(page.locator("#wallet-message")).toContainText("30 minutes");
  await expect(page.locator("#wallet-message")).toContainText("normal password still works");
});
test("Wallet recovery gives a safe next step if the reset response is lost", async ({ page }) => {
  const state = await fixture(page); state.loseResetReply = true;
  state.recoveryQuestions = Array.from({ length: 6 }, (_, i) => ({ id: `saved-question-${i}`, question: `Synthetic private question ${i}?`, answer: `Private answer ${i}` }));
  await page.goto(`${ORIGIN}/wallet`); await page.getByRole("button", { name: "Forgot password?", exact: true }).click();
  for (const i of [4, 0, 2]) await page.getByLabel(`Synthetic private question ${i}?`, { exact: true }).fill(`Private answer ${i}`);
  await page.getByRole("button", { name: "Check answers", exact: true }).click();
  await page.getByLabel("New owner password", { exact: true }).fill("another synthetic password");
  await page.getByLabel("Confirm new owner password", { exact: true }).fill("another synthetic password");
  await page.getByRole("button", { name: "Reset password", exact: true }).click();
  await expect(page.locator("#wallet-message")).toContainText("Try your new password");
  expect(state.requests.filter(r => r.path === "/recovery/reset")).toHaveLength(1);
});
