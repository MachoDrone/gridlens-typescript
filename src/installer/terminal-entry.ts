import { runTerminal } from "./terminal.ts";
import { InstallerError } from "./release.ts";
import { cliFailure } from "./cli-format.ts";
void runTerminal().catch(error=>{console.error(cliFailure(error instanceof InstallerError?error.message:"GridLens installation failed; saved state was retained. Rerun the same command to recover."));process.exitCode=1;});
