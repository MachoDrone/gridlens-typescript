import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { openCredentialVault } from "../src/backend/credential-vault.ts";
import { openSharedState } from "../src/backend/sqlite-state.ts";
import { createObservationStore } from "../src/backend/observations.ts";
import { createPcMonitor } from "../src/backend/pc-monitor.ts";
import type { PcPermission } from "../src/backend/pc-monitor.ts";
import { readPcNetwork } from "../src/backend/pc-network.ts";
import { exactAmount, amountFromResponse, rewardsReaderSource, walletBytes } from "../src/backend/rewards-reader.ts";
import { readRewards } from "../src/backend/pc-rewards.ts";
import { validateAndroidRecorder, androidRecorderName, ANDROID_RECORDER_IMAGE, readAndroidRecorder } from "../src/backend/android-recorder.ts";
import type { PcAssociation } from "../src/contracts/shared.ts";
import type { FleetContext } from "../src/contracts/fleet.ts";
import type { SshRun } from "../src/backend/ssh.ts";

const base = 1_800_000_000_000, host = "11111111111111111111111111111112", pcId = "a".repeat(64), nodeId = "b".repeat(64);
const context: FleetContext = { scopeId: "test", rosterRevision: "one", addresses: [host] };
const gpu = "GPU-11111111-2222-3333-4444-555555555555";
const association: PcAssociation = { address: host, binding: { pcId, runtime: "docker", wrapperId: null, nodeContainerId: nodeId },
  name: "Synthetic PC", sshFingerprint: "SHA256:" + "A".repeat(43), verifiedAtMs: base, privateIp: "10.0.0.2", gpuUuids: [gpu] };
const permission: PcPermission = { version: 1, computer: { id: pcId, host: "10.0.0.2", port: 22, name: "Synthetic PC", fingerprint: association.sshFingerprint, hostKey: "fixture" },
  associations: [association], rosterRevision: "one", automaticIp: true, rewards: true, gpu: true, approvedAtMs: base, revokedAtMs: null, paused: false };

test("remembered SSH credentials are authenticated encrypted records bound to fleet and PC", async () => {
  const root = await mkdtemp(join(tmpdir(), "gridlens-vault-"));
  let vault = openCredentialVault(root);
  try {
    const credential = { username: "synthetic", password: "generated-test-password", sudoPassword: "generated-test-sudo" };
    vault.save("one", pcId, credential);
    for (const path of await readdir(root)) assert(!(await readFile(join(root, path))).includes(Buffer.from(credential.password)));
    assert.deepEqual(vault.read("one", pcId), credential); assert.equal(vault.read("other", pcId), undefined);
    vault.close(); vault = openCredentialVault(root); assert.deepEqual(vault.read("one", pcId), credential);
    vault.forget("one", pcId); assert.equal(vault.read("one", pcId), undefined);
  } finally { vault.close(); await rm(root, { recursive: true, force: true }); }
});

test("PC IP collection retains independent interface source and never falls back after HTTP refusal", async () => {
  const commands: string[] = [];
  const denied = await readPcNetwork(async command => {
    commands.push(command);
    return command === "/bin/hostname -I" ? { code: 0, stdout: "10.0.0.2 10.0.0.9" }
      : { code: 0, stdout: "HTTP/2 429\r\nRetry-After: 3600\r\n\r\nbusy" };
  }, "10.0.0.9", () => base);
  assert.equal(denied.privateIp, "10.0.0.9"); assert.equal(denied.publicIp, null);
  assert.equal(denied.publicFailure, "http-refusal"); assert.equal(denied.retryAtMs, base + 3_600_000);
  assert.equal(commands.length, 2); assert(!commands.some(command => /sudo|docker|api6/.test(command)));
  const fallback: string[] = [];
  const ok = await readPcNetwork(async command => { fallback.push(command); return command === "/bin/hostname -I" ? { code: 0, stdout: "10.0.0.2" }
    : command.includes(" -4 ") ? { code: 7, stdout: "" } : { code: 0, stdout: "HTTP/2 200\r\n\r\n2606:4700:4700::1111" }; }, "10.0.0.2", () => base);
  assert.equal(ok.status, "ok"); assert.equal(fallback.length, 3);
});

test("TypeScript reward helper preserves exact six-decimal source tokens and serializes runnable code", () => {
  assert.equal(exactAmount("835.400645"), "835.400645");
  assert.equal(exactAmount("8.35400645e2"), "835.400645");
  assert.equal(amountFromResponse('{"claimableUptimeNosRewards":9007199254.740991}'), "9007199254.740991");
  for (const text of ['{"claimableUptimeNosRewards":1,"claimableUptimeNosRewards":2}', '{"claimableUptimeNosRewards":"1"}', '{"rewards":{"claimableUptimeNosRewards":1}}']) {
    assert.throws(() => amountFromResponse(text));
  }
  assert.throws(() => exactAmount("0.0000001"));
  const bytes = Buffer.from(JSON.stringify(Array.from({ length: 64 }, (_, i) => i)));
  assert.equal(walletBytes(bytes, bytes.length).length, 64);
  new Script(rewardsReaderSource());
  assert.match(rewardsReaderSource(), /rejectUnauthorized: true/);
});

