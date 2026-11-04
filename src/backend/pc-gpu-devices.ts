import type { PcAssociation } from "../contracts/shared.ts";
import { GPU_UUID } from "../fleet/pc-observations.ts";
import { GPU_BOOT_ID, parsePcGpu } from "../fleet/pc-gpu-devices.ts";
import type { PcGpuAllocation, PcGpuDevice, PcGpuEvent, PcGpuObservation } from "../fleet/pc-gpu-devices.ts";
import type { SshRun } from "./ssh.ts";
import { createGpuRuntimeBindingReader, gpuAllocationCommand } from "./gpu-runtime-binding.ts";

export const PC_GPU_COMMAND = "/usr/bin/nvidia-smi --query-gpu=index,uuid,pci.bus_id --format=csv,noheader,nounits";
export const PC_GPU_BOOT_COMMAND = "/bin/cat /proc/sys/kernel/random/boot_id";
export const PC_GPU_JOURNAL_PROBE = "/usr/bin/journalctl --dmesg --boot=0 --no-pager --quiet --lines=1 --output=json --output-fields=_BOOT_ID,_TRANSPORT";
export const PC_GPU_JOURNAL_COMMAND = "/usr/bin/journalctl --dmesg --boot=0 --no-pager --quiet --lines=257 --output=json --output-fields=_BOOT_ID,_TRANSPORT,MESSAGE --grep='^NVRM: (GPU at |Xid )'";
const normalizeUuid = (value: string) => value.trim().toLowerCase().replace(/^gpu-/, "GPU-");
export function normalizeGpuPci(value: string): string | null {
  const match = /^(?:0000)?([a-f0-9]{4}):([a-f0-9]{2}):([a-f0-9]{2})(\.[0-7])?$/i.exec(value.trim());
  return match ? `${match[1]}:${match[2]}:${match[3]}${match[4] ?? ""}`.toLowerCase() : null;
}
/** Keep independent valid rows when NVML reports an error for a different GPU.
 * Conflicting UUID, index or PCI identities never produce a guessed mapping. */
export function parsePcGpuInventory(output: string, at: number): { devices: PcGpuDevice[]; partial: boolean } {
  if (Buffer.byteLength(output) > 16_384 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(output)) return { devices: [], partial: true };
  const rows: PcGpuDevice[] = []; let partial = false;
  for (const line of output.trim().split(/\r?\n/).filter(Boolean)) {
    const fields = line.split(",").map(value => value.trim()), pci = normalizeGpuPci(fields[2] ?? ""), uuid = normalizeUuid(fields[1] ?? "");
    if (fields.length !== 3 || !/^(?:0|[1-9][0-9]{0,3})$/.test(fields[0]!) || Number(fields[0]) > 1023 || !GPU_UUID.test(uuid) || !pci?.includes(".")) { partial = true; continue; }
    rows.push({ uuid, index: Number(fields[0]), pciBusId: pci, observedAtMs: at, status: "responds" });
  }
  if (rows.length > 64) return { devices: [], partial: true };
  const devices = rows.filter((row, index) => !rows.some((other, otherIndex) => otherIndex !== index &&
    (row.uuid === other.uuid || row.index === other.index || row.pciBusId === other.pciBusId)));
  return { devices, partial: partial || devices.length !== rows.length || !rows.length };
}
function boot(output: string): string | null {
  const id = output.trim().toLowerCase().replaceAll("-", "");
  return GPU_BOOT_ID.test(id) ? id : null;
}

/** NVIDIA documents the UUID preamble preceding the first Xid. Only that
 * same-boot kernel evidence attributes an event to a GPU; current PCI inventory
 * cannot retroactively identify hardware that occupied a slot in the past.
 * https://docs.nvidia.com/deploy/xid-errors/working-with-xid-errors.html */
