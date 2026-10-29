import { isFleetRoster } from "../contracts/fleet.ts";
import { JOB_HISTORY_REQUEST_LIMIT } from "../fleet/job-history.ts";

/** Selection narrows a server-owned roster; it never establishes authorization. */
export function selectJobHistoryHosts(parameters: URLSearchParams, roster: readonly string[],
  additionalParameters: readonly string[] = []): { addresses: string[]; refresh: boolean } {
  const permitted = new Set(["host", "refresh", ...additionalParameters]);
  const addresses = parameters.getAll("host");
  const refresh = parameters.getAll("refresh");
  const allowed = new Set(roster);
  if ([...parameters.keys()].some(key => !permitted.has(key)) ||
      addresses.length === 0 || addresses.length > JOB_HISTORY_REQUEST_LIMIT ||
      !isFleetRoster(addresses) || addresses.some(address => !allowed.has(address)) ||
      refresh.length > 1 || refresh.length === 1 && refresh[0] !== "1") {
    throw new Error("Choose between one and 100 distinct hosts from the current Fleet roster.");
  }
  return { addresses, refresh: refresh.length === 1 };
}
