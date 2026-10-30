import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { previewPort, startPreviewServer } from "../scripts/preview-server.ts";
import type { JobProvider } from "../scripts/jobs.ts";
import { blankJobHistoryRecord } from "../src/fleet/job-history.ts";
import type { NodeInfoSnapshot } from "../src/fleet/node-info.ts";
import { projectNodeApi } from "../src/fleet/node-api.ts";
import { NOS_MINT, NOS_REFRESH_INTERVAL_MS } from "../src/fleet/nos.ts";
import { emptyNos } from "./fixtures/nos.ts";
import { emptySol } from "./fixtures/sol.ts";
import { emptyStaking } from "./fixtures/staking.ts";
import { blankStakingRecord, STAKING_REFRESH_INTERVAL_MS } from "../src/fleet/staking.ts";

const fixtureFiles = [
  "contracts/fleet.js", "contracts/shared.js", "contracts/updates.js", "contracts/online-hosts.js", "fleet/pc-observations.js", "preview/shared-telemetry.js", "preview/updates.js", "preview/fleet-config.js", "preview/fleet-transport.js", "preview/job-history.js", "preview/online-roster.js",
  "preview/evidence-clock.js", "preview/refresh-deadline.js", "preview/sidebar.js", "preview/viewport.js", "preview/table-scroll.js", "preview/connection.js",
  "index.html", "styles.css", "preview/main.js", "preview/fixtures.js", "fleet/freshness.js", "fleet/sort.js", "fleet/ip-display.js", "fleet/duration.js", "fleet/market-display.js", "fleet/hardware-display.js", "fleet/host-metadata.js",
  "fleet/node-info.js", "fleet/node-state.js", "fleet/node-api.js", "fleet/status-display.js", "fleet/country-display.js", "preview/state-refresh.js", "preview/info-content.js", "preview/column-help.js",
  "fleet/jobs.js", "fleet/job-history.js", "fleet/live-duration.js", "fleet/live-activity.js", "fleet/queue.js", "fleet/queued-duration.js", "fleet/sol.js", "fleet/nos.js", "fleet/staking.js", "fleet/staking-view.js",
];

const addresses = Array.from({ length: 8 }, (_, index) => `${"1".repeat(31)}${index + 2}`);

/** Source-contract assertions exclude the server-owned transmission clock. */
function parseSnapshot(body: string) {
  const value = JSON.parse(body);
  if (value.serverTimeMs !== undefined) {
    assert(Number.isSafeInteger(value.serverTimeMs) && value.serverTimeMs >= 0);
    delete value.serverTimeMs;
  }
  return value;
}

function fixtureDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "gridlens-preview-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const filename of fixtureFiles) {
    const path = join(directory, filename);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `fixture: ${filename}\n`);
  }
  // These must never be served even though present beside the allowed build.
  writeFileSync(join(directory, "private.txt"), "not a preview asset");
  writeFileSync(join(directory, "package.json"), "{}");
  writeFileSync(join(directory, "hosts.json"), JSON.stringify(addresses));
  return directory;
}

function close(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((accept, reject) => {
    server.close((error) => error ? reject(error) : accept());
    server.closeAllConnections();
  });
}

async function runningServer(t: TestContext, directory = fixtureDirectory(t)): Promise<Server> {
  const server = await startPreviewServer({ directory, hostsFile: join(directory, "hosts.json"), port: 0 });
  t.after(() => close(server));
  return server;
}

