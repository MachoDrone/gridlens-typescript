import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { createPrivateKey } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { NetworkInterfaceInfo } from "node:os";
import { assertLocalDockerForSelection, chooseDashboardPort, choosePrivateEndpoint, discoverPrivateEndpoints, dockerNetworkExclusions, probeBindPort, recommendPort } from "../src/installer/network-selection.ts";
import { chooseSavedEndpointRepair, chooseTlsConfiguration, chooseTlsMode } from "../src/installer/terminal.ts";
import type { InstallationConfig } from "../src/installer/config.ts";

function nic(address: string, internal = false): NetworkInterfaceInfo {
  return address.includes(":") ? { address, family: "IPv6", internal, netmask: "ffff:ffff:ffff:ffff::", mac: "02:00:00:00:00:01", cidr: `${address}/64`, scopeid: 0 }
    : { address, family: "IPv4", internal, netmask: "255.255.255.0", mac: "02:00:00:00:00:01", cidr: `${address}/24` };
}
function prompts(answers: string[]) {
  const asked: string[] = [], printed: string[] = [];
  return { asked, printed, async ask(prompt: string) { asked.push(prompt); assert(answers.length, `Unexpected extra prompt: ${prompt}`); return answers.shift()!; },
    async secret() { throw new Error("No existing private key should be read in this fixture."); }, print(value: string) { printed.push(value); } };
}

test("address discovery verifies the selected Docker daemon is local, including named-context precedence", () => {
  const calls: string[][] = [];
  const local = { run(args: readonly string[]) { calls.push([...args]); return { status: 0, stderr: "", stdout: JSON.stringify("unix:///var/run/docker.sock") }; } };
  assertLocalDockerForSelection(local, {});
  assertLocalDockerForSelection(local, { DOCKER_HOST: "ssh://generated-remote", DOCKER_CONTEXT: "generated-local" });
  assert.equal(calls.length, 2); assert(calls.every(call => call.join(" ") === "context inspect --format {{json .Endpoints.docker.Host}}"));
  assert.throws(() => assertLocalDockerForSelection(local, { DOCKER_HOST: "ssh://generated-remote" }), /must run on the backend PC/);
  assert.equal(calls.length, 2, "A remote endpoint is never used to infer local addresses");
  assert.throws(() => assertLocalDockerForSelection({ run: () => ({ status: 0, stderr: "", stdout: JSON.stringify("ssh://generated-remote") }) }, {}), /must run on the backend PC/);
});

test("address menu excludes localhost, global/link-local and container assignments while preserving LAN, VPN and ULA choices", () => {
  const result = discoverPrivateEndpoints({ lo: [nic("127.0.0.1", true), nic("::1", true)],
    enp3s0: [nic("192.168.42.20"), nic("2001:db8::20"), nic("fe80::20")],
    wg0: [nic("10.42.0.2"), nic("fd42::2")], docker0: [nic("172.17.0.1")], podman0: [nic("10.88.0.1")],
    "br-abcdef123456": [nic("172.18.0.1")], vethfixture: [nic("10.9.0.1")], cni0: [nic("10.244.0.1")],
    wlan0: [nic("169.254.42.2")], public0: [nic("8.8.8.8")], tailscale0: [nic("100.64.0.2")],
  });
  assert.deepEqual(result.choices.map(value => value.address), ["192.168.42.20", "10.42.0.2", "fd42::2"]);
  assert.equal(result.recommendedIndex, 0); assert.equal(result.choices[1]!.kind, "vpn");
  assert(result.exclusions.some(row => row.interfaceName === "docker0" && row.reason === "container-interface"));
  assert(result.exclusions.some(row => row.interfaceName === "lo" && row.reason === "loopback"));
});

test("only Docker-proven custom bridges are excluded; a legitimate br0 LAN remains available", () => {
  const id = "a".repeat(64), calls: readonly string[][] = [];
  const recorded = calls as string[][];
  const exclusions = dockerNetworkExclusions({ run(args) {
    recorded.push([...args]);
    return { status: 0, stderr: "", stdout: args[1] === "ls" ? id.slice(0, 12) : JSON.stringify([{ Id: id, Driver: "bridge", Options: { "com.docker.network.bridge.name": "custom-container" }, IPAM: { Config: [{ Gateway: "172.25.0.1" }] } }]) };
  } });
  assert.deepEqual(recorded, [["network", "ls", "--filter", "driver=bridge", "--format", "{{.ID}}"], ["network", "inspect", id.slice(0, 12)]]);
  const result = discoverPrivateEndpoints({ br0: [nic("10.42.1.2")], "custom-container": [nic("172.25.0.1")], enp1s0: [nic("172.25.0.1")] }, exclusions);
  assert.deepEqual(result.choices.map(row => row.address), ["10.42.1.2"]);
  assert.throws(() => dockerNetworkExclusions({ run: () => ({ status: 1, stdout: "", stderr: "permission denied" }) }), /could not be verified/);
});

