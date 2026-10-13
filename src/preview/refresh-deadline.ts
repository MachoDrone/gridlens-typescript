/** Source deadlines and local elapsed waits must survive clock calibration differently. */
export interface RefreshDeadline {
  readonly sourceAtMs: number | null;
  readonly notBeforeMs: number;
}

export function createRefreshDeadlines(now: () => number, monotonicNow = () => performance.now()) {
  const remaining = (deadline: RefreshDeadline): number => Math.max(
    deadline.sourceAtMs === null ? -Infinity : deadline.sourceAtMs - now(),
    deadline.notBeforeMs - monotonicNow(),
  );
  return {
    source(atMs: number | null, minimumWaitMs = 0): RefreshDeadline | null {
      return atMs === null ? null : { sourceAtMs: atMs, notBeforeMs: monotonicNow() + minimumWaitMs };
    },
    after(delayMs: number): RefreshDeadline {
      return { sourceAtMs: null, notBeforeMs: monotonicNow() + Math.max(0, delayMs) };
    },
    remaining,
    at(deadline: RefreshDeadline | null): number | null {
      return deadline === null ? null : Math.floor(now() + remaining(deadline));
    },
    earlier(left: RefreshDeadline | null, right: RefreshDeadline | null): RefreshDeadline | null {
      if (left === null) return right;
      if (right === null) return left;
      return remaining(left) <= remaining(right) ? left : right;
    },
  };
}
