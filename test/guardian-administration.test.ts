import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync, sign } from "node:crypto";
import { verifyRelease } from "../src/installer/release.ts";
import { createGuardianAdministration } from "../src/backend/guardian-administration.ts";
import type { GuardianAdministrationOptions } from "../src/backend/guardian-administration.ts";
import type { GuardianStatus } from "../src/backend/source-guardian.ts";
import type { PcPermission } from "../src/backend/pc-monitor.ts";
import type { PcAssociation } from "../src/contracts/shared.ts";
import type { TreasuryConfiguration } from "../src/contracts/treasury.ts";

const source = "1".repeat(31) + "2", destination = "1".repeat(31) + "3", alternate = "1".repeat(31) + "4";
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "gridlens-guardian-admin-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const state = new Map<string, unknown>(), remote = new Map<string, GuardianStatus>();
  const releaseKeys = generateKeyPairSync("ed25519"), trustPublicKey = releaseKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const manifest = Buffer.from(JSON.stringify({ format: "gridlens-modern-release-v1", version: "0.1.0-dev.24", sequence: 24, platform: "linux-x64", minimumCoordinator: 3,
    imageId: `sha256:${"1".repeat(64)}`, configImageId: `sha256:${"2".repeat(64)}`, runtime: { name: "gridlens-runtime-linux-x64-0.1.0-dev.24.tar", bytes: 1024, sha256: "3".repeat(64) } }));
  const signature = sign(null, manifest, releaseKeys.privateKey), identity = { manifest, signature, trustPublicKey, release: verifyRelease(manifest, signature, trustPublicKey) };
  const context = { scopeId: "fleet", rosterRevision: "revision", addresses: [source] };
  const pcId = "a".repeat(64), sshFingerprint = `SHA256:${"b".repeat(43)}`;
  const association: PcAssociation = { address: source, name: "generated-pc", sshFingerprint, verifiedAtMs: 1000,
    privateIp: "192.168.91.2", gpuUuids: [], binding: { pcId, runtime: "docker", wrapperId: null, nodeContainerId: "c".repeat(64) } };
  const permission: PcPermission = { version: 1, computer: { id: pcId, host: "192.168.91.2", port: 22, name: "generated-pc", fingerprint: sshFingerprint, hostKey: "generated-unused" },
    associations: [association], rosterRevision: context.rosterRevision, automaticIp: true, rewards: true, gpu: true, approvedAtMs: 1000, revokedAtMs: null, paused: false };
  const permissionKey = `permission:${context.scopeId}:${pcId}`; state.set(permissionKey, permission);
  const configuration: TreasuryConfiguration = { version: 1, revision: 1, destinationAddress: destination, hosts: [{ address: source, label: "generated" }],
    amountBaseUnits: "1000000", reserveLamports: "50000000", maxCostLamports: "5000000", pilotConsumed: true };
  let downloadWait: Promise<void> | undefined, changed = false, provisionCalls = 0, losePolicyReply = false, policyCalls = 0, unavailable = false;
  const options: GuardianAdministrationOptions = {
    state: { get: key => structuredClone(state.get(key)) as never, set: (key, value) => { state.set(key, structuredClone(value)); } },
    vault: { read: () => ({ username: "generated", password: "generated test credential" }), save() {}, forget() {}, close() {} },
    observations: { read: () => ({ associations: [structuredClone(association)] }) } as unknown as GuardianAdministrationOptions["observations"],
    contexts: () => [structuredClone(context)], credentialsDirectory: directory, cacheDirectory: join(directory, "cache"), trustPublicKey,
    build: { version: "0.1.0-dev.24", sequence: 24, buildId: "24:0.1.0-dev.24" },
    async download() { if (downloadWait) await downloadWait; return { ...identity, archivePath: join(directory, "unused-fixture.tar") }; },
    async metadata() { return identity; },
    async inspect(_run, expected) { if (!remote.has(expected.pcId)) throw new Error("Generated guardian absent"); return { imageId: identity.release.configImageId! }; },
    async connect(_pc, _credential, work) { return work(async () => { throw new Error("No command is allowed in this controller fixture."); }); },
    async provision(_run, { enrollment }, authorize) {
      authorize(); if (unavailable) throw new Error("Generated network unavailable");
      const existing = remote.get(pcId);
      if (existing) {
        assert.equal(existing.authorityId, enrollment.authorityId); assert.equal(existing.destinationAddress, enrollment.destinationAddress);
        assert.ok(!enrollment.transferConsumed || existing.transferConsumed);
        return structuredClone(existing);
      }
      provisionCalls++;
      const status: GuardianStatus = { version: 1, authorityId: enrollment.authorityId, publicKeyDer: enrollment.publicKeyDer, ready: true,
        pcId, policyEpoch: 1, destinationAddress: enrollment.destinationAddress, transferConsumed: enrollment.transferConsumed,
        claimedSources: [...enrollment.claimedSources], sources: enrollment.sources.map(row => ({ address: row.address, containerId: row.binding.nodeContainerId, claimSpent: enrollment.claimedSources.includes(row.address) })) };
      remote.set(pcId, status); return structuredClone(status);
    },
    transportFactory: parameters => ({
      async status(target) { if (unavailable) throw new Error("Generated network unavailable"); await parameters.verifyTarget!(async () => { throw new Error("No real commands"); }, target); const value = remote.get(pcId); if (!value) throw new Error("Generated absence"); return structuredClone(value); },
      async setPolicy(target, address, guard, update = {}) { await parameters.verifyTarget!(async () => { throw new Error("No real commands"); }, target); guard(); policyCalls++; const old = remote.get(pcId)!; old.destinationAddress = address; old.policyEpoch++;
        old.transferConsumed ||= update.transferConsumed === true; old.claimedSources = [...new Set([...old.claimedSources, ...update.claimedSources ?? []])];
        if (update.sources) old.sources = update.sources.map(row => ({ address: row.address, containerId: row.binding.nodeContainerId, claimSpent: old.claimedSources.includes(row.address) }));
        if (losePolicyReply) { losePolicyReply = false; unavailable = true; throw new Error("Generated accepted policy with lost reply"); }
        return structuredClone(old); },
      assertReady() {}, async prepare() {}, async transfer() { throw new Error("No signing in controller test"); }, async claim() { throw new Error("No claims in controller test"); },
    }),
  };
  let controller = createGuardianAdministration(options);
  const stable = () => { if (changed) throw new Error("Owner configuration changed"); };
  return { options, directory, state, remote, context, configuration, pcId, permissionKey, permission, association, stable,
    get controller() { return controller; }, get provisionCalls() { return provisionCalls; },
    get policyCalls() { return policyCalls; }, losePolicyReply() { losePolicyReply = true; },
    restoreNetwork() { unavailable = false; },
    changeConfiguration() { changed = true; }, blockDownload() { let release!: () => void; downloadWait = new Promise<void>(resolve => { release = resolve; }); return release; },
    async restart() { await controller.close(); controller = createGuardianAdministration(options); },
    async settle() { for (let n = 0; n < 100; n++) { await new Promise(resolve => setImmediate(resolve)); if (controller.summary(context, configuration.destinationAddress).job?.state !== "running") return; } throw new Error("Fixture job did not settle"); },
  };
}
test("owner-approved enrollment imports spent global allowance and claims, survives restart, and never creates new budgets", async t => {
  const f = fixture(t);
  assert.equal(f.controller.summary(f.context, destination).state, "not-enrolled");
  const claims = [source, "1".repeat(31) + "5"];
  f.controller.startEnrollment({ context: f.context, configuration: f.configuration, claimedSources: claims }, () => {}, f.stable);
  claims.length = 0; // The caller cannot change the approved import after admission.
  await f.settle();
  assert.equal(f.controller.summary(f.context, destination).state, "ready");
  assert.equal(f.remote.get(f.pcId)?.transferConsumed, true); assert.deepEqual(f.remote.get(f.pcId)?.claimedSources, [source, "1".repeat(31) + "5"]);
  const id = f.controller.summary(f.context, destination).authorityId; await f.restart();
  assert.equal(f.controller.summary(f.context, destination).authorityId, id); assert.equal(f.controller.summary(f.context, destination).state, "ready");
  f.controller.startEnrollment({ context: f.context, configuration: { ...f.configuration, pilotConsumed: false }, claimedSources: [] }, () => {}, f.stable);
  await f.settle(); assert.equal(f.provisionCalls, 1); assert.equal(f.remote.get(f.pcId)?.transferConsumed, true); assert.deepEqual(f.remote.get(f.pcId)?.claimedSources, [source, "1".repeat(31) + "5"]);
  assert.notEqual(f.controller.summary(f.context, destination).state, "ready", "unexplained consumed source state cannot authorize a fresh central allowance");
  await f.controller.syncDestination({ context: f.context, destinationAddress: alternate }, () => {});
  assert.equal(f.remote.get(f.pcId)?.destinationAddress, destination, "configuration staging makes no remote mutation");
  f.configuration.destinationAddress = alternate; f.configuration.revision++;
  f.controller.startEnrollment({ context: f.context, configuration: f.configuration, claimedSources: [] }, () => {}, f.stable); await f.settle();
  assert.equal(f.controller.summary(f.context, alternate).state, "ready");
  await f.controller.close();
});
test("lost policy acknowledgment blocks finance across restart until explicit readback and central commit", async t => {
  const f = fixture(t); f.controller.startEnrollment({ context: f.context, configuration: f.configuration, claimedSources: [] }, () => {}, f.stable); await f.settle();
  assert.equal(f.controller.summary(f.context, destination).state, "ready");
  await f.controller.syncDestination({ context: f.context, destinationAddress: alternate }, () => {});
  assert.equal(f.controller.summary(f.context, destination).state, "sync-required");
  f.configuration.destinationAddress = alternate; f.configuration.revision++;
  f.losePolicyReply(); f.controller.startEnrollment({ context: f.context, configuration: f.configuration, claimedSources: [] }, () => {}, f.stable); await f.settle();
  assert.equal(f.controller.summary(f.context, alternate).state, "sync-required");
  const target = { computer: f.permission.computer, credential: { username: "generated", password: "generated" } };
  assert.throws(() => f.controller.transport.assertReady(target, {} as never));
  const calls = f.policyCalls; await f.restart(); f.restoreNetwork();
  assert.equal(f.controller.summary(f.context, alternate).state, "sync-required");
  f.controller.startEnrollment({ context: f.context, configuration: f.configuration, claimedSources: [] }, () => {}, f.stable); await f.settle();
  assert.equal(f.policyCalls, calls, "accepted matching policy is read back, not submitted again");
  assert.equal(f.controller.summary(f.context, alternate).state, "ready");
  await f.controller.close();
});
test("revocation or changed owner configuration during download fences all source mutations", async t => {
  for (const changed of ["grant", "owner"] as const) {
    const f = fixture(t), release = f.blockDownload();
    f.controller.startEnrollment({ context: f.context, configuration: f.configuration, claimedSources: [] }, () => {}, f.stable);
    if (changed === "grant") f.state.set(f.permissionKey, { ...f.permission, revokedAtMs: Date.now() }); else f.changeConfiguration();
    release(); await f.settle(); assert.equal(f.provisionCalls, 0); assert.equal(f.controller.summary(f.context, destination).state, changed === "grant" ? "not-enrolled" : "sync-required");
    assert.equal(f.controller.summary(f.context, destination).job?.state, "interrupted"); await f.controller.close();
  }
});
test("lost owner key and marker cannot create a replacement identity when the retained authority exists", async t => {
  const f = fixture(t); f.controller.startEnrollment({ context: f.context, configuration: f.configuration, claimedSources: [] }, () => {}, f.stable); await f.settle();
  await f.controller.close(); unlinkSync(join(f.directory, "owner-authority-v1.pem")); unlinkSync(join(f.directory, "owner-authority-v1.marker"));
  const recovering = createGuardianAdministration(f.options); assert.equal(recovering.summary(f.context, destination).state, "recovery-required");
  assert.throws(() => recovering.startEnrollment({ context: f.context, configuration: f.configuration, claimedSources: [] }, () => {}, f.stable));
  assert.equal(f.provisionCalls, 1); await recovering.close();
});
test("an orphaned authority key cannot attach itself to a fresh central ledger", async t => {
  const f = fixture(t); f.controller.startEnrollment({ context: f.context, configuration: f.configuration, claimedSources: [] }, () => {}, f.stable); await f.settle();
  await f.controller.close(); f.state.delete("financial.owner-authority.v1");
  const recovering = createGuardianAdministration(f.options);
  assert.equal(recovering.summary(f.context, destination).state, "recovery-required");
  assert.equal(f.state.has("financial.owner-authority.v1"), false);
  assert.throws(() => recovering.startEnrollment({ context: f.context, configuration: f.configuration, claimedSources: [] }, () => {}, f.stable));
  await recovering.close();
});
test("display metadata changes do not re-enroll a source, but changed container bindings do", async t => {
  const f = fixture(t); f.controller.startEnrollment({ context: f.context, configuration: f.configuration, claimedSources: [] }, () => {}, f.stable); await f.settle();
  f.association.name = "Renamed display label"; f.association.verifiedAtMs += 100;
  assert.equal(f.controller.summary(f.context, destination).state, "ready");
  f.association.binding.nodeContainerId = "d".repeat(64);
  assert.equal(f.controller.summary(f.context, destination).state, "not-enrolled"); await f.controller.close();
});
