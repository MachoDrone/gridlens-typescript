import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import type { FleetContext } from "../contracts/fleet.ts";
import type { DeviceAccess, PrivateState } from "./access.ts";
import type { TreasuryVault } from "./treasury-vault.ts";
import { SharedHttpError } from "./ipc.ts";
import { TreasuryPreflightError, treasuryPreflightFailure } from "./treasury-errors.ts";
import { isMetadataAddress } from "../fleet/host-metadata.ts";
import { NOS_MINT } from "../fleet/nos.ts";
import { TREASURY_AMOUNT, TREASURY_MAX_COST, TREASURY_RESERVE, parseTreasuryConfiguration, parseTreasuryOperation, parseTreasuryQuote } from "../contracts/treasury.ts";
import type { TreasuryConfiguration, TreasuryOperation, TreasuryPlan, TreasuryPublicQuote, TreasuryStatus, TreasuryUnlock } from "../contracts/treasury.ts";

/** Internal driver contracts never go to the browser. The source helper signs
 * this exact bounded message but must NEVER submit it. */
export interface TreasuryQuote extends TreasuryPublicQuote {
  scopeId: string; rosterRevision: string;
  sourceBinding: { pcId: string; nodeId: string; containerId: string; sshIdentity: string };
  messageBase64: string; blockhash: string; lastValidBlockHeight: number;
}
export interface TreasurySigned { quote: TreasuryQuote; transactionBase64: string; signature: string }
export interface TreasuryReceipt { status: "confirmed" | "failed" | "uncertain"; observedAtMs: number; slot?: number; retryAtMs?: number }
export interface TreasuryDriver {
  /** Synchronous admission against the existing shared RPC allowance. The
   * production driver supplies this; injected isolated fixtures may omit it. */
  assertReady?(quote: TreasuryQuote): void;
  prepare(context: FleetContext, sourceAddress: string, destinationAddress: string): Promise<TreasuryQuote>;
  sign(quote: TreasuryQuote, authorize?: () => void): Promise<TreasurySigned>;
  submit(signed: TreasurySigned, authorize?: () => void): Promise<void>;
  reconcile(signed: TreasurySigned): Promise<TreasuryReceipt>;
}
export interface TreasurySecurity { httpsOrigin: string; serverCertificateSha256: string }
export interface TreasuryAccess {
  readonly serverId: string;
  requireAccess(token: unknown, role?: "operator" | "viewer"): DeviceAccess;
  fleet(scopeId: string): FleetContext;
}
/** Internal, memory-only authority shared by distinct financial workflows.
 * No password, bearer token, verifier or receiving-wallet configuration leaves
 * this owner component through the authorization result. */
export interface TreasuryOwnerAuthorization {
  context: FleetContext;
  deviceId: string;
  configurationRevision: number;
  authorizationId: string;
  guard(): void;
  touch(): void;
}
interface PasswordVerifier { salt: string; hash: string }
interface Ticket { hash: string; scopeId: string; binding: string; expiresAtMs: number }
interface Ledger {
  version: 1; serverId: string; keyId: string; revision: number; scopeId: string | null;
  owner: PasswordVerifier | null; configuration: string | null; ticket: Ticket | null;
  attempts: number[]; consumed: boolean; operation: string | null;
}
interface StoredOperation {
  public: TreasuryOperation; scopeId: string; rosterRevision: string; configurationRevision: number;
  planId: string; reviewDigest: string; requestKeyHash: string; quote: TreasuryQuote; signed: TreasurySigned | null;
  reconcileAttempts: number; nextReconcileAtMs: number;
}
interface Unlock { hash: string; deviceId: string; scopeId: string; rosterRevision: string; revision: number; expiresAtMs: number; binding: string }
interface Prepared { public: TreasuryPlan; quote: TreasuryQuote; revision: number; deviceId: string; unlockHash: string; binding: string }
export const TREASURY_LEDGER_KEY = "treasury.v1";
const WINDOW = 300_000;
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const secret = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const base64 = (value: unknown, maximum: number): value is string => typeof value === "string" && value.length > 0 && value.length <= maximum
  && /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, "base64").toString("base64") === value;
