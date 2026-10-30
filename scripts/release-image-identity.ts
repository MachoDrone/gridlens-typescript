import { createHash } from "node:crypto";
import { InstallerError } from "../src/installer/release.ts";
import type { ModernRelease } from "../src/installer/release.ts";

const digest = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const hashId = (value: unknown): value is string => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function fail(): never { throw new InstallerError("The release archive must contain one verified single-platform OCI image and matching Docker image metadata."); }
const manifestTypes = new Set(["application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"]);
const configTypes = new Set(["application/vnd.oci.image.config.v1+json", "application/vnd.docker.container.image.v1+json"]);

/** Read metadata in place; never extract paths or execute anything from an archive. */
export function archiveImageIdentity(input: Uint8Array, expected: { imageId: string; version: string; platform: ModernRelease["platform"]; imageTag: string }): { imageId: string; configImageId: string } {
  if (!hashId(expected.imageId) || input.byteLength < 1024 || input.byteLength > 1024 ** 3) fail();
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength), entries = new Map<string, Buffer>();
  const text = (header: Buffer, start: number, count: number): string => header.subarray(start, start + count).toString("ascii").replace(/\0.*$/s, "").trim();
  const octal = (header: Buffer, start: number, count: number): number => {
    const value = text(header, start, count); if (!/^[0-7]+$/.test(value)) fail();
    const number = Number.parseInt(value, 8); if (!Number.isSafeInteger(number) || number < 0) fail(); return number;
  };
  let offset = 0, terminated = false;
  while (offset + 512 <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + 512); offset += 512;
    if (header.every(byte => byte === 0)) {
      if (offset + 512 > bytes.byteLength || !bytes.subarray(offset).every(byte => byte === 0)) fail();
      terminated = true; break;
    }
    const checksum = octal(header, 148, 8);
    const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (sum !== checksum) fail();
    const prefix = text(header, 345, 155), name = `${prefix ? prefix + "/" : ""}${text(header, 0, 100)}`;
    const size = octal(header, 124, 12), padded = Math.ceil(size / 512) * 512;
    if (!name || name.length > 256 || name.startsWith("/") || name.includes("\\") || name.split("/").some(part => part === "..")
      || offset + padded > bytes.byteLength) fail();
    const type = header[156];
    if (type === 0 || type === 48) {
      if (entries.has(name) || entries.size >= 4096) fail();
      entries.set(name, bytes.subarray(offset, offset + size));
    } else if (type !== 53) fail(); // No links, devices or extended-header ambiguity.
    offset += padded;
  }
  if (!terminated) fail();
  const json = (name: string, maximum = 64 * 1024): Record<string, unknown> => {
    const body = entries.get(name); if (!body || body.length > maximum) fail();
    try { const value: unknown = JSON.parse(body.toString("utf8")); if (!object(value)) fail(); return value; } catch { return fail(); }
  };
  const descriptor = (value: unknown): { digest: string; size: number; mediaType: string } => {
    if (!object(value) || !hashId(value.digest) || !Number.isSafeInteger(value.size) || Number(value.size) < 1
      || Number(value.size) > 1024 ** 3 || typeof value.mediaType !== "string") fail();
    return { digest: value.digest, size: Number(value.size), mediaType: value.mediaType };
  };
  const blob = (desc: { digest: string; size: number }, maximum: number): Buffer => {
    const body = entries.get(`blobs/sha256/${desc.digest.slice(7)}`);
    if (!body || desc.size > maximum || body.length !== desc.size || digest(body) !== desc.digest) fail(); return body;
  };
  const layout = json("oci-layout"), index = json("index.json");
  if (layout.imageLayoutVersion !== "1.0.0" || index.schemaVersion !== 2 || !Array.isArray(index.manifests) || index.manifests.length !== 1) fail();
  const root = descriptor(index.manifests[0]);
  if (root.digest !== expected.imageId || !manifestTypes.has(root.mediaType)) fail();
  blob(root, 64 * 1024);
  const manifest = json(`blobs/sha256/${root.digest.slice(7)}`);
  if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.layers) || manifest.layers.length > 256) fail();
  const config = descriptor(manifest.config);
  if (!configTypes.has(config.mediaType)) fail();
  blob(config, 1024 * 1024);
  const settings = json(`blobs/sha256/${config.digest.slice(7)}`, 1024 * 1024);
  if (settings.os !== "linux" || settings.architecture !== (expected.platform === "linux-x64" ? "amd64" : "arm64")
    || !object(settings.config) || !object(settings.config.Labels) || settings.config.Labels["io.gridlens.product"] !== "shared-backend"
    || settings.config.Labels["io.gridlens.version"] !== expected.version) fail();
  const layers = manifest.layers.map(descriptor);
  for (const layer of layers) blob(layer, 1024 ** 3);
  const dockerBytes = entries.get("manifest.json"); if (!dockerBytes || dockerBytes.length > 64 * 1024) fail();
  let docker: unknown; try { docker = JSON.parse(dockerBytes.toString("utf8")); } catch { fail(); }
  if (!Array.isArray(docker) || docker.length !== 1 || !object(docker[0])) fail();
  const saved = docker[0];
  if (saved.Config !== `blobs/sha256/${config.digest.slice(7)}` || !Array.isArray(saved.RepoTags) || saved.RepoTags.length > 32
    || !saved.RepoTags.includes(expected.imageTag) || JSON.stringify(saved.Layers) !== JSON.stringify(layers.map(layer => `blobs/sha256/${layer.digest.slice(7)}`))) fail();
  return { imageId: root.digest, configImageId: config.digest };
}
