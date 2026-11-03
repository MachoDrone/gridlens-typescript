import { build } from "esbuild";
import { createPublicKey, verify } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { COORDINATOR_VERSION } from "../src/installer/release.ts";
import { sha256 } from "./release-runtime.ts";

export const COMPONENT_DESCRIPTOR = "coordinator-component.json";
export const COMPONENT_SIGNATURE = "coordinator-component.sig";
export interface CoordinatorComponent {
  format: "gridlens-coordinator-component-v1";
  coordinatorVersion: number;
  node: "24.14.1";
  platform: "linux-x64" | "linux-arm64";
  releaseTag: string;
  name: string;
  bytes: number;
  sha256: string;
  signature: string;
  inputFingerprint: string;
  publicKeySha256: string;
}
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
/** createPublicKey also accepts private PEMs; never let that permissive API
 * turn a misconfigured signing-key path into public build arguments. */
export function canonicalPublicKey(publicKey: string): string {
  if (typeof publicKey !== "string" || Buffer.byteLength(publicKey) > 8192 || publicKey.includes("PRIVATE")) throw new Error("Expected one public Ed25519 SPKI PEM.");
  const text = publicKey.trim();
  if (!/^-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END PUBLIC KEY-----$/.test(text)) throw new Error("Expected one public Ed25519 SPKI PEM.");
  const key = createPublicKey(text);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Coordinator trust anchor must be Ed25519.");
  return key.export({ type: "spki", format: "pem" }).toString();
}
export function loadPublicKey(path: string): string {
  return canonicalPublicKey(ordinaryBytes(path, 8192).toString("utf8"));
}
export function publicKeyFingerprint(publicKey: string): string {
  const key = createPublicKey(canonicalPublicKey(publicKey));
  return sha256(key.export({ type: "spki", format: "der" }));
}
export function parseCoordinatorComponent(value: unknown): CoordinatorComponent {
  const keys = ["format", "coordinatorVersion", "node", "platform", "releaseTag", "name", "bytes", "sha256", "signature", "inputFingerprint", "publicKeySha256"];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid coordinator component descriptor.");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join("|") !== keys.sort().join("|") || item.format !== "gridlens-coordinator-component-v1"
    || item.coordinatorVersion !== COORDINATOR_VERSION || item.node !== "24.14.1" || !["linux-x64", "linux-arm64"].includes(String(item.platform))
    || typeof item.releaseTag !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.releaseTag)
    || item.name !== `gridlens-coordinator-${item.platform}` || item.signature !== `${item.name}.sig`
    || !Number.isSafeInteger(item.bytes) || Number(item.bytes) < 1 || Number(item.bytes) > 256 * 1024 ** 2
    || !hex(item.sha256) || !hex(item.inputFingerprint) || !hex(item.publicKeySha256)) throw new Error("Invalid coordinator component descriptor.");
  return item as unknown as CoordinatorComponent;
}
export function verifyCoordinatorComponent(bytes: Uint8Array, signature: Uint8Array, publicKey: string): CoordinatorComponent {
  publicKey = canonicalPublicKey(publicKey);
  if (bytes.byteLength < 1 || bytes.byteLength > 16_384 || signature.byteLength !== 64 || !verify(null, bytes, createPublicKey(publicKey), signature)) throw new Error("Coordinator component signature verification failed.");
  const component = parseCoordinatorComponent(JSON.parse(Buffer.from(bytes).toString("utf8")));
  if (component.publicKeySha256 !== publicKeyFingerprint(publicKey)) throw new Error("Coordinator component uses a different trust anchor.");
  return component;
}
function ordinaryBytes(path: string, maximum: number): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximum) throw new Error("Invalid coordinator component file.");
  return readFileSync(path);
}
/** Reuse is local and explicit. The publisher separately verifies this immutable
 * location publicly before making a launcher that depends on it available. */
