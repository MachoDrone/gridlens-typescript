import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { selectVerificationTests } from "../scripts/verification-groups.ts";
import { planVerification, planVerificationBenchmark, runVerification, validateVerificationReceipt, verificationSourceFingerprint } from "../scripts/verification.ts";
import type { StageExecution, VerificationRuntime } from "../scripts/verification.ts";
import { checkVerificationDiff } from "../scripts/verification-diff.ts";
import { verificationStageInputs } from "../scripts/verification-inputs.ts";

const files = ["test/treasury.test.ts", "test/treasury-claims.test.ts", "test/shared-access.test.ts", "test/shared-backend-state.test.ts", "test/shared-backend-state.stress.test.ts", "test/shared-state-batch.test.ts", "test/solana-rpc.test.ts", "test/solana-rpc-authorization.test.ts", "test/installer-treasury.test.ts", "test/jobs-client.test.ts", "test/browser/wallet.spec.ts", "test/browser/rewards-claims.spec.ts", "test/browser/secure-navigation.spec.ts", "test/browser/fleet.spec.ts", "test/browser/progressive.stress.spec.ts"];
function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), "gridlens-verifier-test-")), root = join(temporary, "source"), stateDir = join(temporary, "evidence");
  mkdirSync(root);
  const write = (path: string, data = "export {};\n") => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), data); };
  for (const path of [...files, "src/backend/treasury.ts", "src/backend/rewards-claimer.ts", "src/backend/collector.ts", "scripts/build.ts", "test/fixtures/inventory.ts"]) write(path);
  write("test/treasury.test.ts", 'import "../src/backend/treasury.ts";\n');
  write("test/treasury-claims.test.ts", 'import "../src/backend/rewards-claimer.ts";\n');
  write("test/jobs-client.test.ts", 'import "../src/backend/collector.ts";\n');
  write("src/contracts/treasury.ts");
  write("test/browser/wallet.spec.ts", 'import "../../src/contracts/treasury.ts";\n');
  write("test/fixtures/start-browser-preview.ts");
  write("src/preview/fixture.ts");
  write("tsconfig.browser.json", JSON.stringify({ include: ["src/preview/**/*.ts", "src/contracts/**/*.ts"] }));
  write("package.json", JSON.stringify({ engines: { node: process.versions.node, npm: "11.11.0" } }));
  write(".gitignore", "dist/\nnode_modules/\n");
  write("README.md", "# Test\n"); write("tsconfig.json", "{}\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Generated fixture"); git("add", "."); git("commit", "-qm", "generated baseline");
  const base = git("rev-parse", "HEAD");
  let tooling = "generated-toolchain-v1";
  const calls: string[][] = [];
  const execute = async ({ command, logPath }: StageExecution) => {
    calls.push(command); writeFileSync(logPath, `Generated successful executor: ${command.join(" ")}\n`);
    if (command.includes("scripts/build.ts")) write("dist/index.html", "generated browser asset\n");
    return 0;
  };
  const runtime: VerificationRuntime = { fingerprint: () => tooling, execute };
  return { root, stateDir, base, write, git, calls, runtime, tooling: (value: string) => { tooling = value; }, clean: () => rmSync(temporary, { recursive: true, force: true }) };
}

