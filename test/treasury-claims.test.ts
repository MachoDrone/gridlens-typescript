import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { address } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { NOS_MINT } from "../src/fleet/nos.ts";
import { createTreasuryClaims, ClaimsNotDispatchedError, TREASURY_CLAIMS_LEDGER_KEY } from "../src/backend/treasury-claims.ts";
import type { ClaimsAuthorization, ClaimsDriver, ClaimsQuote, ClaimsDispatchResult, ClaimsReceipt, ClaimsAmountCorrection } from "../src/backend/treasury-claims.ts";
import { openTreasuryVault } from "../src/backend/treasury-vault.ts";
import type { PrivateState } from "../src/backend/access.ts";
import type { TreasuryClaimPlan, TreasuryClaimOperation } from "../src/contracts/treasury-claims.ts";
import { claimSignature, parseClaimsOperation, parseClaimsPlan, parseClaimsStatus } from "../src/contracts/treasury-claims.ts";
import { TreasuryPreflightError } from "../src/backend/treasury-errors.ts";
import { parseTreasuryPreflightFailure } from "../src/contracts/treasury.ts";
import { SharedHttpError } from "../src/backend/ipc.ts";
import { openSharedState } from "../src/backend/sqlite-state.ts";
import { initializeClaimsMarker } from "../src/backend/treasury-claims-marker.ts";

