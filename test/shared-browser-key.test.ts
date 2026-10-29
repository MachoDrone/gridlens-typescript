import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ssh2 from "ssh2";
import { openSharedState } from "../src/backend/sqlite-state.ts";
import { openCredentialVault } from "../src/backend/credential-vault.ts";
import { createSharedService } from "../src/backend/service.ts";
import { SharedHttpError } from "../src/backend/ipc.ts";
import { inspectConnectedComputer, SshAccessError } from "../src/backend/ssh.ts";
import type { Computer, SshCredential, SshRun } from "../src/backend/ssh.ts";

const plain = ssh2.utils.generateKeyPairSync("ed25519");
const passphrase = "generated-key-passphrase-for-isolated-tests";
const encrypted = ssh2.utils.generateKeyPairSync("ed25519", { passphrase, cipher: "aes256-cbc", rounds: 16 });
const address = "1".repeat(31) + "2";
const pc: Computer = { id: "a".repeat(64), name: "Fixture PC", host: "192.168.42.3", port: 22,
  fingerprint: "SHA256:" + "A".repeat(43), hostKey: "generated-public-fixture" };
const invalid = (error: unknown) => error instanceof SharedHttpError && error.status === 400;
const excludes = (text: string, secret: string): boolean => !text.includes(secret) && !text.includes(JSON.stringify(secret).slice(1, -1));

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-browser-key-")), credentialDirectory = join(directory, "credentials");
  const state = openSharedState(join(directory, "state")), vault = openCredentialVault(credentialDirectory);
  const received: SshCredential[] = []; let rejected = false;
  const service = createSharedService(state, { vault, scan: async () => [pc], inspect: async (computer, credential) => {
    received.push({ ...credential });
    if (rejected) throw new SshAccessError("credential-rejected");
    return { associations: [{ address, binding: { pcId: computer.id, runtime: "docker", wrapperId: null, nodeContainerId: "b".repeat(64) },
      name: computer.name, sshFingerprint: computer.fingerprint, verifiedAtMs: Date.now(), privateIp: computer.host, gpuUuids: [] }], exclusions: [] };
  } });
  service.access.setFleet("default", []); const token = "k".repeat(43); service.access.registerGateway("default", token);
  await service.setup.control({ operation: "setup-scan", scopeId: "default", range: pc.host });
  const view = () => service.setup.read("default");
  const configure = (fields: Record<string, unknown>) => service.read({ operation: "setup-configure", token,
    revision: view().revision, selected: [pc.id], username: "fixture", ...fields });
  async function finish() {
    for (let attempt = 0; attempt < 100 && view().report?.status === "running"; attempt++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.notEqual(view().report?.status, "running"); await new Promise<void>(resolve => setImmediate(resolve)); return view();
  }
  return { service, state, vault, received, configure, finish, view, credentialDirectory,
    reject() { rejected = true; },
    async close() { await service.setup.close(); vault.close(); await state.close(); await rm(directory, { recursive: true }); } };
}

test("browser setup accepts generated private keys, retains only encrypted verified credentials and reuses saved keys", async () => {
  for (const fields of [{ privateKey: plain.private }, { privateKey: encrypted.private, passphrase, sudoPassword: "generated-admin-password" }]) {
    const h = await harness();
    try {
      const started = await h.configure(fields); const done = await h.finish();
      assert.equal(done.savedHosts, 1); assert.equal(done.report?.results[0]?.status, "success");
      const submitted = h.received[0]!;
      assert.ok(submitted.privateKey === fields.privateKey, "The owner supplies exactly the chosen private key to SSH");
      assert.equal(submitted.password, undefined);
      assert.equal(submitted.passphrase, "passphrase" in fields ? passphrase : undefined);
      assert.equal(submitted.sudoPassword, "sudoPassword" in fields ? fields.sudoPassword : undefined);
      const saved = h.vault.read("default", pc.id)!;
      assert.ok(saved.privateKey === fields.privateKey, "Verified key is recoverable only through the credential vault");
      const publicText = JSON.stringify([started, done, h.state.get("setup:default"), h.state.get(`permission:default:${pc.id}`)]);
      assert.ok(excludes(publicText, fields.privateKey) && excludes(publicText, passphrase));
      assert.ok(!publicText.includes("-----BEGIN OPENSSH PRIVATE KEY-----"));
      for (const name of await readdir(h.credentialDirectory)) {
        const file = await readFile(join(h.credentialDirectory, name));
        assert.ok(!file.includes(Buffer.from(fields.privateKey)) && !file.includes(Buffer.from(passphrase)), "Vault files contain no submitted plaintext");
      }
      await h.configure({ privateKey: "" }); await h.finish();
      assert.ok(h.received.at(-1)?.privateKey === fields.privateKey, "Blank key input can reuse the saved verified key");
      h.reject(); await h.configure({ privateKey: plain.private }); const failed = await h.finish();
      assert.equal(failed.report?.results[0]?.status, "failed");
      assert.ok(h.vault.read("default", pc.id)?.privateKey === fields.privateKey, "Rejected replacement leaves the previous verified key intact");
      assert.ok(excludes(JSON.stringify(failed), plain.private));
    } finally { await h.close(); }
  }
});

