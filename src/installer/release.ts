import { createHash, createPublicKey, verify } from "node:crypto";

export const RELEASE_FORMAT = "gridlens-modern-release-v1";
export interface ReleaseArtifact { name: string; bytes: number; sha256: string }
export interface ModernRelease {
  format: typeof RELEASE_FORMAT;
  version: string;
  sequence: number;
  platform: "linux-x64" | "linux-arm64";
  minimumCoordinator: number;
  imageId: string;
  runtime: ReleaseArtifact;
}
export class InstallerError extends Error {}
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export function parseRelease(value: unknown): ModernRelease {
  if (!object(value) || value.format !== RELEASE_FORMAT || typeof value.version !== "string"
    || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(value.version) || value.version.length > 80
    || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1
    || !["linux-x64", "linux-arm64"].includes(String(value.platform)) || value.minimumCoordinator !== 1
    || typeof value.imageId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.imageId)
    || !object(value.runtime) || typeof value.runtime.name !== "string" || !/^gridlens-runtime-[a-z0-9.-]+\.tar$/.test(value.runtime.name)
    || !Number.isSafeInteger(value.runtime.bytes) || Number(value.runtime.bytes) < 1 || Number(value.runtime.bytes) > 1024 * 1024 * 1024
    || typeof value.runtime.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.runtime.sha256)) {
    throw new InstallerError("The signed release manifest is unsupported or invalid.");
  }
  return { format: RELEASE_FORMAT, version: value.version, sequence: Number(value.sequence), platform: value.platform as ModernRelease["platform"],
    minimumCoordinator: 1, imageId: value.imageId, runtime: { name: value.runtime.name, bytes: Number(value.runtime.bytes), sha256: value.runtime.sha256 } };
}
export function verifyRelease(bytes: Uint8Array, signature: Uint8Array, publicKey: string): ModernRelease {
  if (bytes.byteLength > 16_384 || signature.byteLength !== 64) throw new InstallerError("Release signature verification failed.");
  try {
    const key = createPublicKey(publicKey);
    if (key.asymmetricKeyType !== "ed25519" || !verify(null, bytes, key, signature)) throw new Error();
    return parseRelease(JSON.parse(Buffer.from(bytes).toString("utf8")));
  } catch (error) {
    if (error instanceof InstallerError) throw error;
    throw new InstallerError("Release signature verification failed.");
  }
}
export function verifyArtifact(bytes: Uint8Array, artifact: ReleaseArtifact): void {
  if (bytes.byteLength !== artifact.bytes || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
    throw new InstallerError("The downloaded release artifact failed its size or checksum check.");
  }
}
export function releaseURL(base: string, name: string): URL {
  const url = new URL(base);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.search || url.hash
    || !/^\/MachoDrone\/gridlens-typescript\/releases\/download\/[a-zA-Z0-9._-]+\/$/.test(url.pathname)
    || !/^[a-zA-Z0-9._-]+$/.test(name)) throw new InstallerError("Use a pinned modern GridLens GitHub release URL.");
  return new URL(name, url);
}