const sourceA = "1".repeat(31) + "2", sourceB = "1".repeat(31) + "3", serverId = "generated-server";
const denied = (status: number) => (error: unknown) => error instanceof SharedHttpError && error.status === status;
interface TestStored {
  public: TreasuryClaimOperation; quote: ClaimsQuote; dispatch: ClaimsDispatchResult | null;
  configurationRevision: number; planId: string; reviewDigest: string; requestKeyHash: string; reconcileAttempts: number; nextReconcileAtMs: number;
  amountCorrection?: ClaimsAmountCorrection & { version: 1; factor: "1000000"; signature: string; verifiedSlot: number; verifiedAtMs: number };
}
function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "gridlens-claims-")); chmodSync(directory, 0o700);
  const vault = openTreasuryVault(directory, { create: true });
  const oldTransfer = { consumed: true, operation: "original encrypted successful 1 NOS receipt", configuration: "original encrypted destination", owner: "original verifier" };
  const values = new Map<string, unknown>([["treasury.v1", structuredClone(oldTransfer)]]);
  let at = 1_800_000_000_000, active = true, revision = 2, session = "generated-session-1";
  let financialReady = true;
  const context = { scopeId: "main", rosterRevision: "roster-1", addresses: [sourceA, sourceB] };
  const accounts = new Map<string, string>();
  for (const source of context.addresses) accounts.set(source, (await findAssociatedTokenPda({ owner: address(source), mint: address(NOS_MINT), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0]);
  let batchFailure: ((entries: readonly (readonly [string, unknown])[]) => boolean) | undefined;
  const state: PrivateState = { get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    set() { throw new Error("Claims must use atomic ledger batches."); },
    batch(entries) {
      if (batchFailure?.(entries)) throw new Error("Synthetic atomic persistence failure.");
      const next = new Map(values); for (const [key, value] of entries) next.set(key, structuredClone(value));
      values.clear(); for (const [key, value] of next) values.set(key, value);
    } };
  const calls = { prepare: 0, dispatch: 0, helper: 0, reconcile: 0, recover: 0 };
  let prelaunch: ReturnType<typeof deferred> | undefined, reply: ReturnType<typeof deferred> | undefined;
  let dispatchSnapshot: [string, unknown][] | undefined, lost = false, receiptMode: ClaimsReceipt["status"] = "confirmed";
  let prepareError: unknown, admissionError: unknown, changeQuote: ((quote: ClaimsQuote) => ClaimsQuote) | undefined;
  let responseChange: ((response: ClaimsDispatchResult) => unknown) | undefined, receiptChange: ((response: ClaimsReceipt) => ClaimsReceipt) | undefined;
  const driver: ClaimsDriver = {
    async prepare(fleet, source) {
      calls.prepare++; if (prepareError) throw prepareError;
      const quote: ClaimsQuote = { scopeId: fleet.scopeId, rosterRevision: fleet.rosterRevision, sourceAddress: source,
        sourceBinding: { pcId: "a".repeat(64), nodeId: "b".repeat(64), containerId: "c".repeat(64), sshIdentity: `SHA256:${"d".repeat(43)}` },
        sourceTokenAddress: accounts.get(source)!, mintAddress: NOS_MINT, decimals: 6, lastReportedAmountBaseUnits: "2000000", checkedAtMs: at, expiresAtMs: at + 60_000 };
      return changeQuote?.(quote) ?? quote;
    },
    assertReady() { if (admissionError) throw admissionError; },
    async dispatch(quote, authorize) {
      calls.dispatch++;
      const index = values.get(TREASURY_CLAIMS_LEDGER_KEY) as { entries: { id: string }[]; unresolvedId: string };
      const saved = vault.open<{ public: TreasuryClaimOperation }>(values.get(`${TREASURY_CLAIMS_LEDGER_KEY}/operation/${index.unresolvedId}`) as string, `${serverId}:claims-v1:${index.unresolvedId}`);
      assert.equal(saved.public.phase, "dispatch-started"); assert.equal(saved.public.sourceAddress, quote.sourceAddress);
      dispatchSnapshot = structuredClone([...values]);
      if (prelaunch) await prelaunch.promise;
      try { authorize(); } catch { throw new ClaimsNotDispatchedError(); }
      calls.helper++;
      if (reply) await reply.promise;
      if (lost) throw new Error("Synthetic helper reply lost after possible payment.");
      const response: ClaimsDispatchResult = { status: "acknowledged", success: true, amountUnit: "base-units", claimedAmountAtoms: "2500000", signature: "2".repeat(88), observedAtMs: at };
      return (responseChange?.(response) ?? response) as ClaimsDispatchResult;
    },
    async reconcile(operation) {
      calls.reconcile++;
      const result: ClaimsReceipt = { status: receiptMode, observedAtMs: at, ...(receiptMode === "uncertain" ? {} : { slot: 42 }),
        ...(receiptMode === "confirmed" ? { paidAmountBaseUnits: operation.dispatch.claimedAmountAtoms!, payoutOwner: operation.quote.sourceAddress,
          payoutTokenAddress: operation.quote.sourceTokenAddress, mintAddress: NOS_MINT } : {}) };
      return receiptChange?.(result) ?? result;
    },
  };
  const authorizeOperation = (body: Record<string, unknown>): ClaimsAuthorization => {
    const bound = { ...body }, initialRevision = revision, initialSession = session, initialRoster = context.rosterRevision;
    const guard = () => { if (!active || bound.token !== "generated-app-token" || bound.unlockToken !== "generated-owner-token"
      || revision !== initialRevision || session !== initialSession || context.rosterRevision !== initialRoster
      || bound.httpsOrigin !== "https://fixture.invalid" || bound.serverCertificateSha256 !== "e".repeat(64)) throw new SharedHttpError(401); };
    guard(); return { context: structuredClone(context), deviceId: "generated-device", configurationRevision: revision, authorizationId: session, guard, touch: guard };
  };
  const make = (initialize = false) => createTreasuryClaims(state, { serverId, vault, driver, authorizeOperation, now: () => at, initialize,
    requireFinancialReady() { if (!financialReady) throw new TreasuryPreflightError("source-changed"); } });
  let engine = make(true);
  const request = (operation: string, input: Record<string, unknown> = {}) => engine.dispatch({ operation, token: "generated-app-token", unlockToken: "generated-owner-token",
    httpsOrigin: "https://fixture.invalid", serverCertificateSha256: "e".repeat(64), ...input });
  const prepare = (sourceAddress = sourceA) => request("claims-prepare", { sourceAddress }) as Promise<TreasuryClaimPlan>;
  const confirm = (plan: TreasuryClaimPlan, idempotencyKey = `generated-request-${plan.planId}`) => request("claims-confirm", {
    planId: plan.planId, reviewDigest: plan.reviewDigest, idempotencyKey }) as Promise<{ version: 1; operation: TreasuryClaimOperation }>;
  const status = async () => parseClaimsStatus(await request("claims-status"));
  return { directory, values, state, vault, accounts, calls, request, prepare, confirm, status, oldTransfer, authorizeOperation,
    get engine() { return engine; }, advance(ms: number) { at += ms; }, lock() { active = false; }, unlock() { active = true; }, resetOwner() { revision++; session = "new-generated-session"; },
    ready(value: boolean) { financialReady = value; },
    recover(response: ClaimsDispatchResult | null) { driver.recover = async (quote, operationId) => {
      calls.recover++; assert.equal(readStored(operationId).quote.sourceAddress, quote.sourceAddress); return response;
    }; },
    scope(value: string) { context.scopeId = value; context.rosterRevision = `roster-${value}`; revision++; session = `session-${value}`; },
    prepareFailure(error: unknown) { prepareError = error; }, admissionFailure(error: unknown) { admissionError = error; }, quote(change: (value: ClaimsQuote) => ClaimsQuote) { changeQuote = change; },
    response(change: (value: ClaimsDispatchResult) => unknown) { responseChange = change; }, receipt(mode: ClaimsReceipt["status"]) { receiptMode = mode; },
    receiptFields(change: (value: ClaimsReceipt) => ClaimsReceipt) { receiptChange = change; }, loseReply() { lost = true; },
    blockBeforeHelper() { prelaunch = deferred(); return prelaunch.release; }, blockReply() { reply = deferred(); return reply.release; },
    failBatch(predicate: (entries: readonly (readonly [string, unknown])[]) => boolean) { batchFailure = predicate; },
    stored(operationId: string): TestStored { return vault.open<TestStored>(values.get(`${TREASURY_CLAIMS_LEDGER_KEY}/operation/${operationId}`) as string, `${serverId}:claims-v1:${operationId}`); },
    replaceStored(operationId: string, row: TestStored) { values.set(`${TREASURY_CLAIMS_LEDGER_KEY}/operation/${operationId}`, vault.seal(row, `${serverId}:claims-v1:${operationId}`)); },
    async restart(fromDispatchSnapshot = false) {
      await engine.close(); if (fromDispatchSnapshot) { assert(dispatchSnapshot); values.clear(); for (const [key, value] of dispatchSnapshot) values.set(key, structuredClone(value)); }
      engine = make();
    },
    async close() { prelaunch?.release(); reply?.release(); await engine.close(); vault.close(); rmSync(directory, { recursive: true, force: true }); },
  };
  function readStored(operationId: string): TestStored { return vault.open<TestStored>(values.get(`${TREASURY_CLAIMS_LEDGER_KEY}/operation/${operationId}`) as string, `${serverId}:claims-v1:${operationId}`); }
}

test("partial guardian enrollment blocks claims before reservation and fences an admitted operation before helper launch", async () => {
  const f = await fixture();
  try {
    f.ready(false);
    assert.equal(parseTreasuryPreflightFailure(await f.prepare()).code, "source-changed"); assert.equal(f.calls.prepare, 0);
    assert.equal((await f.status()).attemptedHosts.length, 0);
    f.ready(true); const plan = await f.prepare(); f.ready(false);
    assert.equal(parseTreasuryPreflightFailure(await f.confirm(plan)).code, "source-changed");
    assert.equal((await f.status()).attemptedHosts.length, 0); assert.equal(f.calls.helper, 0);
    f.ready(true); const release = f.blockBeforeHelper(); const accepted = await f.confirm(plan); f.ready(false); release(); await f.engine.waitForIdle();
    assert.equal(f.stored(accepted.operation.id).public.phase, "cancelled"); assert.equal(f.calls.helper, 0);
    assert.deepEqual(f.values.get("treasury.v1"), f.oldTransfer);
  } finally { await f.close(); }
});

test("lost guardian ACK recovery reads only the recorded operation with durable pacing and still requires exact finalized payout proof", async () => {
  const f = await fixture();
  try {
    f.loseReply(); f.recover(null);
    const accepted = await f.confirm(await f.prepare()); await f.engine.waitForIdle();
    assert.equal(f.stored(accepted.operation.id).public.phase, "needs-verification"); assert.equal(f.calls.helper, 1);
    f.lock(); await f.engine.reconcilePending(); assert.equal(f.calls.recover, 1); assert.equal(f.calls.reconcile, 0);
    await f.restart(); f.advance(14_999); await f.engine.reconcilePending(); assert.equal(f.calls.recover, 1);
    f.recover({ status: "acknowledged", success: true, amountUnit: "base-units", claimedAmountAtoms: "2500000", signature: "2".repeat(88), observedAtMs: 1_800_000_000_000 });
    f.receiptFields(receipt => ({ ...receipt, payoutOwner: sourceB }));
    f.advance(1); await f.engine.reconcilePending();
    assert.equal(f.calls.recover, 2); assert.equal(f.stored(accepted.operation.id).public.phase, "verifying");
    assert.equal(f.stored(accepted.operation.id).public.signature, "2".repeat(88));
    f.receiptFields(receipt => receipt); f.advance(30_000); await f.engine.reconcilePending();
    assert.equal(f.stored(accepted.operation.id).public.phase, "confirmed");
    assert.equal(f.calls.recover, 2); assert.equal(f.calls.helper, 1); assert.equal(f.calls.dispatch, 1);
    assert.deepEqual(f.values.get("treasury.v1"), f.oldTransfer);
  } finally { await f.close(); }
});

test("full reward claim verifies host payout, preserves original NOS pilot and permits a different host only afterward", async () => {
  const f = await fixture();
  try {
    const plan = parseClaimsPlan(await f.prepare()); assert.equal(plan.quote.payoutOwner, sourceA); assert.equal(plan.quote.amountMode, "full-available");
    assert.equal(plan.quote.payoutTokenAddress, f.accounts.get(sourceA)); assert.equal(f.calls.helper, 0);
    const accepted = await f.confirm(plan); await f.engine.waitForIdle();
    const result = await f.request("claims-operations", { id: accepted.operation.id }) as { operation: TreasuryClaimOperation };
    parseClaimsOperation(result.operation); assert.equal(result.operation.phase, "confirmed"); assert.equal(result.operation.paidAmountBaseUnits, "2500000");
    assert.equal(result.operation.lastReportedAmountBaseUnits, "2000000", "full available rewards may change before dispatch");
    const status = await f.status(); assert.deepEqual(status.attemptedHosts, [sourceA]); assert.equal(status.unresolvedOperationId, null);
    assert.deepEqual(status.eligibleHosts.map(row => row.address), [sourceB]);
    await assert.rejects(f.prepare(), denied(409)); const second = await f.prepare(sourceB); await f.confirm(second); await f.engine.waitForIdle();
    assert.equal(f.calls.helper, 2); assert.deepEqual(f.values.get("treasury.v1"), f.oldTransfer);
    assert.deepEqual((await f.status()).attemptedHosts, [sourceA, sourceB]);
  } finally { await f.close(); }
});

/** Construct a legacy encrypted record, not a new unmarked helper response.
 * The latter must fail closed under the corrected wire protocol. */
async function legacyPending(f: Awaited<ReturnType<typeof fixture>>, amount = "2500000000000") {
  f.receipt("uncertain"); const accepted = await f.confirm(await f.prepare()); await f.engine.waitForIdle();
  const row = f.stored(accepted.operation.id); assert(row.dispatch);
  delete row.dispatch.amountUnit; row.dispatch.claimedAmountAtoms = amount; row.public.paidAmountBaseUnits = amount;
  f.replaceStored(accepted.operation.id, row); await f.restart();
  return { operationId: accepted.operation.id, before: f.stored(accepted.operation.id) };
}
const correctedReceipt = (original = "2500000000000", corrected = "2500000") => (receipt: ClaimsReceipt): ClaimsReceipt => ({
  ...receipt, paidAmountBaseUnits: corrected, amountCorrection: { kind: "legacy-post-base-units", originalClaimedAmountAtoms: original, correctedClaimedAmountAtoms: corrected },
});

test("legacy amount correction atomically retains provenance and confirms only the recorded signature without another claim", async () => {
  const f = await fixture();
  try {
    const { operationId, before } = await legacyPending(f), oldIndex = structuredClone(f.values.get(TREASURY_CLAIMS_LEDGER_KEY)) as { entries: unknown[] };
    const oldTransfer = structuredClone(f.values.get("treasury.v1"));
    f.receipt("confirmed"); f.receiptFields(correctedReceipt()); f.advance(15_000); await f.engine.reconcilePending();
    const after = f.stored(operationId); assert.equal(after.public.phase, "confirmed");
    assert.equal(after.dispatch?.claimedAmountAtoms, "2500000"); assert.equal(after.dispatch?.amountUnit, "base-units");
    assert.equal(after.public.paidAmountBaseUnits, "2500000"); assert.equal(after.public.signature, before.public.signature);
    assert.deepEqual(after.amountCorrection, { version: 1, kind: "legacy-post-base-units", originalClaimedAmountAtoms: "2500000000000",
      correctedClaimedAmountAtoms: "2500000", factor: "1000000", signature: "2".repeat(88), verifiedSlot: 42, verifiedAtMs: after.public.confirmedAtMs });
    for (const field of ["quote", "configurationRevision", "planId", "reviewDigest", "requestKeyHash"] as const) assert.deepEqual(after[field], before[field]);
    assert.equal(after.reconcileAttempts, before.reconcileAttempts + 1); assert.equal(after.public.id, operationId);
    assert.deepEqual((f.values.get(TREASURY_CLAIMS_LEDGER_KEY) as { entries: unknown[] }).entries, oldIndex.entries);
    assert.deepEqual(f.values.get("treasury.v1"), oldTransfer); assert.equal(f.calls.dispatch, 1); assert.equal(f.calls.helper, 1);
    const saved = f.values.get(`${TREASURY_CLAIMS_LEDGER_KEY}/operation/${operationId}`);
    assert.equal(String(saved).includes("2500000000000"), false, "correction provenance remains encrypted");
    await f.restart(); await f.engine.reconcilePending(); assert.equal(f.values.get(`${TREASURY_CLAIMS_LEDGER_KEY}/operation/${operationId}`), saved);
    assert.equal((await f.status()).unresolvedOperationId, null); await assert.rejects(f.prepare(sourceA), denied(409));
    assert.equal(f.calls.helper, 1); assert.equal(f.calls.reconcile, 2);
  } finally { await f.close(); }
});

test("new unmarked helper results cannot masquerade as legacy stored acknowledgments", async () => {
  const f = await fixture();
  try {
    f.response(({ amountUnit: _unit, ...response }) => response);
    const accepted = await f.confirm(await f.prepare()); await f.engine.waitForIdle();
    const stored = f.stored(accepted.operation.id); assert.equal(stored.public.phase, "needs-verification"); assert.equal(stored.dispatch, null);
    assert.equal(f.calls.helper, 1); assert.equal(f.calls.reconcile, 0); await f.restart(); await f.engine.reconcilePending();
    assert.equal(f.calls.helper, 1); await assert.rejects(f.prepare(sourceB), denied(409));
  } finally { await f.close(); }
});

test("marked base-unit records never accept a legacy scaling correction", async () => {
  const f = await fixture();
  try {
    f.receipt("uncertain"); f.response(response => ({ ...response, claimedAmountAtoms: "2500000000000" }));
    const accepted = await f.confirm(await f.prepare()); await f.engine.waitForIdle();
    f.receipt("confirmed"); f.receiptFields(correctedReceipt()); f.advance(15_000); await f.engine.reconcilePending();
    const row = f.stored(accepted.operation.id); assert.equal(row.public.phase, "verifying"); assert.equal(row.amountCorrection, undefined);
    assert.equal(row.dispatch?.amountUnit, "base-units"); assert.equal(row.public.paidAmountBaseUnits, "2500000000000");
    assert.equal(f.calls.helper, 1); await assert.rejects(f.prepare(sourceB), denied(409));
  } finally { await f.close(); }
});

test("legacy correction rejects altered metadata, wrong payout proofs and nonintegral scaling", async () => {
  const mutations: ((receipt: ClaimsReceipt) => ClaimsReceipt)[] = [
    receipt => ({ ...receipt, amountCorrection: { ...receipt.amountCorrection!, originalClaimedAmountAtoms: "2500000000001" } }),
    receipt => ({ ...receipt, amountCorrection: { ...receipt.amountCorrection!, correctedClaimedAmountAtoms: "2500001" } }),
    receipt => ({ ...receipt, amountCorrection: { ...receipt.amountCorrection!, kind: "unknown" as never } }),
    receipt => ({ ...receipt, amountCorrection: { ...receipt.amountCorrection!, extra: "upstream text" } as ClaimsAmountCorrection }),
    receipt => ({ ...receipt, paidAmountBaseUnits: "2500001" }),
    receipt => ({ ...receipt, payoutOwner: sourceB }),
    receipt => ({ ...receipt, payoutTokenAddress: sourceB }),
    receipt => ({ ...receipt, mintAddress: sourceB }),
    receipt => ({ ...receipt, slot: 0 }),
    receipt => ({ ...receipt, observedAtMs: 8_640_000_000_000_000 }),
  ];
  for (const mutate of mutations) {
    const f = await fixture();
    try {
      const { operationId, before } = await legacyPending(f);
      f.receipt("confirmed"); f.receiptFields(receipt => mutate(correctedReceipt()(receipt))); f.advance(15_000); await f.engine.reconcilePending();
      const after = f.stored(operationId); assert.equal(after.public.phase, "verifying"); assert.equal(after.amountCorrection, undefined);
      assert.deepEqual(after.dispatch, before.dispatch); assert.equal(after.public.paidAmountBaseUnits, before.public.paidAmountBaseUnits);
      assert.equal((await f.status()).unresolvedOperationId, operationId); assert.equal(f.calls.helper, 1);
    } finally { await f.close(); }
  }
});

test("legacy as-recorded confirmation needs no unit correction and settled legacy history is never rewritten", async () => {
  const f = await fixture();
  try {
    const { operationId } = await legacyPending(f, "2500000");
    f.receipt("confirmed"); f.advance(15_000); await f.engine.reconcilePending();
    const row = f.stored(operationId); assert.equal(row.public.phase, "confirmed"); assert.equal(row.dispatch?.amountUnit, undefined); assert.equal(row.amountCorrection, undefined);
    const encrypted = f.values.get(`${TREASURY_CLAIMS_LEDGER_KEY}/operation/${operationId}`);
    await f.restart(); await f.engine.reconcilePending();
    assert.equal(f.values.get(`${TREASURY_CLAIMS_LEDGER_KEY}/operation/${operationId}`), encrypted); assert.equal(f.calls.reconcile, 2); assert.equal(f.calls.helper, 1);
  } finally { await f.close(); }
});

test("migration write failure leaves the original amount and unresolved reservation intact until atomic recovery", async () => {
  const f = await fixture();
  try {
    const { operationId, before } = await legacyPending(f); f.receipt("confirmed"); f.receiptFields(correctedReceipt());
    f.failBatch(entries => entries.some(([key, value]) => key.endsWith('/'+operationId)
      && f.vault.open<TestStored>(value as string, `${serverId}:claims-v1:${operationId}`).amountCorrection !== undefined));
    f.advance(15_000); await assert.rejects(f.engine.reconcilePending(), denied(503));
    assert.equal((await f.status()).state, "recovery-required");
    const retained = f.stored(operationId); assert.deepEqual(retained.dispatch, before.dispatch); assert.equal(retained.amountCorrection, undefined);
    assert.equal(retained.public.paidAmountBaseUnits, before.public.paidAmountBaseUnits);
    assert.equal((f.values.get(TREASURY_CLAIMS_LEDGER_KEY) as { unresolvedId: string }).unresolvedId, operationId);
    f.failBatch(() => false); await f.restart(); f.advance(30_000); await f.engine.reconcilePending();
    assert.equal(f.stored(operationId).public.phase, "confirmed"); assert.equal(f.calls.helper, 1); assert.equal(f.calls.dispatch, 1);
    assert.deepEqual(f.values.get("treasury.v1"), f.oldTransfer);
  } finally { await f.close(); }
});

test("tampered retained correction provenance fails closed without rearming a host", async () => {
  for (const field of ["signature", "factor", "originalClaimedAmountAtoms", "verifiedSlot", "verifiedAtMs"] as const) {
    const f = await fixture();
    try {
      const { operationId } = await legacyPending(f); f.receipt("confirmed"); f.receiptFields(correctedReceipt()); f.advance(15_000); await f.engine.reconcilePending();
      const row = f.stored(operationId); assert(row.amountCorrection);
      if (field === "signature") row.amountCorrection.signature = "3".repeat(88);
      else if (field === "factor") row.amountCorrection.factor = "1000" as never;
      else if (field === "originalClaimedAmountAtoms") row.amountCorrection.originalClaimedAmountAtoms = "1";
      else row.amountCorrection[field]++;
      f.replaceStored(operationId, row); await f.restart(); assert.equal((await f.status()).state, "recovery-required");
      await assert.rejects(f.prepare(), denied(503)); assert.equal(f.calls.helper, 1); assert.deepEqual(f.values.get("treasury.v1"), f.oldTransfer);
    } finally { await f.close(); }
  }
});

test("missing signature, malformed response, rejection and lost reply block all later claims without replay", async () => {
  for (const mode of ["missing-signature", "malformed", "rejected", "lost"] as const) {
    const f = await fixture();
    try {
      if (mode === "missing-signature") f.response(({ signature: _signature, ...rest }) => rest);
      if (mode === "malformed") f.response(response => ({ ...response, signature: "bad", raw: "secret" }));
      if (mode === "rejected") f.response(() => ({ status: "rejected", success: false, observedAtMs: 1_800_000_000_000 }));
      if (mode === "lost") f.loseReply();
      const plan = await f.prepare(), accepted = await f.confirm(plan); await f.engine.waitForIdle();
      const row = await f.request("claims-operations", { id: accepted.operation.id }) as { operation: TreasuryClaimOperation };
      assert.equal(row.operation.phase, "needs-verification"); assert.equal(f.calls.reconcile, 0);
      assert.equal(JSON.stringify(row).includes("secret"), false);
      await f.restart(); for (let i = 0; i < 4; i++) { f.advance(300_000); await f.engine.reconcilePending(); }
      assert.equal(f.calls.helper, 1); assert.equal(f.calls.reconcile, 0); await assert.rejects(f.prepare(sourceB), denied(409));
      assert.deepEqual(f.values.get("treasury.v1"), f.oldTransfer);
    } finally { await f.close(); }
  }
});

test("idempotent double confirmation journals exactly once and active work excludes another host", async () => {
  const f = await fixture(), release = f.blockReply();
  try {
    const plan = await f.prepare(); const [first, second] = await Promise.all([f.confirm(plan), f.confirm(plan)]);
    assert.equal(first.operation.id, second.operation.id); assert.equal(f.calls.helper, 1);
    await assert.rejects(f.prepare(sourceB), denied(409)); await assert.rejects(f.confirm(plan, "different-generated-request"), denied(409));
    release(); await f.engine.waitForIdle(); assert.equal(f.calls.helper, 1);
  } finally { release(); await f.close(); }
});

test("owner reset before helper launch cancels without payment and never rearms the same public host", async () => {
  const f = await fixture(), release = f.blockBeforeHelper();
  try {
    const accepted = await f.confirm(await f.prepare()); f.resetOwner(); release(); await f.engine.waitForIdle();
    const row = await f.request("claims-operations", { id: accepted.operation.id }) as { operation: TreasuryClaimOperation };
    assert.equal(row.operation.phase, "cancelled"); assert.equal(f.calls.helper, 0);
    await f.restart(); await assert.rejects(f.prepare(), denied(409)); assert.equal((await f.status()).eligibleHosts[0]?.address, sourceB);
    assert.deepEqual(f.values.get("treasury.v1"), f.oldTransfer);
  } finally { release(); await f.close(); }
});

test("accepted helper response survives owner lock and graceful shutdown then reconciles without another POST", async () => {
  const f = await fixture(), release = f.blockReply();
  try {
    const accepted = await f.confirm(await f.prepare()); assert.equal(f.calls.helper, 1); f.lock();
    const closing = f.engine.close(); release(); await closing;
    f.unlock(); await f.restart(); f.advance(15_000); await f.engine.reconcilePending();
    const row = await f.request("claims-operations", { id: accepted.operation.id }) as { operation: TreasuryClaimOperation };
    assert.equal(row.operation.phase, "confirmed"); assert.equal(f.calls.helper, 1); assert.equal(f.calls.reconcile, 1);
  } finally { release(); await f.close(); }
});

test("valid payout evidence survives owner-clock rollback or a future ACK time and reconciles without replay", async () => {
  for (const clock of ["rollback", "future-ack"] as const) {
    const f = await fixture(), release = f.blockReply();
    try {
      f.receipt("uncertain");
      const accepted = await f.confirm(await f.prepare()); assert.equal(f.calls.helper, 1);
      if (clock === "rollback") f.advance(-60_000);
      else f.response(response => ({ ...response, observedAtMs: response.observedAtMs + 60_000 }));
      release(); await f.engine.waitForIdle();
      const before = await f.request("claims-operations", { id: accepted.operation.id }) as { operation: TreasuryClaimOperation };
      assert.equal(before.operation.phase, "verifying"); assert.equal(before.operation.signature, "2".repeat(88));
      assert.equal(before.operation.paidAmountBaseUnits, "2500000"); assert.equal(before.operation.updatedAtMs, before.operation.startedAtMs);
      assert.equal(f.calls.reconcile, 1, "captured signature remains eligible for receipt verification");
      await f.restart(); f.advance(clock === "rollback" ? 75_000 : 15_000); f.receipt("confirmed"); await f.engine.reconcilePending();
      const after = await f.request("claims-operations", { id: accepted.operation.id }) as { operation: TreasuryClaimOperation };
      assert.equal(after.operation.phase, "confirmed"); assert.equal(after.operation.signature, before.operation.signature);
      assert.equal(after.operation.paidAmountBaseUnits, before.operation.paidAmountBaseUnits); assert.equal(f.calls.helper, 1);
      assert.equal(f.calls.dispatch, 1); assert.deepEqual(f.values.get("treasury.v1"), f.oldTransfer);
    } finally { release(); await f.close(); }
  }
});

test("restart from a dispatch-started journal needs verification and never repeats the claim", async () => {
  const f = await fixture();
  try {
    const accepted = await f.confirm(await f.prepare()); await f.engine.waitForIdle();
    await f.restart(true); await f.engine.reconcilePending();
    const row = await f.request("claims-operations", { id: accepted.operation.id }) as { operation: TreasuryClaimOperation };
    assert.equal(row.operation.phase, "needs-verification"); assert.equal(row.operation.signature, null);
    f.advance(900_000); await f.engine.reconcilePending(); assert.equal(f.calls.helper, 1); await assert.rejects(f.prepare(sourceB), denied(409));
  } finally { await f.close(); }
});

test("wrong recipient, mint, amount and nonfinalized proof cannot confirm or release another host", async () => {
  for (const mutate of [
    (row: ClaimsReceipt) => ({ ...row, payoutOwner: sourceB }),
    (row: ClaimsReceipt) => ({ ...row, payoutTokenAddress: sourceB }),
    (row: ClaimsReceipt) => ({ ...row, mintAddress: sourceB }),
    (row: ClaimsReceipt) => ({ ...row, paidAmountBaseUnits: "2500001" }),
    (row: ClaimsReceipt) => ({ ...row, slot: 0 }),
  ]) {
    const f = await fixture();
    try {
      f.receiptFields(mutate); const accepted = await f.confirm(await f.prepare()); await f.engine.waitForIdle();
      const row = await f.request("claims-operations", { id: accepted.operation.id }) as { operation: TreasuryClaimOperation };
      assert.equal(row.operation.phase, "verifying"); await assert.rejects(f.prepare(sourceB), denied(409)); assert.equal(f.calls.helper, 1);
    } finally { await f.close(); }
  }
});

test("only signature-backed reconciliation runs and backoff remains durable across restart", async () => {
  const f = await fixture();
  try {
    f.receipt("uncertain"); await f.confirm(await f.prepare()); await f.engine.waitForIdle(); assert.equal(f.calls.reconcile, 1);
    await f.restart(); await f.engine.reconcilePending(); assert.equal(f.calls.reconcile, 1);
    for (const [wait, count] of [[15_000, 2], [30_000, 3], [60_000, 4], [300_000, 5]] as const) {
      f.advance(wait - 1); await f.engine.reconcilePending(); assert.equal(f.calls.reconcile, count - 1);
      f.advance(1); await f.engine.reconcilePending(); assert.equal(f.calls.reconcile, count);
    }
    assert.equal(f.calls.helper, 1); f.receipt("confirmed"); f.advance(300_000); await f.engine.reconcilePending();
    assert.equal((await f.status()).unresolvedOperationId, null); assert.equal(f.calls.helper, 1);
  } finally { await f.close(); }
});

test("source binding, recipient ATA, expired review and authorization failures never dispatch", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.request("claims-prepare", { sourceAddress: sourceA, unlockToken: "wrong" }), denied(401));
    assert.equal(f.calls.prepare, 0);
    f.quote(quote => ({ ...quote, sourceTokenAddress: f.accounts.get(sourceB)! }));
    assert.equal((await f.prepare() as unknown as { code: string }).code, "source-changed");
    f.quote(quote => ({ ...quote, mintAddress: sourceB }));
    assert.equal((await f.prepare() as unknown as { code: string }).code, "preflight-unavailable");
    f.quote(quote => quote); const plan = await f.prepare(); f.advance(60_001);
    assert.equal((await f.confirm(plan) as unknown as { code: string }).code, "review-expired");
    const second = await f.prepare(); f.resetOwner(); await assert.rejects(f.confirm(second), denied(409));
    assert.equal(f.calls.helper, 0); assert.equal((await f.status()).attemptedHosts.length, 0);
  } finally { await f.close(); }
});

