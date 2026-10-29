import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSharedState } from "../src/backend/sqlite-state.ts";
import { openCredentialVault } from "../src/backend/credential-vault.ts";
import { createSharedService } from "../src/backend/service.ts";
import { SharedHttpError } from "../src/backend/ipc.ts";
import { inspectConnectedComputer, SshAccessError } from "../src/backend/ssh.ts";
import type { Computer, SshCredential, SshRun } from "../src/backend/ssh.ts";
import type { PcAssociation } from "../src/contracts/shared.ts";

const hosts = [2, 3, 4].map(n => "1".repeat(31) + n);
const pcs: Computer[] = ["a", "b"].map((id, i) => ({ id: id.repeat(64), name: `Fixture PC ${i + 1}`, host: `192.168.42.${i + 2}`,
  port: 22, fingerprint: "SHA256:" + id.toUpperCase().repeat(43), hostKey: "generated-fixture-public-key" }));
const failure = (status: number) => (error: unknown) => error instanceof SharedHttpError && error.status === status;
async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-browser-manager-")), state = openSharedState(join(directory, "state"));
  const vault = openCredentialVault(join(directory, "credentials"));
  let scanned = pcs, gate: Promise<void> | undefined;
  const rejected = new Set<string>(), empty = new Set<string>(), calls: { id: string; credential: SshCredential }[] = [];
  const associations = (computer: Computer): PcAssociation[] => (computer.id === pcs[0]!.id ? hosts.slice(0, 2) : hosts.slice(2)).map((address, i) => ({
    address, binding: { pcId: computer.id, runtime: "docker", wrapperId: null, nodeContainerId: String(i + 1).repeat(64) },
    name: computer.name, sshFingerprint: computer.fingerprint, verifiedAtMs: 1_800_000_000_000, privateIp: computer.host, gpuUuids: [],
  }));
  const service = createSharedService(state, { vault, scan: async () => scanned, inspect: async (computer, credential, _now, options) => {
    assert.equal(options?.autoSudo, true); calls.push({ id: computer.id, credential: { ...credential } });
    if (gate) await gate;
    if (rejected.has(computer.id)) throw new SshAccessError("credential-rejected");
    return { associations: empty.has(computer.id) ? [] : associations(computer), exclusions: [], credential: { ...credential }, name: computer.name };
  } });
  service.access.setFleet("default", []);
  const operator = service.access.pair(service.access.createCode("default", "operator").code, "Fixture operator");
  // Dedicated gateway grant follows roster changes, like the private-network web entry.
  const token = "g".repeat(43); service.access.registerGateway("default", token);
  const view = () => service.setup.read("default");
  const configure = (extra: Record<string, unknown> = {}) => service.read({ operation: "setup-configure", token,
    revision: view().revision, selected: pcs.map(pc => pc.id), username: "fixture", password: "generated-password", ...extra });
  async function finish() {
    for (let i = 0; i < 100 && view().report?.status === "running"; i++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.notEqual(view().report?.status, "running");
    await new Promise<void>(resolve => setImmediate(resolve)); // Let the completed job release its admission slot.
    return view();
  }
  await service.setup.control({ operation: "setup-scan", scopeId: "default", range: "192.168.42.0/24" });
  return { state, vault, service, operator, token, view, configure, finish, calls, rejected, empty,
    setScanned(value: Computer[]) { scanned = value; }, setGate(value?: Promise<void>) { gate = value; },
    async close() { await service.setup.close(); vault.close(); await state.close(); await rm(directory, { recursive: true }); },
  };
}

test("browser setup acknowledges before SSH completes and reports each PC without retaining submitted secrets", async () => {
  const h = await harness(); let release!: () => void;
  h.setGate(new Promise(resolve => { release = resolve; })); h.rejected.add(pcs[1]!.id);
  try {
    const started = await h.configure() as ReturnType<typeof h.view>;
    assert.equal(started.phase, "inspecting"); assert.equal(started.report?.status, "running");
    assert.ok(!JSON.stringify(started).includes("generated-password"));
    assert.throws(() => h.service.setup.action("default", { action: "scan", revision: h.view().revision, range: "192.168.42.0/24" }), failure(409));
    await assert.rejects(h.configure(), failure(409));
    release(); const done = await h.finish();
    assert.equal(done.phase, "done"); assert.equal(done.savedHosts, 2); assert.equal(done.report?.completed, 2);
    assert.deepEqual(done.report?.results.map(row => row.status), ["success", "failed"]);
    assert.match(done.report!.results[1]!.message, /Sign-in rejected/);
    assert.equal(done.managed[0]!.username, "fixture"); assert.equal(done.managed[0]!.hasSavedCredential, true);
    assert.ok(!JSON.stringify(h.state.get("setup:default")).includes("generated-password"));
    assert.ok(!JSON.stringify(done).includes("generated-password"));
    assert.equal(h.vault.read("default", pcs[0]!.id)?.password, "generated-password");
    assert.equal(h.vault.read("default", pcs[1]!.id), undefined);
    const permission = h.state.get<{ automaticIp: boolean; rewards: boolean; gpu: boolean }>(`permission:default:${pcs[0]!.id}`)!;
    assert.deepEqual([permission.automaticIp, permission.rewards, permission.gpu], [true, false, false]);
  } finally { release(); await h.close(); }
});

