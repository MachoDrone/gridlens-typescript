// Entirely synthetic preview data; never imported by a live collector or store.
import type { ContainerState, PCInventory, RuntimeInventory, SuccessfulInventory } from "../fleet/freshness.ts";
import type { IPAddresses } from "../fleet/ip-display.ts";
import type { DurationInput, DurationReading, DurationActivity } from "../fleet/duration.ts";
import type { MarketObservation } from "../fleet/market-display.ts";
import type { HardwareColumn } from "../fleet/hardware-display.ts";
import { NODE_STATES } from "../fleet/node-info.ts";
import type { NodeInfoRecord } from "../fleet/node-info.ts";

/** Documentation-only addresses assigned before sorting, never browser egress. */
export function sampleAddresses(pcIndex: number): IPAddresses {
  return {
    internal: pcIndex === 4 ? null : `192.0.2.${pcIndex + 10}`,
    global: pcIndex === 2 ? null : `198.51.100.${200 - pcIndex}`,
  };
}

export const SAMPLE_TIME = Date.UTC(2026, 0, 1, 12);

/** Invented country reports shared by hosts on a sample PC; never live geography. */
export function sampleCountry(hostId: string): string | null {
  const match = /^sample-host-(\d+)-\d+$/.exec(hostId);
  const pcNumber = Number(match?.[1]);
  if (!Number.isSafeInteger(pcNumber) || pcNumber < 1) return null;
  const countries = ["US", "nl", null, "DE", "Canada", "GB"] as const;
  return countries[(pcNumber - 1) % countries.length] ?? null;
}

export interface HardwareSample {
  readonly values: Readonly<Record<HardwareColumn, string | null>>;
  readonly observedAtMs: number | null;
}

/** Invented metadata, consistent across hosts sharing a sample PC. No live TTL. */
export function sampleHardware(hostId: string): HardwareSample {
  const match = /^sample-host-(\d+)-\d+$/.exec(hostId);
  const pcNumber = Number(match?.[1]);
  const samples = [
    { nvidia: "550.120.02", cpu: "13th Gen Intel(R) Core(TM) i7-13700K", system: "6.8.0-52-generic" },
    { nvidia: "550.90.07", cpu: "13th Gen Intel(R) Core(TM) i5-13600K", system: "6.8.0-9-generic" },
    { nvidia: null, cpu: null, system: null },
    { nvidia: "570.86.16", cpu: "AMD Ryzen 7 7700X 8-Core Processor", system: "6.12.0-4-generic" },
    { nvidia: "535.104.05", cpu: "Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz", system: "6.6.0-15-amd64" },
    { nvidia: "560.35.03", cpu: "AMD Ryzen 9 7950X 16-Core Processor", system: "6.8.0-101-generic" },
  ] as const;
  const index = Number.isSafeInteger(pcNumber) && pcNumber > 0 ? (pcNumber - 1) % samples.length : 2;
  return {
    values: samples[index] ?? samples[2],
    observedAtMs: index === 2 ? null : index === 3 ? SAMPLE_TIME - 180_000 : SAMPLE_TIME,
  };
}

/** Fictitious current-market labels, visible in the initial preview as well. */
export function sampleMarket(hostId: string): MarketObservation | null {
  const match = /^sample-host-(\d+)-(\d+)$/.exec(hostId);
  if (!match) return null;
  const pcNumber = Number(match[1]);
  const hostNumber = Number(match[2]);
  if (!Number.isSafeInteger(pcNumber) || !Number.isSafeInteger(hostNumber) || pcNumber < 1 || hostNumber < 1) return null;
  const labels = ["amber-demo-4090", "amber-demo-4080", "cobalt-demo-a4000", "maple-demo-3060", null, "birch-demo-3090"] as const;
  const index = (pcNumber === 1 ? hostNumber - 1 : pcNumber + hostNumber) % labels.length;
  const label = labels[index];
  if (!label) return null;
  return {
    label,
    observedAtMs: index === 2 ? SAMPLE_TIME - 180_000 : SAMPLE_TIME,
    freshUntilMs: index === 2 ? SAMPLE_TIME - 120_000 : SAMPLE_TIME + 60_000,
    stale: false,
  };
}

