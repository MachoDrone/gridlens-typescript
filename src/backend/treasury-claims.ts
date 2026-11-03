import { createHash, randomUUID } from "node:crypto";
import { address } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import type { FleetContext } from "../contracts/fleet.ts";
import { NOS_MINT } from "../fleet/nos.ts";
import { isMetadataAddress } from "../fleet/host-metadata.ts";
import { claimAmount, claimSignature, claimUnresolved, parseClaimsOperation, parseClaimsQuote, parseClaimsStatus } from "../contracts/treasury-claims.ts";
import type { TreasuryClaimOperation, TreasuryClaimPlan, TreasuryClaimQuote, TreasuryClaimsStatus } from "../contracts/treasury-claims.ts";
import type { PrivateState } from "./access.ts";
import type { TreasuryVault } from "./treasury-vault.ts";
import { TreasuryPreflightError, treasuryPreflightFailure } from "./treasury-errors.ts";
import { SharedHttpError } from "./ipc.ts";

export interface ClaimsQuote {
  scopeId: string; rosterRevision: string; sourceAddress: string;
  sourceBinding: { pcId: string; nodeId: string; containerId: string; sshIdentity: string };
  sourceTokenAddress: string; mintAddress: string; decimals: 6; lastReportedAmountBaseUnits: string; checkedAtMs: number; expiresAtMs: number;
}
export interface ClaimsDispatchResult {
  status: "acknowledged" | "rejected" | "uncertain" | "rate-limited" | "authentication-failed"; success: boolean | null;
  /** Missing only in persisted dev.20 records, never in a new helper response. */
  amountUnit?: "base-units";
  claimedAmountAtoms?: string; signature?: string; observedAtMs: number; retryAfterSeconds?: number;
}
export interface ClaimsReconcileInput { quote: ClaimsQuote; dispatch: ClaimsDispatchResult }
export interface ClaimsAmountCorrection {
  kind: "legacy-post-base-units"; originalClaimedAmountAtoms: string; correctedClaimedAmountAtoms: string;
}
export interface ClaimsReceipt {
  status: "confirmed" | "failed" | "uncertain"; observedAtMs: number; slot?: number; retryAtMs?: number;
  paidAmountBaseUnits?: string; payoutOwner?: string; payoutTokenAddress?: string; mintAddress?: string;
  amountCorrection?: ClaimsAmountCorrection;
}
export interface ClaimsDriver {
  prepare(context: FleetContext, sourceAddress: string): Promise<ClaimsQuote>;
  assertReady(quote: ClaimsQuote): void;
  dispatch(quote: ClaimsQuote, authorize: () => void, operationId?: string): Promise<ClaimsDispatchResult>;
  /** Read only the already-journaled guardian result. Never dispatch a claim. */
  recover?(quote: ClaimsQuote, operationId: string): Promise<ClaimsDispatchResult | null>;
  reconcile(operation: ClaimsReconcileInput): Promise<ClaimsReceipt>;
}
/** Only trusted driver code may use this before handing the mutating helper to
 * its runner. Never construct it from an upstream rejection or lost response. */
