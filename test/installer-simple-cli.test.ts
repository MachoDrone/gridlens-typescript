import assert from "node:assert/strict";
import test from "node:test";
import { cliColorEnabled, cliFailure, cliSection, cliText } from "../src/installer/cli-format.ts";
import { choosePrivateEndpoint, choosePrivateWebPorts } from "../src/installer/network-selection.ts";
import { printBrowserReady } from "../src/installer/terminal.ts";

function terminal(answers: string[] = []) {
  const output: string[] = [], asked: string[] = [];
  return { output, asked, color: false,
    async ask(prompt: string) { asked.push(prompt); assert.ok(answers.length, `Unexpected prompt: ${prompt}`); return answers.shift()!; },
    async secret() { throw new Error("A simple install must not ask for computer credentials"); },
    print(value: string) { output.push(value); }, close() {},
  };
}

test("CLI colors supplement labels and honor NO_COLOR and noninteractive output", () => {
  assert.equal(cliColorEnabled(true, {}), true);
  assert.equal(cliColorEnabled(false, { FORCE_COLOR: "1" }), false);
  assert.equal(cliColorEnabled(true, { NO_COLOR: "1", FORCE_COLOR: "1" }), false);
  assert.equal(cliColorEnabled(true, { TERM: "dumb" }), false);
  assert.match(cliText({ color: true }, "success", "Ready.", {}), /^\u001b\[1;32mReady\.\u001b\[0m$/);
  assert.match(cliText({ color: true }, "action", "http://192.168.42.2:8790/", {}), /^\u001b\[1;34m/);
  assert.match(cliText({ color: true }, "pending", "Preparing…", {}), /^\u001b\[33m/);
  assert.match(cliText({ color: true }, "muted", "Saved settings retained.", {}), /^\u001b\[90m/);
  assert.match(cliFailure("Generated failure", true, {}), /\u001b\[1;31mError: Generated failure/);
  assert.equal(cliText({ color: true }, "success", "Ready.", { NO_COLOR: "" }), "Ready.");
  assert.equal(cliFailure("Generated failure", false, {}), "\nError: Generated failure\n");
});

test("Ready output provides one plain URL and browser PC management without another prompt", () => {
  const t = terminal(); cliSection(t, "GridLens installation"); printBrowserReady(t, "http://192.168.42.2:8790");
  assert.deepEqual(t.asked, []);
  assert.deepEqual(t.output.filter(line => line.startsWith("http")), ["http://192.168.42.2:8790/"]);
  assert.ok(t.output.includes("Ready.")); assert.ok(t.output.includes("Open this address, then choose Manage computers to find, add or update PCs."));
  assert.equal(t.output[0], ""); assert.equal(t.output[2], "");
  assert.ok(t.output.filter(line => line === "").length >= 4);
  assert.doesNotMatch(t.output.join("\n"), /keep.*terminal|computer password|selection complete|monitoring \[|five minutes|#code=/i);
  assert.throws(() => printBrowserReady(t, "http://8.8.8.8:8790"));
});

test("the single port prompt chooses the actual browser port and a separate HTTPS companion", async () => {
  const t = terminal([""]), probes: number[] = [];
  const result = await choosePrivateWebPorts(t, "192.168.42.2", { probe: async (_address, port) => {
    probes.push(port); return [8789, 8791].includes(port) ? "busy" : "available";
  } });
  assert.deepEqual(result, { webPort: 8790, httpsPort: 8792 });
  assert.equal(t.asked.length, 1); assert.match(t.asked[0]!, /^Web dashboard port \[8790, recommended\]/);
  assert.ok(t.output.includes("The port is the number after ':' in your dashboard address."));
  assert.ok(t.output.includes("The suggested port is free. Press Enter to use it, or enter another port."));
  assert.ok(probes.includes(8791) && probes.includes(8792));
  printBrowserReady(t, `http://192.168.42.2:${result.webPort}`);
  assert.ok(t.output.includes("http://192.168.42.2:8790/"));
});

test("first installation explains both choices without adding questions", async () => {
  const t = terminal(["", ""]);
  const address = await choosePrivateEndpoint(t, { choices: [{ address: "192.168.42.2", interfaceName: "enp1s0", family: "IPv4", kind: "lan" }],
    recommendedIndex: 0, exclusions: [] });
  const ports = await choosePrivateWebPorts(t, address.address, { probe: async () => "available" });
  assert.equal(address.address, "192.168.42.2"); assert.equal(ports.webPort, 8789);
  assert.equal(t.asked.length, 2);
  assert.ok(t.output.includes("This is this PC's IP address. Choose one your other devices can reach over your LAN or VPN."));
  assert.ok(t.output.includes("Press Enter to use the recommended address."));
  assert.ok(t.output.every(line => !line.includes("\u001b")), "Non-color output keeps the same explanations");
});

test("an explicit browser port needs no question and never becomes the HTTPS companion", async () => {
  const t = terminal(), calls: number[] = [];
  assert.deepEqual(await choosePrivateWebPorts(t, "fd42::2", { requestedWebPort: 65535, probe: async (_address, port) => {
    calls.push(port); return "available";
  } }), { webPort: 65535, httpsPort: 65534 });
  assert.deepEqual(t.asked, []); assert.deepEqual(calls, [65535, 65534]);
});

test("busy explicit ports and exhausted companion choices stop without guessing another browser port", async () => {
  const t = terminal();
  await assert.rejects(choosePrivateWebPorts(t, "192.168.42.2", { requestedWebPort: 8790, probe: async () => "busy" }), /requested web dashboard port is already in use/);
  let probes = 0;
  await assert.rejects(choosePrivateWebPorts(t, "192.168.42.2", { requestedWebPort: 8790, probe: async (_address, port) => {
    probes++; return port === 8790 ? "available" : "busy";
  } }), /No free companion port/);
  assert.equal(probes, 12); assert.deepEqual(t.asked, []);
  await assert.rejects(choosePrivateWebPorts(t, "192.168.42.2", { requestedWebPort: 70000 }), /1024 through 65535/);
});