test("known preauthorization failure preserves allowance and plan while unknown exceptions are sanitized", async () => {
  const f = await fixture();
  try {
    const plan = await f.prepare(); f.admissionFailure(new TreasuryPreflightError("budget-wait", 1_800_000_060_000));
    assert.deepEqual(await f.confirm(plan), { version: 1, kind: "preflight-failure", code: "budget-wait", retryAtMs: 1_800_000_060_000 });
    assert.equal((await f.status()).attemptedHosts.length, 0); assert.equal(f.calls.helper, 0);
    f.admissionFailure(undefined); f.prepareFailure(new Error("secret https://private.invalid Authorization:value"));
    assert.deepEqual(await f.prepare(), { version: 1, kind: "preflight-failure", code: "preflight-unavailable" });
    await f.confirm(plan); await f.engine.waitForIdle(); assert.equal(f.calls.helper, 1);
  } finally { await f.close(); }
});

test("atomic journal failure prevents helper dispatch; lost acknowledgment persistence fails closed on restart", async () => {
  for (const phase of ["authorization", "acknowledgment"] as const) {
    const f = await fixture();
    try {
      const plan = await f.prepare();
      f.failBatch(entries => entries.some(([key, value]) => {
        if (!key.includes("/operation/")) return false;
        const operationId = key.split("/").at(-1)!;
        const row = f.vault.open<{ dispatch: unknown }>(value as string, `${serverId}:claims-v1:${operationId}`);
        return phase === "authorization" || row.dispatch !== null;
      }));
      if (phase === "authorization") await assert.rejects(f.confirm(plan), denied(503));
      else { await f.confirm(plan); await f.engine.waitForIdle(); }
      assert.equal((await f.status()).state, "recovery-required"); assert.equal(f.calls.helper, phase === "authorization" ? 0 : 1);
      if (phase === "acknowledgment") {
        f.failBatch(() => false); await f.restart(); await f.engine.reconcilePending();
        await assert.rejects(f.prepare(sourceB), denied(409)); assert.equal(f.calls.helper, 1);
      }
      assert.deepEqual(f.values.get("treasury.v1"), f.oldTransfer);
    } finally { await f.close(); }
  }
});