const validPassword = (value: unknown): value is string => typeof value === "string" && value.length >= 12 && value.length <= 1024;
const verifier = (value: unknown): value is PasswordVerifier => object(value) && Object.keys(value).length === 2
  && typeof value.salt === "string" && /^[a-f0-9]{64}$/.test(value.salt) && typeof value.hash === "string" && /^[a-f0-9]{128}$/.test(value.hash);
const derive = (password: string, salt: string): Promise<Buffer> => new Promise((resolve, reject) => {
  scrypt(password, Buffer.from(salt, "hex"), 64, { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
    (error, result) => error ? reject(error) : resolve(result));
});
function parseQuote(value: unknown): TreasuryQuote {
  if (!object(value)) throw new Error("Invalid Wallet quote.");
  const publicQuote = parseTreasuryQuote(value), binding = value.sourceBinding;
  if (publicQuote.mintAddress !== NOS_MINT || !validId(value.scopeId) || !validId(value.rosterRevision)
    || !object(binding) || Object.keys(binding).length !== 4 || !hash(binding.pcId) || !hash(binding.nodeId) || !hash(binding.containerId)
    || typeof binding.sshIdentity !== "string" || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(binding.sshIdentity)
    || !base64(value.messageBase64, 4096) || !isMetadataAddress(value.blockhash) || !time(value.lastValidBlockHeight)
    || publicQuote.expiresAtMs - publicQuote.preparedAtMs > 60_000
    || publicQuote.createDestinationAta !== (BigInt(publicQuote.rentLamports) > 0n)) throw new Error("Invalid Wallet transaction binding.");
  return { ...publicQuote, scopeId: value.scopeId, rosterRevision: value.rosterRevision,
    sourceBinding: { pcId: binding.pcId, nodeId: binding.nodeId, containerId: binding.containerId, sshIdentity: binding.sshIdentity },
    messageBase64: value.messageBase64, blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight };
}
function parseSigned(value: unknown, quote: TreasuryQuote): TreasurySigned {
  if (!object(value) || Object.keys(value).length !== 3 || typeof value.signature !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value.signature)
    || !base64(value.transactionBase64, 8192)) throw new Error("Invalid signed Wallet transaction.");
  const signedQuote = parseQuote(value.quote);
  if (JSON.stringify(signedQuote) !== JSON.stringify(quote)) throw new Error("The signed Wallet transaction changed its review.");
  return { quote: signedQuote, transactionBase64: value.transactionBase64, signature: value.signature };
}
function parseLedger(value: unknown, serverId: string, keyId: string): Ledger {
  if (!object(value) || Object.keys(value).length !== 11 || value.version !== 1 || value.serverId !== serverId || value.keyId !== keyId
    || !time(value.revision) || value.scopeId !== null && !validId(value.scopeId) || value.owner !== null && !verifier(value.owner)
    || value.configuration !== null && !base64(value.configuration, 90_000) || (value.owner === null) !== (value.configuration === null)
    || value.ticket !== null && (!object(value.ticket) || Object.keys(value.ticket).length !== 4 || !hash(value.ticket.hash)
      || !validId(value.ticket.scopeId) || !hash(value.ticket.binding) || !time(value.ticket.expiresAtMs))
    || !Array.isArray(value.attempts) || value.attempts.length > 5 || value.attempts.some(value => !time(value))
    || typeof value.consumed !== "boolean" || value.operation !== null && !base64(value.operation, 90_000)
    || value.consumed !== (value.operation !== null) || value.owner !== null && value.scopeId === null) throw new Error("Invalid retained Wallet ledger.");
  return structuredClone(value) as unknown as Ledger;
}

/** Finite one-NOS pilot. No public dispatch can initialize/reset its durable
 * allowance; reset preserves the encrypted operation even before submission. */
