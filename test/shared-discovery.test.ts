import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanComputers, probeComputer } from "../src/backend/ssh.ts";
import type { Computer, ScanOptions } from "../src/backend/ssh.ts";
import { openSharedState } from "../src/backend/sqlite-state.ts";
import { createSharedService } from "../src/backend/service.ts";
import { SharedHttpError } from "../src/backend/ipc.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const pc = (id = "a", suffix = 4): Computer => ({ id: id.repeat(64), host: `192.168.42.${suffix}`, port: 22,
  name: `Synthetic PC ${suffix}`, fingerprint: `SHA256:${id.toUpperCase().repeat(43)}`, hostKey: "generated-public-fixture" });
const status = (expected: number) => (error: unknown): boolean => error instanceof SharedHttpError && error.status === expected;
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function harness(scan: typeof scanComputers) {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-browser-discovery-")), state = openSharedState(directory);
  let now = 1_800_000_000_000;
  const service = createSharedService(state, { scan, now: () => now });
  service.access.setFleet("default", []); service.access.setFleet("other", []);
  const operator = service.access.pair(service.access.createCode("default", "operator").code, "Generated operator");
  const viewer = service.access.pair(service.access.createCode("default", "viewer").code, "Generated viewer");
  const act = (action: string, fields: Record<string, unknown> = {}) => service.read({ operation: "setup-action", token: operator.token,
    revision: service.setup.read("default").revision, action, ...fields });
  return { state, service, operator, viewer, act, get now() { return now; }, advance(ms: number) { now += ms; },
    async close() { await service.setup.close(); await state.close(); await rm(directory, { recursive: true }); } };
}

test("browser scan validates targets, permissions and revisions before changing setup or contacting a computer", async () => {
  let calls = 0; const h = await harness(async () => { calls++; return []; });
  try {
    const before = h.service.setup.read("default");
    for (const range of ["", "8.8.8.8", "127.0.0.1", "169.254.1.1", "192.168.42.0/22", "192.168.42.0/24;command"])
      await assert.rejects(h.act("scan", { range, port: 22 }), status(400));
    for (const port of [0, 65536, 2.5, "22"])
      await assert.rejects(h.act("scan", { range: "192.168.42.0/24", port }), status(400));
    await assert.rejects(h.act("scan", { range: "192.168.42.0/24", revision: 999 }), status(409));
    await assert.rejects(h.service.read({ operation: "setup-action", token: h.viewer.token, action: "scan", revision: 0, range: "192.168.42.0/24" }), status(401));
    assert.deepEqual(h.service.setup.read("default"), before); assert.equal(calls, 0);
  } finally { await h.close(); }
});

test("browser receives scan acknowledgement immediately and polls bounded progress beyond its request timeout", async () => {
  const work = deferred<Computer[]>(); let options: ScanOptions | undefined;
  const h = await harness(async (_range, _port, supplied) => { options = supplied; return work.promise; });
  try {
    const view = await h.act("scan", { range: "192.168.42.0/24", port: 2222 }) as ReturnType<typeof h.service.setup.read>;
    assert.equal(view.phase, "scanning"); assert.equal(view.scan?.total, 256); assert.equal(view.scan?.port, 2222);
    assert.throws(() => h.service.setup.action("other", { action: "scan", revision: 0, range: "192.168.43.0/24" }), status(409));
    h.advance(16_000); options!.onProgress!({ total: 256, completed: 32, found: 1 });
    const progress = h.service.setup.read("default");
    assert.equal(progress.phase, "scanning"); assert.equal(progress.scan?.completed, 32); assert.equal(progress.scan?.found, 1);
    assert.equal(progress.revision, view.revision, "Progress does not invalidate the cancel action revision");
    work.resolve([pc()]); await tick();
    const done = h.service.setup.read("default"); assert.equal(done.phase, "select"); assert.equal(done.scan?.status, "complete");
    assert.equal(done.scan?.completed, 256); assert.equal(done.computers.length, 1);
    assert.deepEqual(h.service.access.fleet("default").addresses, [], "Discovery never enrolls or monitors a host");
  } finally { work.resolve([]); await h.close(); }
});

test("cancel preserves selections and identity history, supports retry and fences all late scan completion", async () => {
  const late = deferred<Computer[]>(); let call = 0, cancelled: AbortSignal | undefined;
  const h = await harness(async (_range, _port, options) => {
    call++; if (call === 2) { cancelled = options?.signal; return late.promise; } return [pc()];
  });
  try {
    await h.service.setup.control({ operation: "setup-scan", scopeId: "default", range: "192.168.42.0/24" });
    const prior = h.service.setup.read("default");
    h.state.set("setup:default", { ...prior, selected: [pc().id], trusted: [pc().id] });
    h.state.set("ssh-identities:default", [pc()]);
    await h.act("scan", { range: "192.168.42.0/24" }); await h.act("cancel-scan");
    assert.equal(cancelled?.aborted, true);
    const stopped = h.service.setup.read("default"); assert.equal(stopped.scan?.status, "cancelled");
    assert.deepEqual(stopped.computers, [pc()]); assert.deepEqual(stopped.selected, [pc().id]);
    await h.act("scan", { range: "192.168.42.0/24" }); await tick();
    const fresh = h.service.setup.read("default");
    late.resolve([pc("b")]); await tick(); assert.deepEqual(h.service.setup.read("default"), fresh);
    assert.deepEqual(h.state.get("ssh-identities:default"), [pc()]);
  } finally { late.resolve([]); await h.close(); }
});

