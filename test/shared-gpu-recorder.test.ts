import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Script } from "node:vm";
import { mkdtemp, rm } from "node:fs/promises";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeGpuDatabase, recordGpuSamples, readGpuDatabase, parseNvidiaSamples, gpuRecorderSource } from "../src/backend/gpu-recorder-runtime.ts";
import { createGpuCollector, tsRecorderName, TS_GPU_IMAGE, validateTsRecorder } from "../src/backend/gpu-collector.ts";
import { androidRecorderName } from "../src/backend/android-recorder.ts";
import type { PcAssociation } from "../src/contracts/shared.ts";
import type { SshRun } from "../src/backend/ssh.ts";

const base = 1_800_000_000_000, host = "11111111111111111111111111111112", gpu = "GPU-11111111-2222-3333-4444-555555555555";
const nodeId = "b".repeat(64), recorderId = "c".repeat(64);
const association: PcAssociation = { address: host, binding: { pcId: "a".repeat(64), runtime: "docker", wrapperId: null, nodeContainerId: nodeId },
  name: "Synthetic PC", sshFingerprint: "SHA256:" + "A".repeat(43), verifiedAtMs: base, privateIp: "10.0.0.2", gpuUuids: [gpu] };
const binding = { address: host, nodeContainerId: nodeId, gpuUuids: [gpu] };
const xml = `<?xml version="1.0"?><!DOCTYPE nvidia_smi_log SYSTEM "nvsmi_device_v12.dtd"><nvidia_smi_log><gpu id="00000000:01:00.0"><uuid>${gpu}</uuid><minor_number>9</minor_number><clocks_event_reasons><clocks_event_reason_sw_thermal_slowdown>Active</clocks_event_reason_sw_thermal_slowdown><clocks_event_reason_sw_power_cap>Not Active</clocks_event_reason_sw_power_cap></clocks_event_reasons><clocks_event_reasons_counters><clocks_event_reasons_counters_sw_therm_slowdown>1200000 us</clocks_event_reasons_counters_sw_therm_slowdown><clocks_event_reasons_counters_hw_therm_slowdown>N/A</clocks_event_reasons_counters_hw_therm_slowdown></clocks_event_reasons_counters></gpu></nvidia_smi_log>`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("TypeScript GPU XML parsing preserves supported flags, exact counters and UUID allocation without physical-index guesses", () => {
  assert.deepEqual(parseNvidiaSamples(xml, [gpu], base), [[base, 0, 5, 1, 1200000, null, null, null]]);
  assert.throws(() => parseNvidiaSamples(xml.replace(`<uuid>${gpu}</uuid>`, `<uuid>${gpu}</uuid><uuid>${gpu}</uuid>`), [gpu], base), /Duplicate/);
  assert.throws(() => parseNvidiaSamples(xml.replace("<nvidia_smi_log>", '<!ENTITY attack SYSTEM "file:///etc/passwd"><nvidia_smi_log>'), [gpu], base));
  assert.throws(() => parseNvidiaSamples(xml, [gpu.replace("11111111", "99999999")], base), /identity/);
  assert.throws(() => parseNvidiaSamples(xml.replace("<clocks_event_reasons>", '<clocks_throttle_reasons><clocks_throttle_reason_sw_thermal_slowdown>Not Active</clocks_throttle_reason_sw_thermal_slowdown></clocks_throttle_reasons><clocks_event_reasons>'), [gpu], base), /Conflicting/);
  new Script(gpuRecorderSource(binding));
  assert.match(gpuRecorderSource(binding), /127\.0\.0\.1/);
  assert(!gpuRecorderSource(binding).includes("nosana_key"));
});

test("GPU SQLite preserves source time, clock failures, exact bindings and bounded history", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeGpuDatabase(db, binding);
    recordGpuSamples(db, binding, parseNvidiaSamples(xml, [gpu], base), base, "ok");
    assert.equal(readGpuDatabase(db, binding, base + 15_000).observedAtMs, base);
    recordGpuSamples(db, binding, [], base + 10 * 86_400_000, "clock-untrusted");
    const retained = readGpuDatabase(db, binding, base + 15_000);
    assert.equal(retained.status, "clock-untrusted"); assert.equal(retained.clockTrusted, false);
    assert.equal(retained.samples.length, 1, "an untrusted future clock cannot prune history");
    assert.equal(retained.observedAtMs, base);
    recordGpuSamples(db, binding, parseNvidiaSamples(xml, [gpu], base - 1000), base - 1000, "ok");
    assert.equal(readGpuDatabase(db, binding, base + 15_000).status, "clock-regressed");
    assert.throws(() => initializeGpuDatabase(db, { ...binding, address: host + "1" }), /binding/);
    assert.throws(() => readGpuDatabase(db, binding, base, base - 8 * 86_400_000), /window/);
    // The database bound and public report cap are independent; report truncation
    // preserves complete retained rows and never fabricates absent intervals.
    const insert = db.prepare("INSERT INTO samples(at,gpu,value) VALUES(?,?,?)");
    db.exec("BEGIN");
    for (let i = 1; i <= 6100; i++) insert.run(base + i * 1000, 0, JSON.stringify([base + i * 1000, 0, 1, 0, i, null, null, null]));
    db.exec("COMMIT");
    const bounded = readGpuDatabase(db, binding, base + 6100_000, base);
    assert.equal(bounded.samples.length, 6000); assert.equal(bounded.truncated, true);
    assert(bounded.samples[0]![0] > base);
  } finally { db.close(); }
});