test("Enter accepts a sole LAN recommendation and invalid answers cannot invent an address", async () => {
  const candidates = discoverPrivateEndpoints({ enp1s0: [nic("10.42.0.2")], wg0: [nic("10.99.0.2")] });
  const terminal = prompts(["127.0.0.1", "9", ""]);
  assert.equal((await choosePrivateEndpoint(terminal, candidates)).address, "10.42.0.2");
  assert.equal(terminal.asked.length, 3); assert.match(terminal.asked[0]!, /1, recommended/);
  const ambiguous = discoverPrivateEndpoints({ eth0: [nic("10.42.0.2")], wlan0: [nic("192.168.42.2")] });
  assert.equal(ambiguous.recommendedIndex, null);
  assert.equal((await choosePrivateEndpoint(prompts(["", "2"]), ambiguous)).address, "192.168.42.2");
});

test("VPN-only ULA remains explicit and no eligible network produces a clear prerequisite rather than a synthetic IP", async () => {
  const vpn = discoverPrivateEndpoints({ wg0: [nic("fd42::2")] });
  assert.equal(vpn.choices.length, 1); assert.equal(vpn.recommendedIndex, null);
  assert.equal((await choosePrivateEndpoint(prompts(["1"]), vpn)).address, "fd42::2");
  const none = prompts([]);
  await assert.rejects(choosePrivateEndpoint(none, discoverPrivateEndpoints({ lo: [nic("127.0.0.1", true)], enp1s0: [nic("8.8.8.8")] })), /No eligible private address.*Public-only installation is not supported yet/);
  assert.equal(none.asked.length, 0);
});

test("port selection probes the exact address, skips occupied defaults and re-prompts invalid or raced selections", async () => {
  const calls: [string, number][] = [], terminal = prompts(["1e4", "70000", "8791", ""]);
  const probe = async (address: string, port: number) => { calls.push([address, port]); return port === 8789 || port === 8791 ? "busy" as const : "available" as const; };
  const selected = await chooseDashboardPort(terminal, "10.42.0.2", { probe });
  assert.equal(selected, 8790); assert(calls.every(([address]) => address === "10.42.0.2"));
  assert(!calls.some(([, port]) => port === 70000 || port === 10_000));
  assert(terminal.printed.some(value => /Port 8791 is already in use/.test(value)));
  assert.match(terminal.asked[0]!, /8790, recommended/);
});

test("default port search is bounded and arbitrary user ports remain explicit when its range is full", async () => {
  const checked: number[] = [];
  assert.equal(await recommendPort("fd42::2", { probe: async (_address, port) => { checked.push(port); return "busy"; } }), null);
  assert.deepEqual(checked, Array.from({ length: 11 }, (_, index) => 8789 + index));
  const terminal = prompts(["", "9443"]);
  assert.equal(await chooseDashboardPort(terminal, "fd42::2", { probe: async (_address, port) => port === 9443 ? "available" : "busy" }), 9443);
  await assert.rejects(chooseDashboardPort(prompts([]), "10.42.0.2", { probe: async () => "unavailable" }), /selected address cannot be bound/);
});

test("real local port probe detects a listener without replacing it and releases its own temporary bind", async () => {
  const occupied = createServer(socket => socket.destroy());
  await new Promise<void>(resolve => occupied.listen(0, "127.0.0.1", resolve));
  const address = occupied.address(); assert(address && typeof address !== "string");
  try { assert.equal(await probeBindPort("127.0.0.1", address.port), "busy"); assert(occupied.listening); }
  finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
  assert.equal(await probeBindPort("127.0.0.1", address.port), "available");
  const after = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => { after.once("error", reject); after.listen(address.port, "127.0.0.1", resolve); });
  await new Promise<void>(resolve => after.close(() => resolve()));
});

test("private TLS is the Enter default; invalid choices re-prompt before key access or configuration changes", async () => {
  const terminal = prompts(["unsupported", ""]); let reads = 0;
  assert.equal(await chooseTlsConfiguration(terminal, "10.42.0.2", { readText: () => { reads++; throw new Error(); } }), undefined);
  assert.equal(reads, 0); assert.equal(terminal.asked.length, 2);
  assert(terminal.printed.some(value => /public CA certificate/.test(value))); assert(terminal.printed.some(value => /server certificate pin/.test(value)));
  assert.equal(await chooseTlsMode(prompts(["2"])), "existing");
  assert.equal(await chooseTlsMode(prompts(["PRIVATE"])), "private");
});

