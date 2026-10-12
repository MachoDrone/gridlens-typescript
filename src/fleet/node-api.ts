import type { NodeInfoRecord } from "./node-info.ts";

export interface NodeApiView {
  status: "Online" | "Offline" | "Unknown";
  label: "Online" | "Offline" | "Populating..";
  current: boolean;
  checkedAtMs: number | null;
  description: string;
  expiresAtMs: number | null;
}

const displayValidityMs = 30_000;
const maximumRetryWindowMs = 15 * 60_000;
const completionAllowanceMs = 8_000;
const meaning = "API reachability and the node's reported State are separate. A State OTHER response can establish API Online. This does not establish physical machine health or job activity.";

function validTime(value: unknown, nowMs: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    && value <= nowMs && value <= 8_640_000_000_000_000 - displayValidityMs;
}

const timestamp = (value: number): string => new Date(value).toISOString();

interface Proof {
  status: string;
  checkedAtMs: number;
  firstFailedAtMs?: number;
  httpStatus?: number;
  failureKind?: string;
  nextCheckAtMs?: number;
}

interface KnownResult {
  status: "Online" | "Offline";
  checkedAtMs: number;
  deadline: number;
  firstFailedAtMs?: number;
  nextCheckAtMs?: number;
  followsRetrySchedule?: boolean;
}

/** Validate the original evidence separately from whether it is still current. */
function knownResult(proof: Proof | undefined, nowMs: number): KnownResult | null {
  if (!proof || !validTime(proof.checkedAtMs, nowMs)) return null;
  if (proof.status === "online") return { status: "Online", checkedAtMs: proof.checkedAtMs,
    deadline: proof.checkedAtMs + displayValidityMs };
  if (proof.status !== "offline" || proof.httpStatus !== undefined && proof.httpStatus !== 503 ||
      proof.failureKind !== undefined && proof.failureKind !== "http") return null;
  const first = proof.firstFailedAtMs;
  if (first !== undefined && (!validTime(first, nowMs) || first > proof.checkedAtMs ||
      proof.checkedAtMs >= first + displayValidityMs)) return null;
  const next = proof.nextCheckAtMs;
  const scheduleValid = typeof next === "number" && Number.isSafeInteger(next)
    && next > proof.checkedAtMs && next <= 8_640_000_000_000_000 - completionAllowanceMs;
  const followsRetrySchedule = scheduleValid && next <= proof.checkedAtMs + maximumRetryWindowMs;
  return { status: "Offline", checkedAtMs: proof.checkedAtMs,
    deadline: followsRetrySchedule ? next + completionAllowanceMs : (first ?? proof.checkedAtMs) + displayValidityMs,
    followsRetrySchedule,
    ...(scheduleValid ? { nextCheckAtMs: next } : {}),
    ...(first === undefined ? {} : { firstFailedAtMs: first }) };
}