export function parsePcGpuJournal(output: string, bootId: string, observedAtMs: number): PcGpuObservation["journal"] {
  const unavailable: PcGpuObservation["journal"] = { status: "unavailable", events: [] };
  if (Buffer.byteLength(output) > 262_144) return unavailable;
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length > 257) return unavailable;
  const records: { atMs: number; monotonic: number; message: string }[] = [];
  try {
    for (const line of lines) {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (row._BOOT_ID !== bootId || row._TRANSPORT !== "kernel" || typeof row.MESSAGE !== "string" || row.MESSAGE.length > 4096
        || typeof row.__REALTIME_TIMESTAMP !== "string" || !/^[0-9]{1,17}$/.test(row.__REALTIME_TIMESTAMP)
        || typeof row.__MONOTONIC_TIMESTAMP !== "string" || !/^[0-9]{1,16}$/.test(row.__MONOTONIC_TIMESTAMP)) return unavailable;
      const atMs = Math.floor(Number(row.__REALTIME_TIMESTAMP) / 1000), monotonic = Number(row.__MONOTONIC_TIMESTAMP);
      if (!Number.isSafeInteger(atMs) || atMs <= 0 || atMs > observedAtMs + 5000 || !Number.isSafeInteger(monotonic)) return unavailable;
      records.push({ atMs, monotonic, message: row.MESSAGE });
    }
  } catch { return unavailable; }
  const identities = new Map<string, string>(), events: PcGpuEvent[] = [];
  for (const row of records.sort((a, b) => a.monotonic - b.monotonic)) {
    const identity = /^NVRM: GPU at (?:PCI:)?([a-f0-9:.]+): (GPU-[a-f0-9-]+)(?:\s|$)/i.exec(row.message);
    if (identity) {
      const pci = normalizeGpuPci(identity[1]!), uuid = normalizeUuid(identity[2]!);
      if (pci && GPU_UUID.test(uuid)) identities.set(pci, uuid);
      continue;
    }
    const match = /^NVRM: Xid \((?:PCI:)?([a-f0-9:.]+)\): ([1-9][0-9]{0,4})(?:,|\s|$)/i.exec(row.message);
    if (!match) continue;
    const pci = normalizeGpuPci(match[1]!); if (!pci) continue;
    events.push({ bootId, pciBusId: pci, xid: Number(match[2]), atMs: row.atMs, gpuUuid: identities.get(pci) ?? null });
  }
  return { status: lines.length === 257 || events.length > 128 ? "truncated" : "ok", events: events.slice(-128) };
}