test("PC removal revokes only its monitoring, forgets its login, and explicit restore cannot silently restore full monitoring", async () => {
  const h = await harness();
  try {
    await h.configure({ fullMonitoring: true }); await h.finish();
    const before = h.state.get<Record<string, unknown>>(`permission:default:${pcs[1]!.id}`)!;
    h.state.set("provider:test-budget", { used: 42, retryAtMs: 9_000_000_000_000 });
    const removed = await h.service.read({ operation: "setup-remove", token: h.token, revision: h.view().revision, pcId: pcs[0]!.id }) as ReturnType<typeof h.view>;
    assert.deepEqual(h.service.access.fleet("default").addresses, hosts.slice(2));
    assert.equal(h.vault.read("default", pcs[0]!.id), undefined);
    assert.ok(h.vault.read("default", pcs[1]!.id));
    assert.equal(removed.managed.find(row => row.id === pcs[0]!.id)?.removed, true);
    assert.deepEqual(h.state.get(`permission:default:${pcs[1]!.id}`), { ...before, rosterRevision: h.service.access.fleet("default").rosterRevision });
    const calls = h.calls.length;
    await h.configure({ selected: [pcs[0]!.id] }); await h.finish();
    assert.equal(h.calls.length, calls); assert.deepEqual(h.service.access.fleet("default").addresses, hosts.slice(2));
    assert.match(h.view().report!.results[0]!.message, /Restore/);
    await h.configure({ selected: [pcs[0]!.id], restorePcIds: [pcs[0]!.id], fullMonitoring: false }); await h.finish();
    assert.equal(h.service.access.fleet("default").addresses.length, 3);
    const restored = h.state.get<{ revokedAtMs: number | null; rewards: boolean; gpu: boolean; automaticIp: boolean }>(`permission:default:${pcs[0]!.id}`)!;
    assert.equal(restored.revokedAtMs, null); assert.equal(restored.automaticIp, true); assert.equal(restored.rewards, false); assert.equal(restored.gpu, false);
    assert.deepEqual(h.state.get("provider:test-budget"), { used: 42, retryAtMs: 9_000_000_000_000 });
  } finally { await h.close(); }
});

test("saved logins can be reused or updated without losing retained hosts, while rejected credentials leave the good login intact", async () => {
  const h = await harness();
  try {
    await h.configure({ selected: [pcs[0]!.id], fullMonitoring: true }); await h.finish();
    await h.configure({ selected: [pcs[0]!.id], username: "", password: "" }); await h.finish();
    assert.equal(h.calls.at(-1)?.credential.password, "generated-password");
    h.empty.add(pcs[0]!.id);
    await h.configure({ selected: [pcs[0]!.id], password: "generated-new-password" }); await h.finish();
    assert.deepEqual(h.service.access.fleet("default").addresses, hosts.slice(0, 2));
    assert.equal(h.vault.read("default", pcs[0]!.id)?.password, "generated-new-password");
    h.rejected.add(pcs[0]!.id);
    await h.configure({ selected: [pcs[0]!.id], password: "generated-bad-password" }); await h.finish();
    assert.equal(h.vault.read("default", pcs[0]!.id)?.password, "generated-new-password");
    assert.equal(h.state.get<{ rewards: boolean }>(`permission:default:${pcs[0]!.id}`)?.rewards, true);
  } finally { await h.close(); }
});

test("browser management enforces operator access, revision, selected identity and credential input boundaries", async () => {
  const h = await harness();
  try {
    const viewer = h.service.access.pair(h.service.access.createCode("default", "viewer").code, "Fixture viewer");
    await assert.rejects(h.configure({ token: viewer.token }), failure(401));
    await assert.rejects(h.configure({ revision: -1 }), failure(409));
    await assert.rejects(h.configure({ selected: ["f".repeat(64)] }), failure(400));
    await assert.rejects(h.configure({ privateKey: "must-not-enter-browser" }), failure(400));
    await assert.rejects(h.configure({ restorePcIds: ["f".repeat(64)] }), failure(400));
    await h.configure({ selected: [pcs[0]!.id] }); await h.finish();
    const replacement = { ...pcs[0]!, id: "c".repeat(64), fingerprint: "SHA256:" + "C".repeat(43) };
    h.setScanned([replacement]);
    await h.service.setup.control({ operation: "setup-scan", scopeId: "default", range: "192.168.42.0/24" });
    assert.equal(h.view().computers.length, 0);
    await assert.rejects(h.configure({ selected: [replacement.id] }), failure(400));
    assert.ok(h.view().exclusions.some(value => value.includes("changed SSH identity")));
  } finally { await h.close(); }
});

