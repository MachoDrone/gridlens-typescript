import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import { openSharedState } from "../src/backend/sqlite-state.ts";
import { createSharedService } from "../src/backend/service.ts";
import { startOwnerSocket } from "../src/backend/ipc.ts";
import { requestToken, startSharedGateway, validateGatewayOrigin } from "../src/backend/gateway.ts";
import { closeFleetServer } from "../src/server/application.ts";
import { emptyFleetSnapshots } from "../src/server/snapshot-store.ts";

const address = "1".repeat(31) + "2";
const stop = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });

test("private HTTP requires explicit startup opt-in and an exact private IP origin", async () => {
  for (const origin of ["http://10.50.0.8:2342", "http://172.16.1.2:2342", "http://192.168.42.8:2342", "http://127.0.0.1", "http://[fd00::8]:2342", "http://[::1]:2342"])
    assert.doesNotThrow(() => validateGatewayOrigin(origin, "vpn-http"));
  for (const origin of ["http://0.0.0.0:2342", "http://8.8.8.8:2342", "http://172.32.0.1:2342", "http://169.254.1.2:2342", "http://100.64.0.1:2342", "http://[::]:2342",
    "http://[2001:4860:4860::8888]:2342", "http://example.org:2342", "http://localhost:2342", "http://127.1:2342", "http://127.0.0.1:2342/", "http://127.0.0.1:2342/connect",
    "http://127.0.0.1:2342?code=secret", "http://127.0.0.1:2342#secret", "http://name@127.0.0.1:2342", "https://127.0.0.1:2342"])
    assert.throws(() => validateGatewayOrigin(origin, "vpn-http"), origin);
  await assert.rejects(startSharedGateway({ socketPath: "/not-used.sock", directory: "/not-used", publicOrigin: "http://127.0.0.1:2342" }), /canonical origin/);
  assert.doesNotThrow(() => validateGatewayOrigin("https://192.168.42.8:2341"));
});

test("session cookies are selected only by the configured transport, with duplicates and invalid bearer rejected", () => {
  const token = "a".repeat(43), secure = `__Host-gridlens=${token}`, privateCookie = `gridlens-vpn=${token}`;
  const read = (cookie: string, transport: "https" | "vpn-http", headers = {}) => requestToken({ headers: { cookie, ...headers } } as never, transport);
  assert.equal(read(privateCookie, "vpn-http"), token);
  assert.equal(read(secure, "https"), token);
  assert.equal(read(privateCookie, "https"), null);
  assert.equal(read(secure, "vpn-http"), null);
  assert.equal(read(`${privateCookie}; ${privateCookie}`, "vpn-http"), null);
  assert.equal(read(`${secure}; ${secure}`, "https"), null);
  assert.equal(read("gridlens-vpn=bad", "vpn-http"), null);
  assert.equal(read(privateCookie, "vpn-http", { authorization: "bad" }), null);
  assert.equal(read(privateCookie, "https", { "x-forwarded-proto": "http" }), null);
  assert.equal(read(secure, "vpn-http", { "x-forwarded-proto": "https" }), null);
  // A browser visiting both endpoints can send both names to HTTPS; only its secure name is used.
  assert.equal(read(`${privateCookie}; ${secure}`, "https"), token);
});

