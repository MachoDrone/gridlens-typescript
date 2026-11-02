/** Browser-safe Wallet protocol. Signed transactions, password verifiers and SSH
 * bindings never enter this public contract. Amounts are exact integer strings. */
import { isMetadataAddress } from "../fleet/host-metadata.ts";

export const TREASURY_AMOUNT = "1000000" as const;
export const TREASURY_RESERVE = "50000000" as const;
export const TREASURY_MAX_COST = "5000000" as const;
export const TREASURY_PHASES = ["authorized", "signed", "submission-started", "confirmed", "failed", "uncertain", "cancelled"] as const;
export type TreasuryPhase = typeof TREASURY_PHASES[number];
export interface TreasuryStatus {
  version: 1; supported: boolean; state: "setup-required" | "locked" | "unlocked" | "recovery-required";
  pilotConsumed: boolean; serverId: string; scopeId: string; revision: number;
}
export interface TreasuryConfiguration {
  version: 1; revision: number; destinationAddress: string; hosts: { address: string; label: string }[];
  amountBaseUnits: typeof TREASURY_AMOUNT; reserveLamports: typeof TREASURY_RESERVE;
  maxCostLamports: typeof TREASURY_MAX_COST; pilotConsumed: boolean;
}
export interface TreasuryPublicQuote {
  sourceAddress: string; destinationAddress: string; sourceTokenAddress: string; destinationTokenAddress: string; mintAddress: string;
  amountBaseUnits: typeof TREASURY_AMOUNT; decimals: 6; feeLamports: string; rentLamports: string;
  reserveLamports: typeof TREASURY_RESERVE; maxCostLamports: typeof TREASURY_MAX_COST;
  preparedAtMs: number; expiresAtMs: number; createDestinationAta: boolean; sourceNosBaseUnits: string; sourceSolLamports: string;
}
export interface TreasuryPlan {
  version: 1; planId: string; reviewDigest: string; expiresAtMs: number; quote: TreasuryPublicQuote;
}
export interface TreasuryOperation {
  id: string; phase: TreasuryPhase; sourceAddress: string; destinationAddress: string; amountBaseUnits: typeof TREASURY_AMOUNT;
  signature: string | null; startedAtMs: number; updatedAtMs: number; confirmedAtMs: number | null; slot: number | null; error: string | null;
}
export interface TreasuryUnlock {
  version: 1; unlockToken: string; expiresAtMs: number; configuration: TreasuryConfiguration;
}
/** This rejected request has not authorized signing or consumed a pilot allowance.
 * No upstream text, account details or transport URLs are permitted here. */
export const TREASURY_PREFLIGHT_CODES = ["budget-wait", "provider-unavailable", "insufficient-nos", "insufficient-sol-reserve", "cost-limit",
  "account-invalid", "source-changed", "review-expired", "preflight-unavailable"] as const;
