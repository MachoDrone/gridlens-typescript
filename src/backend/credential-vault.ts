import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { constants, chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SshCredential } from "./ssh.ts";

export interface CredentialVault {
  save(scopeId: string, pcId: string, credential: SshCredential): void;
  read(scopeId: string, pcId: string): SshCredential | undefined;
  forget(scopeId: string, pcId: string): void;
  close(): void;
}
function validate(value: unknown): SshCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid remembered credential.");
  const row = value as SshCredential;
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(row.username) || !row.password && !row.privateKey
    || Object.keys(row).some(key => !["username", "password", "privateKey", "passphrase", "sudoPassword"].includes(key))) throw new Error("Invalid remembered credential.");
  for (const field of ["password", "privateKey", "passphrase", "sudoPassword"] as const) if (row[field] !== undefined
    && (typeof row[field] !== "string" || row[field].length > (field === "privateKey" ? 65536 : 4096))) throw new Error("Invalid remembered credential.");
  return { ...row };
}
/** Owner-only encrypted SSH storage; the gateway mounts neither this volume nor its key.
 * Keeping a key and encrypted records in one protected volume protects accidental
 * plaintext copies, not an attacker controlling the owner or its volume. */
export function openCredentialVault(directory: string): CredentialVault {
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!lstatSync(root).isDirectory() || realpathSync(root) !== root) throw new Error("Credentials require an ordinary private directory.");
  chmodSync(root, 0o700);
  const keyPath = join(root, "vault-key");
  try { const fd = openSync(keyPath, "wx", 0o600); try { writeFileSync(fd, randomBytes(32)); fsyncSync(fd); } finally { closeSync(fd); } }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
  const stat = lstatSync(keyPath);
  if (!stat.isFile() || stat.mode & 0o077 || stat.size !== 32) throw new Error("The credential key is missing or not protected.");
  const fd = openSync(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const key = readFileSync(fd); closeSync(fd);
  let closed = false;
  const binding = (scopeId: string, pcId: string): string => {
    if (closed) throw new Error("Credential vault is closed.");
    if (!scopeId || scopeId.length > 256 || !/^[a-f0-9]{64}$/.test(pcId)) throw new Error("Invalid credential binding.");
    return createHash("sha256").update(JSON.stringify([scopeId, pcId])).digest("hex");
  };
  const syncDirectory = (): void => { const fd = openSync(root, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } };
  return {
    save(scopeId, pcId, credential) {
      const name = binding(scopeId, pcId), plaintext = Buffer.from(JSON.stringify(validate(credential)));
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(name));
      try {
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const temporary = join(root, `${name}.${randomBytes(8).toString("hex")}.tmp`);
        const fd = openSync(temporary, "wx", 0o600);
        try { writeFileSync(fd, Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext])); fsyncSync(fd); }
        finally { closeSync(fd); }
        renameSync(temporary, join(root, name)); syncDirectory();
      } finally { plaintext.fill(0); }
    },
    read(scopeId, pcId) {
      const name = binding(scopeId, pcId), path = join(root, name);
      let data: Buffer;
      try {
        const info = lstatSync(path); if (!info.isFile() || info.mode & 0o077 || info.size > 80 * 1024) throw new Error("Credential record is not protected.");
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { data = readFileSync(fd); } finally { closeSync(fd); }
      } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
      if (data[0] !== 1 || data.length < 30) throw new Error("Invalid credential record.");
      const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(1, 13));
      decipher.setAAD(Buffer.from(name)); decipher.setAuthTag(data.subarray(13, 29));
      const plaintext = Buffer.concat([decipher.update(data.subarray(29)), decipher.final()]);
      try { return validate(JSON.parse(plaintext.toString("utf8"))); } finally { plaintext.fill(0); }
    },
    forget(scopeId, pcId) { const name = binding(scopeId, pcId); try { unlinkSync(join(root, name)); syncDirectory(); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    } },
    close() { closed = true; key.fill(0); },
  };
}
