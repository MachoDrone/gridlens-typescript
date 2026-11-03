import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { verify } from "node:crypto";
import { verifyRelease } from "../../src/installer/release.ts";
import { verifyChannel } from "../../src/updater/release.ts";
import { COMPONENT_DESCRIPTOR, COMPONENT_SIGNATURE, coordinatorInputs, loadPublicKey, publicKeyFingerprint, renderCoordinatorLauncher, verifyCoordinatorComponent } from "../release-coordinator.ts";
import { validateReleaseBuildAssets } from "../build-modern-release.ts";
import type { ReleaseBuildResult } from "../build-modern-release.ts";
import { verifyRuntimeArchive } from "../release-runtime.ts";
import { releaseSourceInputs } from "../release-context.ts";
import { expectedBakedImageProof } from "../release-probe.ts";
import { ordinaryFile } from "./files.ts";
import { digest, identity } from "./model.ts";
import type { Asset, Candidate, ReleasePlan } from "./model.ts";
import type { GitHub } from "./github.ts";
import { verifyFileSignature } from "./github.ts";
import { assetMatches } from "./github.ts";

const verifiedArchives = new Map<string, ReturnType<typeof verifyRuntimeArchive>>();

export function verifyBuild(result: ReleaseBuildResult, plan: ReleasePlan, resultPath: string): Candidate {
  const directory = resolve(result.bundleDirectory), publicKey = loadPublicKey(plan.config.publicKeyPath);
  if (publicKeyFingerprint(publicKey) !== plan.publicKeySha256 || result.sourceFingerprint !== plan.sourceFingerprint) throw new Error("Build source or trust anchor differs from the release plan.");
  validateReleaseBuildAssets(result.assets, directory);
  for (const asset of result.assets) {
    const bytes = ordinaryFile(asset.path, 1024 ** 3);
    if (bytes.length !== asset.bytes || digest(bytes) !== asset.sha256) throw new Error("Release artifact changed after building.");
  }
  const bytes = ordinaryFile(join(directory, "modern-release.json"), 16384);
  const manifest = verifyRelease(bytes, ordinaryFile(join(directory, "modern-release.sig"), 64), publicKey);
  const channel = verifyChannel(ordinaryFile(join(directory, `modern-channel-${plan.config.platform}.json`), 16384),
    ordinaryFile(join(directory, `modern-channel-${plan.config.platform}.sig`), 64), publicKey);
  const componentBytes = ordinaryFile(join(directory, COMPONENT_DESCRIPTOR), 16384);
  const component = verifyCoordinatorComponent(componentBytes, ordinaryFile(join(directory, COMPONENT_SIGNATURE), 64), publicKey);
  const manifestSha256 = digest(bytes);
  if (manifest.version !== plan.config.version || manifest.sequence !== plan.config.sequence || manifest.platform !== plan.config.platform
    || manifest.minimumCoordinator !== (plan.config.enableWallet ? 2 : 1) || identity(manifest) !== identity(result.release)
    || channel.manifestSha256 !== manifestSha256 || channel.version !== manifest.version || channel.sequence !== manifest.sequence
    || channel.platform !== manifest.platform || channel.releaseTag !== `modern-v${manifest.version}`
    || component.platform !== plan.config.platform || component.coordinatorVersion < manifest.minimumCoordinator
    || identity(component) !== identity(result.coordinator.descriptor)) throw new Error("Signed release metadata is inconsistent with the plan.");
  if (!result.bakedProof || typeof result.bakedProof.imageId !== "string"
    || ![manifest.imageId, manifest.configImageId].includes(result.bakedProof.imageId)) throw new Error("Baked image proof is missing or does not identify the signed image.");
  const expectedProof = expectedBakedImageProof({ imageId: result.bakedProof.imageId, version: plan.config.version, sequence: plan.config.sequence,
    platform: plan.config.platform, publicKey, treasuryProtocol: plan.config.enableWallet ? 1 : 0, inputs: releaseSourceInputs(plan.config.sourceDirectory),
    labels: { "io.gridlens.product": "shared-backend", "io.gridlens.version": plan.config.version, "io.gridlens.updater-protocol": "1",
      "io.gridlens.browser-security-protocol": "1", "io.gridlens.treasury-protocol": plan.config.enableWallet ? "1" : "0" } });
  if (expectedProof.sourceFingerprint !== plan.sourceFingerprint || identity(result.bakedProof) !== identity(expectedProof))
    throw new Error("Baked image proof differs from the current source, build, public identity or capabilities.");
  const names = [manifest.runtime.name, COMPONENT_DESCRIPTOR, COMPONENT_SIGNATURE, "coordinator-manifest.json", "modern-start.sh", "modern-release.json", "modern-release.sig",
    `modern-channel-${manifest.platform}.json`, `modern-channel-${manifest.platform}.sig`, "LICENSE", "NODE-LICENSE",
    ...(result.coordinator.mode === "new" ? [component.name, component.signature] : [])].sort();
  if (result.assets.map(asset => asset.name).sort().join("|") !== names.join("|") || result.coordinator.mode === "new" && component.releaseTag !== channel.releaseTag
    || result.coordinator.mode === "reused" && component.releaseTag === channel.releaseTag) throw new Error("Release inventory is not the exact supported artifact allowlist.");
  const runtime = result.assets.find(asset => asset.name === manifest.runtime.name)!;
  if (runtime.bytes !== manifest.runtime.bytes || runtime.sha256 !== manifest.runtime.sha256) throw new Error("Runtime inventory differs from the signed manifest.");
  // A deep proof may be reused only inside this process after the exact compressed
  // bytes were hashed again above. Restart performs a fresh complete validation.
  const archiveKey = identity({ sha256: runtime.sha256, imageId: manifest.imageId, configImageId: manifest.configImageId, version: manifest.version, platform: manifest.platform, sequence: manifest.sequence });
  let archive = verifiedArchives.get(archiveKey);
  if (!archive) {
    archive = verifyRuntimeArchive(ordinaryFile(runtime.path, 1024 ** 3), { imageId: manifest.imageId, version: manifest.version, platform: manifest.platform,
      imageTag: `gridlens-modern-build:${manifest.version}-${manifest.sequence}` });
    if (verifiedArchives.size >= 4) verifiedArchives.delete(verifiedArchives.keys().next().value!);
    verifiedArchives.set(archiveKey, archive);
  }
  if (archive.configImageId !== manifest.configImageId || archive.compression !== result.runtime.compression
    || archive.expandedBytes !== result.runtime.expandedBytes || archive.expandedSha256 !== result.runtime.expandedSha256) throw new Error("Runtime archive identity or compression evidence differs from the verified bytes.");
  const launcher = renderCoordinatorLauncher(readFileSync(join(plan.config.sourceDirectory, "scripts/modern-start.sh"), "utf8"), channel.releaseTag, component);
  if (readFileSync(join(directory, "modern-start.sh"), "utf8") !== launcher || !ordinaryFile(join(directory, "LICENSE")).equals(ordinaryFile(join(plan.config.sourceDirectory, "LICENSE")))) throw new Error("Launcher pins or license differ from the reviewed source.");
  const compatibility = JSON.parse(ordinaryFile(join(directory, "coordinator-manifest.json"), 16384).toString("utf8"));
  const expectedCompatibility = { format: "gridlens-modern-coordinator-v1", coordinatorVersion: component.coordinatorVersion, node: component.node,
    platform: component.platform, releaseTag: component.releaseTag, name: component.name, bytes: component.bytes, sha256: component.sha256,
    signature: component.signature, signingPublicKey: publicKey };
  if (identity(compatibility) !== identity(expectedCompatibility)
    || !ordinaryFile(join(directory, "NODE-LICENSE")).equals(ordinaryFile(join(dirname(dirname(process.execPath)), "LICENSE")))) throw new Error("Coordinator compatibility metadata or pinned Node license changed.");
  if (result.coordinator.mode === "new") {
    const binary = ordinaryFile(join(directory, component.name), 256 * 1024 ** 2);
    if (binary.length !== component.bytes || digest(binary) !== component.sha256 || !verify(null, binary, publicKey, ordinaryFile(join(directory, component.signature), 64))) throw new Error("Coordinator binary failed signature verification.");
  }
  const candidateHash = identity({ planHash: plan.planHash, manifestSha256, assets: result.assets.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })).sort((a, b) => a.name.localeCompare(b.name)) });
  return { assets: result.assets, bundleDirectory: directory, manifestSha256, candidateHash, buildResultPath: resultPath };
}
export async function verifyCurrentBuild(result: ReleaseBuildResult, plan: ReleasePlan, resultPath: string): Promise<Candidate> {
  const candidate = verifyBuild(result, plan, resultPath);
  const inputs = await coordinatorInputs(plan.config.sourceDirectory, loadPublicKey(plan.config.publicKeyPath));
  if (inputs.fingerprint !== result.coordinator.descriptor.inputFingerprint) throw new Error("Signed coordinator does not match the current complete coordinator input closure.");
  return candidate;
}
export async function verifyPublicComponent(github: GitHub, result: ReleaseBuildResult, directory: string, publicKey: string): Promise<void> {
  const component = result.coordinator.descriptor;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const files = [COMPONENT_DESCRIPTOR, COMPONENT_SIGNATURE, component.name, component.signature];
  const release = await github.release(component.releaseTag);
  if (!release || release.draft) throw new Error("The reusable coordinator release is not public.");
  for (const name of files) {
    const local = ordinaryFile(join(result.coordinator.componentDirectory, name), name === component.name ? 256 * 1024 ** 2 : 16384);
    const remote = release.assets.filter(asset => asset.name === name);
    if (remote.length !== 1 || !assetMatches(remote[0]!, { name, bytes: local.length, sha256: digest(local) })) throw new Error("Public coordinator asset identity differs from the signed reusable component.");
  }
  for (const name of files) {
    const path = join(directory, name);
    if (!existsSync(path)) await github.download(component.releaseTag, name, path,
      name === component.name ? { bytes: component.bytes, sha256: component.sha256 } : undefined);
  }
  const got = verifyCoordinatorComponent(ordinaryFile(join(directory, COMPONENT_DESCRIPTOR), 16384), ordinaryFile(join(directory, COMPONENT_SIGNATURE), 64), publicKey);
  if (identity(got) !== identity(component)) throw new Error("Published coordinator component differs from the verified reusable component.");
  const binary = ordinaryFile(join(directory, component.name), 256 * 1024 ** 2);
  if (binary.length !== component.bytes || digest(binary) !== component.sha256) throw new Error("Published coordinator binary differs from its descriptor.");
  await verifyFileSignature(join(directory, component.name), ordinaryFile(join(directory, component.signature), 64), publicKey);
}
export function verifyDownloadedAssets(assets: readonly Asset[], expected: readonly Asset[]): void {
  if (assets.length !== expected.length) throw new Error("Anonymous public download proof is incomplete.");
  for (const asset of expected) {
    const downloaded = assets.find(item => item.name === asset.name);
    if (!downloaded || downloaded.sha256 !== asset.sha256 || downloaded.bytes !== asset.bytes) throw new Error("Anonymous public download proof differs from the candidate.");
    const bytes = ordinaryFile(downloaded.path, 1024 ** 3);
    if (bytes.length !== asset.bytes || digest(bytes) !== asset.sha256) throw new Error("Anonymous download evidence changed.");
  }
}
