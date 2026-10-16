import { isMetadataAddress } from "../src/fleet/host-metadata.ts";
import type { HostMetadataSnapshot } from "../src/fleet/host-metadata.ts";
import { isJobRecord } from "../src/fleet/jobs.ts";
import type { JobRecord, JobSnapshot } from "../src/fleet/jobs.ts";
import type { NodeInfoSnapshot } from "../src/fleet/node-info.ts";
import { pruneCacheKeys } from "./online-retention.ts";
import type { ProviderRetention } from "./online-retention.ts";

/** Ordering hints only: these never make a read eligible or renew evidence. */
export type ActivityPriority = (address: string, nowMs: number) => 0 | 1 | 2;

export function comparePriority(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/** Providers call this only for due work, with their original source deadline. */
export function refreshPriority(attempted: boolean, validUntilMs: number | null, eligibleAt: number,
  activity: 0 | 1 | 2, nowMs: number): readonly number[] {
  if (!attempted) return [0, 0, eligibleAt];
  // Aging evidence wins over every transition, including jobs near their limit.
  // A completed attempt without usable proof is unresolved, not permanently
  // lower priority than successes. Once its backoff is due it must age too.
  const urgent = validUntilMs === null ? eligibleAt <= nowMs : validUntilMs <= nowMs + 10_000;
  return [1, urgent ? 0 : activity + 1, eligibleAt];
}

/** Backend-only, process-local evidence; no browser/display state enters here. */
export function createSchedulingEvidence(now: () => number = Date.now) {
  const assignments = new Map<string, { market: string; checkedAt: number }>();
  const nodes = new Map<string, { state: string | null; checkedAt: number; validUntil: number;
    runningSince: number | null; activityAt: number | null }>();
  const nodeOutcomes = new Map<string, number>();
  const invalidatedActivity = new Map<string, number>();
  const jobs = new Map<string, JobRecord>();
  const timestamp = (value: number | null): value is number => value !== null && Number.isSafeInteger(value) && value >= 0;
  const activityPriority: ActivityPriority = (address, time) => {
    const node = nodes.get(address);
    const record = jobs.get(address);
    const job = record?.job;
    const timed = record !== undefined && !record.error && !record.retained && record.checkedAtMs !== null
      && record.checkedAtMs <= time && record.validUntilMs !== null && time < record.validUntilMs
      && job?.node === address && job.state === "RUNNING" && job.timeEnd === 0
      && job.timeStart !== null && job.timeStart > 0 && job.timeStart * 1000 <= time
      && job.timeout !== null && job.timeout > 0;
    if (node && node.checkedAt <= time && time < node.validUntil) {
      if (node.state === "STARTING" || node.state === "RESTARTING") return 0;
      if (node.state === "RUNNING_JOB" && !timed && node.runningSince !== null
        && time - node.runningSince <= 120_000) return 0;
    }
    if (timed && job) {
      const elapsed = time / 1000 - job.timeStart!;
      if (elapsed <= 120 || elapsed >= job.timeout! - 120 && elapsed <= job.timeout! + 300) return 1;
    }
    return 2;
  };
  return {
    retention: {
      markets: hosts => [...hosts].flatMap(address => {
        const market = assignments.get(address)?.market;
        return market ? [market] : [];
      }),
      prune: ({ hosts }) => pruneCacheKeys(hosts, assignments, nodes, nodeOutcomes, invalidatedActivity, jobs),
    } satisfies ProviderRetention,
    activityPriority,
    marketPriority(market: string, time: number): 0 | 1 | 2 {
      let priority: 0 | 1 | 2 = 2;
      for (const [address, assignment] of assignments) {
        if (assignment.market !== market || assignment.checkedAt > time || time >= assignment.checkedAt + 300_000) continue;
        priority = Math.min(priority, activityPriority(address, time)) as 0 | 1 | 2;
      }
      return priority;
    },
    observeMetadata(snapshot: HostMetadataSnapshot): void {
      for (const record of snapshot.hosts) {
        if (!isMetadataAddress(record.address)) continue;
        const old = assignments.get(record.address);
        if (old && record.fetchedAtMs !== null && record.fetchedAtMs < old.checkedAt) continue;
        if (record.error || record.retained || !timestamp(record.fetchedAtMs) || record.fetchedAtMs > now()
          || !isMetadataAddress(record.values?.marketAddress)) { assignments.delete(record.address); continue; }
        assignments.set(record.address, { market: record.values.marketAddress, checkedAt: record.fetchedAtMs });
      }
    },
    observeStates(snapshot: NodeInfoSnapshot): void {
      for (const record of snapshot.hosts) {
        if (!isMetadataAddress(record.address)) continue;
        const old = nodes.get(record.address);
        // A finite roster may replay its early successful host after a watch
        // has already failed that same proof. Compare actual outcome time as
        // well as source time so aggregate replay cannot restore its hint.
        const apiAt = record.apiCheck?.checkedAtMs ?? null;
        // Reconciliation publishes reachability before the new State proof.
        // That frame carries old State fields, including any earlier failure.
        if (record.apiCheck?.status === "online" && apiAt !== record.fetchedAtMs) continue;
        const outcomeAt = timestamp(apiAt) && apiAt <= now() ? apiAt : record.fetchedAtMs;
        if (!timestamp(outcomeAt) || outcomeAt > now()) continue;
        const previousOutcome = nodeOutcomes.get(record.address);
        if (previousOutcome !== undefined && outcomeAt < previousOutcome) continue;
        nodeOutcomes.set(record.address, outcomeAt);
        if (old && record.fetchedAtMs !== null && record.fetchedAtMs < old.checkedAt) continue;
        if (record.error || record.retained || !timestamp(record.fetchedAtMs) || record.fetchedAtMs > now()
          || !timestamp(record.validUntilMs) || record.validUntilMs <= record.fetchedAtMs) {
          if (old) nodes.set(record.address, { ...old, validUntil: Math.min(old.validUntil, now()) });
          continue;
        }
        let state = record.values?.state ?? null;
        let validUntil = record.validUntilMs;
        let activityAt: number | null = null;
        if (state === "OTHER") {
          const activity = record.activity;
          state = activity && !activity.error && timestamp(activity.checkedAtMs) && activity.checkedAtMs <= now()
            && timestamp(activity.validUntilMs) && activity.validUntilMs > activity.checkedAtMs ? activity.state : null;
          if (state === null) {
            // Membership failures have no successful check time of their own.
            // Retire the previously accepted proof rather than timestamping
            // the failure as a new observation or letting aggregate replay win.
            invalidatedActivity.set(record.address, Math.max(invalidatedActivity.get(record.address) ?? -1,
              old?.activityAt ?? -1));
          } else if (activity!.checkedAtMs! <= (invalidatedActivity.get(record.address) ?? -1)) state = null;
          else {
            activityAt = activity!.checkedAtMs;
            validUntil = Math.min(validUntil, activity!.validUntilMs!);
          }
        }
        nodes.set(record.address, { state, checkedAt: record.fetchedAtMs, validUntil, activityAt,
          runningSince: state === "RUNNING_JOB" ? old?.runningSince ?? record.fetchedAtMs
            : state === null ? old?.runningSince ?? null : null });
      }
    },
    observeJobs(snapshot: JobSnapshot): void {
      for (const record of snapshot.hosts) {
        if (!isJobRecord(record)) continue;
        const old = jobs.get(record.address);
        const outcomeAt = Math.max(record.checkedAtMs ?? -1, record.failedAtMs ?? -1);
        const oldOutcomeAt = Math.max(old?.checkedAtMs ?? -1, old?.failedAtMs ?? -1);
        if (outcomeAt < oldOutcomeAt || outcomeAt === oldOutcomeAt
          && Boolean(old?.error || old?.retained) && !record.error && !record.retained) continue;
        if (old?.checkedAtMs !== null && old?.checkedAtMs !== undefined && record.checkedAtMs !== null
          && record.checkedAtMs < old.checkedAtMs) continue;
        jobs.set(record.address, structuredClone(record));
      }
    },
  };
}
