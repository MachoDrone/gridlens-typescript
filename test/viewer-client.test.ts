import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:https";
import type { Server } from "node:http";
import { createViewerClient, parseViewerConfiguration, parseViewerInvite, redeemViewerInvite, ViewerClientError } from "../src/backend/viewer-client.ts";
import { createViewerIntegration, startViewerGateway } from "../src/backend/viewer-gateway.ts";
import { readViewerConfiguration, validateViewerEnvironment } from "../scripts/shared-viewer.ts";
import { startFleetServer, closeFleetServer } from "../src/server/application.ts";
import { emptyFleetSnapshots } from "../src/server/snapshot-store.ts";
import type { ViewerInvite } from "../src/contracts/viewer.ts";

const stop = async (server: Server) => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); };
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "gridlens-viewer-tls-"));
  const run = (args: string[]) => execFileSync("openssl", args, { cwd: directory, stdio: "ignore" });
  run(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "2", "-subj", "/CN=Generated viewer CA", "-addext", "basicConstraints=critical,CA:TRUE"]);
  run(["req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=Generated viewer owner", "-addext", "basicConstraints=critical,CA:FALSE", "-addext", "subjectAltName=IP:127.0.0.1"]);
  run(["x509", "-req", "-in", "leaf.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-set_serial", "2", "-out", "leaf.crt", "-days", "1", "-copy_extensions", "copy"]);
  const ca = readFileSync(join(directory, "ca.crt"), "utf8"), leaf = readFileSync(join(directory, "leaf.crt"), "utf8");
  const token = randomBytes(32).toString("base64url"), code = randomBytes(32).toString("base64url"), context = { scopeId: "generated-scope", rosterRevision: "one", addresses: ["1".repeat(31) + "2"] };
  const snapshots = emptyFleetSnapshots(context.addresses);
  const mode = { role: "viewer", serverId: "generated-owner", scopeId: context.scopeId, denied: false, redirect: false, calls: [] as { url: string; body: Record<string, unknown>; authorization: string | undefined }[] };
  const owner = createServer({ cert: leaf, key: readFileSync(join(directory, "leaf.key")) }, (request, response) => {
    let text = ""; request.on("data", chunk => { text += chunk; }); request.on("end", () => {
      const body = JSON.parse(text); mode.calls.push({ url: request.url!, body, authorization: request.headers.authorization });
      const send = (status: number, value: unknown) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
      if (mode.redirect) { response.writeHead(302, { Location: "https://127.0.0.1:19001/forbidden" }); response.end(); return; }
      if (request.url === "/api/shared/pair") { assert.equal(body.code, code); send(200, { version: 1, serverId: mode.serverId, role: mode.role, token, context }); return; }
      if (request.url !== "/api/shared/viewer/read" || request.headers.authorization !== `Bearer ${token}` || mode.denied) { send(403, {}); return; }
      let result: unknown = body.operation === "resolve" ? context : body.operation === "status" ? { version: 1, serverId: mode.serverId, role: mode.role, context, token }
        : body.operation === "snapshot" ? { ...snapshots[body.resource as keyof typeof snapshots], token } : body.operation === "observations"
          ? { version: 1, serverId: mode.serverId, scopeId: context.scopeId, rosterRevision: context.rosterRevision, associations: [], observations: [], networks: [], token } : { accepted: true };
      if (body.operation === "gpu-history") result = { version: 1, serverId: mode.serverId, scopeId: context.scopeId, rosterRevision: context.rosterRevision, address: body.address, gpu: null };
      send(200, { version: 1, role: mode.role, serverId: mode.serverId, scopeId: mode.scopeId, result });
    });
  });
  await new Promise<void>(done => owner.listen(0, "127.0.0.1", done)); const port = (owner.address() as { port: number }).port;
  const invite: ViewerInvite = { version: 1, kind: "gridlens-viewer-invite", ownerOrigin: `https://127.0.0.1:${port}`, serverId: mode.serverId,
    caCertificatePem: ca, serverCertificateSha256: createHash("sha256").update(new X509Certificate(leaf).raw).digest("hex"), code, expiresAtMs: Date.now() + 60_000 };
  return { directory, owner, mode, token, context, invite, config: { version: 1 as const, ownerOrigin: invite.ownerOrigin, serverId: invite.serverId, caCertificatePem: ca,
    serverCertificateSha256: invite.serverCertificateSha256, token, scopeId: context.scopeId }, async close() { await stop(owner); rmSync(directory, { recursive: true, force: true }); } };
}
test("real pinned TLS pairing accepts viewer only and rejects bad identity, expired invites and redirects without following", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await redeemViewerInvite(f.invite, "Generated viewer"), parseViewerConfiguration(f.config));
    const at = f.mode.calls.length;
    await assert.rejects(redeemViewerInvite({ ...f.invite, expiresAtMs: 1 }, "Generated viewer")); assert.equal(f.mode.calls.length, at);
    await assert.rejects(redeemViewerInvite({ ...f.invite, serverCertificateSha256: "0".repeat(64) }, "Generated viewer")); assert.equal(f.mode.calls.length, at, "pin failure precedes HTTP credential delivery");
    f.mode.role = "operator"; await assert.rejects(redeemViewerInvite(f.invite, "Generated viewer"), (error: unknown) => error instanceof ViewerClientError && error.status === 403);
    await assert.rejects(startViewerGateway({ configuration: f.config, publicOrigin: "http://127.0.0.1:18899", directory: resolve("dist"), host: "127.0.0.1", port: 0 }),
      (error: unknown) => error instanceof ViewerClientError && error.status === 403, "operator credentials cannot start the viewer listener");
    f.mode.role = "viewer"; f.mode.serverId = "wrong-owner"; await assert.rejects(redeemViewerInvite(f.invite, "Generated viewer"));
    f.mode.serverId = f.invite.serverId; f.mode.redirect = true; const before = f.mode.calls.length; await assert.rejects(redeemViewerInvite(f.invite, "Generated viewer")); assert.equal(f.mode.calls.length, before + 1);
    for (const ownerOrigin of ["http://127.0.0.1:8789", "https://example.com:8790", f.invite.ownerOrigin + "/path", f.invite.ownerOrigin + "?token=bad"])
      assert.throws(() => parseViewerInvite({ ...f.invite, ownerOrigin }));
    assert.throws(() => parseViewerConfiguration({ ...f.config, caCertificatePem: readFileSync(join(f.directory, "ca.key"), "utf8") }));
  } finally { await f.close(); }
});
test("untrusted owner CA is rejected before any HTTP credential is delivered", async () => {
  const f = await fixture(), other = await fixture();
  try {
    const before = f.mode.calls.length;
    await assert.rejects(redeemViewerInvite({ ...f.invite, caCertificatePem: other.invite.caCertificatePem }, "Generated viewer"));
    assert.equal(f.mode.calls.length, before);
  } finally { await f.close(); await other.close(); }
});
test("each fixed viewer RPC validates role/scope/server and rejects arbitrary or privileged operations locally", async () => {
  const f = await fixture(), client = createViewerClient(f.config);
  try {
    assert.deepEqual(await client.resolve(), f.context);
    const status = await client.status(); assert.equal(status.role, "viewer"); assert.equal(JSON.stringify(status).includes(f.token), false);
    for (const input of [{ operation: "treasury-confirm" }, { operation: "snapshot", resource: "metadata", scopeId: f.context.scopeId, rosterRevision: "one", url: "https://other.invalid" },
      { operation: "resolve", token: "injected" }, { operation: "snapshot", resource: "metadata", scopeId: "other", rosterRevision: "one" }]) {
      const before = f.mode.calls.length; await assert.rejects(client.read(input)); assert.equal(f.mode.calls.length, before);
    }
    f.mode.role = "operator"; await assert.rejects(client.resolve()); f.mode.role = "viewer";
    f.mode.scopeId = "other"; await assert.rejects(client.resolve()); f.mode.scopeId = f.context.scopeId;
    f.mode.serverId = "other-owner"; await assert.rejects(client.resolve()); f.mode.serverId = f.invite.serverId;
    f.mode.denied = true; await assert.rejects(client.resolve(), (error: unknown) => error instanceof ViewerClientError && error.status === 403);
    assert.ok(f.mode.calls.every(call => call.url === "/api/shared/viewer/read" && !Object.hasOwn(call.body, "token")));
  } finally { client.close(); await f.close(); }
});
test("viewer gateway serves scoped snapshots and hard-denies owner routes without exposing backend token", async () => {
  const f = await fixture(), client = createViewerClient(f.config), integration = createViewerIntegration(client);
  const local = await startFleetServer({ integration, directory: resolve("dist"), host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${(local.address() as { port: number }).port}`;
  try {
    const html = await (await fetch(origin + "/")).text();
    assert.match(html, /name="gridlens-viewer-only" content="1"/); assert.equal(html.includes(f.token), false);
    for (const path of ["/api/fleet/hosts.json", "/api/fleet/metadata.json", "/api/shared/status", "/api/shared/observations"]) {
      const response = await fetch(origin + path); assert.equal(response.status, 200); assert.equal((await response.text()).includes(f.token), false);
    }
    const before = f.mode.calls.length;
    for (const path of ["/wallet", "/api/shared/treasury/confirm", "/setup", "/admin", "/api/shared/setup-configure", "/api/shared/revoke", "/api/shared/viewer/read"])
      assert.equal((await fetch(origin + path, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" })).status, 403);
    assert.equal(f.mode.calls.length, before, "blocked routes cannot contact owner");
    const history = await fetch(origin + "/api/shared/gpu-history", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ address: f.context.addresses[0], fromAtMs: 0, toAtMs: 1000 }) });
    assert.equal(history.status, 200); assert.equal((await history.json()).gpu, null);
    assert.equal((await fetch(origin + "/api/fleet/hosts.json", { headers: { Origin: "https://forged.invalid" } })).status, 403);
    f.mode.denied = true; assert.equal((await fetch(origin + "/api/fleet/metadata.json")).status, 401);
  } finally { local.closeAllConnections(); await closeFleetServer(local, integration); await f.close(); }
});
test("viewer runtime reads only an ordinary private backend configuration file", async () => {
  const f = await fixture();
  try {
    const path = join(f.directory, "client.json"); writeFileSync(path, JSON.stringify(f.config), { mode: 0o600 });
    assert.deepEqual(readViewerConfiguration(path), parseViewerConfiguration(f.config));
    chmodSync(path, 0o644); assert.throws(() => readViewerConfiguration(path)); chmodSync(path, 0o600);
    const link = join(f.directory, "linked.json"); symlinkSync(path, link); assert.throws(() => readViewerConfiguration(link));
  } finally { await f.close(); }
});
test("viewer entry requires explicit financial protocol zero and keeps every other authority override forbidden", () => {
  validateViewerEnvironment({ GRIDLENS_TREASURY_PROTOCOL: "0", PATH: "/usr/local/bin:/usr/bin:/bin" });
  for (const value of [undefined, "", "1", "2", "00", " 0"]) assert.throws(() => validateViewerEnvironment({ GRIDLENS_TREASURY_PROTOCOL: value }));
  for (const name of ["GRIDLENS_TREASURY_SOCKET", "GRIDLENS_OWNER_AUTHORITY", "GRIDLENS_SOCKET", "GRIDLENS_UPDATES", "GRIDLENS_VPN_AUTH_FILE", "NODE_EXTRA_CA_CERTS"])
    assert.throws(() => validateViewerEnvironment({ GRIDLENS_TREASURY_PROTOCOL: "0", [name]: "generated" }));
});