test("the serialized GPU reader opens persisted history read-only and retains exact dates after recorder restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "gridlens-gpu-runtime-")), path = join(root, "gpu.sqlite");
  const db = new DatabaseSync(path);
  initializeGpuDatabase(db, binding); recordGpuSamples(db, binding, parseNvidiaSamples(xml, [gpu], base), base, "ok"); db.close();
  let output = "";
  try {
    class RedirectedDatabase extends DatabaseSync {
      constructor(input: string, options?: { readOnly?: boolean }) {
        assert.equal(input, "/data/gpu.sqlite"); assert.equal(options?.readOnly, true); super(path, options);
      }
    }
    class FixedDate extends Date { static override now(): number { return base + 15_000; } }
    await new Script(gpuRecorderSource(binding)).runInNewContext({ Buffer, Date: FixedDate,
      process: { argv: ["node", "read"], stdout: { write(text: string) { output += text; } }, stderr: { write() { assert.fail("Generated reader failed"); } } },
      require(name: string) {
        if (name === "node:fs") return { lstatSync(input: string) { assert.equal(input, "/data/gpu.sqlite"); return fs.lstatSync(path); } };
        if (name === "node:sqlite") return { DatabaseSync: RedirectedDatabase };
        if (["node:child_process", "node:http", "node:os"].includes(name)) return {};
        throw new Error("Unexpected reader dependency");
      } });
    const result = JSON.parse(output);
    assert.equal(result.observedAtMs, base); assert.deepEqual(result.samples, [[base, 0, 5, 1, 1200000, null, null, null]]);
    const reopened = new DatabaseSync(path, { readOnly: true });
    try { assert.equal(readGpuDatabase(reopened, binding, base + 20_000).observedAtMs, base); } finally { reopened.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

function fixture(options: { android?: boolean; priorBinding?: boolean; badVolume?: boolean; overlappingGpu?: boolean } = {}) {
  const state = new Map<string, unknown>(), commands: string[] = [];
  let exists = false, volumeExists = false, running = true;
  const name = tsRecorderName(association), androidName = androidRecorderName(association), source = gpuRecorderSource(binding);
  const bindingHash = hash(JSON.stringify({ ...association.binding, address: host, gpuUuids: [gpu] }));
  const parts = () => [recorderId, "typescript", "node-gpu-recorder", "1", hash(source), bindingHash, TS_GPU_IMAGE, `container:${nodeId}`, "true", "false", String(running),
    `volume:${name}-data:/data:true;`, "", "private", "", "null", '["ALL"]', '["no-new-privileges"]', "null", "{}", "null", "null",
    JSON.stringify([{ Count: 0, Driver: "", DeviceIDs: [gpu], Capabilities: [["gpu"]], Options: {} }]), '["/usr/local/bin/node"]',
    JSON.stringify(["-e", source, "--", "run"]).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e"), "134217728", "250000000", "32", "unless-stopped", "NVIDIA_DRIVER_CAPABILITIES=utility;"];
  const run: SshRun = async command => {
    commands.push(command);
    if (command.includes("container ls") && command.includes(androidName)) return { code: 0, stdout: options.android ? "d".repeat(64) : "" };
    if (command.includes("container ls") && command.includes("name=^/gridlens-gpu-recorder$")) return { code: 0, stdout: "" };
    if (command.includes("container ls") && command.includes("--filter label=")) return { code: 0, stdout: options.priorBinding || options.overlappingGpu ? `${"d".repeat(64)}\told-recorder`
      : exists ? `${recorderId}\t${name}` : "" };
    if (command.includes("container ls")) return { code: 0, stdout: exists ? recorderId : "" };
    if (command.includes("container inspect") && command.includes("Config.Cmd") && options.priorBinding) return { code: 0, stdout: JSON.stringify(["python", "-B", "-c", `BOUND_ADDRESS = '${host}'\nfixture source`, "run"]) };
    if (command.includes("container inspect") && command.includes("Config.Cmd") && options.overlappingGpu) return { code: 0, stdout: JSON.stringify(["-e", gpuRecorderSource({ ...binding, address: "11111111111111111111111111111113" }), "--", "run"]) };
    if (command.includes("container inspect")) return options.android ? { code: 1, stdout: "" } : { code: 0, stdout: parts().join("\t") };
    if (command.includes(" inspect ") && command.includes(".Id")) return { code: 0, stdout: `${nodeId}\ttrue\tnosana/nosana-node:fixture` };
    if (command.includes("NetworkMode")) return { code: 0, stdout: "bridge" };
    if (command.includes("--query-gpu=uuid")) return { code: 0, stdout: gpu };
    if (command.includes("volume ls")) return { code: 0, stdout: volumeExists ? name + "-data" : "" };
    if (command.includes("volume create")) { volumeExists = true; return { code: 0, stdout: name + "-data" }; }
    if (command.includes("volume inspect")) return { code: 0, stdout: `${options.badVolume ? "unowned" : "typescript"}\tnode-gpu-recorder\t1\t${bindingHash}\tlocal\tlocal\tnull` };
    if (command.includes("docker pull")) return { code: 0, stdout: "" };
    if (command.includes("docker run")) { exists = true; return { code: 0, stdout: recorderId }; }
    if (command.includes("container start")) { running = true; return { code: 0, stdout: recorderId }; }
    if (command.includes("/usr/bin/readlink")) return { code: 0, stdout: "net:[12345]" };
    if (command.endsWith(" -- read")) return { code: 0, stdout: JSON.stringify({ schema: 2, address: host, observedAtMs: base, status: "ok", gpuUuids: [gpu],
      intervalSeconds: 15, fromAtMs: base - 86_400_000, toAtMs: base, truncated: false, clockTrusted: true, samples: [[base, 0, 1, 0, 10, null, null, null]] }) };
    return { code: 0, stdout: host };
  };
  const privateState = { get<T>(key: string): T | undefined { return structuredClone(state.get(key)) as T | undefined; }, set(key: string, value: unknown) { state.set(key, structuredClone(value)); } };
  return { run, commands, privateState, state, parts, source, bindingHash, stop: () => { running = false; } };
}

test("approved TS GPU installation uses only pinned/labeled Docker resources and rerun preserves one writer", async () => {
  const f = fixture(), collect = createGpuCollector({ state: f.privateState, now: () => base });
  const first = await collect(f.run, association); assert.equal(first.status, "ok"); assert.equal(first.samples.length, 1);
  assert.equal(f.commands.filter(command => command.includes("docker run")).length, 1);
  const created = f.commands.find(command => command.includes("docker run"))!;
  assert(created.includes(TS_GPU_IMAGE)); assert(created.includes("--read-only --cap-drop ALL --security-opt no-new-privileges"));
  assert(!/--privileged|--network host|type=bind|--pid host|SYS_MODULE|\/var\/run\/docker/.test(created));
  assert.equal(validateTsRecorder(f.parts(), association, nodeId, f.source).running, true);
  assert.equal((await collect(f.run, association)).observedAtMs, base);
  assert.equal(f.commands.filter(command => command.includes("docker run")).length, 1);
  assert.equal(f.commands.filter(command => command.includes("volume create")).length, 1);
  assert(!f.commands.some(command => /container (restart|stop|rm)/.test(command)));
  f.stop(); assert.equal((await collect(f.run, association)).status, "not-enabled");
  assert(!f.commands.some(command => command.includes("container start")), "ordinary polls respect a stopped established recorder");
  f.state.set(`gpu-lifecycle:${association.binding.pcId}:${host}`, { version: 1, phase: "creating", bindingHash: f.bindingHash, digest: hash(f.source) });
  assert.equal((await collect(f.run, association)).status, "ok");
  assert(f.commands.some(command => command === `/usr/bin/docker container start ${recorderId}`));
});

test("Android ownership, previous bindings and unowned volumes prevent a competing TS recorder", async () => {
  for (const options of [{ android: true }, { priorBinding: true }, { badVolume: true }, { overlappingGpu: true }]) {
    const f = fixture(options), collect = createGpuCollector({ state: f.privateState, now: () => base });
    const result = await collect(f.run, association);
    assert.notEqual(result.status, "ok");
    assert(!f.commands.some(command => /docker (pull|run)|container (start|restart|stop|rm)/.test(command)));
  }
});
