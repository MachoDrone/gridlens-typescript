import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { openSharedState } from "../src/backend/sqlite-state.ts";
import { createSharedService } from "../src/backend/service.ts";
import { createGatewayIntegration } from "../src/backend/gateway.ts";
import { startOwnerSocket, SharedHttpError } from "../src/backend/ipc.ts";
import { startFleetServer, closeFleetServer } from "../src/server/application.ts";
import { parseUpdateStatus } from "../src/contracts/updates.ts";
import type { UpdateBuild, UpdateStatus } from "../src/contracts/updates.ts";

const build: UpdateBuild = { version: "0.1.0-fixture", sequence: 1, buildId: "1:0.1.0-fixture" };
const candidate = { version: "0.1.1-fixture", sequence: 2, buildId: "2:0.1.1-fixture", id: "a".repeat(64), sizeBytes: 200 };
const status: UpdateStatus = { version: 1, supported: true, canUpdate: true, checking: false, current: build, candidate,
  checkedAtMs: 1_800_000_000_000, nextCheckAtMs: 1_800_000_060_000, checkError: null, operation: null };
const denied = (code: number) => (error: unknown) => error instanceof SharedHttpError && error.status === code;

test("update authorization precedes updater calls, strips private fields, and follows revocation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-update-access-")), state = openSharedState(directory);
  const calls: Record<string, unknown>[] = [];
  const service = createSharedService(state, { build, updates: async body => { calls.push(body); return { ...status, privatePath: "/never-publish", token: "private" }; } });
  service.access.setFleet("fixture", []);
  const pair = (role: "operator" | "viewer") => service.access.pair(service.access.createCode("fixture", role).code, role);
  const operator = pair("operator"), viewer = pair("viewer");
  try {
    await assert.rejects(service.read({ operation: "updates-status" }), denied(401));
    for (const operation of ["updates-check", "updates-start"]) await assert.rejects(service.read({ operation, token: viewer.token }), denied(401));
    assert.equal(calls.length, 0);
    const visible = parseUpdateStatus(await service.read({ operation: "updates-status", token: viewer.token }));
    assert.equal(visible.canUpdate, false); assert.deepEqual(visible.current, build);
    assert.equal(JSON.stringify(visible).includes("private"), false);
    assert.deepEqual(calls[0], { operation: "status" });
    const start = { operation: "updates-start", token: operator.token, candidateId: candidate.id, idempotencyKey: "fixture-operation" };
    assert.equal((await service.read(start) as UpdateStatus).canUpdate, true);
    assert.deepEqual(calls.at(-1), { operation: "start", candidateId: candidate.id, idempotencyKey: "fixture-operation" });
    for (const extra of [{ command: "docker" }, { path: "/etc" }, { imageId: "arbitrary" }, { url: "https://foreign.invalid" }, { candidateId: "bad" }])
      await assert.rejects(service.read({ ...start, ...extra }), denied(400));
    const before = calls.length;
    service.access.revoke(operator.token, viewer.deviceId);
    await assert.rejects(service.read({ operation: "updates-status", token: viewer.token }), denied(401));
    assert.equal(calls.length, before);
  } finally { await service.setup.close(); await state.close(); await rm(directory, { recursive: true }); }
});

test("an installation without update service reports unsupported and cannot start work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-update-unsupported-")), state = openSharedState(directory);
  const service = createSharedService(state); service.access.setFleet("fixture", []);
  const { token } = service.access.pair(service.access.createCode("fixture", "operator").code, "fixture");
  try {
    const result = parseUpdateStatus(await service.read({ operation: "updates-status", token }));
    assert.equal(result.supported, false); assert.equal(result.canUpdate, false); assert.equal(result.current, null);
    await assert.rejects(service.read({ operation: "updates-check", token }), denied(503));
  } finally { await service.setup.close(); await state.close(); await rm(directory, { recursive: true }); }
});

test("owner readiness verifies cached roster data without requiring fresh or populated metrics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-update-ready-")), state = openSharedState(directory);
  const service = createSharedService(state, { build });
  service.access.setFleet("empty", []); service.access.setFleet("unknown", ["1".repeat(31) + "2"]);
  try {
    const ready = await service.control({ operation: "readiness" }) as { build: UpdateBuild; status: string };
    assert.equal(ready.status, "ready"); assert.deepEqual(ready.build, build);
    await assert.rejects(service.read({ operation: "readiness", scopeId: "arbitrary" }), denied(400));
    await state.close();
    await assert.rejects(service.read({ operation: "readiness" }));
  } finally { await service.setup.close(); await state.close(); await rm(directory, { recursive: true }); }
});

