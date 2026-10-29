import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { startPreviewServer } from "../scripts/preview-server.ts";
import { createJobProvider } from "../scripts/jobs.ts";
import type { JobProvider } from "../scripts/jobs.ts";
import type { HostMetadataProvider } from "../scripts/host-metadata.ts";
import type { OnlineHostsProvider } from "../scripts/online-hosts.ts";
import type { OnlineHostsSnapshot } from "../src/contracts/online-hosts.ts";
import type { HostMetadataSnapshot } from "../src/fleet/host-metadata.ts";
import { normalizeHostMetadata } from "../src/fleet/host-metadata.ts";
import { isFleetSnapshot } from "../src/contracts/fleet.ts";
import { BROWSER_ASSETS } from "../src/server/browser-assets.ts";
import { blankJobHistoryRecord } from "../src/fleet/job-history.ts";

const addresses = Array.from({ length: 5 }, (_, index) => `${"1".repeat(31)}${index + 2}`);
const scenario = "?scenario=online-gpu-hosts";
const resources = ["metadata", "node-info", "jobs", "queue", "sol", "nos", "staking"];
function fixtureAddress(value: number): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let encoded = "";
  let remaining = value;
  while (remaining) { encoded = alphabet[remaining % 58]! + encoded; remaining = Math.floor(remaining / 58); }
  return "1".repeat(32 - Math.ceil(Math.log2(value + 1) / 8)) + encoded;
}
const snapshot = (members: readonly string[], revision = "r1"): OnlineHostsSnapshot => ({
  addresses: [...members], error: null,
  online: { revision, checkedAtMs: 1_000, nextRefreshAtMs: 61_000, retained: false, discoveryError: null },
});
const metadata = (members: readonly string[]): HostMetadataSnapshot => ({ hosts: members.map(address => ({
  address, values: null, fetchedAtMs: null, retained: false, error: null, marketError: null,
})) });

function discovery(initial = snapshot([addresses[2]!])) {
  let current: OnlineHostsSnapshot = { addresses: [], error: "Discovery has not completed.",
    online: { revision: null, checkedAtMs: null, nextRefreshAtMs: 0, retained: false, discoveryError: null } };
  let candidate = initial;
  let calls = 0;
  const provider: OnlineHostsProvider = {
    read: async signal => { signal?.throwIfAborted(); calls++; current = candidate; return current; },
    peek: () => current,
  };
  return { provider, calls: () => calls, next: (value: OnlineHostsSnapshot) => { candidate = value; } };
}

async function fixture(t: TestContext, onlineProvider: OnlineHostsProvider, metadataProvider?: HostMetadataProvider,
  jobProvider?: JobProvider, now?: () => number) {
  const directory = mkdtempSync(join(tmpdir(), "gridlens-online-server-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [filename] of Object.values(BROWSER_ASSETS)) {
    const path = join(directory, filename);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `fixture: ${filename}\n`);
  }
  const hostsFile = join(directory, "hosts.json");
  const real200HostsFile = join(directory, "real200.json");
  writeFileSync(hostsFile, JSON.stringify([addresses[0]]));
  writeFileSync(real200HostsFile, JSON.stringify([addresses[1]]));
  const unexpected = async (): Promise<never> => { throw new Error("Unrequested provider read."); };
  const server = await startPreviewServer({ directory, port: 0, hostsFile, real200HostsFile, onlineProvider,
    metadataProvider: metadataProvider ?? unexpected, nodeInfoProvider: unexpected, jobProvider: jobProvider ?? unexpected,
    queueProvider: unexpected, solProvider: unexpected, nosProvider: unexpected, stakingProvider: unexpected,
    ...(now ? { now } : {}) });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return { server, hostsFile, real200HostsFile };
}

function read(server: Server, path: string, method = "GET", headers: Record<string, string> = {}, onChunk?: () => void) {
  const address = server.address();
  assert(address && typeof address !== "string");
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const outgoing = request({ hostname: "127.0.0.1", port: address.port, path, method, headers }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => { chunks.push(chunk); onChunk?.(); });
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert(predicate(), "Expected server activity did not occur.");
}

