import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { UpdateBuild, UpdateOperation } from "../src/contracts/updates.ts";
import { createUpdateEngine } from "../src/updater/engine.ts";
import type { UpdateRuntime } from "../src/updater/engine.ts";
import { CHANNEL_FORMAT, channelURL, discoverUpdate, downloadUpdate, pruneUpdateDownloads, UpdateError } from "../src/updater/release.ts";
import type { VerifiedCandidate } from "../src/updater/release.ts";
import { openUpdateState } from "../src/updater/state.ts";
import type { UpdateStateStore } from "../src/updater/state.ts";
import { SharedHttpError } from "../src/backend/ipc.ts";

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const build = (sequence: number): UpdateBuild => ({ version: `0.1.0-dev.${sequence}`, sequence, buildId: `${sequence}:0.1.0-dev.${sequence}` });
function candidate(sequence = 2): VerifiedCandidate {
  const value = build(sequence), release = { format: "gridlens-modern-release-v1" as const, version: value.version, sequence, platform: "linux-x64" as const,
    minimumCoordinator: 1, imageId: `sha256:${hash(`image-${sequence}`)}`, runtime: { name: `gridlens-runtime-linux-x64-${value.version}.tar`, bytes: 3, sha256: hash("abc") } };
  return { ...value, id: hash(JSON.stringify(release)), sizeBytes: 3, releaseTag: `modern-v${value.version}`, release, workerProtocol: 1 };
}
function memoryStore() {
  let saved: unknown;
  return { read: () => structuredClone(saved), write(value: unknown) { saved = structuredClone(value); }, close() {} } satisfies UpdateStateStore;
}
function runtimeFixture() {
  let current = build(1);
  const calls: string[] = [];
  const runtime: UpdateRuntime = {
    async current() { return current; },
    async prepare(_candidate, _archive, job) { calls.push(`prepare:${job.phase}`); },
    async apply(value, job) { calls.push(`apply:${job.phase}`); current = build(value.sequence); },
    async verify(value, job) { calls.push(`verify:${job.phase}`); assert.equal(current.sequence, value.sequence); },
    async rollback(job) { calls.push(`rollback:${job.phase}`); current = job.previous; return current; },
    async replaceWorker(_value, job) { calls.push(`worker:${job.phase}`); },
    async release() { calls.push("release"); },
  };
  return { runtime, calls, setCurrent(value: UpdateBuild) { current = value; } };
}
async function fixture(overrides: Partial<Parameters<typeof createUpdateEngine>[0]> = {}) {
  const installed = runtimeFixture(), selected = candidate(), store = memoryStore();
  let time = 100_000;
  const engine = await createUpdateEngine({ store, runtime: installed.runtime, directory: "/isolated-updater", platform: "linux-x64", publicKey: "unused injected key",
    automatic: false, now: () => time, random: () => 0, discover: async () => selected, download: async (_candidate, _signal, progress) => { progress(3); return "/isolated-verified-archive"; }, ...overrides });
  return { engine, store, selected, ...installed, advance() { time += 1_000_000; } };
}
const firstKey = "request_fixture_one", secondKey = "request_fixture_two";

test("one durable update survives duplicate starts and executes ordered verified stages", async () => {
  let releaseDownload!: () => void;
  const gate = new Promise<void>(resolve => { releaseDownload = resolve; });
  const f = await fixture({ download: async (_value, _signal, progress) => { await gate; progress(3); return "/verified"; } });
  try {
    assert.equal(f.engine.check().checking, true); await f.engine.idle();
    assert.equal(f.engine.status().candidate?.id, f.selected.id);
    const first = f.engine.start(f.selected.id, firstKey);
    assert.equal(first.operation?.phase, "downloading");
    assert.equal(f.engine.start(f.selected.id, firstKey).operation?.id, first.operation!.id);
    assert.equal(f.engine.start(f.selected.id, secondKey).operation?.id, first.operation!.id);
    releaseDownload(); await f.engine.idle();
    const final = f.engine.status(); assert.equal(final.operation?.phase, "complete"); assert.equal(final.current?.sequence, 2);
    assert.equal(final.candidate, null); assert.equal(final.operation?.downloadedBytes, 3);
    assert.deepEqual(f.calls, ["prepare:preparing", "apply:restarting", "verify:verifying-service", "worker:updating-updater", "verify:updating-updater", "release"]);
    assert.equal(f.engine.start(f.selected.id, secondKey).operation?.id, first.operation!.id);
    assert.throws(() => f.engine.start("a".repeat(64), firstKey), (error: unknown) => error instanceof SharedHttpError && error.status === 409);
  } finally { await f.engine.close(); }
});

