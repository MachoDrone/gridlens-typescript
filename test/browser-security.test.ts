import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { createBrowserSecurity, validateBrowserSecurityPublication } from "../src/backend/browser-security.ts";
import type { BrowserSecurityRead } from "../src/backend/browser-security.ts";
import { parseBrowserSecurityStatus, parseBrowserSecurityConnectCode } from "../src/contracts/browser-security.ts";
import type { BrowserSecurityPublication } from "../src/contracts/browser-security.ts";
import { createSharedService } from "../src/backend/service.ts";
import { createGatewayIntegration, startSharedGateway } from "../src/backend/gateway.ts";
import { SharedHttpError, startOwnerSocket } from "../src/backend/ipc.ts";
import { openSharedState } from "../src/backend/sqlite-state.ts";
import { closeFleetServer, startFleetServer } from "../src/server/application.ts";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "gridlens-browser-security-"));
  const run = (args: string[]) => execFileSync("openssl", args, { cwd: directory, stdio: "ignore" });
  run(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "3",
    "-subj", "/CN=Generated browser security fixture", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
  run(["req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "server.key", "-out", "server.csr",
    "-subj", "/CN=Generated local fixture", "-addext", "basicConstraints=critical,CA:FALSE", "-addext", "extendedKeyUsage=serverAuth",
    "-addext", "subjectAltName=IP:127.0.0.1,IP:fd00::2"]);
  run(["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-set_serial", "2", "-out", "server.crt", "-days", "1", "-copy_extensions", "copy"]);
  const ca = readFileSync(join(directory, "ca.crt"), "utf8"), leaf = readFileSync(join(directory, "server.crt"), "utf8");
  const hash = createHash("sha256").update(new X509Certificate(leaf).raw).digest("hex");
  const publication: BrowserSecurityPublication = { version: 1, instance: "fixture", httpsOrigin: "https://127.0.0.1:18778", httpOrigin: "http://127.0.0.1:18770",
    certificatePem: ca, serverCertificatePem: leaf, serverCertificateSha256: hash };
  return { directory, ca, leaf, publication, close: () => rmSync(directory, { recursive: true, force: true }) };
}
const stop = (server: Server) => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); });
const denied = (status: number) => (error: unknown) => error instanceof SharedHttpError && error.status === status;
const applePath = (fingerprint: string) => `/secure-setup/apple-ca/${fingerprint}.mobileconfig`;
function profileCertificate(xml: string): Buffer {
  return execFileSync("python3", ["-c", "import sys,plistlib; p=plistlib.loads(sys.stdin.buffer.read()); assert len(p['PayloadContent'])==1; c=p['PayloadContent'][0]; assert c['PayloadType']=='com.apple.security.root'; sys.stdout.buffer.write(c['PayloadContent'])"],
    { input: xml, maxBuffer: 64 * 1024 });
}
function intermediatePublication(f: ReturnType<typeof fixture>): BrowserSecurityPublication {
  const run = (args: string[]) => execFileSync("openssl", args, { cwd: f.directory, stdio: "ignore" });
  run(["req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "intermediate.key", "-out", "intermediate.csr",
    "-subj", "/CN=Generated intermediate CA"]);
  writeFileSync(join(f.directory, "intermediate.ext"), "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n");
  run(["x509", "-req", "-in", "intermediate.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-set_serial", "3", "-out", "intermediate.crt", "-days", "1", "-extfile", "intermediate.ext"]);
  run(["x509", "-req", "-in", "server.csr", "-CA", "intermediate.crt", "-CAkey", "intermediate.key", "-set_serial", "4", "-out", "intermediate-server.crt", "-days", "1", "-copy_extensions", "copy"]);
  const intermediate = readFileSync(join(f.directory, "intermediate.crt"), "utf8"), leaf = readFileSync(join(f.directory, "intermediate-server.crt"), "utf8");
  return { ...f.publication, certificatePem: intermediate + f.ca, serverCertificatePem: leaf,
    serverCertificateSha256: createHash("sha256").update(new X509Certificate(leaf).raw).digest("hex") };
}