export class ClaimsNotDispatchedError extends Error { constructor() { super("Claim helper was not dispatched."); } }
export interface ClaimsAuthorization {
  context: FleetContext; deviceId: string; configurationRevision: number; authorizationId: string;
  guard(): void; touch(): void;
}
interface Index { version: 1; serverId: string; keyId: string; entries: { hostHash: string; id: string }[]; unresolvedId: string | null }
interface Stored {
  public: TreasuryClaimOperation; quote: ClaimsQuote; dispatch: ClaimsDispatchResult | null;
  configurationRevision: number; planId: string; reviewDigest: string; requestKeyHash: string;
  reconcileAttempts: number; nextReconcileAtMs: number;
  /** Encrypted provenance; the original mistaken interpretation is not erased. */
  amountCorrection?: ClaimsAmountCorrection & { version: 1; factor: "1000000"; signature: string; verifiedSlot: number; verifiedAtMs: number };
}
interface Prepared { public: TreasuryClaimPlan; quote: ClaimsQuote; deviceId: string; authorizationId: string; configurationRevision: number }
export const TREASURY_CLAIMS_LEDGER_KEY = "treasury.claims.v1";
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 8_640_000_000_000_000;
const id = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key)))
    throw new Error("Invalid retained claim state.");
}
export function parseQuote(value: unknown): ClaimsQuote {
  fields(value, ["scopeId", "rosterRevision", "sourceAddress", "sourceBinding", "sourceTokenAddress", "mintAddress", "decimals", "lastReportedAmountBaseUnits", "checkedAtMs", "expiresAtMs"]);
  if (!text(value.scopeId) || !text(value.rosterRevision)) throw new Error("Invalid claim scope.");
  const binding = value.sourceBinding;
  fields(binding, ["pcId", "nodeId", "containerId", "sshIdentity"]);
  if (!hash(binding.pcId) || !hash(binding.nodeId) || !hash(binding.containerId) || typeof binding.sshIdentity !== "string"
    || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(binding.sshIdentity)) throw new Error("Invalid claim source.");
  const quote = parseClaimsQuote({ sourceAddress: value.sourceAddress, payoutOwner: value.sourceAddress, payoutTokenAddress: value.sourceTokenAddress,
    mintAddress: value.mintAddress, decimals: value.decimals, amountMode: "full-available", lastReportedAmountBaseUnits: value.lastReportedAmountBaseUnits,
    checkedAtMs: value.checkedAtMs, expiresAtMs: value.expiresAtMs });
  return { scopeId: value.scopeId, rosterRevision: value.rosterRevision, sourceAddress: quote.sourceAddress,
    sourceBinding: { pcId: binding.pcId, nodeId: binding.nodeId, containerId: binding.containerId, sshIdentity: binding.sshIdentity },
    sourceTokenAddress: quote.payoutTokenAddress, mintAddress: quote.mintAddress, decimals: 6, lastReportedAmountBaseUnits: quote.lastReportedAmountBaseUnits,
    checkedAtMs: quote.checkedAtMs, expiresAtMs: quote.expiresAtMs };
}
function publicQuote(quote: ClaimsQuote): TreasuryClaimQuote {
  return parseClaimsQuote({ sourceAddress: quote.sourceAddress, payoutOwner: quote.sourceAddress, payoutTokenAddress: quote.sourceTokenAddress,
    mintAddress: quote.mintAddress, decimals: 6, amountMode: "full-available", lastReportedAmountBaseUnits: quote.lastReportedAmountBaseUnits,
    checkedAtMs: quote.checkedAtMs, expiresAtMs: quote.expiresAtMs });
}
export function parseDispatch(value: unknown, allowLegacy = false): ClaimsDispatchResult {
  fields(value, ["status", "success", "observedAtMs"], ["amountUnit", "claimedAmountAtoms", "signature", "retryAfterSeconds"]);
  if (!["acknowledged", "rejected", "uncertain", "rate-limited", "authentication-failed"].includes(String(value.status))
    || value.success !== null && typeof value.success !== "boolean" || !time(value.observedAtMs)
    || (value.amountUnit !== "base-units" && !(allowLegacy && value.amountUnit === undefined))
    || value.claimedAmountAtoms !== undefined && !claimAmount(value.claimedAmountAtoms) || value.signature !== undefined && !claimSignature(value.signature)
    || value.retryAfterSeconds !== undefined && (!time(value.retryAfterSeconds) || value.retryAfterSeconds > 2_147_483_647)) throw new Error("Invalid claim response.");
  return { status: value.status as ClaimsDispatchResult["status"], success: value.success as boolean | null, observedAtMs: value.observedAtMs,
    ...(value.amountUnit === undefined ? {} : { amountUnit: "base-units" as const }),
    ...(value.claimedAmountAtoms === undefined ? {} : { claimedAmountAtoms: value.claimedAmountAtoms as string }),
    ...(value.signature === undefined ? {} : { signature: value.signature as string }),
    ...(value.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: value.retryAfterSeconds as number }) };
}
const verifiable = (response: ClaimsDispatchResult | null): response is ClaimsDispatchResult & { signature: string; claimedAmountAtoms: string } =>
  response !== null && response.status === "acknowledged" && response.success === true && claimSignature(response.signature) && claimAmount(response.claimedAmountAtoms);