test("Online job history including explicit refresh only peeks existing observations", async t => {
  const source = discovery();
  let peeks = 0;
  let reads = 0;
  const jobProvider: JobProvider = async () => { reads++; throw new Error("No assignment discovery."); };
  jobProvider.history = async () => { reads++; throw new Error("No history collection."); };
  jobProvider.peekHistory = members => { peeks++; return { hosts: members.map(blankJobHistoryRecord) }; };
  const { server } = await fixture(t, source.provider, undefined, jobProvider);
  await read(server, `/preview/hosts.json${scenario}`);
  const url = `/preview/job-history.json${scenario}&revision=r1&host=${addresses[2]}`;
  for (const suffix of ["", "&refresh=1"]) {
    const result = await read(server, url + suffix);
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(result.body).onlineRevision, "r1");
    assert.deepEqual(JSON.parse(result.body).hosts, [blankJobHistoryRecord(addresses[2]!)]);
  }
  assert.equal(reads, 0);
  assert.equal(peeks, 2);
  assert.equal((await read(server, url.replace("revision=r1", "revision=old"))).status, 409);
  assert.equal(peeks, 2);
});

test("Online discovery is lazy and fixed scenario files and reads remain isolated", async t => {
  const source = discovery();
  const calls: string[][] = [];
  const { server, hostsFile, real200HostsFile } = await fixture(t, source.provider, async input => {
    calls.push([...input]); return metadata(input);
  });
  assert.equal(source.calls(), 0);
  assert.equal((await read(server, `/preview/hosts.json${scenario}`, "HEAD")).status, 503);
  assert.equal((await read(server, "/preview/hosts.json")).status, 200);
  assert.equal((await read(server, "/preview/hosts.json?scenario=real200")).status, 200);
  await read(server, "/preview/metadata.json");
  await read(server, "/preview/metadata.json?scenario=real200");
  assert.equal(source.calls(), 0);
  assert.deepEqual(calls, [[addresses[0]], [addresses[1]]]);
  const online = await read(server, `/preview/hosts.json${scenario}`);
  assert.equal(online.status, 200);
  assert.deepEqual(JSON.parse(online.body).addresses, [addresses[2]]);
  assert.equal(source.calls(), 1);
  assert.equal((await read(server, `/preview/hosts.json${scenario}`, "HEAD")).status, 200);
  const values = JSON.parse((await read(server, `/preview/metadata.json${scenario}&revision=r1`)).body);
  assert.equal(values.onlineRevision, "r1");
  assert.deepEqual(values.hosts.map((value: { address: string }) => value.address), [addresses[2]]);
  assert.equal(source.calls(), 1);
  assert.deepEqual(JSON.parse(readFileSync(hostsFile, "utf8")), [addresses[0]]);
  assert.deepEqual(JSON.parse(readFileSync(real200HostsFile, "utf8")), [addresses[1]]);
});

test("Online job reads return honest blanks without invoking providers lacking cache-only support", async t => {
  const source = discovery(snapshot(addresses));
  let calls = 0;
  const provider: JobProvider = async () => { calls++; throw new Error("Active collection must not run"); };
  const now = 1_000_000;
  const { server } = await fixture(t, source.provider, undefined, provider, () => now);
  await read(server, `/preview/hosts.json${scenario}`);
  for (const headers of [{}, { Accept: "application/x-ndjson" }]) {
    const result = await read(server, `/preview/jobs.json${scenario}&revision=r1`, "GET", headers);
    assert.equal(result.status, 200);
    const frame = JSON.parse(result.body.trim());
    assert.equal(frame.onlineRevision, "r1");
    assert.equal(frame.nextRefreshAtMs, now + 120_000);
    assert(isFleetSnapshot("jobs", frame, addresses));
    assert(frame.hosts.every((record: { checkedAtMs: number | null; job: unknown; error: unknown; pending: boolean }) =>
      record.checkedAtMs === null && record.job === null && record.error === null && !record.pending));
    if ("Accept" in headers) assert.equal((frame as { complete?: boolean }).complete, true);
  }
  assert.equal(calls, 0);
  assert.equal((await read(server, "/preview/jobs.json?scenario=supplied")).status, 502);
  assert.equal((await read(server, "/preview/jobs.json?scenario=real200")).status, 502);
  assert.equal(calls, 2, "both fixed scenarios retain their active collection path");
});

