import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { request } from "node:https";
import type { Server } from "node:http";
import { openSharedState } from "../src/backend/sqlite-state.ts";
import { createSharedService } from "../src/backend/service.ts";
import { createAccess, AccessError } from "../src/backend/access.ts";
import { startOwnerSocket, SharedHttpError } from "../src/backend/ipc.ts";
import { createGatewayIntegration, requestToken } from "../src/backend/gateway.ts";
import { startFleetServer, closeFleetServer } from "../src/server/application.ts";
import { emptyFleetSnapshots } from "../src/server/snapshot-store.ts";
import { scanAddresses } from "../src/backend/ssh.ts";
import { startSharedOwner } from "../scripts/shared-owner.ts";
const address = "1".repeat(31) + "2";
const stop = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });

test("connection codes are one-use, short-lived, role/scoped, and revocations survive owner restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-access-")); let at = 1_800_000_000_000;
  let state = openSharedState(directory, { now: () => at });
  try {
    let access = createAccess(state, () => at); const context = access.setFleet("fleet-a", [address]);
    const code = access.createCode("fleet-a", "operator"), operator = access.pair(code.code, "Generated browser");
    assert.throws(() => access.pair(code.code, "Replay"), AccessError);
    const viewer = access.pair(access.createCode("fleet-a", "viewer").code, "Generated phone");
    assert.throws(() => access.revoke(viewer.token, operator.deviceId), AccessError);
    access.revoke(operator.token, viewer.deviceId); assert.equal(access.resolve(viewer.token), null);
    const secretText = JSON.stringify(state.get("access.v1")); assert.ok(!secretText.includes(operator.token)); assert.ok(!secretText.includes(code.code));
    const serverId = access.serverId; await state.close(); state = openSharedState(directory, { now: () => at }); access = createAccess(state, () => at);
    assert.equal(access.serverId, serverId); assert.equal(access.resolve(viewer.token), null); assert.deepEqual(access.resolve(operator.token)?.context, context);
    const expired = access.createCode("fleet-a", "viewer"); at += 300_001; assert.throws(() => access.pair(expired.code, "Late"), AccessError);
    access.setFleet("fleet-a", []); assert.equal(access.resolve(operator.token), null);
  } finally { await state.close(); await rm(directory, { recursive: true }); }
});

test("owner never accepts public setup secrets, foreign scopes, viewer mutations or unbounded history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-service-")), state = openSharedState(directory);
  try {
    const service = createSharedService(state); const context = service.access.setFleet("fleet-a", [address]);
    const viewer = service.access.pair(service.access.createCode("fleet-a", "viewer").code, "Phone");
    await assert.rejects(service.read({ operation: "snapshot", token: viewer.token, scopeId: "other", rosterRevision: context.rosterRevision, resource: "metadata" }), SharedHttpError);
    await assert.rejects(service.read({ operation: "pair-code", token: viewer.token }), SharedHttpError);
    await assert.rejects(service.read({ operation: "history-request", token: viewer.token, rosterRevision: context.rosterRevision, addresses: Array(101).fill(address), refresh: true }), SharedHttpError);
    await assert.rejects(service.read({ operation: "setup-auth", token: viewer.token, password: "generated" }), SharedHttpError);
    const result = await service.read({ operation: "snapshot", token: viewer.token, scopeId: context.scopeId, rosterRevision: context.rosterRevision, resource: "metadata" });
    assert.deepEqual(result, emptyFleetSnapshots([address]).metadata);
  } finally { await state.close(); await rm(directory, { recursive: true }); }
});

test("real HTTPS gateway pairs web/phone to identical dated snapshots and denies revoked or changed identity access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-https-")), state = openSharedState(join(directory, "state"));
  const certPath = join(directory, "cert.pem"), keyPath = join(directory, "key.pem");
  const generated = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath,
    "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
  assert.equal(generated.status, 0);
  const service = createSharedService(state), context = service.access.setFleet("fleet-a", [address]);
  const snapshot = emptyFleetSnapshots([address]).metadata; const checked = Date.now() - 60_000;
  snapshot.hosts[0]!.fetchedAtMs = checked; await state.snapshots.commit(context, { metadata: snapshot }, 0);
  const socket = join(directory, "ipc", "read.sock"), owner = await startOwnerSocket(socket, service.read);
  const integration = createGatewayIntegration(socket, Buffer.from("<!doctype html><title>Setup</title>"), Buffer.from(""));
  const cert = await readFile(certPath), server = await startFleetServer({ integration, port: 0, host: "127.0.0.1", publicOrigin: "https://localhost",
    tls: { cert, key: await readFile(keyPath) } });
  const port = (server.address() as { port: number }).port;
  const call = (path: string, { body, token, cookie, host = "localhost", revision }: { body?: unknown; token?: string; cookie?: string; host?: string; revision?: string } = {}) => new Promise<{ status: number; value: Record<string, unknown>; cookie?: string }>((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ hostname: "127.0.0.1", servername: "localhost", port, path, ca: cert,
      method: encoded ? "POST" : "GET", headers: { Host: host, ...(encoded ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(encoded) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(revision ? { "X-GridLens-Roster-Revision": revision } : {}) } }, response => {
      let text = ""; response.on("data", chunk => { text += chunk; }); response.on("end", () => resolve({ status: response.statusCode!, value: JSON.parse(text),
        ...(response.headers["set-cookie"]?.[0] ? { cookie: response.headers["set-cookie"][0] } : {}) }));
    }); req.on("error", reject); req.end(encoded);
  });
  try {
    const web = await call("/api/shared/login", { body: { version: 1, code: service.access.createCode("fleet-a", "operator").code, deviceName: "Web" } });
    assert.equal(web.status, 200); assert.equal(web.value.token, undefined); assert.match(web.cookie!, /Secure; HttpOnly; SameSite=Strict/);
    const phone = await call("/api/shared/pair", { body: { version: 1, code: service.access.createCode("fleet-a", "viewer").code, deviceName: "Phone" } });
    const token = phone.value.token as string, cookie = web.cookie!.split(";", 1)[0]!;
    const a = await call("/api/fleet/metadata.json", { token }), b = await call("/api/fleet/metadata.json", { cookie });
    assert.equal(a.status, 200); assert.equal(b.status, 200); assert.deepEqual(a.value.hosts, b.value.hosts); assert.deepEqual(a.value.hosts, snapshot.hosts);
    assert.equal((await call("/api/fleet/metadata.json", { token, revision: "old" })).status, 401);
    assert.equal((await call("/api/shared/status", { token, host: "forged.invalid" })).status, 403);
    const revoke = await call("/api/shared/revoke", { cookie, body: { deviceId: phone.value.deviceId } }); assert.equal(revoke.status, 200);
    assert.equal((await call("/api/fleet/metadata.json", { token })).status, 401);
    assert.equal((await call("/api/shared/setup-action", { cookie, body: { action: "inspect", password: "must-not-enter-browser" } })).status, 400);
  } finally { await closeFleetServer(server, integration); await stop(owner); await state.close(); await rm(directory, { recursive: true }); }
});

