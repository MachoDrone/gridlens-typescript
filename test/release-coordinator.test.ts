import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { COMPONENT_DESCRIPTOR, COMPONENT_SIGNATURE, coordinatorInputs, loadCoordinatorComponent, parseCoordinatorComponent,
  publicKeyFingerprint, renderCoordinatorLauncher, verifyCoordinatorComponent } from "../scripts/release-coordinator.ts";
import { sha256 } from "../scripts/release-runtime.ts";

function fixture() {
  const keys = generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const binary = Buffer.from("Generated inert component; never executed.");
  const descriptor = parseCoordinatorComponent({ format: "gridlens-coordinator-component-v1", coordinatorVersion: 2, node: "24.14.1", platform: "linux-x64",
    releaseTag: "modern-v0.1.0-component-fixture", name: "gridlens-coordinator-linux-x64", bytes: binary.length, sha256: sha256(binary),
    signature: "gridlens-coordinator-linux-x64.sig", inputFingerprint: "b".repeat(64), publicKeySha256: publicKeyFingerprint(publicKey) });
  const bytes = Buffer.from(JSON.stringify(descriptor));
  return { keys, publicKey, binary, descriptor, bytes, signature: sign(null, bytes, keys.privateKey) };
}
test("signed component binds immutable location, executable, complete input fingerprint and trust anchor", () => {
  const f = fixture(), directory = mkdtempSync(join(tmpdir(), "gridlens-component-test-"));
  try {
    writeFileSync(join(directory, COMPONENT_DESCRIPTOR), f.bytes); writeFileSync(join(directory, COMPONENT_SIGNATURE), f.signature);
    writeFileSync(join(directory, f.descriptor.name), f.binary); writeFileSync(join(directory, f.descriptor.signature), sign(null, f.binary, f.keys.privateKey));
    const expected = { inputFingerprint: f.descriptor.inputFingerprint, platform: f.descriptor.platform };
    assert.deepEqual(loadCoordinatorComponent(directory, f.publicKey, expected).component, f.descriptor);
    assert.throws(() => loadCoordinatorComponent(directory, f.publicKey, { ...expected, inputFingerprint: "c".repeat(64) }), /inputs/);
    assert.throws(() => loadCoordinatorComponent(directory, f.publicKey, { ...expected, platform: "linux-arm64" }), /platform/);
    assert.throws(() => verifyCoordinatorComponent(f.bytes, f.signature, fixture().publicKey));
    assert.throws(() => verifyCoordinatorComponent(Buffer.alloc(16385), f.signature, f.publicKey));
    for (const patch of [{ releaseTag: "../wrong" }, { bytes: 256 * 1024 ** 2 + 1 }, { coordinatorVersion: 3 }, { node: "24.0.0" }, { extra: true }]) {
      const changed = Buffer.from(JSON.stringify({ ...f.descriptor, ...patch }));
      assert.throws(() => verifyCoordinatorComponent(changed, sign(null, changed, f.keys.privateKey), f.publicKey));
    }
    const relocated = Buffer.from(JSON.stringify({ ...f.descriptor, releaseTag: "modern-other-fixture" }));
    assert.throws(() => verifyCoordinatorComponent(relocated, f.signature, f.publicKey));
    writeFileSync(join(directory, f.descriptor.name), Buffer.alloc(f.binary.length, 8));
    assert.throws(() => loadCoordinatorComponent(directory, f.publicKey, expected), /executable/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("launcher pins reused coordinator tag separately from the new runtime release", () => {
  const f = fixture(), template = readFileSync(new URL("../scripts/modern-start.sh", import.meta.url), "utf8");
  const launcher = renderCoordinatorLauncher(template, "modern-v0.1.0-next-fixture", f.descriptor);
  assert.match(launcher, /release_tag='modern-v0\.1\.0-next-fixture'/);
  assert.match(launcher, /coordinator_release_tag='modern-v0\.1\.0-component-fixture'/);
  assert.ok(launcher.includes(`coordinator_sha256='${f.descriptor.sha256}'`));
  assert.ok(launcher.includes('/$coordinator_release_tag/$coordinator_name'));
  assert.ok(launcher.includes('--release "https://github.com/MachoDrone/gridlens-typescript/releases/download/$release_tag/"'));
  assert.throws(() => renderCoordinatorLauncher(template, "$(malicious-fixture)", f.descriptor));
});
test("coordinator input identity is independent of checkout paths and reacts to dependency/toolchain changes", async () => {
  const parent = mkdtempSync(join(tmpdir(), "gridlens-component-inputs-")), f = fixture();
  try {
    const nodeExecutable = join(parent, "pinned-node/bin/node"); mkdirSync(dirname(nodeExecutable), { recursive: true });
    writeFileSync(nodeExecutable, "generated node binary identity"); writeFileSync(join(parent, "pinned-node/LICENSE"), "generated node license");
    function project(name: string): string {
      const root = join(parent, name), contents: Record<string, string> = {
        "src/installer/terminal-entry.ts": 'import { message } from "./message.ts"; console.log(message);',
        "src/installer/message.ts": 'export const message = "generated coordinator";',
        "package.json": '{"type":"module"}', "package-lock.json": '{"lockfileVersion":3}',
        "scripts/build-coordinator.ts": 'import "./release-coordinator.ts"; export const builder = "generated";', "scripts/release-coordinator.ts": 'export const component = "generated";',
        "node_modules/esbuild/package.json": '{"version":"generated"}', "node_modules/postject/package.json": '{"version":"generated"}',
        [`node_modules/@esbuild/${process.platform}-${process.arch}/bin/esbuild`]: "generated esbuild binary identity",
      };
      for (const [path, content] of Object.entries(contents)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); }
      return root;
    }
    const first = project("first-source"), second = project("different-source-location");
    const original = await coordinatorInputs(first, f.publicKey, nodeExecutable), repeated = await coordinatorInputs(second, f.publicKey, nodeExecutable);
    assert.equal(original.fingerprint, repeated.fingerprint); assert.deepEqual(original.javascript, repeated.javascript);
    writeFileSync(join(second, "unrelated-ui.txt"), "unrelated generated change");
    assert.equal((await coordinatorInputs(second, f.publicKey, nodeExecutable)).fingerprint, original.fingerprint);
    writeFileSync(join(second, "src/installer/message.ts"), 'export const message = "changed generated coordinator";');
    assert.notEqual((await coordinatorInputs(second, f.publicKey, nodeExecutable)).fingerprint, original.fingerprint);
    writeFileSync(join(first, "node_modules/postject/package.json"), '{"version":"changed"}');
    assert.notEqual((await coordinatorInputs(first, f.publicKey, nodeExecutable)).fingerprint, original.fingerprint);
    assert.notEqual((await coordinatorInputs(first, fixture().publicKey, nodeExecutable)).fingerprint, original.fingerprint);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
