import { chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { parsePlan } from "./model.ts";
import type { ReleaseJournal, ReleasePlan } from "./model.ts";

export function ordinaryFile(path: string, maximum = 4 * 1024 ** 2): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximum) throw new Error("Expected a bounded ordinary release file.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return readFileSync(fd); } finally { closeSync(fd); }
}
export const readJson = (path: string): unknown => JSON.parse(ordinaryFile(path).toString("utf8"));
export function privateDirectory(directory: string, source?: string): string {
  const path = resolve(directory);
  if (source) {
    const part = relative(resolve(source), path);
    if (!part || (!part.startsWith("../") && part !== ".." && !part.startsWith("/"))) throw new Error("Release evidence must be outside the checkout.");
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  for (let item = path; item !== dirname(item); item = dirname(item)) if (lstatSync(item).isSymbolicLink()) throw new Error("Release directories cannot use symbolic links.");
  const stat = lstatSync(path);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new Error("Release state directory must be private (0700).");
  return path;
}
export function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`, bytes = JSON.stringify(value, null, 2) + "\n";
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    renameSync(temporary, path);
    const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { rmSync(temporary, { force: true }); }
}
/** The kernel releases SQLite's exclusive writer lock after a crash. No PID
 * guessing or deletion of another publisher's lock is needed on resume. */
export function lockRun(directory: string): () => void {
  const path = join(directory, "writer.sqlite");
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error("Invalid release writer lock file.");
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  try { db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;"); }
  catch { db.close(); throw new Error("Another release writer owns this run."); }
  return () => { try { db.exec("ROLLBACK"); } finally { db.close(); } };
}
export function createJournal(directory: string, plan: ReleasePlan): ReleaseJournal {
  privateDirectory(directory, plan.config.sourceDirectory);
  if (existsSync(join(directory, "journal.json"))) throw new Error("Release run already exists; use resume.");
  const at = new Date().toISOString();
  const journal: ReleaseJournal = { format: "gridlens-release-journal-v1", runId: randomUUID(), plan: parsePlan(plan), status: "preparing", publicationAuthorized: false,
    createdAt: at, updatedAt: at, stages: {}, mutations: [], events: [{ at, kind: "created", detail: "Prepared release run; publication is separate." }] };
  atomicJson(join(directory, "journal.json"), journal);
  return journal;
}
export function loadJournal(directory: string): ReleaseJournal {
  const value = readJson(join(directory, "journal.json")) as ReleaseJournal;
  if (value?.format !== "gridlens-release-journal-v1" || !Array.isArray(value.mutations) || !Array.isArray(value.events)
    || typeof value.runId !== "string" || !value.stages || typeof value.publicationAuthorized !== "boolean") throw new Error("Invalid release journal.");
  value.plan = parsePlan(value.plan);
  return value;
}
