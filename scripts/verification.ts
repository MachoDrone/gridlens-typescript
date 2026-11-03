import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, homedir, release } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { selectVerificationTests, testOwner, VERIFICATION_GROUPS } from "./verification-groups.ts";
import type { AcceptanceKind, ScopeSelection } from "./verification-groups.ts";
import { verificationStageInputs } from "./verification-inputs.ts";
import { documentationPolicyChanged } from "./verification-docs.ts";

const FORMAT = "gridlens-verification-v1" as const;
const POLICY = 2;
export interface FileProof { path: string; sha256: string | null; executable?: boolean }
export interface VerificationStage { id: string; command: string[]; files: string[] }
export interface VerificationPlan {
  format: typeof FORMAT; policy: number; root: string; baseCommit: string; sourceCommit: string;
  purpose: "verification" | "benchmark"; benchmarkPaths: string[];
  sourceFingerprint: string; toolchainFingerprint: string; environmentFingerprint: string;
  requestedFull: boolean; selection: ScopeSelection; changed: { path: string; status: string; policyChange?: boolean }[];
  stages: VerificationStage[]; requiredAcceptances: AcceptanceKind[]; stateDir: string; planHash: string;
}
export interface StageEvidence {
  id: string; command: string[]; inputFingerprint: string; exitCode: number; completed: boolean;
  startedAt: string; durationMs: number; reused: boolean; logPath: string; logSha256: string;
  artifacts: FileProof[];
}
export interface VerificationReceipt {
  format: typeof FORMAT; plan: VerificationPlan; status: "checks-passed" | "failed" | "invalidated";
  stages: StageEvidence[]; startedAt: string; completedAt: string; receiptPath: string;
  missingAcceptances: AcceptanceKind[];
}
export interface VerificationOptions { root: string; base: string; full?: boolean; stateDir?: string }
export interface VerificationValidation { valid: boolean; checksPassed: boolean; missingAcceptances: string[]; errors: string[] }
export interface StageExecution { root: string; command: string[]; logPath: string }
/** Injection is used by isolated verifier tests, never accepted by the CLI. */
export interface VerificationRuntime { execute?: (request: StageExecution) => Promise<number>; fingerprint?: () => string }

