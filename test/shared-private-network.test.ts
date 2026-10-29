import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import { openSharedState } from "../src/backend/sqlite-state.ts";
import { createSharedService } from "../src/backend/service.ts";
import { startOwnerSocket } from "../src/backend/ipc.ts";
import { createGatewayIntegration, startSharedGateway } from "../src/backend/gateway.ts";
import { closeFleetServer } from "../src/server/application.ts";
import { emptyFleetSnapshots } from "../src/server/snapshot-store.ts";

const stop = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
test("private-network grant injection is explicit, bounded and unavailable on HTTPS", async () => {
  const token = randomBytes(32).toString("base64url");
  assert.throws(() => createGatewayIntegration("/unused", Buffer.from(""), Buffer.from(""), { privateNetworkToken: token }));
  assert.throws(() => createGatewayIntegration("/unused", Buffer.from(""), Buffer.from(""), { transport: "vpn-http", privateNetworkToken: "bad" }));
  await assert.rejects(startSharedGateway({ publicOrigin: "https://127.0.0.1", privateNetworkAuthFile: "/never-read",
    socketPath: "/unused", directory: "/unused" }), /only on its explicit HTTP gateway/);
  const directory = await mkdtemp(join(tmpdir(), "gridlens-private-grant-"));
  try {
    const file = join(directory, "browser.json");
    for (const value of ["null", "{}", JSON.stringify({ version: 1, token: "bad" }), " ".repeat(1025)]) {
      await writeFile(file, value);
      await assert.rejects(startSharedGateway({ publicOrigin: "http://127.0.0.1", transport: "vpn-http", privateNetworkAuthFile: file,
        socketPath: "/unused", directory: "/unused" }), /Invalid private-network grant file/);
    }
  } finally { await rm(directory, { recursive: true }); }
});

test("plain browser access uses its fixed fleet grant across time, roster changes and restart without exposing credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-plain-browser-"));
  let at = Date.now(), state = openSharedState(join(directory, "state"));
  let service = createSharedService(state, { now: () => at });
  const token = randomBytes(32).toString("base64url"), authFile = join(directory, "browser.json"), socket = join(directory, "ipc", "read.sock");
  const address = "1".repeat(31) + "2", other = "1".repeat(31) + "3";
  let context = service.access.setFleet("fleet-a", [address]); service.access.setFleet("fleet-b", [other]);
  const paired = service.access.pair(service.access.createCode("fleet-a", "viewer").code, "Existing native device");
  const snapshot = emptyFleetSnapshots([address]).metadata; snapshot.hosts[0]!.fetchedAtMs = at - 60_000;
  await state.snapshots.commit(context, { metadata: snapshot }, 0);
  await service.control({ operation: "register-vpn-web", scopeId: "fleet-a", token });
  await writeFile(authFile, JSON.stringify({ version: 1, token }), { mode: 0o600 });
  let owner: Server | undefined, gateway: Awaited<ReturnType<typeof startSharedGateway>> | undefined;
  const start = async () => {
    owner = await startOwnerSocket(socket, service.read);
    gateway = await startSharedGateway({ socketPath: socket, directory: resolve("dist"), publicOrigin: "http://127.0.0.1",
      host: "127.0.0.1", port: 0, transport: "vpn-http", privateNetworkAuthFile: authFile });
  };
  const call = (path: string, { body, headers = {} }: { body?: unknown; headers?: Record<string, string> } = {}) =>
    new Promise<{ status: number; text: string; headers: IncomingHttpHeaders }>((resolve, reject) => {
      const encoded = body === undefined ? undefined : JSON.stringify(body), port = (gateway!.server.address() as { port: number }).port;
      const req = request({ hostname: "127.0.0.1", port, path, method: encoded ? "POST" : "GET", headers: { Host: "127.0.0.1",
        ...(encoded ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(encoded), Origin: "http://127.0.0.1" } : {}), ...headers } }, response => {
        let text = ""; response.on("data", chunk => { text += chunk; }); response.on("error", reject);
        response.on("end", () => resolve({ status: response.statusCode!, text, headers: response.headers }));
      }); req.on("error", reject); req.end(encoded);
    });
  try {
    await start();
    for (const path of ["/", "/setup", "/shared-setup.js", "/api/shared/status", "/api/fleet/metadata.json"]) {
      const result = await call(path); assert.equal(result.status, 200, path);
      assert.equal(result.headers["set-cookie"], undefined); assert.ok(!JSON.stringify(result).includes(token), path);
    }
    const html = (await call("/setup")).text;
    assert.match(html, /name="gridlens-private-network" content="1"/); assert.match(html, /<section id="login" hidden>/);
    const oldLink = await call("/connect"); assert.equal(oldLink.status, 302); assert.equal(oldLink.headers.location, "/#");
    assert.deepEqual(JSON.parse((await call("/api/fleet/metadata.json")).text).hosts, snapshot.hosts);
    const supplied = await call("/api/shared/status", { headers: { Authorization: "invalid", Cookie: "gridlens-vpn=invalid" } });
    assert.equal(supplied.status, 200); assert.equal(JSON.parse(supplied.text).context.scopeId, "fleet-a");
    for (const path of ["pair", "login", "pair-code", "revoke"]) assert.equal((await call(`/api/shared/${path}`, { body: {} })).status, 404);
    assert.equal((await call("/api/shared/devices")).status, 404);
    assert.equal((await call("/api/shared/status", { headers: { Host: "forged.invalid" } })).status, 403);
    assert.equal((await call("/api/shared/status", { headers: { Origin: "http://forged.invalid" } })).status, 403);
    assert.equal((await call("/api/fleet/metadata.json", { headers: { "X-GridLens-Scope": "fleet-b" } })).status, 401);
    at += 7 * 86_400_000;
    assert.equal((await call("/")).status, 200, "no browser sign-in expiry after days");
    const previousRevision = context.rosterRevision;
    context = service.access.setFleet("fleet-a", [other]);
    assert.equal(service.access.resolve(paired.token), null, "native paired device still requires its approved revision");
    assert.equal(JSON.parse((await call("/api/shared/status")).text).context.rosterRevision, context.rosterRevision);
    assert.equal((await call("/api/fleet/metadata.json", { headers: { "X-GridLens-Roster-Revision": previousRevision } })).status, 401);
    await closeFleetServer(gateway!.server, gateway!.integration); gateway = undefined;
    await stop(owner!); owner = undefined; await state.close();
    state = openSharedState(join(directory, "state")); service = createSharedService(state, { now: () => at }); await start();
    assert.equal((await call("/")).status, 200, "saved grant works after owner/gateway restart");
    await service.control({ operation: "revoke-vpn-web", scopeId: "fleet-a" });
    assert.equal((await call("/")).status, 403); assert.equal((await call("/api/shared/status")).status, 401);
    assert.equal(service.access.resolve(paired.token), null);
  } finally {
    if (gateway) await closeFleetServer(gateway.server, gateway.integration);
    if (owner) await stop(owner); await state.close(); await rm(directory, { recursive: true });
  }
});
