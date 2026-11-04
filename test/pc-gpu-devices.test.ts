import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import ssh2 from "ssh2";
import { PC_GPU_BOOT_COMMAND, PC_GPU_COMMAND, PC_GPU_JOURNAL_COMMAND, PC_GPU_JOURNAL_PROBE, parsePcGpuInventory, parsePcGpuJournal, readPcGpuDevices } from "../src/backend/pc-gpu-devices.ts";
import { GPU_FRESH_MS, GPU_REFRESH_MS, parsePcGpu, parsePcGpuRecord, pcGpuView } from "../src/fleet/pc-gpu-devices.ts";
import type { PcGpuObservation, PcGpuRecord } from "../src/fleet/pc-gpu-devices.ts";
import type { PcAssociation } from "../src/contracts/shared.ts";
import { parseSharedObservations } from "../src/contracts/shared.ts";
import type { FleetContext } from "../src/contracts/fleet.ts";
import type { SshRun } from "../src/backend/ssh.ts";
import { fingerprint as sshFingerprint, withSsh } from "../src/backend/ssh.ts";
import { createPcMonitor } from "../src/backend/pc-monitor.ts";
import type { PcPermission } from "../src/backend/pc-monitor.ts";
import { createObservationStore } from "../src/backend/observations.ts";
import { openSharedState } from "../src/backend/sqlite-state.ts";
import { openCredentialVault } from "../src/backend/credential-vault.ts";

const base = 1_800_000_000_000, pcId = "a".repeat(64), bootId = "b".repeat(32), fingerprint = "SHA256:" + "A".repeat(43);
const uuids = ["GPU-11111111-1111-1111-1111-111111111111", "GPU-22222222-2222-2222-2222-222222222222", "GPU-33333333-3333-3333-3333-333333333333"];
const addresses = ["1".repeat(31) + "2", "1".repeat(31) + "3", "1".repeat(31) + "4"];
const associations: PcAssociation[] = addresses.map((address, index) => ({ address,
  binding: { pcId, runtime: "docker", wrapperId: null, nodeContainerId: (index + 1).toString(16).repeat(64) },
  name: "Generated three-GPU PC", sshFingerprint: fingerprint, verifiedAtMs: base - 1000, privateIp: "10.0.0.2", gpuUuids: [uuids[index]!] }));
