import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface UpdateStateStore {
  read(): unknown;
  write(value: unknown): void;
  close(): void;
}
/** The kernel releases this lock on process exit. A crashed PID/lease cannot
 * authorize a second writer, and FULL SQLite commits precede runtime changes. */
export function openUpdateState(directory: string): UpdateStateStore {
  if (!directory || directory === "/") throw new Error("An owned update-state directory is required.");
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!lstatSync(root).isDirectory() || realpathSync(root) !== root) throw new Error("Update state requires an ordinary canonical directory.");
  chmodSync(root, 0o700);
  const lockPath = join(root, "owner.sqlite"), statePath = join(root, "updates.sqlite");
  for (const path of [lockPath, statePath]) {
    try { if (!lstatSync(path).isFile()) throw new Error("Update state requires ordinary files."); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  }
  const lock = new DatabaseSync(lockPath); let db: DatabaseSync | undefined;
  try {
    chmodSync(lockPath, 0o600);
    lock.exec("PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY); BEGIN IMMEDIATE;");
    db = new DatabaseSync(statePath); chmodSync(statePath, 0o600);
    const connection = db;
    const version = connection.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 0 && version !== 1) throw new Error("Unsupported updater state; keep the saved operation for compatible recovery.");
    connection.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS journal(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL); PRAGMA user_version=1;");
    let closed = false, poisoned = false;
    const available = () => { if (closed || poisoned) throw new Error("Update state is closed or requires recovery."); };
    return {
      read() {
        available(); const row = connection.prepare("SELECT value FROM journal WHERE id=1").get();
        if (!row) return undefined;
        if (typeof row.value !== "string" || Buffer.byteLength(row.value) > 128 * 1024) throw new Error("Invalid update journal.");
        return JSON.parse(row.value) as unknown;
      },
      write(value) {
        available(); const encoded = JSON.stringify(value);
        if (encoded === undefined || Buffer.byteLength(encoded) > 128 * 1024) throw new Error("Update journal exceeds its size bound.");
        try { connection.prepare("INSERT INTO journal(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(encoded); }
        catch (error) { poisoned = true; throw error; }
      },
      close() { if (closed) return; closed = true; try { connection.close(); } finally { lock.close(); } },
    };
  } catch (error) { db?.close(); lock.close(); throw error; }
}