test("failed and interrupted searches retain verified candidates and permit an explicit retry", async () => {
  let fail = false; const h = await harness(async () => { if (fail) throw new Error("sensitive transport details"); return [pc()]; });
  try {
    await h.service.setup.control({ operation: "setup-scan", scopeId: "default", range: "192.168.42.0/24" });
    fail = true; await h.act("scan", { range: "192.168.42.0/24" }); await tick();
    const failed = h.service.setup.read("default"); assert.equal(failed.phase, "scan"); assert.equal(failed.scan?.status, "failed");
    assert.deepEqual(failed.computers, [pc()]); assert.ok(!JSON.stringify(failed).includes("sensitive"));
    h.state.set("setup:default", { ...failed, phase: "scanning", scan: { ...failed.scan, status: "running" } });
    const restarted = createSharedService(h.state, { scan: async () => [pc()], now: () => h.now });
    assert.equal(restarted.setup.read("default").phase, "scan"); assert.equal(restarted.setup.read("default").scan?.status, "failed");
    assert.deepEqual(restarted.setup.read("default").computers, [pc()]);
    await restarted.setup.control({ operation: "setup-scan", scopeId: "default", range: "192.168.42.4" });
    assert.equal(restarted.setup.read("default").scan?.status, "complete"); await restarted.setup.close();
  } finally { await h.close(); }
});

test("verified network hints and terminal presence are terminal-only and do not become credential payloads", async () => {
  const h = await harness(async () => [pc()]);
  try {
    const network = { operation: "setup-network-context", scopeId: "default", backendName: "fixture-backend", backendAddress: "192.168.42.4",
      suggestedRange: "192.168.42.0/24", verifiedAtMs: h.now, releaseTag: "modern-v0.1.0-dev.5" };
    for (const fields of [{ backendAddress: "8.8.8.8" }, { suggestedRange: "192.168.43.0/24" }, { suggestedRange: "192.168.0.0/16" },
      { releaseTag: "modern-v1.0.0\n" }, { releaseTag: "https://foreign.invalid" }, { verifiedAtMs: h.now + 60_001 }])
      await assert.rejects(h.service.control({ ...network, ...fields }), status(400));
    await h.service.control(network); assert.equal(h.service.setup.read("default").network?.suggestedRange, network.suggestedRange);
    await assert.rejects(h.service.read({ ...network, token: h.operator.token }), status(404));
    const revision = h.service.setup.read("default").revision;
    const present = await h.service.control({ operation: "setup-terminal", scopeId: "default" }) as ReturnType<typeof h.service.setup.read>;
    assert.equal(present.terminalConnected, true); assert.equal(present.revision, revision);
    h.advance(30_001); assert.equal(h.service.setup.read("default").terminalConnected, false);
    await h.service.setup.control({ operation: "setup-scan", scopeId: "default", range: "192.168.42.4" });
    let view = h.service.setup.read("default"); h.service.setup.action("default", { action: "select", revision: view.revision, selected: [pc().id] });
    view = h.service.setup.read("default"); h.service.setup.action("default", { action: "trust", revision: view.revision }); view = h.service.setup.read("default");
    await assert.rejects(h.service.control({ operation: "setup-auth", scopeId: "default", revision: view.revision - 1, username: "fixture", password: "generated-secret", remember: false }), status(409));
    await h.service.control({ operation: "setup-auth", scopeId: "default", revision: view.revision, username: "fixture", password: "generated-secret", remember: false });
    assert.equal(h.service.setup.read("default").phase, "review"); assert.ok(!JSON.stringify(h.service.setup.read("default")).includes("generated-secret"));
  } finally { await h.close(); }
});

test("SSH discovery retains eight concurrent probes and cancellation stops further dispatch", async () => {
  const controller = new AbortController(); let active = 0, maximum = 0, dispatched = 0;
  const release: (() => void)[] = [], progress: number[] = [];
  const pending = scanComputers("192.168.42.0/27", 22, { signal: controller.signal, onProgress: value => progress.push(value.completed),
    async probe(_host, port, signal) {
      assert.equal(port, 22); dispatched++; active++; maximum = Math.max(maximum, active);
      try { await new Promise<void>(resolve => { release.push(resolve); signal!.addEventListener("abort", () => resolve(), { once: true }); }); return null; }
      finally { active--; }
    } });
  await tick(); assert.equal(dispatched, 8); assert.equal(maximum, 8);
  for (const done of release.splice(0)) done(); await tick(); assert.equal(dispatched, 16); assert.equal(maximum, 8);
  controller.abort(); await assert.rejects(pending); assert.equal(active, 0); assert.equal(dispatched, 16);
  assert.equal(progress.at(-1), 8);
  assert.equal(await probeComputer("192.168.42.1", 22, controller.signal), null, "Already cancelled probe opens no connection");
});

test("a failed scan worker aborts every other probe before allowing another scan", async () => {
  let active = 0, dispatched = 0;
  await assert.rejects(scanComputers("192.168.42.0/27", 22, { async probe(_host, _port, signal) {
    dispatched++; active++;
    try {
      if (dispatched === 1) { await tick(); throw new Error("generated probe failure"); }
      await new Promise<void>(resolve => signal!.addEventListener("abort", () => resolve(), { once: true })); return null;
    } finally { active--; }
  } }));
  assert.equal(dispatched, 8); assert.equal(active, 0);
});