test("browser update routes require exact Origin and bounded bodies; readiness rejects old code and unavailable owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-update-http-")), socket = join(directory, "read.sock"), calls: Record<string, unknown>[] = [];
  const grant = "b".repeat(43); let ownerBuild = build, ownerAvailable = true;
  const owner = await startOwnerSocket(socket, async body => {
    calls.push(body);
    if (body.operation === "readiness") {
      if (!ownerAvailable) throw new Error("private internal path");
      return { version: 1, status: "ready", build: ownerBuild };
    }
    assert.equal(body.token, grant);
    if (body.operation === "resolve") return { scopeId: "fixture", rosterRevision: "1", addresses: [] };
    return status;
  });
  const integration = createGatewayIntegration(socket, Buffer.from("<head></head>"), Buffer.from(""), {
    transport: "vpn-http", privateNetworkToken: grant, build, updatesEnabled: true });
  const server = await startFleetServer({ integration, host: "127.0.0.1", port: 0, publicOrigin: "http://127.0.0.1" });
  const port = (server.address() as { port: number }).port;
  const call = (path: string, body?: unknown, origin: string | null = "http://127.0.0.1", host = "127.0.0.1") =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const bytes = body === undefined ? undefined : JSON.stringify(body);
      const req = request({ hostname: "127.0.0.1", port, path, method: bytes ? "POST" : "GET", headers: {
        Host: host, ...(origin === null ? {} : { Origin: origin }), ...(bytes ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bytes) } : {}),
      } }, response => { let text = ""; response.on("data", part => { text += part; }); response.on("end", () => resolve({ status: response.statusCode!, text })); });
      req.on("error", reject); req.end(bytes);
    });
  try {
    for (const origin of [null, "http://foreign.invalid", "null"]) assert.equal((await call("/api/shared/updates/start", {}, origin)).status, 403);
    assert.equal((await call("/api/shared/updates/check", {}, "http://127.0.0.1", "forged.invalid")).status, 403);
    assert.equal(calls.length, 0);
    assert.equal((await call("/api/shared/updates/start", { candidateId: candidate.id, idempotencyKey: "key", command: "bad" })).status, 400);
    assert.equal((await call("/api/shared/updates/start", { idempotencyKey: "x".repeat(2000) })).status, 413);
    assert.equal((await call("/api/shared/updates?other=1")).status, 405);
    assert.equal((await call("/api/shared/updates/check", {})).status, 200);
    assert.deepEqual(calls.at(-1), { operation: "updates-check", token: grant });
    assert.equal((await call("/api/shared/updates")).status, 200);
    const html = await call("/"); assert.equal(html.status, 200);
    assert.match(html.text, /name="gridlens-updates" content="1"/); assert.match(html.text, /name="gridlens-build-id" content="1:0.1.0-fixture"/);
    assert.equal((await call("/health/ready")).status, 200);
    ownerBuild = { ...build, buildId: "old-code" };
    assert.equal((await call("/health/ready")).status, 503);
    ownerBuild = build; ownerAvailable = false;
    const unavailable = await call("/health/ready"); assert.equal(unavailable.status, 503); assert.ok(!unavailable.text.includes("private"));
    assert.equal((await call("/api/fleet/connection.json")).status, 200, "connection alone still cannot establish update readiness");
  } finally {
    await closeFleetServer(server, integration); owner.closeAllConnections(); await new Promise<void>(resolve => owner.close(() => resolve()));
    await rm(directory, { recursive: true });
  }
});

test("public update parser rejects malformed progress and removes internal worker metadata", () => {
  assert.deepEqual(parseUpdateStatus({ ...status, archivePath: "/private", candidate: { ...candidate, releaseURL: "https://private.invalid" } }), status);
  for (const change of [{ current: { ...build, sequence: -1 } }, { candidate: { ...candidate, id: "foreign" } }, { checkError: "invalid\nmessage" },
    { checkedAtMs: "today" }, { supported: true, current: null }]) assert.throws(() => parseUpdateStatus({ ...status, ...change }));
});