test("Online finite and streamed job reads reuse fixed-fleet evidence without refreshing or renewing it", async t => {
  const members = addresses.slice(0, 3);
  const source = discovery(snapshot(members));
  let now = 1_000_000;
  const calls: string[] = [];
  const provider = createJobProvider({ now: () => now, fetch: async input => {
    const host = new URL(String(input)).searchParams.get("node")!;
    calls.push(host);
    return Response.json({ jobs: [{ address: fixtureAddress(10_000 + addresses.indexOf(host)), node: host,
      state: 1, timeStart: 900, timeEnd: 0, timeout: 600 }], totalJobs: 1 });
  } });
  const peek = provider.peek!;
  let cacheReads = 0;
  provider.peek = input => { cacheReads++; return peek(input); };
  const { server } = await fixture(t, source.provider, undefined, provider, () => now);
  await read(server, `/preview/hosts.json${scenario}`);
  assert.equal((await read(server, `/preview/jobs.json${scenario}&revision=old`)).status, 409);
  assert.equal((await read(server, `/preview/jobs.json${scenario}&revision=r1`, "HEAD")).status, 200);
  assert.equal(cacheReads, 0, "invalid revisions and HEAD do not even read cached observations");
  const initial = JSON.parse((await read(server, `/preview/jobs.json${scenario}&revision=r1`)).body);
  assert(initial.hosts.every((record: { job: unknown }) => record.job === null));
  assert.equal(calls.length, 0);
  const supplied = JSON.parse((await read(server, "/preview/jobs.json?scenario=supplied")).body);
  const real200 = JSON.parse((await read(server, "/preview/jobs.json?scenario=real200")).body);
  assert.deepEqual(calls, addresses.slice(0, 2));
  now += 240_000;
  for (const headers of [{}, { Accept: "application/x-ndjson" }]) {
    const result = await read(server, `/preview/jobs.json${scenario}&revision=r1`, "GET", headers);
    const frame = JSON.parse(result.body.trim());
    assert.equal(result.status, 200);
    assert.equal(frame.onlineRevision, "r1");
    assert.equal(frame.nextRefreshAtMs, now + 120_000);
    assert.deepEqual(frame.hosts.slice(0, 2), [...supplied.hosts, ...real200.hosts]);
    assert.equal(frame.hosts[2].job, null);
    assert.equal(frame.hosts[2].checkedAtMs, null);
    assert(frame.hosts[0].validUntilMs < now, "expired source evidence is not renewed by a cache read");
    if ("Accept" in headers) assert.equal(frame.complete, true);
  }
  assert.equal(cacheReads, 3);
  assert.equal(calls.length, 2);
});

test("Online parameters reject unknown, duplicate, missing and stale selections without discovery or data reads", async t => {
  const source = discovery();
  let dataReads = 0;
  const { server } = await fixture(t, source.provider, async input => { dataReads++; return metadata(input); });
  for (const query of ["?scenario=unknown", `${scenario}&scenario=supplied`, `${scenario}&revision=r1`, `${scenario}&revision=r1&revision=r1`]) {
    assert.equal((await read(server, `/preview/hosts.json${query}`)).status, 400);
  }
  for (const resource of resources) {
    for (const query of [`${scenario}&revision=`, `${scenario}&revision=../x`, `${scenario}&revision=r1&revision=r1`]) {
      assert.equal((await read(server, `/preview/${resource}.json${query}`)).status, 400);
    }
    for (const method of ["GET", "HEAD"]) {
      assert.equal((await read(server, `/preview/${resource}.json${scenario}`, method)).status, 409);
      assert.equal((await read(server, `/preview/${resource}.json${scenario}&revision=r1`, method)).status, 409);
    }
  }
  assert.equal(source.calls(), 0);
  assert.equal(dataReads, 0);
  await read(server, `/preview/hosts.json${scenario}`);
  for (const resource of resources) {
    assert.equal((await read(server, `/preview/${resource}.json${scenario}&revision=old`)).status, 409);
    assert.equal((await read(server, `/preview/${resource}.json${scenario}&revision=r1`, "HEAD")).status, 200);
  }
  assert.equal(source.calls(), 1);
  assert.equal(dataReads, 0);
});