function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function jsonHash(value: unknown): string { return hash(JSON.stringify(value)); }
function git(root: string, args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Git verification input failed: ${args[0]}.`);
  return result.stdout;
}
function normalizedPath(path: string): string {
  if (!path || isAbsolute(path) || path.split("/").some(part => part === ".." || part === ".") || /[\0\r\n]/.test(path)) throw new Error("Unsafe verification input path.");
  return path;
}
function fileProof(root: string, path: string): FileProof {
  normalizedPath(path);
  const absolute = join(root, path);
  if (!existsSync(absolute)) return { path, sha256: null };
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(absolute) !== absolute) throw new Error(`Verification inputs must be ordinary files: ${path}.`);
  return { path, sha256: hash(readFileSync(absolute)), executable: (stat.mode & 0o111) !== 0 };
}
function inventory(root: string): string[] {
  return [...new Set(git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean).map(normalizedPath))].filter(path => {
    try {
      const stat = lstatSync(join(root, path));
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Verification source inputs must be ordinary files.");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }).sort();
}
export function verificationSourceFingerprint(root: string): string {
  const canonical = realpathSync(resolve(root));
  return jsonHash(inventory(canonical).map(path => fileProof(canonical, path)));
}
function changes(root: string, base: string): VerificationPlan["changed"] {
  const fields = git(root, ["diff", "--name-status", "-z", "--find-renames", base, "--"]).split("\0");
  const rows: VerificationPlan["changed"] = [];
  for (let index = 0; index < fields.length && fields[index];) {
    const status = fields[index++]!;
    const path = normalizedPath(fields[index++] ?? "");
    if (/^[RC]/.test(status)) {
      rows.push({ path, status: status.startsWith("R") ? "D" : "M" });
      rows.push({ path: normalizedPath(fields[index++] ?? ""), status: "A" });
    } else rows.push({ path, status: status[0]! });
  }
  for (const path of git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean)) rows.push({ path: normalizedPath(path), status: "A" });
  const result = [...new Map(rows.map(row => [row.path, row])).values()].sort((a, b) => a.path.localeCompare(b.path));
  for (const row of result) if (/^(?:README\.md|docs\/.*\.(?:md|txt))$/.test(row.path)) {
    const old = spawnSync("git", ["-C", root, "show", `${base}:${row.path}`], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    const before = old.status === 0 ? old.stdout : "", after = existsSync(join(root, row.path)) ? readFileSync(join(root, row.path), "utf8") : "";
    row.policyChange = documentationPolicyChanged(before, after, git(root, ["diff", "--unified=0", base, "--", row.path]), old.status !== 0 || row.status === "D");
  }
  return result;
}
function treeProof(root: string, path: string): FileProof[] {
  const absolute = join(root, path);
  if (!existsSync(absolute)) return [{ path, sha256: null }];
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error("Symbolic links are not accepted in verification artifacts.");
  if (stat.isDirectory()) return readdirSync(absolute).sort().flatMap(name => treeProof(root, `${path}/${name}`));
  return [fileProof(root, path)];
}
function environmentFingerprint(): string {
  // Hash values, never serialize possible credentials. Changes to effective
  // process/browser environment invalidate evidence. Invocation identifiers are
  // provenance of the caller, not test inputs; they change between tool calls.
  // Keep other CODEX_* configuration and tracing/export settings fingerprinted.
  const invocationOnly = new Set(["PWD", "OLDPWD", "SHLVL", "_", "INIT_CWD", "CODEX_TOOL_CALL_ID", "CODEX_CALL_ID", "CODEX_TURN_ID",
    "CODEX_SESSION_ID", "CODEX_THREAD_ID", "CODEX_REQUEST_ID", "CODEX_TRACE_ID", "CODEX_SPAN_ID"]);
  return jsonHash(Object.entries(process.env).filter(([key]) => !key.startsWith("npm_") && !invocationOnly.has(key)).sort(([a], [b]) => a.localeCompare(b)));
}
function toolchainFingerprint(root: string): string {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { engines?: { node?: string; npm?: string } };
  const npm = spawnSync("npm", ["--version"], { cwd: root, encoding: "utf8", timeout: 10_000 });
  if (process.versions.node !== pkg.engines?.node || npm.status !== 0 || npm.stdout.trim() !== pkg.engines?.npm) throw new Error("Verification requires the repository's pinned Node and npm versions.");
  const browser = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  const modules = join(root, "node_modules");
  if (!existsSync(modules)) throw new Error("Verification toolchain is incomplete; install pinned dependencies first.");
  // The lockfile describes expected packages; hashing actual package bytes also
  // detects a locally altered dependency. npm's executable-link directory is not
  // used by the direct Node commands below and is deliberately excluded.
  const tooling = readdirSync(modules).filter(name => name !== ".bin").sort().flatMap(name => treeProof(root, `node_modules/${name}`));
  if (tooling.some(proof => proof.sha256 === null)) throw new Error("Verification toolchain is incomplete; install pinned dependencies first.");
  return jsonHash({ node: process.versions.node, npm: npm.stdout.trim(), platform: process.platform, arch: process.arch, osRelease: release(), availableParallelism: availableParallelism(),
    nodeSha256: hash(readFileSync(process.execPath)), browserSha256: existsSync(browser) ? hash(readFileSync(browser)) : null, tooling });
}
function externalStateDirectory(root: string, supplied?: string): string {
  const state = resolve(supplied ?? join(homedir(), ".local/state/gridlens-verification", hash(root).slice(0, 20)));
  const within = relative(root, state);
  if (!within || !within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(within)) throw new Error("Verification evidence must be outside the source checkout.");
  let ancestor = state;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  if (realpathSync(ancestor) !== ancestor) throw new Error("Verification evidence cannot use symbolic-link directories.");
  return state;
}
function planDigest(plan: Omit<VerificationPlan, "planHash"> | VerificationPlan): string {
  const { planHash: _ignored, sourceCommit: _commit, ...content } = plan as VerificationPlan;
  // A commit of the exact already-tested contents does not invalidate evidence.
  return jsonHash(content);
}
function stageDefinitions(root: string, base: string, selection: ScopeSelection): VerificationStage[] {
  const stages: VerificationStage[] = [{ id: "diff", command: [process.execPath, "scripts/verification-diff.ts", base], files: [] }];
  if (selection.documentationOnly) return stages;
  stages.push({ id: "typecheck", command: [process.execPath, join(root, "node_modules/typescript/bin/tsc"), "--noEmit"], files: [] });
  stages.push({ id: "build", command: [process.execPath, "scripts/build.ts"], files: [] });
  for (const group of VERIFICATION_GROUPS) {
    const files = selection.nodeTests.filter(path => testOwner(path) === group);
    if (files.length) stages.push({ id: `node-${group}`, command: [process.execPath, "--test", `--test-concurrency=${Math.max(1, Math.floor(availableParallelism() / 2))}`, ...files], files });
  }
  if (selection.browserTests.length) stages.push({ id: "browser", command: [process.execPath, join(root, "node_modules/@playwright/test/cli.js"), "test", ...selection.browserTests, "--output", "<run-output>"], files: selection.browserTests });
  return stages;
}
export async function planVerification(options: VerificationOptions, runtime: VerificationRuntime = {}): Promise<VerificationPlan> {
  const root = realpathSync(resolve(options.root));
  if (!/^[a-f0-9]{7,40}$/.test(options.base)) throw new Error("Verification base must be an immutable commit SHA.");
  const baseCommit = git(root, ["rev-parse", "--verify", `${options.base}^{commit}`]).trim();
  git(root, ["merge-base", "--is-ancestor", baseCommit, "HEAD"]);
  const files = inventory(root), changed = changes(root, baseCommit);
  const selection = selectVerificationTests(changed, files.filter(path => existsSync(join(root, path))), options.full ?? false);
  const plan: VerificationPlan = { format: FORMAT, policy: POLICY, root, baseCommit, sourceCommit: git(root, ["rev-parse", "HEAD"]).trim(), purpose: "verification", benchmarkPaths: [],
    sourceFingerprint: verificationSourceFingerprint(root), toolchainFingerprint: runtime.fingerprint?.() ?? toolchainFingerprint(root),
    environmentFingerprint: environmentFingerprint(), requestedFull: options.full ?? false, selection, changed,
    stages: stageDefinitions(root, baseCommit, selection), requiredAcceptances: selection.requiredAcceptances,
    stateDir: externalStateDirectory(root, options.stateDir), planHash: "" };
  plan.planHash = planDigest(plan);
  return plan;
}
/** Measurement only. Publication validation deliberately rejects these plans. */
export async function planVerificationBenchmark(options: VerificationOptions & { changedPaths: string[] }, runtime: VerificationRuntime = {}): Promise<VerificationPlan> {
  const plan = await planVerification(options, runtime);
  plan.purpose = "benchmark";
  plan.benchmarkPaths = [...new Set(options.changedPaths.map(normalizedPath))].sort();
  if (!plan.benchmarkPaths.length || plan.benchmarkPaths.some(path => !existsSync(join(plan.root, path)))) throw new Error("Benchmark paths must name existing source files.");
  plan.selection = selectVerificationTests(plan.benchmarkPaths.map(path => ({ path, status: "M" })), inventory(plan.root), false);
  plan.stages = stageDefinitions(plan.root, plan.baseCommit, plan.selection);
  plan.requiredAcceptances = plan.selection.requiredAcceptances;
  plan.planHash = planDigest(plan);
  return plan;
}
async function refreshPlan(plan: VerificationPlan, runtime: VerificationRuntime): Promise<VerificationPlan> {
  const options = { root: plan.root, base: plan.baseCommit, full: plan.requestedFull, stateDir: plan.stateDir };
  return plan.purpose === "benchmark" ? planVerificationBenchmark({ ...options, changedPaths: plan.benchmarkPaths }, runtime) : planVerification(options, runtime);
}
function stageFingerprint(plan: VerificationPlan, stage: VerificationStage): string {
  const inputs = verificationStageInputs(plan.root, stage, inventory(plan.root));
  const assetPaths = new Set(inputs.assetPaths);
  const assets = [...assetPaths].flatMap(path => treeProof(plan.root, path));
  if (inputs.webAssets) assets.push(...treeProof(plan.root, "dist").filter(proof => !proof.path.startsWith("dist/backend/")));
  const uniqueAssets = [...new Map(assets.map(proof => [proof.path, proof])).values()].sort((a, b) => a.path.localeCompare(b.path));
  return jsonHash({ policy: POLICY, stage, toolchain: plan.toolchainFingerprint, environment: plan.environmentFingerprint,
    inputs: inputs.files.map(path => fileProof(plan.root, path)), directories: inputs.directories, fallbackReasons: inputs.fallbackReasons, assets: uniqueAssets });
}
function initializeState(directory: string, root: string): void {
  const marker = join(directory, "verification-state.json");
  if (existsSync(directory) && !existsSync(marker) && readdirSync(directory).length) throw new Error("Verification state directory is not an owned empty directory.");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (existsSync(marker)) {
    if (lstatSync(marker).isSymbolicLink() || readFileSync(marker, "utf8") !== JSON.stringify({ format: FORMAT, root })) throw new Error("Verification state belongs to another checkout.");
  } else writeFileSync(marker, JSON.stringify({ format: FORMAT, root }), { flag: "wx", mode: 0o600 });
  chmodSync(directory, 0o700);
  for (const name of ["cache", "runs"]) {
    const child = join(directory, name);
    mkdirSync(child, { recursive: true, mode: 0o700 });
    if (!lstatSync(child).isDirectory() || realpathSync(child) !== child) throw new Error("Invalid verification evidence directory.");
  }
}
function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}
async function executeStage({ root, command, logPath }: StageExecution): Promise<number> {
  const descriptor = openSync(logPath, "wx", 0o600);
  try {
    return await new Promise<number>((resolveStatus, reject) => {
      const executable = command[0]!;
      const child = spawn(executable, command.slice(1), { cwd: root, stdio: ["ignore", descriptor, descriptor], shell: false });
      child.once("error", reject);
      child.once("close", code => resolveStatus(code ?? 1));
    });
  } finally { closeSync(descriptor); }
}
function evidenceValid(plan: VerificationPlan, stage: VerificationStage, evidence: StageEvidence, fingerprint: string): boolean {
  try {
    if (evidence.id !== stage.id || evidence.completed !== true || evidence.exitCode !== 0 || evidence.inputFingerprint !== fingerprint
      || JSON.stringify(evidence.command) !== JSON.stringify(stage.command) || !Number.isFinite(evidence.durationMs) || evidence.durationMs < 0) return false;
    const log = resolve(evidence.logPath), relativeLog = relative(join(plan.stateDir, "runs"), log);
    if (relativeLog.startsWith("..") || isAbsolute(relativeLog) || realpathSync(log) !== log || !lstatSync(log).isFile() || hash(readFileSync(log)) !== evidence.logSha256) return false;
    const expectedArtifacts = stage.id === "build" ? treeProof(plan.root, "dist") : [];
    if (stage.id === "build" && (!expectedArtifacts.length || expectedArtifacts.some(item => item.sha256 === null))) return false;
    return JSON.stringify(evidence.artifacts) === JSON.stringify(expectedArtifacts);
  } catch { return false; }
}
function loadCache(plan: VerificationPlan, stage: VerificationStage, fingerprint: string): StageEvidence | null {
  try {
    const path = join(plan.stateDir, "cache", `${stage.id}-${fingerprint}.json`);
    if (lstatSync(path).isSymbolicLink()) return null;
    const cached = JSON.parse(readFileSync(path, "utf8")) as StageEvidence;
    return evidenceValid(plan, stage, cached, fingerprint) ? { ...cached, reused: true } : null;
  } catch { return null; }
}
export async function runVerification(plan: VerificationPlan, runtime: VerificationRuntime = {}): Promise<VerificationReceipt> {
  const fresh = await refreshPlan(plan, runtime);
  if (fresh.planHash !== plan.planHash || planDigest(plan) !== plan.planHash) throw new Error("Verification inputs changed after planning; generate a fresh plan.");
  initializeState(plan.stateDir, plan.root);
  const locks = join(homedir(), ".local/state/gridlens-verification-locks");
  mkdirSync(locks, { recursive: true, mode: 0o700 });
  if (!lstatSync(locks).isDirectory() || realpathSync(locks) !== locks) throw new Error("Invalid verification lock directory.");
  // Different --state-dir choices must not allow simultaneous shared dist builds.
  const lock = join(locks, `${hash(plan.root)}.lock`);
  const descriptor = openSync(lock, "wx", 0o600);
  const run = join(plan.stateDir, "runs", `${Date.now()}-${randomUUID()}`);
  mkdirSync(run, { mode: 0o700 });
  const receipt: VerificationReceipt = { format: FORMAT, plan, status: "failed", stages: [], startedAt: new Date().toISOString(), completedAt: "", receiptPath: join(run, "receipt.json"), missingAcceptances: plan.requiredAcceptances };
  writeFileSync(descriptor, `${process.pid}\n`);
  atomicJson(join(run, "plan.json"), plan);
  try {
    const executeOne = async (stage: VerificationStage): Promise<{ evidence: StageEvidence; valid: boolean }> => {
      const fingerprint = stageFingerprint(plan, stage);
      const cached = loadCache(plan, stage, fingerprint);
      if (cached) return { evidence: cached, valid: true };
      const started = Date.now(), logPath = join(run, `${stage.id}.log`);
      const command = stage.command.map(argument => argument === "<run-output>" ? join(run, "browser-results") : argument);
      let exitCode = 1;
      let browserLock: number | undefined;
      const browserLockPath = join(locks, "browser-4174.lock");
      try {
        if (stage.id === "browser" && !runtime.execute) browserLock = openSync(browserLockPath, "wx", 0o600);
        exitCode = await (runtime.execute ?? executeStage)({ root: plan.root, command, logPath });
      }
      catch { if (!existsSync(logPath)) writeFileSync(logPath, "Verification command could not start.\n", { mode: 0o600 }); }
      finally { if (browserLock !== undefined) { closeSync(browserLock); rmSync(browserLockPath); } }
      const evidence: StageEvidence = { id: stage.id, command: stage.command, inputFingerprint: fingerprint, exitCode,
        completed: true, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, reused: false,
        logPath, logSha256: hash(readFileSync(logPath)), artifacts: stage.id === "build" ? treeProof(plan.root, "dist") : [] };
      return { evidence, valid: stageFingerprint(plan, stage) === fingerprint && evidenceValid(plan, stage, evidence, fingerprint) };
    };
    const wave = async (stages: VerificationStage[]): Promise<boolean> => {
      // Wait for every admitted child even when its peer fails. No later wave is
      // admitted after failure, and results retain deterministic plan order.
      const results = await Promise.allSettled(stages.map(executeOne));
      let valid = true;
      let rejected: PromiseRejectedResult | undefined;
      for (const result of results) {
        if (result.status === "rejected") { valid = false; rejected ??= result; continue; }
        receipt.stages.push(result.value.evidence);
        if (!result.value.valid) {
          valid = false;
          if (result.value.evidence.exitCode === 0) receipt.status = "invalidated";
        }
      }
      atomicJson(receipt.receiptPath, receipt);
      if (rejected) throw rejected.reason;
      return valid;
    };
    let proceed = true;
    for (const stage of plan.stages.filter(stage => !stage.id.startsWith("node-") && stage.id !== "browser")) {
      if (!await wave([stage])) { proceed = false; break; }
    }
    const ordinary = plan.stages.filter(stage => stage.id.startsWith("node-") && stage.id !== "node-stress");
    const width = Math.min(2, availableParallelism());
    for (let index = 0; proceed && index < ordinary.length; index += width) proceed = await wave(ordinary.slice(index, index + width));
    for (const stage of plan.stages.filter(stage => stage.id === "node-stress" || stage.id === "browser")) {
      if (proceed) proceed = await wave([stage]);
    }
    // Commit reusable evidence only after the candidate, environment and actual
    // toolchain bytes are checked again. An interrupted run has no new cache.
    const after = await refreshPlan(plan, runtime);
    if (after.planHash !== plan.planHash) receipt.status = "invalidated";
    else {
      for (const evidence of receipt.stages) {
        const stage = plan.stages.find(item => item.id === evidence.id);
        if (stage && evidenceValid(plan, stage, evidence, stageFingerprint(plan, stage))) {
          atomicJson(join(plan.stateDir, "cache", `${stage.id}-${evidence.inputFingerprint}.json`), evidence);
        }
      }
      if (receipt.stages.length === plan.stages.length && receipt.stages.every(stage => stage.exitCode === 0) && receipt.status !== "invalidated") receipt.status = "checks-passed";
    }
  } finally {
    receipt.completedAt = new Date().toISOString();
    atomicJson(receipt.receiptPath, receipt);
    closeSync(descriptor); rmSync(lock);
  }
  return receipt;
}
export async function validateVerificationReceipt(receipt: VerificationReceipt, options: { root: string; requiredAcceptances?: readonly string[] }, runtime: VerificationRuntime = {}): Promise<VerificationValidation> {
  const errors: string[] = [], missing = new Set<string>(options.requiredAcceptances ?? []);
  try {
    if (receipt.format !== FORMAT || receipt.plan?.format !== FORMAT || receipt.status !== "checks-passed" || !receipt.completedAt) throw new Error("Verification checks are not complete.");
    if (receipt.plan.purpose !== "verification") throw new Error("Benchmark evidence cannot authorize publication.");
    const plan = await planVerification({ root: options.root, base: receipt.plan.baseCommit, full: receipt.plan.requestedFull, stateDir: receipt.plan.stateDir }, runtime);
    for (const kind of plan.requiredAcceptances) missing.add(kind);
    if (JSON.stringify(receipt.missingAcceptances) !== JSON.stringify(plan.requiredAcceptances)) errors.push("Required external acceptance coverage was altered.");
    if (plan.planHash !== receipt.plan.planHash || planDigest(receipt.plan) !== plan.planHash) errors.push("Verification source, policy, environment or toolchain changed.");
    if (receipt.stages.length !== plan.stages.length) errors.push("Verification stage coverage is incomplete.");
    for (let index = 0; index < plan.stages.length; index++) {
      const stage = plan.stages[index]!, evidence = receipt.stages[index];
      if (!evidence || !evidenceValid(plan, stage, evidence, stageFingerprint(plan, stage))) errors.push(`Missing or stale verification evidence: ${stage.id}.`);
    }
  } catch (error) { errors.push(error instanceof Error ? error.message : "Invalid verification receipt."); }
  return { valid: errors.length === 0, checksPassed: errors.length === 0, missingAcceptances: [...missing].sort(), errors };
}
