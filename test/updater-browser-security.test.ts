import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserSecurity } from "../src/backend/browser-security.ts";
import { Coordinator, BROWSER_SECURITY_PROTOCOL_LABEL } from "../src/installer/coordinator.ts";
import { ensureVpnWeb } from "../src/installer/vpn-web.ts";
import { ensureUpdater } from "../src/updater/deployment.ts";
import { createUpdateRuntime } from "../src/updater/runtime.ts";
import { createUpdateEngine } from "../src/updater/engine.ts";
import { openUpdateState } from "../src/updater/state.ts";
import type { CommandResult } from "../src/installer/docker.ts";
import type { ModernRelease } from "../src/installer/release.ts";
import type { UpdateOperation, UpdateStatus } from "../src/contracts/updates.ts";
import type { VerifiedCandidate } from "../src/updater/release.ts";
import { UpdateDockerFixture } from "./fixtures/updater-docker.ts";

const bytes = Buffer.from("isolated old-worker upgrade archive");
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const release = (sequence: number): ModernRelease => ({ format: "gridlens-modern-release-v1", version: `0.1.0-fixture.${sequence}`, sequence,
  platform: "linux-x64", minimumCoordinator: 1, imageId: `sha256:${hash(`fixture-image-${sequence}`)}`,
  runtime: { name: `gridlens-runtime-fixture-${sequence}.tar`, bytes: bytes.length, sha256: hash(bytes) } });
