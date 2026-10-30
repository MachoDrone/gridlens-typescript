import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("updater imports preserve standalone coordinator startup in the actual CommonJS bundle format", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-coordinator-imports-")), file = join(directory, "coordinator.cjs");
  try {
    await build({ entryPoints: [resolve("src/installer/terminal-entry.ts")], bundle: true, platform: "node", target: "node24", format: "cjs", outfile: file,
      define: { GRIDLENS_RELEASE_PUBLIC_KEY: JSON.stringify("No release is downloaded by these startup probes.") }, logLevel: "silent" });
    for (const argument of ["--version", "--help"]) {
      const result = spawnSync(process.execPath, [file, argument], { cwd: directory, encoding: "utf8", timeout: 10_000, env: { PATH: "/nonexistent" } });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, argument === "--version" ? /gridlens-modern-coordinator 1 \/ Node 24\.14\.1/ : /GridLens modern coordinator/);
      assert.doesNotMatch(result.stderr, /ERR_INVALID_ARG_TYPE|fileURLToPath|Docker access/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
