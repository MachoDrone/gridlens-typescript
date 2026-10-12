import { NOS_MINT } from "../../src/fleet/nos.ts";
import type { NosSnapshot } from "../../src/fleet/nos.ts";

/** Offline only: unconnected balances never become invented zeroes. */
export async function emptyNos(addresses: readonly string[]): Promise<NosSnapshot> {
  return { hosts: addresses.map(address => ({
    address, tokenAccount: null, mint: NOS_MINT, amount: null, decimals: 6,
    accountState: null, provider: null, endpoint: null, contextSlot: null,
    blockTimeMs: null, checkedAtMs: null, validUntilMs: null, retained: false,
    error: null, retryAtMs: null,
  })), nextRefreshAtMs: null };
}
