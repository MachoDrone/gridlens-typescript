import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compressRuntimeArchive } from "../scripts/release-runtime.ts";
import { fetchGuardianRelease, fetchGuardianReleaseMetadata, verifyGuardianArchive } from "../src/installer/guardian-release.ts";
import type { GuardianRelease } from "../src/installer/guardian-release.ts";
import { inspectSourceGuardian, provisionSourceGuardian } from "../src/installer/source-guardian.ts";
import { GUARDIAN_CONTAINER, GUARDIAN_VOLUME, parseGuardianEnrollment, parseGuardianStatus } from "../src/backend/source-guardian.ts";
import type { GuardianEnrollment, GuardianStatus } from "../src/backend/source-guardian.ts";
import type { SshRun } from "../src/backend/ssh.ts";
import { GUARDIAN_MAX_ENROLLMENT_BYTES, GUARDIAN_MAX_REPLY_BYTES } from "../src/backend/guardian-limits.ts";

const digest = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
function tar(entries: [string, Buffer][]): Buffer {
  const parts: Buffer[] = [];
  for (const [name, bytes] of entries) {
    const head = Buffer.alloc(512); head.write(name); head.write("0000644\0", 100); head.write("0000000\0", 108); head.write("0000000\0", 116);
    head.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124); head.write("00000000000\0", 136); head.fill(32, 148, 156); head[156] = 48;
    head.write(head.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(head, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}
function fixture(t: { after(callback: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), "gridlens-guardian-provision-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const keys = generateKeyPairSync("ed25519"), trustPublicKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
  const version = "0.1.0-dev.24", sequence = 24, platform = "linux-x64" as const, imageTag = `gridlens-modern-build:${version}-${sequence}`;
  const imageLabels = { "io.gridlens.product": "shared-backend", "io.gridlens.version": version, "io.gridlens.guardian-protocol": "1", "io.gridlens.financial-security-protocol": "1", "io.gridlens.treasury-protocol": "2" };
  const json = (value: unknown): Buffer => Buffer.from(JSON.stringify(value)), layer = Buffer.from("Generated inert guardian image layer");
  const config = json({ architecture: "amd64", os: "linux", config: { Labels: imageLabels }, rootfs: { type: "layers", diff_ids: [`sha256:${digest(layer)}`] } });
  const manifest = json({ schemaVersion: 2, config: { digest: `sha256:${digest(config)}`, size: config.length, mediaType: "application/vnd.oci.image.config.v1+json" },
    layers: [{ digest: `sha256:${digest(layer)}`, size: layer.length, mediaType: "application/vnd.oci.image.layer.v1.tar" }] });
  const blob = (value: Buffer): string => `blobs/sha256/${digest(value)}`;
  const archive = compressRuntimeArchive(tar([["oci-layout", json({ imageLayoutVersion: "1.0.0" })], ["index.json", json({ schemaVersion: 2, manifests: [{ digest: `sha256:${digest(manifest)}`, size: manifest.length, mediaType: "application/vnd.oci.image.manifest.v1+json" }] })],
    ["manifest.json", json([{ Config: blob(config), RepoTags: [imageTag], Layers: [blob(layer)] }])], [blob(manifest), manifest], [blob(config), config], [blob(layer), layer]]),
    { imageId: `sha256:${digest(config)}`, version, platform, imageTag });
  const release = { format: "gridlens-modern-release-v1" as const, version, sequence, platform, minimumCoordinator: 3, imageId: archive.imageId, configImageId: archive.configImageId,
    runtime: { name: `gridlens-runtime-${platform}-${version}.tar`, bytes: archive.bytes.length, sha256: digest(archive.bytes) } };
  const releaseBytes = json(release), signature = sign(null, releaseBytes, keys.privateKey), archivePath = join(directory, "generated.tar"); writeFileSync(archivePath, archive.bytes);
  const verified: GuardianRelease = { release, archivePath, manifest: releaseBytes, signature, trustPublicKey };
  const owner = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" });
  const enrollment = parseGuardianEnrollment({ version: 1, authorityId: digest(owner), publicKeyDer: owner.toString("base64"), pcId: "a".repeat(64), policyEpoch: 1,
    destinationAddress: "1".repeat(31) + "9", transferConsumed: true, claimedSources: [], sources: [{ address: "1".repeat(31) + "2", name: "Generated PC",
      binding: { pcId: "a".repeat(64), runtime: "docker", wrapperId: null, nodeContainerId: "b".repeat(64) }, sshFingerprint: "SHA256:" + "C".repeat(43), verifiedAtMs: 1000, privateIp: null, gpuUuids: [] }] });
  return { directory, verified, archive: archive.bytes, imageLabels, enrollment };
}
function status(enrollment: GuardianEnrollment): GuardianStatus {
  return parseGuardianStatus({ version: 1, ready: true, authorityId: enrollment.authorityId, publicKeyDer: enrollment.publicKeyDer, pcId: enrollment.pcId,
    policyEpoch: 1, destinationAddress: enrollment.destinationAddress, transferConsumed: enrollment.transferConsumed, claimedSources: enrollment.claimedSources,
    sources: enrollment.sources.map(source => ({ address: source.address, containerId: source.binding.nodeContainerId, claimSpent: enrollment.claimedSources.includes(source.address) })) });
}
function remote(f: ReturnType<typeof fixture>) {
  const calls: { args: string[]; input?: string | Uint8Array }[] = [];
  let image = false, volume: Record<string, unknown> | undefined, container: Record<string, unknown> | undefined, stored: GuardianStatus | undefined;
  const failures = { lostLoad: false, lostProvision: false, denied: false };
  const owned = () => ({ "io.gridlens.product": "financial-guardian", "io.gridlens.guardian-protocol": "1", "io.gridlens.guardian-owner": f.enrollment.authorityId, "io.gridlens.guardian-pc": f.enrollment.pcId });
  const run: SshRun = async (command, options) => {
    assert.match(command, /^\/usr\/bin\/docker(?: '[^']*')+$/);
    const args = [...command.matchAll(/'([^']*)'/g)].map(value => value[1]!); calls.push({ args, ...(options?.input === undefined ? {} : { input: options.input }) });
    const reply = (value: unknown) => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify(value) });
    if (failures.denied) return { code: 1, stdout: "" };
    if (args[0] === "image" && args[1] === "ls") return reply(image ? f.verified.release.configImageId! : "");
    if (args[0] === "image" && args[1] === "inspect") return reply([{ Id: f.verified.release.configImageId, Os: "linux", Architecture: "amd64", Config: { Labels: f.imageLabels } }]);
    if (args[0] === "load") { assert.ok(options?.input instanceof Uint8Array); assert.deepEqual(options.input, f.archive); image = true; if (failures.lostLoad) throw new Error("Generated lost load response"); return reply("Loaded generated image"); }
    if (args[0] === "volume" && args[1] === "ls") return reply(volume ? GUARDIAN_VOLUME : "");
    if (args[0] === "container" && args[1] === "ls") return reply(container ? GUARDIAN_CONTAINER : "");
    if (args[0] === "volume" && args[1] === "create") { volume = { Name: GUARDIAN_VOLUME, Labels: owned() }; return reply(GUARDIAN_VOLUME); }
    if (args[0] === "volume" && args[1] === "inspect") return reply([volume]);
    if (args[0] === "container" && args[1] === "inspect") return reply([container]);
    if (args[0] === "run" && args.at(-1) === "provision") {
      assert.equal(stored, undefined); assert.equal(typeof options?.input, "string"); assert.deepEqual(JSON.parse(String(options!.input)), f.enrollment);
      assert.ok(!args.some(value => value.includes("docker.sock"))); stored = status(f.enrollment);
      if (failures.lostProvision) throw new Error("Generated lost initialization response"); return reply(stored);
    }
    if (args[0] === "run" && args.at(-1) === "serve") {
      assert.ok(stored); container = { Id: "generated-container", Name: "/" + GUARDIAN_CONTAINER, Image: f.verified.release.configImageId,
        Config: { Labels: owned(), User: "0:0", Cmd: ["node", "/app/scripts/source-guardian.ts", "serve"], StopTimeout: 90, StopSignal: "SIGTERM" },
        HostConfig: { ReadonlyRootfs: true, Privileged: false, NetworkMode: "none", PidMode: "", IpcMode: "private", CapDrop: ["ALL"], CapAdd: [], SecurityOpt: ["no-new-privileges:true"], PortBindings: {}, PidsLimit: 128,
          Tmpfs: { "/tmp": "rw,noexec,nosuid,size=16m" }, RestartPolicy: { Name: "unless-stopped" } },
        Mounts: [{ Type: "volume", Name: GUARDIAN_VOLUME, Destination: "/guardian", RW: true }, { Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock", RW: true }], State: { Running: true } };
      return reply(GUARDIAN_CONTAINER);
    }
    if ((args[0] === "run" || args[0] === "exec") && args.at(-1) === "status") {
      assert.equal(options?.maximum, GUARDIAN_MAX_REPLY_BYTES);
      return stored ? reply(stored) : { code: 1, stdout: "" };
    }
    if (args[0] === "start") { container!.State = { Running: true }; return reply(GUARDIAN_CONTAINER); }
    throw new Error("Unexpected generated Docker command: " + args.join(" "));
  };
  return { run, calls, failures, existingVolume(owner = f.enrollment.authorityId) { volume = { Name: GUARDIAN_VOLUME, Labels: { ...owned(), "io.gridlens.guardian-owner": owner } }; },
    changeState(value: GuardianStatus) { stored = value; }, mutateContainer(change: (value: Record<string, unknown>) => void) { assert.ok(container); change(container); } };
}
test("guardian delivery verifies fixed signed release, caches exact binary and never sends an authorization header", async t => {
  const f = fixture(t), urls: string[] = [];
  const fetcher: typeof fetch = async (input, settings) => {
    const url = String(input); urls.push(url); assert.equal(new Headers(settings?.headers).has("authorization"), false);
    assert.ok(url.startsWith("https://github.com/MachoDrone/gridlens-typescript/releases/download/modern-v0.1.0-dev.24/"));
    const bytes = url.endsWith("modern-release.json") ? f.verified.manifest : url.endsWith("modern-release.sig") ? f.verified.signature : f.archive;
    return new Response(new Uint8Array(bytes), { status: 200, headers: { "content-length": String(bytes.length) } });
  };
  const options = { cacheDirectory: join(f.directory, "cache"), trustPublicKey: f.verified.trustPublicKey, build: { version: "0.1.0-dev.24", sequence: 24 }, fetcher };
  const first = await fetchGuardianRelease(options); assert.deepEqual(verifyGuardianArchive(first), f.archive); assert.equal(urls.length, 3);
  const again = await fetchGuardianRelease(options); assert.equal(again.archivePath, first.archivePath); assert.equal(urls.length, 3);
  const metadata = await fetchGuardianReleaseMetadata(options); assert.equal(metadata.release.imageId, first.release.imageId); assert.equal(urls.length, 3);
  writeFileSync(first.archivePath, Buffer.alloc(f.archive.length)); assert.throws(() => verifyGuardianArchive(first), /checksum/);
});
test("pre-exec guardian attestation uses only small signed metadata and rejects weakened shutdown grace", async t => {
  const f = fixture(t), host = remote(f); await provisionSourceGuardian(host.run, { release: f.verified, enrollment: f.enrollment }, () => {});
  writeFileSync(f.verified.archivePath, "archive must not be opened during metadata-only inspection");
  const before = host.calls.length;
  assert.deepEqual(await inspectSourceGuardian(host.run, f.enrollment, f.verified), { imageId: f.verified.release.configImageId });
  assert.equal(host.calls.slice(before).length, 3); assert.ok(host.calls.slice(before).every(call => call.args[1] === "inspect"));
  host.mutateContainer(value => { (value.Config as { StopTimeout: number }).StopTimeout = 30; });
  await assert.rejects(inspectSourceGuardian(host.run, f.enrollment, f.verified), /changed isolation/);
  const beforeInvalid = host.calls.length;
  await assert.rejects(inspectSourceGuardian(host.run, f.enrollment, f.verified, { containerName: "gridlens-modern-default-owner", volumeName: GUARDIAN_VOLUME }), /isolated fixture namespace/);
  assert.equal(host.calls.length, beforeInvalid);
});
test("guardian provision is confined to one owner-bound container and volume; rerun never reinitializes", async t => {
  const f = fixture(t), host = remote(f); let guards = 0;
  const initial = await provisionSourceGuardian(host.run, { release: f.verified, enrollment: f.enrollment }, () => { guards++; });
  assert.equal(initial.transferConsumed, true); assert.ok(guards >= 4);
  assert.equal(host.calls.filter(call => call.args[0] === "load").length, 1);
  assert.equal(host.calls.filter(call => call.args.at(-1) === "provision").length, 1);
  const runtime = host.calls.find(call => call.args.at(-1) === "serve")!.args;
  for (const [flag, value] of [["--network", "none"], ["--stop-timeout", "90"], ["--user", "0:0"], ["--name", GUARDIAN_CONTAINER]]) assert.equal(runtime[runtime.indexOf(flag!) + 1], value);
  assert.equal(runtime.includes("--publish"), false); assert.equal(runtime.includes("--privileged"), false);
  await provisionSourceGuardian(host.run, { release: f.verified, enrollment: f.enrollment }, () => {});
  assert.equal(host.calls.filter(call => call.args.at(-1) === "provision").length, 1);
  assert.equal(host.calls.filter(call => call.args.at(-1) === "serve").length, 1);
  assert.equal(host.calls.some(call => ["rm", "stop"].includes(call.args[0]!)), false);
});
test("foreign owner and missing existing journal block before load or fresh initialization", async t => {
  const f = fixture(t), foreign = remote(f); foreign.existingVolume("f".repeat(64));
  await assert.rejects(provisionSourceGuardian(foreign.run, { release: f.verified, enrollment: f.enrollment }, () => {}), /another owner/);
  assert.equal(foreign.calls.some(call => ["load", "run"].includes(call.args[0]!)), false);
  const missing = remote(f); missing.existingVolume();
  await assert.rejects(provisionSourceGuardian(missing.run, { release: f.verified, enrollment: f.enrollment }, () => {}), /missing or corrupt/);
  assert.equal(missing.calls.some(call => call.args.at(-1) === "provision"), false);
});
test("lost image/provision acknowledgments are adopted by inspection without replaying either write", async t => {
  const f = fixture(t), host = remote(f); host.failures.lostLoad = true; host.failures.lostProvision = true;
  const result = await provisionSourceGuardian(host.run, { release: f.verified, enrollment: f.enrollment }, () => {});
  assert.equal(result.authorityId, f.enrollment.authorityId);
  assert.equal(host.calls.filter(call => call.args[0] === "load").length, 1); assert.equal(host.calls.filter(call => call.args.at(-1) === "provision").length, 1);
});
test("changed state/isolation, failed inspection, revoked authority and corrupt delivery never open a fresh guardian", async t => {
  const f = fixture(t), denied = remote(f); denied.failures.denied = true;
  await assert.rejects(provisionSourceGuardian(denied.run, { release: f.verified, enrollment: f.enrollment }, () => {}), /no absence/);
  assert.equal(denied.calls.some(call => call.args[0] === "load"), false);
  const revoked = remote(f); let count = 0;
  await assert.rejects(provisionSourceGuardian(revoked.run, { release: f.verified, enrollment: f.enrollment }, () => { if (++count === 2) throw new Error("generated revoked owner"); }), /revoked owner/);
  assert.equal(revoked.calls.some(call => call.args[0] === "load"), false);
  const changed = remote(f); await provisionSourceGuardian(changed.run, { release: f.verified, enrollment: f.enrollment }, () => {});
  changed.mutateContainer(value => { (value.HostConfig as { NetworkMode: string }).NetworkMode = "host"; });
  await assert.rejects(provisionSourceGuardian(changed.run, { release: f.verified, enrollment: f.enrollment }, () => {}), /changed isolation/);
  assert.equal(changed.calls.filter(call => call.args.at(-1) === "serve").length, 1);
  const corrupt = remote(f); writeFileSync(f.verified.archivePath, Buffer.alloc(readFileSync(f.verified.archivePath).length));
  await assert.rejects(provisionSourceGuardian(corrupt.run, { release: f.verified, enrollment: f.enrollment }, () => {}), /checksum/); assert.equal(corrupt.calls.length, 0);
});
test("oversized enrollment is rejected before archive access, authorization or any SSH call", async t => {
  const f = fixture(t), host = remote(f); let authorized = false;
  const oversized = { ...f.enrollment, destinationAddress: "x".repeat(GUARDIAN_MAX_ENROLLMENT_BYTES) };
  await assert.rejects(provisionSourceGuardian(host.run, { release: { ...f.verified, archivePath: "/generated-must-never-be-read" }, enrollment: oversized }, () => { authorized = true; }), /Guardian|guardian|bound|large|invalid/);
  assert.equal(authorized, false); assert.equal(host.calls.length, 0);
});
