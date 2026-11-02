/** Public owner-only reward-claim protocol. A claim pays its source host's NOS
 * account. It never forwards to the separate consolidation address. */
import { isMetadataAddress } from "../fleet/host-metadata.ts";
import { NOS_MINT } from "../fleet/nos.ts";

export const CLAIM_PHASES = ["authorized", "dispatch-started", "verifying", "needs-verification", "confirmed", "failed", "cancelled"] as const;
export type TreasuryClaimPhase = typeof CLAIM_PHASES[number];
export interface TreasuryClaimsStatus {
  version: 1; supported: boolean; state: "ready" | "recovery-required";
  unresolvedOperationId: string | null; attemptedHosts: string[]; eligibleHosts: { address: string; label: string }[];
}
export interface TreasuryClaimQuote {
  sourceAddress: string; payoutOwner: string; payoutTokenAddress: string; mintAddress: string; decimals: 6;
  amountMode: "full-available"; lastReportedAmountBaseUnits: string; checkedAtMs: number; expiresAtMs: number;
}
export interface TreasuryClaimPlan { version: 1; planId: string; reviewDigest: string; expiresAtMs: number; quote: TreasuryClaimQuote }
export interface TreasuryClaimOperation {
  id: string; phase: TreasuryClaimPhase; sourceAddress: string; payoutOwner: string; payoutTokenAddress: string;
  lastReportedAmountBaseUnits: string; paidAmountBaseUnits: string | null; signature: string | null;
  startedAtMs: number; updatedAtMs: number; confirmedAtMs: number | null; slot: number | null; error: string | null;
}
export const claimUnresolved = (phase: TreasuryClaimPhase): boolean => !["confirmed", "failed", "cancelled"].includes(phase);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 8_640_000_000_000_000;
const text = (value: unknown, max = 256): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
export const claimAmount = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n;
export function claimSignature(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value)) return false;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = 0n, bytes = 0;
  for (const character of value) number = number * 58n + BigInt(alphabet.indexOf(character));
  while (number > 0n) { bytes++; number >>= 8n; }
  for (const character of value) { if (character !== "1") break; bytes++; }
  return bytes === 64;
}
function fields(value: unknown, names: readonly string[]): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).length !== names.length || Object.keys(value).some(key => !names.includes(key))) throw new Error("Invalid reward-claim fields.");
}
export function parseClaimsStatus(value: unknown): TreasuryClaimsStatus {
  fields(value, ["version", "supported", "state", "unresolvedOperationId", "attemptedHosts", "eligibleHosts"]);
  if (value.version !== 1 || typeof value.supported !== "boolean" || !["ready", "recovery-required"].includes(String(value.state))
    || value.unresolvedOperationId !== null && !text(value.unresolvedOperationId, 80) || !Array.isArray(value.attemptedHosts) || value.attemptedHosts.length > 10_000
    || value.attemptedHosts.some(row => !isMetadataAddress(row)) || new Set(value.attemptedHosts).size !== value.attemptedHosts.length
    || !Array.isArray(value.eligibleHosts) || value.eligibleHosts.length > 10_000 || value.eligibleHosts.some(row => !record(row)
      || Object.keys(row).length !== 2 || !isMetadataAddress(row.address) || !text(row.label) || (value.attemptedHosts as unknown[]).includes(row.address))
    || new Set(value.eligibleHosts.map(row => (row as { address: string }).address)).size !== value.eligibleHosts.length
    || value.supported !== (value.state === "ready") || !value.supported && value.eligibleHosts.length) throw new Error("Invalid reward-claim status.");
  return { version: 1, supported: value.supported, state: value.state as TreasuryClaimsStatus["state"], unresolvedOperationId: value.unresolvedOperationId as string | null,
    attemptedHosts: [...value.attemptedHosts] as string[], eligibleHosts: value.eligibleHosts.map(row => ({ address: row.address as string, label: row.label as string })) };
}
export function parseClaimsQuote(value: unknown): TreasuryClaimQuote {
  fields(value, ["sourceAddress", "payoutOwner", "payoutTokenAddress", "mintAddress", "decimals", "amountMode", "lastReportedAmountBaseUnits", "checkedAtMs", "expiresAtMs"]);
  if (!isMetadataAddress(value.sourceAddress) || value.payoutOwner !== value.sourceAddress || !isMetadataAddress(value.payoutTokenAddress)
    || value.mintAddress !== NOS_MINT || value.decimals !== 6 || value.amountMode !== "full-available" || !claimAmount(value.lastReportedAmountBaseUnits)
    || !time(value.checkedAtMs) || !time(value.expiresAtMs) || value.expiresAtMs <= value.checkedAtMs || value.expiresAtMs - value.checkedAtMs > 420_000)
    throw new Error("Invalid full-host reward-claim review.");
  return { sourceAddress: value.sourceAddress, payoutOwner: value.payoutOwner, payoutTokenAddress: value.payoutTokenAddress,
    mintAddress: NOS_MINT, decimals: 6, amountMode: "full-available", lastReportedAmountBaseUnits: value.lastReportedAmountBaseUnits,
    checkedAtMs: value.checkedAtMs, expiresAtMs: value.expiresAtMs };
}
export function parseClaimsPlan(value: unknown): TreasuryClaimPlan {
  fields(value, ["version", "planId", "reviewDigest", "expiresAtMs", "quote"]);
  if (value.version !== 1 || !text(value.planId, 80) || typeof value.reviewDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.reviewDigest) || !time(value.expiresAtMs))
    throw new Error("Invalid reward-claim plan.");
  const quote = parseClaimsQuote(value.quote);
  if (quote.expiresAtMs !== value.expiresAtMs) throw new Error("Reward-claim review expiry changed.");
  return { version: 1, planId: value.planId, reviewDigest: value.reviewDigest, expiresAtMs: value.expiresAtMs, quote };
}
export function parseClaimsOperation(value: unknown): TreasuryClaimOperation {
  fields(value, ["id", "phase", "sourceAddress", "payoutOwner", "payoutTokenAddress", "lastReportedAmountBaseUnits", "paidAmountBaseUnits", "signature",
    "startedAtMs", "updatedAtMs", "confirmedAtMs", "slot", "error"]);
  if (!text(value.id, 80) || !(CLAIM_PHASES as readonly unknown[]).includes(value.phase) || !isMetadataAddress(value.sourceAddress)
    || value.payoutOwner !== value.sourceAddress || !isMetadataAddress(value.payoutTokenAddress) || !claimAmount(value.lastReportedAmountBaseUnits)
    || value.paidAmountBaseUnits !== null && !claimAmount(value.paidAmountBaseUnits) || value.signature !== null && !claimSignature(value.signature)
    || !time(value.startedAtMs) || !time(value.updatedAtMs) || value.updatedAtMs < value.startedAtMs || value.confirmedAtMs !== null && !time(value.confirmedAtMs)
    || value.slot !== null && (!time(value.slot) || value.slot === 0) || value.error !== null && !text(value.error, 500)
    || value.phase === "confirmed" && (value.paidAmountBaseUnits === null || value.signature === null || value.confirmedAtMs === null || value.slot === null))
    throw new Error("Invalid reward-claim operation.");
  return { id: value.id, phase: value.phase as TreasuryClaimPhase, sourceAddress: value.sourceAddress, payoutOwner: value.payoutOwner,
    payoutTokenAddress: value.payoutTokenAddress, lastReportedAmountBaseUnits: value.lastReportedAmountBaseUnits,
    paidAmountBaseUnits: value.paidAmountBaseUnits as string | null, signature: value.signature as string | null, startedAtMs: value.startedAtMs,
    updatedAtMs: value.updatedAtMs, confirmedAtMs: value.confirmedAtMs as number | null, slot: value.slot as number | null, error: value.error as string | null };
}
