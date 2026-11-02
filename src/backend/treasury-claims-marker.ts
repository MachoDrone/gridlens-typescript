import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function claimsMarkerPresent(directory: string): boolean {
  try { lstatSync(join(resolve(directory), "treasury-claims-v1.marker")); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false; throw error; }
}

/** Separate, nonsecret initialization witness in the retained credential volume.
 * Deleting either journal or marker cannot silently enable another claim. */
export function initializeClaimsMarker(directory: string, serverId: string, keyId: string, ledgerPresent: boolean): boolean {
  if (typeof serverId !== "string" || !serverId.length || serverId.length > 256 || /[\u0000-\u001f\u007f]/.test(serverId)
    || !/^[a-f0-9]{64}$/.test(keyId)) throw new Error("Invalid retained claims identity.");
  const root = resolve(directory), folder = lstatSync(root);
  if (!folder.isDirectory() || realpathSync(root) !== root || folder.mode & 0o077) throw new Error("Claims require the private credential directory.");
  const path = join(root, "treasury-claims-v1.marker");
  let exists = true;
  try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error; exists = false; }
  if (!exists) {
    if (ledgerPresent) throw new Error("The retained claim initialization marker is missing.");
    const fd = openSync(path, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify({ version: 1, serverId, keyId })); fsyncSync(fd); } finally { closeSync(fd); }
    const parent = openSync(root, "r"); try { fsyncSync(parent); } finally { closeSync(parent); }
    return true;
  }
  const info = lstatSync(path);
  if (!info.isFile() || info.size > 1024 || info.mode & 0o077 || !ledgerPresent) throw new Error("The retained claims state needs recovery.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let value: unknown; try { value = JSON.parse(readFileSync(fd, "utf8")); } finally { closeSync(fd); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 3
    || (value as { version?: unknown }).version !== 1 || (value as { serverId?: unknown }).serverId !== serverId
    || (value as { keyId?: unknown }).keyId !== keyId) throw new Error("The retained claims identity changed.");
  return false;
}
