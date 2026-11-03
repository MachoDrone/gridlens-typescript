import assert from "node:assert/strict";
import test from "node:test";
import * as crypto from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { buildModernReleaseArtifacts, modernDockerBuildArgs } from "../scripts/build-modern-release.ts";
import { buildCoordinator } from "../scripts/build-coordinator.ts";
import { canonicalPublicKey, coordinatorInputs, loadPublicKey, publicKeyFingerprint } from "../scripts/release-coordinator.ts";
import { bakedSourceFiles, probeBakedImage } from "../scripts/release-probe.ts";
import type { BakedImageExpectation } from "../scripts/release-probe.ts";
import type { DockerRunner } from "../src/installer/docker.ts";
import { sha256 } from "../scripts/release-runtime.ts";

const generatedKey = () => crypto.generateKeyPairSync("ed25519");
const pem = (key: crypto.KeyObject): string => key.export({ type: "spki", format: "pem" }).toString();
test("public-key inputs reject private or mixed PEM before Docker, bundling or output creation", async () => {
  const root = mkdtempSync(join(tmpdir(), "gridlens-public-key-guard-")), keys = generatedKey(), publicKey = pem(keys.publicKey);
  const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const bad = [privateKey, publicKey + privateKey, privateKey + publicKey, publicKey + publicKey, publicKey + "unexpected text", "x".repeat(8193)];
  const priorPath = process.env.PATH;
  try {
    const bin = join(root, "bin"), marker = join(root, "docker-invoked"); mkdirSync(bin);
    writeFileSync(join(bin, "docker"), `#!/bin/sh\n: > '${marker}'\nexit 99\n`, { mode: 0o700 });
    process.env.PATH = `${bin}:${priorPath ?? ""}`;
    for (const [index, text] of bad.entries()) {
      const path = join(root, `invalid-${index}.pem`); writeFileSync(path, text, { mode: 0o600 });
      const output = join(root, `output-${index}`);
      assert.throws(() => canonicalPublicKey(text), /public Ed25519/);
      assert.throws(() => publicKeyFingerprint(text), /public Ed25519/);
      assert.throws(() => modernDockerBuildArgs({ version: "0.1.0-fixture", sequence: 1 }, text, "fixture"), /public Ed25519/);
      await assert.rejects(coordinatorInputs(join(root, "source-does-not-exist"), text), /public Ed25519/);
      await assert.rejects(buildModernReleaseArtifacts({ output, version: "0.1.0-fixture", sequence: 1, tag: "modern-v0.1.0-fixture", publicKey: path, signingKey: join(root, "never-read-signing-key") }), /public Ed25519|Invalid coordinator component file/);
      await assert.rejects(buildCoordinator({ outputDirectory: output, publicKeyPath: path, signingKeyPath: join(root, "never-read-signing-key"), releaseTag: "modern-v0.1.0-fixture" }), /public Ed25519|Invalid coordinator component file/);
      assert.equal(existsSync(output), false); assert.equal(existsSync(marker), false);
    }
    const publicPath = join(root, "public.pem"); writeFileSync(publicPath, `\n${publicKey.replaceAll("\n", "\r\n")}\n`);
    assert.equal(loadPublicKey(publicPath), publicKey);
    assert.equal(canonicalPublicKey(publicKey.replaceAll("\n", "\r\n")), publicKey);
    assert.equal(publicKeyFingerprint(publicKey), sha256(keys.publicKey.export({ type: "spki", format: "der" })));
    symlinkSync(publicPath, join(root, "link.pem")); assert.throws(() => loadPublicKey(join(root, "link.pem")));
    const wrong = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }); assert.throws(() => canonicalPublicKey(pem(wrong.publicKey)), /Ed25519/);
    assert.ok(!readdirSync(root).some(name => name.startsWith("output-")));
  } finally { if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath; rmSync(root, { recursive: true, force: true }); }
});
function fixture() {
  const publicKey = pem(generatedKey().publicKey), data = new Map<string, Buffer>();
  const inputs = ["src/generated.ts", "scripts/generated.ts", "package.json", "package-lock.json", "LICENSE", "docker/DOCKER-CLI-LICENSE", "docker/DOCKER-CLI-NOTICE", "Dockerfile.shared", "tsconfig.json"].map(name => {
    const bytes = Buffer.from(`generated source ${name}`); return { name, bytes: bytes.length, sha256: sha256(bytes) };
  });
  for (const file of bakedSourceFiles(inputs)) {
    const name = file.path.startsWith("/app/") ? file.path.slice(5) : `docker/${file.path.split("/").at(-1)}`;
    data.set(file.path, Buffer.from(`generated source ${name}`));
  }
  data.set("/app/build.json", Buffer.from(JSON.stringify({ version: "0.1.0-fixture", sequence: 22, buildId: "22:0.1.0-fixture" })));
  data.set("/app/update-public-key.pem", Buffer.from(publicKey));
  const expected: BakedImageExpectation = { imageId: `sha256:${"a".repeat(64)}`, version: "0.1.0-fixture", sequence: 22, platform: "linux-x64", publicKey, treasuryProtocol: 1, inputs,
    labels: { "io.gridlens.product": "shared-backend", "io.gridlens.version": "0.1.0-fixture", "io.gridlens.updater-protocol": "1", "io.gridlens.browser-security-protocol": "1", "io.gridlens.treasury-protocol": "1", "io.gridlens.financial-security-protocol": "1", "io.gridlens.guardian-protocol": "1" } };
  const calls: { args: readonly string[]; input: string }[] = [];
  let unreadable = "", node = "24.14.1";
  const runner: DockerRunner = { run(args, input) {
    const text = String(input); calls.push({ args, input: text }); let stdout = "", stderr = "";
    const process = { getuid: () => 1000, versions: { node }, platform: "linux", arch: "x64", exitCode: 0,
      stdout: { write: (value: string) => { stdout += value; } }, stderr: { write: (value: string) => { stderr += value; } } };
    const fs = { lstatSync: (path: string) => { const bytes = data.get(path); if (!bytes) throw Error("missing"); return { isFile: () => true, isSymbolicLink: () => false, size: bytes.length }; },
      readFileSync: (path: string | number) => { if (path === 0) return Buffer.from(text); if (path === unreadable) throw Error("unreadable"); const bytes = data.get(String(path)); if (!bytes) throw Error("missing"); return bytes; } };
    runInNewContext(args.at(-1)!, { require: (name: string) => name === "node:fs" ? fs : crypto, process, Buffer }, { timeout: 1000 });
    return { status: process.exitCode, stdout, stderr };
  } };
  return { expected, data, calls, runner, unreadable: (path: string) => { unreadable = path; }, node: (value: string) => { node = value; } };
}
test("fixed restricted image probe validates readable baked source, build, Node, public anchor and capabilities", () => {
  const f = fixture(), proof = probeBakedImage(f.runner, f.expected), call = f.calls[0]!;
  assert.equal(proof.imageId, f.expected.imageId); assert.equal(proof.bakedFiles.length, 7);
  assert.equal(proof.capabilities.treasuryProtocol, 1); assert.equal(proof.publicKeySha256, publicKeyFingerprint(f.expected.publicKey));
  for (const [option, value] of [["--network", "none"], ["--user", "1000:1000"], ["--cap-drop", "ALL"], ["--entrypoint", "/usr/local/bin/node"]]) assert.equal(call.args[call.args.indexOf(option!) + 1], value);
  assert.ok(call.args.includes("--read-only") && call.args.includes("--rm") && call.args.includes(f.expected.imageId));
  assert.ok(!call.args.some(value => ["--mount", "--volume", "-v", "--privileged"].includes(value)));
  assert.ok(!call.input.includes("BEGIN") && !call.input.includes("PRIVATE"));
  const original = f.data.get("/app/src/generated.ts")!; f.data.set("/app/src/generated.ts", Buffer.from("wrong source"));
  assert.throws(() => probeBakedImage(f.runner, f.expected), /Baked image verification failed/); f.data.set("/app/src/generated.ts", original);
  f.unreadable("/app/scripts/generated.ts"); assert.throws(() => probeBakedImage(f.runner, f.expected), /Baked image verification failed/); f.unreadable("");
  const build = f.data.get("/app/build.json")!;
  f.data.set("/app/build.json", Buffer.from(JSON.stringify({ version: "0.1.0-fixture", sequence: 21, buildId: "21:0.1.0-fixture" })));
  assert.throws(() => probeBakedImage(f.runner, f.expected), /Baked image verification failed/); f.data.set("/app/build.json", build);
  f.node("24.0.0"); assert.throws(() => probeBakedImage(f.runner, f.expected), /Baked image verification failed/); f.node("24.14.1");
  f.data.set("/app/update-public-key.pem", Buffer.from(pem(generatedKey().publicKey))); assert.throws(() => probeBakedImage(f.runner, f.expected), /Baked image verification failed/);
  const before = f.calls.length; assert.throws(() => probeBakedImage(f.runner, { ...f.expected, labels: { ...f.expected.labels, "io.gridlens.updater-protocol": "0" } }), /metadata/);
  assert.equal(f.calls.length, before, "invalid inspected capabilities cannot start a probe");
});