/** Preserve a confirmed result without presenting its old evidence as current. */
export function projectNodeApi(
  record: NodeInfoRecord | undefined, nowMs: number, connectionError: string | null = null,
): NodeApiView {
  const check = record?.apiCheck;
  let latest: KnownResult | null = null;
  let previous: KnownResult | null = null;
  let usableLatest = false;
  let reason = "No node API result has been established.";
  let diagnostic = "";
  if (check) {
    latest = knownResult(check, nowMs);
    previous = knownResult(check.lastConfirmed, nowMs);
    const assessmentValid = validTime(check.checkedAtMs, nowMs);
    if (check.confirmationPending === true && assessmentValid && validTime(check.lastOnlineAtMs, nowMs)
      && check.lastOnlineAtMs <= check.checkedAtMs) {
      const online = knownResult({ status: "online", checkedAtMs: check.lastOnlineAtMs }, nowMs)!;
      if (!previous || online.checkedAtMs > previous.checkedAtMs) previous = online;
    }
    usableLatest = latest !== null;
    reason = !assessmentValid ? "The supplied API assessment time is invalid or in the future."
      : check.confirmationPending ? `A failed attempt at ${timestamp(check.checkedAtMs)} is awaiting confirmation.`
      : latest ? `The last confirmed check was at ${timestamp(latest.checkedAtMs)}.`
      : `The attempt at ${timestamp(check.checkedAtMs)} did not establish a new API result.`;
    if (check.status !== "online" && record?.error) reason += ` ${record.error}`;
    diagnostic = [check.failureKind && `Failure type: ${check.failureKind}`, check.httpStatus && `HTTP ${check.httpStatus}`,
      check.phase && `Request stage: ${check.phase}`, check.errorCode && `Error code: ${check.errorCode}`].filter(Boolean).join(". ");
  } else if (record?.values && validTime(record.fetchedAtMs, nowMs) &&
      typeof record.validUntilMs === "number" && Number.isSafeInteger(record.validUntilMs) && record.validUntilMs > record.fetchedAtMs) {
    latest = { status: "Online", checkedAtMs: record.fetchedAtMs,
      deadline: Math.min(record.validUntilMs, record.fetchedAtMs + displayValidityMs) };
    usableLatest = !record.retained && !record.error;
    reason = record.error ? `The latest check could not be completed. ${record.error}`
      : record.retained ? "Only a retained Node Info response is available." : "The node returned a validated response.";
  } else if (record?.error) reason = `No dated confirmed API result is available. ${record.error}`;

  const selected = previous && (!latest || previous.checkedAtMs > latest.checkedAtMs) ? previous : latest ?? previous;
  const pendingOnline = check?.confirmationPending === true && validTime(check.checkedAtMs, nowMs)
    && selected?.status === "Online" && selected.checkedAtMs <= check.checkedAtMs;
  // An on-time Service Unavailable response is consistent with the previous
  // Offline result while its confirmation finishes inside the original allowance.
  const pendingOffline = check?.confirmationPending === true && validTime(check.checkedAtMs, nowMs)
    && check.failureKind === "http" && check.httpStatus === 503 && selected?.status === "Offline"
    && selected.followsRetrySchedule === true && selected.checkedAtMs <= check.checkedAtMs;
  const current = selected !== null && !connectionError && nowMs < selected.deadline &&
    (selected === latest && usableLatest || pendingOnline || pendingOffline);
  if (connectionError) reason = `The preview connection is unavailable. ${connectionError}`;
  const diagnostics = diagnostic ? `\n${diagnostic}.` : "";
  if (!selected) return { status: "Unknown", label: "Populating..", current: false, checkedAtMs: null, expiresAtMs: null,
    description: `API Populating.. No confirmed result is available. ${reason}${diagnostics}\n\n${meaning}` };

  const checked = timestamp(selected.checkedAtMs);
  const first = selected.firstFailedAtMs === undefined ? "" : ` First Service Unavailable response: ${timestamp(selected.firstFailedAtMs)}.`;
  const status = current ? `API ${selected.status}. Last confirmed check: ${checked}.${first}`
    : `Last confirmed API result: ${selected.status} at ${checked}.${first} Retained in regular weight; current API reachability is unknown.`;
  const freshness = selected.followsRetrySchedule
    ? `Next scheduled check: ${timestamp(selected.nextCheckAtMs!)}. The result becomes stale if that recheck has not completed by ${timestamp(selected.deadline)} (eight-second request allowance). The original confirmation time is unchanged.`
    : `${nowMs >= selected.deadline ? "The original check expired" : "Original check validity ends"} at ${timestamp(selected.deadline)}; retries and rendering never renew its time.${selected.nextCheckAtMs === undefined ? "" : ` Next retry: ${timestamp(selected.nextCheckAtMs)}. This extended pause exceeds the normal fifteen-minute retry window, so it does not prolong bold emphasis.`}`;
  return { status: selected.status, label: selected.status, current, checkedAtMs: selected.checkedAtMs,
    expiresAtMs: current ? selected.deadline : null,
    description: `${status}\n${freshness}\n${reason}${diagnostics}\n\n${meaning}` };
}

/** Remove bold emphasis when its freshness window ends, even if State is already unknown. */
export function nextApiExpiryDelay(records: readonly NodeInfoRecord[], projectedAtMs: number, nowMs: number): number | null {
  const deadlines = records.flatMap(record => {
    const view = projectNodeApi(record, projectedAtMs);
    return view.expiresAtMs !== null ? [view.expiresAtMs] : [];
  });
  return deadlines.length ? Math.max(1, Math.min(...deadlines) - nowMs + 1) : null;
}
