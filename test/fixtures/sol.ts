import type { SolSnapshot } from "../../src/fleet/sol.ts";

/** Offline only: unconnected balances never become invented zeroes. */
export async function emptySol(addresses: readonly string[]): Promise<SolSnapshot> {
  return { hosts: addresses.map(address => ({
    address, lamports: null, provider: null, endpoint: null, contextSlot: null,
    blockTimeMs: null, checkedAtMs: null, validUntilMs: null, retained: false,
    error: null, retryAtMs: null,
  })), nextRefreshAtMs: null };
}
