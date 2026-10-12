import type { QueueSnapshot } from "../../src/fleet/queue.ts";

/** Every browser harness injects a queue provider; tests never read Nosana. */
export async function emptyQueue(addresses: readonly string[]): Promise<QueueSnapshot> {
  return { hosts: addresses.map(address => ({
    address, marketAddress: null, position: null, total: null,
    checkedAtMs: null, validUntilMs: null, sourceUpdatedAtMs: null,
    retained: false, error: null,
  })) };
}