test("Online initial failure stays unavailable, retained failure preserves membership, and confirmed empty dispatches no data", async t => {
  const source = discovery({ addresses: [], error: "Discovery unavailable.",
    online: { revision: null, checkedAtMs: null, nextRefreshAtMs: 61_000, retained: false, discoveryError: "Discovery unavailable." } });
  let reads = 0;
  const { server } = await fixture(t, source.provider, async input => { reads++; return metadata(input); });
  assert.equal((await read(server, `/preview/hosts.json${scenario}`)).status, 503);
  source.next(snapshot([addresses[2]!]));
  await read(server, `/preview/hosts.json${scenario}`);
  source.next({ ...snapshot([addresses[2]!]), online: { ...snapshot([]).online, retained: true, discoveryError: "Temporary outage." } });
  const retained = await read(server, `/preview/hosts.json${scenario}`);
  assert.equal(retained.status, 200);
  assert.equal(JSON.parse(retained.body).online.retained, true);
  assert.equal((await read(server, `/preview/metadata.json${scenario}&revision=r1`)).status, 200);
  assert.equal(reads, 1);
  source.next(snapshot([], "r2"));
  assert.deepEqual(JSON.parse((await read(server, `/preview/hosts.json${scenario}`)).body).addresses, []);
  for (const resource of resources) {
    const result = await read(server, `/preview/${resource}.json${scenario}&revision=r2`);
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body).hosts, []);
    assert.equal(JSON.parse(result.body).onlineRevision, "r2");
  }
  assert.equal(reads, 1);
});

test("a membership revision cancels only old Online reads and rejects their late results", async t => {
  const source = discovery();
  const calls: { addresses: readonly string[]; signal: AbortSignal; release: () => void }[] = [];
  const { server } = await fixture(t, source.provider, async (input, signal) => {
    assert(signal);
    await new Promise<void>(resolve => calls.push({ addresses: [...input], signal, release: resolve }));
    return metadata(input);
  });
  await read(server, `/preview/hosts.json${scenario}`);
  const oldRead = read(server, `/preview/metadata.json${scenario}&revision=r1`);
  const fixedRead = read(server, "/preview/metadata.json");
  await until(() => calls.length === 2);
  source.next(snapshot([addresses[3]!], "r2"));
  await read(server, `/preview/hosts.json${scenario}`);
  const old = calls.find(call => call.addresses[0] === addresses[2])!;
  const fixed = calls.find(call => call.addresses[0] === addresses[0])!;
  assert(old.signal.aborted);
  assert.equal(fixed.signal.aborted, false);
  assert.equal((await oldRead).status, 409);
  old.release();
  fixed.release();
  assert.equal((await fixedRead).status, 200);
  const currentRead = read(server, `/preview/metadata.json${scenario}&revision=r2`);
  await until(() => calls.length === 3);
  assert.deepEqual(calls[2]!.addresses, [addresses[3]]);
  calls[2]!.release();
  const current = JSON.parse((await currentRead).body);
  assert.equal(current.onlineRevision, "r2");
  assert.deepEqual(current.hosts.map((value: { address: string }) => value.address), [addresses[3]]);
});

test("unchanged membership preserves active watches and changed membership closes the captured revision", async t => {
  const source = discovery();
  let watching: AbortSignal | undefined;
  const provider: HostMetadataProvider = async input => metadata(input);
  provider.watch = async (input, signal, emit) => {
    watching = signal;
    emit(metadata(input));
    return new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  const { server } = await fixture(t, source.provider, provider);
  await read(server, `/preview/hosts.json${scenario}`);
  const stream = read(server, `/preview/metadata.json${scenario}&revision=r1`, "GET", { Accept: "application/x-ndjson" });
  await until(() => watching !== undefined);
  source.next({ ...snapshot([addresses[2]!]), online: { ...snapshot([]).online, checkedAtMs: 2_000 } });
  await read(server, `/preview/hosts.json${scenario}`);
  assert.equal(watching!.aborted, false);
  source.next(snapshot([addresses[3]!], "r2"));
  await read(server, `/preview/hosts.json${scenario}`);
  assert(watching!.aborted);
  const result = await stream;
  const frames = result.body.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(result.status, 200);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].onlineRevision, "r1");
  assert.equal(frames[0].complete, false);
});

test("the Online scenario serves every member of a 1044-host roster without truncation", async t => {
  const members = Array.from({ length: 1_044 }, (_, index) => fixtureAddress(index + 100));
  const source = discovery(snapshot(members));
  let reads = 0;
  const { server } = await fixture(t, source.provider, async input => { reads++; return metadata(input); });
  const roster = JSON.parse((await read(server, `/preview/hosts.json${scenario}`)).body);
  assert.deepEqual(roster.addresses, members);
  const finite = JSON.parse((await read(server, `/preview/metadata.json${scenario}&revision=r1`)).body);
  assert.equal(finite.hosts.length, members.length);
  const stream = await read(server, `/preview/metadata.json${scenario}&revision=r1`, "GET", { Accept: "application/x-ndjson" });
  const complete = JSON.parse(stream.body.trim());
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.hosts.map((value: { address: string }) => value.address), members);
  assert.equal(reads, 2);
});

