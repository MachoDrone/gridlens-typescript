import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import ssh2 from "ssh2";
import { createGatewayIntegration } from "../src/backend/gateway.ts";
import { startOwnerSocket, SharedHttpError } from "../src/backend/ipc.ts";
import { startFleetServer, closeFleetServer } from "../src/server/application.ts";

test("browser sign-in setup uses bounded JSON to the owner and rejects foreign origins or privileged fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-browser-configure-")), socket = join(directory, "read.sock");
  const grant = "a".repeat(43), secret = "generated-browser-password", calls: Record<string, unknown>[] = [];
  let fail = false;
  const owner = await startOwnerSocket(socket, async body => {
    calls.push(body); assert.equal(body.token, grant);
    if (fail) throw new Error(`An internal failure must not expose ${[body.password, body.privateKey, body.passphrase, body.sudoPassword].join(" ")}`);
    if (body.operation === "setup-configure") return { revision: 2, phase: "inspecting", report: { status: "running", total: 1, completed: 0, results: [] } };
    if (body.operation === "setup-remove") return { revision: 3, phase: "done", managed: [] };
    throw new SharedHttpError(404);
  });
  const integration = createGatewayIntegration(socket, Buffer.from("<head></head>"), Buffer.from(""), { transport: "vpn-http", privateNetworkToken: grant });
  const server = await startFleetServer({ integration, host: "127.0.0.1", port: 0, publicOrigin: "http://127.0.0.1" });
  const port = (server.address() as { port: number }).port;
  const call = (path: string, body: unknown, origin: string | null = "http://127.0.0.1", host = "127.0.0.1") =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const bytes = JSON.stringify(body);
      const req = request({ hostname: "127.0.0.1", port, path, method: "POST", headers: {
        Host: host, ...(origin === null ? {} : { Origin: origin }), "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bytes),
      } }, response => { let text = ""; response.on("data", part => { text += part; }); response.on("end", () => resolve({ status: response.statusCode!, text })); });
      req.on("error", reject); req.end(bytes);
    });
  try {
    const body = { revision: 1, selected: ["b".repeat(64)], username: "fixture", password: secret, fullMonitoring: false };
    for (const origin of [null, "http://foreign.invalid", "null"]) assert.equal((await call("/api/shared/setup-configure", body, origin)).status, 403);
    assert.equal((await call("/api/shared/setup-configure", body, "http://127.0.0.1", "foreign.invalid")).status, 403);
    for (const extra of [{ privateKeyPath: "/not-accepted" }, { command: "not-accepted" }, { scopeId: "another-fleet" }, { sudoCommand: "not-accepted" }])
      assert.equal((await call("/api/shared/setup-configure", { ...body, ...extra })).status, 400);
    assert.equal(calls.length, 0);
    const accepted = await call("/api/shared/setup-configure", body);
    assert.equal(accepted.status, 200); assert.ok(!accepted.text.includes(secret) && !accepted.text.includes(grant));
    assert.deepEqual(calls[0], { ...body, operation: "setup-configure", token: grant });
    const removed = await call("/api/shared/setup-remove", { revision: 2, pcId: "b".repeat(64) });
    assert.equal(removed.status, 200);
    const passphrase = "generated-gateway-key-passphrase", sudoPassword = "generated-gateway-sudo-password";
    const key = ssh2.utils.generateKeyPairSync("ed25519", { passphrase, cipher: "aes256-cbc", rounds: 16 }).private;
    const keyBody = { revision: 1, selected: ["b".repeat(64)], username: "fixture", privateKey: key, passphrase, sudoPassword, fullMonitoring: false };
    const acceptedKey = await call("/api/shared/setup-configure", keyBody);
    assert.equal(acceptedKey.status, 200);
    assert.ok(calls.at(-1)?.privateKey === key); assert.equal(calls.at(-1)?.passphrase, passphrase); assert.equal(calls.at(-1)?.sudoPassword, sudoPassword);
    assert.ok(!acceptedKey.text.includes("PRIVATE KEY") && !acceptedKey.text.includes(passphrase) && !acceptedKey.text.includes(sudoPassword));
    fail = true;
    for (const input of [body, keyBody]) {
      const failed = await call("/api/shared/setup-configure", input);
      assert.equal(failed.status, 502); assert.ok(!failed.text.includes(secret) && !failed.text.includes(grant)
        && !failed.text.includes("PRIVATE KEY") && !failed.text.includes(passphrase) && !failed.text.includes(sudoPassword));
    }
  } finally {
    await closeFleetServer(server, integration); owner.closeAllConnections();
    await new Promise<void>(resolve => owner.close(() => resolve())); await rm(directory, { recursive: true });
  }
});
