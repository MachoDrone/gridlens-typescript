import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { address } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { claimUnresolved } from "../../src/contracts/treasury-claims.ts";
import type { TreasuryClaimOperation, TreasuryClaimPhase, TreasuryClaimPlan } from "../../src/contracts/treasury-claims.ts";
import { NOS_MINT } from "../../src/fleet/nos.ts";

const ORIGIN = "https://claims.gridlens.invalid", HOST_A = "1".repeat(31) + "2", HOST_B = "1".repeat(31) + "3", RECEIVER = "1".repeat(31) + "4";
const PASSWORD = "synthetic owner claim password", TOKEN = "synthetic-claims-owner-session".padEnd(43, "x");
const SIGNATURE = "2".repeat(88);
interface RequestRecord { path: string; method: string; body: Record<string, unknown> | null; token: string | undefined }
interface Fixture {
  requests: RequestRecord[]; operations: TreasuryClaimOperation[]; plans: Map<string, TreasuryClaimPlan>; attempted: Set<string>;
  nextPhase: TreasuryClaimPhase; loseConfirmReply: boolean; quoteOwner: string | undefined; operationPayout: string | undefined;
  prepareError: { status: number; value: unknown } | undefined; wait: Promise<void> | undefined; clockOffsetMs: number;
  foreignPending: boolean; claimable: Map<string, string>; ata: Map<string, string>;
}
async function fixture(page: Page): Promise<Fixture> {
  const ata = new Map<string, string>();
  for (const host of [HOST_A, HOST_B]) ata.set(host, (await findAssociatedTokenPda({ owner: address(host), mint: address(NOS_MINT), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0]);
  const state: Fixture = { requests: [], operations: [], plans: new Map(), attempted: new Set(), nextPhase: "confirmed", loseConfirmReply: false,
    quoteOwner: undefined, operationPayout: undefined, prepareError: undefined, wait: undefined, clockOffsetMs: 0, foreignPending: false,
    claimable: new Map([[HOST_A, "427125678"], [HOST_B, "250000"]]), ata };
  const hosts = [{ address: HOST_A, label: "Synthetic host A" }, { address: HOST_B, label: "Synthetic host B" }];
  const configuration = { version: 1, revision: 1, destinationAddress: RECEIVER, hosts, amountBaseUnits: "1000000", reserveLamports: "50000000", maxCostLamports: "5000000", pilotConsumed: true };
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (![ORIGIN, ORIGIN.replace("https:", "http:")].includes(url.origin)) throw new Error(`Unexpected claim fixture request: ${url.origin}`);
    if (url.pathname === "/wallet") {
      const html = (await readFile(resolve("dist/wallet.html"), "utf8")).replace("<main>", '<main><p class="pending small">UI PREVIEW · Synthetic hosts and rewards · No funds can move</p>');
      await route.fulfill({ contentType: "text/html", body: html }); return;
    }
    if (url.pathname === "/wallet.css" || /^\/(?:preview|contracts|fleet)\/[a-z0-9-]+\.js$/.test(url.pathname)) {
      await route.fulfill({ contentType: url.pathname.endsWith(".css") ? "text/css" : "text/javascript", body: await readFile(resolve("dist", url.pathname.slice(1)), "utf8") }); return;
    }
    if (!url.pathname.startsWith("/api/shared/treasury/")) { await route.fulfill({ status: 404 }); return; }
    const path = url.pathname.slice("/api/shared/treasury".length), body = request.postDataJSON() as Record<string, unknown> | null;
    const token = request.headers()["x-gridlens-wallet"]; state.requests.push({ path, method: request.method(), body, token });
    const send = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (path === "/status") { await send({ version: 1, supported: true, state: "locked", pilotConsumed: true, serverId: "synthetic-server", scopeId: "synthetic-scope", revision: 1 }); return; }
    if (path === "/unlock") {
      if (body?.password !== PASSWORD) { await send({}, 401); return; }
      await send({ version: 1, unlockToken: TOKEN, expiresAtMs: Date.now() + 300_000, configuration }); return;
    }
    if (token !== TOKEN) { await send({}, 401); return; }
    if (path === "/lock") { await send({ version: 1, locked: true }); return; }
    if (path === "/configuration") { await send(configuration); return; }
    if (path === "/operations") {
      const at = Date.now() - 60_000;
      await send({ version: 1, operations: [{ id: "previous-one-nos-test", phase: "confirmed", sourceAddress: HOST_A, destinationAddress: RECEIVER,
        amountBaseUnits: "1000000", signature: "3".repeat(88), startedAtMs: at, updatedAtMs: at, confirmedAtMs: at, slot: 99, error: null }] }); return;
    }
    if (path === "/claims/status") {
      await send({ version: 1, supported: true, state: "ready", unresolvedOperationId: state.foreignPending ? "opaque-other-scope-operation"
        : state.operations.find(operation => claimUnresolved(operation.phase))?.id ?? null,
        attemptedHosts: [...state.attempted], eligibleHosts: hosts.filter(host => !state.attempted.has(host.address) && state.claimable.has(host.address)) }); return;
    }
    if (path === "/claims/operations") { await send({ version: 1, operations: state.operations, total: state.operations.length }); return; }
    if (path === "/claims/prepare") {
      if (state.wait) await state.wait;
      if (state.prepareError) { await send(state.prepareError.value, state.prepareError.status); return; }
      const sourceAddress = String(body?.sourceAddress), now = Date.now() + state.clockOffsetMs;
      if (!state.claimable.has(sourceAddress) || state.attempted.has(sourceAddress)) { await send({}, 409); return; }
      const plan: TreasuryClaimPlan = { version: 1, planId: `plan-${state.plans.size + 1}`, reviewDigest: "a".repeat(64), expiresAtMs: now + 60_000,
        quote: { sourceAddress, payoutOwner: state.quoteOwner ?? sourceAddress, payoutTokenAddress: ata.get(sourceAddress)!, mintAddress: NOS_MINT, decimals: 6,
          amountMode: "full-available", lastReportedAmountBaseUnits: state.claimable.get(sourceAddress)!, checkedAtMs: now - 3000, expiresAtMs: now + 60_000 } };
      state.plans.set(plan.planId, plan); await send(plan); return;
    }
    if (path === "/claims/confirm") {
      const plan = state.plans.get(String(body?.planId));
      if (!plan || body?.reviewDigest !== plan.reviewDigest || state.attempted.has(plan.quote.sourceAddress)
        || state.operations.some(operation => claimUnresolved(operation.phase))) { await send({}, 409); return; }
      const source = plan.quote.sourceAddress, now = Date.now(); state.attempted.add(source);
      const verified = state.nextPhase === "confirmed", hasSignature = verified || state.nextPhase === "verifying";
      const operation: TreasuryClaimOperation = { id: `claim-${state.operations.length + 1}`, phase: state.nextPhase, sourceAddress: source, payoutOwner: source,
        payoutTokenAddress: state.operationPayout ?? ata.get(source)!, lastReportedAmountBaseUnits: plan.quote.lastReportedAmountBaseUnits,
        paidAmountBaseUnits: hasSignature ? source === HOST_A ? "428000001" : "250000" : null,
        signature: hasSignature ? SIGNATURE : null, startedAtMs: now, updatedAtMs: now, confirmedAtMs: verified ? now : null,
        slot: verified ? 1234 : null, error: state.nextPhase === "needs-verification" ? "upstream-private-message-do-not-render" : null };
      state.operations.unshift(operation);
      if (state.loseConfirmReply) { await route.abort("failed"); return; }
      await send({ version: 1, operation }); return;
    }
    await send({}, 404);
  });
  return state;
}
async function unlock(page: Page): Promise<void> {
  await page.goto(`${ORIGIN}/wallet`); await page.locator("#unlock-password").fill(PASSWORD);
  await page.getByRole("button", { name: "Unlock Wallet", exact: true }).click();
  await expect(page.locator("#claim-source")).toBeEnabled();
}
async function review(page: Page, host = HOST_A): Promise<void> {
  await page.getByLabel("Host to claim rewards for", { exact: true }).selectOption(host);
  await page.getByRole("button", { name: "Review rewards claim", exact: true }).click();
}
const confirmations = (state: Fixture) => state.requests.filter(request => request.path === "/claims/confirm");

