import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Coordinator } from "../src/installer/coordinator.ts";
import { ensureVpnWeb } from "../src/installer/vpn-web.ts";
import { assertNoActiveUpdate, ensureUpdater, launchWorkerReplacement, validateUpdater } from "../src/updater/deployment.ts";
import { openUpdateState } from "../src/updater/state.ts";
import { createUpdateRuntime, replaceWorkerMain, verifyUpdateEndpoint } from "../src/updater/runtime.ts";
import { UpdateDockerFixture } from "./fixtures/updater-docker.ts";
import type { ModernRelease } from "../src/installer/release.ts";
import type { VerifiedCandidate } from "../src/updater/release.ts";
import type { UpdateOperation } from "../src/contracts/updates.ts";
const bytes = Buffer.from("generated fixture archive");
const release = (sequence: number): ModernRelease => ({ format: "gridlens-modern-release-v1", version: `0.1.0-fixture.${sequence}`, sequence,
  platform: "linux-x64", minimumCoordinator: 1, imageId: `sha256:${String(sequence).repeat(64)}`,
  runtime: { name: `gridlens-runtime-${sequence}.tar`, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } });
const build = (sequence: number) => ({ version: release(sequence).version, sequence, buildId: `${sequence}:${release(sequence).version}` });
function fixture(t: TestContext, classic = false) {
  const directory = mkdtempSync(join(tmpdir(), "gridlens-update-runtime-")), configPath = join(directory, "config.json"), instance = "fixture-update";
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = { ...release(2), ...(classic ? { configImageId: `sha256:${"c".repeat(64)}` } : {}) };
  const localTarget = classic ? { ...target, imageId: target.configImageId! } : target;
  const runner = new UpdateDockerFixture(instance, configPath, [release(1), localTarget]), coordinator = new Coordinator(runner);
  const initial = coordinator.install({ instance, release: release(1), action: "setup", enableUpdater: true, bindAddress: "10.70.0.8" }).config;
  ensureVpnWeb(runner, initial, release(1), 8790); ensureUpdater(runner, initial);
  const candidate: VerifiedCandidate = { ...build(2), id: "a".repeat(64), sizeBytes: bytes.length, release: target, releaseTag: "modern-v0.1.0-fixture.2", workerProtocol: 1 };
  const operation: UpdateOperation = { id: "generated-operation", revision: 1, target: build(2), previous: build(1), phase: "preparing", startedAtMs: 1, updatedAtMs: 1,
    downloadedBytes: bytes.length, totalBytes: bytes.length, error: null, result: null };
  mkdirSync(join(directory, "downloads")); const archive = join(directory, "downloads", `${candidate.id}.tar`); writeFileSync(archive, bytes);
  const probes: string[] = [], runtime = createUpdateRuntime({ instance, stateDirectory: directory, configurationPath: configPath, runner,
    probe: async origin => { probes.push(origin); }, sleep: async () => {} });
  t.after(() => runtime.release());
  return { directory, configPath, initial, runner, runtime, candidate, operation, archive, probes, instance, localTarget };
}
for (const classic of [false, true]) test(`verified ${classic ? "classic" : "containerd"} runtime update replaces owner and both gateways, then restores exact prior state and endpoints`, async t => {
  const f = fixture(t, classic); const signed = structuredClone(f.candidate.release); await f.runtime.prepare(f.candidate, f.archive, f.operation);
  assert.equal(f.runner.held, true); await f.runtime.apply(f.candidate, f.operation); await f.runtime.verify(f.candidate, f.operation);
  assert.deepEqual(await f.runtime.current(), build(2));
  assert.notEqual(f.runner.config!.active.stateVolume, f.initial.active.stateVolume);
  assert.equal(f.runner.config!.active.imageId, f.localTarget.imageId);
  const recorded = JSON.parse(readFileSync(join(f.directory, "runtime-transaction.json"), "utf8"));
  assert.equal(recorded.targetImageId, f.localTarget.imageId); assert.deepEqual(recorded.candidate.release, signed);
  assert.deepEqual(f.candidate.release, signed, "resolution does not rewrite the signed candidate");
  assert.deepEqual(f.probes, [f.initial.origin, "http://10.70.0.8:8790"]);
  assert.equal(f.runner.objects.get(`container:gridlens-modern-${f.instance}-vpn-web`)!.Image, f.localTarget.imageId);
  const restored = await f.runtime.rollback(f.operation);
  assert.deepEqual(restored, build(1)); assert.deepEqual(f.runner.config!.active, f.initial.active);
  assert.equal(f.runner.config!.certificateSha256, f.initial.certificateSha256);
  assert.equal(f.runner.objects.get(`container:gridlens-modern-${f.instance}-vpn-web`)!.Image, release(1).imageId);
  assert.ok(!f.runner.calls.some(args => args.includes("volume") && args.includes("rm")));
  await f.runtime.release(); assert.equal(f.runner.held, false);
});
test("classic store recovery and updater replacement keep the resolved local image identity", async t => {
  const f = fixture(t, true); await f.runtime.prepare(f.candidate, f.archive, f.operation); await f.runtime.apply(f.candidate, f.operation); await f.runtime.release();
  const before = f.runner.calls.length;
  const resumed = createUpdateRuntime({ instance: f.instance, stateDirectory: f.directory, configurationPath: f.configPath,
    runner: f.runner, probe: async () => {}, sleep: async () => {} });
  t.after(() => resumed.release());
  await resumed.prepare(f.candidate, f.archive, f.operation); await resumed.verify(f.candidate, f.operation); await resumed.release();
  assert.ok(!f.runner.calls.slice(before).some(args => args[0] === "load"), "recorded target resumes without reapplying");
  await replaceWorkerMain(f.instance, f.operation.id, { runner: f.runner, stateDirectory: f.directory, configurationPath: f.configPath,
    probe: async () => {}, sleep: async () => {}, workerStatus: async () => ({ current: build(2), operation: { ...f.operation, phase: "complete", result: build(2) } }) });
  assert.equal(f.runner.objects.get(`container:gridlens-modern-${f.instance}-updater`)!.Image, f.localTarget.imageId);
  assert.ok(f.runner.calls.some(args => args[0] === "run" && args.includes("scripts/shared-updater.ts") && args.includes(f.localTarget.imageId)));
  assert.ok(!f.runner.calls.slice(before).some(args => args[0] === "run" && args.includes(f.candidate.release.imageId)));
});
test("legacy recovery journals retain primary identity while unsigned target substitutions reject before mutation", async t => {
  const f = fixture(t), path = join(f.directory, "runtime-transaction.json");
  await f.runtime.prepare(f.candidate, f.archive, f.operation);
  const recorded = JSON.parse(readFileSync(path, "utf8")); delete recorded.targetImageId; writeFileSync(path, JSON.stringify(recorded));
  await f.runtime.apply(f.candidate, f.operation); await f.runtime.verify(f.candidate, f.operation);
  recorded.targetImageId = `sha256:${"f".repeat(64)}`; writeFileSync(path, JSON.stringify(recorded));
  const before = f.runner.calls.length;
  await assert.rejects(f.runtime.apply(f.candidate, f.operation), /outside its signed identities/);
  assert.equal(f.runner.calls.length, before);
});
test("corrupt staged archive and changed previous version reject before stopping the runtime", async t => {
  const f = fixture(t); const before = f.runner.calls.length;
  writeFileSync(f.archive, Buffer.alloc(bytes.length)); await assert.rejects(f.runtime.prepare(f.candidate, f.archive, f.operation), /verification/);
  assert.ok(!f.runner.calls.slice(before).some(args => args[0] === "stop" || args[0] === "load")); await f.runtime.release();
  writeFileSync(f.archive, bytes); await assert.rejects(f.runtime.prepare(f.candidate, f.archive, { ...f.operation, previous: build(2) }), /version changed/);
});
test("interruption after selecting candidate state restores the recorded pair without copying the ledger", async t => {
  const f = fixture(t); await f.runtime.prepare(f.candidate, f.archive, f.operation); f.runner.failRole = "gateway";
  await assert.rejects(f.runtime.apply(f.candidate, f.operation), /interrupted/);
  assert.equal(f.runner.config!.phase, "applying"); await f.runtime.rollback(f.operation);
  assert.deepEqual(f.runner.config!.active, f.initial.active); assert.equal(f.runner.config!.phase, "ready");
  const copies = f.runner.calls.filter(args => args.includes("copy-state")); assert.equal(copies.length, 1); assert.ok(!copies[0]!.join(" ").includes("ledger"));
  const journal = JSON.parse(readFileSync(join(f.directory, "runtime-transaction.json"), "utf8")); assert.equal(journal.rollback, true);
});
test("updater validation rejects extra mounts, host namespaces and changed image before removal", t => {
  const f = fixture(t), updater = f.runner.objects.get(`container:gridlens-modern-${f.instance}-updater`)!;
  validateUpdater(f.instance, updater, release(1).imageId);
  for (const change of [
    (value: Record<string, unknown>) => (value.Mounts as unknown[]).push({ Type: "bind", Source: "/", Destination: "/host", RW: true }),
    (value: Record<string, unknown>) => { (value.HostConfig as Record<string, unknown>).PidMode = "host"; },
    (value: Record<string, unknown>) => { value.Image = release(2).imageId; },
  ]) { const altered = structuredClone(updater); change(altered); assert.throws(() => validateUpdater(f.instance, altered, release(1).imageId)); }
});
test("readiness rejects ordinary HTTP200 and an old browser build", async t => {
  let response: unknown = { status: "ready" };
  const server = createServer((_request, reply) => { reply.writeHead(200, { "Content-Type": "application/json" }); reply.end(JSON.stringify(response)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  await assert.rejects(verifyUpdateEndpoint(origin, "", build(2)));
  response = { status: "ready", build: build(1), ownerBuild: build(2) }; await assert.rejects(verifyUpdateEndpoint(origin, "", build(2)));
  response = { status: "ready", build: build(2), ownerBuild: build(2) }; await verifyUpdateEndpoint(origin, "", build(2));
});
test("replacement Docker run failure restores the old worker and exact app pair", async t => {
  const f = fixture(t); await f.runtime.prepare(f.candidate, f.archive, f.operation); await f.runtime.apply(f.candidate, f.operation); await f.runtime.release();
  f.runner.failRole = "-updater";
  await assert.rejects(replaceWorkerMain(f.instance, f.operation.id, { runner: f.runner, stateDirectory: f.directory, configurationPath: f.configPath,
    probe: async () => {}, sleep: async () => {} }), /replacement updater/);
  assert.deepEqual(f.runner.config!.active, f.initial.active);
  assert.equal(f.runner.objects.get(`container:gridlens-modern-${f.instance}-updater`)!.Image, release(1).imageId);
  assert.equal(f.runner.held, false);
  const journal = JSON.parse(readFileSync(join(f.directory, "runtime-transaction.json"), "utf8")); assert.equal(journal.rollback, true); assert.match(journal.failure, /replacement updater/);
});
test("resumed rollback acquires the shared lock and temporary handoff contention retries", async t => {
  const f = fixture(t); await f.runtime.prepare(f.candidate, f.archive, f.operation); await f.runtime.apply(f.candidate, f.operation); await f.runtime.release();
  let locks = 0;
  const resumed = createUpdateRuntime({ instance: f.instance, stateDirectory: f.directory, configurationPath: f.configPath, runner: f.runner,
    probe: async () => {}, sleep: async () => {}, lock: async () => { if (++locks === 1) throw new Error("Another installation is running"); return f.runner.hold(); } });
  await resumed.rollback(f.operation); assert.equal(locks, 2); assert.equal(f.runner.held, true); await resumed.release();
});
test("terminal guard reads durable active state during updater handoff and permits settled work", t => {
  const f = fixture(t), store = openUpdateState(f.directory); t.after(() => store.close());
  const status = { version: 1, supported: true, canUpdate: true, checking: false, current: build(1), candidate: null,
    checkedAtMs: null, nextCheckAtMs: null, checkError: null, operation: { ...f.operation, phase: "updating-updater" } };
  store.write({ schema: 1, status });
  assert.throws(() => assertNoActiveUpdate(f.directory), /still in progress/);
  store.write({ schema: 1, status: { ...status, operation: { ...f.operation, phase: "complete", result: build(2) } } });
  assertNoActiveUpdate(f.directory);
});
test("stale transaction cannot roll back an unrelated newer image or state", async t => {
  const f = fixture(t); await f.runtime.prepare(f.candidate, f.archive, f.operation); await f.runtime.release();
  f.runner.save({ ...f.runner.config!, active: { ...f.initial.active, imageId: `sha256:${"9".repeat(64)}`, version: "0.1.0-fixture.9", sequence: 9 } });
  const before = f.runner.calls.length;
  await assert.rejects(f.runtime.rollback(f.operation), /newer state was retained/);
  assert.ok(!f.runner.calls.slice(before).some(args => ["stop", "rm", "run"].includes(args[0]!) && !args.includes("--hold-lock")));
});
test("replacement helper drift is rejected before reusing or removing it", async t => {
  const f = fixture(t); await launchWorkerReplacement(f.runner, f.instance, f.candidate.release.imageId, f.operation.id);
  const helper = f.runner.objects.get(`container:gridlens-modern-${f.instance}-updater-replacement`)!;
  (helper.Mounts as unknown[]).push({ Type: "bind", Source: "/", Destination: "/host", RW: true });
  const before = f.runner.calls.length;
  await assert.rejects(launchWorkerReplacement(f.runner, f.instance, f.candidate.release.imageId, f.operation.id), /isolation changed/);
  assert.ok(!f.runner.calls.slice(before).some(args => ["run", "stop", "rm"].includes(args[0]!)));
});
test("rollback reacquires ownership after the previous lock helper was lost", async t => {
  const f = fixture(t); let locks = 0, lost = false;
  const originalHold = f.runner.hold.bind(f.runner), originalRun = f.runner.run.bind(f.runner);
  f.runner.hold = async () => { locks++; lost = false; return originalHold(); };
  f.runner.run = (args, input) => { if (f.runner.held && lost) throw new Error("The installation lock was lost"); return originalRun(args, input); };
  await f.runtime.prepare(f.candidate, f.archive, f.operation); await f.runtime.apply(f.candidate, f.operation);
  lost = true; await f.runtime.rollback(f.operation);
  assert.equal(locks, 2); assert.deepEqual(f.runner.config!.active, f.initial.active);
});
