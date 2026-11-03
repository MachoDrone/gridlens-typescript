import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PC_DRIVER_COMMAND, parseNvidiaVersionOutput, readPcDriver } from "../src/backend/pc-driver.ts";
import { createPcMonitor } from "../src/backend/pc-monitor.ts";
import type { PcPermission } from "../src/backend/pc-monitor.ts";
import { createObservationStore } from "../src/backend/observations.ts";
import { openSharedState } from "../src/backend/sqlite-state.ts";
import { openCredentialVault } from "../src/backend/credential-vault.ts";
import { DRIVER_FRESH_MS, parsePcDriverRecord, pcDriverView } from "../src/fleet/pc-drivers.ts";
import { normalizeHostMetadata, reportedDriverVersion } from "../src/fleet/host-metadata.ts";
import { parseSharedObservations } from "../src/contracts/shared.ts";
import type { PcAssociation } from "../src/contracts/shared.ts";
import type { FleetContext } from "../src/contracts/fleet.ts";

const base = 1_800_000_000_000;
// Actual NVIDIA-SMI --version labels and independent DRIVER/NVML fields;
// version values and identities are generated for this isolated fixture.
const output = "NVIDIA-SMI version  : 580.72.13\nNVML version        : 580.72\nDRIVER version      : 580.72.13\nCUDA Version        : 12.8\n";
const fingerprint = "SHA256:" + "A".repeat(43), pc = "a".repeat(64);
const hosts = ["2", "3", "4", "5"].map(value => "1".repeat(31) + value);
const good = { schema: 1 as const, source: "pc-nvidia-smi-version" as const, observedAtMs: base, status: "ok" as const,
  driverVersion: "580.72.13", cudaDriverVersion: "12.8" };