test("public browser security publication binds strict public PEM, CA signatures, SAN, fingerprint and saved endpoints", () => {
  const f = fixture(), unrelated = fixture();
  try {
    assert.deepEqual(validateBrowserSecurityPublication(f.publication), f.publication);
    const ipv6 = { ...f.publication, httpsOrigin: "https://[fd00::2]:18778", httpOrigin: "http://[fd00::2]:19491" };
    assert.equal(validateBrowserSecurityPublication(ipv6).httpOrigin, ipv6.httpOrigin);
    for (const changed of [
      { certificatePem: f.ca + readFileSync(join(f.directory, "ca.key"), "utf8") },
      { certificatePem: "-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----" },
      { certificatePem: f.ca + f.ca }, { certificatePem: " ".repeat(32 * 1024 + 1) }, { certificatePem: unrelated.ca },
      { serverCertificatePem: f.leaf + f.ca }, { serverCertificateSha256: "0".repeat(64) },
      { httpsOrigin: "https://127.0.0.2:18778" }, { httpsOrigin: "https://example.invalid:18778" },
      { httpsOrigin: "https://8.8.8.8:18778" }, { httpsOrigin: "https://127.0.0.1:18778/" },
      { httpOrigin: "http://127.0.0.2:18770" }, { httpOrigin: "http://127.0.0.1:18778" },
      { httpsOrigin: "https://127.0.0.1:18778/../../secret" }, { token: "must-not-persist" },
    ]) assert.throws(() => validateBrowserSecurityPublication({ ...f.publication, ...changed }), JSON.stringify(Object.keys(changed)));
    const provided = validateBrowserSecurityPublication({ ...f.publication, certificatePem: f.leaf + f.ca });
    assert.equal(provided.certificatePem, f.leaf + f.ca, "provided leaf-first chains are validated without asserting browser trust");
  } finally { f.close(); unrelated.close(); }
});

test("terminal publication survives backend recreation without granting browser or financial authority", async () => {
  const f = fixture(); let state = openSharedState(join(f.directory, "state"));
  let now = Date.now(), service = createSharedService(state, { now: () => now });
  try {
    const initial = await service.read({ operation: "browser-security" }) as BrowserSecurityRead;
    assert.deepEqual(initial, { status: { version: 1, available: false, serverId: service.access.serverId }, certificatePem: null });
    service.access.setFleet("default", []);
    const operator = service.access.pair(service.access.createCode("default", "operator").code, "fixture operator");
    await assert.rejects(service.read({ operation: "browser-security-publish", ...f.publication }), denied(401));
    await assert.rejects(service.read({ operation: "browser-security-publish", ...f.publication, token: operator.token }), denied(404));
    await assert.rejects(service.control({ operation: "browser-security-publish", ...f.publication, path: "/arbitrary" }), denied(400));
    const accessBefore = JSON.stringify(state.get("access.v1"));
    assert.deepEqual(await service.control({ operation: "browser-security-publish", ...f.publication }), { published: true });
    const published = await service.read({ operation: "browser-security" }) as BrowserSecurityRead;
    const status = parseBrowserSecurityStatus(published.status); assert.equal(status.available, true);
    if (!status.available) throw new Error("Expected publication.");
    assert.equal(status.status, "ready"); assert.equal(status.trustMode, "private-ca");
    assert.equal(status.certificateDownloadPath, "/secure-setup/ca.crt"); assert.equal(published.certificatePem, f.ca);
    assert.equal(JSON.stringify(status).includes("BEGIN"), false); assert.equal(JSON.stringify(status).includes(operator.token), false);
    assert.equal(JSON.stringify(state.get("access.v1")), accessBefore);
    await assert.rejects(service.read({ operation: "browser-security", path: "/config/ca.key" }), denied(400));
    await assert.rejects(service.read({ operation: "status" }), denied(401));
    await state.close(); state = openSharedState(join(f.directory, "state")); service = createSharedService(state, { now: () => now });
    assert.deepEqual((await service.read({ operation: "browser-security" }) as BrowserSecurityRead).status, status);
    now = status.serverCertificateValidToMs;
    assert.equal((await service.read({ operation: "browser-security" }) as BrowserSecurityRead).status.available, true);
    assert.equal((parseBrowserSecurityStatus((await service.read({ operation: "browser-security" }) as BrowserSecurityRead).status) as typeof status).status, "expired");
    now = status.serverCertificateValidFromMs - 1;
    assert.equal((parseBrowserSecurityStatus((await service.read({ operation: "browser-security" }) as BrowserSecurityRead).status) as typeof status).status, "not-yet-valid");
    state.set("browser-security.v1", { ...f.publication, certificatePem: "corrupt" });
    await assert.rejects(service.read({ operation: "browser-security" }));
  } finally { await service.setup.close(); await state.close(); f.close(); }
});