function parseAmountCorrection(value: unknown): ClaimsAmountCorrection {
  fields(value, ["kind", "originalClaimedAmountAtoms", "correctedClaimedAmountAtoms"]);
  if (value.kind !== "legacy-post-base-units" || !claimAmount(value.originalClaimedAmountAtoms) || !claimAmount(value.correctedClaimedAmountAtoms)
    || BigInt(value.originalClaimedAmountAtoms) !== BigInt(value.correctedClaimedAmountAtoms) * 1_000_000n) throw new Error("Invalid claim amount correction.");
  return { kind: "legacy-post-base-units", originalClaimedAmountAtoms: value.originalClaimedAmountAtoms, correctedClaimedAmountAtoms: value.correctedClaimedAmountAtoms };
}
function parseCorrectionAudit(value: unknown, operation: TreasuryClaimOperation, response: ClaimsDispatchResult | null): NonNullable<Stored["amountCorrection"]> {
  fields(value, ["version", "kind", "originalClaimedAmountAtoms", "correctedClaimedAmountAtoms", "factor", "signature", "verifiedSlot", "verifiedAtMs"]);
  const correction = parseAmountCorrection({ kind: value.kind, originalClaimedAmountAtoms: value.originalClaimedAmountAtoms, correctedClaimedAmountAtoms: value.correctedClaimedAmountAtoms });
  if (value.version !== 1 || value.factor !== "1000000" || !claimSignature(value.signature) || !time(value.verifiedSlot) || value.verifiedSlot === 0 || !time(value.verifiedAtMs)
    || !verifiable(response) || response.amountUnit !== "base-units" || value.signature !== response.signature || value.signature !== operation.signature
    || operation.phase !== "confirmed" || correction.correctedClaimedAmountAtoms !== response.claimedAmountAtoms
    || correction.correctedClaimedAmountAtoms !== operation.paidAmountBaseUnits || value.verifiedSlot !== operation.slot || value.verifiedAtMs !== operation.confirmedAtMs)
    throw new Error("Claim amount correction lost its receipt binding.");
  return { version: 1, ...correction, factor: "1000000", signature: value.signature, verifiedSlot: value.verifiedSlot, verifiedAtMs: value.verifiedAtMs };
}

/** Separate per-public-host claim allowance. Never modifies treasury.v1 or its
 * original one-NOS transfer receipt, including when owner configuration resets. */
