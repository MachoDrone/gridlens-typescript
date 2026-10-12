import type { JobSnapshot } from "../../src/fleet/jobs.ts";

/** All preview harnesses inject this unless they explicitly test job readings. */
export async function emptyJobs(addresses: readonly string[]): Promise<JobSnapshot> {
  return { hosts: addresses.map(address => ({
    address, job: null, checkedAtMs: null, validUntilMs: null, failedAtMs: null,
    retained: false, pending: false, retryAtMs: null, error: null,
  })) };
}
