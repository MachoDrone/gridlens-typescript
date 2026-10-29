import assert from "node:assert/strict";
import test from "node:test";
import { followBrowserSetup, verifiedSetupNetwork } from "../src/installer/setup-session.ts";
import type { TerminalPrompts } from "../src/installer/terminal.ts";

function terminal() {
  const output: string[] = [], prompts: string[] = [];
  const value: TerminalPrompts = { async ask(prompt) { prompts.push(prompt); return ""; }, async secret(prompt) { prompts.push(prompt); return "generated-terminal-secret"; }, print(text) { output.push(text); }, close() {} };
  return { value, output, prompts };
}
test("one terminal follows browser choices through secret entry and approved inspection", async () => {
  const t = terminal(), calls: Record<string, unknown>[] = [];
  let phase = "scan", revision = 0, approved = false;
  await followBrowserSetup(t.value, body => {
    calls.push(body);
    if (body.operation === "setup-auth") {
      assert.equal(phase, "credentials"); assert.equal(body.revision, revision);
      assert.equal(body.username, "fixture"); assert.equal(body.password, "generated-terminal-secret"); assert.equal(body.remember, true);
      phase = "review"; revision++;
    }
    if (body.operation === "setup-inspect") { assert.ok(approved); assert.equal(phase, "inspecting"); phase = "done"; revision++; }
    return { phase, revision, savedHosts: 2, inspectedPcs: 1 };
  }, { defaultUsername: "fixture", async pause() {
    if (phase === "scan") { phase = "credentials"; revision++; }
    else if (phase === "review") { approved = true; phase = "inspecting"; revision++; }
  } });
  assert.equal(calls.filter(body => body.operation === "setup-inspect").length, 1);
  assert.ok(calls.some(body => body.operation === "setup-terminal" && body.connected === false));
  assert.ok(t.output.some(text => text.includes("2 hosts")));
  assert.ok(t.output.every(text => !text.includes("generated-terminal-secret")));
});
test("lost selection or rejected terminal authentication never starts inspection", async () => {
  const t = terminal(), calls: Record<string, unknown>[] = [];
  await assert.rejects(followBrowserSetup(t.value, body => {
    calls.push(body); if (body.operation === "setup-auth") throw new Error("Selection changed");
    return { phase: "credentials", revision: 9 };
  }, { defaultUsername: "fixture" }), /Selection changed/);
  assert.ok(!calls.some(body => body.operation === "setup-inspect"));
  assert.equal(calls.at(-1)?.connected, false);
  assert.ok(t.output.every(text => !text.includes("generated-terminal-secret")));
});
test("completed setup returns without another password prompt", async () => {
  const t = terminal(); await followBrowserSetup(t.value, () => ({ phase: "done", revision: 12 }));
  assert.deepEqual(t.prompts, []);
});
test("network suggestions use actual assigned prefixes rather than guessing a network from the dashboard address", () => {
  const address = "192.168.42.18", entry = { address, family: "IPv4" as const, netmask: "255.255.254.0", cidr: `${address}/23`, mac: "00:00:00:00:00:00", internal: false };
  const context = verifiedSetupNetwork(address, "0.1.0-dev.5", { enp1s0: [entry] }, "fixture-backend", 1234)!;
  assert.equal(context.suggestedRange, "192.168.42.0/23"); assert.equal(context.releaseTag, "modern-v0.1.0-dev.5");
  assert.equal(context.verifiedAtMs, 1234);
  assert.equal(verifiedSetupNetwork(address, "0.1.0-dev.5", {}, "fixture-backend"), undefined);
  assert.equal(verifiedSetupNetwork(address, "0.1.0-dev.5", { docker0: [entry] }, "fixture-backend"), undefined);
  assert.equal(verifiedSetupNetwork(address, "0.1.0-dev.5", { enp1s0: [{ ...entry, cidr: `${address}/16` }] }, "fixture-backend")!.suggestedRange, address);
});