export const SCENARIOS = [
  { id: "mixed", label: "Mixed health", description: "Fresh, stopped, stale, failed, missing and empty inventory, with visible sample market names. Use 🔄 in Market for the compact view." },
  { id: "fresh", label: "Fresh inventory", description: "Eight observed hosts across six sample PCs, including one confirmed stopped host." },
  { id: "failed", label: "Failed collection", description: "A failed read retains the last observations; current container state is unknown." },
  { id: "stale", label: "Stale inventory", description: "Old observations stay visible without claiming the hosts are still running." },
  { id: "missing", label: "No observation yet", description: "An enrolled sample PC has not supplied any inventory. Its host count is unknown." },
  { id: "empty", label: "Confirmed empty", description: "A successful empty reading replaces this runtime’s earlier inventory." },
  { id: "durations", label: "Job durations", description: "Sample jobs: running, exceeded, zero, unknown limit, stale, missing, queued, completed, changed job, exact limit and fresh job with old local inventory. Advance 60s to expire the job evidence." },
  { id: "states", label: "Node states", description: "All eight synthetic Node Info states, with the reference running/queued/restarting artwork and sample network readings. Advance 30s to dim retained State evidence; animation follows its saved preference. No provider is contacted." },
  { id: "scale", label: "200 sample hosts", description: "A layout fixture with 200 hosts across 50 sample PCs. This is not a live scale test." },
] as const;
export type ScenarioId = typeof SCENARIOS[number]["id"];

function success(pcNumber: number, count: number, at: number, stopped = false): SuccessfulInventory {
  return {
    outcome: "success",
    observedAtMs: at,
    hosts: Array.from({ length: count }, (_, index) => ({
      id: `sample-host-${pcNumber}-${index + 1}`,
      name: `Sample host ${pcNumber}.${index + 1}`,
      state: (stopped && index === 0 ? "stopped" : "running") as ContainerState,
    })),
  };
}

function runtime(latest: RuntimeInventory["latest"], lastSuccess: SuccessfulInventory | null = null, runtimeId = "docker"): RuntimeInventory {
  return { runtimeId, latest, lastSuccess };
}

function pc(number: number, runtimes: readonly RuntimeInventory[], observedAtMs: number | null = SAMPLE_TIME): PCInventory {
  return { pcId: `sample-${String(number).padStart(2, "0")}`, observedAtMs, runtimes };
}

export function sampleInventory(scenario: ScenarioId): readonly PCInventory[] {
  switch (scenario) {
    case "fresh":
      return Array.from({ length: 6 }, (_, index) => pc(index + 1, [
        runtime(success(index + 1, index === 0 ? 3 : 1, SAMPLE_TIME - 15_000, index === 1)),
      ]));
    case "failed":
      return [pc(1, [runtime({ outcome: "failure", observedAtMs: SAMPLE_TIME, error: "Sample inventory read failed" }, success(1, 2, SAMPLE_TIME - 30_000))])];
    case "stale":
      return [pc(1, [runtime(success(1, 2, SAMPLE_TIME - 180_000))], SAMPLE_TIME - 180_000)];
    case "missing":
      return [pc(1, [runtime(null)], null)];
    case "empty":
      return [pc(1, [runtime(success(1, 0, SAMPLE_TIME), success(1, 2, SAMPLE_TIME - 30_000))])];
    case "scale":
      return Array.from({ length: 50 }, (_, index) => pc(index + 1, [runtime(success(index + 1, 4, SAMPLE_TIME - 15_000, index % 7 === 0))]));
    case "states":
      return NODE_STATES.map((_, index) => pc(index + 1, [runtime(success(index + 1, 1, SAMPLE_TIME))]));
    case "durations":
      return Array.from({ length: 11 }, (_, index) => {
        const observed = index === 10 ? SAMPLE_TIME - 180_000 : SAMPLE_TIME;
        return pc(index + 1, [runtime(success(index + 1, 1, observed))], observed);
      });
    case "mixed":
      return [
        pc(1, [runtime(success(1, 3, SAMPLE_TIME - 15_000))]),
        pc(2, [runtime(success(2, 1, SAMPLE_TIME - 10_000, true))]),
        pc(3, [runtime({ outcome: "failure", observedAtMs: SAMPLE_TIME, error: "Sample nested-runtime read failed" }, success(3, 1, SAMPLE_TIME - 45_000), "podman@sample-wrapper")]),
        pc(4, [runtime(success(4, 1, SAMPLE_TIME - 180_000))], SAMPLE_TIME - 180_000),
        pc(5, [runtime(null)], null),
        pc(6, [runtime(success(6, 0, SAMPLE_TIME))]),
      ];
  }
}