test("shutdown fences unfinished browser setup and restart requests sign-in again without persisting its secret", async () => {
  const h = await harness(); let release!: () => void;
  h.setGate(new Promise(resolve => { release = resolve; }));
  try {
    await h.configure({ selected: [pcs[0]!.id] });
    const closing = h.service.setup.close(); release(); await closing;
    assert.deepEqual(h.service.access.fleet("default").addresses, []);
    assert.equal(h.vault.read("default", pcs[0]!.id), undefined);
    assert.ok(!JSON.stringify(h.state.get("setup:default")).includes("generated-password"));
    const restarted = createSharedService(h.state, { vault: h.vault });
    assert.equal(restarted.setup.read("default").report?.status, "failed");
    assert.equal(restarted.setup.read("default").phase, "credentials");
    await restarted.setup.close();
  } finally { release(); await h.close(); }
});

test("automatic sudo uses fixed commands and stdin, and absent optional native Podman is not reported as a failure", async () => {
  for (const mode of ["direct", "passwordless", "password"] as const) {
    const calls: { command: string; input?: string }[] = [], wrapper = "f".repeat(64), node = "d".repeat(64);
    const run: SshRun = async (command, options) => {
      calls.push({ command, ...(options?.input === undefined ? {} : { input: options.input }) });
      if (command === "/bin/hostname") return { code: 0, stdout: "fixture-pc\n" };
      if (command === "/usr/bin/test -x /usr/bin/podman") return { code: 1, stdout: "" };
      const prefix = mode === "direct" ? "" : mode === "passwordless" ? "/usr/bin/sudo -n -- " : "/usr/bin/sudo -S -p '' -- ";
      if (command.startsWith("/usr/bin/docker ps ") && mode !== "direct") return { code: 1, stdout: "" };
      if (command.startsWith("/usr/bin/sudo -n -- ") && mode === "password") return { code: 1, stdout: "" };
      if (!command.startsWith(prefix)) throw new Error("Unexpected fixed inventory command");
      const plain = command.slice(prefix.length);
      if (plain.startsWith("/usr/bin/docker ps ")) return { code: 0, stdout: `${wrapper}\tnosana/podman:v1.1.2\tfixture-wrapper\n` };
      if (plain.includes(`/usr/bin/docker exec ${wrapper} /usr/bin/podman ps `)) return { code: 0, stdout: `${node}\tnosana/nosana-node:fixture\tfixture-node\n` };
      if (plain.includes("/usr/bin/env -i /usr/local/bin/node -e ")) return { code: 0, stdout: hosts[0]! + "\n" };
      if (plain.includes("nvidia-smi")) return { code: 0, stdout: "" };
      throw new Error("Unexpected fixed inventory command");
    };
    const result = await inspectConnectedComputer(pcs[0]!, { username: "fixture", password: "generated-sudo-password" }, run, Date.now, { autoSudo: true });
    assert.equal(result.associations.length, 1); assert.deepEqual(result.exclusions, []);
    assert.equal(result.associations[0]!.binding.wrapperId, wrapper);
    assert.ok(calls.every(call => !call.command.includes("generated-sudo-password")));
    if (mode === "direct") assert.ok(calls.every(call => !call.command.includes("/sudo")));
    if (mode === "passwordless") assert.ok(calls.every(call => call.input === undefined));
    if (mode === "password") { assert.equal(result.credential?.sudoPassword, "generated-sudo-password"); assert.ok(calls.some(call => call.input === "generated-sudo-password\n")); }
  }
});

test("a missing Docker executable is reported without sudo or password retries", async () => {
  const commands: string[] = [];
  const result = await inspectConnectedComputer(pcs[0]!, { username: "fixture", password: "generated-password" }, async command => {
    commands.push(command);
    return command === "/bin/hostname" ? { code: 0, stdout: "fixture-pc\n" } : { code: command.includes("docker ps") ? 127 : 1, stdout: "" };
  }, Date.now, { autoSudo: true });
  assert.ok(commands.every(command => !command.includes("sudo")));
  assert.deepEqual(result.exclusions, ["fixture-pc: Docker command is not available on this computer."]);
});