export async function readPcGpuDevices(run: SshRun, allocatedRun: SshRun, associations: PcAssociation[], now = Date.now): Promise<PcGpuObservation> {
  const deadline = performance.now() + 25_000;
  const bounded = (reader: SshRun): SshRun => (command, options) => {
    const left = Math.floor(deadline - performance.now());
    if (left < 1) return Promise.reject(new Error("GPU observation deadline exceeded."));
    return reader(command, { ...options, timeoutMs: Math.min(left, options?.timeoutMs ?? 3000) });
  };
  const host = bounded(run), allocated = bounded(allocatedRun);
  const devices = new Map<string, PcGpuDevice>(), allocations: PcGpuAllocation[] = [];
  let bootId: string | null = null, partial = false, journal: PcGpuObservation["journal"] = { status: "unavailable", events: [] };
  const selected = associations.slice(0, 64);
  const runtimeBindings = selected.length ? createGpuRuntimeBindingReader(allocated, selected[0]!.binding.pcId) : undefined;
  // The cap bounds both SSH work and per-PC payloads. Remaining associations do
  // not acquire an inferred allocation or borrowed mapping.
  partial = associations.length > selected.length;
  try { const value = await host(PC_GPU_BOOT_COMMAND, { maximum: 128 }); if (value.code === 0) bootId = boot(value.stdout); } catch { /* unavailable */ }
  if (bootId) {
    try {
      const value = await host(PC_GPU_COMMAND, { maximum: 16_384, timeoutMs: 5000 });
      const parsed = parsePcGpuInventory(value.stdout, now()); partial ||= parsed.partial || value.code !== 0 || value.stderrPresent === true;
      for (const device of parsed.devices) devices.set(device.uuid, device);
    } catch { partial = true; }
    for (const association of selected) {
      const result: PcGpuAllocation = { address: association.address, binding: association.binding, observedAtMs: now(), status: "unavailable", gpuUuids: [] };
      try {
        const observedBinding = await runtimeBindings!.resolve(association);
        if (observedBinding) {
          result.observedBinding = observedBinding;
          const visible = await allocated(gpuAllocationCommand(observedBinding), { maximum: 8192 });
          const uuids = visible.stdout.trim().split(/\r?\n/).filter(Boolean).map(normalizeUuid).sort();
          if (visible.code === 0 && !visible.stderrPresent && uuids.length > 0 && uuids.length <= 64 && uuids.every(uuid => GPU_UUID.test(uuid)) && new Set(uuids).size === uuids.length) {
            // An initially unavailable allocation can be measured once the exact
            // approved container/public identity responds. A changed known set
            // remains a mismatch until setup re-verifies the association.
            if (!association.gpuUuids.length || JSON.stringify(uuids) === JSON.stringify([...association.gpuUuids].sort())) { result.status = "ok"; result.gpuUuids = uuids; }
            else result.status = "changed";
          }
        }
      } catch { /* Do not forward remote diagnostics. */ }
      result.observedAtMs = now(); allocations.push(result);
    }
    const expected = [...new Set([...selected.flatMap(row => row.gpuUuids), ...allocations.flatMap(row => row.gpuUuids)])].filter(uuid => GPU_UUID.test(uuid)).slice(0, 64);
    for (const uuid of expected) {
      if (devices.has(uuid)) continue;
      const device: PcGpuDevice = { uuid, index: null, pciBusId: null, observedAtMs: now(), status: "unavailable" };
      try {
        const value = await host(`${PC_GPU_COMMAND} --id=${uuid}`, { maximum: 4096 });
        const parsed = parsePcGpuInventory(value.stdout, now());
        if (value.code === 0 && !value.stderrPresent && !parsed.partial && parsed.devices.length === 1 && parsed.devices[0]!.uuid === uuid) Object.assign(device, parsed.devices[0]);
        else device.status = value.code === 15 ? "inaccessible" : "query-failed";
      } catch { /* deadline/transport failure is not GPU fault evidence */ }
      devices.set(uuid, device);
    }
    // A targeted response may conflict with a different bulk row. Quarantine
    // every colliding identity rather than assigning one physical slot twice.
    const responding = [...devices.values()].filter(device => device.status === "responds");
    for (const device of responding) if (responding.some(other => other.uuid !== device.uuid && (other.index === device.index || other.pciBusId === device.pciBusId))) {
      devices.set(device.uuid, { ...device, index: null, pciBusId: null, status: "query-failed" }); partial = true;
    }
    try {
      // An empty restricted journal is not evidence of log access. Require a
      // current-boot kernel record before treating an empty match as readable.
      const probe = await allocated(PC_GPU_JOURNAL_PROBE, { maximum: 4096 });
      const row = probe.code === 0 && !probe.stderrPresent ? JSON.parse(probe.stdout.trim()) as Record<string, unknown> : undefined;
      if (row?._BOOT_ID === bootId && row._TRANSPORT === "kernel") {
        const value = await allocated(PC_GPU_JOURNAL_COMMAND, { maximum: 262_144, timeoutMs: 5000 });
        if (!value.stderrPresent && (value.code === 0 || value.code === 1 && value.stdout.trim() === "")) journal = parsePcGpuJournal(value.stdout, bootId, now());
      }
    } catch { /* No log installation, group changes, or unbounded fallback. */ }
  }
  let endBoot: string | null = null;
  try { const value = await run(PC_GPU_BOOT_COMMAND, { maximum: 128, timeoutMs: 2000 }); if (value.code === 0) endBoot = boot(value.stdout); } catch { /* fence failed */ }
  const fenced = bootId !== null && endBoot === bootId;
  if (!fenced) {
    devices.clear(); for (const allocation of allocations) { allocation.status = "unavailable"; allocation.gpuUuids = []; delete allocation.observedBinding; }
    journal = { status: "unavailable", events: [] };
  }
  const readings = [...devices.values()].slice(0, 64), responds = readings.filter(device => device.status === "responds").length;
  const status: PcGpuObservation["status"] = !fenced ? bootId && endBoot && bootId !== endBoot ? "boot-changed" : "unavailable"
    : !responds ? "query-failed" : partial || readings.some(device => device.status !== "responds") || allocations.some(row => row.status !== "ok") ? "partial" : "ok";
  return parsePcGpu({ schema: 1, source: "pc-nvidia-smi", observedAtMs: now(), bootId: fenced ? bootId : endBoot,
    status, devices: readings, allocations, journal });
}
