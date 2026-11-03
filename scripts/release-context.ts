import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { sha256 } from "./release-runtime.ts";

const files = ["Dockerfile.shared", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.browser.json", "LICENSE",
  "docker/DOCKER-CLI-LICENSE", "docker/DOCKER-CLI-NOTICE"];
const trees = ["src", "scripts"];
export interface SourceInput { name: string; bytes: number; sha256: string }
/** Fixed build input allowlist. No checkout metadata, local evidence, node_modules
 * or unlisted root files can reach Docker, regardless of .dockerignore. */
export function releaseSourceInputs(project: string, trackedNames?: readonly string[]): SourceInput[] {
  const root = resolve(project);
  const tracked = trackedNames ?? execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 ** 2 }).split("\0").filter(Boolean);
  const names = [...new Set(tracked.filter(name => files.includes(name) || trees.some(tree => name.startsWith(`${tree}/`))))];
  if (files.some(name => !names.includes(name)) || trees.some(tree => !names.some(name => name.startsWith(`${tree}/`)))) throw new Error("Required release sources are not tracked.");
  return names.sort().map(name => {
    if (name.startsWith("/") || name.includes("\\") || name.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Invalid release input path.");
    const path = join(root, name), stat = lstatSync(path);
    for (let parent = dirname(path); parent !== root; parent = dirname(parent)) if (lstatSync(parent).isSymbolicLink()) throw new Error("Release inputs cannot contain symbolic links.");
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 ** 2) throw new Error("Invalid release source input.");
    const bytes = readFileSync(path);
    return { name, bytes: bytes.length, sha256: sha256(bytes) };
  });
}
export const sourceInputFingerprint = (inputs: readonly SourceInput[]): string => sha256(Buffer.from(JSON.stringify(inputs)));
/** Materialize canonical modes and timestamps independently of the checkout path. */
export function writeReleaseContext(project: string, directory: string, inputs = releaseSourceInputs(project)): string {
  const root = resolve(project), output = resolve(directory), pathFromSource = relative(root, output);
  if (pathFromSource !== ".." && !pathFromSource.startsWith("../") && !pathFromSource.startsWith("/")) throw new Error("Release staging must be outside the source checkout.");
  mkdirSync(output, { mode: 0o700 });
  for (const item of inputs) {
    const data = readFileSync(join(root, item.name));
    if (data.length !== item.bytes || sha256(data) !== item.sha256) throw new Error("A release source input changed during staging.");
    const path = join(output, item.name); mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
    writeFileSync(path, data, { mode: 0o644, flag: "wx" }); chmodSync(path, 0o644); utimesSync(path, 0, 0);
  }
  function canonicalDirectories(path: string): void {
    for (const entry of readdirSync(path)) if (lstatSync(join(path, entry)).isDirectory()) canonicalDirectories(join(path, entry));
    chmodSync(path, 0o755); utimesSync(path, 0, 0);
  }
  canonicalDirectories(output);
  return sourceInputFingerprint(inputs);
}