test("unreadable existing TLS files return to the explicit TLS choice and do not print file contents", async () => {
  const terminal = prompts(["existing", "/generated/cert.pem", "/generated/key.pem", ""]);
  const read: string[] = [];
  assert.equal(await chooseTlsConfiguration(terminal, "10.42.0.2", { readText: file => { read.push(file); throw new Error("generated-secret-error"); } }), undefined);
  assert.deepEqual(read, ["/generated/cert.pem"]); assert(!terminal.printed.join("\n").includes("generated-secret-error"));
  assert(terminal.printed.some(value => /configuration has not changed/.test(value)));
});

test("existing generated TLS keys validate IP, key/passphrase and dates before returning an installable choice", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gridlens-tls-choice-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"),
      "-days", "1", "-subj", "/CN=Generated fixture", "-addext", "subjectAltName=IP:10.42.0.2"], { stdio: "ignore" });
    const certificate = readFileSync(join(directory, "cert.pem"), "utf8"), key = readFileSync(join(directory, "key.pem"), "utf8");
    const encrypted = createPrivateKey(key).export({ format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase: "generated-passphrase" }).toString();
    const passwords = ["wrong-generated-passphrase", "generated-passphrase"];
    const terminal = { ...prompts(["existing", "certificate", "key", "existing", "certificate", "key"]), async secret() { return passwords.shift()!; } };
    const result = await chooseTlsConfiguration(terminal, "10.42.0.2", { readText: file => file === "certificate" ? certificate : encrypted });
    assert.equal(result?.certificate, certificate); assert.equal(createPrivateKey(result!.privateKey).asymmetricKeyType, "rsa");
    assert.equal(passwords.length, 0); assert(terminal.printed.some(value => /did not validate/.test(value)));
    assert(!terminal.printed.join("\n").includes("generated-passphrase")); assert(!terminal.printed.join("\n").includes(key));
    const wrongIp = prompts(["existing", "certificate", "key", ""]);
    assert.equal(await chooseTlsConfiguration(wrongIp, "10.42.0.3", { readText: file => file === "certificate" ? certificate : key }), undefined);
    assert(wrongIp.printed.some(value => /selected IP/.test(value)));
    const expired = prompts(["existing", "certificate", "key", ""]);
    assert.equal(await chooseTlsConfiguration(expired, "10.42.0.2", { readText: file => file === "certificate" ? certificate : key, now: () => Date.now() + 2 * 86_400_000 }), undefined);
  } finally { rmSync(directory, { recursive: true }); }
});

const saved: InstallationConfig = { schema: 1, instance: "fixture", bindAddress: "10.42.0.2", port: 8789, origin: "https://10.42.0.2:8789",
  certificateSha256: "a".repeat(64), phase: "ready", active: { imageId: "sha256:" + "b".repeat(64), version: "0.1.0", sequence: 1, stateVolume: "gridlens-modern-fixture-state-one" } };
test("healthy saved endpoints and applying image transactions never mistake their own occupied port for a conflict", async () => {
  const terminal = prompts([]); let assessments = 0;
  const assess = () => { assessments++; return { state: "healthy", repairRequired: false }; };
  const probe = async () => { throw new Error("A healthy/applying endpoint must not be probed"); };
  assert.equal(await chooseSavedEndpointRepair(terminal, saved, assess, probe), undefined);
  assert.equal(await chooseSavedEndpointRepair(terminal, { ...saved, phase: "applying" }, assess, probe), undefined);
  assert.equal(assessments, 1); assert.equal(terminal.asked.length, 0);
});
test("broken saved and pending endpoints keep a free port but require an explicit replacement if occupied", async () => {
  const calls: number[] = [], assess = () => ({ state: "detached", repairRequired: true });
  assert.equal(await chooseSavedEndpointRepair(prompts([]), saved, assess, async (_address, port) => { calls.push(port); return "available"; }), undefined);
  assert.deepEqual(calls, [8789]);
  const pending = { ...saved, pendingPort: 8790 }, terminal = prompts(["9443"]);
  const changed = await chooseSavedEndpointRepair(terminal, pending, assess, async (_address, port) => { calls.push(port); return port === 8790 || port === 8789 ? "busy" : "available"; });
  assert.equal(changed, 9443); assert.equal(calls[1], 8790, "Assess the journaled target, not the old canonical port");
  assert(terminal.printed.some(value => /pending dashboard endpoint.*port 8790/.test(value)));
  assert.equal(pending.port, 8789); assert.equal(pending.pendingPort, 8790, "Prompting never mutates saved recovery state");
});