const csv = `4, ${uuids[0]}, 00000000:06:00.0\n1, ${uuids[1]}, 00000000:07:00.0\n2, ${uuids[2]}, 00000000:08:00.0\n`;
const context: FleetContext = { scopeId: "generated", rosterRevision: "one", addresses };
function event(message: string, offset = 0, id = bootId) {
  return JSON.stringify({ _BOOT_ID: id, _TRANSPORT: "kernel", MESSAGE: message,
    __REALTIME_TIMESTAMP: String((base - 10_000 + offset) * 1000), __MONOTONIC_TIMESTAMP: String(1_000_000 + offset * 1000) });
}
// Formats independently specified by NVIDIA's Xid guide; identifiers and times
// are generated. No source key, raw production log or real inventory is used.
const journal = [event(`NVRM: GPU at 0000:06:00: ${uuids[0]}`), event("NVRM: Xid (PCI:0000:06:00): 79, GPU has fallen off the bus.", 1)].join("\n");
function good(at = base): PcGpuObservation {
  return { schema: 1, source: "pc-nvidia-smi", observedAtMs: at, bootId, status: "ok",
    devices: parsePcGpuInventory(csv, at).devices,
    allocations: associations.map(row => ({ address: row.address, binding: row.binding, observedAtMs: at, status: "ok", gpuUuids: [...row.gpuUuids] })),
    journal: { status: "ok", events: [] } };
}
function record(gpu = good()): PcGpuRecord { return { pcId, sshFingerprint: fingerprint, approvalAtMs: base - 1000, receivedAtMs: base, gpu, lastGood: good() }; }
function reader(options: { bulk?: { code: number; stdout: string }; targeted?: Record<string, { code: number; stdout: string }>; visible?: Record<string, string>; bootChanged?: boolean; logs?: string; logDenied?: boolean } = {}) {
  const commands: string[] = [], elevated: string[] = []; let bootReads = 0;
  const host: SshRun = async (command, bounds) => {
    commands.push(command); assert.ok(bounds?.maximum && bounds.timeoutMs && bounds.timeoutMs <= 5000);
    if (command === PC_GPU_BOOT_COMMAND) return { code: 0, stdout: options.bootChanged && ++bootReads > 1 ? "c".repeat(32) : bootId };
    if (command === PC_GPU_COMMAND) return options.bulk ?? { code: 0, stdout: csv };
    const uuid = command.split(" --id=")[1];
    if (uuid) return options.targeted?.[uuid] ?? { code: 15, stdout: "Generated diagnostic must not leave reader" };
    throw Error("Unexpected host command");
  };
  const allocated: SshRun = async (command, bounds) => {
    elevated.push(command); assert.ok(bounds?.maximum && bounds.timeoutMs && bounds.timeoutMs <= 5000);
    if (command === PC_GPU_JOURNAL_PROBE) return options.logDenied ? { code: 1, stdout: "" } : { code: 0, stdout: JSON.stringify({ _BOOT_ID: bootId, _TRANSPORT: "kernel" }) };
    if (command === PC_GPU_JOURNAL_COMMAND) return { code: 0, stdout: options.logs ?? "" };
    const association = associations.find(row => command.includes(row.binding.nodeContainerId)); assert.ok(association);
    if (command.includes(" inspect ")) return { code: 0, stdout: `${association.binding.nodeContainerId}\ttrue\tnosana/nosana-node:fixture` };
    if (command.includes("--query-gpu=uuid")) return { code: 0, stdout: options.visible?.[association.address] ?? association.gpuUuids.join("\n") };
    return { code: 0, stdout: association.address };
  };
  return { host, allocated, commands, elevated };
}

test("physical inventory normalizes PCI domains, retains independent rows and quarantines conflicting identities", () => {
  const parsed = parsePcGpuInventory(csv, base);
  assert.deepEqual(parsed.devices.map(row => [row.uuid, row.index, row.pciBusId]), [[uuids[0], 4, "0000:06:00.0"], [uuids[1], 1, "0000:07:00.0"], [uuids[2], 2, "0000:08:00.0"]]);
  assert.equal(parsed.partial, false);
  assert.equal(parsePcGpuInventory(csv + "Unknown Error\n", base).devices.length, 3);
  assert.equal(parsePcGpuInventory(csv + `9, ${uuids[0]}, 0000:09:00.0\n`, base).devices.length, 2);
  assert.equal(parsePcGpuInventory(csv + `4, GPU-44444444-4444-4444-4444-444444444444, 0000:10:00.0\n`, base).devices.length, 2);
  for (const invalid of ["0, GPU-malformed, 0000:06:00.0", csv + "\0", "x".repeat(16385)]) assert.deepEqual(parsePcGpuInventory(invalid, base).devices, []);
});

test("bounded approved reads map multiple hosts by UUID and verify allocation separately from physical indices", async () => {
  const f = reader({ logs: journal }); const output = await readPcGpuDevices(f.host, f.allocated, associations, () => base);
  assert.equal(output.status, "ok"); assert.equal(output.bootId, bootId);
  assert.equal(f.commands.filter(command => command === PC_GPU_COMMAND).length, 1);
  assert.equal(f.elevated.filter(command => command.includes("--query-gpu=uuid")).length, 3);
  assert.ok(f.commands.every(command => !command.includes("sudo") && !command.includes("docker")));
  assert.equal(output.journal.events[0]?.gpuUuid, uuids[0]);
  assert.deepEqual(pcGpuView(record(output), associations[0], base).indices, [4]);
  assert.deepEqual(pcGpuView(record(output), associations[1], base).indices, [1]);
  assert.equal(pcGpuView(record(output), associations[1], base).events.length, 0, "an affected GPU does not become a fault on its healthy peer");
  assert.ok(!f.elevated.some(command => /\b(restart|reset|install|usermod|systemctl)\b/.test(command)));
});