test("two different hosts can claim their full rewards while the consumed 1 NOS transfer remains separate", async ({ page }, testInfo) => {
  const state = await fixture(page); let popups = 0; page.on("popup", () => popups++);
  await unlock(page); await expect(page.locator("#prepare-transfer")).toBeDisabled();
  await expect(page.getByRole("heading", { name: "Confirmed · 1 NOS received", exact: true })).toBeVisible();
  await review(page);
  await expect(page.locator("#claim-review-details")).toContainText("427.125678 NOS");
  await expect(page.locator("#claim-review-details")).toContainText(HOST_A);
  await expect(page.locator("#claim-review-details")).toContainText(state.ata.get(HOST_A)!);
  await expect(page.locator("#claim-review-details")).not.toContainText(RECEIVER);
  await expect(page.locator("#claim-review")).toContainText("amount can change");
  await expect(page.locator("#claim-source")).toBeDisabled(); await expect(page.locator("#prepare-claim")).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("claims-desktop-review.png"), fullPage: true });
  await page.getByRole("button", { name: "Claim all available rewards", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Claim verified · 428.000001 NOS received by host", exact: true })).toBeVisible();
  await expect(page.locator(`#claim-source option[value="${HOST_A}"]`)).toBeDisabled();
  await expect(page.locator("#claim-source")).toBeEnabled();
  await review(page, HOST_B); await expect(page.locator("#claim-review-details")).toContainText("0.25 NOS");
  await page.getByRole("button", { name: "Claim all available rewards", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Claim verified · 0.25 NOS received by host", exact: true })).toBeVisible();
  await expect(page.locator("#claims-status")).toContainText("Each current host has already had its claim attempt");
  await expect(page.locator("#claims-status")).not.toContainText("Refresh after monitoring updates");
  expect(confirmations(state)).toHaveLength(2);
  for (const request of confirmations(state)) { expect(request.token).toBe(TOKEN); expect(Object.keys(request.body!).sort()).toEqual(["idempotencyKey", "planId", "reviewDigest", "version"]); }
  expect(state.requests.some(request => request.path === "/confirm")).toBe(false); expect(popups).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("claims-phone-receipts.png"), fullPage: true });
  await unlock(page); await expect(page.locator("#claim-operations article")).toHaveCount(2);
  await expect(page.getByRole("heading", { name: "Confirmed · 1 NOS received", exact: true })).toBeVisible();
  await expect(page.locator(`#claim-source option[value="${HOST_A}"]`)).toBeDisabled();
  await expect(page.locator(`#claim-source option[value="${HOST_B}"]`)).toBeDisabled();
  expect(confirmations(state)).toHaveLength(2);
});

