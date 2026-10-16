/** Local discovery checks are not upstream heartbeats or indexer watermarks. */
export interface OnlineRosterStatus {
  revision: string | null;
  checkedAtMs: number | null;
  nextRefreshAtMs: number;
  retained: boolean;
  discoveryError: string | null;
}

export interface OnlineHostsSnapshot {
  addresses: string[];
  error: string | null;
  online: OnlineRosterStatus;
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    && value <= 8_640_000_000_000_000;
}

export function isOnlineRosterStatus(value: unknown): value is OnlineRosterStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const status = value as Record<string, unknown>;
  if ((status.revision !== null && (typeof status.revision !== "string"
    || !/^[A-Za-z0-9_-]{1,128}$/.test(status.revision)))
    || (status.checkedAtMs !== null && !timestamp(status.checkedAtMs))
    || !timestamp(status.nextRefreshAtMs) || typeof status.retained !== "boolean"
    || (status.discoveryError !== null && (typeof status.discoveryError !== "string"
      || status.discoveryError.length === 0 || status.discoveryError.length > 512
      || /[\u0000-\u001f\u007f]/.test(status.discoveryError)))) return false;
  const established = status.revision !== null;
  if (established !== (status.checkedAtMs !== null)) return false;
  if (established && status.nextRefreshAtMs < (status.checkedAtMs as number)) return false;
  if (status.retained !== (established && status.discoveryError !== null)) return false;
  return true;
}