const build = (sequence: number) => ({ version: release(sequence).version, sequence, buildId: `${sequence}:${release(sequence).version}` });
function certificates(directory: string) {
  const run = (args: string[]) => execFileSync("openssl", args, { cwd: directory, stdio: "ignore" });
  run(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "2",
    "-subj", "/CN=Generated updater migration CA", "-addext", "basicConstraints=critical,CA:TRUE"]);
  run(["req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=Generated updater migration leaf"]);
  writeFileSync(join(directory, "leaf.ext"), "basicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:10.70.0.8\n");
  run(["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-set_serial", "1", "-days", "1", "-out", "server.crt", "-extfile", "leaf.ext"]);
  return { certificatePem: readFileSync(join(directory, "ca.crt"), "utf8"), serverCertificatePem: readFileSync(join(directory, "server.crt"), "utf8") };
}
class MigrationDocker extends UpdateDockerFixture {
  targetProtocol: string | undefined = "1";
  publicFailures = 0; publicReads = 0; publications = 0;
  readonly events: string[] = [];
  readonly ledger = new Map<string, unknown>();
  readonly browserSecurity = createBrowserSecurity({ get: <T>(key: string) => this.ledger.get(key) as T | undefined,
    set: (key, value) => { this.ledger.set(key, structuredClone(value)); } }, this.serverId);
  readonly publicCertificates: { certificatePem: string; serverCertificatePem: string };
  constructor(directory: string, publicCertificates: { certificatePem: string; serverCertificatePem: string }) {
    super("migration-fixture", join(directory, "installation.json"), [release(13), release(14)]);
    this.publicCertificates = publicCertificates;
  }
  override run(args: readonly string[], input?: string | Uint8Array): CommandResult {
    const ok = (value: unknown): CommandResult => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });
    if (args[0] === "run" && args.at(-1) === "public-browser-certificates") {
      assert.equal(this.held, true, "publication must hold installation maintenance ownership");
      this.calls.push([...args]); this.publicReads++; this.events.push("public-certificate-read");
      if (this.publicFailures > 0) { this.publicFailures--; return { status: 1, stdout: "", stderr: "Synthetic public certificate read failure" }; }
      return ok(this.publicCertificates);
    }
    if (args[0] === "exec" && args.at(-1) === "json" && typeof input === "string") {
      const body = JSON.parse(input);
      if (body.operation === "browser-security-publish") {
        assert.equal(this.held, true); this.calls.push([...args]); this.events.push("publish");
        const { operation: _operation, ...publication } = body;
        this.browserSecurity.publish(publication); this.publications++; return ok({ published: true });
      }
    }
    const result = super.run(args, input);
    if (args[0] === "image" && args[1] === "inspect" && result.status === 0 && args.at(-1) === release(14).imageId && this.targetProtocol !== undefined) {
      const images = JSON.parse(result.stdout); images[0].Config.Labels[BROWSER_SECURITY_PROTOCOL_LABEL] = this.targetProtocol; return ok(images);
    }
    if (args[0] === "run" && args.at(-1) === "initialize") {
      this.save({ ...this.config!, certificateSha256: hash(new X509Certificate(this.publicCertificates.serverCertificatePem).raw) }); return ok(this.config);
    }
    return result;
  }
}
async function oldWorkerApplied(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "gridlens-old-worker-security-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runner = new MigrationDocker(directory, certificates(directory)), coordinator = new Coordinator(runner);
  const initial = coordinator.install({ instance: runner.instance, release: release(13), action: "setup", enableUpdater: true, bindAddress: "10.70.0.8" }).config;
  ensureVpnWeb(runner, initial, release(13), 18321); ensureUpdater(runner, initial);
  const candidate: VerifiedCandidate = { ...build(14), id: hash("migration manifest"), release: release(14), sizeBytes: bytes.length,
    releaseTag: `modern-v${release(14).version}`, workerProtocol: 1 };
  const operation: UpdateOperation = { id: "migration-operation", revision: 7, target: build(14), previous: build(13), phase: "updating-updater",
    startedAtMs: 1, updatedAtMs: 1, downloadedBytes: bytes.length, totalBytes: bytes.length, error: null, result: null };
  mkdirSync(join(directory, "downloads")); const archive = join(directory, "downloads", `${candidate.id}.tar`); writeFileSync(archive, bytes);
  const old = createUpdateRuntime({ instance: runner.instance, stateDirectory: directory, configurationPath: runner.configPath, runner, probe: async () => {} });
  await old.prepare(candidate, archive, { ...operation, phase: "preparing" });
  // Execute the pre-feature apply sequence: replace runtime/gateways, but never
  // call the new metadata publisher. The replacement worker inherits this journal.
  const installed = coordinator.install({ instance: runner.instance, release: release(14), action: "upgrade", enableUpdater: true });
  ensureVpnWeb(runner, installed.config, release(14), 18321, { upgrade: true }); ensureUpdater(runner, installed.config, { replace: true });
  await old.release(); assert.equal(runner.browserSecurity.read().status.available, false);
  let time = 10_000, step = 1000;
  const runtime = createUpdateRuntime({ instance: runner.instance, stateDirectory: directory, configurationPath: runner.configPath, runner,
    probe: async origin => { runner.events.push(`probe:${origin}`); }, now: () => time, sleep: async () => { time += step; } });
  t.after(() => runtime.release());
  return { directory, runner, initial, candidate, operation, archive, runtime, fastFailure() { step = 300_001; } };
}
function seedEngineState(directory: string, candidate: VerifiedCandidate, operation: UpdateOperation) {
  const store = openUpdateState(join(directory, "worker-journal"));
  store.write({ schema: 1, highestSequence: 14, highestId: candidate.id, attemptedAtMs: null, retryAtMs: null, failures: 0,
    candidate, job: { candidate, idempotencyKey: "migration_request_key" }, receipts: [],
    status: { version: 1, supported: true, canUpdate: true, checking: false, current: build(14), candidate: null,
      checkedAtMs: null, nextCheckAtMs: null, checkError: null, operation } });
  return store;
}

test("replacement worker resumes updating-updater and publishes before completion without reapplying the image", async t => {
  const f = await oldWorkerApplied(t), before = structuredClone(f.runner.config), calls = f.runner.calls.length;
  f.runner.publicFailures = 1;
  const store = seedEngineState(f.directory, f.candidate, f.operation), originalWrite = store.write;
  store.write = value => {
    if ((value as { status?: UpdateStatus }).status?.operation?.phase === "complete") assert.equal(f.runner.browserSecurity.read().status.available, true);
    originalWrite(value);
  };
  const engine = await createUpdateEngine({ store, runtime: f.runtime, directory: f.directory, platform: "linux-x64", publicKey: "unused injected key",
    automatic: false, discover: async () => { throw new Error("Resume must not discover another release"); }, download: async () => f.archive });
  try {
    await engine.idle(); assert.equal(engine.status().operation?.phase, "complete");
    assert.equal(f.runner.publicReads, 3, "one failed read retries, then both verification passes publish idempotently");
    assert.equal(f.runner.publications, 2);
    const status = f.runner.browserSecurity.read().status; assert(status.available);
    assert.equal(status.serverId, f.runner.serverId); assert.equal(status.httpsOrigin, f.initial.origin); assert.equal(status.httpOrigin, "http://10.70.0.8:18321");
    assert.equal(status.serverCertificateSha256, f.initial.certificateSha256);
    assert.deepEqual(f.runner.config, before);
    for (const call of f.runner.calls.slice(calls)) assert.ok(!["load", "stop", "rm"].includes(call[0]!) && !call.includes("copy-state"));
    const published = f.runner.events.indexOf("publish");
    assert.ok(f.runner.events.slice(0, published).includes(`probe:${f.initial.origin}`));
    assert.ok(f.runner.events.slice(0, published).includes("probe:http://10.70.0.8:18321"));
    assert.equal(f.runner.held, false);
  } finally { await engine.close(); }
});

