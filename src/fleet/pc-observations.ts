import { isMetadataAddress } from "./host-metadata.ts";

export const REWARD_FRESH_MS = 6 * 60_000;
export const MAX_GPU_SAMPLES = 6000;
export const GPU_UUID = /^GPU-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const REWARD_AMOUNT = /^(?:0|[1-9][0-9]{0,12})\.[0-9]{6}$/;
export const GPU_REASON_LABELS = ["Thermal slowdown", "Hardware thermal protection", "Power limiting", "Power braking"] as const;
export interface NodeBinding { pcId: string; runtime: "docker" | "podman"; wrapperId: string | null; nodeContainerId: string }
export interface RewardObservation { schema: 1; address: string; observedAtMs: number; status: "ok" | "authentication-failed" | "rate-limited" | "identity-mismatch" | "unavailable"; amount?: string; retryAfterSeconds?: number }
export type GpuSample = [number, number, number, number, number | null, number | null, number | null, number | null];
export interface NodeGpuObservation {
  schema: 2; address: string; observedAtMs: number | null; status: string; gpuUuids: string[];
  intervalSeconds: 15; fromAtMs: number; toAtMs: number; truncated: boolean; clockTrusted: boolean; samples: GpuSample[];
}
export interface MonitoringState { status: string; checkedAtMs: number }
export type PublicNetworkFailure = "missing-curl" | "dns" | "connection" | "timeout" | "tls" | "http-refusal" | "invalid-response";
export interface PcNetworkObservation {
  schema: 1; observedAtMs: number; status: "ok" | "unavailable"; source: "node-egress-ipify" | "pc-egress-ipify";
  publicIp: string | null; publicObservedAtMs: number | null;
  privateIp: string | null; privateObservedAtMs: number | null;
  publicFailure?: PublicNetworkFailure; privateFailure?: "interface-read-failure";
  httpStatus?: number; retryAtMs?: number;
}
export interface PcNetworkUpdate { pcId: string; network: PcNetworkObservation }
export interface PcNetworkRecord extends PcNetworkUpdate { receivedAtMs: number; lastGoodNetwork?: PcNetworkObservation }
export interface PcUpdate { address: string; binding: NodeBinding; rewards?: RewardObservation; gpu?: NodeGpuObservation; monitoring?: MonitoringState; network?: PcNetworkObservation }
export interface PcObservation extends PcUpdate { receivedAtMs: number; lastGoodRewards?: RewardObservation; lastGoodNetwork?: PcNetworkObservation }
export interface PcObservationIndex extends Omit<PcObservation, "gpu"> { gpu?: Omit<NodeGpuObservation, "samples"> & { sampleCount: number } }
export const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error("Invalid PC observation fields.");
  return value as Record<string, unknown>;
}
/** Numeric IP literals only; never resolves a name or chooses a network target. */
export function normalizedIp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 45) return null;
  if (/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(value))
    return value.split(".").every(part => Number(part) <= 255) ? value : null;
  if (!value.includes(":") || !/^[a-fA-F0-9:]+$/.test(value)) return null;
  try { return new URL(`http://[${value}]/`).hostname.slice(1, -1).toLowerCase(); } catch { return null; }
}
export function privateIp(value: string): boolean {
  const ip = normalizedIp(value); if (ip === null) return false;
  if (ip.includes(":")) return /^(fc|fd)/.test(ip);
  const [a, b] = ip.split(".").map(Number) as [number, number, number, number];
  return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127;
}
export function publicIp(value: string): boolean {
  const ip = normalizedIp(value); if (ip === null || privateIp(ip)) return false;
  if (ip.includes(":")) return /^[23][0-9a-f]{3}:/.test(ip) && !/^2001:db8:/.test(ip) && !/^2001:(?:2:|1[0-9a-f]:|2[0-9a-f]:)/.test(ip);
  const [a, b, c] = ip.split(".").map(Number) as [number, number, number, number];
  return a !== 0 && a !== 127 && a < 224 && !(a === 169 && b === 254)
    && !(a === 192 && (b === 0 && (c === 0 || c === 2) || b === 88 && c === 99)) && !(a === 198 && (b === 18 || b === 19 || b === 51 && c === 100))
    && !(a === 203 && b === 0 && c === 113);
}
export function parsePcNetwork(value: unknown): PcNetworkObservation {
  const input = object(value, ["schema", "observedAtMs", "status", "source", "publicIp", "publicObservedAtMs", "privateIp", "privateObservedAtMs"],
    ["publicFailure", "privateFailure", "httpStatus", "retryAtMs"]);
  if (input.schema !== 1 || typeof input.source !== "string" || !["node-egress-ipify", "pc-egress-ipify"].includes(input.source)
    || !time(input.observedAtMs) || input.observedAtMs === 0 || typeof input.status !== "string"
    || !["ok", "unavailable"].includes(input.status)) throw new Error("Invalid PC network observation.");
  for (const [field, at, valid] of [["publicIp", "publicObservedAtMs", publicIp], ["privateIp", "privateObservedAtMs", privateIp]] as const) {
    if (input[field] === null ? input[at] !== null : typeof input[field] !== "string" || !valid(input[field])
      || !time(input[at]) || input[at] === 0 || input[at] > input.observedAtMs) throw new Error("Invalid observed IP address.");
  }
  if ((input.status === "ok") !== (input.publicIp !== null)) throw new Error("Invalid public IP observation status.");
  if (input.publicFailure !== undefined && (input.publicIp !== null || typeof input.publicFailure !== "string"
    || !["missing-curl", "dns", "connection", "timeout", "tls", "http-refusal", "invalid-response"].includes(input.publicFailure)))
    throw new Error("Invalid public IP failure.");
  if (input.privateFailure !== undefined && (input.privateIp !== null || input.privateFailure !== "interface-read-failure")) throw new Error("Invalid private IP failure.");
  if (input.httpStatus !== undefined && (input.publicFailure !== "http-refusal" || typeof input.httpStatus !== "number"
    || !Number.isInteger(input.httpStatus) || input.httpStatus < 100 || input.httpStatus > 599)) throw new Error("Invalid IP HTTP status.");
  if (input.retryAtMs !== undefined && (!time(input.retryAtMs) || input.retryAtMs === 0)) throw new Error("Invalid IP retry deadline.");
  return { ...input, publicIp: input.publicIp === null ? null : normalizedIp(input.publicIp), privateIp: input.privateIp === null ? null : normalizedIp(input.privateIp) } as PcNetworkObservation;
}
export function parsePcNetworkUpdate(value: unknown): PcNetworkUpdate {
  const input = object(value, ["pcId", "network"]);
  if (typeof input.pcId !== "string" || !/^[a-f0-9]{64}$/.test(input.pcId)) throw new Error("Invalid observed PC.");
  return { pcId: input.pcId, network: parsePcNetwork(input.network) };
}
export function parsePcNetworkRecord(value: unknown): PcNetworkRecord {
  const input = object(value, ["pcId", "network", "receivedAtMs"], ["lastGoodNetwork"]);
  if (!time(input.receivedAtMs)) throw new Error("Invalid network receipt time.");
  const output: PcNetworkRecord = { ...parsePcNetworkUpdate({ pcId: input.pcId, network: input.network }), receivedAtMs: input.receivedAtMs };
  if (input.lastGoodNetwork !== undefined) output.lastGoodNetwork = parsePcNetwork(input.lastGoodNetwork);
  return output;
}
export function networkView(record: Pick<PcObservation, "network" | "lastGoodNetwork"> | undefined, now: number) {
  const latest = record?.network, retained = record?.lastGoodNetwork;
  const usePublic = latest?.publicIp != null && (latest.publicObservedAtMs ?? 0) >= (retained?.publicObservedAtMs ?? 0);
  const usePrivate = latest?.privateIp != null && (latest.privateObservedAtMs ?? 0) >= (retained?.privateObservedAtMs ?? 0);
  const publicAddress = usePublic ? latest.publicIp : retained?.publicIp ?? null;
  const privateAddress = usePrivate ? latest.privateIp : retained?.privateIp ?? null;
  const publicAt = usePublic ? latest.publicObservedAtMs : retained?.publicObservedAtMs ?? null;
  const privateAt = usePrivate ? latest.privateObservedAtMs : retained?.privateObservedAtMs ?? null;
  const recent = (at: number | null): boolean => at !== null && now >= at && now < at + 35 * 60_000;
  return { publicIp: publicAddress, privateIp: privateAddress, publicObservedAtMs: publicAt, privateObservedAtMs: privateAt,
    publicRetained: publicAddress !== null && (!usePublic || !recent(publicAt)),
    privateRetained: privateAddress !== null && (!usePrivate || !recent(privateAt)), status: latest?.status ?? "unavailable" };
}
export function parseBinding(value: unknown): NodeBinding {
  const input = object(value, ["pcId", "runtime", "wrapperId", "nodeContainerId"]);
  const id = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  if (!id(input.pcId) || !id(input.nodeContainerId) || !(input.wrapperId === null || id(input.wrapperId))
    || !(input.runtime === "docker" || input.runtime === "podman") || input.wrapperId !== null && input.runtime !== "podman") throw new Error("Invalid node binding.");
  return input as unknown as NodeBinding;
}
export const sameBinding = (a: NodeBinding, b: NodeBinding): boolean => a.pcId === b.pcId && a.runtime === b.runtime && a.wrapperId === b.wrapperId && a.nodeContainerId === b.nodeContainerId;
export function parseReward(value: unknown, address: string): RewardObservation {
  const input = object(value, ["schema", "address", "observedAtMs", "status"], ["amount", "retryAfterSeconds"]);
  if (input.schema !== 1 || input.address !== address || !time(input.observedAtMs) || input.observedAtMs === 0
    || !["ok", "authentication-failed", "rate-limited", "identity-mismatch", "unavailable"].includes(String(input.status))) throw new Error("Invalid reward observation.");
  if (input.status === "ok" ? typeof input.amount !== "string" || !REWARD_AMOUNT.test(input.amount)
    : input.amount !== undefined) throw new Error("Invalid exact reward amount.");
  if (typeof input.amount === "string" && BigInt(input.amount.replace(".", "")) > 9_223_372_036_854_775_807n) throw new Error("Reward amount exceeds its supported range.");
  if (input.retryAfterSeconds !== undefined && (typeof input.retryAfterSeconds !== "number"
    || !Number.isSafeInteger(input.retryAfterSeconds) || input.retryAfterSeconds < 0 || input.retryAfterSeconds > 2_147_483_647)) throw new Error("Invalid reward retry delay.");
  return input as unknown as RewardObservation;
}
export function parseNodeGpu(value: unknown, address: string): NodeGpuObservation {
  const input = object(value, ["schema", "address", "observedAtMs", "status", "gpuUuids", "intervalSeconds", "fromAtMs", "toAtMs", "truncated", "clockTrusted", "samples"]);
  if (input.schema !== 2 || input.address !== address || !(input.observedAtMs === null || time(input.observedAtMs))
    || !["ok", "starting", "unavailable", "unsupported", "identity-mismatch", "binding-changed", "binding-mismatch", "clock-untrusted", "clock-regressed", "query-failed", "invalid-response", "stale", "not-enabled", "setup-failed"].includes(String(input.status))
    || input.intervalSeconds !== 15 || !time(input.fromAtMs) || !time(input.toAtMs) || input.toAtMs < input.fromAtMs || input.toAtMs - input.fromAtMs > 7 * 86_400_000
    || typeof input.truncated !== "boolean" || typeof input.clockTrusted !== "boolean" || !Array.isArray(input.gpuUuids) || input.gpuUuids.length > 64
    || input.gpuUuids.some(uuid => typeof uuid !== "string" || !GPU_UUID.test(uuid)) || new Set(input.gpuUuids).size !== input.gpuUuids.length
    || !Array.isArray(input.samples) || input.samples.length > MAX_GPU_SAMPLES) throw new Error("Invalid node GPU observation.");
  let last = -1;
  const seen = new Set<string>();
  for (const sample of input.samples) {
    if (!Array.isArray(sample) || sample.length !== 8 || !time(sample[0]) || sample[0] < input.fromAtMs || sample[0] > input.toAtMs || sample[0] < last
      || !Number.isInteger(sample[1]) || sample[1] < 0 || sample[1] >= input.gpuUuids.length
      || !Number.isInteger(sample[2]) || sample[2] < 0 || sample[2] > 15 || !Number.isInteger(sample[3]) || sample[3] < 0 || sample[3] > 15
      || (sample[3] & ~sample[2]) !== 0 || sample.slice(4).some(n => n !== null && (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0))) throw new Error("Invalid GPU sample.");
    const key = `${sample[0]}:${sample[1]}`;
    if (seen.has(key)) throw new Error("Duplicate GPU sample.");
    seen.add(key); last = sample[0];
  }
  return input as unknown as NodeGpuObservation;
}
export function parsePcUpdate(value: unknown): PcUpdate {
  const input = object(value, ["address", "binding"], ["rewards", "gpu", "monitoring", "network"]);
  if (!isMetadataAddress(input.address)) throw new Error("Invalid monitored host.");
  const output: PcUpdate = { address: input.address, binding: parseBinding(input.binding) };
  if (input.rewards !== undefined) output.rewards = parseReward(input.rewards, output.address);
  if (input.gpu !== undefined) output.gpu = parseNodeGpu(input.gpu, output.address);
  if (input.network !== undefined) output.network = parsePcNetwork(input.network);
  if (input.monitoring !== undefined) {
    const state = object(input.monitoring, ["status", "checkedAtMs"]);
    if (!time(state.checkedAtMs) || !["active", "unreachable", "network-unavailable", "credentials-required", "identity-changed", "authorization-required", "binding-changed", "paused", "unsupported", "gpu-access-required"].includes(String(state.status))) throw new Error("Invalid monitoring status.");
    output.monitoring = state as unknown as MonitoringState;
  }
  if (!output.rewards && !output.gpu && !output.monitoring && !output.network) throw new Error("Empty PC observation.");
  return structuredClone(output);
}
export function parseSavedObservation(value: unknown): PcObservation {
  const input = object(value, ["address", "binding", "receivedAtMs"], ["rewards", "gpu", "monitoring", "network", "lastGoodRewards", "lastGoodNetwork"]);
  if (!time(input.receivedAtMs)) throw new Error("Invalid observation receipt time.");
  const { receivedAtMs, lastGoodRewards, lastGoodNetwork, ...update } = input;
  const output: PcObservation = { ...parsePcUpdate(update), receivedAtMs };
  if (lastGoodRewards !== undefined) {
    output.lastGoodRewards = parseReward(lastGoodRewards, output.address);
    if (output.lastGoodRewards.status !== "ok") throw new Error("Invalid retained reward.");
  }
  if (lastGoodNetwork !== undefined) output.lastGoodNetwork = parsePcNetwork(lastGoodNetwork);
  return output;
}
export function rewardView(record: Pick<PcObservation, "rewards" | "lastGoodRewards" | "monitoring"> | undefined, now: number) {
  const success = record?.rewards?.status === "ok" ? record.rewards : record?.lastGoodRewards;
  // GPU recorder permissions are independent of a successful authenticated reward read.
  const current = !!success && record?.rewards?.status === "ok" && now >= success.observedAtMs && now < success.observedAtMs + REWARD_FRESH_MS
    && (!record.monitoring || record.monitoring.status === "active" || record.monitoring.status === "unsupported" || record.monitoring.status === "gpu-access-required");
  return { amount: success?.amount ?? null, observedAtMs: success?.observedAtMs ?? null, current,
    status: record?.rewards?.status ?? record?.monitoring?.status ?? "not-enabled" };
}
export function rewardAtoms(amount: string | null | undefined): string | null { return amount && REWARD_AMOUNT.test(amount) ? BigInt(amount.replace(".", "")).toString() : null; }

