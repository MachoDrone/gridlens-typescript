import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildCoordinator } from "./build-coordinator.ts";
import { parseRelease } from "../src/installer/release.ts";
import type { ModernRelease } from "../src/installer/release.ts";
import { checked, localDockerRunner } from "../src/installer/docker.ts";
import { compressRuntimeArchive, MAX_RUNTIME_BYTES, sha256 } from "./release-runtime.ts";
import { releaseSourceInputs, sourceInputFingerprint, writeReleaseContext } from "./release-context.ts";
import { COMPONENT_DESCRIPTOR, COMPONENT_SIGNATURE, canonicalPublicKey, coordinatorInputs, loadCoordinatorComponent, loadPublicKey, renderCoordinatorLauncher } from "./release-coordinator.ts";
import type { CoordinatorComponent } from "./release-coordinator.ts";
import { probeBakedImage } from "./release-probe.ts";
import type { BakedImageProof } from "./release-probe.ts";
import { walletMinimumCoordinator, walletReleaseProtocol } from "../src/installer/financial-security.ts";
import { channelAssets, channelFamilyForCoordinator } from "../src/updater/channel-paths.ts";

export interface ModernReleaseBuildOptions {
  output: string; version: string; sequence: number; tag: string; signingKey: string; publicKey: string;
  enableWallet?: boolean; treasuryProtocol?: 1 | 2; cold?: boolean; coordinatorComponent?: string;
}
export interface ReleaseBuildAsset { name: string; path: string; bytes: number; sha256: string }
export interface ReleaseBuildResult {
  bundleDirectory: string; release: ModernRelease; sourceFingerprint: string;
  bakedProof: BakedImageProof;
  runtime: { name: string; bytes: number; sha256: string; compression: "gzip"; expandedBytes: number; expandedSha256: string };
  coordinator: { mode: "new" | "reused"; descriptor: CoordinatorComponent; descriptorSignatureName: string; componentDirectory: string };
  assets: ReleaseBuildAsset[];
}
export function modernDockerBuildArgs(options: Pick<ModernReleaseBuildOptions, "version" | "sequence" | "enableWallet" | "treasuryProtocol" | "cold">, publicKey: string, imageName: string): string[] {
  publicKey = canonicalPublicKey(publicKey);
  return ["build", ...(options.cold ? ["--no-cache"] : []), "--file", "Dockerfile.shared", "--build-arg", `GRIDLENS_VERSION=${options.version}`,
    "--build-arg", `GRIDLENS_TREASURY_PROTOCOL=${walletReleaseProtocol(options)}`, "--build-arg", `GRIDLENS_SEQUENCE=${options.sequence}`,
    "--build-arg", `GRIDLENS_UPDATE_PUBLIC_KEY_BASE64=${Buffer.from(publicKey).toString("base64")}`, "--tag", imageName, "."];
}
export function validateReleaseBuildAssets(assets: readonly ReleaseBuildAsset[], directory: string): void {
  const names = new Set<string>();
  for (const asset of assets) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(asset.name) || names.has(asset.name) || resolve(asset.path) !== join(resolve(directory), asset.name)
      || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > MAX_RUNTIME_BYTES || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error("Invalid or duplicate release artifact inventory entry.");
    names.add(asset.name);
  }
  if (names.size !== 11 && names.size !== 13) throw new Error("Unexpected release artifact inventory size.");
}
/** Build preparation only. An explicit inventory is returned; publication must
 * never glob a directory. Cached builds still verify every signed image blob. */
