import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface TreasuryVault {
  readonly keyId: string;
  readonly created: boolean;
  seal(value: unknown, purpose: string): string;
  open<T>(sealed: string, purpose: string): T;
  close(): void;
}
/** Dedicated encryption key; this is not a source wallet key. Its owner-only
 * directory already belongs to the credential volume. Never recreate a missing
 * key for an installation with an existing treasury ledger. */
export function openTreasuryVault(directory: string, { create = false }: { create?: boolean } = {}): TreasuryVault {
  const root = resolve(directory), info = lstatSync(root);
  if (!info.isDirectory() || realpathSync(root) !== root || info.mode & 0o077) throw new Error("Wallet encryption requires its existing private credential directory.");
  const path = join(root, "treasury-key-v1");
  let created = false;
  if (create) {
    try {
      const fd = openSync(path, "wx", 0o600), generated = randomBytes(32);
      try { writeFileSync(fd, generated); fsyncSync(fd); } finally { generated.fill(0); closeSync(fd); }
      const parent = openSync(root, "r"); try { fsyncSync(parent); } finally { closeSync(parent); }
      created = true;
    } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.mode & 0o077 || stat.size !== 32) throw new Error("Wallet encryption key is missing or invalid. Terminal recovery is required.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let key: Buffer; try { key = readFileSync(fd); } finally { closeSync(fd); }
  if (key.length !== 32) { key.fill(0); throw new Error("Wallet encryption key changed."); }
  const keyId = createHash("sha256").update(key).digest("hex"); let closed = false;
  const aad = (purpose: string) => {
    if (closed || typeof purpose !== "string" || !purpose.length || purpose.length > 1024 || /[\u0000-\u001f\u007f]/.test(purpose)) throw new Error("Wallet encryption context is unavailable.");
    return Buffer.from(`gridlens-treasury-v1:${purpose}`);
  };
  return { keyId, created,
    seal(value, purpose) {
      const context = aad(purpose), serialized = JSON.stringify(value);
      if (serialized === undefined || Buffer.byteLength(serialized) > 64 * 1024) throw new Error("Wallet encrypted record exceeds its bound.");
      const plaintext = Buffer.from(serialized), iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(context);
      try {
        const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]).toString("base64");
      }
      finally { plaintext.fill(0); }
    },
    open<T>(sealed: string, purpose: string): T {
      const context = aad(purpose);
      if (typeof sealed !== "string" || sealed.length > 90_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(sealed)) throw new Error("Invalid encrypted Wallet record.");
      const bytes = Buffer.from(sealed, "base64");
      if (bytes.toString("base64") !== sealed || bytes.length < 30 || bytes[0] !== 1) throw new Error("Invalid encrypted Wallet record.");
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(1, 13));
      decipher.setAAD(context); decipher.setAuthTag(bytes.subarray(13, 29));
      const plaintext = Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]);
      try { return JSON.parse(plaintext.toString("utf8")) as T; } finally { plaintext.fill(0); }
    },
    close() { closed = true; key.fill(0); },
  };
}