test("financial selection requires owner/auth, RPC, retained state and Wallet journeys without collector stress", () => {
  const selection = selectVerificationTests([{ path: "src/backend/rewards-claimer.ts", status: "M" }], files);
  assert.equal(selection.full, false);
  for (const path of ["test/treasury.test.ts", "test/shared-access.test.ts", "test/shared-backend-state.test.ts", "test/solana-rpc.test.ts", "test/solana-rpc-authorization.test.ts", "test/installer-treasury.test.ts"]) assert.ok(selection.nodeTests.includes(path), path);
  for (const path of ["test/browser/wallet.spec.ts", "test/browser/rewards-claims.spec.ts", "test/browser/secure-navigation.spec.ts"]) assert.ok(selection.browserTests.includes(path), path);
  assert.ok(!selection.nodeTests.some(path => path.includes("stress")));
  assert.ok(!selection.browserTests.some(path => path.includes("stress")));
  assert.deepEqual(selection.requiredAcceptances, ["docker-claim-units"]);
});
test("collection/storage changes require sustained suites; unknown, build, dependencies and policy select full inventory", () => {
  for (const path of ["src/backend/collector.ts", "src/backend/sqlite-state.ts"]) {
    const selection = selectVerificationTests([{ path, status: "M" }], files);
    assert.ok(selection.nodeTests.includes("test/shared-backend-state.stress.test.ts"));
    assert.ok(selection.browserTests.includes("test/browser/progressive.stress.spec.ts"));
  }
  for (const path of ["src/mystery.ts", "scripts/build.ts", "package-lock.json", "AGENTS.md", "docs/DEVELOPMENT.md", "docs/COMPONENT_RULES.md", "src/preview/viewport.ts", "scripts/verification-groups.ts"]) {
    const selection = selectVerificationTests([{ path, status: "M" }], files);
    assert.equal(selection.full, true, path);
    assert.equal(selection.nodeTests.length + selection.browserTests.length, files.length);
  }
  assert.equal(selectVerificationTests([{ path: "README.md", status: "M" }], files).documentationOnly, true);
  assert.equal(selectVerificationTests([{ path: "test/treasury.test.ts", status: "D" }], files).full, true);
});
test("whitespace gate includes new untracked files and planner rejects even dangling source symlinks", async () => {
  const f = fixture();
  try {
    assert.equal(checkVerificationDiff(f.root, f.base), 0);
    f.write("src/new.ts", "export const value = true;   \n");
    assert.equal(checkVerificationDiff(f.root, f.base), 1);
    f.write("src/new.ts", "export const value = true;\n");
    assert.equal(checkVerificationDiff(f.root, f.base), 0);
    symlinkSync("/does-not-exist-verifier-fixture", join(f.root, "src/external.ts"));
    await assert.rejects(planVerification(f, f.runtime), /ordinary files/);
  } finally { f.clean(); }
});
test("planner captures staged, unstaged, new, deleted and renamed files from immutable reachable base", async () => {
  const f = fixture();
  try {
    f.write("src/backend/treasury.ts", "export const changed = true;\n"); f.git("add", "src/backend/treasury.ts");
    f.write("README.md", "# Changed\n"); f.write("src/new.ts"); rmSync(join(f.root, "test/jobs-client.test.ts"));
    renameSync(join(f.root, "test/shared-access.test.ts"), join(f.root, "test/renamed-access.test.ts")); f.git("add", "test/shared-access.test.ts", "test/renamed-access.test.ts");
    const plan = await planVerification(f, f.runtime);
    assert.ok(plan.changed.some(row => row.path === "src/backend/treasury.ts" && row.status === "M"));
    assert.ok(plan.changed.some(row => row.path === "README.md" && row.status === "M"));
    assert.ok(plan.changed.some(row => row.path === "src/new.ts" && row.status === "A"));
    assert.ok(plan.changed.some(row => row.path === "test/jobs-client.test.ts" && row.status === "D"));
    assert.ok(plan.changed.some(row => row.path === "test/shared-access.test.ts" && row.status === "D"));
    assert.ok(plan.changed.some(row => row.path === "test/renamed-access.test.ts" && row.status === "A"));
    await assert.rejects(planVerification({ ...f, base: "HEAD" }, f.runtime), /immutable/);
    await assert.rejects(planVerification({ ...f, stateDir: join(f.root, ".tools") }, f.runtime), /outside/);
    f.git("checkout", "--orphan", "unrelated"); f.git("rm", "-rf", "."); f.write("other.txt", "unrelated\n"); f.git("add", "."); f.git("commit", "-qm", "unrelated");
    await assert.rejects(planVerification(f, f.runtime), /Git verification input failed/);
  } finally { f.clean(); }
});
test("complete successful evidence builds once, caches unchanged gates and remains valid through an identical commit", async () => {
  const f = fixture();
  try {
    f.write("src/backend/treasury.ts", "export const fixed = true;\n");
    const plan = await planVerification(f, f.runtime), first = await runVerification(plan, f.runtime);
    assert.equal(first.status, "checks-passed");
    assert.equal(f.calls.filter(command => command.includes("scripts/build.ts")).length, 1);
    assert.equal((await validateVerificationReceipt(first, { root: f.root, requiredAcceptances: ["public-installer"] }, f.runtime)).valid, true);
    const second = await runVerification(plan, f.runtime);
    assert.ok(second.stages.every(stage => stage.reused));
    const fingerprint = verificationSourceFingerprint(f.root);
    f.git("add", "."); f.git("commit", "-qm", "same tested content");
    assert.equal(verificationSourceFingerprint(f.root), fingerprint);
    const validation = await validateVerificationReceipt(first, { root: f.root, requiredAcceptances: ["public-installer"] }, f.runtime);
    assert.equal(validation.valid, true, validation.errors.join("; "));
    assert.deepEqual(validation.missingAcceptances, ["public-installer"]);
    assert.equal((await validateVerificationReceipt({ ...first, missingAcceptances: ["docker-updater"] }, { root: f.root }, f.runtime)).valid, false);
  } finally { f.clean(); }
});
test("missing coverage, altered logs, changed assets and changed toolchain cannot be saved as passed evidence", async () => {
  const f = fixture();
  try {
    f.write("src/backend/treasury.ts", "export const fixed = true;\n");
    const receipt = await runVerification(await planVerification(f, f.runtime), f.runtime);
    assert.equal((await validateVerificationReceipt({ ...receipt, stages: receipt.stages.slice(1) }, { root: f.root }, f.runtime)).valid, false);
    const stage = receipt.stages[0]!, log = readFileSync(stage.logPath);
    writeFileSync(stage.logPath, "tampered\n");
    assert.equal((await validateVerificationReceipt(receipt, { root: f.root }, f.runtime)).valid, false);
    writeFileSync(stage.logPath, log);
    f.write("dist/index.html", "different compiled bytes\n");
    assert.equal((await validateVerificationReceipt(receipt, { root: f.root }, f.runtime)).valid, false);
    f.write("dist/index.html", "generated browser asset\n");
    f.tooling("generated-toolchain-v2");
    assert.equal((await validateVerificationReceipt(receipt, { root: f.root }, f.runtime)).valid, false);
  } finally { f.clean(); }
});
test("source, selected tests, configuration and environment changes invalidate coverage; docs preserve runtime cache", async () => {
  const f = fixture(), previous = process.env.GRIDLENS_VERIFICATION_TEST;
  try {
    f.write("src/backend/treasury.ts", "export const fixed = true;\n");
    const first = await runVerification(await planVerification(f, f.runtime), f.runtime);
    f.write("README.md", "# New wording\n");
    const wording = await runVerification(await planVerification(f, f.runtime), f.runtime);
    assert.ok(wording.stages.filter(stage => stage.id !== "diff").every(stage => stage.reused));
    f.write("test/treasury.test.ts", "export const strongerAssertion = true;\n");
    const changedTest = await runVerification(await planVerification(f, f.runtime), f.runtime);
    assert.equal(changedTest.stages.find(stage => stage.id === "node-financial")?.reused, false);
    assert.equal(changedTest.stages.find(stage => stage.id === "build")?.reused, true);
    f.write("tsconfig.json", "{\"strict\":true}\n");
    assert.equal((await validateVerificationReceipt(first, { root: f.root }, f.runtime)).valid, false);
    const configured = await runVerification(await planVerification(f, f.runtime), f.runtime);
    assert.equal(configured.stages.find(stage => stage.id === "build")?.reused, false);
    process.env.GRIDLENS_VERIFICATION_TEST = "changed-environment";
    assert.equal((await validateVerificationReceipt(configured, { root: f.root }, f.runtime)).valid, false);
  } finally { if (previous === undefined) delete process.env.GRIDLENS_VERIFICATION_TEST; else process.env.GRIDLENS_VERIFICATION_TEST = previous; f.clean(); }
});
test("new tool-call and turn trace identifiers reuse evidence while effective environment changes still invalidate it", async () => {
  const f = fixture();
  const traceKeys = ["CODEX_TOOL_CALL_ID", "CODEX_CALL_ID", "CODEX_TURN_ID", "CODEX_SESSION_ID", "CODEX_THREAD_ID", "CODEX_REQUEST_ID", "CODEX_TRACE_ID", "CODEX_SPAN_ID"];
  const effective = { TZ: "Pacific/Auckland", NODE_OPTIONS: "--max-old-space-size=2048", PLAYWRIGHT_CHROMIUM_EXECUTABLE: "/generated/changed-browser", CODEX_CI: "generated-changed-configuration" };
  const saved = new Map([...traceKeys, ...Object.keys(effective)].map(key => [key, process.env[key]]));
  const restore = (key: string) => { const value = saved.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  try {
    for (const key of traceKeys) process.env[key] = `generated-first-${key}`;
    f.write("src/backend/treasury.ts", "export const fixed = true;\n");
    const plan = await planVerification(f, f.runtime), receipt = await runVerification(plan, f.runtime);
    const original = JSON.stringify(receipt), executed = f.calls.length;
    for (const key of traceKeys) process.env[key] = `generated-second-${key}`;
    const resumed = await planVerification(f, f.runtime);
    assert.equal(resumed.environmentFingerprint, plan.environmentFingerprint);
    assert.equal(resumed.planHash, plan.planHash);
    assert.equal((await validateVerificationReceipt(receipt, { root: f.root }, f.runtime)).valid, true);
    assert.ok((await runVerification(resumed, f.runtime)).stages.every(stage => stage.reused));
    assert.equal(f.calls.length, executed);
    for (const [key, value] of Object.entries(effective)) {
      process.env[key] = value;
      assert.equal((await validateVerificationReceipt(receipt, { root: f.root }, f.runtime)).valid, false, key);
      restore(key);
    }
    assert.equal(JSON.stringify(receipt), original, "existing receipt hashes and provenance are never rewritten");
  } finally { for (const key of saved.keys()) restore(key); f.clean(); }
});
test("failed and interrupted stages are not reusable; mutation during execution invalidates the run", async () => {
  const f = fixture();
  try {
    f.write("src/backend/treasury.ts", "export const fixed = true;\n");
    const plan = await planVerification(f, f.runtime);
    let failed = true;
    const runtime: VerificationRuntime = { ...f.runtime, execute: async request => { const result = await f.runtime.execute!(request); if (request.command.includes("--noEmit") && failed) { failed = false; return 1; } return result; } };
    const first = await runVerification(plan, runtime);
    assert.equal(first.status, "failed");
    const second = await runVerification(plan, runtime);
    assert.equal(second.status, "checks-passed");
    assert.equal(second.stages.find(stage => stage.id === "typecheck")?.reused, false);
    f.write("src/backend/treasury.ts", "export const nextFix = true;\n");
    const mutating: VerificationRuntime = { ...f.runtime, execute: async request => { const result = await f.runtime.execute!(request); if (request.command.includes("--noEmit")) f.write("src/backend/treasury.ts", "export const raced = true;\n"); return result; } };
    const raced = await runVerification(await planVerification(f, f.runtime), mutating);
    assert.equal(raced.status, "invalidated");
    assert.equal(raced.stages.some(stage => stage.id === "build"), false);
  } finally { f.clean(); }
});
test("benchmark plans retain candidate fingerprints but can never authorize publication", async () => {
  const f = fixture();
  try {
    f.write("package.json", JSON.stringify({ engines: { node: process.versions.node, npm: "11.11.0" }, changed: true }));
    assert.equal((await planVerification(f, f.runtime)).selection.full, true);
    const benchmark = await planVerificationBenchmark({ ...f, changedPaths: ["src/backend/rewards-claimer.ts"] }, f.runtime);
    assert.equal(benchmark.purpose, "benchmark"); assert.equal(benchmark.selection.full, false);
    const receipt = await runVerification(benchmark, f.runtime);
    assert.equal(receipt.status, "checks-passed");
    const validation = await validateVerificationReceipt(receipt, { root: f.root }, f.runtime);
    assert.equal(validation.valid, false); assert.match(validation.errors.join(" "), /Benchmark/);
  } finally { f.clean(); }
});

test("a backend-only change retains unrelated collection, browser and build evidence", async () => {
  const f = fixture();
  try {
    const first = await runVerification(await planVerification({ ...f, full: true }, f.runtime), f.runtime);
    assert.equal(first.status, "checks-passed");
    f.write("src/backend/rewards-claimer.ts", "export const corrected = true;\n");
    const next = await runVerification(await planVerification({ ...f, full: true }, f.runtime), f.runtime);
    assert.equal(next.status, "checks-passed");
    for (const id of ["build", "node-collection", "browser"]) assert.equal(next.stages.find(stage => stage.id === id)?.reused, true, id);
    for (const id of ["typecheck", "node-financial"]) assert.equal(next.stages.find(stage => stage.id === id)?.reused, false, id);
  } finally { f.clean(); }
});

test("imported helpers, read resources, directory membership and selected-test additions invalidate their own groups", async () => {
  const f = fixture();
  try {
    f.write("test/fixtures/financial-helper.ts", 'import "../../src/backend/treasury.ts";\n');
    f.write("test/fixtures/claim-cases/one.json", '{"amount":1}\n');
    f.write("test/treasury.test.ts", 'import "./fixtures/financial-helper.ts";\nimport {readFileSync,readdirSync} from "node:fs";\nreadFileSync(new URL("./fixtures/claim-cases/one.json",import.meta.url));\nreaddirSync(new URL("./fixtures/claim-cases",import.meta.url));\n');
    await runVerification(await planVerification({ ...f, full: true }, f.runtime), f.runtime);
    for (const [path, data] of [
      ["test/fixtures/financial-helper.ts", 'import "../../src/backend/treasury.ts";\nexport const extra = true;\n'],
      ["test/fixtures/claim-cases/one.json", '{"amount":2}\n'],
      ["test/fixtures/claim-cases/two.json", '{"amount":3}\n'],
      ["test/treasury-new.test.ts", 'import "../src/backend/treasury.ts";\n'],
    ]) {
      f.write(path!, data!);
      const receipt = await runVerification(await planVerification({ ...f, full: true }, f.runtime), f.runtime);
      assert.equal(receipt.status, "checks-passed");
      assert.equal(receipt.stages.find(stage => stage.id === "node-financial")?.reused, false, path);
      assert.equal(receipt.stages.find(stage => stage.id === "node-collection")?.reused, true, path);
      assert.equal(receipt.stages.find(stage => stage.id === "browser")?.reused, true, path);
    }
  } finally { f.clean(); }
});

test("compiler input discovery invalidates new included files without invalidating unrelated backend groups", async () => {
  const f = fixture();
  try {
    await runVerification(await planVerification({ ...f, full: true }, f.runtime), f.runtime);
    f.write("src/contracts/new-contract.ts", "export const revision = 1;\n");
    const receipt = await runVerification(await planVerification({ ...f, full: true }, f.runtime), f.runtime);
    assert.equal(receipt.stages.find(stage => stage.id === "build")?.reused, false);
    assert.equal(receipt.stages.find(stage => stage.id === "node-collection")?.reused, true);
    f.write("tsconfig.browser.json", JSON.stringify({ files: ["../outside.ts"] }));
    const names = f.git("ls-files", "--cached", "--others", "--exclude-standard").split("\n");
    assert.throws(() => verificationStageInputs(f.root, { id: "build", files: [] }, names), /leave the inventoried checkout/);
  } finally { f.clean(); }
});

test("unknown dynamic loaders fall back conservatively for that group", async () => {
  const f = fixture();
  try {
    f.write("src/backend/treasury.ts", "export async function load(path: string) { return import(path); }\n");
    const names = f.git("ls-files", "--cached", "--others", "--exclude-standard").split("\n");
    const inputs = verificationStageInputs(f.root, { id: "node-financial", files: ["test/treasury.test.ts"] }, names);
    assert.ok(inputs.fallbackReasons.some(reason => reason.includes("dynamic module")));
    assert.ok(inputs.files.includes("src/backend/collector.ts"));
    await runVerification(await planVerification({ ...f, full: true }, f.runtime), f.runtime);
    f.write("src/backend/collector.ts", "export const changed = true;\n");
    const next = await runVerification(await planVerification({ ...f, full: true }, f.runtime), f.runtime);
    assert.equal(next.stages.find(stage => stage.id === "node-financial")?.reused, false);
    assert.equal(next.stages.find(stage => stage.id === "browser")?.reused, true);
  } finally { f.clean(); }
});

test("ordinary documentation and link fixes stay fast while changed executable examples and policy select full coverage", async () => {
  const f = fixture();
  try {
    const before = "# Wallet\n\nA short overview of setup.\n\n## Example\n```bash\nnpm run verify\n```\n\n## Requirements\nTransfers must retain their history; see [details](old.md).\n";
    f.write("docs/WALLET_PILOT.md", before); f.git("add", "."); f.git("commit", "-qm", "generated documentation baseline");
    const base = f.git("rev-parse", "HEAD");
    for (const after of [before.replace("short overview", "clear overview"), before.replace("old.md", "fixed.md")]) {
      f.write("docs/WALLET_PILOT.md", after);
      const plan = await planVerification({ ...f, base }, f.runtime);
      assert.equal(plan.selection.documentationOnly, true);
      assert.deepEqual(plan.stages.map(stage => stage.id), ["diff"]);
    }
    for (const after of [before.replace("npm run verify", "npm run check"), before.replace("must retain", "must delete")]) {
      f.write("docs/WALLET_PILOT.md", after);
      assert.equal((await planVerification({ ...f, base }, f.runtime)).selection.full, true);
    }
  } finally { f.clean(); }
});

test("runner overlaps at most two ordinary Node groups within CPU budget and isolates build, stress and browser", async () => {
  const f = fixture();
  try {
    let active = 0, peak = 0, built = false, stressDone = false;
    const runtime: VerificationRuntime = { ...f.runtime, execute: async request => {
      await f.runtime.execute!(request);
      if (request.command.includes("scripts/build.ts")) { assert.equal(active, 0); built = true; }
      if (request.command.includes("--test")) {
        assert.equal(built, true);
        const stress = request.command.some(argument => argument.includes(".stress.test.ts"));
        if (stress) assert.equal(active, 0);
        active++; peak = Math.max(peak, active);
        const parallel = Number(request.command.find(argument => argument.startsWith("--test-concurrency="))!.split("=")[1]);
        assert.ok(active * parallel <= availableParallelism());
        await new Promise(resolve => setTimeout(resolve, 15));
        active--; if (stress) stressDone = true;
      }
      if (request.command.some(argument => argument.endsWith("/cli.js"))) { assert.equal(active, 0); assert.equal(stressDone, true); }
      return 0;
    } };
    const receipt = await runVerification(await planVerification({ ...f, full: true }, runtime), runtime);
    assert.equal(receipt.status, "checks-passed");
    assert.equal(peak, Math.min(2, availableParallelism()));
    assert.deepEqual(receipt.stages.map(stage => stage.id), receipt.plan.stages.map(stage => stage.id));
  } finally { f.clean(); }
});

test("a failed parallel Node group drains its admitted peer and prevents later groups and browser admission", async () => {
  const f = fixture();
  try {
    let active = 0;
    const runtime: VerificationRuntime = { ...f.runtime, execute: async request => {
      await f.runtime.execute!(request);
      if (!request.command.includes("--test")) return 0;
      active++;
      await new Promise(resolve => setTimeout(resolve, 15));
      active--;
      return request.command.includes("test/treasury.test.ts") ? 1 : 0;
    } };
    const receipt = await runVerification(await planVerification({ ...f, full: true }, runtime), runtime);
    assert.equal(receipt.status, "failed"); assert.equal(active, 0);
    assert.ok(receipt.stages.some(stage => stage.id === "node-financial" && stage.exitCode === 1));
    assert.ok(!receipt.stages.some(stage => ["node-collection", "node-stress", "browser"].includes(stage.id)));
    const retry = await runVerification(await planVerification({ ...f, full: true }, f.runtime), f.runtime);
    assert.equal(retry.status, "checks-passed");
    assert.equal(retry.stages.find(stage => stage.id === "node-financial")?.reused, false);
  } finally { f.clean(); }
});
