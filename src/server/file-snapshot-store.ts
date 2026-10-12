import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { createMemorySnapshotStore } from "./snapshot-store.ts";
import type { FleetSnapshotStore } from "./snapshot-store.ts";

const maximumSnapshotBytes = 64 * 1024 * 1024;

/** Local development persistence only: one owner holds an exclusive lifetime
 * lock. This is not a shared-replica database or a production lease mechanism.
 * A crash deliberately leaves its lock for explicit operator investigation.
 * Any failed persistence step closes reads/writes, including an ambiguous
 * directory-flush failure after rename. Close and reopen to validate whichever
 * revision reached disk; never retry with the previous in-memory version. */
export async function createFileSnapshotStore(directory: string, { now = Date.now }: { now?: () => number } = {}): Promise<FleetSnapshotStore> {
  if (typeof directory !== "string" || !directory.trim()) throw new Error("An explicit snapshot directory is required.");
  const root = resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!(await lstat(root)).isDirectory()) throw new Error("Snapshot directory must be an ordinary directory.");
  const lockPath = join(root, "writer.lock");
  const dataPath = join(root, "snapshots.json");
  let lock: FileHandle;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch { throw new Error("Snapshot directory has an existing writer lock; a second writer is not supported."); }
  let released = false;
  async function release(): Promise<void> {
    if (released) return;
    released = true;
    await lock.close();
    await unlink(lockPath);
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, owner: randomUUID() }) + "\n");
    await lock.sync();
    let initial: unknown = [];
    try {
      const file = await open(dataPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > maximumSnapshotBytes) throw new Error("Snapshot storage must be an ordinary file within 64 MiB.");
        const raw = await file.readFile("utf8");
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || !("schemaVersion" in parsed) || parsed.schemaVersion !== 1 || !("fleets" in parsed)) {
          throw new Error("Invalid snapshot file format.");
        }
        initial = parsed.fleets;
      } finally { await file.close(); }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw new Error("Stored Fleet snapshots failed validation.", { cause: error });
    }
    const store = createMemorySnapshotStore({ initial, now, persist: async snapshots => {
      const body = JSON.stringify({ schemaVersion: 1, fleets: snapshots }) + "\n";
      if (Buffer.byteLength(body) > maximumSnapshotBytes) throw new Error("Local snapshot storage exceeds its 64 MiB limit.");
      const temporary = join(root, `snapshots.${randomUUID()}.tmp`);
      let renamed = false;
      try {
        const output = await open(temporary, "wx", 0o600);
        try { await output.writeFile(body); await output.sync(); }
        finally { await output.close(); }
        await rename(temporary, dataPath);
        renamed = true;
        // Flush the directory entry as well as file contents before publication.
        const folder = await open(root, constants.O_RDONLY);
        try { await folder.sync(); } finally { await folder.close(); }
      } finally {
        if (!renamed) await unlink(temporary).catch(() => {});
      }
    } });
    let closing: Promise<void> | undefined;
    return { read: context => store.read(context), commit: (context, updates, revision) => store.commit(context, updates, revision),
      subscribe: (context, signal, onUpdate) => store.subscribe(context, signal, onUpdate),
      close() { return closing ??= store.close().then(release); } };
  } catch (error) {
    await release();
    throw error;
  }
}