test("failed resumed publication cannot complete and rollback preserves the failure and pre-feature identity", async t => {
  const f = await oldWorkerApplied(t); f.runner.publicFailures = Infinity; f.fastFailure();
  const store = seedEngineState(f.directory, f.candidate, f.operation), phases: string[] = [], originalWrite = store.write;
  store.write = value => { phases.push((value as { status: UpdateStatus }).status.operation!.phase); originalWrite(value); };
  const engine = await createUpdateEngine({ store, runtime: f.runtime, directory: f.directory, platform: "linux-x64", publicKey: "unused injected key",
    automatic: false, download: async () => f.archive });
  let error: string | null;
  try {
    await engine.idle(); const status = engine.status(); error = status.operation!.error;
    assert.equal(status.operation?.phase, "rolled-back"); assert(error); assert.equal(phases.includes("complete"), false);
    assert.deepEqual(f.runner.config!.active, f.initial.active); assert.equal(f.runner.config!.certificateSha256, f.initial.certificateSha256);
    assert.equal(f.runner.browserSecurity.read().status.available, false);
    assert.equal(f.runner.publications, 0); assert.equal(f.runner.publicReads, 2, "rollback to an image without the capability must not export or publish");
  } finally { await engine.close(); }
  const reopened = openUpdateState(join(f.directory, "worker-journal"));
  try { const saved = reopened.read() as { status: UpdateStatus }; assert.equal(saved.status.operation?.phase, "rolled-back"); assert.equal(saved.status.operation?.error, error); }
  finally { reopened.close(); }
});

test("resumed publication rejects lost ownership and changed server or certificate identities", async t => {
  const f = await oldWorkerApplied(t); f.fastFailure();
  await assert.rejects(f.runtime.verify(f.candidate, f.operation), /maintenance lock/);
  assert.equal(f.runner.publicReads, 0);
  await f.runtime.prepare(f.candidate, f.archive, f.operation);
  const originalId = f.runner.serverId; f.runner.serverId = "unrelated-server";
  await assert.rejects(f.runtime.verify(f.candidate, f.operation), /runtime identity/); assert.equal(f.runner.publicReads, 0);
  f.runner.serverId = originalId;
  const saved = structuredClone(f.runner.config!); f.runner.save({ ...saved, certificateSha256: "0".repeat(64) });
  await assert.rejects(f.runtime.verify(f.candidate, f.operation), /runtime identity/); assert.equal(f.runner.publicReads, 0);
  f.runner.save(saved); f.runner.publicCertificates.serverCertificatePem = f.runner.publicCertificates.certificatePem;
  await assert.rejects(f.runtime.verify(f.candidate, f.operation), /public TLS identity/); assert.equal(f.runner.publications, 0);
});

test("verification skips pre-feature images and rejects unsupported browser setup capabilities", async t => {
  const f = await oldWorkerApplied(t); f.fastFailure();
  await f.runtime.prepare(f.candidate, f.archive, f.operation);
  f.runner.targetProtocol = undefined; await f.runtime.verify(f.candidate, f.operation);
  assert.equal(f.runner.publicReads, 0); assert.equal(f.runner.publications, 0);
  f.runner.targetProtocol = "2"; await assert.rejects(f.runtime.verify(f.candidate, f.operation), /unsupported browser security protocol/);
  assert.equal(f.runner.publicReads, 0); assert.equal(f.runner.publications, 0);
});
