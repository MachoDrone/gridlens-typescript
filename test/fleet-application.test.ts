import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { Server } from "node:http";
import { request } from "node:http";
import { BROWSER_ASSETS } from "../src/server/browser-assets.ts";
import { closeFleetServer, startFleetServer } from "../src/server/application.ts";
import type { FleetIntegration } from "../src/server/application.ts";
import { createMemorySnapshotStore, emptyFleetSnapshots } from "../src/server/snapshot-store.ts";
import { createSnapshotSource } from "../src/server/snapshot-source.ts";
import type { FleetSource } from "../src/server/snapshot-source.ts";
import type { FleetContext, FleetResource, FleetSnapshots } from "../src/contracts/fleet.ts";
import { hostedConfiguration, loadIntegration } from "../scripts/hosted-server.ts";
import { createFleetTransport } from "../src/preview/fleet-transport.ts";

const address = "1".repeat(31) + "2";
const second = "1".repeat(31) + "3";
const fleet: FleetContext = { scopeId: "operator-a", rosterRevision: "r1", addresses: [address] };
const other: FleetContext = { scopeId: "operator-b", rosterRevision: "r1", addresses: [second] };

async function assets(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-hosting-http-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [file] of Object.values(BROWSER_ASSETS)) {
    const path = join(directory, file);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, file === "index.html" ? "<!doctype html><html><head></head><body>Fleet</body></html>" : "/* isolated asset */");
  }
  return directory;
}
function origin(server: Server): string {
  const address = server.address();
  assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
async function app(t: TestContext, integration: FleetIntegration, options: Partial<Parameters<typeof startFleetServer>[0]> = {}) {
  const server = await startFleetServer({ directory: await assets(t), port: 0, integration, ...options });
  t.after(async () => { if (server.listening) await closeFleetServer(server, integration); });
  return server;
}
function authenticated(source = createSnapshotSource(createMemorySnapshotStore())): FleetIntegration {
  return { source, resolveAccess: async request => request.headers.authorization === "test-a" ? fleet
    : request.headers.authorization === "test-b" ? other : null };
}
const options = { headers: { Authorization: "test-a" } };

test("a small history selection ignores irrelevant and unchanged bulk progress frames", async t => {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const addresses = [...alphabet].slice(0, 50).map(last => "1".repeat(31) + last);
  const context = { ...fleet, addresses };
  const integration: FleetIntegration = { resolveAccess: async () => context, source: {
    async read(resource, owned, _signal, update) {
      const snapshot = emptyFleetSnapshots(owned.addresses)[resource];
      for (const row of snapshot.hosts) {
        update?.({ ...snapshot, hosts: [row] } as typeof snapshot);
        update?.(snapshot);
      }
      return snapshot;
    },
  } };
  const server = await app(t, integration);
  let frames = 0;
  const transport = createFleetTransport({ fetch: (url, init) => fetch(`${origin(server)}${url}`, init) });
  const selected = [addresses[0]!];
  const result = await transport.read("job-history", "/api/fleet/job-history.json", {
    addresses: selected, hosts: selected, onSnapshot: () => { frames++; },
  });
  assert.equal(frames, 2, "one selected observation and the finite final result");
  assert.equal(result.hosts[0]?.address, selected[0]);
});

test("history selection narrows an authorized roster, preserves source context and strips unused fields", async t => {
  const context = { ...fleet, addresses: [address, second] };
  const reads: FleetContext[] = [];
  const integration: FleetIntegration = {
    resolveAccess: async () => context,
    source: { async read(resource, owned) {
      reads.push(owned);
      const snapshot = emptyFleetSnapshots(owned.addresses)[resource];
      return { ...snapshot, privateDefinition: "not exported" };
    } },
  };
  const server = await app(t, integration);
  const url = `${origin(server)}/api/fleet/job-history.json`;
  for (const query of ["", "?host=foreign", `?host=${address}&host=${address}`,
    `?host=${address}&scopeId=operator-b`, `?host=${address}&refresh=0`]) {
    assert.equal((await fetch(`${url}${query}`)).status, 400);
  }
  assert.equal(reads.length, 0);
  assert.equal((await fetch(`${url}?host=${second}`, { method: "HEAD" })).status, 200);
  assert.equal(reads.length, 0);
  const response = await fetch(`${url}?host=${second}&refresh=1`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.hosts.map((row: { address: string }) => row.address), [second]);
  assert.equal(body.privateDefinition, undefined);
  assert.deepEqual(reads[0], context, "selection cannot change store scope or roster revision");
  const stream = await fetch(`${url}?host=${address}`, { headers: { Accept: "application/x-ndjson" } });
  const frame = JSON.parse((await stream.text()).trim());
  assert.equal(frame.complete, true);
  assert.deepEqual(frame.hosts.map((row: { address: string }) => row.address), [address]);
});

test("portable gateway requires explicit adapters/origin and never supplies authentication or public-provider defaults", async t => {
  await assert.rejects(startFleetServer({ integration: {} as FleetIntegration }), /resolver.*source/);
  await assert.rejects(startFleetServer({ integration: authenticated(), host: "0.0.0.0" }), /public origin/);
  for (const publicOrigin of ["ftp://example.test", "https://user:pass@example.test", "https://example.test/path", "https://example.test/?key=x"]) {
    await assert.rejects(startFleetServer({ integration: authenticated(), publicOrigin }), /origin/);
  }
  let reads = 0;
  const source: FleetSource = { async read(resource, context) { reads++; return emptyFleetSnapshots(context.addresses)[resource]; } };
  const server = await app(t, authenticated(source));
  const url = origin(server);
  for (const path of ["hosts", "metadata", "node-info", "jobs", "queue", "sol", "nos", "staking"]) {
    assert.equal((await fetch(`${url}/api/fleet/${path}.json`)).status, 401);
  }
  assert.equal((await fetch(`${url}/api/fleet/jobs.json`, { headers: { "X-User": "test-a", "X-Forwarded-User": "test-a" } })).status, 401);
  assert.equal(reads, 0);
  assert.equal((await fetch(`${url}/health/ready`)).status, 200);
  assert.equal((await fetch(`${url}/api/fleet/connection.json`)).status, 200);
  assert.equal(reads, 0, "health and connectivity checks must not dispatch data reads");
  const html = await (await fetch(url)).text();
  assert.match(html, /gridlens-api-base.*\/api\/fleet/);
  assert.match(html, /gridlens-source-mode.*snapshot/);
});

test("authorized scopes are resolved before reads; query addresses and forged origins cannot select another fleet", async t => {
  const store = createMemorySnapshotStore();
  const server = await app(t, authenticated(createSnapshotSource(store)));
  const url = origin(server);
  const a = await (await fetch(`${url}/api/fleet/hosts.json`, options)).json();
  const b = await (await fetch(`${url}/api/fleet/hosts.json`, { headers: { Authorization: "test-b" } })).json();
  assert.deepEqual(a.addresses, [address]); assert.deepEqual(b.addresses, [second]);
  assert.equal((await fetch(`${url}/api/fleet/jobs.json?address=${second}`, options)).status, 400);
  assert.equal((await fetch(`${url}/api/fleet/jobs.json`, { headers: { ...options.headers, Origin: "https://untrusted.invalid" } })).status, 403);
  const forgedStatus = await new Promise<number | undefined>((accept, reject) => {
    const outgoing = request(`${url}/api/fleet/jobs.json`, { headers: { ...options.headers,
      Host: "untrusted.invalid", "X-Forwarded-Host": new URL(url).host } }, response => {
      response.resume(); response.once("end", () => accept(response.statusCode));
    });
    outgoing.once("error", reject); outgoing.end();
  });
  assert.equal(forgedStatus, 403);
  assert.equal((await fetch(`${url}/api/fleet/jobs.json`, { ...options, method: "POST" })).status, 405);
  const result = await (await fetch(`${url}/api/fleet/jobs.json`, options)).json();
  assert.deepEqual(result.hosts.map((record: { address: string }) => record.address), [address]);
  assert.equal(result.hosts[0].checkedAtMs, null);
});

test("one gateway mounts below an existing site through configuration, without root API aliases", async t => {
  const server = await app(t, authenticated(), { basePath: "/tools/fleet" });
  const url = origin(server);
  const html = await (await fetch(`${url}/tools/fleet/`)).text();
  assert.match(html, /gridlens-api-base.*\/tools\/fleet\/api\/fleet/);
  const redirected = await fetch(`${url}/tools/fleet`, { redirect: "manual" });
  assert.equal(redirected.status, 308);
  assert.equal(redirected.headers.get("location"), "/tools/fleet/");
  assert.equal((await fetch(`${url}/tools/fleet/health/ready`)).status, 200);
  assert.equal((await fetch(`${url}/tools/fleet/api/fleet/hosts.json`, options)).status, 200);
  assert.equal((await fetch(`${url}/api/fleet/hosts.json`, options)).status, 404);
  assert.equal((await fetch(`${url}/tools/fleet/preview/fleet-config.js`)).status, 200);
  for (const basePath of ["/../fleet", "//elsewhere", "/fleet/", "/fleet?x", "/%2e%2e", "https://example.test"]) {
    await assert.rejects(startFleetServer({ integration: authenticated(), basePath }), /mount path/);
  }
});

test("two gateways read the same shared snapshots without rediscovery or timestamp renewal after days away", async t => {
  let now = 1_000_000;
  const store = createMemorySnapshotStore();
  const initial = emptyFleetSnapshots(fleet.addresses);
  initial.jobs = { hosts: [{ address, job: { address: second, node: address, state: "RUNNING",
    timeStart: 900, timeEnd: 0, timeout: 600 }, checkedAtMs: now, validUntilMs: now + 180_000,
    failedAtMs: null, retained: false, pending: false, retryAtMs: null, error: null }], nextRefreshAtMs: now + 120_000 };
  await store.commit(fleet, { jobs: initial.jobs }, 0);
  const integration = authenticated(createSnapshotSource(store, { now: () => now }));
  const first = await app(t, integration);
  const secondServer = await app(t, integration);
  now += 3 * 86_400_000;
  for (const server of [first, secondServer]) {
    const result = await (await fetch(`${origin(server)}/api/fleet/jobs.json`, options)).json();
    assert.deepEqual(result.hosts, initial.jobs.hosts);
    assert.equal(result.nextRefreshAtMs, now + 120_000, "only the cache recheck plan may change");
  }
  assert.equal((await store.read(fleet)).revision, 1);
});

test("revoked or changed authorized rosters terminate existing watches and prevent further data delivery", async t => {
  for (const changedRoster of [false, true]) {
    let allowed = true;
    let upstream: AbortSignal | undefined;
    let emit!: (snapshot: FleetSnapshots["node-info"]) => void;
    const data = emptyFleetSnapshots(fleet.addresses)["node-info"];
    const source: FleetSource = {
      async read(resource, context) { return emptyFleetSnapshots(context.addresses)[resource]; },
      watch<K extends FleetResource>(_resource: K, _context: FleetContext, signal: AbortSignal,
        update: (snapshot: FleetSnapshots[K]) => void): Promise<never> {
        upstream = signal;
        emit = value => update(value as FleetSnapshots[K]);
        emit(data);
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      },
    };
    const integration: FleetIntegration = { source, resolveAccess: async () => allowed ? fleet : changedRoster ? other : null };
    const server = await app(t, integration, { accessCheckIntervalMs: 20 });
    const response = await fetch(`${origin(server)}/api/fleet/node-info.json`, { headers: { Accept: "application/x-ndjson" } });
    const reader = response.body!.getReader();
    const initial = await reader.read();
    assert.match(new TextDecoder().decode(initial.value), /watching/);
    allowed = false;
    await assert.rejects(async () => { while (!(await reader.read()).done) { /* bounded by server access recheck */ } });
    assert.equal(upstream?.aborted, true);
    emit(data); // Late producer callbacks cannot revive an obsolete viewer.
    reader.releaseLock();
    assert.equal((await fetch(`${origin(server)}/api/fleet/hosts.json`)).status, changedRoster ? 200 : 401);
  }
});

test("bad source responses, exceptions and stalled requests stay bounded and never expose adapter diagnostics", async t => {
  for (const variant of ["foreign", "throw", "hang"] as const) {
    const source: FleetSource = { async read(resource) {
      if (variant === "throw") throw new Error("private-adapter-secret");
      if (variant === "hang") return new Promise(() => {});
      return emptyFleetSnapshots(other.addresses)[resource];
    } };
    const server = await app(t, authenticated(source), { requestTimeoutMs: 40 });
    const response = await fetch(`${origin(server)}/api/fleet/jobs.json`, options);
    assert.equal(response.status, variant === "hang" ? 504 : 502);
    assert(!JSON.stringify(await response.json()).includes("private-adapter-secret"));
  }
});

test("gateway strips extra raw source fields before finite or progressive publication", async t => {
  const integration: FleetIntegration = { resolveAccess: async () => ({ ...fleet, token: "private-session-token" }), source: { async read(resource, context, _signal, onUpdate) {
    assert.deepEqual(Object.keys(context).sort(), ["addresses", "rosterRevision", "scopeId"]);
    const raw = { ...emptyFleetSnapshots(context.addresses)[resource], accessToken: "private-source-field" };
    onUpdate?.(raw);
    return raw;
  } } };
  const server = await app(t, integration);
  for (const accept of ["application/json", "application/x-ndjson"]) {
    const response = await fetch(`${origin(server)}/api/fleet/sol.json`, { headers: { ...options.headers, Accept: accept } });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert(!body.includes("private-source-field"));
    assert(!body.includes("accessToken"));
  }
});

test("gateway stamps roster and finite/progressive envelopes independently of source timestamps", async t => {
  let now = 1_000;
  const snapshots = emptyFleetSnapshots(fleet.addresses);
  const snapshot = snapshots["node-info"];
  snapshot.hosts[0]!.apiCheck = { status: "online", checkedAtMs: 100,
    lastConfirmed: { status: "online", checkedAtMs: 100 } };
  const source: FleetSource = { async read(resource, _context, _signal, onUpdate) {
    const raw = { ...snapshots[resource], serverTimeMs: -1 };
    now = 1_100;
    onUpdate?.(raw);
    now = 1_200;
    return raw;
  } };
  const server = await app(t, authenticated(source), { now: () => now });
  const roster = await (await fetch(`${origin(server)}/api/fleet/hosts.json`, options)).json();
  assert.equal(roster.serverTimeMs, 1_000);
  const finite = await (await fetch(`${origin(server)}/api/fleet/node-info.json`, options)).json();
  assert.equal(finite.serverTimeMs, 1_200);
  assert.deepEqual(finite.hosts, snapshot.hosts);
  const response = await fetch(`${origin(server)}/api/fleet/node-info.json`, {
    headers: { ...options.headers, Accept: "application/x-ndjson" },
  });
  const frames = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(frames.map(frame => frame.serverTimeMs), [1_100, 1_200]);
  assert.deepEqual(frames.map(frame => frame.complete), [false, true]);
  for (const frame of frames) assert.deepEqual(frame.hosts, snapshot.hosts);
  assert.equal("serverTimeMs" in snapshot, false, "transport clocks are excluded from source observations");
  assert.deepEqual(await (await fetch(`${origin(server)}/api/fleet/connection.json`)).json(), { status: "ok" });
});

test("gateway watch stamps each update and empty progress frame with its emission time", async t => {
  let now = 1_000;
  let publish!: (snapshot: FleetSnapshots["node-info"]) => void;
  const snapshot = emptyFleetSnapshots(fleet.addresses)["node-info"];
  const source: FleetSource = {
    async read(resource, context) { return emptyFleetSnapshots(context.addresses)[resource]; },
    watch<K extends FleetResource>(_resource: K, _context: FleetContext, signal: AbortSignal,
      update: (snapshot: FleetSnapshots[K]) => void): Promise<never> {
      publish = value => update(value as FleetSnapshots[K]);
      publish(snapshot);
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  };
  const server = await app(t, authenticated(source), { now: () => now });
  const controller = new AbortController();
  const response = await fetch(`${origin(server)}/api/fleet/node-info.json`, { signal: controller.signal,
    headers: { ...options.headers, Accept: "application/x-ndjson" } });
  const reader = response.body!.getReader();
  const initial = JSON.parse(new TextDecoder().decode((await reader.read()).value));
  assert.equal(initial.serverTimeMs, 1_000);
  now = 2_000;
  publish({ hosts: [] });
  const progress = JSON.parse(new TextDecoder().decode((await reader.read()).value));
  assert.deepEqual(progress, { hosts: [], complete: false, watching: true, serverTimeMs: 2_000 });
  now = 3_000;
  publish(snapshot);
  const replay = JSON.parse(new TextDecoder().decode((await reader.read()).value));
  assert.equal(replay.serverTimeMs, 3_000);
  assert.deepEqual(replay.hosts, initial.hosts);
  controller.abort(); reader.releaseLock();
});

test("watch updates withheld during access revalidation replay after successful revalidation", async t => {
  const roster = { ...fleet, addresses: [address, second] };
  let resolving!: () => void;
  let release!: () => void;
  const rechecking = new Promise<void>(accept => { resolving = accept; });
  const held = new Promise<void>(accept => { release = accept; });
  let accesses = 0;
  let publish!: (snapshot: FleetSnapshots["node-info"]) => void;
  const source: FleetSource = {
    async read(resource, context) { return emptyFleetSnapshots(context.addresses)[resource]; },
    watch<K extends FleetResource>(_resource: K, _context: FleetContext, signal: AbortSignal, update: (snapshot: FleetSnapshots[K]) => void): Promise<never> {
      publish = snapshot => update(snapshot as FleetSnapshots[K]);
      publish(emptyFleetSnapshots(roster.addresses)["node-info"]);
      return new Promise((_accept, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  };
  const server = await app(t, { source, resolveAccess: async () => {
    if (++accesses === 2) { resolving(); await held; }
    return roster;
  } }, { accessCheckIntervalMs: 50 });
  const controller = new AbortController();
  const response = await fetch(`${origin(server)}/api/fleet/node-info.json`, { signal: controller.signal,
    headers: { Accept: "application/x-ndjson" } });
  const reader = response.body!.getReader(); await reader.read();
  await rechecking;
  publish({ hosts: [{ address, fetchedAtMs: 1_000_000, validUntilMs: 1_030_000, retained: false, error: null,
    values: { state: "QUEUED", dl: null, ul: null, ping: null, networkUnavailableReason: null } }] });
  publish({ hosts: [{ address: second, fetchedAtMs: 1_000_001, validUntilMs: 1_030_001, retained: false, error: null,
    values: { state: "STARTING", dl: null, ul: null, ping: null, networkUnavailableReason: null } }] });
  release();
  const update = JSON.parse(new TextDecoder().decode((await reader.read()).value));
  assert.equal(update.hosts[0].values.state, "QUEUED");
  assert.equal(update.hosts[0].fetchedAtMs, 1_000_000);
  assert.equal(update.hosts[1].values.state, "STARTING");
  assert.equal(update.hosts[1].fetchedAtMs, 1_000_001);
  controller.abort(); reader.releaseLock();
});

test("gateway shutdown aborts active feeds before closing and closes the integration once", async t => {
  const store = createMemorySnapshotStore();
  let closed = 0;
  const integration = { ...authenticated(createSnapshotSource(store)), close: async () => { closed++; } };
  const server = await app(t, integration);
  const response = await fetch(`${origin(server)}/api/fleet/metadata.json`, { headers: { ...options.headers, Accept: "application/x-ndjson" } });
  const reader = response.body!.getReader(); await reader.read();
  const stopped = closeFleetServer(server, integration);
  await assert.rejects(reader.read());
  await stopped;
  assert.equal(closed, 1);
  reader.releaseLock();
});

test("hosted launcher requires explicit trusted local module and validates configuration", async () => {
  assert.throws(() => hostedConfiguration({}), /GRIDLENS_INTEGRATION_MODULE/);
  assert.throws(() => hostedConfiguration({ GRIDLENS_INTEGRATION_MODULE: "https://example.test/module.js" }), /local integration/);
  for (const value of ["0", "-1", "65536", "4x", "1.5"]) {
    assert.throws(() => hostedConfiguration({ GRIDLENS_INTEGRATION_MODULE: "./adapter.js", GRIDLENS_PORT: value }), /GRIDLENS_PORT/);
  }
  assert.equal(hostedConfiguration({ GRIDLENS_INTEGRATION_MODULE: "./adapter.js" }).server.host, "127.0.0.1");
  await assert.rejects(loadIntegration("/nonexistent-private-path/integration.js"), /^Error: The trusted Fleet integration could not be initialized\.$/);
});
