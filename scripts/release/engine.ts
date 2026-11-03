import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { atomicJson, readJson } from "./files.ts";
import { canonical, STAGES } from "./model.ts";
import type { ReleaseJournal, Stage } from "./model.ts";

export interface ReleaseContext {
  directory: string;
  journal: ReleaseJournal;
  save(): void;
  assertActive(): void;
  event(kind: string, detail: string): void;
  mutate<T>(key: string, kind: string, identity: unknown, observe: () => Promise<T | undefined>, apply: () => Promise<void>): Promise<T>;
}
export interface ReleaseEffects {
  validate(context: ReleaseContext): Promise<void>;
  stages: Record<Stage, (context: ReleaseContext, previous?: unknown) => Promise<unknown>>;
  cleanup(context: ReleaseContext): Promise<unknown>;
}
export class ReleaseSuperseded extends Error {}
export class ReleaseAborted extends Error {}
function checkAbort(directory: string, journal: ReleaseJournal): void {
  const path = join(directory, "abort-request.json");
  if (!existsSync(path)) return;
  const request = readJson(path) as { runId: string; planHash: string };
  if (request.runId !== journal.runId || request.planHash !== journal.plan.planHash) throw new Error("Abort request belongs to another release run.");
  throw new ReleaseAborted("Release abort requested; in-flight outcomes are retained and no new mutation is dispatched.");
}
export function releaseContext(directory: string, journal: ReleaseJournal, progress: (value: unknown) => void = () => {}): ReleaseContext {
  const save = (): void => { journal.updatedAt = new Date().toISOString(); atomicJson(join(directory, "journal.json"), journal); };
  const event = (kind: string, detail: string): void => {
    journal.events.push({ at: new Date().toISOString(), kind, detail }); save();
    progress({ runId: journal.runId, kind, detail, at: journal.updatedAt });
  };
  return {
    directory, journal, save, event, assertActive: () => checkAbort(directory, journal),
    async mutate<T>(key: string, kind: string, operationIdentity: unknown, observe: () => Promise<T | undefined>, apply: () => Promise<void>): Promise<T> {
      let record = journal.mutations.find(item => item.key === key);
      if (record && (record.kind !== kind || canonical(record.identity) !== canonical(operationIdentity))) throw new Error("Release mutation identity changed.");
      const observed = await observe();
      if (observed !== undefined) {
        record ??= { key, kind, identity: operationIdentity, status: "intent", intentAt: new Date().toISOString() };
        if (!journal.mutations.includes(record)) journal.mutations.push(record);
        record.status = "observed"; record.observedAt = new Date().toISOString(); record.result = observed; save();
        return observed;
      }
      if (record?.status === "observed") throw new Error("Previously verified remote mutation is no longer present; refusing to recreate it.");
      if (!record) { record = { key, kind, identity: operationIdentity, status: "intent", intentAt: new Date().toISOString() }; journal.mutations.push(record); }
      checkAbort(directory, journal);
      save(); // Durable intent precedes every potentially mutating request.
      await apply(); // Never automatically retry a failed request; resume observes first.
      const result = await observe();
      if (result === undefined) throw new Error("Release mutation outcome is not confirmed; resume will inspect it before any retry.");
      record.status = "observed"; record.observedAt = new Date().toISOString(); record.result = result; save();
      return result;
    }
  };
}
export async function runRelease(context: ReleaseContext, effects: ReleaseEffects, mode: "prepare" | "publish" | "resume"): Promise<void> {
  const journal = context.journal;
  if (journal.status === "aborted" && mode === "resume") throw new Error("This run was aborted. Explicit publish or prepare is required to restart its authorized scope.");
  if (mode === "publish") {
    journal.publicationAuthorized = true;
    context.event("authorized", "Development source, immutable prerelease, isolated acceptance and channel publication authorized by command. Live installation excluded.");
  }
  if (mode !== "resume") rmSync(join(context.directory, "abort-request.json"), { force: true });
  const publishing = mode !== "prepare" && journal.publicationAuthorized;
  journal.status = publishing ? "publishing" : "preparing"; context.save();
  const stages = publishing ? STAGES : STAGES.slice(0, 4);
  try { await effects.validate(context); }
  catch (error) { journal.status = "blocked"; context.event("validation-failed", error instanceof Error ? error.message : "Release validation failed."); throw error; }
  for (const stage of stages) {
    const previous = journal.stages[stage], start = performance.now();
    const previousEvidence = previous?.status === "complete" ? previous.evidence : undefined;
    journal.stages[stage] = { status: "running", attempt: (previous?.attempt ?? 0) + 1, startedAt: new Date().toISOString(),
      ...(previousEvidence === undefined ? {} : { evidence: previousEvidence }) };
    context.event("stage-start", stage);
    try {
      checkAbort(context.directory, journal);
      const evidence = await effects.stages[stage](context, previousEvidence);
      const record = journal.stages[stage]!;
      record.status = "complete"; record.evidence = evidence; record.completedAt = new Date().toISOString(); record.elapsedMs = Math.round(performance.now() - start);
      context.event("stage-complete", JSON.stringify({ stage, attempt: record.attempt, elapsedMs: record.elapsedMs }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Release stage failed.";
      const record = journal.stages[stage]!;
      record.status = "failed"; record.error = message; record.elapsedMs = Math.round(performance.now() - start);
      journal.failure ??= { stage, message, at: new Date().toISOString() };
      journal.status = error instanceof ReleaseSuperseded ? "superseded" : error instanceof ReleaseAborted ? "aborted" : "blocked";
      context.event("stage-failed", `${stage}: ${message}`);
      if (error instanceof ReleaseAborted) { try { await cleanupRelease(context, effects); } catch { /* Preserve the abort and separate cleanup failure. */ } }
      throw error;
    }
  }
  journal.status = publishing ? "complete" : "prepared";
  context.event("complete", publishing ? "Development publication and isolated acceptance verified." : "Local release candidate verified; publication has not started.");
}
export async function abortRelease(context: ReleaseContext, effects: ReleaseEffects): Promise<void> {
  context.journal.status = "aborted";
  context.event("aborted", "No new publication actions will be dispatched. Published releases and branch/channel history are retained.");
  await cleanupRelease(context, effects);
}
export async function cleanupRelease(context: ReleaseContext, effects: ReleaseEffects): Promise<void> {
  try { const result = await effects.cleanup(context); context.event("cleanup", JSON.stringify(result)); delete context.journal.cleanupFailure; context.save(); }
  catch (error) { context.journal.cleanupFailure = error instanceof Error ? error.message : "Owned fixture cleanup failed."; context.save(); throw error; }
}
