import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = fileURLToPath(new URL("../", import.meta.url));

export function buildPreview(): void {
  const outputDirectory = resolve(projectDirectory, "dist");
  rmSync(outputDirectory, { recursive: true, force: true });
  const result = spawnSync(process.execPath, [
    resolve(projectDirectory, "node_modules/typescript/bin/tsc"),
    "-p",
    "tsconfig.browser.json",
  ], { cwd: projectDirectory, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Browser compilation failed (${result.signal ?? result.status}).`);
  }
  mkdirSync(outputDirectory, { recursive: true });
  for (const filename of ["index.html", "styles.css"]) {
    copyFileSync(resolve(projectDirectory, "src/preview", filename), resolve(outputDirectory, filename));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    buildPreview();
    console.log("Built the isolated Fleet preview in dist/.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
