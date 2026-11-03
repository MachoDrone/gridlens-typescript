import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planVerification, runVerification } from "./verification.ts";

export async function verifyCli(args: string[]): Promise<void> {
  let base: string | undefined, stateDir: string | undefined, full = false, planOnly = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--base" && !base && args[index + 1] && !args[index + 1]!.startsWith("--")) base = args[++index];
    else if (arg === "--state-dir" && !stateDir && args[index + 1] && !args[index + 1]!.startsWith("--")) stateDir = args[++index];
    else if (arg === "--full" && !full) full = true;
    else if (arg === "--plan-only" && !planOnly) planOnly = true;
    else throw new Error("Usage: npm run verify -- --base <commit-sha> [--full] [--plan-only] [--state-dir <external-directory>]");
  }
  if (!base || stateDir === "") throw new Error("An immutable --base commit SHA is required.");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const plan = await planVerification({ root, base, full, ...(stateDir ? { stateDir } : {}) });
  if (planOnly) { console.log(JSON.stringify(plan, null, 2)); return; }
  const receipt = await runVerification(plan);
  console.log(JSON.stringify(receipt, null, 2));
  if (receipt.status !== "checks-passed") process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyCli(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : "Verification failed."); process.exitCode = 1; });
}