/** Separate state/network examples never joined to the supplied public addresses. */
export function sampleNodeInfo(scenario: ScenarioId, hostId: string): NodeInfoRecord | undefined {
  if (scenario !== "states") return undefined;
  const match = /^sample-host-(\d+)-1$/.exec(hostId);
  const index = Number(match?.[1]) - 1;
  const state = NODE_STATES[index];
  if (!state) return undefined;
  return {
    address: hostId,
    values: { state, dl: 100.5 + index * 20, ul: 50.5 + index * 10, ping: 10.25 + index, networkUnavailableReason: null },
    fetchedAtMs: SAMPLE_TIME, validUntilMs: SAMPLE_TIME + 30_000, retained: false, error: null,
  };
}

/** Selected, synthetic job evidence; the expiry is a fixture, not an API promise. */
export function sampleDuration(scenario: ScenarioId, hostId: string): DurationInput | null {
  if (scenario !== "durations") return null;
  const match = /^sample-host-(\d+)-1$/.exec(hostId);
  if (!match) return null;
  const number = Number(match[1]);
  if (number < 1 || number > 11) return null;
  const jobId = `sample-job-${number}`;
  let reading: DurationReading | null = {
    jobId, elapsedSeconds: 120, limitSeconds: 600,
    observedAtMs: SAMPLE_TIME, freshUntilMs: SAMPLE_TIME + 60_000, stale: false,
  };
  let activity: DurationActivity = {
    jobId, state: "running", queuePosition: null,
    observedAtMs: SAMPLE_TIME, freshUntilMs: SAMPLE_TIME + 60_000, stale: false,
  };
  let displayedJobId: string | null = jobId;
  switch (number) {
    case 2: reading = { ...reading, elapsedSeconds: 960 }; break;
    case 3: reading = { ...reading, elapsedSeconds: 0 }; break;
    case 4: reading = { ...reading, elapsedSeconds: 90, limitSeconds: null }; break;
    case 5: reading = { ...reading, elapsedSeconds: 300, observedAtMs: SAMPLE_TIME - 120_000, freshUntilMs: SAMPLE_TIME - 60_000 }; break;
    case 6: reading = null; break;
    case 7:
      reading = { ...reading, elapsedSeconds: 360, observedAtMs: SAMPLE_TIME - 120_000, freshUntilMs: SAMPLE_TIME - 60_000 };
      activity = { ...activity, state: "queued", jobId: null, queuePosition: "2/8" };
      displayedJobId = null;
      break;
    case 8:
      reading = { ...reading, elapsedSeconds: 480 };
      activity = { ...activity, state: "completed" };
      break;
    case 9: activity = { ...activity, jobId: "sample-next-job-9" }; break;
    case 10: reading = { ...reading, elapsedSeconds: 600 }; break;
  }
  return { displayedJobId, reading, activity };
}
