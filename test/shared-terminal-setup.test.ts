import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSharedState } from "../src/backend/sqlite-state.ts";
import { createSharedService } from "../src/backend/service.ts";
import { createGatewayIntegration } from "../src/backend/gateway.ts";
import { SharedHttpError } from "../src/backend/ipc.ts";
import type { Computer } from "../src/backend/ssh.ts";

test("terminal setup actions reuse bounded discovery, identity and approval validation without browser participation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-terminal-actions-")), state = openSharedState(directory);
  const pc: Computer = { id: "a".repeat(64), host: "192.168.42.3", port: 22, name: "Generated computer",
    fingerprint: "SHA256:" + "A".repeat(43), hostKey: "generated-public-fixture" };
  let probes = 0;
  const service = createSharedService(state, { scan: async () => { probes++; return [pc]; } });
  service.access.setFleet("default", []);
  const status = (code: number) => (error: unknown) => error instanceof SharedHttpError && error.status === code;
  const act = (action: string, fields: Record<string, unknown> = {}) => service.control({ operation: "setup-action", scopeId: "default",
    revision: service.setup.read("default").revision, action, ...fields });
  try {
    for (const range of ["8.8.8.8", "192.168.0.0/16", "192.168.42.0/24;command"])
      await assert.rejects(act("scan", { range }), status(400));
    await assert.rejects(act("scan", { revision: 99, range: pc.host }), status(409));
    assert.equal(probes, 0);
    const started = await act("scan", { range: pc.host, port: 22 }) as ReturnType<typeof service.setup.read>;
    assert.equal(started.phase, "scanning");
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(service.setup.read("default").phase, "select");
    await assert.rejects(act("select", { selected: ["b".repeat(64)] }), status(400));
    await act("select", { selected: [pc.id] });
    await assert.rejects(act("trust", { revision: started.revision }), status(409));
    await act("trust");
    assert.equal(service.setup.read("default").phase, "credentials");
    const revision = service.setup.read("default").revision;
    await service.control({ operation: "setup-auth", scopeId: "default", revision, username: "fixture", password: "generated-secret", remember: false });
    await assert.rejects(act("inspect", { automaticIp: true, fullMonitoring: "yes" }), status(400));
    await act("inspect", { automaticIp: true, fullMonitoring: false });
    const view = service.setup.read("default");
    assert.equal(view.phase, "inspecting"); assert.equal(view.fullMonitoring, false);
    assert.ok(!JSON.stringify(view).includes("generated-secret"));
    assert.deepEqual(service.access.fleet("default").addresses, []);
  } finally { await service.setup.close(); await state.close(); await rm(directory, { recursive: true }); }
});

test("deployed setup pages explicitly select terminal onboarding without changing native sign-in HTML", async () => {
  const html = await readFile(new URL("../src/preview/shared-setup.html", import.meta.url));
  const gateway = createGatewayIntegration("/unused", html, Buffer.from(""));
  let body: Buffer | undefined;
  const handled = await gateway.handleRequest!({ url: "/setup", method: "GET", headers: {} } as never,
    { writeHead() {}, end(value: Buffer) { body = value; } } as never);
  assert.equal(handled, true);
  assert.match(body!.toString(), /name="gridlens-setup-mode" content="terminal"/);
  assert.match(body!.toString(), /<section id="login">/);
});
