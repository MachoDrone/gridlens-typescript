// Copyright (c) 2026 MachoDrone. MIT license; see LICENSE.
// Full and compact display for a host's reported market association.

export type MarketDisplayMode = "full" | "compact";

/** Already-selected market association; this is not a provider/API contract. */
export interface MarketObservation {
  readonly label: string | null;
  readonly observedAtMs: number | null;
  readonly freshUntilMs: number | null;
  readonly stale: boolean;
}

export interface MarketView {
  readonly text: string;
  readonly fullLabel: string | null;
  readonly freshness: "current" | "retained" | "unknown";
  readonly description: string;
  /** Original source timestamp; displaying a value never renews its evidence. */
  readonly observedAtMs: number | null;
}

export function normalizeMarketMode(value: unknown): MarketDisplayMode {
  return value === "compact" ? "compact" : "full";
}

export function nextMarketMode(mode: MarketDisplayMode): MarketDisplayMode {
  return mode === "full" ? "compact" : "full";
}

function validTimestamp(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
}

function timestamp(value: number | null): string {
  return validTimestamp(value) ? new Date(value).toISOString() : "unavailable or invalid";
}

function evidenceIssue(observation: MarketObservation, nowMs: number): string | null {
  if (!validTimestamp(observation.observedAtMs)) return "observation time is missing or invalid";
  if (observation.observedAtMs > nowMs) return "observation time is in the future";
  if (!validTimestamp(observation.freshUntilMs)) return "expiry is missing or invalid";
  if (observation.freshUntilMs <= observation.observedAtMs) return "expiry does not follow its observation";
  if (observation.stale !== false) return "source marked this observation stale";
  if (nowMs >= observation.freshUntilMs) return "market evidence has expired";
  return null;
}

/**
 * Project source evidence without collection, ambient time or a guessed TTL.
 * The caller selects the reported current assignment; recommendations and GPU
 * measurements must not substitute for it. Returned strings are plain text.
 */
export function projectMarket(
  observation: MarketObservation | null,
  mode: MarketDisplayMode,
  nowMs: number,
): MarketView {
  if (!validTimestamp(nowMs)) throw new RangeError("Clock must be non-negative integer milliseconds in the Date range");
  const fullLabel = observation?.label?.trim() || null;
  const observedAtMs = observation?.observedAtMs ?? null;
  const sourceTimes = observation === null ? "Market source times unavailable."
    : `Market observed at ${timestamp(observation.observedAtMs)}; fresh until ${timestamp(observation.freshUntilMs)}.`;
  const identityNote = "A market association does not establish physical GPU identity.";
  if (observation === null || fullLabel === null) {
    return {
      text: "—", fullLabel: null, freshness: "unknown", observedAtMs,
      description: `Market unknown: no reported market association. ${sourceTimes} ${identityNote}`,
    };
  }
  const issue = evidenceIssue(observation, nowMs);
  return {
    text: mode === "compact" ? Array.from(fullLabel).slice(0, 2).join("") : fullLabel,
    fullLabel,
    freshness: issue === null ? "current" : "retained",
    description: `${issue === null ? "Current" : "Retained"} market association: ${fullLabel}.${issue === null ? "" : ` Current assignment unverified: ${issue}.`} ${sourceTimes} ${identityNote}`,
    observedAtMs,
  };
}