test("invalid, public-only, mixed, orphaned and oversized key submissions fail before state or trust changes", async () => {
  const h = await harness();
  try {
    const before = JSON.stringify(h.view());
    for (const fields of [
      { privateKey: "not a key" }, { privateKey: plain.public }, { privateKey: encrypted.private },
      { privateKey: encrypted.private, passphrase: "wrong-passphrase" }, { privateKey: plain.private, password: "mixed-password" },
      { privateKey: plain.private, username: "" }, { passphrase }, { passphrase: "", privateKey: "" },
      { privateKey: "a".repeat(65537) }, { privateKey: "é".repeat(32769) }, { privateKey: plain.private, passphrase: "p".repeat(4097) },
      { sudoPassword: "orphaned-admin-password" }, { password: "password", sudoPassword: "not-key-mode" },
      { privateKey: plain.private, sudoPassword: "s".repeat(4097) }, { privateKeyPath: "/never-read" },
    ]) {
      await assert.rejects(h.configure(fields), error => {
        assert.ok(!String(error).includes(plain.private) && !String(error).includes(passphrase)); return invalid(error);
      });
      assert.equal(JSON.stringify(h.view()), before);
    }
    assert.equal(h.received.length, 0); assert.equal(h.state.get("ssh-identities:default"), undefined);
    assert.equal(h.vault.read("default", pc.id), undefined);
  } finally { await h.close(); }
});

test("SSH key passphrases are never used as sudo passwords", async () => {
  for (const administrator of [undefined, "generated-administrator-password"] as const) {
    const calls: { command: string; input?: string }[] = [];
    const run: SshRun = async (command, options) => {
      calls.push({ command, ...(options?.input === undefined ? {} : { input: options.input }) });
      if (command === "/bin/hostname") return { code: 0, stdout: "fixture-pc\n" };
      if (command === "/usr/bin/test -x /usr/bin/podman") return { code: 1, stdout: "" };
      if (command.startsWith("/usr/bin/docker ps ") || command.startsWith("/usr/bin/sudo -n -- ")) return { code: 1, stdout: "" };
      assert.ok(administrator !== undefined); assert.equal(options?.input, administrator + "\n");
      if (command.includes("docker ps ")) return { code: 0, stdout: `${"b".repeat(64)}\tnosana/nosana-node:fixture\tfixture-node\n` };
      if (command.includes("/usr/local/bin/node -e ")) return { code: 0, stdout: address + "\n" };
      if (command.includes("nvidia-smi")) return { code: 0, stdout: "" };
      throw new Error("Unexpected fixture command");
    };
    const result = await inspectConnectedComputer(pc, { username: "fixture", privateKey: encrypted.private, passphrase,
      ...(administrator === undefined ? {} : { sudoPassword: administrator }) }, run, Date.now, { autoSudo: true });
    assert.ok(calls.every(call => !call.command.includes(passphrase) && call.input !== passphrase + "\n"));
    assert.equal(result.associations.length, administrator === undefined ? 0 : 1);
    if (administrator === undefined) assert.ok(!calls.some(call => call.command.includes("sudo -S")));
  }
});