test("one inaccessible device cannot erase healthy GPUs and Unknown Error cannot establish Xid 79", async () => {
  const f = reader({ bulk: { code: 15, stdout: csv.split("\n").slice(1).join("\n") }, logDenied: true });
  const output = await readPcGpuDevices(f.host, f.allocated, associations, () => base);
  assert.equal(output.status, "partial");
  assert.equal(output.devices.find(row => row.uuid === uuids[0])?.status, "inaccessible");
  assert.equal(output.devices.find(row => row.uuid === uuids[0])?.index, null);
  assert.deepEqual(pcGpuView(record(output), associations[1], base).indices, [1]);
  assert.equal(output.journal.status, "unavailable"); assert.equal(output.journal.events.length, 0);
  assert.ok(!JSON.stringify(output).includes("diagnostic"));
  const generic = reader({ bulk: { code: 255, stdout: "Unknown Error" }, targeted: { [uuids[0]!]: { code: 255, stdout: "Unknown Error" } } });
  const failure = await readPcGpuDevices(generic.host, generic.allocated, associations, () => base);
  assert.equal(failure.devices.find(row => row.uuid === uuids[0])?.status, "query-failed"); assert.deepEqual(failure.journal.events, []);
});

test("documented journalctl dmesg commands and exit-zero NVIDIA stderr preserve partial inventory without inventing Xid", async () => {
  // Independent command contract: journalctl documents -k/--dmesg, not
  // --kernel. The observed NVIDIA failure mode exits zero with two valid rows
  // and a device-handle diagnostic on stderr; use generated GPU identities.
  const commands: string[] = [];
  const run: SshRun = async command => {
    commands.push(command);
    if (command === "/bin/cat /proc/sys/kernel/random/boot_id") return { code: 0, stdout: bootId };
    if (command === "/usr/bin/nvidia-smi --query-gpu=index,uuid,pci.bus_id --format=csv,noheader,nounits") return {
      code: 0, stdout: `0, ${uuids[0]}, 00000000:01:00.0\n1, ${uuids[1]}, 00000000:04:00.0\n`, stderrPresent: true };
    if (command === "/usr/bin/journalctl --dmesg --boot=0 --no-pager --quiet --lines=1 --output=json --output-fields=_BOOT_ID,_TRANSPORT")
      return { code: 0, stdout: JSON.stringify({ _BOOT_ID: bootId, _TRANSPORT: "kernel" }) };
    if (command === "/usr/bin/journalctl --dmesg --boot=0 --no-pager --quiet --lines=257 --output=json --output-fields=_BOOT_ID,_TRANSPORT,MESSAGE --grep='^NVRM: (GPU at |Xid )'")
      return { code: 1, stdout: "", stderrPresent: false };
    assert.fail(`Command is outside independently specified read contract: ${command}`);
  };
  const output = await readPcGpuDevices(run, run, [], () => base);
  assert.equal(commands.length, 5); assert.equal(output.status, "partial");
  assert.deepEqual(output.devices.map(device => [device.index, device.pciBusId]), [[0, "0000:01:00.0"], [1, "0000:04:00.0"]]);
  assert.ok(output.devices.every(device => device.status === "responds"));
  assert.deepEqual(output.journal, { status: "ok", events: [] });
});