test("wrong or changed candidate fails before any runtime mutation", async () => {
  let selected = candidate(); const f = await fixture({ discover: async () => selected });
  try {
    f.engine.check(); await f.engine.idle(); selected = candidate(3); f.advance();
    f.engine.start(candidate().id, firstKey); await f.engine.idle();
    assert.equal(f.engine.status().operation?.phase, "failed"); assert.match(f.engine.status().operation?.error ?? "", /release changed/);
    assert.deepEqual(f.calls, ["release"]); assert.equal(f.engine.status().candidate?.sequence, 3);
  } finally { await f.engine.close(); }
});

test("start reuses a recently verified exact candidate and failed older revalidation establishes shared cooldown", async () => {
  let reads = 0, fail = false;
  const discover = async () => { reads++; if (fail) throw new UpdateError("The signed release could not be checked."); return candidate(); };
  const fresh = await fixture({ discover });
  fresh.engine.check(); await fresh.engine.idle(); fresh.engine.start(fresh.selected.id, firstKey); await fresh.engine.idle();
  assert.equal(reads, 1, "Start must reuse the exact recent signature proof"); await fresh.engine.close();
  const older = await fixture({ discover });
  try {
    older.engine.check(); await older.engine.idle(); older.advance(); fail = true;
    older.engine.start(older.selected.id, firstKey); await older.engine.idle();
    assert.equal(older.engine.status().operation?.phase, "failed");
    assert.equal(older.engine.status().checkError, "The signed release could not be checked.");
    const before = reads; older.engine.check(); await older.engine.idle(); assert.equal(reads, before);
    assert.throws(() => older.engine.start(older.selected.id, secondKey), (error: unknown) => error instanceof SharedHttpError && error.status === 429);
  } finally { await older.engine.close(); }
});

test("service readiness failure rolls back and retains its original reason", async () => {
  const installed = runtimeFixture(); installed.runtime.verify = async () => { throw new UpdateError("The new browser gateway could not read its Fleet cache."); };
  const f = await fixture({ runtime: installed.runtime });
  try {
    f.engine.check(); await f.engine.idle(); f.engine.start(f.selected.id, firstKey); await f.engine.idle();
    const result = f.engine.status(); assert.equal(result.operation?.phase, "rolled-back"); assert.equal(result.current?.sequence, 1);
    assert.equal(result.operation?.error, "The new browser gateway could not read its Fleet cache.");
    assert.ok(installed.calls.includes("rollback:rolling-back"));
  } finally { await f.engine.close(); }
});

test("failed rollback keeps original failure and never claims recovery", async () => {
  const installed = runtimeFixture(); installed.runtime.apply = async () => { throw new UpdateError("Saved endpoint could not be restored."); };
  installed.runtime.rollback = async () => { throw new Error("private implementation detail"); };
  const f = await fixture({ runtime: installed.runtime });
  try {
    f.engine.check(); await f.engine.idle(); f.engine.start(f.selected.id, firstKey); await f.engine.idle();
    assert.equal(f.engine.status().operation?.phase, "failed");
    assert.equal(f.engine.status().operation?.error, "Saved endpoint could not be restored. Recovery could not be verified.");
  } finally { await f.engine.close(); }
});

test("verified backend is restored if worker replacement or its final readiness check fails", async () => {
  const installed = runtimeFixture(); installed.runtime.replaceWorker = async () => { throw new UpdateError("The updated updater could not start."); };
  const f = await fixture({ runtime: installed.runtime });
  try {
    f.engine.check(); await f.engine.idle(); f.engine.start(f.selected.id, firstKey); await f.engine.idle();
    assert.equal(f.engine.status().operation?.phase, "rolled-back"); assert.equal(f.engine.status().current?.sequence, 1);
    assert.equal(f.engine.status().operation?.error, "The updated updater could not start.");
  } finally { await f.engine.close(); }
});

