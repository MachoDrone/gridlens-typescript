const maximumTimeMs = 8_640_000_000_000_000;

/** Transport time is independent of the timestamps contained in observations. */
export function isServerTimeMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximumTimeMs;
}

export interface EvidenceClockUpdate {
  /** Reproject/rearm only for calibration, trust restoration or a forward correction. */
  changed: boolean;
  /** Expiry confidence changed; this does not change source refresh scheduling. */
  freshnessChanged: boolean;
  calibratedNow: boolean;
  trustChanged: boolean;
  correctionMs: number;
}

export interface EvidenceClock {
  now(): number;
  /** Conservative expiry time; never use for elapsed jobs or future-source validation. */
  freshnessNow(): number;
  readonly calibrated: boolean;
  readonly trusted: boolean;
  accept(serverTimeMs: number, requestElapsedMs?: number): EvidenceClockUpdate;
  /** Keep the reference and retained evidence; only freshness trust is suspended. */
  suspend(): boolean;
}

/**
 * Compare source timestamps with the server's epoch, progressing with elapsed
 * browser time. Never derive a reference from a host's observation timestamp.
 */
export function createEvidenceClock({
  wallNow = Date.now,
  monotonicNow = () => performance.now(),
}: { wallNow?: () => number; monotonicNow?: () => number } = {}): EvidenceClock {
  let anchorMs: number | null = null;
  let anchorMonotonicMs = 0;
  let lastNowMs = 0;
  let trusted = true;
  let measuredFreshness = false;
  let upperAnchorMs: number | null = null;
  let upperMonotonicMs = 0;
  let lastUpperMs = 0;

  const elapsedNow = (): number => {
    const value = monotonicNow();
    if (!Number.isFinite(value) || value < 0) throw new RangeError("Monotonic clock must be finite and non-negative.");
    return value;
  };
  const projectedAt = (elapsed: number): number => {
    lastNowMs = Math.max(lastNowMs, Math.min(maximumTimeMs,
      Math.floor(anchorMs! + Math.max(0, elapsed - anchorMonotonicMs))));
    return lastNowMs;
  };
  const upperAt = (elapsed: number, estimate: number): number => {
    if (upperAnchorMs === null) return measuredFreshness ? maximumTimeMs : estimate;
    // Round outward and retain the bound if a defective elapsed clock moves
    // backward. Only a new compatible sample may tighten the uncertainty.
    lastUpperMs = Math.max(lastUpperMs, estimate, Math.min(maximumTimeMs,
      Math.ceil(upperAnchorMs + Math.max(0, elapsed - upperMonotonicMs))));
    return lastUpperMs;
  };
  const wallTime = (): number => {
    const value = wallNow();
    if (!isServerTimeMs(value)) throw new RangeError("Wall clock must be integer milliseconds in the Date range.");
    return value;
  };

  return {
    get calibrated() { return anchorMs !== null; },
    get trusted() { return trusted; },
    now() {
      if (anchorMs !== null) return projectedAt(elapsedNow());
      return wallTime();
    },
    freshnessNow() {
      if (anchorMs === null) return wallTime();
      const elapsed = elapsedNow();
      return upperAt(elapsed, projectedAt(elapsed));
    },
    accept(serverTimeMs, requestElapsedMs) {
      if (!isServerTimeMs(serverTimeMs)) throw new RangeError("Server time must be integer milliseconds in the Date range.");
      if (requestElapsedMs !== undefined && (!Number.isFinite(requestElapsedMs) || requestElapsedMs < 0 || requestElapsedMs > maximumTimeMs)) {
        throw new RangeError("Request elapsed time must be finite, non-negative milliseconds in the Date range.");
      }
      const elapsed = elapsedNow();
      const calibratedNow = anchorMs === null;
      const trustChanged = !trusted;
      const before = calibratedNow ? serverTimeMs : projectedAt(elapsed);
      const previousFreshness = calibratedNow ? null : upperAt(elapsed, before);
      const previousUpper = upperAnchorMs === null ? null : previousFreshness;
      const correctionMs = Math.max(0, serverTimeMs - before);
      if (calibratedNow || correctionMs > 0) {
        anchorMs = serverTimeMs;
        anchorMonotonicMs = elapsed;
        lastNowMs = serverTimeMs;
      }
      const estimate = Math.max(before, serverTimeMs);
      if (requestElapsedMs !== undefined) {
        measuredFreshness = true;
        const candidateUpper = Math.min(maximumTimeMs, serverTimeMs + Math.ceil(requestElapsedMs));
        // Emission occurs after this request starts, so its whole elapsed time
        // bounds transit without assuming symmetric latency or moving now().
        // Compatible later samples can narrow an earlier bound. Slow streams
        // cannot widen it. An entirely older sample cannot rewind or tighten it.
        if (candidateUpper >= estimate) {
          upperAnchorMs = previousUpper !== null && serverTimeMs <= previousUpper
            ? Math.min(previousUpper, candidateUpper) : candidateUpper;
          upperMonotonicMs = elapsed;
          lastUpperMs = upperAnchorMs;
        }
      } else if (previousUpper !== null && estimate > previousUpper) {
        // Legacy samples still calibrate the estimate, but cannot establish a
        // measured upper bound after jumping beyond the one previously known.
        upperAnchorMs = null;
      }
      trusted = true;
      const freshnessChanged = calibratedNow || trustChanged || previousFreshness !== upperAt(elapsed, estimate);
      return { changed: calibratedNow || trustChanged || correctionMs > 0, freshnessChanged,
        calibratedNow, trustChanged, correctionMs };
    },
    suspend() {
      // Old servers never publish a reference; preserve their existing lifecycle
      // behavior rather than waiting forever for unavailable calibration data.
      if (anchorMs === null) return false;
      const changed = trusted;
      trusted = false;
      upperAnchorMs = null;
      return changed;
    },
  };
}