test("provided certificates have no CA-import download and public metadata rejects added secrets or arbitrary origins", () => {
  const f = fixture(), values = new Map<string, unknown>(), state = { get: <T>(key: string) => values.get(key) as T | undefined, set: (key: string, value: unknown) => { values.set(key, value); } };
  try {
    const security = createBrowserSecurity(state, "fixture-server");
    const { status, certificatePem } = security.publish({ ...f.publication, certificatePem: f.leaf + f.ca });
    assert.ok(status.available);
    assert.equal(status.trustMode, "provided-certificate"); assert.equal(status.certificateDownloadPath, null); assert.equal(certificatePem, null);
    assert.throws(() => parseBrowserSecurityStatus({ ...status, certificatePem: f.ca }));
    assert.throws(() => parseBrowserSecurityStatus({ ...status, httpsOrigin: "https://other.invalid:18778" }));
    assert.throws(() => parseBrowserSecurityStatus({ ...status, certificateDownloadPath: "https://other.invalid/file" }));
  } finally { f.close(); }
});

test("gateway exposes only fixed public setup resources, enforces origin/method/path, and creates no session", async t => {
  const f = fixture(), replacement = fixture(), state = openSharedState(join(f.directory, "state"));
  let at = Date.now(); const service = createSharedService(state, { now: () => at });
  let cleanupOwner: Server | undefined, cleanupServer: Server | undefined;
  t.after(async () => { if (cleanupServer) await stop(cleanupServer); if (cleanupOwner) await stop(cleanupOwner); await service.setup.close(); await state.close(); f.close(); replacement.close(); });
  await service.control({ operation: "browser-security-publish", ...f.publication });
  const socket = join(f.directory, "read.sock"), owner = cleanupOwner = await startOwnerSocket(socket, service.read);
  const integration = createGatewayIntegration(socket, Buffer.from("<head></head>"), Buffer.from(""), { transport: "vpn-http",
    browserSecurityAssets: { html: Buffer.from("<h1>Secure browser</h1>"), script: Buffer.from("export {};") } });
  const server = cleanupServer = await startFleetServer({ integration, host: "127.0.0.1", port: 0, publicOrigin: f.publication.httpOrigin! });
  const port = (server.address() as { port: number }).port;
  const call = (path: string, method = "GET", headers: Record<string, string> = {}) => new Promise<{ code: number; text: string; headers: IncomingHttpHeaders }>((done, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", port, path, method, headers: { Host: new URL(f.publication.httpOrigin!).host, ...headers } }, response => {
      let text = ""; response.on("data", chunk => { text += chunk; }); response.on("end", () => done({ code: response.statusCode!, text, headers: response.headers }));
    }); req.on("error", reject); req.end();
  });
  try {
    for (const path of ["/secure-setup", "/secure-setup.js", "/secure-setup/status.json", "/secure-setup/ca.crt"]) {
      const result = await call(path); assert.equal(result.code, 200, path); assert.equal(result.headers["cache-control"], "no-store");
      assert.equal(result.headers["set-cookie"], undefined); assert.equal((await call(path, "HEAD")).text, "");
    }
    assert.equal((await call("/secure-setup/ca.crt")).text, f.ca);
    const caHash = createHash("sha256").update(new X509Certificate(f.ca).raw).digest("hex");
    assert.equal((await call("/secure-setup/ca.crt")).headers["content-disposition"], `attachment; filename="gridlens-fixture-${caHash.slice(0, 8)}-ca.crt"`);
    const matching = await call("/secure-setup/ca.crt", "GET", { "If-Match": `"${caHash}"` });
    assert.equal(matching.code, 200); assert.equal(matching.headers.etag, `"${caHash}"`); assert.equal(matching.text, f.ca);
    const profile = await call(applePath(caHash));
    assert.equal(profile.code, 200); assert.equal(profile.headers["content-type"], "application/x-apple-aspen-config");
    assert.equal(profile.headers.etag, `"${caHash}"`); assert.equal(profile.headers["cache-control"], "no-store");
    assert.equal(profile.headers["x-content-type-options"], "nosniff"); assert.equal(profile.headers["referrer-policy"], "no-referrer");
    assert.equal(profile.headers["set-cookie"], undefined);
    assert.equal(profile.headers["content-disposition"], `attachment; filename="gridlens-fixture-${caHash.slice(0, 8)}-ca.mobileconfig"`);
    assert.deepEqual(profileCertificate(profile.text), new X509Certificate(f.ca).raw);
    const profileHead = await call(applePath(caHash), "HEAD"); assert.equal(profileHead.code, 200); assert.equal(profileHead.text, "");
    assert.equal(profileHead.headers["content-length"], String(Buffer.byteLength(profile.text)));
    assert.equal((await call(applePath(caHash), "GET", { "If-Match": `"${caHash}"` })).text, profile.text);
    for (const value of ["*", caHash, `W/"${caHash}"`, `"${caHash}", "${caHash}"`, '"invalid"', `"${"0".repeat(64)}"`]) {
      const rejected = await call("/secure-setup/ca.crt", "GET", { "If-Match": value });
      assert.equal(rejected.code, 412); assert.equal(rejected.text.includes("BEGIN CERTIFICATE"), false);
      const appleRejected = await call(applePath(caHash), "GET", { "If-Match": value });
      assert.equal(appleRejected.code, 412); assert.doesNotMatch(appleRejected.text, /<plist|<data>|BEGIN CERTIFICATE/);
      assert.match(appleRejected.text, /href="\/secure-setup">Back to Secure/);
    }
    assert.equal((await call(applePath(caHash), "POST")).code, 405);
    assert.equal((await call(applePath(caHash) + "?path=/config/ca.key")).code, 400);
    for (const invalid of [applePath(caHash.toUpperCase()), applePath("a".repeat(63)), applePath(caHash) + "/", "/secure-setup/apple-ca/server.crt"])
      assert.equal((await call(invalid)).code, 404);
    const traversal = await call("/secure-setup/apple-ca/../ca.crt"); assert.equal(traversal.code, 400); assert.doesNotMatch(traversal.text, /<plist|BEGIN CERTIFICATE/);
    assert.equal((await call(applePath(caHash), "GET", { Host: "forged.invalid" })).code, 403);
    assert.equal((await call(applePath(caHash), "GET", { Origin: "http://forged.invalid" })).code, 403);
    assert.equal((await call("/secure-setup/status.json", "POST")).code, 405);
    assert.equal((await call("/secure-setup/ca.crt?path=/config/ca.key")).code, 400);
    assert.equal((await call("/secure-setup/anything")).code, 404);
    assert.equal((await call("/secure-setup/status.json", "GET", { Host: "forged.invalid" })).code, 403);
    assert.equal((await call("/secure-setup/ca.crt", "GET", { Origin: "http://forged.invalid" })).code, 403);
    assert.equal((await call("/api/shared/status")).code, 401, "reading onboarding metadata never pairs the browser");
    const leaked = JSON.stringify(JSON.parse((await call("/secure-setup/status.json")).text));
    assert.equal(leaked.includes("BEGIN"), false); assert.equal(leaked.includes("token"), false);
    // The publication may change after status was checked and before the download.
    await service.control({ operation: "browser-security-publish", ...replacement.publication });
    const raced = await call("/secure-setup/ca.crt", "GET", { "If-Match": `"${caHash}"` });
    assert.equal(raced.code, 412); assert.equal(raced.text.includes("BEGIN CERTIFICATE"), false);
    const oldApple = await call(applePath(caHash)); assert.equal(oldApple.code, 412); assert.doesNotMatch(oldApple.text, /<plist|<data>|BEGIN CERTIFICATE/);
    assert.equal(oldApple.headers["content-type"], "text/html; charset=utf-8"); assert.equal(oldApple.headers["content-disposition"], undefined);
    assert.match(oldApple.text, /href="\/secure-setup">Back to Secure/);
    const replacementHash = createHash("sha256").update(new X509Certificate(replacement.ca).raw).digest("hex");
    const current = await call("/secure-setup/ca.crt", "GET", { "If-Match": `"${replacementHash}"` });
    assert.equal(current.code, 200); assert.equal(current.headers.etag, `"${replacementHash}"`); assert.equal(current.text, replacement.ca);
    assert.deepEqual(profileCertificate((await call(applePath(replacementHash))).text), new X509Certificate(replacement.ca).raw);
    at = Date.parse(new X509Certificate(replacement.leaf).validTo);
    const expiredApple = await call(applePath(replacementHash)); assert.equal(expiredApple.code, 409); assert.doesNotMatch(expiredApple.text, /<plist|<data>|BEGIN CERTIFICATE/);
    const intermediate = intermediatePublication(f);
    // OpenSSL dates certificates when each command runs. Choose a clock inside
    // the finished chain's validity interval, rather than before its creation.
    const validity = [f.ca, intermediate.certificatePem, intermediate.serverCertificatePem].map(pem => new X509Certificate(pem));
    at = Math.max(...validity.map(certificate => Date.parse(certificate.validFrom))) + 1000;
    assert.ok(at < Math.min(...validity.map(certificate => Date.parse(certificate.validTo))));
    await service.control({ operation: "browser-security-publish", ...intermediate });
    const intermediateStatus = parseBrowserSecurityStatus((await service.read({ operation: "browser-security" }) as BrowserSecurityRead).status);
    assert.ok(intermediateStatus.available); assert.equal(intermediateStatus.status, "ready");
    const intermediateHash = createHash("sha256").update(new X509Certificate(intermediate.certificatePem).raw).digest("hex");
    const unsupportedApple = await call(applePath(intermediateHash)); assert.equal(unsupportedApple.code, 409);
    assert.match(unsupportedApple.text, /not a self-signed root/); assert.doesNotMatch(unsupportedApple.text, /<plist|<data>|BEGIN CERTIFICATE/);
    assert.equal((await call("/secure-setup/ca.crt")).text, intermediate.certificatePem, "CRT chain export remains available");
    await service.control({ operation: "browser-security-publish", ...f.publication, certificatePem: f.leaf + f.ca });
    const providedApple = await call(applePath(f.publication.serverCertificateSha256)); assert.equal(providedApple.code, 409);
    assert.doesNotMatch(providedApple.text, /<plist|<data>|BEGIN CERTIFICATE/);
    await service.control({ operation: "browser-security-publish", ...f.publication, httpOrigin: "http://127.0.0.1:19777" });
    assert.equal((await call("/secure-setup/status.json")).code, 503, "stale published endpoints fail closed");
  } finally { await closeFleetServer(server, integration); cleanupServer = undefined; await stop(owner); cleanupOwner = undefined; }
});