test("updater restart resumes the durable handoff without reapplying or rolling back the backend", async () => {
  const store = memoryStore(), installed = runtimeFixture();
  let reachedHandoff!: () => void;
  const handoff = new Promise<void>(resolve => { reachedHandoff = resolve; });
  installed.runtime.replaceWorker = async (_candidate, _job, signal) => { reachedHandoff(); await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true })); };
  const first = await fixture({ store, runtime: installed.runtime });
  first.engine.check(); await first.engine.idle(); first.engine.start(first.selected.id, firstKey); await handoff;
  await first.engine.close();
  assert.equal((store.read() as { status: { operation: UpdateOperation } }).status.operation.phase, "updating-updater");
  installed.runtime.replaceWorker = async () => {};
  const next = await fixture({ store, runtime: installed.runtime });
  try {
    await next.engine.idle(); assert.equal(next.engine.status().operation?.phase, "complete");
    assert.equal(installed.calls.filter(call => call.startsWith("apply:")).length, 1);
    assert.ok(!installed.calls.some(call => call.startsWith("rollback:")));
  } finally { await next.engine.close(); }
});

test("highest verified sequence and download-service cooldown survive restart while availability is retained", async () => {
  const store = memoryStore(); let selected = candidate(3), failure = false, reads = 0, time = 100_000;
  const discover = async () => { reads++; if (failure) throw new UpdateError("Release checks are waiting for the download service.", 9_000_000); return selected; };
  const first = await fixture({ store, discover, now: () => time });
  first.engine.check(); await first.engine.idle(); failure = true; time += 60_001;
  first.engine.check(); await first.engine.idle(); assert.equal(first.engine.status().candidate?.sequence, 3);
  assert.equal(first.engine.status().nextCheckAtMs, 9_000_000); await first.engine.close();
  const next = await fixture({ store, discover, now: () => time });
  try {
    next.engine.check(); await next.engine.idle(); assert.equal(reads, 2);
    failure = false; selected = candidate(2); time = 9_000_001; next.engine.check(); await next.engine.idle();
    assert.match(next.engine.status().checkError ?? "", /older or conflicting/); assert.equal(next.engine.status().candidate?.sequence, 3);
  } finally { await next.engine.close(); }
});

test("IPC accepts only fixed updater operations with no caller-controlled paths or releases", async () => {
  const f = await fixture();
  try {
    for (const body of [{ operation: "status", path: "/tmp" }, { operation: "start", candidateId: "a".repeat(64), idempotencyKey: firstKey, command: "anything" },
      { operation: "exec" }, { operation: "start", candidateId: "https://invalid.example", idempotencyKey: firstKey }]) {
      await assert.rejects(f.engine.dispatch(body), (error: unknown) => error instanceof SharedHttpError && error.status === 400);
    }
    assert.equal((await f.engine.dispatch({ operation: "status" })).current?.sequence, 1);
  } finally { await f.engine.close(); }
});

