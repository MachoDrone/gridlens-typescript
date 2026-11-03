import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest, identity, PUBLIC_KEY_SHA256, REPOSITORY } from "../scripts/release/model.ts";
import type { Candidate, ReleaseConfig, ReleasePlan } from "../scripts/release/model.ts";
import { publicInstallerAcceptance } from "../scripts/release/public-installer.ts";
import type { PublicLauncher } from "../scripts/release/public-installer.ts";
import type { FixtureDocker } from "../scripts/release/fixture-docker.ts";
import type { Snapshot } from "../scripts/release/fixture-snapshot.ts";
import type { GitHub } from "../scripts/release/github.ts";
import type { ModernRelease } from "../src/installer/release.ts";

function setup(t: { after(callback: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), "gridlens-public-installer-test-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bundle = join(directory, "bundle"); mkdirSync(bundle);
  const keys = generateKeyPairSync("ed25519"), publicPath = join(directory, "public.pem"); writeFileSync(publicPath, keys.publicKey.export({ type: "spki", format: "pem" }));
  const config: ReleaseConfig = { sourceDirectory: join(directory, "source"), sourceCommit: "a".repeat(40), version: "0.1.0-dev.22", sequence: 22,
    platform: "linux-x64", repository: REPOSITORY, publicKeyPath: publicPath, signingKeyPath: join(directory, "never-read.pem"), notesPath: join(directory, "notes"),
    previousTag: "modern-v0.1.0-dev.21", enableWallet: true, verification: { base: "b".repeat(40), full: true }, build: { cold: true },
    fixture: { sshTarget: "generated@192.168.22.2", address: "192.168.22.2", webPorts: [23101, 23103], requireColdDownload: false } };
  const definition = { format: "gridlens-release-plan-v1" as const, config, sourceTree: "c".repeat(40), sourceFingerprint: "d".repeat(64), notesSha256: "e".repeat(64), publicKeySha256: PUBLIC_KEY_SHA256, toolchain: { node: "24.14.1", npm: "11.11.0" }, docker: { endpointFingerprint: "f".repeat(64), daemonId: "generated-daemon-identity" } };
  const plan: ReleasePlan = { ...definition, planHash: identity(definition) };
  const release = (sequence: number): ModernRelease => ({ format: "gridlens-modern-release-v1", version: `0.1.0-dev.${sequence}`, sequence, platform: "linux-x64", minimumCoordinator: 2,
    imageId: `sha256:${digest(`image-${sequence}`)}`, configImageId: `sha256:${digest(`config-${sequence}`)}`,
    runtime: { name: `gridlens-runtime-linux-x64-0.1.0-dev.${sequence}.tar`, bytes: 1024, sha256: "f".repeat(64) } });
  const current = release(22), previous = release(21), currentBytes = Buffer.from(JSON.stringify(current));
  writeFileSync(join(bundle, "modern-release.json"), currentBytes); writeFileSync(join(bundle, "modern-release.sig"), sign(null, currentBytes, keys.privateKey));
  const candidate: Candidate = { assets: [], bundleDirectory: bundle, manifestSha256: digest(currentBytes), candidateHash: "1".repeat(64), buildResultPath: join(directory, "unused.json") };
  const steps: string[] = [], installed = new Map<string, ModernRelease>(), configured = new Set<string>(); let closes = 0;
  const flags = { failUpgrade: false, failCleanup: false, imagePresent: true, mutatePreservedIdentity: false };
  const github = { async download(_tag: string, name: string, destination: string) {
    const bytes = Buffer.from(JSON.stringify(previous)), body = name.endsWith(".sig") ? sign(null, bytes, keys.privateKey) : bytes;
    writeFileSync(destination, body); return { name, path: destination, bytes: body.length, sha256: digest(body) };
  } } as GitHub;
  const docker = {
    async portsAvailable() { steps.push("preflight-ports"); }, async absent() { steps.push("preflight-empty"); }, async imagePresent() { return flags.imagePresent; },
    async cleanup(fixtures: { instance: string }[]) { steps.push("cleanup"); if (flags.failCleanup) throw new Error("injected cleanup failure"); return { cleanupVerified: true, removed: fixtures.map(f => f.instance), releaseImagesRetained: true }; }
  } as unknown as FixtureDocker;
  const launcher: PublicLauncher = async (_profile, fixture, tag, action, logPath) => {
    steps.push(`${tag}:${action}`); writeFileSync(logPath, "generated public launcher fixture log\n");
    if (flags.failUpgrade && action === "upgrade" && tag.endsWith("22")) throw new Error("original generated installer failure");
    const next = tag.endsWith("22") ? current : previous, old = installed.get(fixture.instance);
    if (!old || next.sequence > old.sequence) installed.set(fixture.instance, next);
  };
  const snapshot: NonNullable<Parameters<typeof publicInstallerAcceptance>[4]>["snapshot"] = async (profile, fixture) => {
    const active = installed.get(fixture.instance)!;
    const value: Snapshot = { config: { instance: fixture.instance, origin: `https://${profile.address}:${fixture.httpsPort}`, bindAddress: profile.address,
      port: fixture.httpsPort, certificateSha256: "9".repeat(64), active, ...(active.sequence === 22 && fixture.instance.endsWith("-up") ? { previous } : {}) },
      serverId: "generated-server", context: { addresses: [] }, publicCaSha256: "2".repeat(64), grantIdentitySha256: "3".repeat(64),
      audit: { walletOwnerConfigured: configured.has(fixture.instance) }, containers: { owner: { image: active.imageId } } };
    if (flags.mutatePreservedIdentity && active.sequence === 22 && fixture.instance.endsWith("-up")) value.serverId = "unexpected-replacement";
    return value;
  };
  const owner: NonNullable<Parameters<typeof publicInstallerAcceptance>[4]>["owner"] = async (_profile, fixture) => {
    steps.push("configure-owner"); configured.add(fixture.instance);
    return { async check(restarted) { steps.push(`owner-check:${restarted}`); return { sameGeneratedPasswordUnlocks: true }; }, close() { closes++; } };
  };
  return { directory, plan, candidate, github, dependencies: { docker, launcher, snapshot, owner }, steps, flags, closes: () => closes };
}
test("maintained public acceptance runs fresh, configured upgrade and both older retention paths before cleanup", async t => {
  const f = setup(t), directory = join(f.directory, "acceptance");
  const receipt = await publicInstallerAcceptance(f.plan, f.candidate, directory, f.github, f.dependencies);
  assert.equal(receipt.cleanupVerified, true); assert.equal(receipt.configuredOwnerPreserved, true); assert.equal(receipt.coldRuntimeDownload, false);
  assert.deepEqual(receipt.stages.map(stage => stage.stage), ["fresh", "seed", "upgrade", "retain-setup", "retain-upgrade"]);
  assert.equal(f.steps.filter(step => step === "owner-check:true").length, 1); assert.equal(f.steps.filter(step => step === "owner-check:false").length, 2);
  assert.equal(f.steps.at(-1), "cleanup"); assert.equal(f.closes(), 1);
  const count = f.steps.length;
  assert.deepEqual(await publicInstallerAcceptance(f.plan, f.candidate, directory, f.github, f.dependencies), receipt);
  assert.equal(f.steps.length, count, "exact completed evidence is reused without running another owner setup");
  writeFileSync(receipt.evidence.find(item => item.path.endsWith("upgrade.json"))!.path, "{}\n");
  await assert.rejects(publicInstallerAcceptance(f.plan, f.candidate, directory, f.github, f.dependencies), /evidence changed/);
});
test("failed public upgrade clears generated secrets and cleanup cannot replace the original error", async t => {
  const f = setup(t); f.flags.failUpgrade = true; f.flags.failCleanup = true;
  await assert.rejects(publicInstallerAcceptance(f.plan, f.candidate, join(f.directory, "acceptance"), f.github, f.dependencies), /original generated installer failure/);
  assert.equal(f.closes(), 1); assert.equal(f.steps.at(-1), "cleanup");
});
test("public acceptance rejects changed identity and never declares a preloaded image cold", async t => {
  const f = setup(t); f.flags.mutatePreservedIdentity = true;
  await assert.rejects(publicInstallerAcceptance(f.plan, f.candidate, join(f.directory, "changed"), f.github, f.dependencies), /preservation failed/);
  const cold = setup(t); cold.plan.config.fixture.requireColdDownload = true;
  await assert.rejects(publicInstallerAcceptance(cold.plan, cold.candidate, join(cold.directory, "cold"), cold.github, cold.dependencies), /already present/);
  assert.equal(cold.steps.some(step => step.startsWith("modern-v")), false);
});
test("interrupted fixture generation is cleaned before a fresh generation can be tested", async t => {
  const f = setup(t), directory = join(f.directory, "acceptance"); f.flags.failUpgrade = true;
  await assert.rejects(publicInstallerAcceptance(f.plan, f.candidate, directory, f.github, f.dependencies), /original/);
  const old = JSON.parse(readFileSync(join(directory, "fixtures.json"), "utf8")) as { generation: string };
  f.flags.failUpgrade = false; f.steps.length = 0;
  const receipt = await publicInstallerAcceptance(f.plan, f.candidate, directory, f.github, f.dependencies);
  const fresh = JSON.parse(readFileSync(join(directory, "fixtures.json"), "utf8")) as { generation: string };
  assert.equal(f.steps[0], "cleanup"); assert.notEqual(fresh.generation, old.generation); assert.equal(receipt.cleanupVerified, true);
});