export function loadCoordinatorComponent(directory: string, publicKey: string, expected: { inputFingerprint: string; platform: string }) {
  const descriptorBytes = ordinaryBytes(join(directory, COMPONENT_DESCRIPTOR), 16_384);
  const descriptorSignature = ordinaryBytes(join(directory, COMPONENT_SIGNATURE), 64);
  const component = verifyCoordinatorComponent(descriptorBytes, descriptorSignature, publicKey);
  if (component.inputFingerprint !== expected.inputFingerprint || component.platform !== expected.platform) throw new Error("Coordinator component inputs or platform changed; build a new component.");
  const binary = ordinaryBytes(join(directory, component.name), 256 * 1024 ** 2), signature = ordinaryBytes(join(directory, component.signature), 64);
  if (binary.length !== component.bytes || sha256(binary) !== component.sha256 || signature.length !== 64
    || !verify(null, binary, createPublicKey(publicKey), signature)) throw new Error("Coordinator executable failed its signed checksum or signature check.");
  return { component, descriptorBytes, descriptorSignature };
}
function treeHashes(root: string, name: string): { name: string; sha256: string }[] {
  const path = join(root, name), stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error("Coordinator inputs cannot contain symbolic links.");
  if (stat.isDirectory()) return readdirSync(path).sort().flatMap(child => treeHashes(root, `${name}/${child}`));
  if (!stat.isFile() || stat.size > 256 * 1024 ** 2) throw new Error("Invalid coordinator build input.");
  return [{ name, sha256: sha256(readFileSync(path)) }];
}
/** Full input closure, independent of checkout/output paths and runtime release
 * tag. The generated JS is available for building exactly the fingerprinted code. */
export async function coordinatorInputs(project: string, publicKey: string, nodeExecutable = process.execPath) {
  publicKey = canonicalPublicKey(publicKey);
  const root = resolve(project);
  const result = await build({ absWorkingDir: root, entryPoints: ["src/installer/terminal-entry.ts"], bundle: true, platform: "node", target: "node24",
    format: "cjs", outfile: "coordinator.cjs", write: false, metafile: true,
    define: { GRIDLENS_RELEASE_PUBLIC_KEY: JSON.stringify(publicKey) }, logLevel: "silent" });
  const javascript = result.outputFiles[0]?.contents;
  if (!javascript || result.outputFiles.length !== 1) throw new Error("Unexpected coordinator bundle outputs.");
  // Fingerprint the producer's complete local import closure too. A helper
  // change must invalidate reuse even when the terminal source is unchanged.
  const producer = await build({ absWorkingDir: root, entryPoints: ["scripts/build-coordinator.ts"], bundle: true, platform: "node", target: "node24",
    format: "esm", outfile: "producer.mjs", write: false, metafile: true, external: ["esbuild", "postject"], logLevel: "silent" });
  const names = new Set([...Object.keys(result.metafile.inputs), ...Object.keys(producer.metafile.inputs), "package.json", "package-lock.json",
    "scripts/release-coordinator.ts"]);
  const inputs = [...names].sort().map(name => {
    const normalized = relative(root, resolve(root, name));
    if (!normalized || normalized.startsWith("../") || normalized.startsWith("/")) throw new Error("Coordinator input is outside the source checkout.");
    return { name: normalized, sha256: sha256(ordinaryBytes(join(root, normalized), 32 * 1024 ** 2)) };
  });
  const tooling = ["node_modules/esbuild", "node_modules/postject", `node_modules/@esbuild/${process.platform}-${process.arch}`]
    .flatMap(name => treeHashes(root, name));
  const node = ordinaryBytes(nodeExecutable, 256 * 1024 ** 2);
  const nodeLicense = ordinaryBytes(join(dirname(dirname(nodeExecutable)), "LICENSE"), 2 * 1024 ** 2);
  const identity = { format: "gridlens-coordinator-inputs-v1", coordinatorVersion: COORDINATOR_VERSION, node: process.versions.node,
    platform: `${process.platform}-${process.arch}`, nodeSha256: sha256(node), nodeLicenseSha256: sha256(nodeLicense),
    publicKeySha256: publicKeyFingerprint(publicKey), bundleSha256: sha256(javascript), inputs, tooling,
    sea: { disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, execArgvExtension: "none" },
    injection: { resource: "NODE_SEA_BLOB", sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2", overwrite: false } };
  return { fingerprint: sha256(Buffer.from(JSON.stringify(identity))), javascript: Buffer.from(javascript), identity };
}
export function renderCoordinatorLauncher(template: string, runtimeTag: string, component: CoordinatorComponent): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runtimeTag)) throw new Error("Invalid runtime release tag.");
  const text = template.replaceAll("@RELEASE_TAG@", runtimeTag).replaceAll("@COORDINATOR_RELEASE_TAG@", component.releaseTag)
    .replaceAll("@COORDINATOR_NAME@", component.name).replaceAll("@COORDINATOR_SHA256@", component.sha256);
  if (/@(?:RELEASE_TAG|COORDINATOR_[A-Z_]+)@/.test(text)) throw new Error("Unresolved coordinator launcher input.");
  return text;
}
