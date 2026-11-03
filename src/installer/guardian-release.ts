import { createHash, createPublicKey, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { releaseURL, verifyArtifact, verifyRelease } from "./release.ts";
import type { ModernRelease } from "./release.ts";
import { downloadUpdate, pruneUpdateDownloads } from "../updater/release.ts";
import { verifyRuntimeArchive } from "../../scripts/release-runtime.ts";

export interface GuardianReleaseIdentity {
  release: ModernRelease;
  manifest: Uint8Array;
  signature: Uint8Array;
  trustPublicKey: string;
}
export interface GuardianRelease extends GuardianReleaseIdentity { archivePath: string }
export interface GuardianReleaseOptions {
  cacheDirectory: string;
  trustPublicKey: string;
  build: { version: string; sequence: number };
  platform?: "linux-x64" | "linux-arm64";
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}
const hash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const pending = new Map<string, Promise<GuardianRelease>>();
const pendingMetadata = new Map<string, Promise<GuardianReleaseIdentity>>();
function publicKey(text: string): string {
  if (text.length > 8192 || text.includes("PRIVATE") || !/^-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END PUBLIC KEY-----$/.test(text.trim())) throw new Error("Guardian release requires the installed public trust anchor.");
  const key = createPublicKey(text); if (key.asymmetricKeyType !== "ed25519") throw new Error("Guardian release trust anchor must be Ed25519.");
  return key.export({ type: "spki", format: "pem" }).toString();
}
async function metadata(url: URL, maximum: number, fetcher: typeof fetch, signal: AbortSignal): Promise<Buffer> {
  let target = url;
  for (let redirect = 0; redirect < 6; redirect++) {
    if (target.protocol !== "https:" || target.username || target.password || target.port
      || !["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"].includes(target.hostname)) throw new Error("Guardian release redirected outside its fixed trusted service.");
    const response = await fetcher(target, { signal, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get("location"); await response.body?.cancel();
      if (!next) throw new Error("Guardian release metadata redirect is incomplete."); target = new URL(next, target); continue;
    }
    if (!response.ok || !response.body) throw new Error("The installed version's published guardian release is unavailable.");
    const parts: Uint8Array[] = []; let bytes = 0;
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > maximum) throw new Error("Guardian release metadata exceeded its bound."); parts.push(chunk); }
    return Buffer.concat(parts);
  }
  throw new Error("Guardian release metadata exceeded its redirect bound.");
}
function ordinary(path: string, maximum: number): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximum) throw new Error("Guardian release cache contains an invalid file.");
  return readFileSync(path);
}
/** A caller cannot select a repository, arbitrary URL, executable or private key.
 * These options are injected by the owner from its own installed build/anchor. */