test("retention capacity rejects an injected replacement without changing the active roster or revision", async t => {
  const members = Array.from({ length: 5_001 }, (_, index) => fixtureAddress(index + 100));
  const source = discovery(snapshot(members));
  const { server } = await fixture(t, source.provider, async input => metadata(input));
  assert.deepEqual(JSON.parse((await read(server, `/preview/hosts.json${scenario}`)).body).addresses, members);
  source.next(snapshot([], "too-many-departures"));
  const retained = JSON.parse((await read(server, `/preview/hosts.json${scenario}`)).body);
  assert.deepEqual(retained.addresses, members);
  assert.equal(retained.online.revision, "r1");
  assert.equal(retained.online.retained, true);
  assert.match(retained.online.discoveryError, /capacity/);
  assert.equal((await read(server, `/preview/metadata.json${scenario}&revision=too-many-departures`)).status, 409);
  assert.equal((await read(server, `/preview/metadata.json${scenario}&revision=r1`)).status, 200);
});

test("unexpected synchronous discovery errors remain bounded and preserve an established roster", async t => {
  const source = discovery();
  let fail = false;
  const provider: OnlineHostsProvider = { ...source.provider, read: signal => {
    if (fail) throw new Error("private implementation detail must not leave the provider");
    return source.provider.read(signal);
  } };
  const { server } = await fixture(t, provider);
  await read(server, `/preview/hosts.json${scenario}`);
  fail = true;
  const result = await read(server, `/preview/hosts.json${scenario}`);
  assert.equal(result.status, 200);
  const retained = JSON.parse(result.body);
  assert.deepEqual(retained.addresses, [addresses[2]]);
  assert.equal(retained.online.revision, "r1");
  assert.equal(retained.online.retained, true);
  assert.doesNotMatch(result.body, /private implementation detail/);
});

test("2000-host normalized metadata fits bounded Online replay and final stream frames", async t => {
  const members = Array.from({ length: 2_000 }, (_, index) => fixtureAddress(index + 100));
  const source = discovery(snapshot(members));
  const complete: HostMetadataSnapshot = { hosts: members.map(address => ({
    address, values: { ...normalizeHostMetadata(address, { nodeAddress: address, status: "界".repeat(64),
      marketAddress: members[0], metrics: { cpu: { cpu_model: "界".repeat(256) },
        gpu: { cuda_driver_version: "界".repeat(64), nvml_driver_version: "界".repeat(64) },
        package_version: "界".repeat(64), system_environment: "界".repeat(256), ram_gb: 100, disk_gb: 100 } }),
    marketLabel: "界".repeat(256) }, fetchedAtMs: 1_000, retained: false, error: null, marketError: null,
  })) };
  assert(isFleetSnapshot("metadata", complete, members));
  const byteLength = Buffer.byteLength(JSON.stringify(complete));
  assert(byteLength > 2 * 1024 * 1024 && byteLength < 8 * 1024 * 1024);
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { server } = await fixture(t, source.provider, async (_input, _signal, emit) => {
    calls++;
    emit?.(complete);
    await gate;
    return complete;
  });
  await read(server, `/preview/hosts.json${scenario}`);
  const headers = { Accept: "application/x-ndjson" };
  let firstProgress = false;
  const first = read(server, `/preview/metadata.json${scenario}&revision=r1`, "GET", headers, () => { firstProgress = true; });
  await until(() => firstProgress);
  let joinedProgress = false;
  const joined = read(server, `/preview/metadata.json${scenario}&revision=r1`, "GET", headers, () => { joinedProgress = true; });
  await until(() => joinedProgress);
  assert.equal(calls, 1);
  release();
  for (const response of await Promise.all([first, joined])) {
    assert.equal(response.status, 200);
    const frames = response.body.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(frames.length, 2);
    assert.equal(frames[0].complete, false);
    assert.equal(frames[1].complete, true);
    for (const frame of frames) {
      assert.equal(frame.onlineRevision, "r1");
      assert(isFleetSnapshot("metadata", frame, members));
    }
  }
});
