import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildHandoff } from "../scripts/build-handoff.ts";

function tree(directory: string, prefix = ""): string[] {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? tree(directory, path) : [path];
  }).sort();
}
async function availablePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return address.port;
}

test("handoff is reproducible, contains only runtime files, and runs outside its checkout without dependencies", { timeout: 120_000 }, async t => {
  const temporary = mkdtempSync(join(tmpdir(), "gridlens-handoff-test-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const output = buildHandoff({ outputDirectory: join(temporary, "built") });
  const manifestBytes = readFileSync(join(output, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestBytes) as {
    format: string; files: { path: string; bytes: number; sha256: string }[];
  };
  assert.equal(manifest.format, "gridlens-nosana-handoff-v1");
  const filenames = tree(output);
  assert.deepEqual(manifest.files.map(file => file.path), filenames.filter(path => path !== "manifest.json"));
  for (const file of manifest.files) {
    const content = readFileSync(join(output, file.path));
    assert.equal(content.byteLength, file.bytes);
    assert.equal(createHash("sha256").update(content).digest("hex"), file.sha256);
    assert(!/\.(?:ts|tsx|map)$/.test(file.path) || file.path.endsWith(".d.ts"));
    assert(!/(?:^|\/)(?:test|fixtures|node_modules|\.tools|credentials|secrets)(?:\/|$)/.test(file.path));
  }
  assert(filenames.includes("scripts/hosted-server.js"));
  assert(filenames.includes("src/server/application.js"));
  assert(filenames.includes("src/server/application.d.ts"));
  assert(filenames.includes("src/contracts/fleet.js"));
  assert(filenames.includes("src/contracts/fleet.d.ts"));
  assert(filenames.includes("src/fleet/job-history.d.ts"));
  assert(filenames.includes("dist/preview/job-history.js"));
  assert(filenames.includes("INTEGRATION.md"));
  assert(filenames.includes("dist/preview/main.js"));
  assert(!filenames.includes("scripts/preview-server.js"), "public adapters must not be a hosted fallback");
  assert(!filenames.includes("scripts/solana-rpc.js"));
  assert(!filenames.includes("scripts/host-address-file.js"));
  const package_ = JSON.parse(readFileSync(join(output, "package.json"), "utf8"));
  assert.deepEqual(package_.dependencies, {});
  assert.equal(package_.devDependencies, undefined);
  assert.deepEqual(package_.scripts, { start: "node scripts/hosted-server.js" });
  for (const name of ["application", "contracts", "snapshot-source", "snapshot-store", "file-snapshot-store"]) {
    const exported = package_.exports[`./${name}`];
    assert(exported.types.endsWith(".d.ts"));
    assert(exported.import.endsWith(".js"));
    assert(existsSync(join(output, exported.types)));
    assert(existsSync(join(output, exported.import)));
  }
  const lock = JSON.parse(readFileSync(join(output, "package-lock.json"), "utf8"));
  assert.deepEqual(Object.keys(lock.packages), [""]);
  assert.deepEqual(lock.packages[""].dependencies, {});
  buildHandoff({ outputDirectory: output });
  assert.equal(readFileSync(join(output, "manifest.json"), "utf8"), manifestBytes,
    "unchanged source and pinned tools produce identical artifact hashes");

  const copied = join(temporary, "source-free-copy");
  cpSync(output, copied, { recursive: true });
  assert(!existsSync(join(copied, "node_modules")));
  const environment = { PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}` };
  // A separate consumer resolves only declarations from the copied artifact.
  // Node type definitions and the compiler are developer tools, never runtime dependencies.
  const consumer = join(temporary, "typed-consumer");
  mkdirSync(join(consumer, "node_modules"), { recursive: true });
  symlinkSync(copied, join(consumer, "node_modules", package_.name), "dir");
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(consumer, "integration.ts"), `
import type { FleetIntegration } from "${package_.name}/application";
import type { FleetSource } from "${package_.name}/snapshot-source";
import { isFleetRoster } from "${package_.name}/contracts";
import type { FleetSnapshots } from "${package_.name}/contracts";
const history: FleetSnapshots["job-history"] = { hosts: [] };
const source: FleetSource = { async read() { throw new Error("No backend configured in this type fixture."); } };
export function createIntegration(): FleetIntegration {
  return { source, resolveAccess: async () => isFleetRoster([])
    ? { scopeId: "typed-fixture", rosterRevision: "1", addresses: [] } : null };
}
`);
  const compiler = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
  const types = fileURLToPath(new URL("../node_modules/@types", import.meta.url));
  const checked = spawnSync(process.execPath, [compiler, "--noEmit", "--strict", "--module", "nodenext",
    "--target", "es2023", "--lib", "es2023,dom,dom.iterable", "--types", "node", "--typeRoots", types,
    join(consumer, "integration.ts")], { cwd: consumer, env: environment, encoding: "utf8", timeout: 15_000 });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  const unavailable = spawnSync(process.execPath, [join(copied, "scripts/hosted-server.js")], {
    cwd: temporary, env: environment, encoding: "utf8", timeout: 5_000,
  });
  assert.notEqual(unavailable.status, 0, "missing integration cannot enable public fallback");
  assert.match(unavailable.stderr, /integration/i);
  const integration = join(temporary, "fixture-integration.mjs");
  writeFileSync(integration, `
export function createIntegration() {
  return {
    resolveAccess: async request => ["allowed", "history"].includes(request.headers["x-fixture-session"])
      ? { scopeId: "isolated-fixture", rosterRevision: "1",
          addresses: request.headers["x-fixture-session"] === "history" ? ["${"1".repeat(31)}2"] : [] } : null,
    source: { read: async (resource, context) => resource === "job-history" ? {
      hosts: context.addresses.map(address => ({ address, jobs: [{
        address: "${"1".repeat(31)}3", node: address, state: "COMPLETED", result: "failed",
        timeStart: 100, timeEnd: 200, timeout: 600, checkedAtMs: 300000,
      }], totalJobs: 1, checkedAtMs: 300000, validUntilMs: 600000,
        retained: false, pending: false, retryAtMs: null, error: null })),
    } : ({ hosts: [], nextRefreshAtMs: null }) },
  };
}
`);
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  let outputText = "";
  const child = spawn(process.execPath, [join(copied, "scripts/hosted-server.js")], { cwd: temporary,
    env: { ...environment, GRIDLENS_INTEGRATION_MODULE: integration, GRIDLENS_HOST: "127.0.0.1",
      GRIDLENS_PORT: String(port), GRIDLENS_PUBLIC_ORIGIN: origin }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", chunk => { outputText += String(chunk); });
  child.stderr?.on("data", chunk => { outputText += String(chunk); });
  const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.race([exited, setTimeout(3_000, undefined, { ref: false }).then(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    })]);
  });
  let healthy = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert(child.exitCode === null && child.signalCode === null, outputText);
    try { healthy = (await fetch(`${origin}/health/live`)).ok; } catch { /* Child still starting. */ }
    if (healthy) break;
    await setTimeout(30);
  }
  assert(healthy, outputText);
  assert.equal((await fetch(`${origin}/health/ready`)).status, 200);
  assert([401, 403].includes((await fetch(`${origin}/api/fleet/hosts.json`)).status));
  const headers = { "x-fixture-session": "allowed" };
  assert.equal((await fetch(`${origin}/`, { headers })).status, 200);
  assert.equal((await fetch(`${origin}/preview/main.js`, { headers })).status, 200);
  assert.equal((await fetch(`${origin}/preview/job-history.js`, { headers })).status, 200);
  const hosts = await fetch(`${origin}/api/fleet/hosts.json`, { headers });
  assert.equal(hosts.status, 200);
  assert.deepEqual((await hosts.json() as { addresses: string[] }).addresses, []);
  for (const resource of ["metadata", "node-info", "jobs", "queue", "sol", "nos", "staking"]) {
    const response = await fetch(`${origin}/api/fleet/${resource}.json`, { headers });
    assert.equal(response.status, 200, resource);
    assert.deepEqual((await response.json() as { hosts: unknown[] }).hosts, []);
  }
  const history = await fetch(`${origin}/api/fleet/job-history.json?host=${"1".repeat(31)}2`, {
    headers: { "x-fixture-session": "history" },
  });
  assert.equal(history.status, 200);
  const record = (await history.json()).hosts[0];
  assert.equal(record.jobs[0].state, "COMPLETED");
  assert.equal(record.jobs[0].result, "failed");
  assert.equal(record.checkedAtMs, 300000, "copied runtime preserves historical source dates");
  child.kill("SIGTERM");
  assert.equal(await exited, 0, outputText);
  const installed = spawnSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], {
    cwd: copied, env: environment, encoding: "utf8", timeout: 15_000,
  });
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  assert(!existsSync(join(copied, "node_modules/typescript")));
  assert(!existsSync(join(copied, "node_modules/@solana")));
});

test("handoff refuses to replace unrelated data or the source checkout", () => {
  const temporary = mkdtempSync(join(tmpdir(), "gridlens-handoff-protection-"));
  try {
    writeFileSync(join(temporary, "keep.txt"), "unchanged");
    assert.throws(() => buildHandoff({ outputDirectory: temporary }), /without a GridLens handoff manifest/);
    assert.equal(readFileSync(join(temporary, "keep.txt"), "utf8"), "unchanged");
    assert.throws(() => buildHandoff({ outputDirectory: new URL("../", import.meta.url).pathname }), /repository/);
  } finally { rmSync(temporary, { recursive: true }); }
});