function metadataContext(options: GuardianReleaseOptions) {
  const { version, sequence } = options.build, platform = options.platform ?? `linux-${process.arch}`;
  if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(version) || version.length > 80 || !Number.isSafeInteger(sequence) || sequence < 1
    || !["linux-x64", "linux-arm64"].includes(platform)) throw new Error("Invalid installed guardian build identity.");
  const trustPublicKey = publicKey(options.trustPublicKey), root = resolve(options.cacheDirectory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory() || lstatSync(root).mode & 0o077) throw new Error("Guardian release cache must be an owned private directory.");
  const key = hash(JSON.stringify({ root, version, sequence, platform, trustPublicKey }));
  return { root, version, sequence, platform, trustPublicKey, key };
}
/** Metadata-only identity resolution for source checks and receipt polling. */
export async function fetchGuardianReleaseMetadata(options: GuardianReleaseOptions): Promise<GuardianReleaseIdentity> {
  const { root, version, sequence, platform, trustPublicKey, key } = metadataContext(options);
  const existing = pendingMetadata.get(key); if (existing) return existing;
  const work = async (): Promise<GuardianReleaseIdentity> => {
    const stored = join(root, `${key}.json`), fetcher = options.fetcher ?? fetch;
    const signal = AbortSignal.any([AbortSignal.timeout(16 * 60_000), ...(options.signal ? [options.signal] : [])]);
    let manifest: Buffer, signature: Buffer;
    if (existsSync(stored)) {
      const value = JSON.parse(ordinary(stored, 32768).toString("utf8")) as { manifest: string; signature: string };
      if (typeof value.manifest !== "string" || typeof value.signature !== "string" || Object.keys(value).sort().join("|") !== "manifest|signature") throw new Error("Guardian release metadata cache is invalid.");
      manifest = Buffer.from(value.manifest, "base64"); signature = Buffer.from(value.signature, "base64");
      if (manifest.toString("base64") !== value.manifest || signature.toString("base64") !== value.signature) throw new Error("Guardian release metadata encoding is invalid.");
    } else {
      const base = `https://github.com/MachoDrone/gridlens-typescript/releases/download/modern-v${version}/`;
      manifest = await metadata(releaseURL(base, "modern-release.json"), 16384, fetcher, signal);
      signature = await metadata(releaseURL(base, "modern-release.sig"), 64, fetcher, signal);
    }
    const release = verifyRelease(manifest, signature, trustPublicKey);
    if (release.version !== version || release.sequence !== sequence || release.platform !== platform || release.minimumCoordinator < 2) throw new Error("Guardian release differs from the owner's installed build.");
    if (!existsSync(stored)) {
      const temporary = `${stored}.${randomBytes(8).toString("hex")}.pending`, file = openSync(temporary, "wx", 0o600);
      try { writeFileSync(file, JSON.stringify({ manifest: manifest.toString("base64"), signature: signature.toString("base64") })); fsyncSync(file); } finally { closeSync(file); }
      try { renameSync(temporary, stored); const parent = openSync(root, "r"); try { fsyncSync(parent); } finally { closeSync(parent); } }
      finally { if (existsSync(temporary)) unlinkSync(temporary); }
    }
    return { release, manifest, signature, trustPublicKey };
  };
  const promise = work(); pendingMetadata.set(key, promise);
  try { return await promise; } finally { pendingMetadata.delete(key); }
}
export async function fetchGuardianRelease(options: GuardianReleaseOptions): Promise<GuardianRelease> {
  const { root, key } = metadataContext(options), existing = pending.get(key); if (existing) return existing;
  const work = async (): Promise<GuardianRelease> => {
    const identity = await fetchGuardianReleaseMetadata(options), { release } = identity, id = hash(identity.manifest);
    const archivePath = await downloadUpdate({ id, release, releaseTag: `modern-v${release.version}`, version: release.version, sequence: release.sequence,
      buildId: `${release.sequence}:${release.version}`, sizeBytes: release.runtime.bytes, workerProtocol: 1 }, root,
      { ...(options.signal ? { signal: options.signal } : {}), ...(options.fetcher ? { fetch: options.fetcher } : {}) });
    const result = { ...identity, archivePath }; verifyGuardianArchive(result);
    await pruneUpdateDownloads(root, [id]); return result;
  };
  const promise = work(); pending.set(key, promise);
  try { return await promise; } finally { pending.delete(key); }
}
export function verifyGuardianReleaseIdentity(input: GuardianReleaseIdentity): ModernRelease {
  const release = verifyRelease(input.manifest, input.signature, publicKey(input.trustPublicKey));
  if (JSON.stringify(release) !== JSON.stringify(input.release)) throw new Error("Guardian release metadata changed before delivery.");
  return release;
}
/** Rechecks cache bytes immediately before SSH delivery, including every OCI blob
 * and both signed root/config identities. It never returns a wallet key. */
export function verifyGuardianArchive(input: GuardianRelease): Buffer {
  const release = verifyGuardianReleaseIdentity(input);
  const bytes = ordinary(input.archivePath, 1024 ** 3); verifyArtifact(bytes, release.runtime);
  const proof = verifyRuntimeArchive(bytes, { imageId: release.imageId, version: release.version, platform: release.platform, imageTag: `gridlens-modern-build:${release.version}-${release.sequence}` });
  if (proof.configImageId !== release.configImageId) throw new Error("Guardian runtime archive does not match the signed config identity.");
  return bytes;
}
