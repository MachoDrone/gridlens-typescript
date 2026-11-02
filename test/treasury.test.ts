import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, chmodSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAccess } from "../src/backend/access.ts";
import type { PrivateState } from "../src/backend/access.ts";
import { createTreasury, TREASURY_LEDGER_KEY } from "../src/backend/treasury.ts";
import type { TreasuryDriver, TreasuryQuote, TreasurySigned } from "../src/backend/treasury.ts";
import { openTreasuryVault } from "../src/backend/treasury-vault.ts";
import type { TreasuryOperation, TreasuryPlan, TreasuryUnlock } from "../src/contracts/treasury.ts";
import { TREASURY_AMOUNT, TREASURY_MAX_COST, TREASURY_RESERVE, TREASURY_PREFLIGHT_CODES, parseTreasuryConfiguration, parseTreasuryPlan,
  parseTreasuryOperation, parseTreasuryPreflightFailure, treasuryPreflightStatus } from "../src/contracts/treasury.ts";
import { TreasuryPreflightError, treasuryPreflightFailure } from "../src/backend/treasury-errors.ts";
import { NOS_MINT } from "../src/fleet/nos.ts";
import { SharedHttpError } from "../src/backend/ipc.ts";

const address = (last: string) => "1".repeat(31) + last;
const source = address("2"), destination = address("3"), password = "generated Wallet passphrase";
const security = { httpsOrigin: "https://192.168.42.10:8790", serverCertificateSha256: "f".repeat(64) };
const denied = (status: number) => (error: unknown) => error instanceof SharedHttpError && error.status === status;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gridlens-treasury-")); chmodSync(root, 0o700);
  const values = new Map<string, unknown>(); let at = 1_800_000_000_000;
  const securityState = { ...security };
  let failWrite: ((value: unknown) => boolean) | undefined;
  const state: PrivateState = { get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    set(key, value) { if (key === TREASURY_LEDGER_KEY && failWrite?.(value)) throw new Error("Synthetic durable failure"); values.set(key, structuredClone(value)); } };
  let access = createAccess(state, () => at); const context = access.setFleet("main", [source, address("5")]);
  const operator = access.pair(access.createCode("main", "operator").code, "Generated owner browser");
  const employee = access.pair(access.createCode("main", "operator").code, "Generated employee browser");
  const viewer = access.pair(access.createCode("main", "viewer").code, "Generated viewer");
  let vault = openTreasuryVault(root, { create: true });
  const calls = { prepare: 0, sign: 0, submit: 0, reconcile: 0 };
  let keyReaderCalls = 0;
  let quoteChange: ((quote: TreasuryQuote) => TreasuryQuote) | undefined;
  let prepareError: unknown, admissionError: unknown;
  let signWait: ReturnType<typeof deferred<void>> | undefined;
  let submitWait: ReturnType<typeof deferred<void>> | undefined;
  let submitFailure = false, receipt: "confirmed" | "failed" | "uncertain" = "confirmed";
  let admissionReady = true, providerRetryAtMs: number | undefined;
  const signature = "2".repeat(88), transactionBase64 = Buffer.from("generated-signed-transaction-never-sent-to-a-network").toString("base64");
  const driver: TreasuryDriver = {
    assertReady() {
      if (admissionError !== undefined) throw admissionError;
      if (!admissionReady) throw new TreasuryPreflightError("budget-wait", at + 60_000);
    },
    async prepare(fleet, sourceAddress, destinationAddress) {
      calls.prepare++;
      if (prepareError !== undefined) throw prepareError;
      const quote: TreasuryQuote = { scopeId: fleet.scopeId, rosterRevision: fleet.rosterRevision, sourceAddress, destinationAddress,
        sourceTokenAddress: address("6"), destinationTokenAddress: address("7"), mintAddress: NOS_MINT,
        amountBaseUnits: TREASURY_AMOUNT, decimals: 6, feeLamports: "5000", rentLamports: "2039280", reserveLamports: TREASURY_RESERVE,
        maxCostLamports: TREASURY_MAX_COST, createDestinationAta: true, sourceNosBaseUnits: "2000000", sourceSolLamports: "100000000",
        preparedAtMs: at, expiresAtMs: at + 60_000, sourceBinding: { pcId: "a".repeat(64), nodeId: "b".repeat(64), containerId: "c".repeat(64), sshIdentity: `SHA256:${"d".repeat(43)}` },
        messageBase64: Buffer.from("generated-message").toString("base64"), blockhash: address("8"), lastValidBlockHeight: 1200 };
      return quoteChange?.(quote) ?? quote;
    },
    async sign(quote, authorize) { calls.sign++; if (signWait) await signWait.promise; authorize?.(); keyReaderCalls++; return { quote, transactionBase64, signature }; },
    async submit(signed, authorize) {
      if (submitWait) await submitWait.promise;
      authorize?.();
      calls.submit++;
      const ledger = values.get(TREASURY_LEDGER_KEY) as { consumed: boolean; operation: string };
      const journal = vault.open<{ signed: TreasurySigned; public: TreasuryOperation }>(ledger.operation, `${access.serverId}:operation`);
      assert.equal(ledger.consumed, true); assert.equal(journal.public.phase, "submission-started");
      assert.deepEqual(journal.signed, signed, "exact signed bytes and signature are durable before submission");
      if (submitFailure) throw new Error("Synthetic lost acknowledgement");
    },
    async reconcile() { calls.reconcile++; return { status: receipt, observedAtMs: at, ...(receipt === "confirmed" ? { slot: 42 } : {}),
      ...(providerRetryAtMs === undefined ? {} : { retryAtMs: providerRetryAtMs }) }; },
  };
  const make = () => createTreasury(state, { access, vault, driver, security: () => securityState, now: () => at });
  let treasury = make();
  const request = (operation: string, data: Record<string, unknown> = {}) => treasury.dispatch({ operation, token: operator.token, ...securityState, ...data });
  const setup = async () => {
    const ticket = treasury.control({ operation: "treasury-setup", scopeId: "main" }) as { ticket: string };
    return await request("setup", { ticket: ticket.ticket, password, destinationAddress: destination }) as TreasuryUnlock;
  };
  const prepare = async (unlock: TreasuryUnlock) => await request("prepare", { unlockToken: unlock.unlockToken, sourceAddress: source }) as TreasuryPlan;
  const confirm = async (unlock: TreasuryUnlock, plan: TreasuryPlan, idempotencyKey = "generated_idempotency_key") => await request("confirm", {
    unlockToken: unlock.unlockToken, planId: plan.planId, reviewDigest: plan.reviewDigest, idempotencyKey }) as { operation: TreasuryOperation };
  return { root, values, state, context, operator, employee, viewer, calls, setup, prepare, confirm, request, signature, transactionBase64,
    get treasury() { return treasury; }, get vault() { return vault; }, get access() { return access; },
    get keyReaderCalls() { return keyReaderCalls; },
    advance(ms: number) { at += ms; }, setQuote(change: (quote: TreasuryQuote) => TreasuryQuote) { quoteChange = change; },
    prepareFailure(error: unknown) { prepareError = error; }, admissionFailure(error: unknown) { admissionError = error; },
    changeTlsIdentity() { securityState.serverCertificateSha256 = "a".repeat(64); },
    blockSign() { signWait = deferred<void>(); return () => signWait!.resolve(); },
    blockSubmit() { submitWait = deferred<void>(); return () => submitWait!.resolve(); },
    failSubmit(value = true) { submitFailure = value; }, receipt(value: typeof receipt) { receipt = value; },
    admission(value: boolean) { admissionReady = value; }, providerWait(ms: number) { providerRetryAtMs = at + ms; },
    failWriteWhen(predicate: (value: unknown) => boolean) { failWrite = predicate; },
    async restart() { await treasury.close(); vault.close(); vault = openTreasuryVault(root); access = createAccess(state, () => at); treasury = make(); },
    async close() { await treasury.close(); vault.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("dedicated treasury encryption binds purpose, rejects tampering and never recreates a missing key by default", () => {
  const root = mkdtempSync(join(tmpdir(), "gridlens-treasury-vault-")); chmodSync(root, 0o700);
  try {
    const vault = openTreasuryVault(root, { create: true }); assert.equal(vault.created, true);
    const sealed = vault.seal({ destination, signed: "generated-signature" }, "server:configuration");
    assert.equal(sealed.includes(destination), false); assert.deepEqual(vault.open(sealed, "server:configuration"), { destination, signed: "generated-signature" });
    assert.throws(() => vault.open(sealed, "different:configuration"));
    const bytes = Buffer.from(sealed, "base64"); bytes[bytes.length - 1]! ^= 1;
    assert.throws(() => vault.open(bytes.toString("base64"), "server:configuration"));
    const key = readFileSync(join(root, "treasury-key-v1")); vault.close(); assert.throws(() => vault.seal({}, "server:configuration"));
    const reopened = openTreasuryVault(root); assert.equal(reopened.created, false); reopened.close();
    assert.deepEqual(readFileSync(join(root, "treasury-key-v1")), key); key.fill(0);
    unlinkSync(join(root, "treasury-key-v1")); assert.throws(() => openTreasuryVault(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("owner setup requires the terminal ticket and real saved HTTPS identity; ordinary operators/viewers never inherit unlock", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.request("setup", { ticket: "x".repeat(43), password, destinationAddress: destination }), denied(401));
    await assert.rejects(f.request("status", { httpsOrigin: "http://192.168.42.10:8789" }), denied(403));
    await assert.rejects(f.request("status", { token: f.viewer.token }), denied(401));
    const unlock = await f.setup(); parseTreasuryConfiguration(unlock.configuration);
    await assert.rejects(f.request("configuration", { token: f.employee.token, unlockToken: unlock.unlockToken }), denied(401));
    await assert.rejects(f.request("configuration"), denied(401));
    assert.throws(() => f.treasury.control({ operation: "treasury-setup", scopeId: "main" }), denied(409));
    const serialized = JSON.stringify([...f.values]);
    for (const sensitive of [password, destination, unlock.unlockToken]) assert.equal(serialized.includes(sensitive), false);
    assert.deepEqual(f.calls, { prepare: 0, sign: 0, submit: 0, reconcile: 0 });
    await f.restart();
    await assert.rejects(f.request("configuration", { unlockToken: unlock.unlockToken }), denied(401));
    const again = await f.request("unlock", { password }) as TreasuryUnlock;
    assert.equal(again.configuration.destinationAddress, destination);
  } finally { await f.close(); }
});

test("password throttling is durable and scrypt is limited to one concurrent verification", async () => {
  const f = fixture();
  try {
    await f.setup();
    const first = f.request("unlock", { password });
    await assert.rejects(f.request("unlock", { password }), denied(429)); await first;
    for (let index = 0; index < 3; index++) await assert.rejects(f.request("unlock", { password: "a wrong generated password" }), denied(401));
    await f.restart(); await assert.rejects(f.request("unlock", { password }), denied(429));
    f.advance(60_001); const unlock = await f.request("unlock", { password }) as TreasuryUnlock; assert.ok(unlock.unlockToken);
  } finally { await f.close(); }
});

test("expired setup tickets and changed saved HTTPS identity cannot retain financial authority", async () => {
  const f = fixture();
  try {
    const ticket = f.treasury.control({ operation: "treasury-setup", scopeId: "main" }) as { ticket: string };
    f.advance(300_001);
    await assert.rejects(f.request("setup", { ticket: ticket.ticket, password, destinationAddress: destination }), denied(401));
    const unlock = await f.setup(); f.changeTlsIdentity();
    await assert.rejects(f.request("configuration", { unlockToken: unlock.unlockToken }), denied(401));
    assert.equal(f.calls.sign, 0);
  } finally { await f.close(); }
});

test("one reviewed 1 NOS operation journals before submission, deduplicates confirmation and permanently consumes the installation pilot", async () => {
  const f = fixture();
  try {
    const unlock = await f.setup(), plan = await f.prepare(unlock); parseTreasuryPlan(plan);
    await assert.rejects(f.request("confirm", { unlockToken: unlock.unlockToken, planId: plan.planId, reviewDigest: plan.reviewDigest,
      idempotencyKey: "generated_idempotency_key", amountBaseUnits: "2000000" }), denied(400));
    const first = await f.confirm(unlock, plan), duplicate = await f.confirm(unlock, plan);
    assert.equal(first.operation.id, duplicate.operation.id); await f.treasury.waitForIdle();
    const result = await f.request("operations", { unlockToken: unlock.unlockToken, id: first.operation.id }) as { operation: TreasuryOperation };
    parseTreasuryOperation(result.operation); assert.equal(result.operation.phase, "confirmed"); assert.equal(result.operation.signature, f.signature);
    assert.deepEqual(f.calls, { prepare: 1, sign: 1, submit: 1, reconcile: 1 });
    const serialized = JSON.stringify(f.values.get(TREASURY_LEDGER_KEY));
    assert.equal(serialized.includes(destination), false); assert.equal(serialized.includes(f.transactionBase64), false); assert.equal(serialized.includes(f.signature), false);
    await assert.rejects(f.prepare(unlock), denied(409));
    f.treasury.control({ operation: "treasury-reset", scopeId: "main" }); await f.restart();
    const status = await f.request("status") as { pilotConsumed: boolean }; assert.equal(status.pilotConsumed, true);
    assert.equal(f.calls.sign, 1); assert.equal(f.calls.submit, 1);
  } finally { await f.close(); }
});

test("polling does not extend unlock; successful deliberate review refreshes its five-minute inactivity window", async () => {
  const f = fixture();
  try {
    const unlock = await f.setup(); f.advance(250_000);
    await f.request("configuration", { unlockToken: unlock.unlockToken });
    await f.prepare(unlock); f.advance(100_000);
    await f.request("configuration", { unlockToken: unlock.unlockToken });
    f.advance(200_001); await assert.rejects(f.request("configuration", { unlockToken: unlock.unlockToken }), denied(401));
    assert.equal(f.calls.sign, 0);
  } finally { await f.close(); }
});

test("revocation while signing prevents later submission and does not restore the pilot", async () => {
  const f = fixture(); const release = f.blockSign();
  try {
    const unlock = await f.setup(), plan = await f.prepare(unlock); await f.confirm(unlock, plan);
    f.access.revoke(f.employee.token, f.operator.deviceId); release(); await f.treasury.waitForIdle();
    const entry = f.vault.open<{ public: TreasuryOperation }>((f.values.get(TREASURY_LEDGER_KEY) as { operation: string }).operation, `${f.access.serverId}:operation`);
    assert.equal(entry.public.phase, "cancelled"); assert.equal(f.calls.submit, 0);
    assert.equal(f.keyReaderCalls, 0, "revocation before the helper runs prevents any key access");
    assert.equal((f.values.get(TREASURY_LEDGER_KEY) as { consumed: boolean }).consumed, true);
  } finally { release(); await f.close(); }
});

test("CLI reset during signing cancels unsent work, preserves history and cannot replenish the 1 NOS allowance", async () => {
  const f = fixture(); const release = f.blockSign();
  try {
    const unlock = await f.setup(), plan = await f.prepare(unlock); await f.confirm(unlock, plan);
    const reset = f.treasury.control({ operation: "treasury-reset", scopeId: "main" }) as { ticket: string };
    release(); await f.treasury.waitForIdle();
    const newUnlock = await f.request("setup", { ticket: reset.ticket, password, destinationAddress: address("9") }) as TreasuryUnlock;
    assert.equal(newUnlock.configuration.pilotConsumed, true); await assert.rejects(f.prepare(newUnlock), denied(409));
    const result = await f.request("operations", { unlockToken: newUnlock.unlockToken }) as { operations: TreasuryOperation[] };
    assert.equal(result.operations[0]!.phase, "cancelled"); assert.equal(result.operations[0]!.destinationAddress, destination);
    assert.equal(f.calls.sign, 1); assert.equal(f.calls.submit, 0);
    assert.equal(f.keyReaderCalls, 0, "terminal reset before the helper runs prevents any key access");
  } finally { release(); await f.close(); }
});

test("unknown submission is reconciled only by its recorded signature after restart, never resigned or resent", async () => {
  const f = fixture();
  try {
    const unlock = await f.setup(), plan = await f.prepare(unlock); f.failSubmit(); f.receipt("uncertain");
    const confirmed = await f.confirm(unlock, plan); await f.treasury.waitForIdle();
    const result = await f.request("operations", { unlockToken: unlock.unlockToken, id: confirmed.operation.id }) as { operation: TreasuryOperation };
    assert.equal(result.operation.phase, "uncertain"); assert.equal(result.operation.signature, f.signature);
    await f.restart(); f.receipt("confirmed"); f.advance(15_000); await f.treasury.reconcilePending();
    const reopened = await f.request("unlock", { password }) as TreasuryUnlock;
    const recovered = await f.request("operations", { unlockToken: reopened.unlockToken }) as { operations: TreasuryOperation[] };
    assert.equal(recovered.operations[0]!.phase, "confirmed"); assert.equal(f.calls.submit, 1); assert.equal(f.calls.sign, 1);
  } finally { await f.close(); }
});

test("known shared-budget deferral at confirmation does not consume the pilot or invoke its signer", async () => {
  const f = fixture();
  try {
    const unlock = await f.setup(), plan = await f.prepare(unlock);
    f.admission(false);
    const failure = parseTreasuryPreflightFailure(await f.confirm(unlock, plan));
    assert.equal(failure.code, "budget-wait"); assert.equal(failure.retryAtMs, 1_800_000_060_000);
    const config = await f.request("configuration", { unlockToken: unlock.unlockToken }) as { pilotConsumed: boolean };
    assert.equal(config.pilotConsumed, false); assert.equal(f.calls.sign, 0); assert.equal(f.calls.submit, 0);
    // A later explicit confirmation is allowed only because no execution was admitted.
    f.admission(true); await f.confirm(unlock, plan); await f.treasury.waitForIdle();
    assert.equal(f.calls.sign, 1); assert.equal(f.calls.submit, 1);
  } finally { await f.close(); }
});

test("receipt reconciliation backs off durably through restart and respects longer provider waits", async () => {
  const f = fixture();
  try {
    const unlock = await f.setup(), plan = await f.prepare(unlock); f.receipt("uncertain");
    await f.confirm(unlock, plan); await f.treasury.waitForIdle(); assert.equal(f.calls.reconcile, 1);
    await f.restart(); await f.treasury.reconcilePending(); assert.equal(f.calls.reconcile, 1);
    for (const [wait, expected] of [[15_000, 2], [30_000, 3], [60_000, 4], [300_000, 5]] as const) {
      f.advance(wait - 1); await f.treasury.reconcilePending(); assert.equal(f.calls.reconcile, expected - 1);
      f.advance(1); await f.treasury.reconcilePending(); assert.equal(f.calls.reconcile, expected);
    }
    f.providerWait(900_000); f.advance(300_000); await f.treasury.reconcilePending(); assert.equal(f.calls.reconcile, 6);
    await f.restart(); f.advance(599_999); await f.treasury.reconcilePending(); assert.equal(f.calls.reconcile, 6);
    f.advance(1); await f.treasury.reconcilePending(); assert.equal(f.calls.reconcile, 7);
    assert.equal(f.calls.sign, 1); assert.equal(f.calls.submit, 1);
  } finally { await f.close(); }
});

test("destination changes while the signer is waiting invalidate review authority before any key use", async () => {
  const f = fixture(), release = f.blockSign();
  try {
    const unlock = await f.setup(), plan = await f.prepare(unlock); await f.confirm(unlock, plan);
    await f.request("configure", { unlockToken: unlock.unlockToken, currentPassword: password, destinationAddress: address("9") });
    release(); await f.treasury.waitForIdle();
    assert.equal(f.keyReaderCalls, 0); assert.equal(f.calls.submit, 0);
    const fresh = await f.request("unlock", { password }) as TreasuryUnlock;
    assert.equal(fresh.configuration.destinationAddress, address("9")); assert.equal(fresh.configuration.pilotConsumed, true);
    await assert.rejects(f.prepare(fresh), denied(409));
  } finally { release(); await f.close(); }
});

test("reset during submission prechecks prevents dispatch and preserves the sole signature for reconciliation", async () => {
  const f = fixture(), release = f.blockSubmit();
  try {
    const unlock = await f.setup(), plan = await f.prepare(unlock); await f.confirm(unlock, plan);
    // Signing returns on the next microtask; the submit driver then waits before dispatch.
    await new Promise(resolve => setImmediate(resolve));
    f.treasury.control({ operation: "treasury-reset", scopeId: "main" }); f.receipt("uncertain");
    release(); await f.treasury.waitForIdle();
    assert.equal(f.calls.submit, 0); assert.equal(f.keyReaderCalls, 1);
    const record = f.vault.open<{ public: TreasuryOperation }>((f.values.get(TREASURY_LEDGER_KEY) as { operation: string }).operation, `${f.access.serverId}:operation`);
    assert.equal(record.public.phase, "uncertain"); assert.equal(record.public.signature, f.signature);
  } finally { release(); await f.close(); }
});

test("failed authorization journal write prevents even the first signer call", async () => {
  const f = fixture();
  try {
    const unlock = await f.setup(), plan = await f.prepare(unlock);
    f.failWriteWhen(value => (value as { consumed: boolean }).consumed);
    await assert.rejects(f.confirm(unlock, plan), denied(503));
    assert.equal(f.calls.sign, 0); assert.equal(f.keyReaderCalls, 0); assert.equal(f.calls.submit, 0);
    assert.equal((await f.request("status") as { state: string }).state, "recovery-required");
  } finally { await f.close(); }
});

test("changed/overbudget quotes and expired reviews never reach the signer", async () => {
  const f = fixture();
  try {
    const unlock = await f.setup();
    for (const change of [
      (quote: TreasuryQuote) => ({ ...quote, amountBaseUnits: "2000000" as "1000000" }),
      (quote: TreasuryQuote) => ({ ...quote, feeLamports: "5000001" }),
      (quote: TreasuryQuote) => ({ ...quote, sourceSolLamports: "50000000" }),
      (quote: TreasuryQuote) => ({ ...quote, mintAddress: address("9") }),
    ]) { f.setQuote(change); assert.equal(parseTreasuryPreflightFailure(await f.prepare(unlock)).code, "preflight-unavailable"); }
    f.setQuote(quote => ({ ...quote, destinationAddress: address("9") })); await assert.rejects(f.prepare(unlock), denied(409));
    f.setQuote(quote => quote); const plan = await f.prepare(unlock); f.advance(60_001);
    assert.equal(parseTreasuryPreflightFailure(await f.confirm(unlock, plan)).code, "review-expired");
    assert.equal(f.calls.sign, 0); assert.equal(f.calls.submit, 0);
  } finally { await f.close(); }
});

test("preflight failure contract permits only finite codes and scheduler eligibility without raw details", () => {
  for (const code of TREASURY_PREFLIGHT_CODES) {
    const result = parseTreasuryPreflightFailure({ version: 1, kind: "preflight-failure", code });
    assert.equal(result.code, code);
    assert.equal(treasuryPreflightStatus(code), code === "budget-wait" ? 429 : ["provider-unavailable", "preflight-unavailable"].includes(code) ? 503 : 409);
  }
  for (const code of ["budget-wait", "provider-unavailable"]) assert.equal(parseTreasuryPreflightFailure({ version: 1, kind: "preflight-failure", code,
    retryAtMs: 1_800_000_060_000 }).retryAtMs, 1_800_000_060_000);
  for (const malformed of [
    { version: 1, kind: "preflight-failure", code: "upstream-secret" },
    { version: 1, kind: "preflight-failure", code: "budget-wait", message: "secret" },
    { version: 1, kind: "preflight-failure", code: "budget-wait", url: "https://secret.invalid" },
    ...[null, "soon", -1, 0, Infinity, Number.NaN, 8_640_000_000_000_001].map(retryAtMs => ({ version: 1, kind: "preflight-failure", code: "budget-wait", retryAtMs })),
    { version: 1, kind: "preflight-failure", code: "insufficient-nos", retryAtMs: 1_800_000_060_000 },
  ]) assert.throws(() => parseTreasuryPreflightFailure(malformed));
  const secretError = Object.assign(new Error("Bearer synthetic-secret at https://private.invalid"), { code: "budget-wait", retryAtMs: 1_800_000_060_000 });
  assert.deepEqual(treasuryPreflightFailure(secretError), { version: 1, kind: "preflight-failure", code: "preflight-unavailable" });
  const malformedKnown = Object.assign(new TreasuryPreflightError("budget-wait"), { code: "malformed-secret", cause: secretError });
  assert.deepEqual(treasuryPreflightFailure(malformedKnown), { version: 1, kind: "preflight-failure", code: "preflight-unavailable" });
});

test("all expected preflight reasons survive the owner boundary without consuming allowance, signing or exposing exceptions", async () => {
  const f = fixture();
  try {
    const unlock = await f.setup();
    for (const code of TREASURY_PREFLIGHT_CODES) {
      const error = new TreasuryPreflightError(code, ["budget-wait", "provider-unavailable"].includes(code) ? 1_800_000_060_000 : undefined);
      error.message = "Synthetic private exception must never reach the browser";
      f.prepareFailure(error);
      const result = parseTreasuryPreflightFailure(await f.prepare(unlock));
      assert.equal(result.code, code); assert.equal(JSON.stringify(result).includes("private"), false);
      const configuration = await f.request("configuration", { unlockToken: unlock.unlockToken }) as { pilotConsumed: boolean };
      assert.equal(configuration.pilotConsumed, false);
      assert.deepEqual(await f.request("operations", { unlockToken: unlock.unlockToken }), { version: 1, operations: [] });
    }
    const before = f.calls.prepare;
    await assert.rejects(f.request("prepare", { sourceAddress: source, unlockToken: unlock.unlockToken, token: f.employee.token }), denied(401));
    assert.equal(f.calls.prepare, before, "ordinary operators cannot obtain a financial preflight result");
    assert.equal(f.calls.sign, 0); assert.equal(f.keyReaderCalls, 0); assert.equal(f.calls.submit, 0);
  } finally { await f.close(); }
});

test("unknown and malformed preflight errors are sanitized before Review and confirmation admission", async () => {
  const f = fixture();
  try {
    const unlock = await f.setup(), plan = await f.prepare(unlock);
    for (const error of [new Error("secret token and URL https://private.invalid"),
      { code: "budget-wait", message: "forged upstream reason" },
      Object.assign(new TreasuryPreflightError("budget-wait"), { retryAtMs: "malformed-secret" }),
    ]) {
      f.prepareFailure(error); f.admissionFailure(error);
      assert.deepEqual(await f.prepare(unlock), { version: 1, kind: "preflight-failure", code: "preflight-unavailable" });
      assert.deepEqual(await f.confirm(unlock, plan), { version: 1, kind: "preflight-failure", code: "preflight-unavailable" });
      const saved = f.values.get(TREASURY_LEDGER_KEY) as { consumed: boolean; operation: unknown };
      assert.equal(saved.consumed, false); assert.equal(saved.operation, null);
    }
    assert.equal(f.calls.sign, 0); assert.equal(f.keyReaderCalls, 0); assert.equal(f.calls.submit, 0);
    // No failure consumed or invalidated this still-current review. A deliberate
    // later click can authorize it once the preflight condition is resolved.
    f.prepareFailure(undefined); f.admissionFailure(undefined);
    await f.confirm(unlock, plan); await f.treasury.waitForIdle();
    assert.equal(f.calls.sign, 1); assert.equal(f.calls.submit, 1);
  } finally { await f.close(); }
});

test("owner revocation while a rejected preflight is settling withholds its financial reason", async () => {
  const f = fixture();
  try {
    const unlock = await f.setup(); f.prepareFailure(new TreasuryPreflightError("insufficient-nos"));
    const pending = f.prepare(unlock);
    f.access.revoke(f.employee.token, f.operator.deviceId);
    await assert.rejects(pending, denied(401));
    assert.equal(f.calls.sign, 0); assert.equal(f.keyReaderCalls, 0); assert.equal(f.calls.submit, 0);
    const saved = f.values.get(TREASURY_LEDGER_KEY) as { consumed: boolean; operation: unknown };
    assert.equal(saved.consumed, false); assert.equal(saved.operation, null);
  } finally { await f.close(); }
});

test("failure to durably journal signed bytes prevents submission and fails closed", async () => {
  const f = fixture();
  try {
    const unlock = await f.setup(), plan = await f.prepare(unlock);
    f.failWriteWhen(value => {
      const record = value as { operation: string | null };
      return record.operation !== null && f.vault.open<{ public: TreasuryOperation }>(record.operation, `${f.access.serverId}:operation`).public.phase === "signed";
    });
    await f.confirm(unlock, plan); await f.treasury.waitForIdle(); assert.equal(f.calls.sign, 1); assert.equal(f.calls.submit, 0);
    const status = await f.request("status") as { state: string; pilotConsumed: boolean };
    assert.equal(status.state, "recovery-required"); assert.equal(status.pilotConsumed, true);
    await f.restart(); await f.treasury.reconcilePending(); assert.equal(f.calls.sign, 1); assert.equal(f.calls.submit, 0);
  } finally { await f.close(); }
});

test("missing or corrupt retained ledger cannot silently create a new owner or pilot allowance", async () => {
  const f = fixture();
  try {
    await f.setup(); f.values.delete(TREASURY_LEDGER_KEY); await f.restart();
    assert.equal((await f.request("status") as { state: string }).state, "recovery-required");
    assert.throws(() => f.treasury.control({ operation: "treasury-reset", scopeId: "main" }), denied(503));
    f.values.set(TREASURY_LEDGER_KEY, null); await f.restart();
    assert.equal((await f.request("status") as { state: string }).state, "recovery-required");
    assert.equal(f.calls.sign, 0);
  } finally { await f.close(); }
});
