import { buildSync } from "esbuild";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export interface DependencyStage { id: string; files: string[] }
export interface VerificationInputs {
  files: string[]; directories: string[]; assetPaths: string[]; webAssets: boolean; fallbackReasons: string[];
}
interface ResourceRule { files?: string[]; directories?: string[]; compilers?: string[]; assets?: string[]; webAssets?: boolean; literalResources?: boolean }
class UnownedDependencyError extends Error {}
/** Inputs that are selected by a compiler, filesystem walk or HTTP asset map,
 * rather than a normal TS import. Paths are relative to the source checkout. */
const RESOURCES: Record<string, ResourceRule> = {
  "playwright.config.ts": { files: ["test/fixtures/start-browser-preview.ts"], literalResources: false },
  "scripts/build.ts": { directories: ["src/preview"], compilers: ["tsconfig.browser.json"], files: ["src/backend/treasury-signer-entry.ts"], literalResources: false },
  "scripts/build-treasury-signer.ts": { files: ["src/backend/treasury-signer-entry.ts"], literalResources: false },
  "scripts/build-handoff.ts": { directories: ["src/preview"], compilers: ["tsconfig.browser.json", "tsconfig.runtime.json"], files: ["scripts/hosted-server.ts", "docs/HOSTING_HANDOFF.md", "LICENSE"], literalResources: false },
  "scripts/build-coordinator.ts": { files: ["src/installer/terminal-entry.ts", "scripts/modern-start.sh"] },
  "scripts/build-modern-release.ts": { directories: ["src", "scripts", "docker"], files: ["Dockerfile.shared", "Dockerfile.shared.dockerignore", "LICENSE"] },
  "scripts/release-runtime.ts": { directories: ["src", "scripts", "docker"], files: ["Dockerfile.shared", "Dockerfile.shared.dockerignore", "LICENSE"] },
  "scripts/release-coordinator.ts": { files: ["src/installer/terminal-entry.ts", "scripts/build-coordinator.ts"] },
  "scripts/preview-server.ts": { webAssets: true },
  "src/server/application.ts": { webAssets: true },
  "src/backend/gateway.ts": { webAssets: true },
  "src/backend/treasury-transfer.ts": { assets: ["dist/backend/treasury-signer.cjs"] },
  "test/treasury-transfer.test.ts": { files: ["scripts/build-treasury-signer.ts", "src/backend/treasury-signer-entry.ts"] },
  "test/browser/request-admission.spec.ts": { webAssets: true },
};
/** These reviewed readers consume injected/generated runtime state, downloaded
 * artifacts, or synthetic test files. They do not dynamically discover checkout
 * code. Their static imports and literal checkout resource paths still count.
 * A new unknown dynamic reader falls back for its group until reviewed here. */
