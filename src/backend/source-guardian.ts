import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { address } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { parseAssociation } from "../contracts/shared.ts";
import type { PcAssociation } from "../contracts/shared.ts";
import { isMetadataAddress } from "../fleet/host-metadata.ts";
import { parseQuote as parseTransferQuote } from "./treasury.ts";
import type { TreasuryQuote } from "./treasury.ts";
import { parseQuote as parseClaimQuote, parseDispatch } from "./treasury-claims.ts";
import type { ClaimsDispatchResult, ClaimsQuote } from "./treasury-claims.ts";
import { validateSignedTransfer, validatedTransferMessage, TREASURY_MAX_COST, TREASURY_RESERVE, TREASURY_NOS_MINT } from "./treasury-transaction.ts";
import { authorityDigest, canonicalAuthorityJson, parseOwnerAuthority, verifyOwnerRequest } from "./owner-authority.ts";
import type { OwnerAuthorityDescriptor, OwnerSignedRequest } from "./owner-authority.ts";
import { boundedGuardianJson, GUARDIAN_MAX_BODY_BYTES, GUARDIAN_MAX_ENROLLMENT_BYTES, GUARDIAN_MAX_PIN_BYTES, GUARDIAN_MAX_REPLY_BYTES,
  GUARDIAN_MAX_LEDGER_BYTES, GUARDIAN_MAX_SOURCES, GUARDIAN_MAX_CLAIM_HISTORY, GUARDIAN_MAX_KNOWN_SOURCES } from "./guardian-limits.ts";

export const GUARDIAN_CONTAINER = "gridlens-financial-guardian";
export const GUARDIAN_VOLUME = "gridlens-financial-guardian-state";
export interface GuardianEnrollment extends OwnerAuthorityDescriptor {
  pcId: string; policyEpoch: number; destinationAddress: string; transferConsumed: boolean;
  claimedSources: string[]; sources: PcAssociation[];
}
interface Pin extends OwnerAuthorityDescriptor { pcId: string; sources: PcAssociation[] }
export interface GuardianStatus extends OwnerAuthorityDescriptor {
  ready: true; pcId: string; policyEpoch: number; destinationAddress: string; transferConsumed: boolean;
  claimedSources: string[];
  sources: { address: string; containerId: string; claimSpent: boolean }[];
}
export type GuardianAction = { kind: "transfer"; policyEpoch: number; quote: TreasuryQuote }
  | { kind: "claim"; policyEpoch: number; quote: ClaimsQuote }
  | { kind: "set-policy"; policyEpoch: number; destinationAddress: string; sources?: PcAssociation[]; claimedSources?: string[]; transferConsumed?: boolean }
  | { kind: "operation-status"; operationId: string; sourceAddress: string; operationKind: "claim" | "transfer" };