test("missing or malformed retained claim state never silently initializes another allowance", async () => {
  const f = await fixture();
  try {
    f.values.delete(TREASURY_CLAIMS_LEDGER_KEY); await f.restart();
    assert.equal((await f.status()).state, "recovery-required"); await assert.rejects(f.prepare(), denied(503));
    f.values.set(TREASURY_CLAIMS_LEDGER_KEY, { version: 1, entries: [] }); await f.restart();
    assert.equal((await f.status()).supported, false); assert.equal(f.calls.helper, 0);
    assert.deepEqual(f.values.get("treasury.v1"), f.oldTransfer);
  } finally { await f.close(); }
});

test("claim signatures require canonical base58 encoding of exactly 64 bytes", () => {
  assert.equal(claimSignature("2".repeat(88)), true);
  for (const invalid of ["1".repeat(63), "1".repeat(65), "z".repeat(88), "2".repeat(64), "0".repeat(88), "2".repeat(89)])
    assert.equal(claimSignature(invalid), false);
});

test("foreign-scope claim history stays private while per-public-host limits and unresolved blocking remain global", async () => {
  const f = await fixture();
  try {
    f.receipt("uncertain"); const accepted = await f.confirm(await f.prepare()); await f.engine.waitForIdle();
    f.scope("other"); const scoped = await f.status();
    assert.deepEqual(scoped.attemptedHosts, []); assert.deepEqual(scoped.eligibleHosts.map(row => row.address), [sourceB]);
    assert.equal(scoped.unresolvedOperationId, accepted.operation.id, "an opaque blocker grants no access to its record");
    assert.deepEqual(await f.request("claims-operations"), { version: 1, operations: [], total: 0 });
    await assert.rejects(f.request("claims-operations", { id: accepted.operation.id }), denied(403));
    await assert.rejects(f.prepare(sourceB), denied(409));
    f.receipt("confirmed"); f.advance(15_000); await f.engine.reconcilePending();
    await assert.rejects(f.prepare(sourceA), denied(409)); assert.equal(f.calls.helper, 1);
  } finally { await f.close(); }
});

