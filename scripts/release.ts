/** Maintainer release coordinator. This entry point never installs a live app. */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { abortRelease, cleanupRelease, releaseContext, runRelease } from "./release/engine.ts";
import { productionEffects } from "./release/effects.ts";
import { atomicJson, createJournal, loadJournal, lockRun, privateDirectory, readJson } from "./release/files.ts";
import { parsePlan } from "./release/model.ts";
import { createPlan } from "./release/source.ts";

export interface ReleaseArguments { command: "plan" | "prepare" | "publish" | "resume" | "status" | "abort" | "cleanup"; values: Map<string, string>; acceptances: string[] }
export function releaseArguments(args: readonly string[]): ReleaseArguments {
  const [command, ...rest] = args;
  if (!["plan", "prepare", "publish", "resume", "status", "abort", "cleanup"].includes(command ?? "")) throw new Error("Use release plan, prepare, publish, resume, status, abort or cleanup.");
  const values = new Map<string, string>(), acceptances: string[] = [];
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]!, value = rest[index + 1];
    if (!value || !["--config", "--output", "--plan", "--run", "--acceptance"].includes(key)) throw new Error("Invalid release command option.");
    if (key === "--acceptance") { acceptances.push(resolve(value)); continue; }
    if (values.has(key)) throw new Error("Supply each release option once."); values.set(key, resolve(value));
  }
  if (command === "plan") {
    if (!values.has("--config") || [...values.keys()].some(key => !["--config", "--output"].includes(key)) || acceptances.length) throw new Error("Use plan --config FILE [--output FILE].");
  } else if (!values.has("--run") || [...values.keys()].some(key => !["--run", "--plan"].includes(key))
    || values.has("--plan") && !["prepare", "publish"].includes(command!)) throw new Error("Use --run DIRECTORY and optional --plan FILE when starting prepare or publish.");
  return { command: command as ReleaseArguments["command"], values, acceptances };
}
export async function releaseMain(args: readonly string[]): Promise<void> {
  process.umask(0o077);
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    console.log("GridLens development release coordinator\nplan --config FILE [--output FILE]\nprepare --plan FILE --run DIRECTORY\npublish [--plan FILE] --run DIRECTORY [--acceptance RECEIPT]\nresume|status|abort|cleanup --run DIRECTORY\n\nPublish executes the approved development release workflow. Live installation is separate.\nPrivate evidence remains outside the source checkout; resume retains the recorded authorization."); return;
  }
  const options = releaseArguments(args), get = (key: string): string => options.values.get(key)!;
  if (options.command === "plan") {
    const plan = await createPlan(readJson(get("--config")));
    if (options.values.has("--output")) {
      privateDirectory(dirname(get("--output")), plan.config.sourceDirectory);
      if (existsSync(get("--output"))) throw new Error("Plan output already exists; preserve its identity."); atomicJson(get("--output"), plan);
    }
    console.log(JSON.stringify(plan, null, 2)); return;
  }
  const directory = get("--run");
  if (options.command === "status") { console.log(JSON.stringify(loadJournal(directory), null, 2)); return; }
  if (options.values.has("--plan")) privateDirectory(directory, parsePlan(readJson(get("--plan"))).config.sourceDirectory);
  else privateDirectory(directory);
  if (options.command === "abort") {
    const journal = loadJournal(directory);
    atomicJson(resolve(directory, "abort-request.json"), { runId: journal.runId, planHash: journal.plan.planHash, requestedAt: new Date().toISOString() });
  }
  let release: () => void;
  try { release = lockRun(directory); }
  catch (error) {
    if (options.command === "abort" && error instanceof Error && error.message === "Another release writer owns this run.") {
      console.log(JSON.stringify({ status: "abort-requested", note: "The active writer will retain its in-flight result and stop before the next mutation or stage." })); return;
    }
    throw error;
  }
  try {
    const journal = existsSync(resolve(directory, "journal.json")) ? loadJournal(directory)
      : options.values.has("--plan") ? createJournal(directory, parsePlan(readJson(get("--plan")))) : undefined;
    if (!journal) throw new Error("No release run exists. Supply --plan when starting prepare or publish.");
    if (options.values.has("--plan") && parsePlan(readJson(get("--plan"))).planHash !== journal.plan.planHash) throw new Error("This run belongs to a different immutable plan.");
    const context = releaseContext(directory, journal, event => console.log(JSON.stringify(event))), effects = productionEffects(directory, options.acceptances);
    if (options.command === "abort") await abortRelease(context, effects);
    else if (options.command === "cleanup") await cleanupRelease(context, effects);
    else await runRelease(context, effects, options.command);
    console.log(JSON.stringify({ runId: journal.runId, status: journal.status, planHash: journal.plan.planHash, candidateHash: journal.candidate?.candidateHash }));
  } finally { release(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await releaseMain(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : "Release coordinator failed. Inspect the private journal."); process.exitCode = 1; }
}
