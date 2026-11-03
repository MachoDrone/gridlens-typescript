import { GPU_UUID, parseBinding, sameBinding, time } from "./pc-observations.ts";
import type { NodeBinding } from "./pc-observations.ts";
import type { PcAssociation } from "../contracts/shared.ts";

export const GPU_REFRESH_MS = 5 * 60_000;
export const GPU_FRESH_MS = 6 * 60_000;
export const GPU_BOOT_ID = /^[a-f0-9]{32}$/;
export const GPU_PCI_ID = /^[a-f0-9]{4}:[a-f0-9]{2}:[a-f0-9]{2}(?:\.[0-7])?$/;
export interface PcGpuDevice {
  uuid: string; index: number | null; pciBusId: string | null; observedAtMs: number;
  status: "responds" | "inaccessible" | "query-failed" | "unavailable";
}
export interface PcGpuAllocation {
  address: string; binding: NodeBinding; observedAtMs: number;
  status: "ok" | "changed" | "unavailable"; gpuUuids: string[];
}
export interface PcGpuEvent { bootId: string; pciBusId: string; xid: number; atMs: number; gpuUuid: string | null }
export interface PcGpuObservation {
  schema: 1; source: "pc-nvidia-smi"; observedAtMs: number; bootId: string | null;
  status: "ok" | "partial" | "query-failed" | "unavailable" | "boot-changed";
  devices: PcGpuDevice[]; allocations: PcGpuAllocation[];
  journal: { status: "ok" | "unavailable" | "truncated"; events: PcGpuEvent[] };
}
export interface PcGpuUpdate { pcId: string; sshFingerprint: string; approvalAtMs: number; gpu: PcGpuObservation }
export interface PcGpuRecord extends PcGpuUpdate {
  receivedAtMs: number; lastGood?: PcGpuObservation; retainedEvents?: PcGpuEvent[];
  retainedMappings?: { bootId: string; device: PcGpuDevice }[];
  retainedAllocations?: PcGpuAllocation[];
}
function object(value: unknown, fields: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || fields.some(field => !Object.hasOwn(value, field))
    || Object.keys(value).some(field => !fields.includes(field) && !optional.includes(field))) throw new Error("Invalid PC GPU fields.");
  return value as Record<string, unknown>;
}
function list<T>(value: unknown, maximum: number, parse: (row: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error("Invalid PC GPU list.");
  return value.map(parse);
}
function unique(values: unknown[]): boolean { return new Set(values).size === values.length; }
function uuid(value: unknown): value is string { return typeof value === "string" && GPU_UUID.test(value); }
function timestamp(value: unknown): value is number { return time(value) && value > 0; }
function parseDevice(value: unknown): PcGpuDevice {
  const row = object(value, ["uuid", "index", "pciBusId", "observedAtMs", "status"]);
  if (!uuid(row.uuid) || !timestamp(row.observedAtMs) || !["responds", "inaccessible", "query-failed", "unavailable"].includes(String(row.status))) throw new Error("Invalid PC GPU device.");
  if (row.status === "responds" ? !Number.isSafeInteger(row.index) || (row.index as number) < 0 || (row.index as number) > 1023
    || typeof row.pciBusId !== "string" || !GPU_PCI_ID.test(row.pciBusId) || !row.pciBusId.includes(".")
    : row.index !== null || row.pciBusId !== null) throw new Error("Invalid PC GPU identity.");
  return { ...row } as unknown as PcGpuDevice;
}
function parseAllocation(value: unknown): PcGpuAllocation {
  const row = object(value, ["address", "binding", "observedAtMs", "status", "gpuUuids"]);
  const gpuUuids = list(row.gpuUuids, 64, value => { if (!uuid(value)) throw new Error("Invalid allocated GPU UUID."); return value; });
  if (typeof row.address !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(row.address) || !timestamp(row.observedAtMs)
    || !["ok", "changed", "unavailable"].includes(String(row.status)) || !unique(gpuUuids)
    || (row.status === "ok" ? !gpuUuids.length : gpuUuids.length !== 0)) throw new Error("Invalid GPU allocation.");
  return { address: row.address, binding: parseBinding(row.binding), observedAtMs: row.observedAtMs,
    status: row.status as PcGpuAllocation["status"], gpuUuids };
}
export function parsePcGpuEvent(value: unknown): PcGpuEvent {
  const row = object(value, ["bootId", "pciBusId", "xid", "atMs", "gpuUuid"]);
  if (typeof row.bootId !== "string" || !GPU_BOOT_ID.test(row.bootId) || typeof row.pciBusId !== "string" || !GPU_PCI_ID.test(row.pciBusId)
    || !Number.isSafeInteger(row.xid) || (row.xid as number) < 1 || (row.xid as number) > 99999 || !timestamp(row.atMs)
    || row.gpuUuid !== null && !uuid(row.gpuUuid)) throw new Error("Invalid GPU fault event.");
  return { ...row } as unknown as PcGpuEvent;
}
export function parsePcGpu(value: unknown): PcGpuObservation {
  const row = object(value, ["schema", "source", "observedAtMs", "bootId", "status", "devices", "allocations", "journal"]);
  if (row.schema !== 1 || row.source !== "pc-nvidia-smi" || !timestamp(row.observedAtMs)
    || row.bootId !== null && (typeof row.bootId !== "string" || !GPU_BOOT_ID.test(row.bootId))
    || !["ok", "partial", "query-failed", "unavailable", "boot-changed"].includes(String(row.status))) throw new Error("Invalid PC GPU observation.");
  const devices = list(row.devices, 64, parseDevice), allocations = list(row.allocations, 512, parseAllocation);
  const journal = object(row.journal, ["status", "events"]), events = list(journal.events, 128, parsePcGpuEvent);
  if (!["ok", "unavailable", "truncated"].includes(String(journal.status)) || journal.status === "unavailable" && events.length
    || events.some(event => event.bootId !== row.bootId || event.atMs > (row.observedAtMs as number) + 5000)
    || !unique(devices.map(device => device.uuid)) || !unique(allocations.map(allocation => allocation.address))
    || !unique(devices.filter(device => device.status === "responds").map(device => device.index))
    || !unique(devices.filter(device => device.status === "responds").map(device => device.pciBusId))
    || [...devices, ...allocations].some(item => item.observedAtMs > (row.observedAtMs as number))
    || (row.bootId === null || row.status === "boot-changed") && (devices.some(device => device.status === "responds") || allocations.some(allocation => allocation.status === "ok"))
    || row.status === "ok" && (!devices.length || devices.some(device => device.status !== "responds") || allocations.some(allocation => allocation.status !== "ok"))) throw new Error("Inconsistent PC GPU observation.");
  return { schema: 1, source: "pc-nvidia-smi", observedAtMs: row.observedAtMs, bootId: row.bootId as string | null,
    status: row.status as PcGpuObservation["status"], devices, allocations, journal: { status: journal.status as PcGpuObservation["journal"]["status"], events } };
}
export function parsePcGpuUpdate(value: unknown): PcGpuUpdate {
  const row = object(value, ["pcId", "sshFingerprint", "approvalAtMs", "gpu"]), gpu = parsePcGpu(row.gpu);
  if (typeof row.pcId !== "string" || !/^[a-f0-9]{64}$/.test(row.pcId) || typeof row.sshFingerprint !== "string"
    || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(row.sshFingerprint) || !timestamp(row.approvalAtMs)
    || gpu.observedAtMs < row.approvalAtMs || [...gpu.devices, ...gpu.allocations].some(item => item.observedAtMs < (row.approvalAtMs as number))
    || gpu.allocations.some(allocation => allocation.binding.pcId !== row.pcId)) throw new Error("Invalid PC GPU source identity.");
  return { pcId: row.pcId, sshFingerprint: row.sshFingerprint, approvalAtMs: row.approvalAtMs, gpu };
}
export function parsePcGpuRecord(value: unknown): PcGpuRecord {
  const row = object(value, ["pcId", "sshFingerprint", "approvalAtMs", "gpu", "receivedAtMs"], ["lastGood", "retainedEvents", "retainedMappings", "retainedAllocations"]);
  if (!timestamp(row.receivedAtMs)) throw new Error("Invalid PC GPU receipt time.");
  const output: PcGpuRecord = { ...parsePcGpuUpdate({ pcId: row.pcId, sshFingerprint: row.sshFingerprint, approvalAtMs: row.approvalAtMs, gpu: row.gpu }), receivedAtMs: row.receivedAtMs };
  if (row.lastGood !== undefined) {
    output.lastGood = parsePcGpuUpdate({ pcId: row.pcId, sshFingerprint: row.sshFingerprint, approvalAtMs: row.approvalAtMs, gpu: row.lastGood }).gpu;
    if (output.lastGood.status !== "ok" || output.lastGood.observedAtMs > output.gpu.observedAtMs) throw new Error("Invalid retained GPU observation.");
  }
  if (row.retainedEvents !== undefined) {
    output.retainedEvents = list(row.retainedEvents, 128, parsePcGpuEvent);
    if (output.retainedEvents.some(event => event.atMs > output.gpu.observedAtMs + 5000)) throw new Error("Invalid retained GPU event time.");
  }
  if (row.retainedMappings !== undefined) {
    output.retainedMappings = list(row.retainedMappings, 64, value => {
      const mapping = object(value, ["bootId", "device"]), device = parseDevice(mapping.device);
      if (typeof mapping.bootId !== "string" || !GPU_BOOT_ID.test(mapping.bootId) || device.status !== "responds"
        || device.observedAtMs < output.approvalAtMs || device.observedAtMs > output.gpu.observedAtMs) throw new Error("Invalid retained GPU mapping.");
      return { bootId: mapping.bootId, device };
    });
    if (!unique(output.retainedMappings.map(mapping => mapping.device.uuid))) throw new Error("Duplicate retained GPU mapping.");
  }
  if (row.retainedAllocations !== undefined) {
    output.retainedAllocations = list(row.retainedAllocations, 64, parseAllocation);
    if (!unique(output.retainedAllocations.map(allocation => allocation.address)) || output.retainedAllocations.some(allocation => allocation.status !== "ok"
      || allocation.binding.pcId !== output.pcId || allocation.observedAtMs < output.approvalAtMs || allocation.observedAtMs > output.gpu.observedAtMs)) throw new Error("Invalid retained GPU allocation.");
  }
  return output;
}

/** Device access, allocation, historical Xids and freshness are separate evidence.
 * A successful query does not establish workload health or clear an older Xid. */
export function pcGpuView(record: PcGpuRecord | undefined, association: PcAssociation | undefined, now: number, transportFailed = false) {
  const matching = record && association && record.pcId === association.binding.pcId && record.sshFingerprint === association.sshFingerprint ? record : undefined;
  const latest = matching?.gpu;
  const allocation = latest?.allocations.find(row => row.address === association?.address && sameBinding(row.binding, association.binding));
  const fresh = (at: number) => now >= at && now < at + GPU_FRESH_MS;
  const sameUuids = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  const allocationMatches = allocation?.status === "ok" && (!association?.gpuUuids.length || sameUuids(allocation.gpuUuids, association.gpuUuids));
  const currentAllocation = allocationMatches && !!latest?.bootId && latest.status !== "boot-changed" && fresh(allocation.observedAtMs)
    && allocation.observedAtMs >= association!.verifiedAtMs && !transportFailed;
  const previous = matching?.lastGood;
  const previousAllocation = matching?.retainedAllocations?.find(row => row.address === association?.address && sameBinding(row.binding, association.binding))
    ?? previous?.allocations.find(row => row.address === association?.address && sameBinding(row.binding, association.binding));
  const expected = allocationMatches ? allocation.gpuUuids : association?.gpuUuids.length ? association.gpuUuids : previousAllocation?.gpuUuids ?? [];
  const devices = (latest?.devices ?? []).filter(device => expected.includes(device.uuid));
  const available = currentAllocation ? devices.filter(device => device.status === "responds" && fresh(device.observedAtMs)) : [];
  const indices = available.map(device => device.index!).sort((a, b) => a - b);
  const current = !!currentAllocation && !!expected.length && available.length === expected.length;
  const retained = new Map<string, PcGpuDevice>();
  const historicalDevices = matching?.retainedMappings?.map(mapping => mapping.device) ?? previous?.devices ?? [];
  if (previousAllocation?.status === "ok") for (const device of historicalDevices) {
    if (previousAllocation.gpuUuids.includes(device.uuid) && (expected.includes(device.uuid) || !expected.length && !association?.gpuUuids.length)
      && device.status === "responds" && now >= device.observedAtMs) retained.set(device.uuid, device);
  }
  if (allocationMatches) for (const device of devices) {
    if (device.status === "responds" && now >= device.observedAtMs) retained.set(device.uuid, device);
  }
  for (const device of available) retained.delete(device.uuid);
  const retainedDevices = [...retained.values()].sort((a, b) => a.index! - b.index!);
  const retainedIndices = retainedDevices.map(device => device.index!);
  const allEvents = matching?.retainedEvents ?? latest?.journal.events ?? [];
  const events = allEvents.filter(event => event.gpuUuid !== null && expected.includes(event.gpuUuid));
  const pcEvents = allEvents.filter(event => event.gpuUuid === null);
  return { indices, retainedIndices, retainedDevices, gpuUuids: expected, expectedCount: expected.length, current, partial: indices.length > 0 && !current,
    observedAtMs: available.length ? Math.min(...available.map(device => device.observedAtMs)) : retainedDevices.length ? Math.min(...retainedDevices.map(device => device.observedAtMs)) : null,
    attemptedAtMs: latest?.observedAtMs ?? null, devices, events, pcEvents,
    journalStatus: latest?.journal.status ?? "unavailable", allocationStatus: allocation?.status ?? "unavailable" };
}