export function jobGpuConditions(record: PcObservation | undefined, job: { node: string; timeStart: number | null; timeEnd: number | null; state: string; result?: string | null }, now: number, confirmedRunning = false): { label: string; detail: string } {
  const unavailable = (detail: string) => ({ label: "—", detail });
  const gpu = record?.gpu;
  if (!gpu || gpu.address !== job.node || record?.address !== job.node || !gpu.samples.length) return unavailable("No recorded GPU samples for this host and job interval.");
  if (!gpu.clockTrusted || gpu.toAtMs > now + 5000) return unavailable("PC observation time is untrusted; job association is unavailable.");
  if (job.state === "QUEUED" || job.state === "RUNNING" && ((job.timeEnd ?? 0) > 0 || job.result != null)) return unavailable("Job lifecycle and timing do not establish a consistent execution interval.");
  if (job.state === "RUNNING" && !confirmedRunning) return unavailable("The running assignment is not currently confirmed and has no verified end time; newer GPU samples are not assigned to this historical record.");
  if (job.timeStart === null || !Number.isSafeInteger(job.timeStart) || job.timeStart <= 0) return unavailable("This job has no verified start time.");
  const start = job.timeStart * 1000;
  const end = job.timeEnd !== null && job.timeEnd > 0 ? job.timeEnd * 1000 : job.state === "RUNNING" ? Math.min(now, gpu.toAtMs) : null;
  if (!time(start) || end === null || !time(end) || end < start) return unavailable("This job has no valid observation interval.");
  const samples = gpu.samples.filter(sample => sample[0] >= start && sample[0] <= end);
  if (!samples.length) return unavailable("No GPU samples overlap this job. Earlier unrecorded intervals remain unknown.");
  const active = GPU_REASON_LABELS.map((_, index) => samples.some(sample => sample[3] & (1 << index)));
  const supported = GPU_REASON_LABELS.filter((_, index) => samples.some(sample => sample[2] & (1 << index)));
  let gap = 0;
  let partial = gpu.truncated;
  const durationUs = [0, 0, 0, 0];
  const counterIntervals = [0, 0, 0, 0];
  let resets = 0;
  for (let device = 0; device < gpu.gpuUuids.length; device++) {
    const readings = samples.filter(sample => sample[1] === device);
    if (!readings.length || readings[0]![0] > start + 15_000 || readings.at(-1)![0] < end - 15_000) partial = true;
    for (let i = 1; i < readings.length; i++) {
      const previous = readings[i - 1]!, current = readings[i]!, elapsed = current[0] - previous[0];
      gap = Math.max(gap, elapsed);
      for (let reason = 0; reason < 4; reason++) {
        const before = previous[reason + 4], after = current[reason + 4];
        if (typeof before !== "number" || typeof after !== "number") continue;
        if (after < before) { resets++; continue; }
        const delta = after - before;
        if (elapsed <= 0 || elapsed > 37_500 || delta > elapsed * 2000) continue;
        counterIntervals[reason]!++;
        durationUs[reason]! += delta;
        if (delta > 0) active[reason] = true;
      }
    }
  }
  partial ||= gap > 22_500;
  const hits = GPU_REASON_LABELS.filter((_, index) => active[index]);
  const label = hits.length ? hits.join("; ") : supported.length || counterIntervals.some(count => count > 0) ? "No events in samples" : "Unsupported";
  return { label, detail: `${hits.length ? "Observed during this job: " + hits.join(", ") : "No active supported flags in the recorded samples"}.\n` +
    `Verified node GPU allocation: ${gpu.gpuUuids.join(", ")}.\n${samples.length} samples from ${new Date(samples[0]![0]).toISOString()} to ${new Date(samples.at(-1)![0]).toISOString()}.\n` +
    `${partial ? "Partial coverage" : "Sampled coverage"}; largest interior gap ${gap / 1000}s. Unsupported reasons and unobserved intervals remain unknown.\n` +
    `${GPU_REASON_LABELS.map((label, index) => `${label} counter increase within verified intervals: ${counterIntervals[index] ? `${(durationUs[index]! / 1_000_000).toFixed(3)}s` : "unavailable"}`).join("; ")}. ${resets} counter resets excluded.\n` +
    "Association uses the verified host/GPU allocation and reported job interval; it does not establish which operation caused throttling or a job failure." };
}
