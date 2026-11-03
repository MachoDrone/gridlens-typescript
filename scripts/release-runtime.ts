import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { archiveImageIdentity } from "./release-image-identity.ts";

export const MAX_RUNTIME_BYTES = 1024 ** 3;
export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export type ArchiveExpectation = Parameters<typeof archiveImageIdentity>[1];
/** The legacy .tar wire name stays compatible with existing Docker loaders.
 * Hashes and sizes describe the actual gzip bytes, never the expanded archive. */
export function compressRuntimeArchive(raw: Uint8Array, expected: ArchiveExpectation, maximum = MAX_RUNTIME_BYTES) {
  if (!Number.isSafeInteger(maximum) || maximum < 1024 || maximum > MAX_RUNTIME_BYTES || raw.byteLength > maximum) throw new Error("Runtime archive exceeds its expanded limit.");
  const identity = archiveImageIdentity(raw, expected, maximum);
  const bytes = gzipSync(raw, { level: 1 });
  const verified = verifyRuntimeArchive(bytes, expected, maximum);
  if (verified.expandedBytes !== raw.byteLength || verified.expandedSha256 !== sha256(raw)) throw new Error("Runtime compression changed the verified image archive.");
  return { bytes, ...identity, compression: "gzip" as const, expandedBytes: raw.byteLength, expandedSha256: sha256(raw) };
}
export function verifyRuntimeArchive(bytes: Uint8Array, expected: ArchiveExpectation, maximum = MAX_RUNTIME_BYTES) {
  if (!Number.isSafeInteger(maximum) || maximum < 1024 || maximum > MAX_RUNTIME_BYTES || bytes.byteLength < 1 || bytes.byteLength > maximum) throw new Error("Runtime archive exceeds its signed transport limit.");
  const gzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  let raw: Uint8Array;
  try { raw = gzip ? gunzipSync(bytes, { maxOutputLength: maximum }) : bytes; }
  catch { throw new Error("Runtime archive decompression failed or exceeded its expanded limit."); }
  if (raw.byteLength > maximum) throw new Error("Runtime archive exceeds its expanded limit.");
  return { ...archiveImageIdentity(raw, expected, maximum), compression: gzip ? "gzip" as const : "none" as const,
    expandedBytes: raw.byteLength, expandedSha256: sha256(raw) };
}