export function createTreasuryClaims(state: PrivateState, options: {
  serverId: string; vault: TreasuryVault; driver: ClaimsDriver; authorizeOperation: (body: Record<string, unknown>) => ClaimsAuthorization;
  initialize?: boolean; now?: () => number; hosts?: (context: FleetContext) => { address: string; label: string }[];
  requireFinancialReady?: (context: FleetContext) => void;
}) {
  const { serverId, vault, driver, authorizeOperation } = options, now = options.now ?? Date.now;
  let index: Index | undefined, broken = false, closing = false, preparing = false, reconciliation: Promise<void> | undefined;
  const pending = new Set<Promise<void>>(), plans = new Map<string, Prepared>();
  const recordKey = (operationId: string) => `${TREASURY_CLAIMS_LEDGER_KEY}/operation/${operationId}`;
  const purpose = (operationId: string) => `${serverId}:claims-v1:${operationId}`;
  const hostHash = (source: string) => digest(JSON.stringify([serverId, source]));
  function fail(status = 409): never { throw new SharedHttpError(status); }
  function available(): Index { if (broken || !index) fail(503); return index; }
  function read(operationId: string): Stored {
    try {
      const encrypted = state.get<unknown>(recordKey(operationId));
      if (typeof encrypted !== "string" || encrypted.length > 90_000) throw new Error();
      const row = vault.open<unknown>(encrypted, purpose(operationId));
      fields(row, ["public", "quote", "dispatch", "configurationRevision", "planId", "reviewDigest", "requestKeyHash", "reconcileAttempts", "nextReconcileAtMs"], ["amountCorrection"]);
      const value = parseClaimsOperation(row.public), quote = parseQuote(row.quote), response = row.dispatch === null ? null : parseDispatch(row.dispatch, true);
      if (value.id !== operationId || value.sourceAddress !== quote.sourceAddress || value.payoutTokenAddress !== quote.sourceTokenAddress
        || value.lastReportedAmountBaseUnits !== quote.lastReportedAmountBaseUnits || !time(row.configurationRevision) || !id(row.planId)
        || !hash(row.reviewDigest) || !hash(row.requestKeyHash) || !time(row.reconcileAttempts) || row.reconcileAttempts > 4 || !time(row.nextReconcileAtMs)
        || value.signature !== (response?.signature ?? null) || value.paidAmountBaseUnits !== (response?.claimedAmountAtoms ?? null)
        || ["confirmed", "verifying", "failed"].includes(value.phase) && !verifiable(response)) throw new Error();
      return { public: value, quote, dispatch: response, configurationRevision: row.configurationRevision, planId: row.planId,
        reviewDigest: row.reviewDigest, requestKeyHash: row.requestKeyHash, reconcileAttempts: row.reconcileAttempts, nextReconcileAtMs: row.nextReconcileAtMs,
        ...(row.amountCorrection === undefined ? {} : { amountCorrection: parseCorrectionAudit(row.amountCorrection, value, response) }) };
    } catch { broken = true; plans.clear(); return fail(503); }
  }
  function persist(next: Index, row?: Stored): void {
    available();
    try {
      const writes: [string, unknown][] = [[TREASURY_CLAIMS_LEDGER_KEY, next]];
      if (row) writes.push([recordKey(row.public.id), vault.seal(row, purpose(row.public.id))]);
      if (!state.batch) throw new Error();
      state.batch(writes); index = next;
    } catch { broken = true; plans.clear(); fail(503); }
  }
  function save(row: Stored): void {
    const saved = available();
    if (!saved.entries.some(entry => entry.id === row.public.id && entry.hostHash === hostHash(row.quote.sourceAddress))) fail(503);
    const unresolvedId = claimUnresolved(row.public.phase) ? row.public.id : saved.unresolvedId === row.public.id ? null : saved.unresolvedId;
    if (saved.unresolvedId !== null && saved.unresolvedId !== row.public.id && claimUnresolved(row.public.phase)) fail(503);
    persist({ ...saved, unresolvedId }, row);
  }
  try {
    if (!text(serverId) || !hash(vault.keyId) || !state.batch) throw new Error();
    const saved = state.get<unknown>(TREASURY_CLAIMS_LEDGER_KEY);
    if (saved === undefined) {
      if (!options.initialize) throw new Error();
      index = { version: 1, serverId, keyId: vault.keyId, entries: [], unresolvedId: null }; persist(index);
    } else {
      fields(saved, ["version", "serverId", "keyId", "entries", "unresolvedId"]);
      if (saved.version !== 1 || saved.serverId !== serverId || saved.keyId !== vault.keyId || !Array.isArray(saved.entries) || saved.entries.length > 10_000
        || saved.unresolvedId !== null && !id(saved.unresolvedId) || saved.entries.some(entry => !object(entry) || Object.keys(entry).length !== 2 || !hash(entry.hostHash) || !id(entry.id))
        || new Set(saved.entries.map(entry => entry.hostHash)).size !== saved.entries.length || new Set(saved.entries.map(entry => entry.id)).size !== saved.entries.length) throw new Error();
      index = structuredClone(saved) as unknown as Index;
      const unresolved: string[] = [];
      for (const entry of index.entries) {
        const operation = read(entry.id);
        if (hostHash(operation.quote.sourceAddress) !== entry.hostHash) throw new Error();
        if (claimUnresolved(operation.public.phase)) unresolved.push(entry.id);
      }
      if (unresolved.length > 1 || (unresolved[0] ?? null) !== index.unresolvedId) throw new Error();
    }
  } catch { broken = true; }
  function status(auth: ClaimsAuthorization): TreasuryClaimsStatus {
    if (broken) return { version: 1, supported: false, state: "recovery-required", unresolvedOperationId: null, attemptedHosts: [], eligibleHosts: [] };
    const saved = available(), attemptedHosts = saved.entries.map(entry => read(entry.id)).filter(row => row.quote.scopeId === auth.context.scopeId).map(row => row.quote.sourceAddress);
    const attempted = new Set(saved.entries.map(entry => entry.hostHash));
    const hosts = options.hosts?.(auth.context) ?? auth.context.addresses.map(address => ({ address, label: address }));
    if (hosts.some(row => !auth.context.addresses.includes(row.address))) fail(503);
    return parseClaimsStatus({ version: 1, supported: true, state: "ready", unresolvedOperationId: saved.unresolvedId, attemptedHosts,
      eligibleHosts: hosts.filter(row => !attempted.has(hostHash(row.address))) });
  }
  function transition(operationId: string, phase: TreasuryClaimOperation["phase"], error: string | null): void {
    const current = read(operationId); save({ ...current, public: { ...current.public, phase, error, updatedAtMs: Math.max(now(), current.public.updatedAtMs) } });
  }
  async function reconcileOne(operationId: string): Promise<void> {
    let current = read(operationId);
    if (!verifiable(current.dispatch) && !driver.recover || !["verifying", "needs-verification"].includes(current.public.phase) || current.nextReconcileAtMs > now()) return;
    const count = Math.min(4, current.reconcileAttempts + 1), delay = [15_000, 30_000, 60_000, 300_000][count - 1]!;
    save({ ...current, reconcileAttempts: count, nextReconcileAtMs: now() + delay });
    if (!verifiable(current.dispatch)) {
      let captured: ClaimsDispatchResult | null = null;
      try { const recovered = await driver.recover!(structuredClone(current.quote), operationId); if (recovered !== null) captured = parseDispatch(recovered); }
      catch { /* A failed guardian read never becomes another claim request. */ }
      if (!verifiable(captured)) return;
      current = read(operationId);
      current = { ...current, dispatch: captured, public: { ...current.public, phase: "verifying", signature: captured.signature,
        paidAmountBaseUnits: captured.claimedAmountAtoms, updatedAtMs: Math.max(now(), current.public.updatedAtMs),
        error: "The recorded guardian payout is awaiting finalized verification. No claim request will be repeated." } };
      save(current);
    }
    if (!verifiable(current.dispatch)) return;
    let receipt: ClaimsReceipt;
    try { receipt = await driver.reconcile({ quote: structuredClone(current.quote), dispatch: structuredClone(current.dispatch) }); }
    catch { receipt = { status: "uncertain", observedAtMs: now() }; }
    const latest = read(operationId);
    let result: "confirmed" | "failed" | "uncertain" = "uncertain";
    let correction: Stored["amountCorrection"];
    if (receipt && ["confirmed", "failed", "uncertain"].includes(receipt.status) && time(receipt.observedAtMs) && receipt.observedAtMs <= now() + 15_000
      && (receipt.retryAtMs === undefined || time(receipt.retryAtMs))) {
      if (receipt.status === "confirmed" && time(receipt.slot) && receipt.slot > 0
        && receipt.payoutOwner === current.quote.sourceAddress && receipt.payoutTokenAddress === current.quote.sourceTokenAddress && receipt.mintAddress === NOS_MINT) {
        if (receipt.amountCorrection === undefined) {
          if (receipt.paidAmountBaseUnits === current.dispatch.claimedAmountAtoms) result = "confirmed";
        } else {
          try {
            const checked = parseAmountCorrection(receipt.amountCorrection);
            if (!verifiable(latest.dispatch) || latest.dispatch.amountUnit !== undefined || latest.amountCorrection !== undefined
              || latest.dispatch.signature !== current.dispatch.signature || checked.originalClaimedAmountAtoms !== latest.dispatch.claimedAmountAtoms
              || checked.originalClaimedAmountAtoms !== latest.public.paidAmountBaseUnits || checked.correctedClaimedAmountAtoms !== receipt.paidAmountBaseUnits)
              throw new Error("The legacy receipt correction does not match the retained operation.");
            correction = { version: 1, ...checked, factor: "1000000", signature: latest.dispatch.signature, verifiedSlot: receipt.slot, verifiedAtMs: receipt.observedAtMs };
            result = "confirmed";
          } catch { /* Keep the original captured amount unless every proof binding validates. */ }
        }
      } else if (receipt.status === "failed" && receipt.amountCorrection === undefined && time(receipt.slot) && receipt.slot > 0) result = "failed";
    }
    // One atomic retained-ledger update stores the canonical amount and its
    // encrypted provenance with the ordinary confirmed transition. No claim
    // request, reservation, identity, quote or original transfer record changes.
    save({ ...latest, ...(correction ? { amountCorrection: correction,
      dispatch: { ...latest.dispatch!, amountUnit: "base-units" as const, claimedAmountAtoms: correction.correctedClaimedAmountAtoms } } : {}),
      nextReconcileAtMs: result === "uncertain" ? Math.max(latest.nextReconcileAtMs, now() + delay,
      receipt && time(receipt.retryAtMs) ? receipt.retryAtMs : 0) : 0,
      public: { ...latest.public, phase: result === "uncertain" ? "verifying" : result, updatedAtMs: Math.max(now(), latest.public.updatedAtMs),
        ...(correction ? { paidAmountBaseUnits: correction.correctedClaimedAmountAtoms } : {}),
        confirmedAtMs: result === "confirmed" ? receipt.observedAtMs : null, slot: result !== "uncertain" ? receipt.slot! : null,
        error: result === "confirmed" ? null : result === "failed" ? "The recorded payout transaction failed. This host's claim attempt remains used."
          : "The recorded payout is not finalized and verified yet. No claim request will be repeated." } });
  }
  async function execute(operationId: string, auth: ClaimsAuthorization): Promise<void> {
    try {
      const current = read(operationId);
      try { if (closing) fail(503); auth.guard(); } catch {
        transition(operationId, "cancelled", "Owner authorization changed before dispatch. This host's attempt remains used."); return;
      }
      transition(operationId, "dispatch-started", null);
      let response: ClaimsDispatchResult;
      try {
        response = parseDispatch(await driver.dispatch(structuredClone(current.quote), () => {
          if (closing) fail(503); auth.guard();
          if (read(operationId).public.phase !== "dispatch-started") fail(409);
        }, operationId));
        // A clock step after dispatch must not erase the only known payout
        // signature/amount. The bounded timestamp is retained as reported;
        // finalized receipt evidence, not ACK wall-clock ordering, proves payment.
      } catch (error) {
        if (error instanceof ClaimsNotDispatchedError) transition(operationId, "cancelled", "The claim helper was not dispatched. This host's attempt remains used.");
        else transition(operationId, "needs-verification", "The claim outcome is unknown. Do not claim again; payment may have occurred.");
        return;
      }
      // This reply belongs to an already dispatched operation. Owner lock/reset
      // or graceful shutdown must not discard it or cause another API request.
      const latest = read(operationId);
      save({ ...latest, dispatch: response, public: { ...latest.public, phase: verifiable(response) ? "verifying" : "needs-verification",
        paidAmountBaseUnits: response.claimedAmountAtoms ?? null, signature: response.signature ?? null, updatedAtMs: Math.max(now(), latest.public.updatedAtMs),
        error: verifiable(response) ? null : "The claim response does not prove a payout. Do not claim again; payment may have occurred." } });
      if (!closing && verifiable(response)) await reconcileOne(operationId);
    } catch { /* A persistence failure poisons admission; never redispatch. */ }
  }
  function track(task: Promise<void>): void { pending.add(task); void task.finally(() => pending.delete(task)).catch(() => {}); }
  const common = ["operation", "token", "unlockToken", "httpsOrigin", "serverCertificateSha256"];
  const routes: Record<string, string[]> = { "claims-status": [], "claims-prepare": ["sourceAddress"],
    "claims-confirm": ["planId", "reviewDigest", "idempotencyKey"], "claims-operations": ["id"] };
  async function dispatch(input: Record<string, unknown>): Promise<unknown> {
    if (closing) fail(503);
    // All accepted fields are primitives; do not retain caller-owned mutable data.
    const body = { ...input }, name = String(body.operation), allowed = Object.hasOwn(routes, name) ? routes[name]! : undefined;
    if (!allowed || Object.keys(body).some(key => !common.includes(key) && !allowed.includes(key))
      || Object.values(body).some(value => value !== undefined && typeof value !== "string")) fail(400);
    const initialAuthorization = authorizeOperation(body); initialAuthorization.guard();
    const financial = name === "claims-prepare" || name === "claims-confirm";
    if (financial) { try { options.requireFinancialReady?.(initialAuthorization.context); } catch (error) { return treasuryPreflightFailure(error); } }
    const auth: ClaimsAuthorization = { ...initialAuthorization, guard() {
      initialAuthorization.guard(); if (financial) options.requireFinancialReady?.(initialAuthorization.context);
    } };
    if (name === "claims-status") return status(auth);
    const saved = available();
    if (name === "claims-operations") {
      if (body.id !== undefined) {
        if (!id(body.id) || !saved.entries.some(entry => entry.id === body.id)) fail(404);
        const row = read(body.id); if (row.quote.scopeId !== auth.context.scopeId) fail(403);
        return { version: 1, operation: row.public };
      }
      const rows = saved.entries.slice().reverse().map(entry => read(entry.id)).filter(row => row.quote.scopeId === auth.context.scopeId);
      return { version: 1, operations: rows.slice(0, 100).map(row => row.public), total: rows.length };
    }
    if (name === "claims-prepare") {
      if (saved.unresolvedId || preparing || saved.entries.length >= 10_000) fail(409);
      if (!isMetadataAddress(body.sourceAddress) || !auth.context.addresses.includes(body.sourceAddress)) fail(400);
      if (saved.entries.some(entry => entry.hostHash === hostHash(body.sourceAddress as string))) fail(409);
      preparing = true;
      try {
        const quote = parseQuote(await driver.prepare(structuredClone(auth.context), body.sourceAddress));
        const [expectedAccount] = await findAssociatedTokenPda({ owner: address(quote.sourceAddress), tokenProgram: TOKEN_PROGRAM_ADDRESS, mint: address(NOS_MINT) });
        auth.guard();
        if (closing || available().unresolvedId || available().entries.some(entry => entry.hostHash === hostHash(quote.sourceAddress))
          || quote.scopeId !== auth.context.scopeId || quote.rosterRevision !== auth.context.rosterRevision
          || quote.sourceAddress !== body.sourceAddress || quote.sourceTokenAddress !== expectedAccount) throw new TreasuryPreflightError("source-changed");
        if (quote.checkedAtMs > now() + 15_000 || now() - quote.checkedAtMs > 360_000 || quote.expiresAtMs <= now() || quote.expiresAtMs > now() + 60_000)
          throw new TreasuryPreflightError("review-expired");
        const planId = randomUUID(), reviewDigest = digest(JSON.stringify([serverId, auth.deviceId, auth.authorizationId, auth.configurationRevision, planId, quote]));
        const result: TreasuryClaimPlan = { version: 1, planId, reviewDigest, expiresAtMs: quote.expiresAtMs, quote: publicQuote(quote) };
        plans.clear(); plans.set(planId, { public: result, quote, deviceId: auth.deviceId, authorizationId: auth.authorizationId, configurationRevision: auth.configurationRevision });
        auth.touch(); return structuredClone(result);
      } catch (error) { if (error instanceof SharedHttpError) throw error; auth.guard(); return treasuryPreflightFailure(error); }
      finally { preparing = false; }
    }
    if (name === "claims-confirm") {
      if (!id(body.planId) || !hash(body.reviewDigest) || typeof body.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(body.idempotencyKey)) fail(400);
      const requestKeyHash = digest(body.idempotencyKey);
      for (const entry of saved.entries) {
        const row = read(entry.id);
        if (row.requestKeyHash === requestKeyHash) {
          if (row.planId !== body.planId || row.reviewDigest !== body.reviewDigest || row.quote.scopeId !== auth.context.scopeId) fail(409);
          return { version: 1, operation: row.public };
        }
      }
      const plan = plans.get(body.planId);
      if (saved.unresolvedId || !plan || plan.public.reviewDigest !== body.reviewDigest || plan.deviceId !== auth.deviceId || plan.authorizationId !== auth.authorizationId
        || plan.configurationRevision !== auth.configurationRevision || plan.quote.scopeId !== auth.context.scopeId || plan.quote.rosterRevision !== auth.context.rosterRevision
        || saved.entries.some(entry => entry.hostHash === hostHash(plan.quote.sourceAddress)) || saved.entries.length >= 10_000) fail(409);
      if (plan.quote.expiresAtMs <= now()) return treasuryPreflightFailure(new TreasuryPreflightError("review-expired"));
      try { driver.assertReady(structuredClone(plan.quote)); auth.guard(); } catch (error) { if (error instanceof SharedHttpError) throw error; return treasuryPreflightFailure(error); }
      const operationId = randomUUID(), at = now();
      const row: Stored = { public: { id: operationId, phase: "authorized", sourceAddress: plan.quote.sourceAddress, payoutOwner: plan.quote.sourceAddress,
        payoutTokenAddress: plan.quote.sourceTokenAddress, lastReportedAmountBaseUnits: plan.quote.lastReportedAmountBaseUnits, paidAmountBaseUnits: null,
        signature: null, startedAtMs: at, updatedAtMs: at, confirmedAtMs: null, slot: null, error: null }, quote: structuredClone(plan.quote), dispatch: null,
        configurationRevision: auth.configurationRevision, planId: body.planId, reviewDigest: body.reviewDigest, requestKeyHash, reconcileAttempts: 0, nextReconcileAtMs: 0 };
      persist({ ...saved, entries: [...saved.entries, { hostHash: hostHash(plan.quote.sourceAddress), id: operationId }], unresolvedId: operationId }, row);
      plans.clear(); auth.touch(); track(execute(operationId, auth)); return { version: 1, operation: row.public };
    }
    return fail(404);
  }
  async function reconcilePending(): Promise<void> {
    if (closing || broken || pending.size || reconciliation) return;
    const currentId = available().unresolvedId; if (!currentId) return;
    const task = (async () => {
      const row = read(currentId);
      if (row.public.phase === "authorized") transition(currentId, "cancelled", "The operation stopped before dispatch. This host's attempt remains used.");
      else if (row.public.phase === "dispatch-started") transition(currentId, "needs-verification", "The claim was interrupted after dispatch began. Payment may have occurred; no request will be repeated.");
      else await reconcileOne(currentId);
    })();
    reconciliation = task;
    try { await task; } finally { reconciliation = undefined; }
  }
  return { dispatch, reconcilePending,
    async waitForIdle() { await Promise.allSettled([...pending, ...(reconciliation ? [reconciliation] : [])]); },
    async close() { closing = true; plans.clear(); await Promise.allSettled([...pending, ...(reconciliation ? [reconciliation] : [])]); },
  };
}