function read(server: Server, path: string, method = "GET", headers: Record<string, string> = {}): Promise<{
  status: number | undefined; headers: IncomingHttpHeaders; body: string;
}> {
  const address = server.address();
  assert(address && typeof address !== "string");
  return new Promise((accept, reject) => {
    const outgoing = request({ hostname: "127.0.0.1", port: address.port, path, method, headers }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("error", reject);
      incoming.on("end", () => accept({
        status: incoming.statusCode,
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

test("history requests only selected startup hosts and rejects invalid selectors before collection", async t => {
  const directory = fixtureDirectory(t);
  const real200HostsFile = join(directory, "real200.json");
  writeFileSync(real200HostsFile, JSON.stringify([addresses[1]]));
  const calls: { addresses: readonly string[]; refresh: boolean | undefined }[] = [];
  const provider: JobProvider = async () => { throw new Error("History must not request assignments."); };
  provider.history = async (selected, _signal, onUpdate, refresh) => {
    calls.push({ addresses: [...selected], refresh });
    const snapshot = { hosts: selected.map(blankJobHistoryRecord) };
    onUpdate?.(snapshot);
    return snapshot;
  };
  const server = await startPreviewServer({ directory, hostsFile: join(directory, "hosts.json"),
    real200HostsFile, jobProvider: provider, port: 0 });
  t.after(() => close(server));
  for (const query of ["", "?host=foreign", `?host=${addresses[0]}&host=${addresses[0]}`,
    `?host=${addresses[0]}&file=private.txt`, `?host=${addresses[0]}&refresh=0`,
    `?host=${addresses[0]}&scenario=real200`]) {
    assert.equal((await read(server, `/preview/job-history.json${query}`)).status, 400);
  }
  assert.equal(calls.length, 0);
  const path = `/preview/job-history.json?host=${addresses[1]}&scenario=real200&refresh=1`;
  assert.equal((await read(server, path, "HEAD")).status, 200);
  assert.equal(calls.length, 0);
  const result = await read(server, path, "GET", { Accept: "application/x-ndjson" });
  assert.equal(result.status, 200);
  const frames = result.body.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(frames.at(-1).complete, true);
  for (const frame of frames) assert.deepEqual(frame.hosts.map((row: { address: string }) => row.address), [addresses[1]]);
  assert.deepEqual(calls, [{ addresses: [addresses[1]], refresh: true }]);
});

test("preview serves exactly the fixture assets on loopback with fixed types and no caching", async (t) => {
  const server = await runningServer(t);
  const address = server.address();
  assert(address && typeof address !== "string");
  assert.equal(address.address, "127.0.0.1");
  for (const filename of fixtureFiles) {
    const result = await read(server, `/${filename}`);
    assert.equal(result.status, 200);
    assert.equal(result.body, `fixture: ${filename}\n`);
    const expected = filename.endsWith(".html") ? "text/html" :
      filename.endsWith(".css") ? "text/css" : "text/javascript";
    assert.equal(result.headers["content-type"], `${expected}; charset=utf-8`);
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(result.headers["x-content-type-options"], "nosniff");
    assert.equal(Number(result.headers["content-length"]), Buffer.byteLength(result.body));
  }
  assert.equal((await read(server, "/?example=fixture")).body, "fixture: index.html\n");
});

test("HEAD returns the same asset length without sending its body", async (t) => {
  const server = await runningServer(t);
  const result = await read(server, "/", "HEAD");
  assert.equal(result.status, 200);
  assert.equal(result.body, "");
  assert.equal(Number(result.headers["content-length"]), Buffer.byteLength("fixture: index.html\n"));
  assert.equal((await read(server, "/missing", "HEAD")).status, 404);
});

test("connection checks stay independent of missing, invalid, empty and populated rosters without provider work", async t => {
  for (const contents of [undefined, "invalid JSON", "[]", JSON.stringify(addresses)]) {
    const directory = fixtureDirectory(t);
    const hostsFile = join(directory, "hosts.json");
    if (contents === undefined) rmSync(hostsFile);
    else writeFileSync(hostsFile, contents);
    let calls = 0;
    const unexpectedRead = async (): Promise<never> => {
      calls++;
      throw new Error("Connection checks must not dispatch provider reads.");
    };
    const server = await startPreviewServer({
      directory, hostsFile, real200HostsFile: hostsFile, port: 0,
      metadataProvider: unexpectedRead, nodeInfoProvider: unexpectedRead,
      jobProvider: unexpectedRead, queueProvider: unexpectedRead,
      solProvider: unexpectedRead, nosProvider: unexpectedRead, stakingProvider: unexpectedRead,
    });
    t.after(() => close(server));
    for (const query of ["", "?scenario=real200", "?scenario=invalid", "?scenario=supplied&scenario=real200", "?file=private.txt"]) {
      const path = `/preview/connection.json${query}`;
      const result = await read(server, path);
      assert.equal(result.status, 200);
      assert.deepEqual(JSON.parse(result.body), { status: "ok" });
      assert.equal(result.headers["content-type"], "application/json; charset=utf-8");
      assert.equal(result.headers["cache-control"], "no-store");
      assert.equal(result.headers["x-content-type-options"], "nosniff");
      assert.equal(Number(result.headers["content-length"]), Buffer.byteLength(result.body));
      const head = await read(server, path, "HEAD");
      assert.equal(head.status, result.status);
      assert.equal(head.body, "");
      for (const header of ["content-type", "content-length", "cache-control", "x-content-type-options"]) {
        assert.equal(head.headers[header], result.headers[header]);
      }
    }
    assert.equal(calls, 0);
    await close(server);
  }
});

test("preview rejects traversal, source files, arbitrary files and API paths", async (t) => {
  const server = await runningServer(t);
  for (const path of [
    "/../index.html", "/preview/../index.html", "/%2e%2e/index.html", "/%69ndex.html",
    "//index.html", "/private.txt", "/package.json", "/src/preview/main.ts",
    "/api/fleet", "/preview", "/fleet/freshness.js/extra", "/__proto__", "/hosts.json",
    "/preview/host-address-file.ts", "/preview/hosts.json/extra", "/preview/%68osts.json",
    "/preview/node-info.ts", "/preview/node-info.json/extra", "/preview/%6eode-info.json",
    "/preview/jobs.ts", "/preview/jobs.json/extra", "/preview/%6aobs.json",
    "/preview/sol.ts", "/preview/sol.json/extra", "/preview/%73ol.json",
    "/preview/staking.ts", "/preview/staking.json/extra", "/preview/%73taking.json",
    "/preview/nos.ts", "/preview/nos.json/extra", "/preview/%6eos.json",
    "/preview/queue.ts", "/preview/queue.json/extra", "/preview/%71ueue.json",
    "/preview/connection.json/extra", "/preview/connection.json/", "/preview/%63onnection.json",
    "/preview/../preview/connection.json", "//preview/connection.json", "/preview/Connection.json",
  ]) {
    const result = await read(server, path);
    assert.equal(result.status, 404, path);
    assert.equal(result.body, "Not found\n", path);
  }
});

test("preview supports only GET and HEAD", async (t) => {
  const server = await runningServer(t);
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
    const result = await read(server, "/", method);
    assert.equal(result.status, 405, method);
    assert.equal(result.headers.allow, "GET, HEAD");
    assert.equal((await read(server, "/preview/hosts.json", method)).status, 405, method);
    const connection = await read(server, "/preview/connection.json", method);
    assert.equal(connection.status, 405, method);
    assert.equal(connection.headers.allow, "GET, HEAD");
  }
});

test("missing or incomplete builds fail before listening", async (t) => {
  const directory = fixtureDirectory(t);
  const hostsFile = join(directory, "hosts.json");
  await assert.rejects(startPreviewServer({ directory: join(directory, "absent"), hostsFile, port: 0 }), /npm run build/);
  rmSync(join(directory, "preview/fixtures.js"));
  await assert.rejects(startPreviewServer({ directory, hostsFile, port: 0 }), /npm run build/);
});

test("occupied preview ports fail without selecting another port", async (t) => {
  const server = await runningServer(t);
  const address = server.address();
  assert(address && typeof address !== "string");
  const directory = fixtureDirectory(t);
  await assert.rejects(startPreviewServer({ directory, hostsFile: join(directory, "hosts.json"), port: address.port }), {
    code: "EADDRINUSE",
  });
});

test("preview port validation rejects invalid arguments and invalid programmatic ports", async (t) => {
  const directory = fixtureDirectory(t);
  assert.equal(previewPort([]), 4173);
  assert.equal(previewPort(["--port", "4567"]), 4567);
  for (const arguments_ of [
    ["--port"], ["--host", "0.0.0.0"], ["--port", "0"], ["--port", "65536"],
    ["--port", "4.5"], ["--port", "-1"], ["--port", "4173junk"], ["--port", "NaN"],
    ["--port", "4173", "extra"],
  ]) assert.throws(() => previewPort(arguments_));
  for (const port of [-1, 65536, 4.5, NaN, Infinity]) {
    await assert.rejects(startPreviewServer({ port, hostsFile: join(directory, "hosts.json") }), /Preview port/);
  }
});

test("supplied addresses are served in file order with no cache and no file selection", async (t) => {
  const server = await runningServer(t);
  const result = await read(server, "/preview/hosts.json?file=private.txt");
  assert.equal(result.status, 200);
  assert.equal(result.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(result.headers["x-content-type-options"], "nosniff");
  assert.deepEqual(parseSnapshot(result.body), { addresses, error: null });
  const head = await read(server, "/preview/hosts.json", "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
  assert.equal(Number(head.headers["content-length"]), Buffer.byteLength(result.body));
});

test("input stays a startup snapshot until an explicit server restart", async (t) => {
  const directory = fixtureDirectory(t);
  const server = await runningServer(t, directory);
  writeFileSync(join(directory, "hosts.json"), JSON.stringify([addresses[2], addresses[0]]));
  assert.deepEqual(parseSnapshot((await read(server, "/preview/hosts.json")).body), { addresses, error: null });
  await close(server);
  const restarted = await runningServer(t, directory);
  assert.deepEqual(parseSnapshot((await read(restarted, "/preview/hosts.json")).body), {
    addresses: [addresses[2], addresses[0]], error: null,
  });
});

test("missing or invalid input reports failure without changing files or losing synthetic assets", async (t) => {
  const directory = fixtureDirectory(t);
  const hostsFile = join(directory, "absent", "hosts.json");
  const errors: string[] = [];
  const before = readdirSync(directory);
  const missing = await startPreviewServer({ directory, hostsFile, port: 0, onHostsInputError: (error) => errors.push(error) });
  t.after(() => close(missing));
  const response = await read(missing, "/preview/hosts.json");
  assert.equal(response.status, 503);
  const payload = parseSnapshot(response.body) as { addresses: unknown[]; error: string };
  assert.deepEqual(payload.addresses, []);
  assert.match(payload.error, /Host Address file .*Input is missing \(ENOENT\).*restart/);
  assert.deepEqual(errors, [payload.error]);
  assert.equal(existsSync(join(directory, "absent")), false);
  assert.deepEqual(readdirSync(directory), before);
  assert.equal((await read(missing, "/")).status, 200);
  assert.equal((await read(missing, "/preview/fixtures.js")).status, 200);

  const invalidFile = join(directory, "hosts.json");
  const invalidContents = JSON.stringify([addresses[0], "invalid"]);
  writeFileSync(invalidFile, invalidContents);
  const invalid = await runningServer(t, directory);
  const invalidResponse = await read(invalid, "/preview/hosts.json");
  assert.equal(invalidResponse.status, 503);
  assert.deepEqual(parseSnapshot(invalidResponse.body).addresses, []);
  assert.match(parseSnapshot(invalidResponse.body).error, /Entry 2/);
  assert.equal(readFileSync(invalidFile, "utf8"), invalidContents);
  assert.deepEqual(readdirSync(directory), before);
});

test("restarting and reading preserve supplied input and separate backup hashes", async (t) => {
  const directory = fixtureDirectory(t);
  const hostsFile = join(directory, "hosts.json");
  const backupFile = join(directory, "hosts.json.backup");
  writeFileSync(backupFile, readFileSync(hostsFile));
  const digest = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
  const before = [digest(hostsFile), digest(backupFile)];
  for (let restart = 0; restart < 2; restart++) {
    const server = await runningServer(t, directory);
    assert.deepEqual(parseSnapshot((await read(server, "/preview/hosts.json")).body), { addresses, error: null });
    assert.equal((await read(server, "/hosts.json.backup")).status, 404);
    await close(server);
    assert.deepEqual([digest(hostsFile), digest(backupFile)], before);
  }
});

test("an intentionally empty supplied array is successful with zero addresses", async (t) => {
  const directory = fixtureDirectory(t);
  writeFileSync(join(directory, "hosts.json"), "[]\n");
  const server = await runningServer(t, directory);
  const result = await read(server, "/preview/hosts.json");
  assert.equal(result.status, 200);
  assert.deepEqual(parseSnapshot(result.body), { addresses: [], error: null });
});

test("Real200 uses a separate immutable startup list without replacing supplied hosts or accepting arbitrary scenario inputs", async t => {
  const directory = fixtureDirectory(t);
  const real200HostsFile = join(directory, "real200.json");
  const realAddresses = [addresses[3], addresses[1]];
  writeFileSync(real200HostsFile, JSON.stringify(realAddresses));
  const server = await startPreviewServer({ directory, hostsFile: join(directory, "hosts.json"), real200HostsFile, port: 0 });
  t.after(() => close(server));
  writeFileSync(real200HostsFile, JSON.stringify([addresses[0]]));
  assert.deepEqual(parseSnapshot((await read(server, "/preview/hosts.json")).body), { addresses, error: null });
  const selected = await read(server, "/preview/hosts.json?scenario=real200&file=hosts.json&address=untrusted");
  assert.equal(selected.status, 200);
  assert.deepEqual(parseSnapshot(selected.body), { addresses: realAddresses, error: null });
  assert.equal((await read(server, "/real200.json")).status, 404);
  for (const query of ["scenario=unknown", "scenario=real200&scenario=supplied", "scenario=../../hosts.json"]) {
    assert.equal((await read(server, `/preview/hosts.json?${query}`)).status, 400);
    assert.equal((await read(server, `/preview/sol.json?${query}`)).status, 400);
    assert.equal((await read(server, `/preview/nos.json?${query}`)).status, 400);
    assert.equal((await read(server, `/preview/staking.json?${query}`)).status, 400);
  }
});

test("missing or invalid Real200 stays unavailable without substituting the supplied roster", async t => {
  const directory = fixtureDirectory(t);
  const real200HostsFile = join(directory, "real200.json");
  let calls = 0;
  for (const contents of [null, "invalid", "[]"]) {
    if (contents !== null) writeFileSync(real200HostsFile, contents);
    const server = await startPreviewServer({ directory, hostsFile: join(directory, "hosts.json"), real200HostsFile, port: 0,
      solProvider: async () => { calls++; return { hosts: [], nextRefreshAtMs: null }; },
      nosProvider: async () => { calls++; return { hosts: [], nextRefreshAtMs: null }; } });
    t.after(() => close(server));
    assert.equal((await read(server, "/preview/hosts.json")).status, 200);
    const selected = await read(server, "/preview/hosts.json?scenario=real200");
    assert.equal(selected.status, contents === "[]" ? 200 : 503);
    assert.deepEqual(parseSnapshot(selected.body).addresses, []);
    if (contents !== "[]") assert.match(parseSnapshot(selected.body).error, /Host Address file/);
    const data = await read(server, "/preview/sol.json?scenario=real200");
    assert.equal(data.status, selected.status);
    assert.deepEqual(parseSnapshot(data.body), { hosts: [], nextRefreshAtMs: null });
    const nos = await read(server, "/preview/nos.json?scenario=real200");
    assert.equal(nos.status, selected.status);
    assert.deepEqual(parseSnapshot(nos.body), { hosts: [], nextRefreshAtMs: null });
    assert.equal((await read(server, "/preview/hosts.json?scenario=real200", "HEAD")).status, selected.status);
    await close(server);
  }
  const isolated = await runningServer(t, directory);
  const unconfigured = await read(isolated, "/preview/hosts.json?scenario=real200");
  assert.equal(unconfigured.status, 503);
  assert.match(parseSnapshot(unconfigured.body).error, /Real200.*not configured/);
  assert.equal(calls, 0);
});

for (const [route, providerName] of [
  ["metadata", "metadataProvider"], ["node-info", "nodeInfoProvider"],
  ["jobs", "jobProvider"], ["queue", "queueProvider"], ["sol", "solProvider"], ["nos", "nosProvider"], ["staking", "stakingProvider"],
] as const) {
  test(`${route}: concurrent fixed rosters stay separate and inactive scenarios dispatch no work`, async t => {
    const directory = fixtureDirectory(t);
    const real200HostsFile = join(directory, "real200.json");
    const realAddresses = [addresses[3]!, addresses[1]!];
    writeFileSync(real200HostsFile, JSON.stringify(realAddresses));
    const calls: { addresses: readonly string[]; release: () => void }[] = [];
    const provider = async (input: readonly string[]) => {
      await new Promise<void>(resolve => { calls.push({ addresses: [...input], release: resolve }); });
      return { hosts: [], nextRefreshAtMs: null };
    };
    const server = await startPreviewServer({ directory, hostsFile: join(directory, "hosts.json"), real200HostsFile, port: 0,
      [providerName]: provider });
    t.after(() => close(server));
    await read(server, "/preview/hosts.json?scenario=real200");
    await read(server, `/preview/${route}.json?scenario=real200`, "HEAD");
    assert.equal(calls.length, 0);
    const supplied = read(server, `/preview/${route}.json`);
    await until(() => calls.length === 1);
    assert.deepEqual(calls[0]!.addresses, addresses);
    const real = read(server, `/preview/${route}.json?scenario=real200&address=untrusted&file=hosts.json`);
    const duplicate = read(server, `/preview/${route}.json?scenario=real200`);
    await until(() => calls.length === 2);
    await read(server, "/preview/hosts.json");
    assert.deepEqual(calls[1]!.addresses, realAddresses);
    for (const call of calls) call.release();
    for (const result of await Promise.all([supplied, real, duplicate])) assert.equal(result.status, 200);
    assert.equal(calls.length, 2);
  });
}

test("Real200 queue dependencies use the Real200 metadata roster and keep it alive after a direct viewer leaves", async t => {
  const directory = fixtureDirectory(t);
  const real200HostsFile = join(directory, "real200.json");
  const realAddresses = [addresses[3]!, addresses[1]!];
  writeFileSync(real200HostsFile, JSON.stringify(realAddresses));
  const calls: { addresses: readonly string[]; signal: AbortSignal; release: () => void }[] = [];
  const server = await startPreviewServer({ directory, hostsFile: join(directory, "hosts.json"), real200HostsFile, port: 0,
    metadataProvider: async (input, signal) => {
      assert(signal);
      await new Promise<void>(resolve => { calls.push({ addresses: [...input], signal, release: resolve }); });
      return { hosts: input.map(address => ({ address, values: null, fetchedAtMs: null, retained: false, error: null, marketError: null })) };
    } });
  t.after(() => close(server));
  const direct = cancellableRead(server, "/preview/metadata.json?scenario=real200");
  await until(() => calls.length === 1);
  const queue = cancellableRead(server, "/preview/queue.json?scenario=real200");
  await read(server, "/preview/hosts.json");
  direct.outgoing.destroy();
  await direct.result;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.addresses, realAddresses);
  assert.equal(calls[0]!.signal.aborted, false);
  calls[0]!.release();
  const snapshot = parseSnapshot(await queue.result);
  assert.deepEqual(snapshot.hosts.map((row: { address: string }) => row.address), realAddresses);
});

test("metadata requests use only the startup addresses, deduplicate overlaps, and ignore request parameters", async (t) => {
  const directory = fixtureDirectory(t);
  const recordedCalls: (readonly string[])[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const snapshot = { hosts: addresses.map(address => ({
    address, values: null, fetchedAtMs: null, retained: false, error: "Isolated fixture", marketError: null,
  })) };
  const server = await startPreviewServer({
    directory, hostsFile: join(directory, "hosts.json"), port: 0,
    metadataProvider: async input => {
      recordedCalls.push([...input]);
      await pending;
      return snapshot;
    },
  });
  t.after(() => close(server));
  assert.equal((await read(server, "/")).status, 200);
  assert.equal((await read(server, "/preview/metadata.json", "HEAD")).status, 200);
  assert.equal((await read(server, "/preview/metadata.json", "POST")).status, 405);
  assert.equal(recordedCalls.length, 0);
  writeFileSync(join(directory, "hosts.json"), JSON.stringify([addresses[1]]));
  const first = read(server, "/preview/metadata.json?address=untrusted&file=private.txt");
  const second = read(server, "/preview/metadata.json");
  // A local HTTP round-trip lets both earlier requests enter the pending provider.
  await read(server, "/preview/hosts.json");
  assert.deepEqual(recordedCalls, [addresses]);
  release();
  for (const result of await Promise.all([first, second])) {
    assert.equal(result.status, 200);
    assert.deepEqual(parseSnapshot(result.body), snapshot);
    assert.equal(result.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(Number(result.headers["content-length"]), Buffer.byteLength(result.body));
  }
  assert.equal(recordedCalls.length, 1);
});

test("empty, invalid and missing input never call the metadata provider", async (t) => {
  const directory = fixtureDirectory(t);
  const hostsFile = join(directory, "hosts.json");
  let calls = 0;
  for (const contents of ["[]", "invalid", null]) {
    if (contents === null) rmSync(hostsFile);
    else writeFileSync(hostsFile, contents);
    const server = await startPreviewServer({
      directory, hostsFile, port: 0,
      metadataProvider: async () => { calls++; throw new Error("must not be called"); },
    });
    t.after(() => close(server));
    const result = await read(server, "/preview/metadata.json");
    assert.equal(result.status, contents === "[]" ? 200 : 503);
    assert.deepEqual(parseSnapshot(result.body), { hosts: [] });
    assert.equal((await read(server, "/preview/metadata.json", "HEAD")).status, result.status);
    await close(server);
  }
  assert.equal(calls, 0);
});

test("unexpected metadata provider failures return bounded per-host diagnostics without raw errors", async (t) => {
  const directory = fixtureDirectory(t);
  const server = await startPreviewServer({
    directory, hostsFile: join(directory, "hosts.json"), port: 0,
    metadataProvider: async () => { throw new Error("untrusted provider detail"); },
  });
  t.after(() => close(server));
  const result = await read(server, "/preview/metadata.json");
  assert.equal(result.status, 502);
  assert(!result.body.includes("untrusted provider detail"));
  assert.deepEqual(parseSnapshot(result.body), { hosts: addresses.map(address => ({
    address, values: null, fetchedAtMs: null, retained: false,
    error: "The preview could not load Nosana metadata.", marketError: null,
  })) });
});

test("Node Info reads only startup addresses, deduplicates overlaps and ignores URL input", async (t) => {
  const directory = fixtureDirectory(t);
  const calls: (readonly string[])[] = [];
  let metadataCalls = 0;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const snapshot = { hosts: addresses.map(address => ({
    address, values: null, fetchedAtMs: null, validUntilMs: null, retained: false, error: "Isolated fixture",
  })) };
  const server = await startPreviewServer({
    directory, hostsFile: join(directory, "hosts.json"), port: 0,
    nodeInfoProvider: async input => {
      calls.push([...input]);
      await pending;
      return snapshot;
    },
    metadataProvider: async () => { metadataCalls++; return { hosts: [] }; },
  });
  t.after(() => close(server));
  assert.equal((await read(server, "/")).status, 200);
  assert.equal((await read(server, "/preview/node-info.json", "HEAD")).status, 200);
  assert.equal((await read(server, "/preview/node-info.json", "POST")).status, 405);
  assert.equal(calls.length, 0);
  writeFileSync(join(directory, "hosts.json"), JSON.stringify([addresses[1]]));
  const first = read(server, "/preview/node-info.json?address=untrusted&file=private.txt");
  const second = read(server, "/preview/node-info.json");
  await read(server, "/preview/hosts.json");
  assert.deepEqual(calls, [addresses]);
  release();
  for (const result of await Promise.all([first, second])) {
    assert.equal(result.status, 200);
    assert.deepEqual(parseSnapshot(result.body), snapshot);
    assert.equal(result.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(result.headers["x-content-type-options"], "nosniff");
    assert.equal(Number(result.headers["content-length"]), Buffer.byteLength(result.body));
  }
  assert.equal(calls.length, 1);
  assert.equal(metadataCalls, 0);
});

test("empty, invalid and missing input never call the Node Info provider", async (t) => {
  const directory = fixtureDirectory(t);
  const hostsFile = join(directory, "hosts.json");
  let calls = 0;
  for (const contents of ["[]", "invalid", null]) {
    if (contents === null) rmSync(hostsFile);
    else writeFileSync(hostsFile, contents);
    const server = await startPreviewServer({
      directory, hostsFile, port: 0,
      nodeInfoProvider: async () => { calls++; throw new Error("must not be called"); },
    });
    t.after(() => close(server));
    const result = await read(server, "/preview/node-info.json");
    assert.equal(result.status, contents === "[]" ? 200 : 503);
    assert.deepEqual(parseSnapshot(result.body), { hosts: [] });
    assert.equal((await read(server, "/preview/node-info.json", "HEAD")).status, result.status);
    await close(server);
  }
  assert.equal(calls, 0);
});

test("unexpected Node Info failures produce bounded errors independent of metadata", async (t) => {
  const directory = fixtureDirectory(t);
  let metadataCalls = 0;
  const server = await startPreviewServer({
    directory, hostsFile: join(directory, "hosts.json"), port: 0,
    nodeInfoProvider: async () => { throw new Error("untrusted node diagnostic"); },
    metadataProvider: async () => { metadataCalls++; return { hosts: [] }; },
  });
  t.after(() => close(server));
  const before = Date.now();
  const result = await read(server, "/preview/node-info.json");
  const after = Date.now();
  assert.equal(result.status, 502);
  assert(!result.body.includes("untrusted node diagnostic"));
  const snapshot = parseSnapshot(result.body) as NodeInfoSnapshot;
  const checkedAtMs = snapshot.hosts[0]!.apiCheck!.checkedAtMs;
  assert(Number.isSafeInteger(checkedAtMs) && checkedAtMs >= before && checkedAtMs <= after);
  assert.deepEqual(snapshot, { hosts: addresses.map(address => ({
    address, values: null, fetchedAtMs: null, validUntilMs: null, retained: false,
    error: "The preview could not load Nosana Node Info.",
    apiCheck: { status: "other", checkedAtMs },
  })) });
  assert(snapshot.hosts.every(record => projectNodeApi(record, after).status === "Unknown"));
  assert.equal((await read(server, "/preview/metadata.json")).status, 200);
  assert.equal(metadataCalls, 1);
});

test("jobs route uses only startup addresses, shares overlapping reads and never dispatches for HEAD", async (t) => {
  const directory = fixtureDirectory(t);
  const calls: (readonly string[])[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const snapshot = { hosts: addresses.map(address => ({ address, job: null, checkedAtMs: null,
    validUntilMs: null, failedAtMs: null, retained: false, pending: false, retryAtMs: null,
    error: "Isolated fixture" })) };
  const server = await startPreviewServer({ directory, hostsFile: join(directory, "hosts.json"), port: 0,
    jobProvider: async input => { calls.push([...input]); await pending; return snapshot; },
    nodeInfoProvider: async () => { throw new Error("jobs must remain independent of State"); },
    metadataProvider: async () => { throw new Error("jobs must remain independent of metadata"); },
  });
  t.after(() => close(server));
  assert.equal((await read(server, "/preview/jobs.json", "HEAD")).status, 200);
  assert.equal((await read(server, "/preview/jobs.json", "POST")).status, 405);
  assert.equal(calls.length, 0);
  writeFileSync(join(directory, "hosts.json"), JSON.stringify([addresses[1]]));
  const first = read(server, "/preview/jobs.json?address=untrusted&file=private.txt");
  const second = read(server, "/preview/jobs.json");
  await read(server, "/preview/hosts.json");
  assert.deepEqual(calls, [addresses]);
  release();
  for (const result of await Promise.all([first, second])) {
    assert.equal(result.status, 200);
    assert.deepEqual(parseSnapshot(result.body), snapshot);
    assert.equal(result.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(result.headers["x-content-type-options"], "nosniff");
  }
  assert.equal(calls.length, 1);
});

test("empty, invalid and missing input never call the jobs provider", async (t) => {
  const directory = fixtureDirectory(t);
  const hostsFile = join(directory, "hosts.json");
  let calls = 0;
  for (const contents of ["[]", "invalid", null]) {
    if (contents === null) rmSync(hostsFile);
    else writeFileSync(hostsFile, contents);
    const server = await startPreviewServer({ directory, hostsFile, port: 0,
      jobProvider: async () => { calls++; throw new Error("must not be called"); } });
    t.after(() => close(server));
    const result = await read(server, "/preview/jobs.json");
    assert.equal(result.status, contents === "[]" ? 200 : 503);
    assert.deepEqual(parseSnapshot(result.body), { hosts: [] });
    assert.equal((await read(server, "/preview/jobs.json", "HEAD")).status, result.status);
    await close(server);
  }
  assert.equal(calls, 0);
});

test("unexpected job provider failures are bounded and State hints never trigger jobs reads", async (t) => {
  const directory = fixtureDirectory(t);
  let calls = 0;
  const observed: NodeInfoSnapshot[] = [];
  const state = { hosts: addresses.map(address => ({ address, values: null,
    fetchedAtMs: null, validUntilMs: null, retained: false, error: null })) };
  const jobProvider: JobProvider = async () => { calls++; throw new Error("untrusted diagnostic"); };
  jobProvider.observeStates = snapshot => { observed.push(snapshot); };
  const server = await startPreviewServer({ directory, hostsFile: join(directory, "hosts.json"), port: 0,
    jobProvider, nodeInfoProvider: async () => state });
  t.after(() => close(server));
  assert.equal((await read(server, "/preview/node-info.json")).status, 200);
  assert.deepEqual(observed, [state]);
  assert.equal(calls, 0);
  const response = await read(server, "/preview/jobs.json");
  assert.equal(response.status, 502);
  assert(!response.body.includes("untrusted diagnostic"));
  assert.deepEqual(parseSnapshot(response.body), { hosts: addresses.map(address => ({ address, job: null,
    checkedAtMs: null, validUntilMs: null, failedAtMs: null, retained: false, pending: false,
    retryAtMs: null, error: "The preview could not load Nosana job timing." })) });
});

test("queue route uses only startup hosts, shares inflight reads and keeps HEAD read-free", async (t) => {
  const directory = fixtureDirectory(t);
  const calls: (readonly string[])[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const snapshot = { hosts: addresses.map(address => ({ address, marketAddress: null, position: null, total: null,
    checkedAtMs: null, validUntilMs: null, sourceUpdatedAtMs: null, retained: false, error: "Isolated fixture" })) };
  const server = await startPreviewServer({ directory, hostsFile: join(directory, "hosts.json"), port: 0,
    queueProvider: async input => { calls.push([...input]); await pending; return snapshot; },
    nodeInfoProvider: async () => { assert.fail("Queue route must not call Node Info"); },
    jobProvider: async () => { assert.fail("Queue route must not call jobs"); },
    metadataProvider: async () => { assert.fail("Injected queue provider must bypass metadata"); },
  });
  t.after(() => close(server));
  assert.equal((await read(server, "/preview/queue.json", "HEAD")).status, 200);
  assert.equal((await read(server, "/preview/queue.json", "POST")).status, 405);
  assert.equal(calls.length, 0);
  writeFileSync(join(directory, "hosts.json"), JSON.stringify([addresses[1]]));
  const first = read(server, "/preview/queue.json?address=untrusted&market=untrusted&file=private.txt");
  const second = read(server, "/preview/queue.json");
  await read(server, "/preview/hosts.json");
  assert.deepEqual(calls, [addresses]);
  release();
  for (const result of await Promise.all([first, second])) {
    assert.equal(result.status, 200);
    assert.deepEqual(parseSnapshot(result.body), snapshot);
    assert.equal(result.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(result.headers["x-content-type-options"], "nosniff");
  }
  assert.equal(calls.length, 1);
});

test("empty, invalid and missing startup input never dispatch queue reads", async (t) => {
  const directory = fixtureDirectory(t);
  const hostsFile = join(directory, "hosts.json");
  let calls = 0;
  for (const contents of ["[]", "invalid", null]) {
    if (contents === null) rmSync(hostsFile);
    else writeFileSync(hostsFile, contents);
    const server = await startPreviewServer({ directory, hostsFile, port: 0,
      queueProvider: async () => { calls++; throw new Error("must not be called"); } });
    t.after(() => close(server));
    const result = await read(server, "/preview/queue.json");
    assert.equal(result.status, contents === "[]" ? 200 : 503);
    assert.deepEqual(parseSnapshot(result.body), { hosts: [] });
    assert.equal((await read(server, "/preview/queue.json", "HEAD")).status, result.status);
    await close(server);
  }
  assert.equal(calls, 0);
});

test("queue route returns bounded errors when an injected provider throws", async (t) => {
  const directory = fixtureDirectory(t);
  const server = await startPreviewServer({ directory, hostsFile: join(directory, "hosts.json"), port: 0,
    queueProvider: async () => { throw new Error("private injected diagnostic"); } });
  t.after(() => close(server));
  const result = await read(server, "/preview/queue.json");
  assert.equal(result.status, 502);
  assert(!result.body.includes("private"));
  assert.deepEqual(parseSnapshot(result.body), { hosts: addresses.map(address => ({ address, marketAddress: null,
    position: null, total: null, checkedAtMs: null, validUntilMs: null, sourceUpdatedAtMs: null, retained: false,
    error: "The preview could not load Nosana queue positions." })) });
});

test("SOL route shares work, uses startup hosts only and keeps HEAD read-free", async t => {
  const directory = fixtureDirectory(t);
  const calls: (readonly string[])[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const snapshot = { hosts: [], nextRefreshAtMs: 30_000 };
  const server = await startPreviewServer({ directory, hostsFile: join(directory, "hosts.json"), port: 0,
    solProvider: async input => { calls.push([...input]); await pending; return snapshot; },
  });
  t.after(() => close(server));
  assert.equal((await read(server, "/preview/sol.json", "HEAD")).status, 200);
  assert.equal((await read(server, "/preview/sol.json", "POST")).status, 405);
  assert.equal(calls.length, 0);
  writeFileSync(join(directory, "hosts.json"), JSON.stringify([addresses[1]]));
  const first = read(server, "/preview/sol.json?address=untrusted&endpoint=http://untrusted&force=true");
  const second = read(server, "/preview/sol.json");
  await read(server, "/preview/hosts.json");
  assert.deepEqual(calls, [addresses]);
  release();
  for (const result of await Promise.all([first, second])) {
    assert.equal(result.status, 200);
    assert.deepEqual(parseSnapshot(result.body), snapshot);
    assert.equal(result.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(result.headers["cache-control"], "no-store");
  }
  assert.equal(calls.length, 1);
});

test("empty, invalid and missing startup input never dispatch SOL reads", async t => {
  const directory = fixtureDirectory(t);
  const hostsFile = join(directory, "hosts.json");
  let calls = 0;
  for (const contents of ["[]", "invalid", null]) {
    if (contents === null) rmSync(hostsFile);
    else writeFileSync(hostsFile, contents);
    const server = await startPreviewServer({ directory, hostsFile, port: 0,
      solProvider: async () => { calls++; throw new Error("must not be called"); } });
    t.after(() => close(server));
    const result = await read(server, "/preview/sol.json");
    assert.equal(result.status, contents === "[]" ? 200 : 503);
    assert.deepEqual(parseSnapshot(result.body), { hosts: [], nextRefreshAtMs: null });
    assert.equal((await read(server, "/preview/sol.json", "HEAD")).status, result.status);
    await close(server);
  }
  assert.equal(calls, 0);
});

test("SOL provider exceptions produce a dated retry and bounded unknowns", async t => {
  const directory = fixtureDirectory(t);
  const server = await startPreviewServer({ directory, hostsFile: join(directory, "hosts.json"), port: 0,
    solProvider: async () => { throw new Error("private injected diagnostic"); } });
  t.after(() => close(server));
  const before = Date.now();
  const result = await read(server, "/preview/sol.json");
  assert.equal(result.status, 502);
  assert(!result.body.includes("private injected"));
  const snapshot = parseSnapshot(result.body);
  assert(snapshot.nextRefreshAtMs >= before + 30_000);
  assert.deepEqual(snapshot.hosts.map((host: { address: string }) => host.address), addresses);
  assert(snapshot.hosts.every((host: { lamports: unknown }) => host.lamports === null));
});

test("NOS route shares startup-roster work, ignores query overrides and stays finite JSON", async t => {
  const directory = fixtureDirectory(t);
  const calls: (readonly string[])[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const snapshot = await emptyNos(addresses);
  const server = await startPreviewServer({ directory, hostsFile: join(directory, "hosts.json"), port: 0,
    nosProvider: async input => { calls.push([...input]); await pending; return snapshot; },
  });
  t.after(() => close(server));
  assert.equal((await read(server, "/preview/nos.json", "HEAD")).status, 200);
  assert.equal((await read(server, "/preview/nos.json", "POST")).status, 405);
  assert.equal(calls.length, 0);
  writeFileSync(join(directory, "hosts.json"), JSON.stringify([addresses[1]]));
  const first = read(server, "/preview/nos.json?address=untrusted&file=private.txt&endpoint=http://untrusted&force=true");
  const second = read(server, "/preview/nos.json", "GET", { Accept: "application/x-ndjson" });
  await read(server, "/preview/hosts.json");
  assert.deepEqual(calls, [addresses]);
  release();
  for (const result of await Promise.all([first, second])) {
    assert.equal(result.status, 200);
    assert.deepEqual(parseSnapshot(result.body), snapshot);
    assert.equal(result.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(Number(result.headers["content-length"]), Buffer.byteLength(result.body));
  }
  assert.equal(calls.length, 1);
});

test("empty, invalid and missing startup input never dispatch NOS reads", async t => {
  const directory = fixtureDirectory(t);
  const hostsFile = join(directory, "hosts.json");
  let calls = 0;
  for (const contents of ["[]", "invalid", null]) {
    if (contents === null) rmSync(hostsFile);
    else writeFileSync(hostsFile, contents);
    const server = await startPreviewServer({ directory, hostsFile, port: 0,
      nosProvider: async () => { calls++; throw new Error("must not be called"); } });
    t.after(() => close(server));
    const result = await read(server, "/preview/nos.json");
    assert.equal(result.status, contents === "[]" ? 200 : 503);
    assert.deepEqual(parseSnapshot(result.body), { hosts: [], nextRefreshAtMs: null });
    const head = await read(server, "/preview/nos.json", "HEAD");
    assert.equal(head.status, result.status);
    assert.equal(head.body, "");
    await close(server);
  }
  assert.equal(calls, 0);
});

test("NOS provider exceptions produce bounded unknowns and one consistent retry deadline", async t => {
  const directory = fixtureDirectory(t);
  const server = await startPreviewServer({ directory, hostsFile: join(directory, "hosts.json"), port: 0,
    nosProvider: async () => { throw new Error("private injected diagnostic"); } });
  t.after(() => close(server));
  const before = Date.now();
  const result = await read(server, "/preview/nos.json");
  const after = Date.now();
  assert.equal(result.status, 502);
  assert(!result.body.includes("private injected"));
  const snapshot = parseSnapshot(result.body);
  assert(snapshot.nextRefreshAtMs >= before + NOS_REFRESH_INTERVAL_MS);
  assert(snapshot.nextRefreshAtMs <= after + NOS_REFRESH_INTERVAL_MS);
  assert.deepEqual(snapshot.hosts, addresses.map(address => ({
    address, tokenAccount: null, mint: NOS_MINT, amount: null, decimals: 6,
    accountState: null, provider: null, endpoint: null, contextSlot: null,
    blockTimeMs: null, checkedAtMs: null, validUntilMs: null, retained: false,
    retryAtMs: snapshot.nextRefreshAtMs, error: "The preview could not load NOS balances.",
  })));
});

test("staking route binds startup hosts, coalesces viewers and accepts only read methods", async t => {
  const directory = fixtureDirectory(t);
  const calls: (readonly string[])[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const snapshot = await emptyStaking(addresses);
  const server = await startPreviewServer({ directory, hostsFile: join(directory, "hosts.json"), port: 0,
    stakingProvider: async input => { calls.push([...input]); await pending; return snapshot; },
  });
  t.after(() => close(server));
  let arrived = 0;
  server.on("request", request => {
    if (request.method === "GET" && request.url?.startsWith("/preview/staking.json")) arrived++;
  });
  assert.equal((await read(server, "/preview/staking.json", "HEAD")).status, 200);
  assert.equal((await read(server, "/preview/staking.json", "POST")).status, 405);
  assert.equal(calls.length, 0);
  writeFileSync(join(directory, "hosts.json"), JSON.stringify([addresses[1]]));
  const first = read(server, "/preview/staking.json?address=untrusted&file=private.txt&endpoint=http://untrusted&force=true");
  const second = read(server, "/preview/staking.json", "GET", { Accept: "application/x-ndjson" });
  // Wait for both callers to join; the first dispatch alone is not a barrier.
  await until(() => arrived === 2);
  assert.deepEqual(calls, [addresses]);
  release();
  for (const result of await Promise.all([first, second])) {
    assert.equal(result.status, 200);
    assert.deepEqual(parseSnapshot(result.body), snapshot);
    assert.equal(result.headers["content-type"], "application/json; charset=utf-8");
  }
  assert.equal(calls.length, 1);
});

test("staking empty/invalid inputs never read upstream; exceptions retain bounded separate unknowns", async t => {
  const directory = fixtureDirectory(t);
  const hostsFile = join(directory, "hosts.json");
  let calls = 0;
  for (const contents of ["[]", "invalid", null]) {
    if (contents === null) rmSync(hostsFile);
    else writeFileSync(hostsFile, contents);
    const server = await startPreviewServer({ directory, hostsFile, port: 0,
      stakingProvider: async () => { calls++; throw new Error("private injected diagnostic"); } });
    t.after(() => close(server));
    const result = await read(server, "/preview/staking.json");
    assert.equal(result.status, contents === "[]" ? 200 : 503);
    assert.deepEqual(parseSnapshot(result.body), { hosts: [], nextRefreshAtMs: null });
    await close(server);
  }
  assert.equal(calls, 0);
  writeFileSync(hostsFile, JSON.stringify(addresses));
  const server = await startPreviewServer({ directory, hostsFile, port: 0,
    stakingProvider: async () => { throw new Error("private injected diagnostic"); } });
  t.after(() => close(server));
  const before = Date.now();
  const result = await read(server, "/preview/staking.json");
  assert.equal(result.status, 502);
  assert(!result.body.includes("private injected"));
  const snapshot = parseSnapshot(result.body);
  assert(snapshot.nextRefreshAtMs >= before + STAKING_REFRESH_INTERVAL_MS);
  assert.deepEqual(snapshot.hosts, addresses.map(address => {
    const record = blankStakingRecord(address);
    const retryAtMs = snapshot.nextRefreshAtMs;
    const error = "The preview could not load staking readings.";
    return { ...record, stake: { ...record.stake, retryAtMs, error },
      requirement: { ...record.requirement, retryAtMs, error }, marketError: error };
  }));
});

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    assert(Date.now() < deadline, "expected server event before deadline");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function cancellableRead(server: Server, path: string) {
  const address = server.address();
  assert(address && typeof address !== "string");
  const outgoing = request({ hostname: "127.0.0.1", port: address.port, path });
  const result = new Promise<string>(resolve => {
    outgoing.on("response", incoming => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      incoming.on("error", () => resolve("disconnected"));
    });
    outgoing.on("error", () => resolve("disconnected"));
  });
  outgoing.end();
  return { outgoing, result };
}

for (const [route, providerName] of [
  ["metadata", "metadataProvider"], ["node-info", "nodeInfoProvider"],
  ["jobs", "jobProvider"], ["queue", "queueProvider"], ["sol", "solProvider"], ["nos", "nosProvider"], ["staking", "stakingProvider"],
] as const) {
  test(`${route}: last disconnect aborts shared work and immediate return starts a new read`, async t => {
    const directory = fixtureDirectory(t);
    const calls: { signal: AbortSignal; release: () => void }[] = [];
    const provider = async (_addresses: readonly string[], signal?: AbortSignal) => {
      assert(signal);
      await new Promise<void>(resolve => { calls.push({ signal, release: resolve }); });
      // Deliberately ignore cancellation to test obsolete completion guards.
      return { hosts: [], nextRefreshAtMs: null };
    };
    const server = await startPreviewServer({ directory, hostsFile: join(directory, "hosts.json"), port: 0,
      [providerName]: provider });
    t.after(() => close(server));
    const first = cancellableRead(server, `/preview/${route}.json`);
    const second = cancellableRead(server, `/preview/${route}.json`);
    await until(() => calls.length === 1);
    await read(server, "/preview/hosts.json");
    first.outgoing.destroy();
    await first.result;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls[0]!.signal.aborted, false, "other viewer still needs shared work");
    second.outgoing.destroy();
    await second.result;
    await until(() => calls[0]!.signal.aborted);
    const resumed = cancellableRead(server, `/preview/${route}.json`);
    await until(() => calls.length === 2);
    calls[0]!.release();
    const another = cancellableRead(server, `/preview/${route}.json`);
    await read(server, "/preview/hosts.json");
    assert.equal(calls.length, 2, "obsolete cleanup must not remove replacement work");
    calls[1]!.release();
    const bodies = await Promise.all([resumed.result, another.result]);
    for (const body of bodies) assert.deepEqual(parseSnapshot(body).hosts, []);
    assert.equal(calls[1]!.signal.aborted, false);
  });
}

test("closing the direct metadata viewer preserves a pending queue dependency", async t => {
  const directory = fixtureDirectory(t);
  let signal: AbortSignal | undefined;
  let release!: () => void;
  let calls = 0;
  const server = await startPreviewServer({ directory, hostsFile: join(directory, "hosts.json"), port: 0,
    metadataProvider: async (_input, currentSignal) => {
      calls++; signal = currentSignal;
      await new Promise<void>(resolve => { release = resolve; });
      return { hosts: addresses.map(address => ({ address, values: null, fetchedAtMs: null,
        retained: false, error: null, marketError: null })) };
    },
  });
  t.after(() => close(server));
  const direct = cancellableRead(server, "/preview/metadata.json");
  await until(() => calls === 1);
  const queue = cancellableRead(server, "/preview/queue.json");
  await read(server, "/preview/hosts.json");
  direct.outgoing.destroy();
  await direct.result;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(signal?.aborted, false);
  assert.equal(calls, 1);
  release();
  const snapshot = parseSnapshot(await queue.result);
  assert.equal(snapshot.hosts.length, addresses.length);
  assert(snapshot.hosts.every((host: { position: unknown }) => host.position === null));
});

test("progressive metadata streams ready hosts, replays late joins and shares a concurrent JSON reader", async t => {
  const directory = fixtureDirectory(t);
  const snapshot = { hosts: addresses.map(address => ({ address, values: null, fetchedAtMs: null,
    retained: false, error: null, marketError: null })) };
  let release!: () => void;
  let signal!: AbortSignal;
  let calls = 0;
  const server = await startPreviewServer({ directory, hostsFile: join(directory, "hosts.json"), port: 0,
    metadataProvider: async (_addresses, currentSignal, onUpdate) => {
      calls++; signal = currentSignal!;
      onUpdate?.({ hosts: snapshot.hosts.slice(0, 1) });
      await new Promise<void>(resolve => { release = resolve; });
      return snapshot;
    },
  });
  t.after(() => close(server));
  const bound = server.address(); assert(bound && typeof bound !== "string");
  const url = `http://127.0.0.1:${bound.port}/preview/metadata.json`;
  const first = new AbortController();
  const response = await fetch(url, { headers: { Accept: "application/x-ndjson, application/json" }, signal: first.signal });
  assert.match(response.headers.get("content-type")!, /application\/x-ndjson/);
  const reader = response.body!.getReader();
  const update = parseSnapshot(new TextDecoder().decode((await reader.read()).value));
  assert.deepEqual(update, { hosts: snapshot.hosts.slice(0, 1), complete: false });
  const json = read(server, "/preview/metadata.json");
  const joined = await fetch(url, { headers: { Accept: "application/x-ndjson" } });
  const joinedReader = joined.body!.getReader();
  const replay = parseSnapshot(new TextDecoder().decode((await joinedReader.read()).value));
  assert.deepEqual(replay, update);
  first.abort();
  await read(server, "/preview/hosts.json");
  assert.equal(signal.aborted, false);
  release();
  const final = parseSnapshot(new TextDecoder().decode((await joinedReader.read()).value));
  assert.deepEqual(final, { ...snapshot, complete: true });
  assert.equal((await joinedReader.read()).done, true);
  assert.deepEqual(parseSnapshot((await json).body), snapshot);
  assert.equal(calls, 1);
  reader.releaseLock(); joinedReader.releaseLock();
});

test("preview stamps roster, finite and replayed stream envelopes without changing source time", async t => {
  const directory = fixtureDirectory(t);
  const observedAt = 100;
  const snapshot = { serverTimeMs: -1, hosts: addresses.map(address => ({ address, values: null,
    fetchedAtMs: observedAt, retained: false, error: null, marketError: null })) };
  let now = 1_000;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const server = await startPreviewServer({ directory, hostsFile: join(directory, "hosts.json"), port: 0,
    now: () => now, metadataProvider: async (_addresses, _signal, onUpdate) => {
      onUpdate?.(snapshot);
      await held;
      return snapshot;
    },
  });
  t.after(() => close(server));
  const roster = JSON.parse((await read(server, "/preview/hosts.json")).body);
  assert.equal(roster.serverTimeMs, now);
  const bound = server.address(); assert(bound && typeof bound !== "string");
  const url = `http://127.0.0.1:${bound.port}/preview/metadata.json`;
  const controller = new AbortController();
  now = 1_100;
  const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/x-ndjson" } });
  const reader = response.body!.getReader();
  const initial = JSON.parse(new TextDecoder().decode((await reader.read()).value));
  assert.equal(initial.serverTimeMs, 1_100);
  assert.deepEqual(initial.hosts, snapshot.hosts);
  now = 1_200;
  const joined = await fetch(url, { headers: { Accept: "application/x-ndjson" } });
  const joinedReader = joined.body!.getReader();
  const replay = JSON.parse(new TextDecoder().decode((await joinedReader.read()).value));
  assert.equal(replay.serverTimeMs, 1_200, "replaying old evidence gets a new transmission time");
  assert.deepEqual(replay.hosts, initial.hosts);
  controller.abort();
  now = 1_300;
  release();
  const final = JSON.parse(new TextDecoder().decode((await joinedReader.read()).value));
  assert.equal(final.complete, true);
  assert.equal(final.serverTimeMs, 1_300);
  assert.deepEqual(final.hosts, snapshot.hosts);
  assert.equal((await joinedReader.read()).done, true);
  now = 1_400;
  const finite = JSON.parse((await read(server, "/preview/metadata.json")).body);
  assert.equal(finite.serverTimeMs, 1_400);
  assert.deepEqual(finite.hosts, snapshot.hosts);
  assert.equal(snapshot.serverTimeMs, -1, "wire stamps must not mutate cached/provider snapshots");
  reader.releaseLock(); joinedReader.releaseLock();
});

test("SOL streams completed balances, replays a late viewer and keeps a shared JSON response finite", async t => {
  const directory = fixtureDirectory(t);
  const snapshot = await emptySol(addresses);
  let release!: () => void;
  let signal!: AbortSignal;
  let calls = 0;
  const server = await startPreviewServer({ directory, hostsFile: join(directory, "hosts.json"), port: 0,
    solProvider: async (_addresses, currentSignal, onUpdate) => {
      calls++; signal = currentSignal!;
      onUpdate?.({ hosts: snapshot.hosts.slice(0, 1), nextRefreshAtMs: 30_000 });
      await new Promise<void>(resolve => { release = resolve; });
      return snapshot;
    },
  });
  t.after(() => close(server));
  const bound = server.address(); assert(bound && typeof bound !== "string");
  const url = `http://127.0.0.1:${bound.port}/preview/sol.json`;
  const first = new AbortController();
  const response = await fetch(url, { headers: { Accept: "application/x-ndjson, application/json" }, signal: first.signal });
  assert.match(response.headers.get("content-type")!, /application\/x-ndjson/);
  const reader = response.body!.getReader();
  const update = parseSnapshot(new TextDecoder().decode((await reader.read()).value));
  assert.deepEqual(update, { hosts: snapshot.hosts.slice(0, 1), nextRefreshAtMs: 30_000, complete: false });
  const json = read(server, "/preview/sol.json");
  const joined = await fetch(url, { headers: { Accept: "application/x-ndjson" } });
  const joinedReader = joined.body!.getReader();
  assert.deepEqual(parseSnapshot(new TextDecoder().decode((await joinedReader.read()).value)), update);
  first.abort();
  await read(server, "/preview/hosts.json");
  assert.equal(signal.aborted, false);
  release();
  assert.deepEqual(parseSnapshot(new TextDecoder().decode((await joinedReader.read()).value)), { ...snapshot, complete: true });
  assert.equal((await joinedReader.read()).done, true);
  assert.deepEqual(parseSnapshot((await json).body), snapshot);
  assert.equal(calls, 1);
  reader.releaseLock(); joinedReader.releaseLock();
});

test("progressive failures end with an explicit failed frame instead of silently replacing evidence", async t => {
  const directory = fixtureDirectory(t);
  const server = await startPreviewServer({ directory, hostsFile: join(directory, "hosts.json"), port: 0,
    metadataProvider: async (_addresses, _signal, onUpdate) => {
      onUpdate?.({ hosts: [{ address: addresses[0]!, values: null, fetchedAtMs: null,
        retained: false, error: null, marketError: null }] });
      throw new Error("private provider diagnostic");
    },
  });
  t.after(() => close(server));
  const bound = server.address(); assert(bound && typeof bound !== "string");
  const response = await fetch(`http://127.0.0.1:${bound.port}/preview/metadata.json`, {
    headers: { Accept: "application/x-ndjson" },
  });
  const text = await response.text();
  assert(!text.includes("private provider"));
  const frames = text.trim().split("\n").map(line => parseSnapshot(line));
  assert.equal(frames[0].complete, false);
  assert.equal(frames.at(-1).complete, true);
  assert.equal(frames.at(-1).failed, true);
});

test("visible State watches share updates, keep JSON finite and stop only after their last viewer leaves", async t => {
  const directory = fixtureDirectory(t);
  const snapshot: NodeInfoSnapshot = { hosts: addresses.map(address => ({ address, values: null,
    fetchedAtMs: null, validUntilMs: null, retained: false, error: null })) };
  let finiteReads = 0;
  let watches = 0;
  let watchSignal!: AbortSignal;
  let publish!: (snapshot: NodeInfoSnapshot) => void;
  const provider: import("../scripts/node-info.ts").NodeInfoProvider = async () => { finiteReads++; return snapshot; };
  provider.watch = async (_addresses, signal, onUpdate) => {
    watches++; watchSignal = signal; publish = onUpdate;
    onUpdate({ hosts: snapshot.hosts.slice(0, 1), nextRefreshAtMs: Date.now() + 15_000 });
    return new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  const server = await startPreviewServer({ directory, hostsFile: join(directory, "hosts.json"), port: 0,
    nodeInfoProvider: provider });
  t.after(() => close(server));
  const bound = server.address(); assert(bound && typeof bound !== "string");
  const url = `http://127.0.0.1:${bound.port}/preview/node-info.json`;
  const first = new AbortController(); const second = new AbortController();
  const response = await fetch(url, { headers: { Accept: "application/x-ndjson" }, signal: first.signal });
  const reader = response.body!.getReader();
  const initial = parseSnapshot(new TextDecoder().decode((await reader.read()).value));
  assert.equal(initial.watching, true); assert.equal(initial.complete, false);
  assert.equal(watches, 1); assert.equal(finiteReads, 0);
  const joinedResponse = await fetch(url, { headers: { Accept: "application/x-ndjson" }, signal: second.signal });
  const joined = joinedResponse.body!.getReader();
  const replay = parseSnapshot(new TextDecoder().decode((await joined.read()).value));
  assert.deepEqual(replay, initial);
  assert.deepEqual(parseSnapshot((await read(server, "/preview/node-info.json")).body), snapshot);
  assert.equal(finiteReads, 1); assert.equal(watches, 1);
  first.abort();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(watchSignal.aborted, false);
  publish({ hosts: snapshot.hosts.slice(1, 2), nextRefreshAtMs: Date.now() + 15_000 });
  const updated = parseSnapshot(new TextDecoder().decode((await joined.read()).value));
  assert.equal(updated.hosts[0].address, addresses[1]);
  second.abort();
  await until(() => watchSignal.aborted);
  reader.releaseLock(); joined.releaseLock();
});