test("SSH retains only stderr presence when NVIDIA exits zero with a device diagnostic", async () => {
  const keys = ssh2.utils.generateKeyPairSync("ed25519"), parsed = ssh2.utils.parseKey(keys.private);
  assert.ok(!(parsed instanceof Error)); const publicKey = parsed.getPublicSSH();
  const diagnostic = "Unable to determine the device handle for GPU2: 0000:06:00.0: Unknown Error\nGenerated secret must never leave SSH stderr\n";
  const server = new ssh2.Server({ hostKeys: [keys.private] }, client => {
    client.on("authentication", request => request.accept()).on("ready", () => {
      client.on("session", accept => {
        accept().on("exec", accept => {
          const stream = accept(); stream.write("0, generated public row\n"); stream.stderr.write(diagnostic); stream.exit(0); stream.end();
        });
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  try {
    const result = await withSsh({ id: createHash("sha256").update(publicKey).digest("hex"), host: "127.0.0.1", port: address.port, name: "Generated local SSH fixture",
      fingerprint: sshFingerprint(publicKey), hostKey: publicKey.toString("base64") }, { username: "generated", password: "generated" },
    run => run("/usr/bin/nvidia-smi --query-gpu=index,uuid,pci.bus_id --format=csv,noheader,nounits", { maximum: 4096, timeoutMs: 2000 }));
    assert.deepEqual(result, { code: 0, stdout: "0, generated public row\n", stderrPresent: true });
    assert.ok(!JSON.stringify(result).includes("secret")); assert.ok(!JSON.stringify(result).includes("Unknown Error"));
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("targeted UUID fallback recovers a healthy row without borrowing another GPU's index", async () => {
  const f = reader({ bulk: { code: 255, stdout: "Unknown Error" }, targeted: { [uuids[1]!]: { code: 0, stdout: `1, ${uuids[1]}, 0000:07:00.0` } } });
  const output = await readPcGpuDevices(f.host, f.allocated, associations, () => base);
  assert.deepEqual(output.devices.filter(row => row.status === "responds").map(row => row.uuid), [uuids[1]]);
  assert.equal(f.commands.filter(command => command.includes(" --id=")).length, 3);
  const swapped = reader({ bulk: { code: 1, stdout: "" }, targeted: { [uuids[0]!]: { code: 0, stdout: `1, ${uuids[1]}, 0000:07:00.0` } } });
  assert.equal((await readPcGpuDevices(swapped.host, swapped.allocated, associations, () => base)).devices[0]?.index, null);
});

test("allocation changes and reboot during a read fence current mappings", async () => {
  const changed = reader({ visible: { [addresses[0]!]: uuids[1]! } });
  const output = await readPcGpuDevices(changed.host, changed.allocated, associations, () => base);
  assert.equal(output.allocations[0]?.status, "changed");
  assert.deepEqual(pcGpuView(record(output), associations[0], base).indices, []);
  const reboot = reader({ bootChanged: true, logs: journal });
  const fenced = await readPcGpuDevices(reboot.host, reboot.allocated, associations, () => base);
  assert.equal(fenced.status, "boot-changed"); assert.deepEqual(fenced.devices, []); assert.deepEqual(fenced.journal.events, []);
  assert.ok(fenced.allocations.every(row => row.status === "unavailable"));
});

test("kernel UUID preamble attributes exact Xid codes while unrelated PCI, generic text and another boot do not", () => {
  const parsed = parsePcGpuJournal(journal + "\n" + event("NVRM: Xid (PCI:0000:09:00): 79, GPU has fallen off the bus.", 2)
    + "\n" + event("NVRM: Xid (PCI:0000:06:00): 43, Generated channel error", 3)
    + "\n" + event("NVRM: Unknown Error GPU has fallen off the bus", 4), bootId, base);
  assert.deepEqual(parsed.events.map(row => [row.xid, row.gpuUuid]), [[79, uuids[0]], [79, null], [43, uuids[0]]]);
  assert.equal(parsed.events[0]?.atMs, base - 9999);
  assert.equal(parsePcGpuJournal(event("NVRM: Xid (PCI:0000:06:00): 79, error", 1, "c".repeat(32)), bootId, base).status, "unavailable");
  assert.equal(parsePcGpuJournal("not json", bootId, base).status, "unavailable");
  const truncated = parsePcGpuJournal(Array.from({ length: 257 }, (_, index) => event("NVRM: Xid (PCI:0000:06:00): 43, error", index)).join("\n"), bootId, base);
  assert.equal(truncated.status, "truncated"); assert.equal(truncated.events.length, 128);
});

test("multi-GPU projection preserves exact current and retained dates, boot ordering and clock failures", () => {
  const multi = { ...associations[0]!, gpuUuids: [uuids[0]!, uuids[1]!] }, full = good();
  full.allocations[0]!.gpuUuids = [...multi.gpuUuids];
  const row = record(full); row.lastGood = full;
  assert.deepEqual(pcGpuView(row, multi, base).indices, [1, 4]);
  assert.equal(pcGpuView(row, multi, base).current, true);
  assert.deepEqual(pcGpuView(row, multi, base + GPU_FRESH_MS).indices, []);
  assert.deepEqual(pcGpuView(row, multi, base + GPU_FRESH_MS).retainedIndices, [1, 4]);
  assert.deepEqual(pcGpuView(row, multi, base - 1).retainedIndices, []);
  assert.deepEqual(pcGpuView(row, multi, base, true).indices, []);
  const partial = good(base + 1000); partial.status = "partial"; partial.allocations[0]!.gpuUuids = [...multi.gpuUuids];
  partial.devices[0] = { uuid: uuids[0]!, index: null, pciBusId: null, observedAtMs: base + 1000, status: "inaccessible" };
  const view = pcGpuView({ ...row, gpu: partial }, multi, base + 1000);
  assert.deepEqual(view.indices, [1]); assert.deepEqual(view.retainedIndices, [4]); assert.equal(view.partial, true);
  assert.equal(view.retainedDevices[0]?.observedAtMs, base); assert.equal(view.expectedCount, 2);
  const reordered = good(base + 2000); reordered.bootId = "c".repeat(32); reordered.devices[0]!.index = 0;
  assert.deepEqual(pcGpuView({ ...row, gpu: reordered }, associations[0], base + 2000).indices, [0]);
  assert.deepEqual(pcGpuView(row, { ...associations[0]!, binding: { ...associations[0]!.binding, nodeContainerId: "f".repeat(64) } }, base).indices, []);
  assert.deepEqual(pcGpuView(row, { ...associations[0]!, sshFingerprint: "SHA256:" + "B".repeat(43) }, base).indices, []);
});

async function fixture(approvedAssociations = associations) {
  const root = await mkdtemp(join(tmpdir(), "gridlens-gpu-devices-")); let at = base;
  const state = openSharedState(join(root, "state"), { now: () => at }), vault = openCredentialVault(join(root, "vault"));
  const observations = createObservationStore(state, "generated-server", () => at);
  const permission: PcPermission = { version: 1, computer: { id: pcId, host: "10.0.0.2", port: 22, name: "Generated PC", fingerprint, hostKey: "generated" },
    associations: approvedAssociations, rosterRevision: context.rosterRevision, automaticIp: false, rewards: false, gpu: true, approvedAtMs: base - 1000, revokedAtMs: null, paused: false };
  observations.associate(context, approvedAssociations); state.set(`permission:${context.scopeId}:${pcId}`, permission);
  vault.save(context.scopeId, pcId, { username: "generated", password: "generated" });
  return { state, vault, observations, permission, now: () => at, time: (value: number) => { at = value; },
    update: (gpu: PcGpuObservation) => observations.gpuDevices(context, { pcId, sshFingerprint: fingerprint, approvalAtMs: permission.approvedAtMs, gpu }),
    close: async () => { vault.close(); await state.close(); await rm(root, { recursive: true, force: true }); } };
}

test("GPU store keeps fault history through responsive reads and rollback-compatible namespaces without renewing dates", async () => {
  const f = await fixture();
  try {
    const first = good(); first.journal = parsePcGpuJournal(journal, bootId, base); f.update(first);
    f.time(base + 1000); f.update(good(base + 1000));
    let saved = f.observations.read(context).pcGpuDevices![0]!;
    assert.equal(saved.retainedEvents?.[0]?.atMs, base - 9999);
    assert.equal(pcGpuView(saved, associations[0], base + 1000).events[0]?.xid, 79, "responding does not clear recorded Xid");
    const original = f.state.get<Record<string, unknown>>(`observations:${context.scopeId}:${context.rosterRevision}`)!;
    assert.equal(original.pcGpuDevices, undefined, "old writers do not own the new namespace");
    f.state.set(`observations:${context.scopeId}:${context.rosterRevision}`, { ...original });
    saved = f.observations.read(context).pcGpuDevices![0]!; assert.equal(saved.gpu.observedAtMs, base + 1000);
    assert.throws(() => f.update(good(base)), /source time/);
    f.state.set(`permission:${context.scopeId}:${pcId}`, { ...f.permission, gpu: false });
    assert.deepEqual(f.observations.read(context).pcGpuDevices, []); assert.throws(() => f.update(good(base + 1000)), /Unapproved/);
  } finally { await f.close(); }
});

test("store and shared contracts reject altered bindings, duplicate devices, new approval epochs and invalid timestamps", async () => {
  const f = await fixture();
  try {
    const invalid = good(); invalid.devices.push({ ...invalid.devices[0]! }); assert.throws(() => parsePcGpu(invalid));
    const changed = good(); changed.allocations[0]!.binding = { ...changed.allocations[0]!.binding, nodeContainerId: "f".repeat(64) };
    assert.throws(() => f.update(changed), /allocation source/);
    assert.throws(() => parsePcGpuRecord({ ...record(), approvalAtMs: base + 1 }));
    f.update(good());
    const data = f.observations.read(context);
    assert.throws(() => parseSharedObservations({ ...data, pcGpuDevices: [data.pcGpuDevices![0], data.pcGpuDevices![0]] }, "generated-server", context));
    const old = { ...data }; delete old.pcGpuDevices; assert.equal(parseSharedObservations(old, "generated-server", context).pcGpuDevices, undefined);
    f.state.set(`permission:${context.scopeId}:${pcId}`, { ...f.permission, approvedAtMs: base });
    assert.deepEqual(f.observations.read(context).pcGpuDevices, []);
  } finally { await f.close(); }
});

test("a PC first seen during a partial fault retains each proved mapping when a later query is unavailable", async () => {
  const f = await fixture();
  try {
    const partial = good(); partial.status = "partial";
    partial.devices[0] = { uuid: uuids[0]!, index: null, pciBusId: null, observedAtMs: base, status: "inaccessible" };
    partial.journal = parsePcGpuJournal(journal, bootId, base); f.update(partial);
    assert.equal(f.observations.read(context).pcGpuDevices![0]!.lastGood, undefined);
    f.time(base + 1000);
    f.update({ schema: 1, source: "pc-nvidia-smi", observedAtMs: base + 1000, bootId: null, status: "unavailable",
      devices: [], allocations: [], journal: { status: "unavailable", events: [] } });
    const row = f.observations.read(context).pcGpuDevices![0]!;
    assert.deepEqual(pcGpuView(row, associations[1], base + 1000).retainedIndices, [1]);
    assert.equal(pcGpuView(row, associations[1], base + 1000).retainedDevices[0]?.observedAtMs, base);
    assert.deepEqual(pcGpuView(row, associations[0], base + 1000).retainedIndices, []);
    assert.equal(pcGpuView(row, associations[0], base + 1000).events[0]?.xid, 79);
  } finally { await f.close(); }
});

test("one durable GPU inventory lane serves three hosts, survives restart and stops after revocation", async () => {
  const f = await fixture(); let reads = 0;
  const make = () => createPcMonitor({ state: f.state, vault: f.vault, observations: f.observations, contexts: () => [context], now: f.now,
    connect: async (_computer, _credential, work) => work(async () => { throw Error("unexpected SSH read"); }),
    driverReader: async () => ({ schema: 1, source: "pc-nvidia-smi-version", observedAtMs: f.now(), status: "unavailable", driverVersion: null, cudaDriverVersion: null }),
    devicesReader: async (_run, _allocated, known, now) => { reads++; assert.equal(known.length, 3); return good(now!()); },
    gpuReader: async (_run, association) => ({ schema: 2, address: association.address, observedAtMs: null, status: "query-failed", gpuUuids: [], intervalSeconds: 15,
      fromAtMs: f.now(), toAtMs: f.now(), truncated: false, clockTrusted: false, samples: [] }) });
  let monitor = make();
  try {
    await monitor.tick(); assert.equal(reads, 1); await monitor.stop();
    f.time(base + 30_000); monitor = make(); await monitor.tick(); assert.equal(reads, 1);
    f.time(base + GPU_REFRESH_MS); await monitor.tick(); assert.equal(reads, 2);
    f.state.set(`permission:${context.scopeId}:${pcId}`, { ...f.permission, revokedAtMs: f.now() });
    f.time(base + 2 * GPU_REFRESH_MS); await monitor.tick(); assert.equal(reads, 2);
  } finally { await monitor.stop(); await f.close(); }
});

test("revocation during the GPU read suppresses publication", async () => {
  const f = await fixture(); let reads = 0;
  const monitor = createPcMonitor({ state: f.state, vault: f.vault, observations: f.observations, contexts: () => [context], now: f.now,
    connect: async (_computer, _credential, work) => work(async () => ({ code: 127, stdout: "" })),
    devicesReader: async () => { reads++; f.state.set(`permission:${context.scopeId}:${pcId}`, { ...f.permission, revokedAtMs: base }); return good(); } });
  try { await monitor.tick(); assert.equal(reads, 1); assert.deepEqual(f.observations.read(context).pcGpuDevices, undefined); }
  finally { await monitor.stop(); await f.close(); }
});

test("GPU-only runtime evidence preserves the approved anchor and uses measured UUIDs with no saved UUID association", () => {
  const approved = { ...associations[0]!, gpuUuids: [] }, gpu = good();
  const observedBinding = { pcId, runtime: "podman" as const, wrapperId: "c".repeat(64), nodeContainerId: "d".repeat(64) };
  gpu.allocations[0]!.observedBinding = observedBinding;
  const parsed = parsePcGpuRecord(record(gpu)), view = pcGpuView(parsed, approved, base);
  assert.deepEqual(view.indices, [4]); assert.equal(view.current, true);
  assert.deepEqual(view.observedBinding, observedBinding); assert.equal(view.runtimeChanged, true);
  assert.deepEqual(parsed.gpu.allocations[0]!.binding, approved.binding);
  assert.deepEqual(approved.gpuUuids, []);
  assert.deepEqual(pcGpuView(parsed, { ...approved, binding: observedBinding }, base).indices, [], "GPU evidence does not authorize rebinding the source");
  assert.deepEqual(pcGpuView(parsed, { ...approved, sshFingerprint: "SHA256:" + "B".repeat(43) }, base).indices, []);
  assert.deepEqual(pcGpuView(parsed, { ...approved, verifiedAtMs: base + 1 }, base + 1).indices, []);
  assert.deepEqual(pcGpuView(parsed, approved, base + GPU_FRESH_MS).indices, []);
  assert.deepEqual(pcGpuView(parsed, approved, base, true).indices, []);
  assert.deepEqual(pcGpuView(parsed, { ...approved, gpuUuids: [uuids[1]!] }, base).indices, [], "known UUID conflicts remain unconfirmed");
  const wrongPc = structuredClone(gpu); wrongPc.allocations[0]!.observedBinding!.pcId = "f".repeat(64);
  assert.throws(() => parsePcGpu(wrongPc), /Invalid GPU allocation/);
  const shortId = structuredClone(gpu); shortId.allocations[0]!.observedBinding!.nodeContainerId = "d".repeat(12);
  assert.throws(() => parsePcGpu(shortId));
  assert.throws(() => parsePcGpuRecord({ ...record(gpu), approvalAtMs: base + 1 }), /source identity/);
});

test("known kernel GPU UUIDs remain PC-level evidence until a host allocation proves attribution", () => {
  const gpu = good(), approved = associations.map(row => ({ ...row, gpuUuids: [] }));
  gpu.status = "partial"; gpu.allocations[0] = { ...gpu.allocations[0]!, status: "unavailable", gpuUuids: [] };
  gpu.journal = parsePcGpuJournal(journal, bootId, base);
  const row = record(gpu); delete row.lastGood;
  for (const association of approved) {
    const view = pcGpuView(row, association, base);
    assert.equal(view.events.length, 0);
    assert.deepEqual(view.pcEvents.map(event => [event.xid, event.gpuUuid, event.atMs]), [[79, uuids[0], base - 9999]]);
  }
  assert.deepEqual(pcGpuView(row, approved[1], base).indices, [1], "PC-level evidence does not erase healthy mappings");
  gpu.allocations[0] = good().allocations[0]!;
  assert.equal(pcGpuView(row, approved[0], base).events[0]?.xid, 79);
  assert.equal(pcGpuView(row, approved[1], base).pcEvents.length, 0, "an attributed fault does not become another host's fault");
});

test("v2 GPU storage migrates v1 evidence without modifying rollback data, permissions or financial source bindings", async () => {
  const approved = associations.map(row => ({ ...row, gpuUuids: [] })), f = await fixture(approved);
  const oldKey = `pc-gpu-devices:${context.scopeId}:${context.rosterRevision}`, newKey = `pc-gpu-devices-v2:${context.scopeId}:${context.rosterRevision}`;
  const permissionKey = `permission:${context.scopeId}:${pcId}`;
  try {
    const original = record(); original.gpu.journal = parsePcGpuJournal(journal, bootId, base);
    f.state.set(oldKey, [original]);
    const oldBytes = JSON.stringify(f.state.get(oldKey)), permissionBytes = JSON.stringify(f.state.get(permissionKey));
    assert.equal(f.observations.read(context).pcGpuDevices![0]!.gpu.observedAtMs, base);
    assert.equal(f.state.get(newKey), undefined, "reading v1 evidence never mutates it");
    f.time(base + 1000); const updated = good(base + 1000);
    updated.allocations[0]!.observedBinding = { pcId, runtime: "podman", wrapperId: "c".repeat(64), nodeContainerId: "d".repeat(64) };
    f.update(updated);
    assert.equal(JSON.stringify(f.state.get(oldKey)), oldBytes, "an older release still sees exactly its accepted format");
    assert.equal(JSON.stringify(f.state.get(permissionKey)), permissionBytes);
    assert.deepEqual(f.observations.read(context).associations, approved);
    const restarted = createObservationStore(f.state, "generated-server", f.now), saved = restarted.read(context).pcGpuDevices![0]!;
    assert.deepEqual(saved.gpu.allocations[0]!.observedBinding, updated.allocations[0]!.observedBinding);
    assert.equal(saved.retainedEvents?.[0]?.atMs, base - 9999);
    assert.deepEqual(pcGpuView(saved, approved[0], base + 1000).indices, [4]);
    f.time(base + 2000);
    f.update({ schema: 1, source: "pc-nvidia-smi", observedAtMs: base + 2000, bootId: null, status: "unavailable",
      devices: [], allocations: [], journal: { status: "unavailable", events: [] } });
    const retained = restarted.read(context).pcGpuDevices![0]!;
    assert.deepEqual(retained.retainedAllocations?.[0]?.observedBinding, updated.allocations[0]!.observedBinding);
    assert.equal(retained.retainedAllocations?.[0]?.observedAtMs, base + 1000);
    assert.deepEqual(pcGpuView(retained, approved[0], base + 2000).retainedIndices, [4]);
    assert.equal(pcGpuView(retained, approved[0], base + 2000).retainedDevices[0]?.observedAtMs, base + 1000);
    f.state.set(newKey, []);
    assert.deepEqual(restarted.read(context).pcGpuDevices, [], "explicit v2 emptiness cannot resurrect v1 mappings");
    f.state.set(newKey, null);
    assert.throws(() => restarted.read(context), /Invalid saved PC GPU inventory/, "invalid v2 data cannot silently fall back to v1");
  } finally { await f.close(); }
});