export async function buildModernReleaseArtifacts(options: ModernReleaseBuildOptions): Promise<ReleaseBuildResult> {
  if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(options.version) || options.version.length > 80 || !Number.isSafeInteger(options.sequence) || options.sequence < 1)
    throw new Error("Use a valid version and monotonically increasing release sequence.");
  if (options.tag !== `modern-v${options.version}`) throw new Error("The signed update channel requires the exact modern-vVERSION release tag.");
  if (process.versions.node !== "24.14.1" || process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) throw new Error("Build with pinned Node 24.14.1 on the supported Linux target.");
  process.umask(0o077);
  const treasuryProtocol = walletReleaseProtocol(options);
  const output = resolve(options.output), project = fileURLToPath(new URL("../", import.meta.url));
  const platform = `linux-${process.arch}` as ModernRelease["platform"];
  const publicKeyText = loadPublicKey(options.publicKey), publicKey = createPublicKey(publicKeyText);
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("The update trust anchor must be Ed25519.");
  const inputs = releaseSourceInputs(project), sourceFingerprint = sourceInputFingerprint(inputs);
  const coordinatorProof = await coordinatorInputs(project, publicKeyText);
  const reused = options.coordinatorComponent ? loadCoordinatorComponent(resolve(options.coordinatorComponent), publicKeyText,
    { inputFingerprint: coordinatorProof.fingerprint, platform }) : undefined;
  // All reuse compatibility checks precede the Docker build and signing-key read.
  mkdirSync(output, { mode: 0o700 });
  const staging = mkdtempSync(join(dirname(output), ".gridlens-release-"));
  try {
    const context = join(staging, "context"); writeReleaseContext(project, context, inputs);
    const runner = localDockerRunner({ execute: (command, args, settings) => spawnSync(command, args, { ...settings, cwd: context }) });
    const docker = (args: string[]): string => checked(runner, args);
    const imageName = `gridlens-modern-build:${options.version}-${options.sequence}`;
    docker(modernDockerBuildArgs(options, publicKeyText, imageName));
    const inspected = JSON.parse(docker(["image", "inspect", imageName])) as { Id: string; Os: string; Architecture: string; Config: { Labels: Record<string, string> } }[];
    const image = inspected[0];
    if (inspected.length !== 1 || !image || !/^sha256:[a-f0-9]{64}$/.test(image.Id) || image.Os !== "linux"
      || image.Architecture !== (process.arch === "x64" ? "amd64" : "arm64") || image.Config?.Labels?.["io.gridlens.product"] !== "shared-backend"
      || image.Config.Labels["io.gridlens.version"] !== options.version || image.Config.Labels["io.gridlens.treasury-protocol"] !== String(treasuryProtocol)
      || image.Config.Labels["io.gridlens.financial-security-protocol"] !== "1" || image.Config.Labels["io.gridlens.guardian-protocol"] !== "1")
      throw new Error("The built image identity, platform or capability differs from the requested release.");
    const bakedProof = probeBakedImage(runner, { imageId: image.Id, version: options.version, sequence: options.sequence, platform,
      publicKey: publicKeyText, treasuryProtocol, inputs, labels: image.Config.Labels });
    const rawPath = join(staging, "runtime.tar"); docker(["save", "--output", rawPath, imageName]);
    const stat = lstatSync(rawPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RUNTIME_BYTES) throw new Error("The runtime archive is not a bounded ordinary file.");
    const compressed = compressRuntimeArchive(readFileSync(rawPath), { imageId: image.Id, version: options.version, platform, imageTag: imageName });
    const artifactName = `gridlens-runtime-${platform}-${options.version}.tar`;
    writeFileSync(join(output, artifactName), compressed.bytes, { mode: 0o600, flag: "wx" });
    const runtime = { name: artifactName, bytes: compressed.bytes.length, sha256: sha256(compressed.bytes) };
    const manifest = parseRelease({ format: "gridlens-modern-release-v1", version: options.version, sequence: options.sequence, platform,
      minimumCoordinator: walletMinimumCoordinator(treasuryProtocol), imageId: compressed.imageId, configImageId: compressed.configImageId, runtime });
    if (sourceInputFingerprint(releaseSourceInputs(project)) !== sourceFingerprint) throw new Error("Source inputs changed during the runtime build.");
    const key = createPrivateKey(readFileSync(options.signingKey));
    if (key.asymmetricKeyType !== "ed25519" || !createPublicKey(key).export({ type: "spki", format: "der" }).equals(publicKey.export({ type: "spki", format: "der" })))
      throw new Error("Signing key does not match the release trust anchor.");
    const writeSigned = (name: string, bytes: Buffer): void => {
      const signature = sign(null, bytes, key);
      if (!verify(null, bytes, publicKey, signature)) throw new Error("Release signature self-check failed.");
      writeFileSync(join(output, `${name}.json`), bytes, { mode: 0o600, flag: "wx" });
      writeFileSync(join(output, `${name}.sig`), signature, { mode: 0o600, flag: "wx" });
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n"); writeSigned("modern-release", manifestBytes);
    const channelNames = channelAssets(platform, channelFamilyForCoordinator(manifest.minimumCoordinator));
    writeSigned(channelNames.manifest.slice(0, -5), Buffer.from(JSON.stringify({ format: "gridlens-modern-channel-v1", channel: "development", platform,
      version: manifest.version, sequence: manifest.sequence, buildId: `${manifest.sequence}:${manifest.version}`, releaseTag: options.tag,
      manifestSha256: sha256(manifestBytes), workerProtocol: 1 }, null, 2) + "\n"));
    const componentDirectory = reused ? resolve(options.coordinatorComponent!) : await buildCoordinator({ outputDirectory: join(output, "coordinator"),
      publicKeyPath: options.publicKey, signingKeyPath: options.signingKey, releaseTag: options.tag });
    const selected = reused ?? loadCoordinatorComponent(componentDirectory, publicKeyText, { inputFingerprint: coordinatorProof.fingerprint, platform });
    const component = selected.component;
    writeFileSync(join(output, COMPONENT_DESCRIPTOR), selected.descriptorBytes, { mode: 0o600, flag: "wx" });
    writeFileSync(join(output, COMPONENT_SIGNATURE), selected.descriptorSignature, { mode: 0o600, flag: "wx" });
    writeFileSync(join(output, "coordinator-manifest.json"), JSON.stringify({ format: "gridlens-modern-coordinator-v1", coordinatorVersion: component.coordinatorVersion,
      node: component.node, platform: component.platform, releaseTag: component.releaseTag, name: component.name, bytes: component.bytes,
      sha256: component.sha256, signature: component.signature, signingPublicKey: publicKeyText }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    writeFileSync(join(output, "modern-start.sh"), renderCoordinatorLauncher(readFileSync(join(project, "scripts/modern-start.sh"), "utf8"), options.tag, component), { mode: 0o700, flag: "wx" });
    copyFileSync(join(project, "LICENSE"), join(output, "LICENSE"));
    copyFileSync(join(dirname(dirname(process.execPath)), "LICENSE"), join(output, "NODE-LICENSE"));
    if (!reused) for (const name of [component.name, component.signature]) copyFileSync(join(componentDirectory, name), join(output, name));
    if (sourceInputFingerprint(releaseSourceInputs(project)) !== sourceFingerprint) throw new Error("Source inputs changed during the release build.");
    const names = [artifactName, COMPONENT_DESCRIPTOR, COMPONENT_SIGNATURE, "coordinator-manifest.json", "modern-start.sh", "modern-release.json", "modern-release.sig",
      channelNames.manifest, channelNames.signature, "LICENSE", "NODE-LICENSE", ...(!reused ? [component.name, component.signature] : [])].sort();
    const assets = names.map(name => { const bytes = readFileSync(join(output, name)); return { name, path: join(output, name), bytes: bytes.length, sha256: sha256(bytes) }; });
    validateReleaseBuildAssets(assets, output);
    return { bundleDirectory: output, release: manifest, sourceFingerprint, bakedProof,
      runtime: { ...runtime, compression: "gzip", expandedBytes: compressed.expandedBytes, expandedSha256: compressed.expandedSha256 },
      coordinator: { mode: reused ? "reused" : "new", descriptor: component, descriptorSignatureName: COMPONENT_SIGNATURE, componentDirectory }, assets };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
/** Preserve the existing builder/CLI return shape for older release automation. */
export async function buildModernRelease(options: ModernReleaseBuildOptions): Promise<string> {
  return (await buildModernReleaseArtifacts(options)).bundleDirectory;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), get = (name: string): string => { const at = args.indexOf(name); if (at < 0 || !args[at + 1]) throw new Error(`Missing ${name}.`); return args[at + 1]!; };
  try {
    console.log(await buildModernRelease({ output: get("--output"), version: get("--version"), sequence: Number(get("--sequence")), tag: get("--tag"),
      signingKey: get("--signing-key"), publicKey: get("--public-key"), enableWallet: args.includes("--enable-wallet"), cold: args.includes("--cold") || args.includes("--no-cache"),
      ...(args.includes("--treasury-protocol") ? { treasuryProtocol: Number(get("--treasury-protocol")) as 1 | 2 } : {}),
      ...(args.includes("--coordinator-component") ? { coordinatorComponent: get("--coordinator-component") } : {}) }));
  } catch (error) { console.error(error instanceof Error ? error.message : "Modern release build failed."); process.exitCode = 1; }
}
