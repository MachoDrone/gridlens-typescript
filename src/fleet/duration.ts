// Presentation follows the user-supplied Nosana Fleet reference. This is an
// internal view model, not a backend contract, collection policy or wire format.

export type DurationDisplayMode = "bar" | "text";

/** Presentation grace only; never extend the job limit or evidence deadline. */
export const DURATION_OVERRUN_GRACE_SECONDS = 5 * 60;
export const DURATION_OVERRUN_GRACE_NOTE = "Red warnings begin more than 5 minutes past the reported limit; the limit itself is unchanged.";

/** Both projections pass validated elapsed time and a positive limit or null. */
export function isDurationOverrun(elapsedSeconds: number, limitSeconds: number | null): boolean {
  return limitSeconds !== null && elapsedSeconds - limitSeconds > DURATION_OVERRUN_GRACE_SECONDS;
}

interface DurationEvidence {
  readonly observedAtMs: number | null;
  readonly freshUntilMs: number | null;
  readonly stale: boolean;
}

export interface DurationReading extends DurationEvidence {
  readonly jobId: string;
  readonly elapsedSeconds: number | null;
  readonly limitSeconds: number | null;
}

export interface DurationActivity extends DurationEvidence {
  readonly state: "running" | "queued" | "completed" | "idle" | "unknown";
  readonly jobId: string | null;
  /** Internal normalized format: positive integer or position/total; no verified provider contract yet. */
  readonly queuePosition: string | null;
}

export interface DurationInput {
  readonly displayedJobId: string | null;
  readonly reading: DurationReading | null;
  readonly activity: DurationActivity | null;
}

export interface DurationView {
  readonly kind: "unknown" | "queue" | "duration";
  readonly text: string;
  readonly description: string;
  readonly elapsedSeconds: number | null;
  readonly limitSeconds: number | null;
  readonly percent: number | null;
  /** Evidence freshness is independent of elapsed-time color or motion. */
  readonly freshness: "current" | "retained" | "unknown";
  readonly tone: "current" | "exceeded" | "retained" | "unbounded";
  readonly animated: boolean;
  /** Validated original live evidence deadline; presentation never renews it. */
  readonly validUntilMs?: number | null;
  /** Presentation only; API reachability does not establish job absence. */
  readonly unavailableReason?: "api-offline";
}

export function normalizeDurationMode(value: unknown): DurationDisplayMode {
  return value === "text" ? "text" : "bar";
}

export function nextDurationMode(mode: DurationDisplayMode): DurationDisplayMode {
  return mode === "bar" ? "text" : "bar";
}

function validSeconds(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

/** Compact reference formatting; zero units are omitted except for zero itself. */
export function formatDurationSeconds(seconds: number): string {
  if (!validSeconds(seconds)) throw new RangeError("Duration must be finite, non-negative safe seconds");
  const total = Math.floor(seconds);
  if (total < 60) return `${total}s`;
  if (total < 3_600) {
    const minutes = Math.floor(total / 60);
    const remainder = total % 60;
    return `${minutes}m${remainder > 0 ? ` ${remainder}s` : ""}`;
  }
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  return [days > 0 ? `${days}d` : "", hours > 0 ? `${hours}h` : "", minutes > 0 ? `${minutes}m` : ""]
    .filter(Boolean).join(" ");
}

function validTimestamp(value: number | null): value is number {
  // Date's representable range is narrower than JavaScript's safe integers.
  return value !== null && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
}

function validQueuePosition(value: string | null): string | null {
  const position = value?.trim() ?? "";
  if (!/^[1-9]\d*(?:\/[1-9]\d*)?$/.test(position)) return null;
  const [positionText, totalText] = position.split("/");
  const index = Number(positionText);
  const total = totalText === undefined ? index : Number(totalText);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index > total) return null;
  return position;
}

function evidenceIssue(label: string, evidence: DurationEvidence | null, nowMs: number): string | null {
  if (evidence === null) return `${label} evidence is missing`;
  if (!validTimestamp(evidence.observedAtMs)) return `${label} observation time is missing or invalid`;
  if (!validTimestamp(evidence.freshUntilMs)) return `${label} expiry is missing or invalid`;
  if (evidence.observedAtMs > nowMs) return `${label} observation time is in the future`;
  if (evidence.freshUntilMs <= evidence.observedAtMs) return `${label} expiry does not follow its observation`;
  if (evidence.stale !== false) return `${label} evidence is marked stale`;
  if (nowMs >= evidence.freshUntilMs) return `${label} evidence has expired`;
  return null;
}

