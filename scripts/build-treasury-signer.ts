import { buildSync } from "esbuild";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = fileURLToPath(new URL("../", import.meta.url));
/** Ship dependencies with the restricted helper; nothing is installed in Nosana containers. */
export function buildTreasurySigner(output = resolve(projectDirectory, "dist/backend/treasury-signer.cjs")): void {
  buildSync({ entryPoints: [resolve(projectDirectory, "src/backend/treasury-signer-entry.ts")], outfile: output,
    bundle: true, platform: "node", target: "node18", format: "cjs", minify: true, legalComments: "inline", logLevel: "silent" });
}
