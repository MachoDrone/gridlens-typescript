import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { archiveImageIdentity } from "../scripts/release-image-identity.ts";
import { compressRuntimeArchive, verifyRuntimeArchive } from "../scripts/release-runtime.ts";
import { releaseSourceInputs, sourceInputFingerprint, writeReleaseContext } from "../scripts/release-context.ts";
import { modernDockerBuildArgs, validateReleaseBuildAssets } from "../scripts/build-modern-release.ts";

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));
function tar(entries: [string, Buffer][]): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, bytes] of entries) {
    const header = Buffer.alloc(512); header.write(name); header.write("0000644\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
    header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124); header.write("00000000000\0", 136);
    header.fill(32, 148, 156); header[156] = 48; header.write("ustar\0", 257); header.write("00", 263);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}
function fixture(options: { layers?: Buffer[]; storedLayers?: Buffer[]; mediaTypes?: string[]; diffIds?: string[] } = {}) {
  const layers = options.layers ?? [Buffer.alloc(32768, 7)], stored = options.storedLayers ?? layers;
  const version = "0.1.0-generated", imageTag = "gridlens-modern-build:generated";
  const config = json({ architecture: "amd64", os: "linux", config: { Labels: { "io.gridlens.product": "shared-backend", "io.gridlens.version": version } },
    rootfs: { type: "layers", diff_ids: options.diffIds ?? layers.map(layer => `sha256:${digest(layer)}`) } });
  const configId = digest(config), path = (id: string) => `blobs/sha256/${id}`;
  const manifest = json({ schemaVersion: 2, config: { digest: `sha256:${configId}`, size: config.length, mediaType: "application/vnd.oci.image.config.v1+json" },
    layers: stored.map((layer, index) => ({ digest: `sha256:${digest(layer)}`, size: layer.length, mediaType: options.mediaTypes?.[index] ?? "application/vnd.oci.image.layer.v1.tar" })) });
  const rootId = digest(manifest);
  const entries: [string, Buffer][] = [["oci-layout", json({ imageLayoutVersion: "1.0.0" })],
    ["index.json", json({ schemaVersion: 2, manifests: [{ digest: `sha256:${rootId}`, size: manifest.length, mediaType: "application/vnd.oci.image.manifest.v1+json" }] })],
    ["manifest.json", json([{ Config: path(configId), RepoTags: [imageTag], Layers: stored.map(layer => path(digest(layer))) }])],
    [path(rootId), manifest], [path(configId), config], ...stored.map(layer => [path(digest(layer)), layer] as [string, Buffer])];
  return { entries, bytes: tar(entries), configId: `sha256:${configId}`, rootId: `sha256:${rootId}`,
    expected: { imageId: `sha256:${rootId}`, version, imageTag, platform: "linux-x64" as const } };
}
test("producer accepts independently inspected classic or OCI identity only after all blobs verify", () => {
  const f = fixture();
  for (const imageId of [f.rootId, f.configId]) assert.deepEqual(archiveImageIdentity(f.bytes, { ...f.expected, imageId }), { imageId: f.rootId, configImageId: f.configId });
  assert.throws(() => archiveImageIdentity(f.bytes, { ...f.expected, imageId: `sha256:${"9".repeat(64)}` }));
  for (const [name] of f.entries.filter(([name]) => name.startsWith("blobs/"))) {
    const changed = f.entries.map(([key, bytes]) => [key, key === name ? Buffer.alloc(bytes.length, 8) : bytes] as [string, Buffer]);
    assert.throws(() => archiveImageIdentity(tar(changed), { ...f.expected, imageId: f.configId }));
  }
  assert.throws(() => archiveImageIdentity(tar([...f.entries, [`blobs/sha256/${digest(Buffer.from("orphan"))}`, Buffer.from("orphan")]]), f.expected));
});
test("classic config identity binds the ordered expanded layer content, including gzip", () => {
  const original = Buffer.alloc(4096, 7), replacement = Buffer.alloc(4096, 9), base = fixture({ layers: [original] });
  // Every stored blob and the replacement OCI root are internally consistent,
  // but the independently inspected config is unchanged: this must be rejected.
  const replaced = fixture({ layers: [original], storedLayers: [replacement] });
  assert.equal(replaced.configId, base.configId); assert.notEqual(replaced.rootId, base.rootId);
  assert.throws(() => archiveImageIdentity(replaced.bytes, { ...replaced.expected, imageId: base.configId }));
  const ordered = fixture({ layers: [original, replacement] });
  const reordered = fixture({ layers: [original, replacement], storedLayers: [replacement, original] });
  assert.equal(reordered.configId, ordered.configId);
  assert.throws(() => archiveImageIdentity(reordered.bytes, { ...reordered.expected, imageId: ordered.configId }));
  const compressed = gzipSync(original), gzip = fixture({ layers: [original], storedLayers: [compressed], mediaTypes: ["application/vnd.oci.image.layer.v1.tar+gzip"] });
  assert.equal(gzip.configId, base.configId);
  assert.deepEqual(archiveImageIdentity(gzip.bytes, { ...gzip.expected, imageId: base.configId }), { imageId: gzip.rootId, configImageId: base.configId });
  const wrongGzip = fixture({ layers: [original], storedLayers: [gzipSync(replacement)], mediaTypes: ["application/vnd.oci.image.layer.v1.tar+gzip"] });
  assert.throws(() => archiveImageIdentity(wrongGzip.bytes, { ...wrongGzip.expected, imageId: base.configId }));
  const corrupt = Buffer.from(compressed); corrupt[corrupt.length - 7]! ^= 7;
  const corruptGzip = fixture({ layers: [original], storedLayers: [corrupt], mediaTypes: ["application/vnd.oci.image.layer.v1.tar+gzip"] });
  assert.throws(() => archiveImageIdentity(corruptGzip.bytes, { ...corruptGzip.expected, imageId: base.configId }));
  const missing = fixture({ layers: [original], diffIds: [] });
  assert.throws(() => archiveImageIdentity(missing.bytes, missing.expected));
  const unsupported = fixture({ layers: [original], mediaTypes: ["application/vnd.oci.image.layer.v1.tar+unknown"] });
  assert.throws(() => archiveImageIdentity(unsupported.bytes, unsupported.expected));
});
test("expanded gzip layers respect per-layer and cumulative limits before accepting the image", () => {
  const layers = [Buffer.alloc(4096, 7), Buffer.alloc(4096, 8)];
  const f = fixture({ layers, storedLayers: layers.map(layer => gzipSync(layer)), mediaTypes: layers.map(() => "application/vnd.docker.image.rootfs.diff.tar.gzip") });
  assert.equal(archiveImageIdentity(f.bytes, f.expected, 8192).configImageId, f.configId);
  assert.throws(() => archiveImageIdentity(f.bytes, f.expected, 7000), "each layer fits alone but their sum must fail");
  assert.throws(() => archiveImageIdentity(f.bytes, f.expected, 4095), "first layer exceeds its expansion allowance");
});