test("an unresolved claim blocks all hosts, verifies through local GETs, then permits another host", async ({ page }) => {
  const state = await fixture(page); state.nextPhase = "verifying";
  await unlock(page); await review(page); await page.locator("#confirm-claim").click();
  await expect(page.getByRole("heading", { name: "Verifying claim receipt", exact: true })).toBeVisible();
  await expect(page.locator("#claim-source")).toBeDisabled(); await expect(page.locator("#prepare-claim")).toBeDisabled();
  await expect(page.locator("#claim-operations")).not.toContainText("Verified payment:");
  state.operations[0] = { ...state.operations[0]!, phase: "confirmed", confirmedAtMs: Date.now(), slot: 1234, updatedAtMs: Date.now() };
  await page.locator("#refresh-claims").click(); await expect(page.locator("#claim-source")).toBeEnabled();
  await expect(page.getByRole("heading", { name: "Claim verified · 428.000001 NOS received by host", exact: true })).toBeVisible();
  expect(confirmations(state)).toHaveLength(1);
  expect(state.requests.filter(request => request.path.startsWith("/claims/") && request.method === "POST").map(request => request.path))
    .toEqual(["/claims/prepare", "/claims/confirm"]);
});

for (const lost of [false, true]) test(`${lost ? "lost confirmation reply" : "missing payout signature"} needs verification and never retries the claim`, async ({ page }) => {
  const state = await fixture(page); state.nextPhase = "needs-verification"; state.loseConfirmReply = lost;
  await unlock(page); await review(page); await page.locator("#confirm-claim").click();
  await page.locator("#refresh-claims").click();
  await expect(page.getByRole("heading", { name: "Claim needs verification", exact: true })).toBeVisible();
  await expect(page.locator("#claim-source")).toBeDisabled(); await expect(page.locator("#prepare-claim")).toBeDisabled();
  await expect(page.locator("body")).not.toContainText("upstream-private-message-do-not-render");
  await expect(page.locator("#claim-operations")).not.toContainText("Verified payment:");
  await expect(page.locator("#claim-operations a")).toHaveCount(0); expect(confirmations(state)).toHaveLength(1);
  await page.locator("#refresh-claims").click(); expect(confirmations(state)).toHaveLength(1);
});

test("a claim review for an unexpected receiving wallet is rejected before confirmation", async ({ page }) => {
  const state = await fixture(page); state.quoteOwner = RECEIVER;
  await unlock(page); await review(page); await expect(page.locator("#wallet-message")).toContainText("could not complete");
  await expect(page.locator("#claim-review")).toBeHidden(); expect(confirmations(state)).toHaveLength(0);
});