test("rewards identity mismatch never dispatches the signer; future-clock denials retain permission and cooldown meaning", async () => {
  const commands: string[] = [];
  const run: SshRun = async command => {
    commands.push(command);
    if (command.includes(" inspect ")) return { code: 0, stdout: `${nodeId}\ttrue\tnosana/nosana-node:fixture` };
    return { code: 0, stdout: "11111111111111111111111111111113" };
  };
  assert.equal((await readRewards(run, association, () => base)).status, "identity-mismatch");
  assert.equal(commands.length, 2); assert(!commands.some(command => command.includes("ulimit")));
  const outcome = await readRewards(async command => command.includes(" inspect ") ? { code: 0, stdout: `${nodeId}\ttrue\tnosana/nosana-node:fixture` }
    : command.includes("ulimit") ? { code: 0, stdout: JSON.stringify({ schema: 1, address: host, observedAtMs: base + 86_400_000, status: "authentication-failed", retryAfterSeconds: 3600 }) }
      : { code: 0, stdout: host }, association, () => base);
  assert.equal(outcome.status, "authentication-failed"); assert.equal(outcome.observedAtMs, base); assert.equal(outcome.retryAfterSeconds, 3600);
});

test("Android recorder reuse requires source, labels, image, resource limits and exact GPU/node bindings", () => {
  const source = `BOUND_ADDRESS = '${host}'\nBOUND_NODE_ID = '${nodeId}'\nBOUND_UUIDS = ['${gpu}']\nfixture external source`;
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const volume = androidRecorderName(association) + "-data";
  const parts = ["android", "node-gpu-recorder", "1", hash(source), ANDROID_RECORDER_IMAGE, `container:${nodeId}`, "true", "false",
    `volume:${volume}:/data:true;`, "true", "", "private", "", "null", '["ALL"]', '["no-new-privileges"]', "null", "{}", "null", "null",
    JSON.stringify([{ Count: 0, Driver: "", DeviceIDs: [gpu], Capabilities: [["gpu"]], Options: {} }]), "null", "134217728", "250000000", "32", "unless-stopped", "NVIDIA_DRIVER_CAPABILITIES=utility;", "c".repeat(64)];
  const cmd = ["python", "-B", "-c", source, "run"];
  assert.equal(validateAndroidRecorder(parts, cmd, association, nodeId, hash("fixture external source")).id, "c".repeat(64));
  for (const [index, value] of [[0, "typescript"], [3, "0".repeat(64)], [5, "host"], [7, "true"], [8, "bind:/etc:/data:true;"], [24, "0"]] as const) {
    const changed = [...parts]; changed[index] = value;
    assert.throws(() => validateAndroidRecorder(changed, cmd, association, nodeId, hash("fixture external source")));
  }
  assert.throws(() => validateAndroidRecorder(parts, cmd, { ...association, gpuUuids: [] }, nodeId, hash("fixture external source")));
});

test("missing/incompatible recorders stay explicit and never trigger creating a competing writer", async () => {
  const commands: string[] = [];
  const output = await readAndroidRecorder(async command => {
    commands.push(command);
    if (command.includes("container inspect")) return { code: 1, stdout: "" };
    if (command.includes(" inspect ") && command.includes(".Id")) return { code: 0, stdout: `${nodeId}\ttrue\tnosana/nosana-node:fixture` };
    if (command.includes("NetworkMode")) return { code: 0, stdout: "bridge" };
    if (command.includes("nvidia-smi")) return { code: 0, stdout: gpu };
    return { code: 0, stdout: host };
  }, association, () => base);
  assert.equal(output.status, "not-enabled");
  assert(!commands.some(command => /\b(create|start|restart|pull|stop|rm)\b/.test(command)));
});

test("monitor honors persisted wallet denial independently from GPU/IP and keeps revocation through restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "gridlens-monitor-"));
  let time = base, rewardReads = 0, gpuReads = 0, ipReads = 0;
  const state = openSharedState(join(root, "state"), { now: () => time }), vault = openCredentialVault(join(root, "vault"));
  const observations = createObservationStore(state, "fixture-server", () => time);
  observations.associate(context, [association]); state.set(`permission:test:${pcId}`, permission);
  vault.save("test", pcId, { username: "fixture", password: "fixture-generated" });
  const make = () => createPcMonitor({ state, vault, observations, contexts: () => [context], now: () => time,
    connect: async (_computer, _credential, action) => action(async () => ({ code: 0, stdout: "" })),
    networkReader: async () => { ipReads++; return { schema: 1, source: "pc-egress-ipify", observedAtMs: time, status: "ok", publicIp: "8.8.8.8", publicObservedAtMs: time, privateIp: "10.0.0.2", privateObservedAtMs: time }; },
    rewardsReader: async () => { rewardReads++; return { schema: 1, address: host, observedAtMs: time, status: "authentication-failed" }; },
    gpuReader: async () => { gpuReads++; return { schema: 2, address: host, observedAtMs: null, status: "not-enabled", gpuUuids: [], intervalSeconds: 15,
      fromAtMs: time, toAtMs: time, truncated: false, clockTrusted: false, samples: [] }; } });
  let monitor = make();
  try {
    await monitor.tick(); assert.equal(rewardReads, 1); assert.equal(gpuReads, 1); assert.equal(ipReads, 1);
    await monitor.stop(); time += 600_000; monitor = make(); await monitor.tick();
    assert.equal(rewardReads, 1); assert.equal(gpuReads, 2); assert.equal(ipReads, 1);
    assert.equal(observations.read(context).observations[0]!.rewards?.status, "authentication-failed");
    state.set(`permission:test:${pcId}`, { ...permission, revokedAtMs: time });
    time += 1_800_000; await monitor.tick(); assert.equal(rewardReads, 1); assert.equal(gpuReads, 2); assert.equal(ipReads, 1);
  } finally { await monitor.stop(); await state.close(); vault.close(); await rm(root, { recursive: true, force: true }); }
});
