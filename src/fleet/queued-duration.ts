import type { DurationView } from "./duration.ts";
import type { QueueView } from "./queue.ts";

export type QueuedDurationLayout = "separate" | "combined";

export interface QueuedDurationView {
  readonly showQueue: boolean;
  readonly showDuration: boolean;
  /** Both useful sources remain visible, each on its own labeled line. */
  readonly stacked: boolean;
  /** The existing Duration text, except a standalone queue arrow becomes Queued. */
  readonly durationText: string;
  /** Both original descriptions, even when a compact presentation is hidden. */
  readonly description: string;
}

export function normalizeQueuedDurationLayout(value: unknown): QueuedDurationLayout {
  return value === "combined" ? "combined" : "separate";
}

/**
 * Select presentation containers only. Existing projections own evidence,
 * freshness, conflict handling, sorting and animation; retain those unchanged.
 * In particular a retained/conflicting position or timing is still useful.
 */
export function projectQueuedDuration(queue: QueueView, duration: DurationView): QueuedDurationView {
  const showQueue = queue.kind === "position";
  const showTiming = duration.kind === "duration";
  return {
    showQueue,
    showDuration: showTiming || !showQueue,
    stacked: showQueue && showTiming,
    durationText: duration.kind === "queue" ? "Queued" : duration.text,
    description: `Queued\n${queue.description}\n\nDuration\n${duration.description}`,
  };
}
