import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { localDockerRunner } from "../src/installer/docker.ts";
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
  const launch = () => spawn(process.execPath, ["--input-type=module", "-e", `import { holdMaintenanceLock } from ${JSON.stringify(module)}; await holdMaintenanceLock(${JSON.stringify(file)});`], { stdio: ["pipe", "pipe", "ignore"] });
  const first = launch(); t.after(() => { first.kill("SIGTERM"); }); await once(first.stdout, "data");
  const second = launch(); const [code] = await once(second, "exit"); assert.notEqual(code, 0);
  first.kill("SIGKILL"); await once(first, "exit");
  const third = launch(); t.after(() => { third.kill("SIGTERM"); });
  const [ready] = await once(third.stdout, "data"); assert.match(ready.toString(), /GRIDLENS_LOCK_READY/);
  third.stdin.end(); const [last] = await once(third, "exit"); assert.equal(last, 0);
});
