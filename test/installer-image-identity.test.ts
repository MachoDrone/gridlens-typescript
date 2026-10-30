import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { archiveImageIdentity } from "../scripts/release-image-identity.ts";
import { findReleaseImage, requireReleaseImage, runtimeRelease } from "../src/installer/image-identity.ts";
import { parseRelease, verifyRelease } from "../src/installer/release.ts";
import type { ModernRelease } from "../src/installer/release.ts";
import type { DockerRunner, CommandResult } from "../src/installer/docker.ts";
import { DockerCommandError } from "../src/installer/docker.ts";

const hash = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const json = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));
const blobPath = (id: string): string => `blobs/sha256/${id.slice(7)}`;
const version = "0.1.0-identity-fixture", tag = "gridlens-modern-build:identity-fixture";
function archive(entries: [string, Buffer][]): Buffer {
  const parts: Buffer[] = [];
  for (const [name, body] of entries) {
    const header = Buffer.alloc(512); header.write(name, 0); header.write("0000644\0", 100);
    header.write("0000000\0", 108); header.write("0000000\0", 116);
    header.write(body.length.toString(8).padStart(11, "0") + "\0", 124); header.write("00000000000\0", 136);
    header.fill(32, 148, 156); header[156] = 48; header.write("ustar\0", 257); header.write("00", 263);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}
function fixture() {
  const layer = Buffer.from("synthetic image layer");
  const config = json({ architecture: "amd64", os: "linux", config: { Labels: { "io.gridlens.product": "shared-backend", "io.gridlens.version": version } },
    rootfs: { type: "layers", diff_ids: [hash(layer)] } });
  const configId = hash(config), layerId = hash(layer);
  const manifest = json({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: configId, size: config.length },
    layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar", digest: layerId, size: layer.length }] });
  const imageId = hash(manifest);
  const entries: [string, Buffer][] = [["oci-layout", json({ imageLayoutVersion: "1.0.0" })],
    ["index.json", json({ schemaVersion: 2, manifests: [{ digest: imageId, size: manifest.length, mediaType: "application/vnd.oci.image.manifest.v1+json" }] })],
    ["manifest.json", json([{ Config: blobPath(configId), RepoTags: [tag], Layers: [blobPath(layerId)] }])],
    [blobPath(imageId), manifest], [blobPath(configId), config], [blobPath(layerId), layer]];
  const expected = { imageId, version, platform: "linux-x64" as const, imageTag: tag };
  const bytes = archive(entries);
  const release: ModernRelease = { format: "gridlens-modern-release-v1", version, sequence: 12, platform: "linux-x64", minimumCoordinator: 1,
    imageId, configImageId: configId, runtime: { name: "gridlens-runtime-identity.tar", bytes: bytes.length, sha256: hash(bytes).slice(7) } };
  return { entries, expected, bytes, release, imageId, configId, layerId };
}
function image(release: ModernRelease, id: string) {
  return { Id: id, Os: "linux", Architecture: "amd64", Config: { Labels: { "io.gridlens.product": "shared-backend", "io.gridlens.version": release.version } } };
}
const missing: CommandResult = { status: 1, stdout: "", stderr: "Error response from daemon: No such image: fixture" };

test("builder derives and binds both identities from OCI config, manifest and Docker compatibility metadata", () => {
  const f = fixture();
  assert.deepEqual(archiveImageIdentity(f.bytes, f.expected), { imageId: f.imageId, configImageId: f.configId });
  assert.notEqual(f.imageId, f.configId);
  for (const name of [blobPath(f.configId), blobPath(f.imageId), blobPath(f.layerId)]) {
    const tampered = f.entries.map(([key, value]) => [key, key === name ? Buffer.from(value).fill(120, 0, 1) : value] as [string, Buffer]);
    assert.throws(() => archiveImageIdentity(archive(tampered), f.expected));
  }
  const wrongMapping = f.entries.map(([name, body]) => [name, name === "manifest.json" ? json([{ Config: blobPath(f.imageId), RepoTags: [tag], Layers: [blobPath(f.layerId)] }]) : body] as [string, Buffer]);
  assert.throws(() => archiveImageIdentity(archive(wrongMapping), f.expected));
  assert.throws(() => archiveImageIdentity(f.bytes, { ...f.expected, platform: "linux-arm64" }));
  assert.throws(() => archiveImageIdentity(f.bytes, { ...f.expected, version: "0.0.0-wrong" }));
  assert.throws(() => archiveImageIdentity(f.bytes, { ...f.expected, imageTag: "unrelated:tag" }));
});

test("archive identity rejects missing OCI proof, duplicate metadata and truncated or ambiguous tar structure", () => {
  const f = fixture();
  assert.throws(() => archiveImageIdentity(archive(f.entries.filter(([name]) => name !== "index.json")), f.expected));
  assert.throws(() => archiveImageIdentity(archive([...f.entries, f.entries[0]!]), f.expected));
  assert.throws(() => archiveImageIdentity(f.bytes.subarray(0, f.bytes.length - 600), f.expected));
  const malformed = Buffer.from(f.bytes); malformed[148] = 49;
  assert.throws(() => archiveImageIdentity(malformed, f.expected));
  assert.throws(() => archiveImageIdentity(archive([["../index.json", json({})], ...f.entries]), f.expected));
});

test("classic and containerd stores resolve only their exact signed image ID without mutable tag fallback", () => {
  const f = fixture();
  for (const selected of [f.imageId, f.configId]) {
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const runner: DockerRunner = { run(args) {
      mutableCalls.push([...args]);
      return args[2] === selected ? { status: 0, stdout: JSON.stringify([image(f.release, selected)]), stderr: "" } : missing;
    } };
    assert.equal(requireReleaseImage(runner, f.release), selected);
    assert.deepEqual(calls, selected === f.imageId ? [["image", "inspect", f.imageId]] : [["image", "inspect", f.imageId], ["image", "inspect", f.configId]]);
    const local = runtimeRelease(f.release, selected);
    assert.equal(local.imageId, selected); assert.equal(f.release.imageId, f.imageId, "signed release stays immutable");
  }
  assert.throws(() => runtimeRelease(f.release, `sha256:${"f".repeat(64)}`));
});

test("image resolution fails closed on metadata drift and daemon errors rather than trying another identity", () => {
  const f = fixture(); let calls = 0;
  for (const replacement of [{ ...image(f.release, f.imageId), Id: f.configId }, { ...image(f.release, f.imageId), Os: "windows" },
    { ...image(f.release, f.imageId), Architecture: "arm64" }, { ...image(f.release, f.imageId), Config: { Labels: { "io.gridlens.product": "foreign" } } }]) {
    calls = 0;
    const runner: DockerRunner = { run() { calls++; return { status: 0, stdout: JSON.stringify([replacement]), stderr: "" }; } };
    assert.throws(() => findReleaseImage(runner, f.release)); assert.equal(calls, 1);
  }
  calls = 0;
  const denied: DockerRunner = { run() { calls++; return { status: 1, stdout: "", stderr: "permission denied while connecting to Docker" }; } };
  assert.throws(() => findReleaseImage(denied, f.release), DockerCommandError); assert.equal(calls, 1);
  const absent: DockerRunner = { run() { return missing; } };
  assert.equal(findReleaseImage(absent, f.release), undefined);
  assert.throws(() => requireReleaseImage(absent, f.release), /missing from Docker after loading/);
});

test("optional config identity remains inside the signed manifest and old manifests retain strict single-ID behavior", () => {
  const f = fixture(), keys = generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
  const bytes = json(f.release), signature = sign(null, bytes, keys.privateKey);
  assert.deepEqual(verifyRelease(bytes, signature, publicKey), f.release);
  assert.throws(() => verifyRelease(json({ ...f.release, configImageId: `sha256:${"e".repeat(64)}` }), signature, publicKey));
  for (const configImageId of [null, "latest", "sha256:short", 1]) assert.throws(() => parseRelease({ ...f.release, configImageId }));
  const { configImageId: _configImageId, ...legacy } = f.release;
  assert.deepEqual(parseRelease(legacy), legacy);
  const calls: string[][] = [], runner: DockerRunner = { run(args) { calls.push([...args]); return missing; } };
  assert.equal(findReleaseImage(runner, legacy), undefined); assert.deepEqual(calls, [["image", "inspect", f.imageId]]);
});