test("real TLS gateway compares published leaf to the certificate it actually serves", async t => {
  const f = fixture(), other = fixture(), state = openSharedState(join(f.directory, "state")), service = createSharedService(state);
  let cleanupOwner: Server | undefined, cleanupServer: Server | undefined;
  t.after(async () => { if (cleanupServer) await stop(cleanupServer); if (cleanupOwner) await stop(cleanupOwner); await service.setup.close(); await state.close(); f.close(); other.close(); });
  await service.control({ operation: "browser-security-publish", ...f.publication });
  const socket = join(f.directory, "read.sock"), owner = cleanupOwner = await startOwnerSocket(socket, service.read);
  const gateway = await startSharedGateway({ socketPath: socket, directory: resolve("dist"), host: "127.0.0.1", port: 0,
    publicOrigin: f.publication.httpsOrigin, certPath: join(f.directory, "server.crt"), keyPath: join(f.directory, "server.key") });
  cleanupServer = gateway.server;
  const call = (path = "/secure-setup/status.json") => new Promise<{ code: number; text: string; headers: IncomingHttpHeaders }>((done, reject) => {
    const request = httpsRequest({ hostname: "127.0.0.1", port: (gateway.server.address() as { port: number }).port, path, ca: f.ca,
      headers: { Host: new URL(f.publication.httpsOrigin).host } }, response => {
      let text = ""; response.on("data", chunk => { text += chunk; }); response.on("end", () => done({ code: response.statusCode!, text, headers: response.headers }));
    });
    request.on("error", reject); request.end();
  });
  try {
    assert.equal((await call()).code, 200);
    const fingerprint = createHash("sha256").update(new X509Certificate(f.ca).raw).digest("hex");
    const profile = await call(applePath(fingerprint)); assert.equal(profile.code, 200);
    assert.equal(profile.headers["set-cookie"], undefined); assert.deepEqual(profileCertificate(profile.text), new X509Certificate(f.ca).raw);
    await service.control({ operation: "browser-security-publish", ...other.publication });
    assert.equal((await call()).code, 503, "a valid but different published leaf must not describe the served TLS identity");
    const changed = await call(applePath(fingerprint)); assert.equal(changed.code, 503); assert.doesNotMatch(changed.text, /<plist|<data>|BEGIN CERTIFICATE/);
  } finally { await closeFleetServer(gateway.server, gateway.integration); cleanupServer = undefined; await stop(owner); cleanupOwner = undefined; }
});