test("durable state enforces one owner and reopens after clean close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-update-state-"));
  try {
    const first = openUpdateState(directory); first.write({ operation: "generated fixture" });
    assert.throws(() => openUpdateState(directory)); first.close();
    const next = openUpdateState(directory); assert.deepEqual(next.read(), { operation: "generated fixture" }); next.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("persistence failure fences runtime mutations instead of attempting an unrecorded rollback", async () => {
  const base = memoryStore(), installed = runtimeFixture(); let failing = false;
  const store: UpdateStateStore = { ...base, write(value) { if (failing) throw new Error("generated ambiguous persistence failure"); base.write(value); } };
  const f = await fixture({ store, runtime: installed.runtime, download: async () => { failing = true; return "/verified"; } });
  try {
    f.engine.check(); await f.engine.idle(); f.engine.start(f.selected.id, firstKey); await f.engine.idle();
    assert.throws(() => f.engine.status(), (error: unknown) => error instanceof SharedHttpError && error.status === 503);
    assert.ok(!installed.calls.some(call => /^(apply|rollback|prepare):/.test(call)));
  } finally { await f.engine.close(); }
});

test("signed development channel pins platform, build, manifest and release artifacts", async () => {
  const keys = generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const selected = candidate(), manifest = Buffer.from(JSON.stringify(selected.release));
  const channel = Buffer.from(JSON.stringify({ format: CHANNEL_FORMAT, channel: "development", platform: "linux-x64", ...build(2), releaseTag: selected.releaseTag,
    manifestSha256: hash(manifest), workerProtocol: 1 }));
  const files = new Map<string, Uint8Array>([["modern-channel-linux-x64.json", channel], ["modern-channel-linux-x64.sig", sign(null, channel, keys.privateKey)],
    ["modern-release.json", manifest], ["modern-release.sig", sign(null, manifest, keys.privateKey)]]);
  const fetcher: typeof fetch = async input => { const url = new URL(String(input)); assert.equal(url.hostname, "github.com"); return new Response(files.get(url.pathname.split("/").at(-1)!) as Uint8Array<ArrayBuffer>); };
  assert.deepEqual(await discoverUpdate({ platform: "linux-x64", publicKey, fetch: fetcher }), selected);
  files.set("modern-release.json", Buffer.from(JSON.stringify(candidate(3).release)));
  await assert.rejects(discoverUpdate({ platform: "linux-x64", publicKey, fetch: fetcher }), /manifest does not match/);
  files.set("modern-channel-linux-x64.sig", Buffer.alloc(64));
  await assert.rejects(discoverUpdate({ platform: "linux-x64", publicKey, fetch: fetcher }), /signature verification/);
  assert.match(channelURL("linux-arm64").href, /modern-development\/modern-channel-linux-arm64\.json$/);
});

test("streamed artifact is checksum bounded, atomically retained and reused without another download", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-update-download-")); const selected = candidate(); let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("a")); controller.enqueue(new TextEncoder().encode("bc")); controller.close(); } })); };
  try {
    const progress: number[] = [];
    const path = await downloadUpdate(selected, directory, { fetch: fetcher, onProgress: bytes => progress.push(bytes) });
    assert.equal(await readFile(path, "utf8"), "abc"); assert.deepEqual(progress, [1, 3]);
    assert.equal(await downloadUpdate(selected, directory, { fetch: fetcher }), path); assert.equal(calls, 1);
    await writeFile(path, "bad");
    await assert.rejects(downloadUpdate(selected, directory, { fetch: async () => new Response("toolong") }), /exceeded its signed size/);
    await assert.rejects(readFile(`${path}.partial`), { code: "ENOENT" });
    await assert.rejects(downloadUpdate(selected, directory, { fetch: async () => new Response("xyz") }), /checksum or size/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("download redirects never reach arbitrary hosts and Retry-After is retained as a deadline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-update-boundary-")); let calls = 0;
  try {
    await assert.rejects(downloadUpdate(candidate(), directory, { fetch: async () => { calls++; return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }); } }), /destination is not allowed/);
    assert.equal(calls, 1);
    await assert.rejects(downloadUpdate(candidate(), directory, { fetch: async () => new Response(null, { status: 302, headers: { location: "https://github.com:8443/private" } }) }), /destination is not allowed/);
    await assert.rejects(downloadUpdate(candidate(), directory, { now: () => 1000, fetch: async () => new Response("wait", { status: 429, headers: { "retry-after": "120" } }) }),
      (error: unknown) => error instanceof UpdateError && error.retryAtMs === 121_000);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("archive retention keeps requested recovery pairs and leaves unrelated filenames untouched", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-update-retention-"));
  try {
    const first = candidate(2), second = candidate(3), third = candidate(4), fetcher: typeof fetch = async () => new Response("abc");
    const firstPath = await downloadUpdate(first, directory, { fetch: fetcher });
    const secondPath = await downloadUpdate(second, directory, { fetch: fetcher });
    const thirdPath = await downloadUpdate(third, directory, { fetch: fetcher });
    const unrelated = join(directory, "downloads", "operator-note.txt"); await writeFile(unrelated, "preserve");
    await pruneUpdateDownloads(directory, [third.id, first.id]);
    assert.equal(await readFile(firstPath, "utf8"), "abc"); assert.equal(await readFile(thirdPath, "utf8"), "abc");
    await assert.rejects(readFile(secondPath), { code: "ENOENT" }); assert.equal(await readFile(unrelated, "utf8"), "preserve");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