test("scan targets are explicit bounded private networks and invalid bearer never falls back to a cookie", () => {
  assert.equal(scanAddresses("192.168.42.0/24").length, 256);
  assert.throws(() => scanAddresses("10.0.0.0/8")); assert.throws(() => scanAddresses("8.8.8.8"));
  assert.equal(requestToken({ headers: { authorization: "bad", cookie: `__Host-gridlens=${"a".repeat(43)}` } } as never), null);
});

test("operator monitoring revocation fences collection separately from device access and survives restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-monitor-access-")); let state = openSharedState(directory);
  try {
    let service = createSharedService(state), context = service.access.setFleet("fleet-a", [address]);
    const pcId = "a".repeat(64), binding = { pcId, runtime: "docker" as const, wrapperId: null, nodeContainerId: "b".repeat(64) };
    service.observations.associate(context, [{ address, binding, name: "Synthetic PC", sshFingerprint: "SHA256:" + "A".repeat(43), verifiedAtMs: Date.now(), privateIp: null, gpuUuids: [] }]);
    state.set(`permission:fleet-a:${pcId}`, { version: 1, computer: { id: pcId, name: "Synthetic PC" }, associations: [], rosterRevision: context.rosterRevision,
      automaticIp: true, rewards: true, gpu: true, approvedAtMs: Date.now(), revokedAtMs: null, paused: false });
    const operator = service.access.pair(service.access.createCode("fleet-a", "operator").code, "Operator");
    const viewer = service.access.pair(service.access.createCode("fleet-a", "viewer").code, "Viewer");
    await assert.rejects(service.read({ operation: "monitoring-action", token: viewer.token, pcId, action: "revoke" }), SharedHttpError);
    await service.read({ operation: "monitoring-action", token: operator.token, pcId, action: "revoke" });
    assert.ok(state.get<{ revokedAtMs: number }>(`permission:fleet-a:${pcId}`)!.revokedAtMs);
    assert.notEqual(service.access.resolve(viewer.token), null, "revoking collection is independent of cached reading access");
    await state.close(); state = openSharedState(directory); service = createSharedService(state); context = service.access.fleet("fleet-a");
    assert.equal(state.get<{ paused: boolean }>(`permission:fleet-a:${pcId}`)?.paused, true);
    assert.equal((await service.read({ operation: "snapshot", token: viewer.token, scopeId: context.scopeId, rosterRevision: context.rosterRevision, resource: "metadata" }) as { hosts: unknown[] }).hosts.length, 1);
  } finally { await state.close(); await rm(directory, { recursive: true }); }
});

test("interrupted real owner startup releases its lifetime lock and retains server identity for retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-owner-start-"));
  const environment = { GRIDLENS_STATE_DIR: join(directory, "state"), GRIDLENS_LEDGER_DIR: join(directory, "ledger"),
    GRIDLENS_CREDENTIAL_DIR: join(directory, "credentials"), GRIDLENS_SOCKET_DIR: join(directory, "read"), GRIDLENS_CONTROL_DIR: join(directory, "bad-control") };
  try {
    await writeFile(environment.GRIDLENS_CONTROL_DIR, "ordinary file must remain unchanged");
    await assert.rejects(startSharedOwner(environment));
    assert.equal(await readFile(environment.GRIDLENS_CONTROL_DIR, "utf8"), "ordinary file must remain unchanged");
    const first = await startSharedOwner({ ...environment, GRIDLENS_CONTROL_DIR: join(directory, "control") });
    const identity = first.service.access.serverId; await first.close();
    const second = await startSharedOwner({ ...environment, GRIDLENS_CONTROL_DIR: join(directory, "control") });
    assert.equal(second.service.access.serverId, identity); await second.close();
  } finally { await rm(directory, { recursive: true }); }
});
