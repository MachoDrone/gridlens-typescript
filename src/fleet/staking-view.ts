import type { HostMetadataRecord } from "./host-metadata.ts";
import { STAKING_DISPLAY_VALIDITY_MS } from "./staking.ts";
import type { StakingRecord } from "./staking.ts";

/** The existing metadata cache defines how long an assignment supports a comparison. */
export const STAKING_MARKET_VALIDITY_MS = 300_000;

export interface StakingView {
  amount: string | null;
  target: string | null;
  marketAddress: string | null;
  amountCurrent: boolean;
  targetCurrent: boolean;
  marketCurrent: boolean;
  comparisonCurrent: boolean;
  satisfied: boolean;
  nextExpiryAtMs: number | null;
}

/** Keep vault amount and market-target freshness independent. A changed market
 * immediately hides the previous denominator, without discarding a valid vault read. */
export function projectStaking(
  record: StakingRecord | undefined,
  metadata: HostMetadataRecord | undefined,
  nowMs: number,
  connectionError: string | null = null,
  metadataError: string | null = null,
  freshnessAtMs = nowMs,
): StakingView {
  const expiryAtMs = Math.max(nowMs, freshnessAtMs);
  const marketAddress = metadata === undefined ? record?.marketAddress ?? null : metadata.values?.marketAddress ?? null;
  const fetchedAtMs = metadata === undefined ? record?.marketFetchedAtMs ?? null : metadata.fetchedAtMs;
  const marketRetained = metadata === undefined ? record?.marketRetained !== false : metadata.retained;
  const marketError = metadata === undefined ? record?.marketError ?? null : metadata.error;
  const marketDeadline = fetchedAtMs === null ? null : fetchedAtMs + STAKING_MARKET_VALIDITY_MS;
  const marketCurrent = marketAddress !== null && fetchedAtMs !== null && fetchedAtMs <= nowMs + 15_000 &&
    marketDeadline !== null && expiryAtMs < marketDeadline && !marketRetained && marketError === null && metadataError === null;
  const amount = record?.stake.amount ?? null;
  const target = marketAddress !== null && record?.requirement.marketAddress === marketAddress
    ? record.requirement.targetAmount : null;
  const deadline = (reading: StakingRecord["stake"] | StakingRecord["requirement"] | undefined): number | null =>
    reading?.checkedAtMs == null || reading.validUntilMs === null ? null
      : Math.min(reading.validUntilMs, reading.checkedAtMs + STAKING_DISPLAY_VALIDITY_MS);
  const current = (reading: StakingRecord["stake"] | StakingRecord["requirement"] | undefined): boolean => {
    const until = deadline(reading);
    return reading !== undefined && reading.checkedAtMs !== null && reading.checkedAtMs <= nowMs + 15_000 &&
      until !== null && expiryAtMs < until && !reading.retained && reading.error === null && connectionError === null;
  };
  const amountCurrent = amount !== null && current(record?.stake);
  const targetCurrent = target !== null && current(record?.requirement) && marketCurrent;
  const comparisonCurrent = amountCurrent && targetCurrent;
  const deadlines = [amountCurrent ? deadline(record?.stake) : null,
    targetCurrent ? deadline(record?.requirement) : null, marketCurrent ? marketDeadline : null]
    .filter((value): value is number => value !== null && value > expiryAtMs);
  return { amount, target, marketAddress, amountCurrent, targetCurrent, marketCurrent, comparisonCurrent,
    satisfied: comparisonCurrent && BigInt(amount!) >= BigInt(target!),
    nextExpiryAtMs: deadlines.length > 0 ? Math.min(...deadlines) : null };
}