function describeEvidence(label: string, evidence: DurationEvidence | null): string {
  if (evidence === null) return `${label} source times unavailable.`;
  const timestamp = (value: number | null): string => validTimestamp(value) ? new Date(value).toISOString() : "unavailable or invalid";
  return `${label} observed at ${timestamp(evidence.observedAtMs)}; fresh until ${timestamp(evidence.freshUntilMs)}.`;
}

function emptyView(description: string): DurationView {
  return {
    kind: "unknown", text: "—", description,
    elapsedSeconds: null, limitSeconds: null, percent: null,
    tone: "unbounded", freshness: "unknown", animated: false,
  };
}

/**
 * Project already-selected backend evidence using an explicit clock. The caller
 * owns source arbitration and job selection. Rendering never advances elapsed
 * time, manufactures an expiry, or renews the source observations.
 */
export function projectDuration(input: DurationInput | null, nowMs: number): DurationView {
  if (!validTimestamp(nowMs)) throw new RangeError("Clock must be non-negative integer milliseconds in the Date range");
  if (input === null) return emptyView("Duration unknown: no job evidence.");

  const { displayedJobId, reading, activity } = input;
  const activityIssue = evidenceIssue("Activity", activity, nowMs);
  const queuePosition = validQueuePosition(activity?.queuePosition ?? null);
  if (activity?.state === "queued" && activityIssue === null && queuePosition !== null) {
    return {
      kind: "queue", text: "⟵",
      description: `Current queued activity at position ${queuePosition}.${activity.jobId ? ` Job ${activity.jobId}.` : ""} See the Queued column on the left. ${describeEvidence("Activity", activity)}`,
      elapsedSeconds: null, limitSeconds: null, percent: null,
      tone: "current", freshness: "current", animated: false,
    };
  }

  const sourceTimes = `${describeEvidence("Duration", reading)} ${describeEvidence("Activity", activity)}`;
  if (reading === null) return emptyView(`Duration unknown: no duration reading. ${sourceTimes}`);
  if (displayedJobId === null || displayedJobId.trim() === "" || reading.jobId.trim() === "" || reading.jobId !== displayedJobId) {
    return emptyView(`Duration unknown: reading job does not match the displayed job. ${sourceTimes}`);
  }
  if (!validSeconds(reading.elapsedSeconds)) {
    return emptyView(`Duration unknown for job ${displayedJobId}: elapsed duration is missing or invalid. ${sourceTimes}`);
  }

  const elapsedSeconds = reading.elapsedSeconds;
  const limitSeconds = validSeconds(reading.limitSeconds) && reading.limitSeconds > 0 ? reading.limitSeconds : null;
  const text = `${formatDurationSeconds(elapsedSeconds)}${limitSeconds === null ? "" : ` / ${formatDurationSeconds(limitSeconds)}`}`;
  const readingIssue = evidenceIssue("Duration", reading, nowMs);
  const jobIssue = activity === null ? null
    : activity.state !== "running" ? `Activity is ${activity.state}, not running`
    : activity.jobId !== displayedJobId ? "Activity job does not match the displayed job"
    : null;
  const issues = [readingIssue, activityIssue, jobIssue].filter((value): value is string => value !== null);
  const retained = issues.length > 0;
  const exceeded = isDurationOverrun(elapsedSeconds, limitSeconds);
  const tone = retained ? "retained" : limitSeconds === null ? "unbounded" : exceeded ? "exceeded" : "current";
  const overrun = exceeded ? retained
    ? " EXCEEDED in retained reading: reported elapsed duration was beyond its limit and the 5-minute display grace."
    : " EXCEEDED: reported elapsed duration is beyond its limit and the 5-minute display grace."
    : "";
  return {
    kind: "duration", text,
    description: `Job ${displayedJobId}: ${text}. ${retained ? `Retained duration: ${issues.join("; ")}.` : "Current duration with matching running activity."}${overrun}${limitSeconds === null ? " No valid positive duration limit reported." : ` ${DURATION_OVERRUN_GRACE_NOTE}`} ${sourceTimes}`,
    elapsedSeconds, limitSeconds,
    percent: limitSeconds === null ? null : Math.min(100, (elapsedSeconds / limitSeconds) * 100),
    tone, freshness: retained ? "retained" : "current", animated: !retained && limitSeconds !== null,
  };
}
