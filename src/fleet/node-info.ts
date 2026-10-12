import { isMetadataAddress } from "./host-metadata.ts";

export const NODE_STATES = [
  "RUNNING_JOB", "QUEUED", "BENCHMARKING", "HEALTHCHECK", "STARTING",
  "RESTARTING", "JOINING_MARKET", "OTHER",
] as const;

/** Only the selected Node Info fields; no process, device or inventory inference. */
export interface NodeInfoValues {
  state: string | null;
  dl: number | null;
  ul: number | null;
  ping: number | null;
  networkUnavailableReason: string | null;
}

/** Independent public membership evidence; never replaces the raw Node Info fields. */
export interface NodeActivityEvidence {
  state: "RUNNING_JOB" | "QUEUED" | null;
  source: "nosana-indexer";
  checkedAtMs: number | null;
  validUntilMs: number | null;
  error: string | null;
}

export const NODE_API_ERROR_CODES = [
  "EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
  "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED",
  "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
] as const;
export type NodeApiFailureKind = "timeout" | "network" | "redirect" | "http" | "invalid-response";
export type NodeApiFailurePhase = "request" | "headers" | "body" | "validation";
export type NodeApiErrorCode = typeof NODE_API_ERROR_CODES[number];

/** One dated confirmed result; this deliberately contains no nested history. */
export interface NodeApiResult {
  status: "online" | "offline";
  checkedAtMs: number;
  firstFailedAtMs?: number;
  httpStatus?: number;
  /** Per-host retry deadline recorded with this result, never rolled forward by redisplay. */
  nextCheckAtMs?: number;
}

/** Outcome of the existing raw Node Info read, independent of activity evidence. */
export interface NodeApiCheck {
  status: "online" | "offline" | "other";
  /** Completed request time; Other may instead describe a local pending/deferral assessment. */
  checkedAtMs: number;
  /** One actual reachability failure awaits a bounded same-endpoint confirmation. */
  confirmationPending?: boolean;
  /** Original successful raw response time; never advanced by failed checks. */
  lastOnlineAtMs?: number;
  /** Earliest HTTP 503 in the current confirmation pair, never refreshed by redisplay. */
  firstFailedAtMs?: number;
  failureKind?: NodeApiFailureKind;
  httpStatus?: number;
  phase?: NodeApiFailurePhase;
  errorCode?: NodeApiErrorCode;
  lastConfirmed?: NodeApiResult;
  /** Frozen plan from this confirmed Offline result; not a shared scheduling update. */
  nextCheckAtMs?: number;
}

export interface NodeInfoRecord {
  address: string;
  values: NodeInfoValues | null;
  /** Response completion time at this preview, not the network measurement time. */
  fetchedAtMs: number | null;
  /** Local display deadline for state; not a provider freshness guarantee. */
  validUntilMs: number | null;
  retained: boolean;
  error: string | null;
  activity?: NodeActivityEvidence;
  apiCheck?: NodeApiCheck;
}

export interface NodeInfoSnapshot {
  hosts: NodeInfoRecord[];
  nextRefreshAtMs?: number | null;
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function stateText(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return value.trim() || null;
}

function nonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Match the requested host and select only state and the named network readings. */
export function normalizeNodeInfo(address: string, payload: unknown): NodeInfoValues {
  const node = object(payload);
  if (!isMetadataAddress(address) || node.node !== address) {
    throw new Error("Nosana Node Info response did not match the requested Host Address.");
  }
  const network = object(object(node.info).network);
  const dl = nonnegative(network.download_mbps);
  const ul = nonnegative(network.upload_mbps);
  const ping = nonnegative(network.ping_ms);
  // Node software initializes these exact fields to zero without measurement
  // validity or time. The triplet cannot establish a completed network test.
  const defaultNetwork = dl === 0 && ul === 0 && ping === 0;
  return {
    state: stateText(node.state),
    dl: defaultNetwork ? null : dl,
    ul: defaultNetwork ? null : ul,
    ping: defaultNetwork ? null : ping,
    networkUnavailableReason: defaultNetwork
      ? "Node Info returned default zero network readings; no measurement is established." : null,
  };
}