export function createTreasury(state: PrivateState, options: {
  access: TreasuryAccess; vault: TreasuryVault; driver: TreasuryDriver; security: () => TreasurySecurity;
  now?: () => number; hosts?: (context: FleetContext) => { address: string; label: string }[];
}) {
  const { access, vault, driver, security } = options, now = options.now ?? Date.now;
  const sessions = new Map<string, Unlock>(), plans = new Map<string, Prepared>(), pending = new Set<Promise<void>>();
  let ledger: Ledger | undefined, broken = false, closed = false, hashing = false, preparing = false, reconciling = false;
  const purpose = (kind: "configuration" | "operation") => `${access.serverId}:${kind}`;
  const initial: Ledger = { version: 1, serverId: access.serverId, keyId: vault.keyId, revision: 0, scopeId: null,
    owner: null, configuration: null, ticket: null, attempts: [], consumed: false, operation: null };
  function fail(code = 409): never { throw new SharedHttpError(code); }
  function available(): Ledger { if (closed || broken || !ledger) fail(503); return ledger; }
  function persist(next: Ledger): void {
    available();
    try { state.set(TREASURY_LEDGER_KEY, next); ledger = next; }
    catch { broken = true; sessions.clear(); plans.clear(); fail(503); }
  }
  function operation(): StoredOperation | null {
    const saved = available(); if (saved.operation === null) return null;
    try {
      const value = vault.open<StoredOperation>(saved.operation, purpose("operation"));
      if (!object(value) || ![9, 11].includes(Object.keys(value).length) || Object.keys(value).some(key => !["public", "scopeId", "rosterRevision", "configurationRevision",
        "planId", "reviewDigest", "requestKeyHash", "quote", "signed", "reconcileAttempts", "nextReconcileAtMs"].includes(key))
        || !validId(value.scopeId) || !validId(value.rosterRevision)
        || !time(value.configurationRevision) || !validId(value.planId) || !hash(value.reviewDigest) || !hash(value.requestKeyHash)) throw new Error();
      const reconcileAttempts = value.reconcileAttempts === undefined ? 0 : value.reconcileAttempts;
      const nextReconcileAtMs = value.nextReconcileAtMs === undefined ? 0 : value.nextReconcileAtMs;
      if (!time(reconcileAttempts) || reconcileAttempts > 4 || !time(nextReconcileAtMs)
        || (value.reconcileAttempts === undefined) !== (value.nextReconcileAtMs === undefined)) throw new Error();
      const publicValue = parseTreasuryOperation(value.public), quote = parseQuote(value.quote);
      if (quote.scopeId !== value.scopeId || quote.rosterRevision !== value.rosterRevision || publicValue.sourceAddress !== quote.sourceAddress
        || publicValue.destinationAddress !== quote.destinationAddress) throw new Error();
      const signed = value.signed === null ? null : parseSigned(value.signed, quote);
      if (publicValue.signature !== (signed?.signature ?? null) || ["signed", "submission-started", "confirmed"].includes(publicValue.phase) && !signed) throw new Error();
      return { public: publicValue, scopeId: value.scopeId, rosterRevision: value.rosterRevision, configurationRevision: value.configurationRevision,
        planId: value.planId, reviewDigest: value.reviewDigest, requestKeyHash: value.requestKeyHash, quote, signed, reconcileAttempts, nextReconcileAtMs };
    } catch { broken = true; sessions.clear(); plans.clear(); return fail(503); }
  }
  function saveOperation(value: StoredOperation, extra: Partial<Ledger> = {}): void {
    const sealed = vault.seal(value, purpose("operation"));
    persist({ ...available(), ...extra, consumed: true, operation: sealed });
  }
  function destination(): string {
    try {
      const configuration = available().configuration;
      if (!configuration) return fail(401);
      const value = vault.open<{ destinationAddress: string }>(configuration, purpose("configuration"));
      if (!object(value) || Object.keys(value).length !== 1 || !isMetadataAddress(value.destinationAddress)) throw new Error();
      return value.destinationAddress;
    } catch (error) { if (error instanceof SharedHttpError) throw error; broken = true; return fail(503); }
  }
  try {
    const saved = state.get<unknown>(TREASURY_LEDGER_KEY);
    if (saved === undefined) {
      // An existing encryption key with a missing ledger could have already
      // spent the pilot. Never infer a new allowance from the absent record.
      if (!vault.created) throw new Error("Missing retained Wallet ledger.");
      ledger = initial; persist(initial);
    } else ledger = parseLedger(saved, access.serverId, vault.keyId);
    if (ledger.configuration) destination();
    operation();
  } catch { broken = true; }
  function binding(): { value: TreasurySecurity; hash: string } {
    const value = security(); let url: URL;
    try { url = new URL(value.httpsOrigin); } catch { return fail(503); }
    if (url.protocol !== "https:" || url.origin !== value.httpsOrigin || url.username || url.password || !hash(value.serverCertificateSha256)) fail(503);
    return { value, hash: digest(JSON.stringify([access.serverId, value.httpsOrigin, value.serverCertificateSha256])) };
  }
  function device(token: unknown): DeviceAccess {
    try { return access.requireAccess(token, "operator"); } catch { return fail(401); }
  }
  function sameScope(principal: DeviceAccess): void {
    const saved = available(); if (saved.scopeId !== null && saved.scopeId !== principal.context.scopeId) fail(403);
  }
  function requireUnlock(body: Record<string, unknown>): { principal: DeviceAccess; unlock: Unlock } {
    const principal = device(body.token); sameScope(principal);
    const session = secret(body.unlockToken) ? sessions.get(digest(body.unlockToken)) : undefined;
    const saved = available();
    if (!saved.owner || !session || session.deviceId !== principal.deviceId || session.scopeId !== principal.context.scopeId
      || session.rosterRevision !== principal.context.rosterRevision || session.revision !== saved.revision || session.expiresAtMs <= now()
      || session.expiresAtMs > now() + WINDOW || session.binding !== binding().hash) fail(401);
    return { principal, unlock: session };
  }
  function authorizeOperation(body: Record<string, unknown>): TreasuryOwnerAuthorization {
    // Capture primitives, never a mutable request object supplied by another
    // workflow. The financial socket's trusted TLS facts remain mandatory.
    const input = { token: body.token, unlockToken: body.unlockToken,
      httpsOrigin: body.httpsOrigin, serverCertificateSha256: body.serverCertificateSha256 };
    const expected = binding();
    if (input.httpsOrigin !== expected.value.httpsOrigin || input.serverCertificateSha256 !== expected.value.serverCertificateSha256) fail(403);
    const initial = requireUnlock(input), context = structuredClone(initial.principal.context);
    const configurationRevision = available().revision, authorizationId = initial.unlock.hash, deviceId = initial.principal.deviceId;
    const guard = (): void => {
      if (binding().hash !== expected.hash) fail(403);
      const current = requireUnlock(input);
      if (current.principal.deviceId !== deviceId || current.unlock.hash !== authorizationId
        || available().revision !== configurationRevision || current.principal.context.scopeId !== context.scopeId
        || current.principal.context.rosterRevision !== context.rosterRevision) fail(409);
    };
    return { context, deviceId, configurationRevision, authorizationId, guard,
      touch() { guard(); initial.unlock.expiresAtMs = now() + WINDOW; } };
  }
  function configuration(principal: DeviceAccess): TreasuryConfiguration {
    const saved = available(), rows = options.hosts?.(principal.context) ?? principal.context.addresses.map(address => ({ address, label: address }));
    if (rows.some(row => !principal.context.addresses.includes(row.address))) fail(503);
    return parseTreasuryConfiguration({ version: 1, revision: saved.revision, destinationAddress: destination(), hosts: rows,
      amountBaseUnits: TREASURY_AMOUNT, reserveLamports: TREASURY_RESERVE, maxCostLamports: TREASURY_MAX_COST, pilotConsumed: saved.consumed });
  }
  function issueUnlock(principal: DeviceAccess): TreasuryUnlock {
    const saved = available(), token = randomBytes(32).toString("base64url"), tokenHash = digest(token), expiresAtMs = now() + WINDOW;
    for (const [key, session] of sessions) if (session.deviceId === principal.deviceId || session.expiresAtMs <= now()) sessions.delete(key);
    if (sessions.size >= 16) fail(429);
    sessions.set(tokenHash, { hash: tokenHash, deviceId: principal.deviceId, scopeId: principal.context.scopeId,
      rosterRevision: principal.context.rosterRevision, revision: saved.revision, expiresAtMs, binding: binding().hash });
    return { version: 1, unlockToken: token, expiresAtMs, configuration: configuration(principal) };
  }
  function reserveAttempt(): void {
    const saved = available(), at = now(), recent = saved.attempts.filter(value => value > at - 60_000);
    if (!time(at) || saved.attempts.some(value => value > at) || recent.length >= 5 || hashing) fail(429);
    persist({ ...saved, attempts: [...recent, at] });
  }
  async function passwordHash(password: unknown, prior?: PasswordVerifier): Promise<PasswordVerifier> {
    reserveAttempt();
    if (!validPassword(password)) fail(400);
    hashing = true;
    try {
      const salt = prior?.salt ?? randomBytes(32).toString("hex"), derived = await derive(password, salt);
      try {
        if (prior && !timingSafeEqual(derived, Buffer.from(prior.hash, "hex"))) fail(401);
        return { salt, hash: derived.toString("hex") };
      } finally { derived.fill(0); }
    } finally { hashing = false; }
  }
  function clearAuthority(): void { sessions.clear(); plans.clear(); }
  function transition(id: string, phase: TreasuryOperation["phase"], error: string | null): void {
    const current = operation(); if (!current || current.public.id !== id) fail(503);
    saveOperation({ ...current, public: { ...current.public, phase, error, updatedAtMs: Math.max(now(), current.public.updatedAtMs) } });
  }
  function track(task: Promise<void>): void { pending.add(task); void task.finally(() => pending.delete(task)).catch(() => {}); }
  async function reconcileOne(id: string): Promise<void> {
    const current = operation(); if (!current || current.public.id !== id || !current.signed
      || !["submission-started", "uncertain"].includes(current.public.phase) || current.nextReconcileAtMs > now()) return;
    const attempt = Math.min(4, current.reconcileAttempts + 1), delay = [15_000, 30_000, 60_000, 300_000][attempt - 1]!;
    // Commit recovery pacing before dispatch: a crash must not create an
    // immediate replacement allowance or a rapid loop against an absent receipt.
    saveOperation({ ...current, reconcileAttempts: attempt, nextReconcileAtMs: now() + delay });
    let receipt: TreasuryReceipt;
    try { receipt = await driver.reconcile(structuredClone(current.signed)); }
    catch { receipt = { status: "uncertain", observedAtMs: now() }; }
    if (closed) return;
    const latest = operation(); if (!latest || latest.public.id !== id) return;
    if (!receipt || !["confirmed", "failed", "uncertain"].includes(receipt.status) || !time(receipt.observedAtMs)
      || receipt.observedAtMs > now() + 15_000 || receipt.status === "confirmed" && !time(receipt.slot)
      || receipt.retryAtMs !== undefined && (!time(receipt.retryAtMs) || receipt.retryAtMs > 8_640_000_000_000_000)) {
      transition(id, "uncertain", "The transfer receipt could not be verified."); return;
    }
    saveOperation({ ...latest, nextReconcileAtMs: receipt.status === "uncertain"
      ? Math.max(latest.nextReconcileAtMs, now() + delay, receipt.retryAtMs ?? 0) : 0,
      public: { ...latest.public, phase: receipt.status, updatedAtMs: Math.max(now(), latest.public.updatedAtMs),
      confirmedAtMs: receipt.status === "confirmed" ? receipt.observedAtMs : null, slot: receipt.status === "confirmed" ? receipt.slot! : null,
      error: receipt.status === "confirmed" ? null : receipt.status === "failed" ? "The transaction failed. The pilot remains locked against another send."
        : "The transfer result is not verified. No additional transfer will be submitted." } });
  }
  async function execute(id: string, body: Record<string, unknown>, expected: Prepared): Promise<void> {
    const authorize = (phase: TreasuryOperation["phase"]): void => {
      requireUnlock(body);
      const current = operation();
      if (closed || binding().hash !== expected.binding || available().revision !== expected.revision || now() >= expected.quote.expiresAtMs
        || current?.public.id !== id || current.public.phase !== phase) fail(409);
    };
    try {
      const original = operation(); if (!original || original.public.id !== id) fail(503);
      let signed: TreasurySigned;
      try {
        authorize("authorized");
        signed = parseSigned(await driver.sign(structuredClone(original.quote), () => authorize("authorized")), original.quote);
      } catch {
        try { authorize("authorized"); }
        catch { transition(id, "cancelled", "Wallet authority changed before signing completed. No transaction will be submitted."); return; }
        transition(id, "failed", "Signing did not complete. Nothing was submitted by GridLens; the pilot remains locked."); return;
      }
      const current = operation(); if (!current || current.public.id !== id) fail(503);
      // Persist the sole signed transaction before any network submission.
      saveOperation({ ...current, signed, public: { ...current.public, signature: signed.signature,
        phase: current.public.phase === "cancelled" ? "cancelled" : "signed", updatedAtMs: Math.max(now(), current.public.updatedAtMs) } });
      try {
        authorize("signed");
      } catch { transition(id, "cancelled", "Wallet authority changed before submission. The signed transaction was retained but will not be sent."); return; }
      transition(id, "submission-started", null);
      try { await driver.submit(structuredClone(signed), () => authorize("submission-started")); }
      catch { transition(id, "uncertain", "Submission was not acknowledged. Checking the recorded transaction; no retry will be sent."); }
      if (!closed) await reconcileOne(id);
    } catch { /* Persistence failure closes admission. Never submit through recovery. */ }
  }
  function status(principal: DeviceAccess, body: Record<string, unknown>): TreasuryStatus {
    let unlocked = false;
    if (!broken && !closed && ledger?.owner) { try { requireUnlock(body); unlocked = true; } catch { /* Locked is public. */ } }
    return { version: 1, supported: !broken && !closed, state: broken || closed ? "recovery-required" : !ledger?.owner ? "setup-required" : unlocked ? "unlocked" : "locked",
      pilotConsumed: broken ? true : ledger?.consumed ?? true, serverId: access.serverId, scopeId: principal.context.scopeId, revision: ledger?.revision ?? 0 };
  }
  const common = ["operation", "token", "unlockToken", "httpsOrigin", "serverCertificateSha256"];
  const fields: Record<string, string[]> = { status: [], setup: ["ticket", "password", "destinationAddress"], unlock: ["password"], lock: [],
    configuration: [], configure: ["currentPassword", "destinationAddress", "newPassword"], prepare: ["sourceAddress"],
    confirm: ["planId", "reviewDigest", "idempotencyKey"], operations: ["id"] };
  async function dispatch(body: Record<string, unknown>): Promise<unknown> {
    const name = String(body.operation), allowed = Object.hasOwn(fields, name) ? fields[name] : undefined;
    if (!allowed || Object.keys(body).some(key => !common.includes(key) && !allowed.includes(key))) fail(400);
    const securityBinding = binding();
    if (body.httpsOrigin !== securityBinding.value.httpsOrigin || body.serverCertificateSha256 !== securityBinding.value.serverCertificateSha256) fail(403);
    const principal = device(body.token);
    if (name === "status") return status(principal, body);
    sameScope(principal);
    if (name === "lock") {
      if (secret(body.unlockToken)) {
        const key = digest(body.unlockToken), found = sessions.get(key);
        if (found?.deviceId === principal.deviceId) { sessions.delete(key); for (const [id, plan] of plans) if (plan.unlockHash === key) plans.delete(id); }
      }
      return { version: 1, locked: true };
    }
    if (name === "setup") {
      const saved = available(), ticket = saved.ticket, revision = saved.revision;
      if (saved.owner || !ticket || !secret(body.ticket) || digest(body.ticket) !== ticket.hash || ticket.expiresAtMs <= now()
        || ticket.expiresAtMs > now() + WINDOW || ticket.scopeId !== principal.context.scopeId || ticket.binding !== securityBinding.hash) {
        reserveAttempt(); return fail(401);
      }
      if (!isMetadataAddress(body.destinationAddress)) fail(400);
      const owner = await passwordHash(body.password);
      if (available().revision !== revision || available().ticket?.hash !== ticket.hash || ticket.expiresAtMs <= now()
        || binding().hash !== securityBinding.hash || device(body.token).context.rosterRevision !== principal.context.rosterRevision) fail(409);
      persist({ ...available(), revision: revision + 1, scopeId: ticket.scopeId, owner, ticket: null,
        configuration: vault.seal({ destinationAddress: body.destinationAddress }, purpose("configuration")) });
      clearAuthority(); return issueUnlock(principal);
    }
    if (name === "unlock") {
      const saved = available(), prior = saved.owner, revision = saved.revision;
      if (!prior) fail(401);
      await passwordHash(body.password, prior);
      if (available().revision !== revision || binding().hash !== securityBinding.hash
        || device(body.token).context.rosterRevision !== principal.context.rosterRevision) fail(409);
      return issueUnlock(principal);
    }
    const authorization = requireUnlock(body);
    if (name === "configuration") return configuration(authorization.principal);
    if (name === "configure") {
      const saved = available(), revision = saved.revision;
      if (body.destinationAddress === undefined && body.newPassword === undefined || body.destinationAddress !== undefined && !isMetadataAddress(body.destinationAddress)
        || body.newPassword !== undefined && !validPassword(body.newPassword)) fail(400);
      await passwordHash(body.currentPassword, saved.owner!);
      requireUnlock(body);
      const owner = body.newPassword === undefined ? saved.owner : await passwordHash(body.newPassword);
      requireUnlock(body);
      if (available().revision !== revision || binding().hash !== securityBinding.hash) fail(409);
      const recipient = body.destinationAddress ?? destination();
      persist({ ...available(), revision: revision + 1, owner, ticket: null, configuration: vault.seal({ destinationAddress: recipient }, purpose("configuration")) });
      clearAuthority(); return { version: 1, locked: true };
    }
    if (name === "prepare") {
      if (available().consumed || preparing) fail(409);
      if (!isMetadataAddress(body.sourceAddress) || !principal.context.addresses.includes(body.sourceAddress)) fail(400);
      const recipient = destination(), revision = available().revision;
      if (recipient === body.sourceAddress) fail(400);
      preparing = true;
      try {
        const quote = parseQuote(await driver.prepare(structuredClone(principal.context), body.sourceAddress, recipient));
        requireUnlock(body);
        if (now() >= quote.expiresAtMs) throw new TreasuryPreflightError("review-expired");
        if (available().consumed || available().revision !== revision || quote.sourceAddress !== body.sourceAddress || quote.destinationAddress !== recipient
          || quote.scopeId !== principal.context.scopeId || quote.rosterRevision !== principal.context.rosterRevision
          || quote.preparedAtMs > now() + 15_000 || binding().hash !== securityBinding.hash) fail(409);
        const planId = randomUUID(), publicQuote = parseTreasuryQuote(quote);
        const reviewDigest = digest(JSON.stringify([access.serverId, principal.context.scopeId, principal.context.rosterRevision, revision, planId, quote]));
        const publicValue: TreasuryPlan = { version: 1, planId, reviewDigest, expiresAtMs: quote.expiresAtMs, quote: publicQuote };
        plans.clear(); plans.set(planId, { public: publicValue, quote, revision, deviceId: principal.deviceId, unlockHash: authorization.unlock.hash, binding: securityBinding.hash });
        authorization.unlock.expiresAtMs = now() + WINDOW;
        return structuredClone(publicValue);
      } catch (error) {
        if (error instanceof SharedHttpError) throw error;
        // Do not return financial preflight information after access was revoked
        // while the read was waiting for the provider or shared allowance.
        requireUnlock(body);
        return treasuryPreflightFailure(error);
      }
      finally { preparing = false; }
    }
    if (name === "confirm") {
      if (typeof body.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(body.idempotencyKey) || !validId(body.planId) || !hash(body.reviewDigest)) fail(400);
      const existing = operation(), requestHash = digest(body.idempotencyKey);
      if (existing) {
        if (existing.requestKeyHash === requestHash && existing.planId === body.planId && existing.reviewDigest === body.reviewDigest
          && existing.scopeId === principal.context.scopeId) return { version: 1, operation: existing.public };
        fail(409);
      }
      const prepared = plans.get(body.planId);
      if (available().consumed || !prepared || prepared.public.reviewDigest !== body.reviewDigest || prepared.revision !== available().revision
        || prepared.deviceId !== principal.deviceId || prepared.unlockHash !== authorization.unlock.hash || prepared.binding !== securityBinding.hash
        || prepared.quote.rosterRevision !== principal.context.rosterRevision) fail(409);
      if (prepared.quote.expiresAtMs <= now()) return treasuryPreflightFailure(new TreasuryPreflightError("review-expired"));
      // Known budget deferrals must not consume the sole pilot before any
      // signer starts. This does not increase or reset the shared allowance.
      try { driver.assertReady?.(structuredClone(prepared.quote)); } catch (error) { return treasuryPreflightFailure(error); }
      const at = now(), id = randomUUID();
      const created: StoredOperation = { public: { id, phase: "authorized", sourceAddress: prepared.quote.sourceAddress,
        destinationAddress: prepared.quote.destinationAddress, amountBaseUnits: TREASURY_AMOUNT, signature: null,
        startedAtMs: at, updatedAtMs: at, confirmedAtMs: null, slot: null, error: null }, scopeId: principal.context.scopeId,
        rosterRevision: principal.context.rosterRevision, configurationRevision: prepared.revision, planId: body.planId,
        reviewDigest: body.reviewDigest, requestKeyHash: requestHash, quote: structuredClone(prepared.quote), signed: null,
        reconcileAttempts: 0, nextReconcileAtMs: 0 };
      saveOperation(created); plans.clear();
      authorization.unlock.expiresAtMs = now() + WINDOW;
      track(execute(id, { ...body }, prepared));
      return { version: 1, operation: created.public };
    }
    if (name === "operations") {
      const value = operation();
      if (value && value.scopeId !== principal.context.scopeId) fail(403);
      if (body.id !== undefined) { if (!value || body.id !== value.public.id) fail(404); return { version: 1, operation: value.public }; }
      return { version: 1, operations: value ? [value.public] : [] };
    }
    return fail(404);
  }
  function control(body: Record<string, unknown>): unknown {
    if (!["treasury-setup", "treasury-reset"].includes(String(body.operation)) || Object.keys(body).some(key => !["operation", "scopeId"].includes(key))
      || !validId(body.scopeId)) fail(400);
    const context = access.fleet(body.scopeId), saved = available();
    if (saved.scopeId !== null && saved.scopeId !== context.scopeId) fail(403);
    if (body.operation === "treasury-setup" && saved.owner) fail(409);
    const securityBinding = binding(), ticket = randomBytes(32).toString("base64url"), expiresAtMs = now() + WINDOW;
    let next = { ...saved, revision: saved.revision + 1, ticket: { hash: digest(ticket), scopeId: context.scopeId, binding: securityBinding.hash, expiresAtMs } };
    if (body.operation === "treasury-reset") {
      next = { ...next, owner: null, configuration: null };
      const current = operation();
      if (current && ["authorized", "signed"].includes(current.public.phase)) {
        current.public = { ...current.public, phase: "cancelled", error: "Terminal recovery cancelled this unsent operation. The pilot remains consumed.", updatedAtMs: Math.max(now(), current.public.updatedAtMs) };
        next.operation = vault.seal(current, purpose("operation"));
      }
    }
    persist(next); clearAuthority();
    return { version: 1, ticket, expiresAtMs, httpsOrigin: securityBinding.value.httpsOrigin,
      setupUrl: `${securityBinding.value.httpsOrigin}/wallet#ticket=${ticket}` };
  }
  async function reconcilePending(): Promise<void> {
    if (closed || broken || reconciling || pending.size) return;
    reconciling = true;
    try {
      const current = operation(); if (!current) return;
      if (["authorized", "signed"].includes(current.public.phase)) {
        transition(current.public.id, "cancelled", "Wallet execution was interrupted before submission. No new signing or send will be attempted."); return;
      }
      await reconcileOne(current.public.id);
    } finally { reconciling = false; }
  }
  return { dispatch, control, reconcilePending, authorizeOperation,
    async waitForIdle() { await Promise.allSettled([...pending]); },
    async close() { closed = true; clearAuthority(); await Promise.allSettled([...pending]); },
  };
}
