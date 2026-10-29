import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { createMemorySnapshotStore } from "../server/snapshot-store.ts";
import type { FleetSnapshotStore } from "../server/snapshot-store.ts";

const LIMIT = 64 * 1024 * 1024;
export interface SharedState {
  snapshots: FleetSnapshotStore;
  /** Private owner-only namespaces. Never expose this interface through HTTP. */
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  /** Atomic owner-ledger updates, e.g. one host's history and its fleet summary.
   * The separately backed-up snapshot database cannot participate. */
  batch(entries: readonly (readonly [string, unknown])[]): void;
  /** Consistent matched-image checkpoint; normal code rollback retains the live DB. */
  checkpoint(path: string): Promise<void>;
  close(): Promise<void>;
}

/** One owner, released by the OS after a crash. The separate SQLite lock database
 * holds an IMMEDIATE transaction for the owner's lifetime. No stale PID guessing.
 * All data, access decisions and reservations commit with synchronous=FULL before
 * their callers can act. An ambiguous failure poisons the owner until reopened. */
export function openSharedState(directory: string, { now = Date.now, ledgerDirectory }: { now?: () => number; ledgerDirectory?: string } = {}): SharedState {
  if (!directory || directory === "/") throw new Error("An explicit private shared-state directory is required.");
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!lstatSync(root).isDirectory() || realpathSync(root) !== root) throw new Error("Shared state requires an ordinary canonical directory.");
  chmodSync(root, 0o700);
  const ledgerRoot = resolve(ledgerDirectory ?? root);
  mkdirSync(ledgerRoot, { recursive: true, mode: 0o700 });
  if (!lstatSync(ledgerRoot).isDirectory() || realpathSync(ledgerRoot) !== ledgerRoot) throw new Error("The safety ledger requires an ordinary canonical directory.");
  chmodSync(ledgerRoot, 0o700);
  for (const path of [join(ledgerRoot, "owner.sqlite"), join(ledgerRoot, "ledger.sqlite"), join(root, "state.sqlite")]) {
    try { if (!lstatSync(path).isFile()) throw new Error("Shared state must use ordinary files."); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  }
  const lock = new DatabaseSync(join(ledgerRoot, "owner.sqlite"));
  let db: DatabaseSync | undefined;
  let cacheDb: DatabaseSync | undefined;
  try {
    chmodSync(join(ledgerRoot, "owner.sqlite"), 0o600);
    lock.exec("PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY); BEGIN IMMEDIATE;");
    db = new DatabaseSync(join(ledgerRoot, "ledger.sqlite"));
    cacheDb = new DatabaseSync(join(root, "state.sqlite"));
    chmodSync(join(ledgerRoot, "ledger.sqlite"), 0o600);
    chmodSync(join(root, "state.sqlite"), 0o600);
    for (const database of [db, cacheDb]) {
      database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
      const version = database.prepare("PRAGMA user_version").get()?.user_version;
      if (version !== 0 && version !== 1) throw new Error("Unsupported shared-state version; retain the existing database and matching image.");
      database.exec("CREATE TABLE IF NOT EXISTS private_state (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version=1;");
    }
    const connection = db;
    const observations = cacheDb;
    let closed = false, poisoned = false;
    let memorySnapshots: FleetSnapshotStore | undefined;
    const poison = (): void => {
      poisoned = true;
      // Existing subscriptions must stop as well as new ledger/snapshot reads.
      void memorySnapshots?.close().catch(() => {});
    };
    const available = (): void => { if (closed || poisoned) throw new Error("Shared state is closed or needs recovery after a persistence failure."); };
    const keyCheck = (key: string): void => {
      // Scope IDs use the existing Fleet contract, including spaces/Unicode.
      // Keys are bound SQL parameters, never filesystem paths or SQL fragments.
      if (typeof key !== "string" || !key.length || key.length > 1024 || /[\u0000-\u001f\u007f]/.test(key)) throw new Error("Invalid shared-state namespace.");
    };
    const get = <T>(key: string): T | undefined => {
      available(); keyCheck(key);
      const row = (key === "snapshots" ? observations : connection).prepare("SELECT value FROM private_state WHERE key = ?").get(key);
      if (!row) return undefined;
      if (typeof row.value !== "string" || Buffer.byteLength(row.value) > LIMIT) throw new Error("Invalid shared-state value.");
      return JSON.parse(row.value) as T;
    };
    const set = (key: string, value: unknown): void => {
      available(); keyCheck(key);
      const json = JSON.stringify(value);
      if (json === undefined || Buffer.byteLength(json) > LIMIT) throw new Error("Shared-state value exceeds its bound.");
      try { (key === "snapshots" ? observations : connection).prepare("INSERT INTO private_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, json); }
      catch (error) { poison(); throw error; }
    };
    const batch = (entries: readonly (readonly [string, unknown])[]): void => {
      available();
      if (!Array.isArray(entries)) throw new Error("Invalid shared-state transaction.");
      const keys = new Set<string>();
      // Validate and serialize everything before opening the transaction. Invalid
      // caller data must never partially write, or unnecessarily poison, state.
      const prepared = entries.map(entry => {
        if (!Array.isArray(entry) || entry.length !== 2) throw new Error("Invalid shared-state transaction entry.");
        const [key, value] = entry; keyCheck(key);
        if (key === "snapshots" || keys.has(key)) throw new Error("A ledger transaction requires unique non-snapshot keys.");
        keys.add(key);
        const json = JSON.stringify(value);
        if (json === undefined || Buffer.byteLength(json) > LIMIT) throw new Error("Shared-state value exceeds its bound.");
        return [key, json] as const;
      });
      if (!prepared.length) return;
      try {
        connection.exec("BEGIN IMMEDIATE");
        const put = connection.prepare("INSERT INTO private_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
        for (const [key, json] of prepared) put.run(key, json);
        connection.exec("COMMIT");
      } catch (error) {
        // COMMIT/I/O errors can be ambiguous. Try rollback, then require reopen
        // regardless of its outcome; never publish a partly believed revision.
        try { if (connection.isTransaction) connection.exec("ROLLBACK"); } catch { /* Original persistence failure remains primary. */ }
        poison(); throw error;
      }
    };
    const store = createMemorySnapshotStore({ now, initial: get("snapshots") ?? [], persist: async values => set("snapshots", values) });
    memorySnapshots = store;
    const snapshots: FleetSnapshotStore = {
      async read(context) { available(); const value = await store.read(context); available(); return value; },
      async commit(context, updates, revision) { available(); const value = await store.commit(context, updates, revision); available(); return value; },
      subscribe(context, signal, onUpdate) {
        try { available(); } catch (error) { return Promise.reject(error); }
        return store.subscribe(context, signal, (value, changed) => { available(); onUpdate(value, changed); });
      },
      close: () => store.close(),
    };
    let stopping: Promise<void> | undefined;
    return { snapshots, get, set, batch,
      async checkpoint(path) {
        available();
        if (resolve(path) === join(root, "state.sqlite")) throw new Error("A checkpoint must be a different file.");
        await backup(observations, path); chmodSync(path, 0o600);
      },
      close() {
        return stopping ??= snapshots.close().finally(() => {
          closed = true;
          try { observations.close(); connection.close(); } finally { lock.close(); }
        });
      },
    };
  } catch (error) { cacheDb?.close(); db?.close(); lock.close(); throw error; }
}