test("an unexpected receipt token account stays blocked through history refresh", async ({ page }) => {
  const state = await fixture(page); state.operationPayout = state.ata.get(HOST_B);
  await unlock(page); await review(page); await page.locator("#confirm-claim").click(); await page.locator("#refresh-claims").click();
  await expect(page.locator("#claims-status")).toContainText("needs verification");
  await expect(page.locator("#claim-source")).toBeDisabled();
  await expect(page.locator("#claim-operations")).not.toContainText("Claim verified"); expect(confirmations(state)).toHaveLength(1);
});

test("claim preparation reports zero or unavailable rewards without a 1 NOS minimum or a POST retry", async ({ page }) => {
  const state = await fixture(page); state.prepareError = { status: 409, value: { version: 1, kind: "preflight-failure", code: "no-claimable-rewards" } };
  await unlock(page); await review(page); await expect(page.locator("#wallet-message")).toContainText("No claimable uptime rewards");
  await expect(page.locator("#wallet-message")).toContainText("No claim was authorized");
  await expect(page.locator("#wallet-message")).not.toContainText("1 NOS"); expect(confirmations(state)).toHaveLength(0);
  state.prepareError = { status: 503, value: { version: 1, kind: "preflight-failure", code: "rewards-unavailable", message: "<img src=x>private upstream details" } };
  await review(page); await expect(page.locator("body")).not.toContainText("private upstream details");
  await expect(page.locator("#wallet-message img")).toHaveCount(0); expect(confirmations(state)).toHaveLength(0);
});

test("duplicate confirm clicks make one claim attempt", async ({ page }) => {
  const state = await fixture(page); state.nextPhase = "authorized";
  await unlock(page); await review(page);
  await page.locator("#confirm-claim").evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(page.getByRole("heading", { name: "Claim authorized", exact: true })).toBeVisible();
  expect(confirmations(state)).toHaveLength(1); await expect(page.locator("#claim-source")).toBeDisabled();
});

test("HTTP never requests claim status or accepts a claim password", async ({ page }) => {
  const state = await fixture(page); await page.goto(`${ORIGIN.replace("https:", "http:")}/wallet`);
  await expect(page.getByRole("heading", { name: "Secure this device first" })).toBeVisible(); expect(state.requests).toHaveLength(0);
  await expect(page.locator("#wallet-claims")).toBeHidden();
});

test("expired reviews and locked pages cannot claim, and late prepare results stay discarded", async ({ page }) => {
  await page.clock.install({ time: new Date() });
  const state = await fixture(page); await unlock(page); await review(page); await expect(page.locator("#claim-review")).toBeVisible();
  await page.clock.fastForward(61_000); await expect(page.locator("#claim-review")).toBeHidden(); expect(confirmations(state)).toHaveLength(0);
  let finish!: () => void; state.wait = new Promise<void>(resolve => { finish = resolve; });
  await review(page); await expect.poll(() => state.requests.filter(request => request.path === "/claims/prepare").length).toBe(2);
  await page.locator("#wallet-lock").click(); finish();
  await expect(page.getByRole("heading", { name: "Unlock Wallet", exact: true })).toBeVisible();
  await expect(page.locator("#claim-review")).toBeHidden(); await expect(page.locator("#claim-operations")).toBeEmpty();
  expect(confirmations(state)).toHaveLength(0);
});

test("claim prepare can complete after twenty seconds and uses only its selected host", async ({ page }) => {
  await page.clock.install({ time: new Date() });
  const state = await fixture(page); let finish!: () => void; state.wait = new Promise<void>(resolve => { finish = resolve; });
  try {
    await unlock(page); await review(page, HOST_B);
    await expect.poll(() => state.requests.filter(request => request.path === "/claims/prepare").length).toBe(1);
    await page.clock.fastForward(25_000); state.clockOffsetMs = 25_000;
    await expect(page.locator("#wallet-message")).toHaveText("Checking this host's claimable rewards…");
    finish(); await expect(page.locator("#claim-review")).toBeVisible();
    expect(state.requests.find(request => request.path === "/claims/prepare")?.body).toEqual({ version: 1, sourceAddress: HOST_B });
    expect(confirmations(state)).toHaveLength(0);
  } finally { finish(); }
});

test("a global pending claim from another scope blocks actions without fetching foreign details or relocking Wallet", async ({ page }) => {
  const state = await fixture(page); state.foreignPending = true;
  await page.goto(`${ORIGIN}/wallet`); await page.locator("#unlock-password").fill(PASSWORD); await page.getByRole("button", { name: "Unlock Wallet", exact: true }).click();
  await expect(page.locator("#wallet-unlocked")).toBeVisible(); await expect(page.locator("#claim-source")).toBeDisabled();
  await expect(page.locator("#claims-status")).toContainText("still being verified");
  expect(state.requests.some(request => request.path.includes("opaque-other-scope-operation"))).toBe(false);
});