test("gzip transport preserves v1 image identities and rejects damaged, truncated and oversized expansion", () => {
  const f = fixture(), compressed = compressRuntimeArchive(f.bytes, { ...f.expected, imageId: f.configId });
  assert.ok(compressed.bytes.length < f.bytes.length); assert.equal(compressed.compression, "gzip");
  assert.equal(compressed.expandedSha256, digest(f.bytes)); assert.equal(compressed.expandedBytes, f.bytes.length);
  assert.equal(verifyRuntimeArchive(compressed.bytes, f.expected).imageId, f.rootId);
  assert.equal(verifyRuntimeArchive(f.bytes, f.expected).compression, "none");
  assert.deepEqual(compressRuntimeArchive(f.bytes, f.expected).bytes, compressed.bytes, "gzip output is deterministic");
  const damaged = Buffer.from(compressed.bytes); damaged[damaged.length - 7]! ^= 7;
  assert.throws(() => verifyRuntimeArchive(damaged, f.expected));
  assert.throws(() => verifyRuntimeArchive(compressed.bytes.subarray(0, -8), f.expected));
  assert.throws(() => verifyRuntimeArchive(compressed.bytes, f.expected, 1024), /expanded limit/);
  assert.throws(() => verifyRuntimeArchive(gzipSync(randomBytes(4096)), f.expected, 1024), /transport limit/);
  assert.throws(() => compressRuntimeArchive(f.bytes, f.expected, 1024), /expanded limit/);
});
test("canonical Docker context includes only tracked allowlisted inputs and ignores path, mode and timestamp differences", () => {
  const parent = mkdtempSync(join(tmpdir(), "gridlens-context-test-"));
  try {
    const source = join(parent, "source"); mkdirSync(source);
    const names = ["Dockerfile.shared", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.browser.json", "LICENSE",
      "docker/DOCKER-CLI-LICENSE", "docker/DOCKER-CLI-NOTICE", "src/example.ts", "scripts/example.ts"];
    for (const name of names) { mkdirSync(dirname(join(source, name)), { recursive: true }); writeFileSync(join(source, name), `generated ${name}\n`); }
    execFileSync("git", ["init", "-q"], { cwd: source }); execFileSync("git", ["add", "--", ...names], { cwd: source });
    writeFileSync(join(source, "src/untracked-private-fixture.txt"), "generated exclusion fixture");
    writeFileSync(join(source, "private-fixture.txt"), "generated exclusion fixture");
    execFileSync("git", ["add", "private-fixture.txt"], { cwd: source });
    const inputs = releaseSourceInputs(source), fingerprint = sourceInputFingerprint(inputs);
    assert.deepEqual(inputs.map(x => x.name), names.sort());
    chmodSync(join(source, "src/example.ts"), 0o777);
    assert.equal(sourceInputFingerprint(releaseSourceInputs(source)), fingerprint);
    const target = join(parent, "context"); assert.equal(writeReleaseContext(source, target, inputs), fingerprint);
    assert.equal(statSync(join(target, "src/example.ts")).mode & 0o777, 0o644); assert.equal(statSync(join(target, "src/example.ts")).mtimeMs, 0);
    assert.deepEqual(readFileSync(join(target, "src/example.ts")), readFileSync(join(source, "src/example.ts")));
    assert.equal(sourceInputFingerprint(releaseSourceInputs(target, names)), fingerprint);
    assert.throws(() => writeReleaseContext(source, join(source, "nested"), inputs), /outside/);
    writeFileSync(join(source, "src/example.ts"), "changed"); assert.throws(() => writeReleaseContext(source, join(parent, "drift"), inputs), /changed/);
    rmSync(join(source, "scripts/example.ts")); symlinkSync(join(source, "private-fixture.txt"), join(source, "scripts/example.ts"));
    assert.throws(() => releaseSourceInputs(source), /input/);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
test("cached Docker build is default, cold build is explicit, and publication inventory rejects ambiguity", () => {
  const options = { version: "0.1.0-fixture", sequence: 1, enableWallet: true };
  const publicKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.ok(!modernDockerBuildArgs(options, publicKey, "fixture").includes("--no-cache"));
  assert.ok(modernDockerBuildArgs({ ...options, cold: true }, publicKey, "fixture").includes("--no-cache"));
  const directory = "/tmp/generated-release-inventory", entries = Array.from({ length: 11 }, (_, i) => ({ name: `fixture-${i}`, path: `${directory}/fixture-${i}`, bytes: 1, sha256: "a".repeat(64) }));
  validateReleaseBuildAssets(entries, directory);
  assert.throws(() => validateReleaseBuildAssets([...entries.slice(1), entries[1]!], directory));
  assert.throws(() => validateReleaseBuildAssets([{ ...entries[0]!, name: "../escape" }, ...entries.slice(1)], directory));
  assert.throws(() => validateReleaseBuildAssets([{ ...entries[0]!, bytes: 1024 ** 3 + 1 }, ...entries.slice(1)], directory));
});
