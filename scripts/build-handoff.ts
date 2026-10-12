import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = resolve(fileURLToPath(new URL("../", import.meta.url)));
const artifactFormat = "gridlens-nosana-handoff-v1";
const manifestName = "manifest.json";
type JsonObject = Record<string, unknown>;

function json(path: string): JsonObject {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid package metadata.");
  return value as JsonObject;
}
function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

/** Hosted serving has only Node dependencies; public preview adapters stay local. */
function productionLock(source: JsonObject, package_: JsonObject): JsonObject {
  if (source.lockfileVersion !== 3 || typeof source.packages !== "object" || source.packages === null) {
    throw new Error("The handoff requires the repository's version-three package lock.");
  }
  const root: JsonObject = { name: package_.name, version: package_.version, license: package_.license,
    dependencies: package_.dependencies, engines: package_.engines };
  return { name: package_.name, version: package_.version, lockfileVersion: 3, requires: true, packages: { "": root } };
}

function compile(config: string, output: string): void {
  const result = spawnSync(process.execPath, [join(projectDirectory, "node_modules/typescript/bin/tsc"),
    "-p", config, "--outDir", output], { cwd: projectDirectory, stdio: "pipe", encoding: "utf8", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Handoff compilation failed (${config}):\n${result.stdout}${result.stderr}`);
}

function files(directory: string, prefix = ""): string[] {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error("Handoff output must not contain symbolic links.");
    if (entry.isDirectory()) return files(directory, path);
    if (!entry.isFile()) throw new Error("Handoff output must contain only ordinary files.");
    return [path];
  }).sort();
}

function validateOutput(directory: string): void {
  const fromOutput = relative(directory, projectDirectory);
  if (directory === projectDirectory || fromOutput !== "" && !fromOutput.startsWith(`..${sep}`) &&
      fromOutput !== ".." && !isAbsolute(fromOutput)) {
    throw new Error("Handoff output must not replace the repository or one of its parents.");
  }
  if (!existsSync(directory)) return;
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) {
    throw new Error("Handoff output must be a generated artifact directory.");
  }
  if (!existsSync(join(directory, manifestName)) || json(join(directory, manifestName)).format !== artifactFormat) {
    throw new Error("Refusing to replace a directory without a GridLens handoff manifest.");
  }
}

/** An explicit build emits public application code only; it never loads a roster. */
export function buildHandoff({ outputDirectory = join(projectDirectory, ".tools/handoff") }: {
  outputDirectory?: string;
} = {}): string {
  const output = resolve(outputDirectory);
  validateOutput(output);
  const sourcePackage = json(join(projectDirectory, "package.json"));
  const engines = sourcePackage.engines as Record<string, string>;
  if (process.versions.node !== engines.node) throw new Error(`Use the pinned Node ${engines.node} to build the handoff.`);
  const typescript = json(join(projectDirectory, "node_modules/typescript/package.json"));
  if (typescript.version !== (sourcePackage.devDependencies as JsonObject).typescript) {
    throw new Error("The installed TypeScript compiler does not match the pinned toolchain.");
  }
  mkdirSync(dirname(output), { recursive: true });
  const staging = mkdtempSync(join(dirname(output), ".gridlens-handoff-build-"));
  try {
    compile("tsconfig.runtime.json", staging);
    compile("tsconfig.browser.json", join(staging, "dist"));
    for (const name of ["index.html", "styles.css"]) {
      copyFileSync(join(projectDirectory, "src/preview", name), join(staging, "dist", name));
    }
    const package_: JsonObject = { name: sourcePackage.name, version: sourcePackage.version,
      private: true, description: "GridLens hosted runtime handoff", license: sourcePackage.license,
      type: "module", engines, packageManager: sourcePackage.packageManager,
      scripts: { start: "node scripts/hosted-server.js" }, dependencies: {},
      exports: Object.fromEntries([
        ["application", "src/server/application"], ["contracts", "src/contracts/fleet"],
        ["snapshot-source", "src/server/snapshot-source"], ["snapshot-store", "src/server/snapshot-store"],
        ["file-snapshot-store", "src/server/file-snapshot-store"],
      ].map(([name, path]) => [`./${name}`, { types: `./${path}.d.ts`, import: `./${path}.js` }])) };
    writeJson(join(staging, "package.json"), package_);
    writeJson(join(staging, "package-lock.json"), productionLock(json(join(projectDirectory, "package-lock.json")), package_));
    copyFileSync(join(projectDirectory, "LICENSE"), join(staging, "LICENSE"));
    copyFileSync(join(projectDirectory, "docs/HOSTING_HANDOFF.md"), join(staging, "INTEGRATION.md"));
    writeJson(join(staging, "runtime-config.example.json"), {
      GRIDLENS_HOST: "127.0.0.1", GRIDLENS_PORT: "4173", GRIDLENS_PUBLIC_ORIGIN: "http://127.0.0.1:4173",
      GRIDLENS_BASE_PATH: "",
      GRIDLENS_INTEGRATION_MODULE: "/absolute/path/to/trusted-nosana-integration.mjs",
    });
    const entries = files(staging).map(path => {
      if (/\.(?:ts|tsx|map)$/.test(path) && !path.endsWith(".d.ts") ||
          /(?:^|\/)(?:test|fixtures|\.tools|node_modules)(?:\/|$)/.test(path)) {
        throw new Error(`Unexpected non-runtime file in handoff: ${path}`);
      }
      const bytes = readFileSync(join(staging, path));
      if (path.endsWith(".js") && !path.startsWith("dist/")) {
        const source = bytes.toString("utf8");
        const imports = [...source.matchAll(/\b(?:import|export)\s+(?:[^;"']+?\s+from\s*)?["']([^"']+)["']/g),
          ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)];
        if (imports.some(match => !match[1]!.startsWith(".") && !match[1]!.startsWith("node:"))) {
          throw new Error(`Hosted runtime unexpectedly requires a third-party dependency: ${path}`);
        }
      }
      return { path, bytes: bytes.byteLength, sha256: digest(bytes) };
    });
    if (!entries.some(entry => entry.path === "scripts/hosted-server.js")) throw new Error("Hosted runtime entry point was not emitted.");
    writeJson(join(staging, manifestName), { format: artifactFormat, name: package_.name, version: package_.version,
      toolchain: { node: engines.node, npm: engines.npm, typescript: typescript.version },
      install: "npm ci --omit=dev --ignore-scripts", start: "npm start", files: entries });
    // Compilation and validation finish before replacing an earlier owned artifact.
    if (existsSync(output)) rmSync(output, { recursive: true });
    renameSync(staging, output);
    return output;
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 0 && (args.length !== 2 || args[0] !== "--output" || !args[1])) {
      throw new Error("Usage: npm run build:handoff [-- --output DIRECTORY]");
    }
    console.log(`Built GridLens handoff: ${buildHandoff(args[1] ? { outputDirectory: args[1] } : {})}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Handoff build failed.");
    process.exitCode = 1;
  }
}
