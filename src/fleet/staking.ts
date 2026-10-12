import { isMetadataAddress } from "./host-metadata.ts";
import { NOS_MINT } from "./nos.ts";

export const STAKING_PROGRAM = "nosScmHY2uR24Zh751PmGj9ww9QRNHewh9H59AfrTJE";
export const NOSANA_JOBS_PROGRAM = "nosJhNRqr2bc9g1nfGDcXXTXvYUmxD4cVwy2pMWhrYM";
export const STAKING_REFRESH_INTERVAL_MS = 30 * 60_000;
export const STAKING_DISPLAY_VALIDITY_MS = 35 * 60_000;

export interface StakingEvidence {
  provider: string | null;
  endpoint: string | null;
  contextSlot: number | null;
  blockTimeMs: number | null;
  checkedAtMs: number | null;
  validUntilMs: number | null;
  retained: boolean;
  error: string | null;
  retryAtMs: number | null;
}
export interface StakingReading extends StakingEvidence {
  stakeAccount: string | null;
  vaultAccount: string | null;
  mint: string;
  /** Exact six-decimal NOS base units presently held by the vault. */
  amount: string | null;
  /** Stake ledger amount can exceed the remaining vault after withdrawals. */
  recordedAmount: string | null;
  xnos: string | null;
  durationSeconds: string | null;
  unstakeAtSeconds: string | null;
  accountState: "absent" | "initialized" | "frozen" | null;
}
export interface StakingRequirement extends StakingEvidence {
  marketAddress: string | null;
  /** Nosana node's displayed NOS target, using node_xnos_minimum as base units. */
  targetAmount: string | null;
  /** The on-chain requirement is duration-weighted xNOS, independently explained. */
  xnosMinimum: string | null;
}
export interface StakingRecord {
  address: string;
  stake: StakingReading;
  requirement: StakingRequirement;
  marketAddress: string | null;
  marketFetchedAtMs: number | null;
  marketRetained: boolean;
  marketError: string | null;
}
export interface StakingSnapshot { hosts: StakingRecord[]; nextRefreshAtMs: number | null }

export function blankStakingEvidence(): StakingEvidence {
  return { provider: null, endpoint: null, contextSlot: null, blockTimeMs: null, checkedAtMs: null,
    validUntilMs: null, retained: false, error: null, retryAtMs: null };
}
export function blankStakingRecord(address: string): StakingRecord {
  return { address, marketAddress: null, marketFetchedAtMs: null, marketRetained: false, marketError: null,
    stake: { ...blankStakingEvidence(), stakeAccount: null, vaultAccount: null, mint: NOS_MINT,
      amount: null, recordedAmount: null, xnos: null, durationSeconds: null, unstakeAtSeconds: null, accountState: null },
    requirement: { ...blankStakingEvidence(), marketAddress: null, targetAmount: null, xnosMinimum: null } };
}
/** u128 permits exact on-chain xNOS requirements beyond JavaScript safe integers. */
export function isStakingAmount(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d{0,38})$/.test(value) && BigInt(value) <= (1n << 128n) - 1n;
}
export function formatStakingAmount(amount: string | null | undefined, compact = true): string {
  if (!isStakingAmount(amount)) return "—";
  const units = BigInt(amount);
  if (compact) return String((units + 500_000n) / 1_000_000n);
  const fraction = String(units % 1_000_000n).padStart(6, "0").replace(/0+$/, "");
  return `${units / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}
export function compareStakingAmounts(a: string | null | undefined, b: string | null | undefined): number {
  if (!isStakingAmount(a)) return isStakingAmount(b) ? 1 : 0;
  if (!isStakingAmount(b)) return -1;
  return BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function timestamp(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000);
}
function text(value: unknown): boolean { return value === null || (typeof value === "string" && value.length <= 1024); }
function identity(value: unknown): boolean { return value === null || isMetadataAddress(value); }
function evidence(value: Record<string, unknown>, present: boolean): boolean {
  if (typeof value.retained !== "boolean" || ![value.provider, value.endpoint, value.error].every(text) ||
      ![value.blockTimeMs, value.checkedAtMs, value.validUntilMs, value.retryAtMs].every(timestamp) ||
      !(value.contextSlot === null || (typeof value.contextSlot === "number" && Number.isSafeInteger(value.contextSlot) && value.contextSlot >= 0))) return false;
  if (value.checkedAtMs === null ? value.validUntilMs !== null : value.validUntilMs !== (value.checkedAtMs as number) + STAKING_DISPLAY_VALIDITY_MS) return false;
  return !present || [value.provider, value.endpoint, value.contextSlot, value.blockTimeMs, value.checkedAtMs, value.validUntilMs].every(item => item !== null);
}
export function isStakingRecord(value: unknown): value is StakingRecord {
  if (!object(value) || !isMetadataAddress(value.address) || !identity(value.marketAddress) ||
      !timestamp(value.marketFetchedAtMs) || typeof value.marketRetained !== "boolean" || !text(value.marketError) ||
      !object(value.stake) || !object(value.requirement)) return false;
  const stake = value.stake;
  const requirement = value.requirement;
  if (stake.mint !== NOS_MINT || !identity(stake.stakeAccount) || !identity(stake.vaultAccount) ||
      ![stake.amount, stake.recordedAmount, stake.xnos, stake.durationSeconds, stake.unstakeAtSeconds].every(item => item === null || isStakingAmount(item)) ||
      ![null, "absent", "initialized", "frozen"].includes(stake.accountState as string | null) ||
      !evidence(stake, stake.amount !== null)) return false;
  if (stake.amount === null ? stake.accountState !== null :
    [stake.stakeAccount, stake.vaultAccount, stake.recordedAmount, stake.xnos, stake.durationSeconds, stake.unstakeAtSeconds, stake.accountState].some(item => item === null)) return false;
  if (stake.accountState === "absent" && [stake.amount, stake.recordedAmount, stake.xnos, stake.durationSeconds, stake.unstakeAtSeconds].some(item => item !== "0")) return false;
  if (!identity(requirement.marketAddress) || ![requirement.targetAmount, requirement.xnosMinimum].every(item => item === null || isStakingAmount(item)) ||
      requirement.targetAmount !== requirement.xnosMinimum || !evidence(requirement, requirement.targetAmount !== null)) return false;
  return requirement.targetAmount === null || requirement.marketAddress !== null;
}