const RUNTIME_READERS = new Set([
  "scripts/host-address-file.ts", "scripts/hosted-server.ts", "scripts/local-integration.ts", "scripts/release-context.ts",
  "scripts/release/artifacts.ts", "scripts/release/effects.ts", "scripts/release/files.ts", "scripts/release/fixture-http.ts",
  "scripts/release/fixture-snapshot.ts", "scripts/release/github.ts", "scripts/shared-docker-fixture.ts", "scripts/shared-updater.ts",
  "scripts/test-claim-units-docker.ts", "scripts/test-claims-shutdown-docker.ts", "scripts/test-updater-docker.ts", "scripts/verification.ts",
  "src/backend/build.ts", "src/backend/credential-vault.ts", "src/backend/gpu-recorder-runtime.ts", "src/backend/pc-rewards.ts",
  "src/backend/rewards-claimer.ts", "src/backend/rewards-reader.ts", "src/backend/ssh.ts", "src/backend/treasury-claims-marker.ts", "src/backend/treasury-vault.ts",
  "src/installer/container-init.ts", "src/installer/setup-session.ts", "src/installer/terminal.ts", "src/server/file-snapshot-store.ts",
  "src/updater/release.ts", "src/updater/runtime.ts",
  ...["apple-certificate", "browser-security", "handoff-build", "host-address-file", "hosting-lab", "installer-artifact-download",
    "installer-browser-security", "installer-certificate-export", "installer-network-selection", "installer-treasury",
    "installer-updater-compatibility", "installer-vpn-web", "installer", "online-preview-server", "preview-server", "release-coordinator",
    "release-producer", "release-publisher", "rewards-claimer", "shared-access", "shared-backend-state", "shared-browser-key",
    "shared-docker-runner", "shared-gpu-recorder", "shared-pc-monitor", "shared-terminal-setup", "snapshot-store", "treasury-claims-marker",
    "treasury-gateway", "treasury", "updater-browser-security", "updater-lock", "updater-runtime", "updater", "verification", "webapp-assets"].map(name => `test/${name}.test.ts`),
  ...["host-addresses", "local-webapp", "online-hosts", "real200", "rewards-claims", "secure-navigation", "secure-setup",
    "shared-setup-access", "shared-setup", "wallet"].map(name => `test/browser/${name}.spec.ts`),
]);
const RUNTIME_MODULE_LOADERS = new Set(["scripts/hosted-server.ts", "scripts/shared-docker-fixture.ts", "test/treasury-transfer.test.ts", "test/browser/request-admission.spec.ts"]);
const policyFile = (path: string) => /^(?:package(?:-lock)?\.json|\.nvmrc|\.gitignore|tsconfig[^/]*\.json|playwright\.config\.ts|AGENTS\.md|docs\/(?:DEVELOPMENT|COMPONENT_RULES|SECURITY|REQUIREMENTS|WALLET_PILOT|MODERN_INSTALL|AUTOMATIC_UPDATES)\.md|scripts\/(?:verify\.ts|verification[^/]*\.ts))$/.test(path);
const localCode = (path: string) => /\.[cm]?[jt]sx?$/.test(path);
function safeRelative(root: string, absolute: string): string | null {
  const path = relative(root, absolute);
  return path && path !== ".." && !path.startsWith("../") && !isAbsolute(path) ? path : null;
}
function strings(text: string): string[] {
  // Imports themselves are parsed by esbuild below. This conservative resource
  // scan can over-include quoted examples; it never evaluates source text.
  return [...text.matchAll(/["'`]([^"'`\r\n]+)["'`]/g)].map(match => match[1]!).filter(value => !value.includes("${") && !value.includes("\\"));
}
function firstArguments(text: string, calls: RegExp): string[] {
  const result: string[] = [];
  for (const match of text.matchAll(calls)) {
    const start = match.index! + match[0].length;
    let depth = 0, quote = "", escaped = false, end = start;
    for (; end < text.length; end++) {
      const char = text[end]!;
      if (quote) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === quote) quote = ""; continue; }
      if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
      if (char === "(" || char === "[" || char === "{") depth++;
      else if (")]}".includes(char)) { if (!depth) break; depth--; }
      else if (char === "," && !depth) break;
    }
    result.push(text.slice(start, end));
  }
  return result;
}
function globPattern(pattern: string): RegExp {
  if (isAbsolute(pattern) || pattern.split("/").includes("..")) throw new UnownedDependencyError("Compiler inputs leave the inventoried checkout.");
  if (!pattern || /[{}[\]\\]/.test(pattern)) throw new Error("Unsupported compiler input pattern.");
  let expression = "^";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === "*" && pattern[index + 1] === "*") {
      index++;
      if (pattern[index + 1] === "/") { expression += "(?:.*/)?"; index++; }
      else expression += ".*";
    } else if (char === "*") expression += "[^/]*";
    else if (char === "?") expression += "[^/]";
    else expression += /[.+^$()|]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`${expression}$`);
}
function compilerInputs(root: string, path: string, inventory: readonly string[], seen = new Set<string>()): string[] {
  if (seen.has(path)) throw new Error("Circular compiler input configuration.");
  seen.add(path);
  const config = JSON.parse(readFileSync(resolve(root, path), "utf8")) as { extends?: string; files?: string[]; include?: string[]; exclude?: string[] };
  const files: string[] = [...(config.files ?? [])];
  if (files.some(file => isAbsolute(file) || file.split("/").includes(".."))) throw new UnownedDependencyError("Compiler inputs leave the inventoried checkout.");
  if (config.include) {
    const compilePattern = (pattern: string) => globPattern(inventory.some(file => file.startsWith(`${pattern}/`)) ? `${pattern}/**` : pattern);
    const includes = config.include.map(compilePattern), excludes = (config.exclude ?? []).map(compilePattern);
    files.push(...inventory.filter(file => includes.some(pattern => pattern.test(file)) && !excludes.some(pattern => pattern.test(file))));
  } else if (!config.files && config.extends) {
    const extended = safeRelative(root, resolve(root, dirname(path), config.extends));
    if (!extended) throw new UnownedDependencyError("Compiler input configuration leaves checkout.");
    files.push(...compilerInputs(root, extended, inventory, seen));
  } else if (!config.files) throw new Error("Unspecified compiler input discovery.");
  return files;
}
export function verificationStageInputs(root: string, stage: DependencyStage, inventory: readonly string[]): VerificationInputs {
  const known = new Set(inventory), files = new Set(inventory.filter(policyFile)), directories = new Set<string>(), assets = new Set<string>(), fallback = new Set<string>();
  let webAssets = stage.id === "browser";
  if (stage.id === "diff") return { files: [...inventory], directories: [], assetPaths: [], webAssets: false, fallbackReasons: [] };
  if (stage.id === "typecheck") return { files: [...new Set([...files, ...inventory.filter(path => localCode(path) || path.endsWith(".json"))])].sort(), directories: [], assetPaths: [], webAssets: false, fallbackReasons: [] };
  const pending = stage.id === "build" ? ["scripts/build.ts"] : [...stage.files];
  if (stage.id === "browser") pending.push("playwright.config.ts", "test/fixtures/start-browser-preview.ts");
  const visited = new Set<string>();
  const bundled = new Set<string>();
  const addDirectory = (path: string) => {
    if (!path || path.startsWith("..") || isAbsolute(path)) return;
    directories.add(path);
    for (const child of inventory) if (child.startsWith(`${path}/`)) {
      files.add(child); if (localCode(child) && !visited.has(child)) pending.push(child);
    }
  };
  const add = (path: string) => {
    if (!path || path.startsWith("..") || isAbsolute(path) || /[\0\r\n]/.test(path)) return;
    if (path === "dist" || path.startsWith("dist/")) return;
    if (existsSync(resolve(root, path)) && lstatSync(resolve(root, path)).isDirectory()) { addDirectory(path); return; }
    files.add(path); if (known.has(path) && localCode(path) && !visited.has(path)) pending.push(path);
  };
  const resourcePaths = (from: string, value: string, reading = false): string[] => {
    if (/^[a-z][a-z0-9+.-]*:|\s|[{}<>]/i.test(value) || value.length > 300) return [];
    if (!reading && [".", "..", "./", "../"].includes(value)) return [];
    if (value === "dist" || value.startsWith("dist/")) return [];
    const candidates = value.startsWith(".") ? [safeRelative(root, resolve(root, dirname(from), value))]
      : [value, safeRelative(root, resolve(root, dirname(from), value))];
    return candidates.filter((path): path is string => !!path && !path.startsWith("node_modules/") && !path.startsWith("dist/")
      && (known.has(path) || (reading || value.includes("/")) && inventory.some(file => file.startsWith(`${path}/`))));
  };
  while (pending.length) {
    const roots = [...new Set(pending.filter(path => known.has(path) && localCode(path) && !bundled.has(path)))];
    if (roots.length) {
      for (const path of roots) bundled.add(path);
      try {
        const result = buildSync({ absWorkingDir: root, entryPoints: roots, outdir: "verification-input-scan", bundle: true,
          write: false, metafile: true, packages: "external", platform: "node", format: "esm", logLevel: "silent",
          logOverride: { "unsupported-dynamic-import": "warning", "unsupported-require-call": "warning" } });
        for (const dependency of Object.keys(result.metafile!.inputs)) {
          if (!known.has(dependency)) throw new UnownedDependencyError("Verification found a dependency outside the inventoried checkout; it cannot be cached.");
          bundled.add(dependency); add(dependency);
        }
        for (const warning of result.warnings) if (["unsupported-dynamic-import", "unsupported-require-call"].includes(warning.id)) {
          const from = warning.location?.file;
          if (!from || !RUNTIME_MODULE_LOADERS.has(from)) fallback.add(`${from ?? roots[0]}: dynamic module dependency`);
        }
      } catch (error) {
        if (error instanceof UnownedDependencyError) throw error;
        fallback.add(`${roots.join(",")}: unresolved static dependency`);
      }
    }
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path); files.add(path);
    if (!known.has(path) || !localCode(path)) continue;
    const source = readFileSync(resolve(root, path), "utf8"), rule = RESOURCES[path];
    for (const value of rule?.files ?? []) add(value);
    for (const value of rule?.directories ?? []) addDirectory(value);
    for (const config of rule?.compilers ?? []) {
      if (!known.has(config)) continue;
      try { for (const value of compilerInputs(root, config, inventory)) add(value); }
      catch (error) {
        if (error instanceof UnownedDependencyError) throw error;
        fallback.add(`${path}: unresolved compiler input configuration`);
      }
    }
    if (stage.id !== "build") {
      for (const asset of rule?.assets ?? []) assets.add(asset);
      if (rule?.webAssets) webAssets = true;
    }
    if (rule?.literalResources !== false) for (const value of strings(source)) for (const resource of resourcePaths(path, value)) add(resource);
    const reviewed = !!rule || RUNTIME_READERS.has(path);
    if (!reviewed) for (const argument of firstArguments(source, /\b(?:readFile(?:Sync)?|readdir(?:Sync)?|cpSync|copyFile(?:Sync)?)\s*\(/g)) {
      const resources = strings(argument).flatMap(value => resourcePaths(path, value, true));
      for (const resource of resources) add(resource);
      if (!resources.length) fallback.add(`${path}: dynamic filesystem dependency`);
    }
  }
  if (fallback.size) {
    for (const path of inventory) files.add(path);
    if (stage.id !== "build") assets.add("dist");
  }
  return { files: [...files].sort(), directories: [...directories].sort(), assetPaths: [...assets].sort(), webAssets, fallbackReasons: [...fallback].sort() };
}