test("actual private HTTP gateway pairs browsers, shares dated cache, keeps access checks and redirects signed-out visits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-private-http-"));
  const state = openSharedState(join(directory, "state")), service = createSharedService(state);
  const context = service.access.setFleet("synthetic-fleet", [address]);
  const snapshot = emptyFleetSnapshots([address]).metadata;
  snapshot.hosts[0]!.fetchedAtMs = Date.now() - 60_000;
  await state.snapshots.commit(context, { metadata: snapshot }, 0);
  const socket = join(directory, "ipc", "read.sock"), owner = await startOwnerSocket(socket, service.read);
  let gateway: Awaited<ReturnType<typeof startSharedGateway>> | undefined;
  try {
    gateway = await startSharedGateway({ socketPath: socket, directory: resolve("dist"), publicOrigin: "http://127.0.0.1",
      transport: "vpn-http", host: "127.0.0.1", port: 0,
      certPath: join(directory, "absent-cert.pem"), keyPath: join(directory, "absent-key.pem") });
    const port = (gateway.server.address() as { port: number }).port;
    const call = (path: string, { body, headers = {} }: { body?: unknown; headers?: Record<string, string> } = {}) =>
      new Promise<{ status: number; text: string; headers: IncomingHttpHeaders }>((resolve, reject) => {
        const encoded = body === undefined ? undefined : JSON.stringify(body);
        const req = request({ hostname: "127.0.0.1", port, path, method: encoded ? "POST" : "GET", headers: { Host: "127.0.0.1",
          ...(encoded ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(encoded), Origin: "http://127.0.0.1" } : {}), ...headers } }, response => {
          let text = ""; response.on("data", chunk => { text += chunk; }); response.on("error", reject);
          response.on("end", () => resolve({ status: response.statusCode!, text, headers: response.headers }));
        }); req.on("error", reject); req.end(encoded);
      });
    const signedOut = await call("/"); assert.equal(signedOut.status, 302); assert.equal(signedOut.headers.location, "/connect");
    assert.equal((await call("/connect")).status, 200);
    assert.equal((await call("/api/fleet/metadata.json")).status, 401);
    const code = service.access.createCode("synthetic-fleet", "operator").code;
    const login = await call("/api/shared/login", { body: { version: 1, code, deviceName: "Generated browser" }, headers: { "X-Forwarded-Proto": "https" } });
    assert.equal(login.status, 200); assert.equal(JSON.parse(login.text).token, undefined);
    const setCookie = login.headers["set-cookie"]![0]!;
    assert.match(setCookie, /^gridlens-vpn=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict$/);
    const cookie = setCookie.split(";", 1)[0]!;
    assert.equal((await call("/api/shared/login", { body: { version: 1, code, deviceName: "Replay" } })).status, 401);
    assert.equal((await call("/", { headers: { Cookie: cookie } })).status, 200);
    const first = await call("/api/fleet/metadata.json", { headers: { Cookie: cookie } });
    assert.equal(first.status, 200); assert.deepEqual(JSON.parse(first.text).hosts, snapshot.hosts);
    const second = await call("/api/shared/login", { body: { version: 1, code: service.access.createCode("synthetic-fleet", "viewer").code, deviceName: "Generated mobile browser" } });
    const secondCookie = second.headers["set-cookie"]![0]!.split(";", 1)[0]!;
    const secondRead = await call("/api/fleet/metadata.json", { headers: { Cookie: secondCookie } });
    assert.equal(secondRead.status, 200); assert.deepEqual(JSON.parse(secondRead.text).hosts, snapshot.hosts);
    assert.equal((await call("/api/shared/status", { headers: { Cookie: cookie.replace("gridlens-vpn=", "__Host-gridlens=") } })).status, 401);
    assert.equal((await call("/api/shared/status", { headers: { Cookie: `${cookie}; ${cookie}` } })).status, 401);
    assert.equal((await call("/api/shared/status", { headers: { Cookie: cookie, Authorization: "bad" } })).status, 401);
    assert.equal((await call("/api/shared/status", { headers: { Cookie: cookie, Host: "forged.invalid", "X-Forwarded-Host": "127.0.0.1" } })).status, 403);
    assert.equal((await call("/api/shared/status", { headers: { Cookie: cookie, Origin: "http://forged.invalid" } })).status, 403);
    assert.equal((await call("/api/fleet/metadata.json", { headers: { Cookie: cookie, "X-GridLens-Roster-Revision": "old" } })).status, 401);
    const revoked = await call("/api/shared/revoke", { headers: { Cookie: cookie }, body: { deviceId: JSON.parse(second.text).deviceId } });
    assert.equal(revoked.status, 200);
    assert.equal((await call("/api/fleet/metadata.json", { headers: { Cookie: secondCookie } })).status, 401);
    assert.equal((await call("/", { headers: { Cookie: secondCookie } })).status, 302);
  } finally {
    if (gateway) await closeFleetServer(gateway.server, gateway.integration);
    await stop(owner); await state.close(); await rm(directory, { recursive: true });
  }
});