test("real retained SQLite preserves spent hosts and original NOS receipt across paired observation-directory rollback", async () => {
  const f = await fixture();
  const ledgerDirectory = join(f.directory, "retained-ledger");
  let state: ReturnType<typeof openSharedState> | undefined, restoredVault: ReturnType<typeof openTreasuryVault> | undefined;
  let restored: ReturnType<typeof createTreasuryClaims> | undefined;
  try {
    const accepted = await f.confirm(await f.prepare()); await f.engine.waitForIdle();
    const before = JSON.stringify(f.values.get("treasury.v1"));
    assert.equal(initializeClaimsMarker(f.directory, serverId, f.vault.keyId, false), true);
    state = openSharedState(join(f.directory, "observations-new"), { ledgerDirectory });
    // These are real, completed claim records produced above with generated
    // fixtures. The original transfer record is opaque to the claims subsystem.
    state.batch([...f.values]); await state.close(); state = undefined;
    state = openSharedState(join(f.directory, "observations-rollback"), { ledgerDirectory });
    restoredVault = openTreasuryVault(f.directory);
    assert.equal(initializeClaimsMarker(f.directory, serverId, restoredVault.keyId, state.get(TREASURY_CLAIMS_LEDGER_KEY) !== undefined), false);
    const never = async (): Promise<never> => { throw new Error("Rollback must never dispatch another claim."); };
    const driver: ClaimsDriver = { prepare: never, assertReady() { throw new Error("Unexpected admission"); }, dispatch: never, reconcile: never };
    restored = createTreasuryClaims(state, { serverId, vault: restoredVault, driver, authorizeOperation: f.authorizeOperation });
    const body = { token: "generated-app-token", unlockToken: "generated-owner-token", httpsOrigin: "https://fixture.invalid", serverCertificateSha256: "e".repeat(64) };
    const status = parseClaimsStatus(await restored.dispatch({ ...body, operation: "claims-status" }));
    assert.deepEqual(status.attemptedHosts, [sourceA]); assert.equal(status.unresolvedOperationId, null);
    const history = await restored.dispatch({ ...body, operation: "claims-operations", id: accepted.operation.id }) as { operation: TreasuryClaimOperation };
    assert.equal(history.operation.phase, "confirmed"); assert.equal(history.operation.paidAmountBaseUnits, "2500000");
    await assert.rejects(restored.dispatch({ ...body, operation: "claims-prepare", sourceAddress: sourceA }), denied(409));
    await restored.reconcilePending(); assert.equal(JSON.stringify(state.get("treasury.v1")), before);
    assert.deepEqual(state.get("treasury.v1"), f.oldTransfer); assert.equal(f.calls.helper, 1);
  } finally { await restored?.close(); await state?.close(); restoredVault?.close(); await f.close(); }
});
