import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { GUARDIAN_MAX_BODY_BYTES, GUARDIAN_MAX_ENVELOPE_BYTES, boundedGuardianJson } from "./guardian-limits.ts";

export interface OwnerAuthorityDescriptor { version: 1; authorityId: string; publicKeyDer: string }
export interface OwnerSignedRequest { version: 1; authorityId: string; body: unknown; signature: string }
export interface OwnerAuthority { readonly descriptor: OwnerAuthorityDescriptor; sign(body: unknown): OwnerSignedRequest; close(): void }
export class OwnerAuthorityError extends Error {
  readonly kind: "not-initialized" | "recovery-required";
  constructor(kind: "not-initialized" | "recovery-required") { super(`Owner authority ${kind}.`); this.kind = kind; }
}
export function canonicalAuthorityJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalAuthorityJson).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalAuthorityJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new Error("Invalid owner authorization payload.");
}
export const authorityDigest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
export function parseOwnerAuthority(value: unknown): OwnerAuthorityDescriptor {
  const row = value as Partial<OwnerAuthorityDescriptor> | null;
  if (!row || Object.keys(row).sort().join(",") !== "authorityId,publicKeyDer,version" || row.version !== 1
    || typeof row.authorityId !== "string" || !/^[a-f0-9]{64}$/.test(row.authorityId) || typeof row.publicKeyDer !== "string") throw new Error("Invalid owner authority.");
  const bytes = Buffer.from(row.publicKeyDer, "base64");
  if (bytes.length !== 44 || bytes.toString("base64") !== row.publicKeyDer || authorityDigest(bytes) !== row.authorityId
    || createPublicKey({ key: bytes, format: "der", type: "spki" }).asymmetricKeyType !== "ed25519") throw new Error("Invalid owner authority.");
  return { version: 1, authorityId: row.authorityId, publicKeyDer: row.publicKeyDer };
}
function signedBytes(body: unknown): Buffer {
  const text = canonicalAuthorityJson(body);
  if (Buffer.byteLength(text) > GUARDIAN_MAX_BODY_BYTES) throw new Error("Owner request exceeds its bound.");
  return Buffer.from(`gridlens-source-finance-v1\n${text}`);
}
export function verifyOwnerRequest(value: unknown, descriptor: OwnerAuthorityDescriptor): unknown {
  boundedGuardianJson(value, GUARDIAN_MAX_ENVELOPE_BYTES);
  const row = value as Partial<OwnerSignedRequest> | null, pin = parseOwnerAuthority({ version: descriptor.version, authorityId: descriptor.authorityId, publicKeyDer: descriptor.publicKeyDer });
  if (!row || Object.keys(row).sort().join(",") !== "authorityId,body,signature,version" || row.version !== 1
    || row.authorityId !== pin.authorityId || typeof row.signature !== "string") throw new Error("Owner authorization rejected.");
  const signature = Buffer.from(row.signature, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== row.signature || !verify(null, signedBytes(row.body),
    createPublicKey({ key: Buffer.from(pin.publicKeyDer, "base64"), format: "der", type: "spki" }), signature)) throw new Error("Owner authorization rejected.");
  return structuredClone(row.body);
}
function privateFile(path: string, maximum: number): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.nlink !== 1 || stat.size < 1 || stat.size > maximum || realpathSync(path) !== path)
    throw new OwnerAuthorityError("recovery-required");
  return readFileSync(path);
}
/** A new organizational signing identity, never a Nosana key. Creation is an
 * explicit owner-authorized provisioning action, not a startup/reset fallback. */
export function openOwnerAuthority(directory: string, options: { create: boolean; historyPresent?: boolean; allowHistoryMigration?: boolean; expectedAuthorityId?: string } = { create: false }): OwnerAuthority {
  const root = resolve(directory), keyPath = join(root, "owner-authority-v1.pem"), marker = join(root, "owner-authority-v1.marker");
  if (options.create) mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!existsSync(root)) throw new OwnerAuthorityError("not-initialized");
  const folder = lstatSync(root);
  if (!folder.isDirectory() || folder.isSymbolicLink() || folder.mode & 0o077 || realpathSync(root) !== root) throw new OwnerAuthorityError("recovery-required");
  const keyExists = existsSync(keyPath), markerExists = existsSync(marker);
  if (keyExists !== markerExists) throw new OwnerAuthorityError("recovery-required");
  if (!keyExists) {
    if (options.expectedAuthorityId) throw new OwnerAuthorityError("recovery-required");
    if (!options.create) throw new OwnerAuthorityError("not-initialized");
    if (options.historyPresent && options.allowHistoryMigration !== true) throw new OwnerAuthorityError("recovery-required");
    const pair = generateKeyPairSync("ed25519"), publicBytes = pair.publicKey.export({ format: "der", type: "spki" });
    const descriptor: OwnerAuthorityDescriptor = { version: 1, authorityId: authorityDigest(publicBytes), publicKeyDer: publicBytes.toString("base64") };
    const secret = Buffer.from(pair.privateKey.export({ format: "pem", type: "pkcs8" }));
    try {
      const fd = openSync(keyPath, "wx", 0o600); try { writeFileSync(fd, secret); fsyncSync(fd); } finally { closeSync(fd); }
      const witness = openSync(marker, "wx", 0o600); try { writeFileSync(witness, JSON.stringify(descriptor)); fsyncSync(witness); } finally { closeSync(witness); }
      const parent = openSync(root, "r"); try { fsyncSync(parent); } finally { closeSync(parent); }
    } finally { secret.fill(0); }
  }
  let privateKey: KeyObject | undefined;
  let descriptor: OwnerAuthorityDescriptor;
  try {
    descriptor = parseOwnerAuthority(JSON.parse(privateFile(marker, 2048).toString("utf8")));
    if (options.expectedAuthorityId !== undefined && descriptor.authorityId !== options.expectedAuthorityId) throw new Error();
    const bytes = privateFile(keyPath, 4096); try { privateKey = createPrivateKey(bytes); } finally { bytes.fill(0); }
    if (privateKey.asymmetricKeyType !== "ed25519" || createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64") !== descriptor.publicKeyDer)
      throw new Error();
  } catch { throw new OwnerAuthorityError("recovery-required"); }
  return { descriptor: Object.freeze(descriptor), sign(body) {
    if (!privateKey) throw new OwnerAuthorityError("recovery-required");
    const envelope: OwnerSignedRequest = { version: 1, authorityId: descriptor.authorityId, body: structuredClone(body), signature: sign(null, signedBytes(body), privateKey).toString("base64") };
    boundedGuardianJson(envelope, GUARDIAN_MAX_ENVELOPE_BYTES); return envelope;
  }, close() { privateKey = undefined; } };
}
