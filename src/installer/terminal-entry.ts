import { runTerminal } from "./terminal.ts";
import { InstallerError } from "./release.ts";
void runTerminal().catch(error=>{console.error(error instanceof InstallerError?error.message:"GridLens setup failed; saved state was retained. Rerun the same command to recover.");process.exitCode=1;});
