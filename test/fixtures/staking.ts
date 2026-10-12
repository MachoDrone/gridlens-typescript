import { blankStakingRecord } from "../../src/fleet/staking.ts";
import type { StakingSnapshot } from "../../src/fleet/staking.ts";

/** Offline fixtures never invent staking balances or market targets. */
export async function emptyStaking(addresses: readonly string[]): Promise<StakingSnapshot> {
  return { hosts: addresses.map(blankStakingRecord), nextRefreshAtMs: null };
}
