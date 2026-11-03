import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { compressRuntimeArchive } from "../scripts/release-runtime.ts";
import { releaseSourceInputs, sourceInputFingerprint } from "../scripts/release-context.ts";
import { expectedBakedImageProof } from "../scripts/release-probe.ts";
import { canonicalPublicKey, publicKeyFingerprint, renderCoordinatorLauncher } from "../scripts/release-coordinator.ts";
import type { CoordinatorComponent } from "../scripts/release-coordinator.ts";
import type { ReleaseBuildResult } from "../scripts/build-modern-release.ts";
import { digest, identity, REPOSITORY } from "../scripts/release/model.ts";
import type { ReleasePlan } from "../scripts/release/model.ts";
import { verifyBuild, verifyCurrentBuild } from "../scripts/release/artifacts.ts";

function tar(entries: [string, Buffer][]): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, bytes] of entries) {
    const header = Buffer.alloc(512); header.write(name); header.write("0000644\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
    header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124); header.write("00000000000\0", 136); header.fill(32, 148, 156); header[156] = 48;
    header.write(header.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, "0") + "\0 ", 148);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}
function fixture(t: { after(callback: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), "gridlens-artifact-proof-test-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "source"), bundle = join(directory, "bundle"); mkdirSync(source); mkdirSync(bundle);
  const template = "runtime=@RELEASE_TAG@\ncomponent=@COORDINATOR_RELEASE_TAG@\nbinary=@COORDINATOR_NAME@\nhash=@COORDINATOR_SHA256@\n";
  const names = ["Dockerfile.shared", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.browser.json", "LICENSE", "docker/DOCKER-CLI-LICENSE", "docker/DOCKER-CLI-NOTICE", "src/generated.ts", "scripts/modern-start.sh"];
  for (const name of names) { mkdirSync(dirname(join(source, name)), { recursive: true }); writeFileSync(join(source, name), name === "scripts/modern-start.sh" ? template : `generated ${name}\n`); }
  execFileSync("git", ["init", "-q"], { cwd: source }); execFileSync("git", ["add", "--", ...names], { cwd: source });
  const inputs = releaseSourceInputs(source), fingerprint = sourceInputFingerprint(inputs), keys = generateKeyPairSync("ed25519");
  const publicKey = canonicalPublicKey(keys.publicKey.export({ type: "spki", format: "pem" }).toString()), publicPath = join(directory, "public.pem");
  writeFileSync(publicPath, publicKey);
  const version = "0.1.0-dev.22", sequence = 22, platform = "linux-x64" as const, tag = `modern-v${version}`, imageTag = `gridlens-modern-build:${version}-${sequence}`;
  const labels = { "io.gridlens.product": "shared-backend", "io.gridlens.version": version, "io.gridlens.updater-protocol": "1", "io.gridlens.browser-security-protocol": "1", "io.gridlens.treasury-protocol": "1" };
  const json = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));
  const layer = Buffer.from("generated inert layer bytes"), config = json({ architecture: "amd64", os: "linux", config: { Labels: labels }, rootfs: { type: "layers", diff_ids: [`sha256:${digest(layer)}`] } });
  const manifest = json({ schemaVersion: 2, config: { digest: `sha256:${digest(config)}`, size: config.length, mediaType: "application/vnd.oci.image.config.v1+json" },
    layers: [{ digest: `sha256:${digest(layer)}`, size: layer.length, mediaType: "application/vnd.oci.image.layer.v1.tar" }] });
  const blob = (bytes: Buffer): string => `blobs/sha256/${digest(bytes)}`;
  const raw = tar([["oci-layout", json({ imageLayoutVersion: "1.0.0" })], ["index.json", json({ schemaVersion: 2, manifests: [{ digest: `sha256:${digest(manifest)}`, size: manifest.length, mediaType: "application/vnd.oci.image.manifest.v1+json" }] })],
    ["manifest.json", json([{ Config: blob(config), RepoTags: [imageTag], Layers: [blob(layer)] }])], [blob(config), config], [blob(manifest), manifest], [blob(layer), layer]]);
  const archive = compressRuntimeArchive(raw, { imageId: `sha256:${digest(config)}`, version, platform, imageTag });
  const runtime = { name: `gridlens-runtime-${platform}-${version}.tar`, bytes: archive.bytes.length, sha256: digest(archive.bytes) };
  const release = { format: "gridlens-modern-release-v1" as const, version, sequence, platform, minimumCoordinator: 2, imageId: archive.imageId, configImageId: archive.configImageId, runtime };
  const binary = Buffer.from("generated inert coordinator fixture"), component: CoordinatorComponent = { format: "gridlens-coordinator-component-v1", coordinatorVersion: 2, node: "24.14.1", platform,
    releaseTag: tag, name: `gridlens-coordinator-${platform}`, bytes: binary.length, sha256: digest(binary), signature: `gridlens-coordinator-${platform}.sig`, inputFingerprint: "9".repeat(64), publicKeySha256: publicKeyFingerprint(publicKey) };
  const put = (name: string, bytes: Buffer | string): void => { writeFileSync(join(bundle, name), bytes); };
  const signed = (name: string, value: unknown): Buffer => { const bytes = json(value); put(`${name}.json`, bytes); put(`${name}.sig`, sign(null, bytes, keys.privateKey)); return bytes; };
  put(runtime.name, archive.bytes); const releaseBytes = signed("modern-release", release);
  signed(`modern-channel-${platform}`, { format: "gridlens-modern-channel-v1", channel: "development", platform, version, sequence, buildId: `${sequence}:${version}`, releaseTag: tag, manifestSha256: digest(releaseBytes), workerProtocol: 1 });
  signed("coordinator-component", component); put(component.name, binary); put(component.signature, sign(null, binary, keys.privateKey));
  put("coordinator-manifest.json", json({ format: "gridlens-modern-coordinator-v1", coordinatorVersion: 2, node: component.node, platform, releaseTag: tag, name: component.name, bytes: component.bytes, sha256: component.sha256, signature: component.signature, signingPublicKey: publicKey }));
  put("modern-start.sh", renderCoordinatorLauncher(template, tag, component)); copyFileSync(join(source, "LICENSE"), join(bundle, "LICENSE")); copyFileSync(join(dirname(dirname(process.execPath)), "LICENSE"), join(bundle, "NODE-LICENSE"));
  const inventory = [runtime.name, "modern-release.json", "modern-release.sig", `modern-channel-${platform}.json`, `modern-channel-${platform}.sig`, "coordinator-component.json", "coordinator-component.sig", component.name, component.signature, "coordinator-manifest.json", "modern-start.sh", "LICENSE", "NODE-LICENSE"];
  const result: ReleaseBuildResult = { bundleDirectory: bundle, release, sourceFingerprint: fingerprint, runtime: { ...runtime, compression: "gzip", expandedBytes: archive.expandedBytes, expandedSha256: archive.expandedSha256 },
    coordinator: { mode: "new", descriptor: component, descriptorSignatureName: "coordinator-component.sig", componentDirectory: bundle },
    bakedProof: expectedBakedImageProof({ imageId: archive.configImageId, version, sequence, platform, publicKey, treasuryProtocol: 1, inputs, labels }),
    assets: inventory.map(name => { const path = join(bundle, name), bytes = readFileSync(path); return { name, path, bytes: bytes.length, sha256: digest(bytes) }; }) };
  const definition: Omit<ReleasePlan, "planHash"> = { format: "gridlens-release-plan-v1", config: { sourceDirectory: source, sourceCommit: "a".repeat(40), version, sequence, platform, repository: REPOSITORY,
    publicKeyPath: publicPath, signingKeyPath: join(directory, "never-read.pem"), notesPath: join(directory, "notes"), previousTag: "modern-v0.1.0-dev.21", enableWallet: true,
    verification: { base: "b".repeat(40), full: true }, build: { cold: true }, fixture: { sshTarget: "generated@192.168.22.2", address: "192.168.22.2", webPorts: [23101, 23103] as [number, number], requireColdDownload: false } },
    sourceTree: "c".repeat(40), sourceFingerprint: fingerprint, notesSha256: "d".repeat(64), publicKeySha256: component.publicKeySha256, toolchain: { node: "24.14.1", npm: "11.11.0" }, docker: { endpointFingerprint: "e".repeat(64), daemonId: "generated-daemon-id" } };
  const plan: ReleasePlan = { ...definition, planHash: identity(definition) };
  return { source, publicKey, publicPath, result, plan, resultPath: join(directory, "result.json") };
}
test("publisher accepts equivalent CRLF/whitespace public PEM with canonical compatibility metadata", t => {
  const f = fixture(t), original = verifyBuild(f.result, f.plan, f.resultPath);
  writeFileSync(f.publicPath, ` \r\n${f.publicKey.replaceAll("\n", "\r\n")}\r\n `);
  assert.deepEqual(verifyBuild(f.result, f.plan, f.resultPath), original);
});
test("publisher and resume reject missing or altered baked proof even after archive validation is cached", async t => {
  const f = fixture(t); verifyBuild(f.result, f.plan, f.resultPath);
  const missing = structuredClone(f.result) as Partial<ReleaseBuildResult>; delete missing.bakedProof;
  assert.throws(() => verifyBuild(missing as ReleaseBuildResult, f.plan, f.resultPath), /Baked image proof/);
  await assert.rejects(verifyCurrentBuild(missing as ReleaseBuildResult, f.plan, f.resultPath), /Baked image proof/);
  const changes: ((value: ReleaseBuildResult) => void)[] = [
    value => { value.bakedProof.imageId = `sha256:${"f".repeat(64)}`; },
    value => { value.bakedProof.build.sequence++; },
    value => { value.bakedProof.build.version = "0.1.0-dev.23"; },
    value => { value.bakedProof.platform = "linux-arm64"; },
    value => { value.bakedProof.publicKeySha256 = "f".repeat(64); },
    value => { value.bakedProof.capabilities.treasuryProtocol = 0; },
    value => { value.bakedProof.sourceFingerprint = "f".repeat(64); },
    value => { value.bakedProof.bakedFiles[0]!.sha256 = "f".repeat(64); },
    value => { value.bakedProof.bakedFiles.pop(); }
  ];
  for (const change of changes) { const altered = structuredClone(f.result); change(altered); assert.throws(() => verifyBuild(altered, f.plan, f.resultPath), /Baked image proof/); }
  writeFileSync(join(f.source, "src/generated.ts"), "changed source after probe\n");
  assert.throws(() => verifyBuild(f.result, f.plan, f.resultPath), /Baked image proof/);
});
test("baked proof accepts either independently inspected signed image identity, but no other identity", t => {
  const f = fixture(t); verifyBuild(f.result, f.plan, f.resultPath);
  f.result.bakedProof.imageId = f.result.release.imageId;
  assert.doesNotThrow(() => verifyBuild(f.result, f.plan, f.resultPath));
});
