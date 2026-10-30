import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { localDockerRunner, DockerCommandError, MAINTENANCE_LOCK_BUSY, MAINTENANCE_LOCK_BUSY_EXIT } from "../src/installer/docker.ts";
import { maintenanceLockFailure } from "../src/updater/deployment.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";

test("a lock helper dying after READY fences later Docker mutations", async t => {
  const directory = mkdtempSync(join(tmpdir(), "gridlens-lock-loss-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pidFile = join(directory, "pid");
  writeFileSync(join(directory, "docker"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.GRIDLENS_LOCK_FIXTURE_PID,String(process.pid));process.stdout.write('GRIDLENS_LOCK_READY\\n');process.stdin.resume();\n`, { mode: 0o700 });
  let mutations = 0;
  const runner = localDockerRunner({ allowSudo: false, environment: { PATH: directory, GRIDLENS_LOCK_FIXTURE_PID: pidFile },
    execute: (_command, args) => { if (args[0] !== "container") mutations++;
      return { pid: 1, output: [], stdout: JSON.stringify([{ Id: "fixture-lock", State: { Running: true } }]), stderr: "", status: 0, signal: null }; } });
  const release = await runner.hold!(["run", "--name", "gridlens-modern-fixture-maintenance-aaaaaaaaaaaaaaaa"]);
  const pid = Number(readFileSync(pidFile, "utf8")); assert.ok(Number.isSafeInteger(pid)); process.kill(pid, "SIGTERM");
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.throws(() => runner.run(["stop", "gridlens-modern-fixture-owner"]), /lock was lost/);
  assert.equal(mutations, 0); await release();
});
test("kernel maintenance lock rejects a second holder and releases after process termination", async t => {
  const directory = mkdtempSync(join(tmpdir(), "gridlens-lock-kernel-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const module = new URL("../src/updater/deployment.ts", import.meta.url).href, file = join(directory, "lock.sqlite");
  const launch = () => spawn(process.execPath, ["--input-type=module", "-e", `import { holdMaintenanceLock, maintenanceLockFailure } from ${JSON.stringify(module)};
    try { await holdMaintenanceLock(${JSON.stringify(file)}); } catch(error) { const failure=maintenanceLockFailure(error); process.stderr.write(failure.message); process.exitCode=failure.exitCode; }`], { stdio: ["pipe", "pipe", "pipe"] });
  const first = launch(); t.after(() => { first.kill("SIGTERM"); }); await once(first.stdout, "data");
  const second = launch(); let detail = ""; second.stderr.on("data", chunk => { detail += chunk.toString(); });
  const [code] = await once(second, "close"); assert.equal(code, MAINTENANCE_LOCK_BUSY_EXIT); assert.match(detail, /GRIDLENS_LOCK_BUSY/);
  first.kill("SIGKILL"); await once(first, "exit");
  const third = launch(); t.after(() => { third.kill("SIGTERM"); });
  const [ready] = await once(third.stdout, "data"); assert.match(ready.toString(), /GRIDLENS_LOCK_READY/);
  third.stdin.end(); const [last] = await once(third, "exit"); assert.equal(last, 0);
});

test("a failed Docker lock helper preserves its real cause without claiming another installation", async t => {
  const directory = mkdtempSync(join(tmpdir(), "gridlens-lock-start-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "docker"), `#!${process.execPath}\nprocess.stderr.write('Unable to find image locally; Docker access denied.\\nAuthorization: Bearer generated-token\\nhttps://example.invalid/image?token=generated-query\\n');process.exitCode=125;\n`, { mode: 0o700 });
  const runner = localDockerRunner({ allowSudo: false, environment: { PATH: directory } });
  await assert.rejects(runner.hold!(["run", "--name", "gridlens-modern-fixture-maintenance-aaaaaaaaaaaaaaaa"]), error => {
    assert(error instanceof DockerCommandError); assert.equal(error.kind, "exit"); assert.equal(error.exitCode, 125);
    assert.match(error.message, /Unable to find image locally; Docker access denied/);
    assert.doesNotMatch(error.message, /Another installation|generated-token|generated-query|example\.invalid/);
    return true;
  });
});

test("only an explicit busy marker with its matching exit status is reported as lock contention", async t => {
  const directory = mkdtempSync(join(tmpdir(), "gridlens-lock-busy-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [code, message, busy] of [[75, MAINTENANCE_LOCK_BUSY + "\n", true], [125, MAINTENANCE_LOCK_BUSY + "\n", false], [75, "Other helper failure\n", false]] as const) {
    writeFileSync(join(directory, "docker"), `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(message)});process.exitCode=${code};\n`, { mode: 0o700 });
    const runner = localDockerRunner({ allowSudo: false, environment: { PATH: directory } });
    await assert.rejects(runner.hold!(["run", "--name", "gridlens-modern-fixture-maintenance-aaaaaaaaaaaaaaaa"]), error => {
      assert(error instanceof Error);
      if (busy) { assert.match(error.message, /Another installation or update is running/); assert(!(error instanceof DockerCommandError)); }
      else { assert(error instanceof DockerCommandError); assert.doesNotMatch(error.message, /Another installation/); }
      return true;
    });
  }
});

test("lock helper diagnostics stay bounded and redact secrets cut by the output limit", async t => {
  const directory = mkdtempSync(join(tmpdir(), "gridlens-lock-output-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "docker"), `#!${process.execPath}\nprocess.stderr.write('{"token":"'+'generated-secret-fragment-'.repeat(4000));setTimeout(()=>{},1000);\n`, { mode: 0o700 });
  const runner = localDockerRunner({ allowSudo: false, environment: { PATH: directory } });
  await assert.rejects(runner.hold!(["run", "--name", "gridlens-modern-fixture-maintenance-aaaaaaaaaaaaaaaa"]), error => {
    assert(error instanceof DockerCommandError); assert.equal(error.kind, "output-limit");
    assert(error.message.length < 4500); assert.doesNotMatch(error.message, /generated-secret|Another installation/); return true;
  });
});

test("SQLite busy is distinct from permission, read-only and open failures in the helper protocol", () => {
  for (const errcode of [5, 6, 261, 262, 517]) {
    const failure = maintenanceLockFailure(Object.assign(new Error("private message"), { code: "ERR_SQLITE_ERROR", errcode }));
    assert.deepEqual(failure, { exitCode: MAINTENANCE_LOCK_BUSY_EXIT, message: MAINTENANCE_LOCK_BUSY });
  }
  for (const error of [Object.assign(new Error("private filesystem path"), { code: "EACCES" }),
    Object.assign(new Error("private message"), { code: "ERR_SQLITE_ERROR", errcode: 8 }),
    Object.assign(new Error("private message"), { code: "ERR_SQLITE_ERROR", errcode: 14 }),
    Object.assign(new Error("private message"), { code: "EACCES", errcode: 5 })]) {
    const failure = maintenanceLockFailure(error); assert.equal(failure.exitCode, 1);
    assert.match(failure.message, /Installation lock helper failed/); assert.doesNotMatch(failure.message, /GRIDLENS_LOCK_BUSY|private/);
  }
});