test("NVIDIA-SMI parser selects DRIVER rather than NVML and rejects ambiguous or malformed versions", () => {
  assert.deepEqual(parseNvidiaVersionOutput(output), { driverVersion: "580.72.13", cudaDriverVersion: "12.8" });
  assert.deepEqual(parseNvidiaVersionOutput(output.replaceAll("\n", "\r\n")), { driverVersion: "580.72.13", cudaDriverVersion: "12.8" });
  for (const text of [output.replace("DRIVER version", "other version"), output + "DRIVER version : 590.1\n", output + "CUDA Version : 12.8\n",
    output.replace("580.72.13\nCUDA", "missing\nCUDA"), output.replace("12.8", "12.8 malicious"), output + "\0", "x".repeat(4097)]) assert.throws(() => parseNvidiaVersionOutput(text));
});
test("driver reader uses one bounded unprivileged command and publishes finite failures only", async () => {
  const calls: { command: string; options: unknown }[] = [];
  const result = await readPcDriver(async (command, options) => { calls.push({ command, options }); return { code: 0, stdout: output }; }, () => base);
  assert.deepEqual(result, good); assert.deepEqual(calls, [{ command: PC_DRIVER_COMMAND, options: { maximum: 4096, timeoutMs: 5000 } }]);
  for (const [code, status] of [[127, "missing-command"], [1, "query-failed"], [0, "invalid-response"]] as const) {
    const failed = await readPcDriver(async () => ({ code, stdout: "generated sensitive-looking command diagnostic" }), () => base);
    assert.equal(failed.status, status); assert.equal(failed.driverVersion, null); assert.ok(!JSON.stringify(failed).includes("diagnostic"));
  }
  assert.equal((await readPcDriver(async () => { throw Error("generated private diagnostic"); }, () => base)).status, "unavailable");
});
test("driver projection preserves dates and failure meaning while both fresh and retained upstream sentinels are unknown", () => {
  const record = { pcId: pc, sshFingerprint: fingerprint, approvalAtMs: base - 1000, driver: good, receivedAtMs: base };
  assert.equal(pcDriverView(record, base).current, true); assert.equal(pcDriverView(record, base + DRIVER_FRESH_MS).current, false);
  assert.equal(pcDriverView(record, base, true).current, false); assert.equal(pcDriverView(record, base - 1).driverVersion, null);
  const retained = parsePcDriverRecord({ ...record, driver: { ...good, observedAtMs: base + 60_000, status: "query-failed", driverVersion: null, cudaDriverVersion: null }, lastGoodDriver: good });
  const view = pcDriverView(retained, base + 60_000); assert.equal(view.current, false); assert.equal(view.observedAtMs, base); assert.equal(view.driverVersion, good.driverVersion);
  for (const value of ["missing", " missing ", "MISSING", null]) {
    assert.equal(reportedDriverVersion(value), null);
    const normalized = normalizeHostMetadata(hosts[0]!, { nodeAddress: hosts[0], metrics: { gpu: { cuda_driver_version: value, nvml_driver_version: value } } });
    assert.equal(normalized.cuda, null); assert.equal(normalized.nvidia, null);
  }
  assert.equal(reportedDriverVersion("580.72.13"), "580.72.13");
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gridlens-pc-driver-")); let at = base, contexts: FleetContext[];
  const context: FleetContext = { scopeId: "generated", rosterRevision: "one", addresses: hosts }; contexts = [context];
  const state = openSharedState(join(root, "state"), { ledgerDirectory: join(root, "ledger"), now: () => at });
  const vault = openCredentialVault(join(root, "credentials")), observations = createObservationStore(state, "generated-server", () => at);
  const associations: PcAssociation[] = hosts.map((address, i) => ({ address, binding: { pcId: i < 3 ? pc : "b".repeat(64), runtime: "docker", wrapperId: null,
    nodeContainerId: (i + 10).toString(16).padStart(64, "0") }, name: i < 3 ? "Generated three-host PC" : "Generated second PC", sshFingerprint: fingerprint,
    verifiedAtMs: base - 1000, privateIp: null, gpuUuids: [] }));
  observations.associate(context, associations);
  const permissions = [pc, "b".repeat(64)].map((pcId): PcPermission => ({ version: 1,
    computer: { id: pcId, host: pcId === pc ? "10.0.0.2" : "10.0.0.3", port: 22, name: "Generated PC", fingerprint, hostKey: "generated" },
    associations: associations.filter(row => row.binding.pcId === pcId), rosterRevision: context.rosterRevision,
    automaticIp: false, rewards: false, gpu: true, approvedAtMs: base - 1000, revokedAtMs: null, paused: false }));
  for (const permission of permissions) { state.set(`permission:generated:${permission.computer.id}`, permission); vault.save("generated", permission.computer.id,
    { username: "generated", password: "generated-fixture-password", sudoPassword: "generated-sudo-must-not-be-used" }); }
  const commands: { pcId: string; command: string; input: unknown }[] = []; let gpuReads = 0;
  let read: (pcId: string, command: string) => Promise<{ code: number; stdout: string }> = async () => ({ code: 0, stdout: output });
  function monitor() { return createPcMonitor({ state, vault, observations, contexts: () => contexts, now: () => at,
    connect: async (computer, _credential, action) => action(async (command, options) => {
      commands.push({ pcId: computer.id, command, input: options?.input }); return read(computer.id, command);
    }), gpuReader: async (_run, association) => { gpuReads++; return { schema: 2, address: association.address, observedAtMs: null, status: "query-failed", gpuUuids: [],
      intervalSeconds: 15, fromAtMs: at, toAtMs: at, truncated: false, clockTrusted: false, samples: [] }; } }); }
  return { context, state, vault, observations, associations, permissions, commands, monitor, gpuReads: () => gpuReads,
    time(value: number) { at = value; }, reader(value: typeof read) { read = value; }, clearContexts() { contexts = []; },
    async close() { vault.close(); await state.close(); await rm(root, { recursive: true, force: true }); } };
}
test("three hosts share one PC version read and restart preserves deadlines, independently from GPU faults", async () => {
  const f = await fixture(); let monitor = f.monitor();
  try {
    await monitor.tick(); assert.equal(f.commands.length, 2); assert.equal(f.gpuReads(), 4);
    assert.ok(f.commands.every(row => row.command === PC_DRIVER_COMMAND && row.input === undefined));
    let data = f.observations.read(f.context); assert.equal(data.drivers?.length, 2);
    assert.ok(data.observations.every(row => row.gpu?.status === "query-failed"), "version success cannot clear GPU failures");
    for (const association of f.associations.slice(0, 3)) assert.equal(data.drivers!.find(row => row.pcId === association.binding.pcId)!.driver.driverVersion, good.driverVersion);
    f.time(base + 30_000); await monitor.tick(); assert.equal(f.commands.length, 2); assert.equal(f.gpuReads(), 8);
    await monitor.stop(); monitor = f.monitor(); f.time(base + 31_000); await monitor.tick(); assert.equal(f.commands.length, 2);
    f.reader(async pcId => pcId === pc ? { code: 127, stdout: "missing" } : { code: 0, stdout: output });
    f.time(base + 300_000); await monitor.tick(); assert.equal(f.commands.length, 4);
    data = f.observations.read(f.context); const failed = data.drivers!.find(row => row.pcId === pc)!;
    assert.equal(failed.driver.status, "missing-command"); assert.equal(failed.lastGoodDriver?.observedAtMs, base);
    assert.equal(pcDriverView(failed, base + 300_000).current, false);
    await monitor.stop(); monitor = f.monitor(); f.time(base + 330_000); await monitor.tick(); assert.equal(f.commands.length, 4);
    f.time(base + 360_000); await monitor.tick(); assert.equal(f.commands.length, 5);
    assert.equal(f.state.get<{ driverAt: number }>(`monitor:generated:${pc}`)!.driverAt, base + 480_000);
  } finally { await monitor.stop(); await f.close(); }
});
test("revocation or SSH identity changes during a read cannot publish or reactivate its result", async () => {
  for (const change of ["revoke", "identity", "roster"] as const) {
    const f = await fixture(); let release!: (value: { code: number; stdout: string }) => void, started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; }); const pending = new Promise<{ code: number; stdout: string }>(resolve => { release = resolve; });
    f.reader(async pcId => { if (pcId !== pc) return { code: 0, stdout: output }; started(); return pending; });
    const monitor = f.monitor();
    try {
      const tick = monitor.tick(); await began; f.time(base + 1);
      if (change === "roster") f.clearContexts();
      else f.state.set(`permission:generated:${pc}`, change === "revoke" ? { ...f.permissions[0]!, revokedAtMs: base + 1 }
        : { ...f.permissions[0]!, computer: { ...f.permissions[0]!.computer, fingerprint: "SHA256:" + "B".repeat(43) } });
      release({ code: 0, stdout: output }); await tick;
      assert.ok(!f.observations.read(f.context).drivers?.some(row => row.pcId === pc));
      const calls = f.commands.length; f.time(base + 600_000); await monitor.tick(); assert.equal(f.commands.filter(row => row.pcId === pc).length, 1);
      assert.ok(f.commands.length >= calls);
    } finally { await monitor.stop(); await f.close(); }
  }
});
test("driver records are scoped, preserve original success times and survive an older observation writer", async () => {
  const f = await fixture(), monitor = f.monitor();
  try {
    await monitor.tick(); const data = f.observations.read(f.context), driver = data.drivers![0]!;
    parseSharedObservations(data, "generated-server", f.context);
    assert.throws(() => parseSharedObservations({ ...data, drivers: [{ ...driver, sshFingerprint: "SHA256:" + "B".repeat(43) }] }, "generated-server", f.context));
    assert.throws(() => parseSharedObservations({ ...data, drivers: [driver, driver] }, "generated-server", f.context));
    for (const at of [base - 1, base + 5001]) assert.throws(() => f.observations.driver(f.context, { pcId: driver.pcId, sshFingerprint: driver.sshFingerprint,
      approvalAtMs: driver.approvalAtMs, driver: { ...good, observedAtMs: at } }));
    const { drivers: _ignored, ...oldShape } = data; f.state.set(`observations:generated:one`, oldShape);
    assert.deepEqual(f.observations.read(f.context).drivers, data.drivers, "older writes cannot erase the separate driver namespace");
    f.state.set(`permission:generated:${pc}`, { ...f.permissions[0]!, gpu: false });
    assert.ok(!f.observations.read(f.context).drivers!.some(row => row.pcId === pc));
    f.state.set(`permission:generated:${pc}`, { ...f.permissions[0]!, approvedAtMs: base + 1 });
    assert.ok(!f.observations.read(f.context).drivers!.some(row => row.pcId === pc), "new approval cannot revive an older reading as current");
  } finally { await monitor.stop(); await f.close(); }
});