export type TreasuryPreflightCode = typeof TREASURY_PREFLIGHT_CODES[number];
export interface TreasuryPreflightFailure {
  version: 1; kind: "preflight-failure"; code: TreasuryPreflightCode;
  /** Earliest known retry eligibility, never a recovery or completion promise. */
  retryAtMs?: number;
}
export function parseTreasuryPreflightFailure(value: unknown): TreasuryPreflightFailure {
  if (!object(value) || value.version !== 1 || value.kind !== "preflight-failure"
    || !(TREASURY_PREFLIGHT_CODES as readonly unknown[]).includes(value.code)
    || Object.keys(value).some(key => !["version", "kind", "code", "retryAtMs"].includes(key))
    || value.retryAtMs !== undefined && (!integer(value.retryAtMs) || value.retryAtMs < 1 || value.retryAtMs > 8_640_000_000_000_000
      || value.code !== "budget-wait" && value.code !== "provider-unavailable")) throw new Error("Invalid Wallet preflight failure.");
  return { version: 1, kind: "preflight-failure", code: value.code as TreasuryPreflightCode,
    ...(value.retryAtMs === undefined ? {} : { retryAtMs: value.retryAtMs as number }) };
}
export function treasuryPreflightStatus(code: TreasuryPreflightCode): 409 | 429 | 503 {
  if (!(TREASURY_PREFLIGHT_CODES as readonly unknown[]).includes(code)) throw new Error("Invalid Wallet preflight code.");
  return code === "budget-wait" ? 429 : code === "provider-unavailable" || code === "preflight-unavailable" ? 503 : 409;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const text = (value: unknown, maximum = 256): value is string => typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
const amount = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value);
export function parseTreasuryStatus(value: unknown): TreasuryStatus {
  if (!object(value) || value.version !== 1 || typeof value.supported !== "boolean" || typeof value.pilotConsumed !== "boolean"
    || !["setup-required", "locked", "unlocked", "recovery-required"].includes(String(value.state))
    || !text(value.serverId) || !text(value.scopeId) || !integer(value.revision)) throw new Error("Invalid Wallet status.");
  return { version: 1, supported: value.supported, state: value.state as TreasuryStatus["state"], pilotConsumed: value.pilotConsumed,
    serverId: value.serverId, scopeId: value.scopeId, revision: value.revision };
}
export function parseTreasuryConfiguration(value: unknown): TreasuryConfiguration {
  if (!object(value) || value.version !== 1 || !integer(value.revision) || !isMetadataAddress(value.destinationAddress)
    || value.amountBaseUnits !== TREASURY_AMOUNT || value.reserveLamports !== TREASURY_RESERVE || value.maxCostLamports !== TREASURY_MAX_COST
    || typeof value.pilotConsumed !== "boolean" || !Array.isArray(value.hosts) || value.hosts.length > 10_000
    || value.hosts.some(row => !object(row) || !isMetadataAddress(row.address) || !text(row.label, 256))
    || new Set(value.hosts.map(row => (row as { address: string }).address)).size !== value.hosts.length) throw new Error("Invalid Wallet configuration.");
  return { version: 1, revision: value.revision, destinationAddress: value.destinationAddress,
    hosts: value.hosts.map(row => ({ address: (row as { address: string }).address, label: (row as { label: string }).label })),
    amountBaseUnits: TREASURY_AMOUNT, reserveLamports: TREASURY_RESERVE, maxCostLamports: TREASURY_MAX_COST, pilotConsumed: value.pilotConsumed };
}
export function parseTreasuryQuote(value: unknown): TreasuryPublicQuote {
  if (!object(value) || ![value.sourceAddress, value.destinationAddress, value.sourceTokenAddress, value.destinationTokenAddress, value.mintAddress].every(isMetadataAddress)
    || value.sourceAddress === value.destinationAddress || value.amountBaseUnits !== TREASURY_AMOUNT || value.decimals !== 6
    || !amount(value.feeLamports) || !amount(value.rentLamports) || BigInt(value.feeLamports) + BigInt(value.rentLamports) > BigInt(TREASURY_MAX_COST)
    || value.reserveLamports !== TREASURY_RESERVE || value.maxCostLamports !== TREASURY_MAX_COST
    || typeof value.createDestinationAta !== "boolean" || !amount(value.sourceNosBaseUnits) || !amount(value.sourceSolLamports)
    || BigInt(value.sourceNosBaseUnits) < BigInt(TREASURY_AMOUNT)
    || BigInt(value.sourceSolLamports) - BigInt(value.feeLamports) - BigInt(value.rentLamports) < BigInt(TREASURY_RESERVE)
    || !integer(value.preparedAtMs) || !integer(value.expiresAtMs) || value.expiresAtMs <= value.preparedAtMs
    || value.expiresAtMs - value.preparedAtMs > 300_000) throw new Error("Invalid Wallet review.");
  return { sourceAddress: value.sourceAddress as string, destinationAddress: value.destinationAddress as string,
    sourceTokenAddress: value.sourceTokenAddress as string, destinationTokenAddress: value.destinationTokenAddress as string,
    mintAddress: value.mintAddress as string, amountBaseUnits: TREASURY_AMOUNT, decimals: 6, feeLamports: value.feeLamports, rentLamports: value.rentLamports,
    reserveLamports: TREASURY_RESERVE, maxCostLamports: TREASURY_MAX_COST, preparedAtMs: value.preparedAtMs, expiresAtMs: value.expiresAtMs,
    createDestinationAta: value.createDestinationAta, sourceNosBaseUnits: value.sourceNosBaseUnits, sourceSolLamports: value.sourceSolLamports };
}
export function parseTreasuryPlan(value: unknown): TreasuryPlan {
  if (!object(value) || value.version !== 1 || !text(value.planId, 80) || typeof value.reviewDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.reviewDigest)
    || !integer(value.expiresAtMs)) throw new Error("Invalid Wallet plan.");
  const quote = parseTreasuryQuote(value.quote);
  if (quote.expiresAtMs !== value.expiresAtMs) throw new Error("Invalid Wallet plan expiry.");
  return { version: 1, planId: value.planId, reviewDigest: value.reviewDigest, expiresAtMs: value.expiresAtMs, quote };
}
export function parseTreasuryOperation(value: unknown): TreasuryOperation {
  if (!object(value) || !text(value.id, 80) || !(TREASURY_PHASES as readonly unknown[]).includes(value.phase)
    || !isMetadataAddress(value.sourceAddress) || !isMetadataAddress(value.destinationAddress) || value.amountBaseUnits !== TREASURY_AMOUNT
    || value.signature !== null && (typeof value.signature !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value.signature))
    || !integer(value.startedAtMs) || !integer(value.updatedAtMs) || value.updatedAtMs < value.startedAtMs
    || value.confirmedAtMs !== null && !integer(value.confirmedAtMs) || value.slot !== null && !integer(value.slot)
    || value.error !== null && !text(value.error, 500)) throw new Error("Invalid Wallet operation.");
  if (value.phase === "confirmed" && (value.signature === null || value.confirmedAtMs === null || value.slot === null)) throw new Error("Unverified Wallet receipt.");
  return { id: value.id, phase: value.phase as TreasuryPhase, sourceAddress: value.sourceAddress, destinationAddress: value.destinationAddress,
    amountBaseUnits: TREASURY_AMOUNT, signature: value.signature as string | null, startedAtMs: value.startedAtMs, updatedAtMs: value.updatedAtMs,
    confirmedAtMs: value.confirmedAtMs as number | null, slot: value.slot as number | null, error: value.error as string | null };
}
export function parseTreasuryUnlock(value: unknown): TreasuryUnlock {
  if (!object(value) || value.version !== 1 || typeof value.unlockToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.unlockToken)
    || !integer(value.expiresAtMs)) throw new Error("Invalid Wallet unlock.");
  return { version: 1, unlockToken: value.unlockToken, expiresAtMs: value.expiresAtMs, configuration: parseTreasuryConfiguration(value.configuration) };
}