test("private-web browser handoff redeems only through its matching real HTTPS gateway and cannot mint independent devices", async t => {
  const f = fixture(), replacement = fixture(), state = openSharedState(join(f.directory, "state")), service = createSharedService(state);
  const servers: Server[] = [];
  t.after(async () => { for (const server of servers.reverse()) await stop(server); await service.setup.close(); await state.close(); f.close(); replacement.close(); });
  const grant = randomBytes(32).toString("base64url");
  service.access.setFleet("default", []); service.access.registerGateway("default", grant);
  const independent = service.access.pair(service.access.createCode("default", "operator").code, "Terminal-paired operator");
  await service.control({ operation: "browser-security-publish", ...f.publication });
  const socket = join(f.directory, "handoff.sock"); servers.push(await startOwnerSocket(socket, service.read));
  const http = await startSharedGateway({ socketPath: socket, directory: resolve("dist"), host: "127.0.0.1", port: 0,
    transport: "vpn-http", publicOrigin: f.publication.httpOrigin!, privateNetworkToken: grant }); servers.push(http.server);
  const https = await startSharedGateway({ socketPath: socket, directory: resolve("dist"), host: "127.0.0.1", port: 0,
    publicOrigin: f.publication.httpsOrigin, certPath: join(f.directory, "server.crt"), keyPath: join(f.directory, "server.key") }); servers.push(https.server);
  const call = (secure: boolean, path: string, body?: unknown, extra: Record<string, string> = {}, omitOrigin = false) =>
    new Promise<{ code: number; text: string; headers: IncomingHttpHeaders }>((done, reject) => {
      const origin = secure ? f.publication.httpsOrigin : f.publication.httpOrigin!, data = body === undefined ? undefined : JSON.stringify(body);
      const request = (secure ? httpsRequest : httpRequest)({ hostname: "127.0.0.1", port: ((secure ? https : http).server.address() as { port: number }).port,
        path, method: data === undefined ? "GET" : "POST", ...(secure ? { ca: f.ca } : {}), headers: { Host: new URL(origin).host,
          ...(omitOrigin ? {} : { Origin: origin }), ...(data === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }), ...extra } }, response => {
        let text = ""; response.on("data", chunk => { text += chunk; }); response.on("end", () => done({ code: response.statusCode!, text, headers: response.headers }));
      }); request.on("error", reject); request.end(data);
    });
  assert.equal(JSON.parse((await call(false, "/secure-setup/status.json")).text).canConnectBrowser, true);
  assert.equal(JSON.parse((await call(true, "/secure-setup/status.json")).text).canConnectBrowser, false);
  for (const extra of [{ scopeId: "other" }, { token: independent.token }, { role: "operator" }, { parentGatewayId: "other" }])
    assert.equal((await call(false, "/secure-setup/connect-code", extra)).code, 400);
  assert.equal((await call(false, "/secure-setup/connect-code", {}, {}, true)).code, 403);
  assert.equal((await call(false, "/secure-setup/connect-code", {}, { Origin: "http://forged.invalid" })).code, 403);
  assert.equal((await call(false, "/secure-setup/connect-code?scope=other", {})).code, 400);
  assert.equal((await call(true, "/secure-setup/connect-code", {}, { Authorization: `Bearer ${independent.token}` })).code, 403);
  assert.equal((await call(false, "/secure-setup/connect", { version: 1, code: "x".repeat(43) })).code, 403);
  assert.equal((await call(false, "/secure-setup/connect-code")).code, 405);
  const issued = await call(false, "/secure-setup/connect-code", {});
  assert.equal(issued.code, 200); assert.equal(issued.headers["set-cookie"], undefined);
  const ticket = parseBrowserSecurityConnectCode(JSON.parse(issued.text));
  assert(ticket.expiresAtMs > Date.now() && ticket.expiresAtMs <= Date.now() + 300_000);
  assert.equal((await call(true, "/api/shared/login", { version: 1, code: ticket.code, deviceName: "Must not escape lineage" })).code, 401);
  assert.equal((await call(true, "/secure-setup/connect", { version: 1, code: ticket.code }, {}, true)).code, 403);
  assert.equal((await call(true, "/secure-setup/connect", { version: 1, code: ticket.code, serverCertificateSha256: f.publication.serverCertificateSha256 })).code, 400);
  const connected = await call(true, "/secure-setup/connect", { version: 1, code: ticket.code });
  assert.equal(connected.code, 200); assert.deepEqual(JSON.parse(connected.text), { version: 1, connected: true });
  const cookie = connected.headers["set-cookie"]?.[0]; assert(cookie);
  assert.match(cookie, /^__Host-gridlens=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict$/);
  const cookieHeader = { Cookie: cookie.split(";", 1)[0]! };
  assert.equal(connected.text.includes(cookieHeader.Cookie.split("=")[1]!), false);
  assert.equal(connected.text.includes(grant), false);
  assert.equal((await call(true, "/secure-setup/connect", { version: 1, code: ticket.code })).code, 401);
  const status = JSON.parse((await call(true, "/api/shared/status", undefined, cookieHeader)).text);
  assert.equal(status.role, "operator"); assert.equal(status.context.scopeId, "default");
  assert.equal(status.canManageDevices, false);
  assert.equal((await call(true, "/api/shared/setup", undefined, cookieHeader)).code, 200, "derived browsers can manage PCs without independent-device administration");
  const pairedStatus = JSON.parse((await call(true, "/api/shared/status", undefined, { Authorization: `Bearer ${independent.token}` })).text);
  assert.equal(Object.hasOwn(pairedStatus, "canManageDevices"), false, "existing paired/native status wire remains unchanged");
  const privateStatus = JSON.parse((await call(false, "/api/shared/status")).text);
  assert.equal(Object.hasOwn(privateStatus, "canManageDevices"), false, "existing private gateway status wire remains unchanged");
  assert.equal((await call(true, "/api/shared/status")).code, 401);
  assert.equal((await call(true, "/api/shared/pair-code", {}, cookieHeader)).code, 401);
  assert.equal((await call(true, "/api/shared/devices", undefined, cookieHeader)).code, 401);
  assert.equal((await call(true, "/api/shared/revoke", { deviceId: independent.deviceId }, cookieHeader)).code, 401);
  assert(service.access.resolve(independent.token));
  const derived = service.access.devices(independent.token).find(device => device.name === "Secure browser"); assert(derived);
  assert.equal((await call(true, "/api/shared/revoke", { deviceId: derived.deviceId }, { Authorization: `Bearer ${independent.token}` })).code, 200);
  assert.equal((await call(true, "/api/shared/status", undefined, cookieHeader)).code, 401);

  const secondTicket = parseBrowserSecurityConnectCode(JSON.parse((await call(false, "/secure-setup/connect-code", {})).text));
  const second = await call(true, "/secure-setup/connect", { version: 1, code: secondTicket.code });
  const secondCookie = { Cookie: second.headers["set-cookie"]![0]!.split(";", 1)[0]! };
  const pending = parseBrowserSecurityConnectCode(JSON.parse((await call(false, "/secure-setup/connect-code", {})).text));
  service.access.setFleet("default", ["1".repeat(31) + "2"]);
  assert.equal(JSON.parse((await call(true, "/api/shared/status", undefined, secondCookie)).text).context.addresses.length, 1);
  assert.equal((await call(true, "/secure-setup/connect", { version: 1, code: pending.code })).code, 401);
  const certificateTicket = parseBrowserSecurityConnectCode(JSON.parse((await call(false, "/secure-setup/connect-code", {})).text));
  await service.control({ operation: "browser-security-publish", ...replacement.publication });
  const mismatch = await call(true, "/secure-setup/connect", { version: 1, code: certificateTicket.code });
  assert.equal(mismatch.code, 503); assert.equal(mismatch.headers["set-cookie"], undefined);
  await service.control({ operation: "browser-security-publish", ...f.publication });
  service.access.revokeGateway("default");
  assert.equal((await call(true, "/api/shared/status", undefined, secondCookie)).code, 401);
  assert.equal((await call(false, "/secure-setup/connect-code", {})).code, 401);
});