export interface GuardianRequest {
  version: 1; operationId: string; pcId: string; scopeId: string; rosterRevision: string;
  issuedAtMs: number; expiresAtMs: number; action: GuardianAction;
}
export interface GuardianReply { version: 1; operationId: string; state: "complete" | "uncertain"; result: unknown | null }
interface Operation { operationId: string; digest: string; sourceAddress: string | null; kind: GuardianAction["kind"]; reply: GuardianReply }
interface Ledger {
  version: 1; authorityId: string; pcId: string; pinHash: string; policyEpoch: number; destinationAddress: string;
  transferConsumed: boolean; claimedSources: string[]; sources: PcAssociation[]; knownSources: string[]; activeId: string | null; operations: Operation[];
}
export interface GuardianExecutor {
  transfer(source: PcAssociation, quote: TreasuryQuote, authorize: () => void): Promise<{ transactionBase64: string; signature: string }>;
  claim(source: PcAssociation, quote: ClaimsQuote, authorize: () => void): Promise<ClaimsDispatchResult>;
}
export class GuardianError extends Error {
  readonly code: "invalid" | "not-enrolled" | "owner-mismatch" | "stale-policy" | "spent" | "pending" | "recovery-required";
  constructor(code: GuardianError["code"]) { super(`Financial guardian ${code}.`); this.code = code; }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
function exact(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).sort().join(",") !== fields.sort().join(",")) throw new GuardianError("invalid");
}
export function parseGuardianRequest(value: unknown): GuardianRequest {
  boundedGuardianJson(value, GUARDIAN_MAX_BODY_BYTES);
  exact(value, ["version", "operationId", "pcId", "scopeId", "rosterRevision", "issuedAtMs", "expiresAtMs", "action"]);
  if (value.version !== 1 || !id(value.operationId) || !hash(value.pcId) || !text(value.scopeId) || !text(value.rosterRevision)
    || !time(value.issuedAtMs) || !time(value.expiresAtMs) || value.expiresAtMs <= value.issuedAtMs || value.expiresAtMs - value.issuedAtMs > 60_000 || !object(value.action)) throw new GuardianError("invalid");
  const action = value.action;
  if (action.kind === "transfer" || action.kind === "claim") {
    exact(action, ["kind", "policyEpoch", "quote"]);
    if (!time(action.policyEpoch) || action.policyEpoch < 1) throw new GuardianError("invalid");
    const quote = action.kind === "transfer" ? parseTransferQuote(action.quote) : parseClaimQuote(action.quote);
    if (canonicalAuthorityJson(quote) !== canonicalAuthorityJson(action.quote) || quote.scopeId !== value.scopeId || quote.rosterRevision !== value.rosterRevision
      || quote.sourceBinding.pcId !== value.pcId || quote.expiresAtMs < value.expiresAtMs) throw new GuardianError("invalid");
  } else if (action.kind === "set-policy") {
    if (Object.keys(action).some(key => !["kind", "policyEpoch", "destinationAddress", "sources", "claimedSources", "transferConsumed"].includes(key))
      || !time(action.policyEpoch) || action.policyEpoch < 1 || !isMetadataAddress(action.destinationAddress)
      || action.transferConsumed !== undefined && typeof action.transferConsumed !== "boolean"
      || action.claimedSources !== undefined && (!Array.isArray(action.claimedSources) || action.claimedSources.length > GUARDIAN_MAX_CLAIM_HISTORY || !action.claimedSources.every(isMetadataAddress))) throw new GuardianError("invalid");
    if (action.sources !== undefined) normalizeSources(action.sources, value.pcId);
  } else if (action.kind === "operation-status") {
    exact(action, ["kind", "operationId", "sourceAddress", "operationKind"]);
    if (!id(action.operationId) || !isMetadataAddress(action.sourceAddress) || !["claim", "transfer"].includes(String(action.operationKind))) throw new GuardianError("invalid");
  } else throw new GuardianError("invalid");
  return structuredClone(value) as unknown as GuardianRequest;
}
function normalizeSources(value: unknown, pcId: string): PcAssociation[] {
  if (!Array.isArray(value) || !value.length || value.length > GUARDIAN_MAX_SOURCES) throw new GuardianError("invalid");
  const addresses = value.map(source => object(source) ? source.address : undefined);
  if (!addresses.every(isMetadataAddress) || new Set(addresses).size !== addresses.length) throw new GuardianError("invalid");
  const sources = value.map(source => parseAssociation(source, { scopeId: "guardian", rosterRevision: "pin", addresses }));
  if (sources.some(source => source.binding.pcId !== pcId || source.binding.runtime === "podman" && !source.binding.wrapperId)) throw new GuardianError("invalid");
  return sources;
}
export function parseGuardianEnrollment(value: unknown): GuardianEnrollment {
  boundedGuardianJson(value, GUARDIAN_MAX_ENROLLMENT_BYTES);
  exact(value, ["version", "authorityId", "publicKeyDer", "pcId", "policyEpoch", "destinationAddress", "transferConsumed", "claimedSources", "sources"]);
  const owner = parseOwnerAuthority({ version: value.version, authorityId: value.authorityId, publicKeyDer: value.publicKeyDer });
  if (!hash(value.pcId) || value.policyEpoch !== 1 || !isMetadataAddress(value.destinationAddress) || typeof value.transferConsumed !== "boolean"
    || !Array.isArray(value.sources) || !value.sources.length || value.sources.length > GUARDIAN_MAX_SOURCES || !Array.isArray(value.claimedSources)
    || value.claimedSources.length > GUARDIAN_MAX_CLAIM_HISTORY || !value.claimedSources.every(isMetadataAddress)) throw new GuardianError("invalid");
  const sources = normalizeSources(value.sources, value.pcId);
  if (new Set(value.claimedSources).size !== value.claimedSources.length) throw new GuardianError("invalid");
  return { ...owner, pcId: value.pcId, policyEpoch: 1, destinationAddress: value.destinationAddress, transferConsumed: value.transferConsumed,
    claimedSources: [...value.claimedSources], sources };
}
export function serializeGuardianEnrollment(value: unknown): string {
  return boundedGuardianJson(parseGuardianEnrollment(value), GUARDIAN_MAX_ENROLLMENT_BYTES);
}
export function parseGuardianStatus(value: unknown): GuardianStatus {
  boundedGuardianJson(value, GUARDIAN_MAX_REPLY_BYTES);
  exact(value, ["version", "ready", "authorityId", "publicKeyDer", "pcId", "policyEpoch", "destinationAddress", "transferConsumed", "claimedSources", "sources"]);
  const owner = parseOwnerAuthority({ version: value.version, authorityId: value.authorityId, publicKeyDer: value.publicKeyDer });
  if (value.ready !== true || !hash(value.pcId) || !time(value.policyEpoch) || value.policyEpoch < 1 || !isMetadataAddress(value.destinationAddress)
    || typeof value.transferConsumed !== "boolean" || !Array.isArray(value.sources) || !value.sources.length || value.sources.length > GUARDIAN_MAX_SOURCES
    || !Array.isArray(value.claimedSources) || value.claimedSources.length > GUARDIAN_MAX_CLAIM_HISTORY || !value.claimedSources.every(isMetadataAddress)
    || new Set(value.claimedSources).size !== value.claimedSources.length) throw new GuardianError("invalid");
  const claimedSources = value.claimedSources as string[];
  const sources = value.sources.map(source => {
    exact(source, ["address", "containerId", "claimSpent"]);
    if (!isMetadataAddress(source.address) || !hash(source.containerId) || typeof source.claimSpent !== "boolean"
      || source.claimSpent !== claimedSources.includes(source.address)) throw new GuardianError("invalid");
    return { address: source.address, containerId: source.containerId, claimSpent: source.claimSpent };
  });
  if (new Set(sources.map(source => source.address)).size !== sources.length) throw new GuardianError("invalid");
  return { ...owner, ready: true, pcId: value.pcId, policyEpoch: value.policyEpoch, destinationAddress: value.destinationAddress,
    transferConsumed: value.transferConsumed, claimedSources: [...claimedSources], sources };
}
function syncFile(path: string, data: string): void {
  const fd = openSync(path, "wx", 0o600); try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
}
function privateRoot(directory: string): string {
  const root = resolve(directory), stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || realpathSync(root) !== root) throw new GuardianError("recovery-required");
  return root;
}
/** Local installer only. No dispatch operation can initialize or replace a pin. */
export function initializeSourceGuardian(directory: string, input: unknown): GuardianStatus {
  const enrollment = parseGuardianEnrollment(input);
  const pin: Pin = { version: 1, authorityId: enrollment.authorityId, publicKeyDer: enrollment.publicKeyDer, pcId: enrollment.pcId, sources: enrollment.sources };
  const pinText = canonicalAuthorityJson(pin);
  if (Buffer.byteLength(pinText) > GUARDIAN_MAX_PIN_BYTES) throw new GuardianError("invalid");
  const knownSources = [...new Set([...enrollment.sources.map(source => source.address), ...enrollment.claimedSources])];
  if (knownSources.length > GUARDIAN_MAX_KNOWN_SOURCES) throw new GuardianError("invalid");
  const ledger: Ledger = { version: 1, authorityId: pin.authorityId, pcId: pin.pcId, pinHash: authorityDigest(pinText),
    policyEpoch: 1, destinationAddress: enrollment.destinationAddress, transferConsumed: enrollment.transferConsumed,
    claimedSources: enrollment.claimedSources, sources: enrollment.sources, knownSources, activeId: null, operations: [] };
  const serializedLedger = boundedGuardianJson(ledger, GUARDIAN_MAX_LEDGER_BYTES);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const root = privateRoot(directory), pinPath = join(root, "owner-pin.json"), ledgerPath = join(root, "guardian.sqlite");
  if (existsSync(pinPath) || existsSync(ledgerPath)) throw new GuardianError("recovery-required");
  syncFile(pinPath, pinText); syncFile(ledgerPath, "");
  const db = new DatabaseSync(ledgerPath);
  try { db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE guardian_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)");
    db.prepare("INSERT INTO guardian_state(id,value) VALUES(1,?)").run(serializedLedger); }
  finally { db.close(); }
  const parent = openSync(root, "r"); try { fsyncSync(parent); } finally { closeSync(parent); }
  const guardian = openSourceGuardian(root); try { return guardian.status(); } finally { guardian.close(); }
}
export function openSourceGuardian(directory: string, options: { now?: () => number; executor?: GuardianExecutor } = {}) {
  const root = privateRoot(directory), pinPath = join(root, "owner-pin.json"), ledgerPath = join(root, "guardian.sqlite"), now = options.now ?? Date.now;
  for (const path of [pinPath, ledgerPath]) {
    if (!existsSync(path)) throw new GuardianError("not-enrolled");
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || realpathSync(path) !== path || stat.nlink !== 1) throw new GuardianError("recovery-required");
  }
  const pinText = readFileSync(pinPath, "utf8");
  if (Buffer.byteLength(pinText) > GUARDIAN_MAX_PIN_BYTES) throw new GuardianError("recovery-required");
  const pinValue: unknown = JSON.parse(pinText); exact(pinValue, ["version", "authorityId", "publicKeyDer", "pcId", "sources"]);
  const owner = parseOwnerAuthority({ version: pinValue.version, authorityId: pinValue.authorityId, publicKeyDer: pinValue.publicKeyDer });
  if (!hash(pinValue.pcId)) throw new GuardianError("recovery-required");
  const pin: Pin = { ...owner, pcId: pinValue.pcId, sources: normalizeSources(pinValue.sources, pinValue.pcId) };
  if (canonicalAuthorityJson(pin) !== pinText) throw new GuardianError("recovery-required");
  const db = new DatabaseSync(ledgerPath); db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL");
  let closed = false;
  const read = (): Ledger => {
    if (closed) throw new GuardianError("recovery-required");
    const row = db.prepare("SELECT value FROM guardian_state WHERE id=1").get() as { value?: unknown } | undefined;
    if (typeof row?.value !== "string" || Buffer.byteLength(row.value) > GUARDIAN_MAX_LEDGER_BYTES) throw new GuardianError("recovery-required");
    const value: unknown = JSON.parse(row.value); exact(value, ["version", "authorityId", "pcId", "pinHash", "policyEpoch", "destinationAddress", "transferConsumed", "claimedSources", "sources", "knownSources", "activeId", "operations"]);
    const sources = normalizeSources(value.sources, pin.pcId);
    if (!Array.isArray(value.knownSources) || value.knownSources.length > GUARDIAN_MAX_KNOWN_SOURCES || !value.knownSources.every(isMetadataAddress)) throw new GuardianError("recovery-required");
    const knownSources = value.knownSources as string[], known = new Set(knownSources);
    if (value.version !== 1 || value.authorityId !== pin.authorityId || value.pcId !== pin.pcId || value.pinHash !== authorityDigest(pinText)
      || !time(value.policyEpoch) || value.policyEpoch < 1 || !isMetadataAddress(value.destinationAddress) || typeof value.transferConsumed !== "boolean"
      || known.size !== knownSources.length || sources.some(source => !known.has(source.address))
      || !Array.isArray(value.claimedSources) || value.claimedSources.length > GUARDIAN_MAX_CLAIM_HISTORY || !value.claimedSources.every(address => known.has(address))
      || new Set(value.claimedSources).size !== value.claimedSources.length || value.activeId !== null && !id(value.activeId)
      || !Array.isArray(value.operations) || value.operations.length > 10_000) throw new GuardianError("recovery-required");
    for (const entry of value.operations) {
      exact(entry, ["operationId", "digest", "sourceAddress", "kind", "reply"]);
      if (!id(entry.operationId) || !hash(entry.digest) || !["transfer", "claim", "set-policy"].includes(String(entry.kind))
        || entry.sourceAddress !== null && (typeof entry.sourceAddress !== "string" || !known.has(entry.sourceAddress))) throw new GuardianError("recovery-required");
      exact(entry.reply, ["version", "operationId", "state", "result"]);
      if (entry.reply.version !== 1 || entry.reply.operationId !== entry.operationId || !["complete", "uncertain"].includes(String(entry.reply.state))) throw new GuardianError("recovery-required");
      if (entry.kind === "claim" && !value.claimedSources.includes(entry.sourceAddress) || entry.kind === "transfer" && !value.transferConsumed) throw new GuardianError("recovery-required");
    }
    if (new Set(value.operations.map(entry => (entry as Operation).operationId)).size !== value.operations.length
      || value.activeId !== null && !value.operations.some(entry => (entry as Operation).operationId === value.activeId)) throw new GuardianError("recovery-required");
    return value as unknown as Ledger;
  };
  const mutate = <T>(work: (state: Ledger) => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try { const state = read(), result = work(state); db.prepare("UPDATE guardian_state SET value=? WHERE id=1").run(boundedGuardianJson(state, GUARDIAN_MAX_LEDGER_BYTES)); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const projection = (state: Ledger): GuardianStatus => ({ version: 1, ready: true, authorityId: pin.authorityId, publicKeyDer: pin.publicKeyDer,
    pcId: pin.pcId, policyEpoch: state.policyEpoch, destinationAddress: state.destinationAddress, transferConsumed: state.transferConsumed, claimedSources: [...state.claimedSources],
    sources: state.sources.map(source => ({ address: source.address, containerId: source.binding.nodeContainerId, claimSpent: state.claimedSources.includes(source.address) })) });
  try { read(); } catch (error) { db.close(); throw error; }
  return {
    status(): GuardianStatus { return projection(read()); },
    async dispatch(envelope: OwnerSignedRequest): Promise<GuardianReply> {
      let request: GuardianRequest;
      try { request = parseGuardianRequest(verifyOwnerRequest(envelope, pin)); } catch { throw new GuardianError("owner-mismatch"); }
      const checkTime = () => { if (request.pcId !== pin.pcId || request.issuedAtMs > now() + 1000 || request.expiresAtMs <= now()) throw new GuardianError("invalid"); };
      checkTime();
      const action = request.action;
      if (action.kind === "operation-status") {
        const entry = read().operations.find(entry => entry.operationId === action.operationId);
        if (!entry || entry.sourceAddress !== action.sourceAddress || entry.kind !== action.operationKind) throw new GuardianError("invalid"); return structuredClone(entry.reply);
      }
      const digest = authorityDigest(canonicalAuthorityJson(request));
      let source: PcAssociation | undefined;
      if (action.kind !== "set-policy") {
        const quote = action.quote;
        source = read().sources.find(source => source.address === quote.sourceAddress && source.binding.nodeContainerId === quote.sourceBinding.containerId
          && source.sshFingerprint === quote.sourceBinding.sshIdentity);
        if (!source) throw new GuardianError("not-enrolled");
        if (action.kind === "transfer") {
          const quote = action.quote;
          await validatedTransferMessage(quote);
          if (quote.reserveLamports !== TREASURY_RESERVE || quote.maxCostLamports !== TREASURY_MAX_COST || BigInt(quote.feeLamports) + BigInt(quote.rentLamports) > BigInt(TREASURY_MAX_COST)
            || BigInt(quote.sourceSolLamports) - BigInt(quote.feeLamports) - BigInt(quote.rentLamports) < BigInt(TREASURY_RESERVE)) throw new GuardianError("invalid");
        } else {
          const [expected] = await findAssociatedTokenPda({ owner: address(quote.sourceAddress), mint: address(TREASURY_NOS_MINT), tokenProgram: TOKEN_PROGRAM_ADDRESS });
          if (quote.sourceTokenAddress !== expected || action.quote.checkedAtMs > now() + 15_000 || now() - action.quote.checkedAtMs >= 300_000
            || BigInt(action.quote.lastReportedAmountBaseUnits) <= 0n) throw new GuardianError("invalid");
        }
      }
      const existing = mutate(state => {
        checkTime();
        const prior = state.operations.find(entry => entry.operationId === request.operationId);
        if (prior) { if (prior.digest !== digest) throw new GuardianError("invalid"); return structuredClone(prior.reply); }
        if (state.activeId) throw new GuardianError("pending");
        if (state.operations.length >= 10_000 || action.policyEpoch !== state.policyEpoch) throw new GuardianError("stale-policy");
        if (action.kind === "set-policy") {
          state.policyEpoch++; state.destinationAddress = action.destinationAddress;
          if (action.sources) state.sources = normalizeSources(action.sources, pin.pcId);
          state.claimedSources = [...new Set([...state.claimedSources, ...(action.claimedSources ?? [])])];
          state.knownSources = [...new Set([...state.knownSources, ...state.sources.map(source => source.address), ...state.claimedSources])];
          if (state.knownSources.length > GUARDIAN_MAX_KNOWN_SOURCES || state.claimedSources.length > GUARDIAN_MAX_CLAIM_HISTORY || state.policyEpoch > Number.MAX_SAFE_INTEGER) throw new GuardianError("invalid");
          state.transferConsumed ||= action.transferConsumed === true;
          const reply: GuardianReply = { version: 1, operationId: request.operationId, state: "complete", result: projection(state) };
          state.operations.push({ operationId: request.operationId, digest, sourceAddress: null, kind: action.kind, reply }); return reply;
        }
        if (action.kind === "transfer") {
          if (state.transferConsumed || action.quote.destinationAddress !== state.destinationAddress) throw new GuardianError("spent");
          state.transferConsumed = true;
        } else {
          if (state.claimedSources.length >= GUARDIAN_MAX_CLAIM_HISTORY || state.claimedSources.includes(action.quote.sourceAddress)) throw new GuardianError("spent");
          state.claimedSources.push(action.quote.sourceAddress);
        }
        state.activeId = request.operationId;
        state.operations.push({ operationId: request.operationId, digest, sourceAddress: action.quote.sourceAddress, kind: action.kind,
          reply: { version: 1, operationId: request.operationId, state: "uncertain", result: null } });
        return null;
      });
      if (existing) return existing;
      if (action.kind === "set-policy") throw new GuardianError("invalid");
      let result: unknown = null;
      try {
        if (!options.executor || !source) throw new Error();
        const guard = () => { checkTime(); const current = read(); if (current.activeId !== request.operationId || current.policyEpoch !== action.policyEpoch) throw new GuardianError("stale-policy"); };
        guard();
        if (action.kind === "transfer") {
          const signed = await options.executor.transfer(source, action.quote, guard);
          await validateSignedTransfer(action.quote, signed.transactionBase64, signed.signature); result = signed;
        } else result = parseDispatch(await options.executor.claim(source, action.quote, guard));
      } catch { /* Reservation survives every failure. No dispatcher replay. */ }
      return mutate(state => {
        const entry = state.operations.find(entry => entry.operationId === request.operationId);
        if (!entry || state.activeId !== request.operationId) throw new GuardianError("recovery-required");
        entry.reply = { version: 1, operationId: request.operationId, state: result === null ? "uncertain" : "complete", result };
        state.activeId = null; return structuredClone(entry.reply);
      });
    },
    close(): void { if (!closed) { closed = true; db.close(); } },
  };
}
