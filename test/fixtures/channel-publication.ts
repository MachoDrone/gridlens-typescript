import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channelAssets } from "../../src/updater/channel-paths.ts";
import type { ChannelFamily } from "../../src/updater/channel-paths.ts";
import { createJournal } from "../../scripts/release/files.ts";
import { releaseContext } from "../../scripts/release/engine.ts";
import { digest, identity, PUBLIC_KEY_SHA256, REPOSITORY } from "../../scripts/release/model.ts";
import type { Asset, ReleaseConfig, ReleasePlan } from "../../scripts/release/model.ts";
import type { GitHub, RemoteAsset, RemoteRelease } from "../../scripts/release/github.ts";

export function channelPublicationFixture(t: { after(callback: () => void): void }, options: {
  family?: ChannelFamily; targetSequence?: number; previousSequence?: number; initialSequence?: number | null;
  primarySequence?: number; componentVersion?: number; primaryMinimum?: number;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "gridlens-channel-test-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "source"), state = join(directory, "run"); mkdirSync(source); mkdirSync(state, { mode: 0o700 });
  const git = (...args: string[]) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("config", "user.name", "Generated channel fixture"); git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(source, "fixture.txt"), "generated base\n"); git("add", "."); git("commit", "-qm", "generated previous source"); const base = git("rev-parse", "HEAD");
  writeFileSync(join(source, "fixture.txt"), "generated candidate\n"); git("add", "."); git("commit", "-qm", "generated target source"); const head = git("rev-parse", "HEAD");
  const family = options.family ?? "legacy", targetSequence = options.targetSequence ?? 22, previousSequence = options.previousSequence ?? targetSequence - 1;
  const primarySequence = options.primarySequence ?? 23, initialSequence = options.initialSequence === undefined ? previousSequence : options.initialSequence;
  const keys = generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const config: ReleaseConfig = { sourceDirectory: source, sourceCommit: head, version: `0.1.0-dev.${targetSequence}`, sequence: targetSequence,
    platform: "linux-x64", repository: REPOSITORY, publicKeyPath: join(directory, "public.pem"), signingKeyPath: join(directory, "never-read.pem"), notesPath: join(directory, "notes.txt"),
    previousTag: `modern-v0.1.0-dev.${previousSequence}`, enableWallet: true, treasuryProtocol: family === "legacy" ? 1 : 2,
    verification: { base, full: true }, build: { cold: true }, fixture: { sshTarget: "fixture@192.168.55.5", address: "192.168.55.5", webPorts: [23001, 23003], requireColdDownload: false } };
  writeFileSync(config.publicKeyPath, publicKey);
  const definition = { format: "gridlens-release-plan-v1" as const, config, sourceTree: "c".repeat(40), sourceFingerprint: "d".repeat(64), notesSha256: "e".repeat(64),
    publicKeySha256: PUBLIC_KEY_SHA256, toolchain: { node: "24.14.1", npm: "11.11.0" }, docker: { endpointFingerprint: "f".repeat(64), daemonId: "generated-daemon" } };
  const plan: ReleasePlan = { ...definition, planHash: identity(definition) }, journal = createJournal(state, plan), context = releaseContext(state, journal);
  let nextId = 1, immutableId = 10_000;
  const bytes = new Map<number, Buffer>(), releases = new Map<string, RemoteRelease>(), manifests = new Map<number, Buffer>();
  const remote: RemoteRelease = { id: 777, tag_name: "modern-development", target_commitish: head, draft: false, prerelease: true, assets: [] };
  function add(release: RemoteRelease, name: string, body: Buffer): RemoteAsset {
    const id = release === remote ? nextId++ : immutableId++; bytes.set(id, body);
    const value: RemoteAsset = { id, name, size: body.length, digest: `sha256:${digest(body)}`, state: "uploaded" }; release.assets.push(value); return value;
  }
  function immutable(sequence: number): RemoteRelease {
    const tag = `modern-v0.1.0-dev.${sequence}`, prior = releases.get(tag); if (prior) return prior;
    const release: RemoteRelease = { id: 1000 + sequence, tag_name: tag, target_commitish: sequence === previousSequence ? base : head, draft: false, prerelease: true, assets: [] };
    releases.set(tag, release);
    const minimumCoordinator = family === "legacy" ? 2 : sequence <= primarySequence ? options.primaryMinimum ?? 2 : 3;
    const runtime = Buffer.from("generated inert runtime");
    const manifest = Buffer.from(JSON.stringify({ format: "gridlens-modern-release-v1", version: `0.1.0-dev.${sequence}`, sequence, platform: "linux-x64", minimumCoordinator,
      imageId: `sha256:${"a".repeat(64)}`, runtime: { name: `gridlens-runtime-generated-${sequence}.tar`, bytes: runtime.length, sha256: digest(runtime) } }));
    manifests.set(sequence, manifest); add(release, "modern-release.json", manifest); add(release, "modern-release.sig", sign(null, manifest, keys.privateKey));
    add(release, `gridlens-runtime-generated-${sequence}.tar`, runtime);
    add(release, "modern-start.sh", Buffer.from("generated reviewed launcher\n")); add(release, "coordinator-manifest.json", Buffer.from("{}"));
    if (sequence === primarySequence) {
      const binary = Buffer.from("generated coordinator fixture bytes"), name = "gridlens-coordinator-linux-x64";
      const component = Buffer.from(JSON.stringify({ format: "gridlens-coordinator-component-v1", coordinatorVersion: options.componentVersion ?? 3, node: "24.14.1", platform: "linux-x64",
        releaseTag: tag, name, bytes: binary.length, sha256: digest(binary), signature: `${name}.sig`, inputFingerprint: "c".repeat(64),
        publicKeySha256: digest(keys.publicKey.export({ type: "spki", format: "der" })) }));
      add(release, "coordinator-component.json", component); add(release, "coordinator-component.sig", sign(null, component, keys.privateKey));
      add(release, name, binary); add(release, `${name}.sig`, sign(null, binary, keys.privateKey));
    }
    return release;
  }
  function pair(sequence: number, manifestSha256?: string): Buffer[] {
    immutable(sequence);
    const body = Buffer.from(JSON.stringify({ format: "gridlens-modern-channel-v1", channel: "development", platform: "linux-x64", version: `0.1.0-dev.${sequence}`, sequence,
      buildId: `${sequence}:0.1.0-dev.${sequence}`, releaseTag: `modern-v0.1.0-dev.${sequence}`, manifestSha256: manifestSha256 ?? digest(manifests.get(sequence)!), workerProtocol: 1 }));
    return [body, sign(null, body, keys.privateKey)];
  }
  function installLane(selectedFamily: ChannelFamily, sequence: number, manifestSha256?: string) {
    const names = Object.values(channelAssets("linux-x64", selectedFamily)); remote.assets = remote.assets.filter(asset => !names.includes(asset.name));
    pair(sequence, manifestSha256).forEach((body, index) => add(remote, names[index]!, body));
  }
  if (family === "coordinator3") installLane("legacy", primarySequence);
  if (initialSequence !== null) installLane(family, initialSequence);
  const names = Object.values(channelAssets("linux-x64", family)), target = pair(targetSequence), assets: Asset[] = [];
  for (const [index, body] of target.entries()) { const name = names[index]!, path = join(state, name); writeFileSync(path, body); assets.push({ name, path, bytes: body.length, sha256: digest(body) }); }
  for (const name of ["modern-release.json", "modern-release.sig"]) {
    const remoteAsset = immutable(targetSequence).assets.find(asset => asset.name === name)!, body = bytes.get(remoteAsset.id)!, path = join(state, name);
    writeFileSync(path, body); assets.push({ name, path, bytes: body.length, sha256: digest(body) });
  }
  journal.candidate = { assets, candidateHash: "1".repeat(64), manifestSha256: digest(manifests.get(targetSequence)!), bundleDirectory: state, buildResultPath: join(state, "unused.json") }; context.save();
  const deletes: number[] = [], uploads: string[] = [], downloads: { tag: string; name: string }[] = [];
  const hooks: { afterDelete?: () => void; afterUpload?: () => void; download?: (tag: string, name: string, body: Buffer) => Buffer; tagCommit?: (tag: string) => string | undefined } = {};
  const github: GitHub = {
    release: async tag => structuredClone(tag === "modern-development" ? remote : releases.get(tag)),
    tagCommit: async tag => hooks.tagCommit ? hooks.tagCommit(tag) : tag === config.previousTag ? base : head,
    create: async () => { throw Error("Unexpected release create"); }, publish: async () => { throw Error("Unexpected release publish"); },
    async removeAsset(id) { assert.ok(remote.assets.some(asset => asset.id === id)); deletes.push(id); remote.assets = remote.assets.filter(asset => asset.id !== id); hooks.afterDelete?.(); },
    async upload(_id, asset) {
      assert.equal(remote.assets.some(row => row.name === asset.name), false); uploads.push(asset.name);
      const row = add(remote, asset.name, readFileSync(asset.path)); hooks.afterUpload?.(); return row;
    },
    async download(tag, name, destination, expected) {
      downloads.push({ tag, name }); const release = tag === "modern-development" ? remote : releases.get(tag), asset = release?.assets.find(row => row.name === name); assert.ok(asset);
      const original = bytes.get(asset.id)!, body = hooks.download?.(tag, name, original) ?? original;
      if (expected) assert.deepEqual({ bytes: body.length, sha256: digest(body) }, expected);
      writeFileSync(destination, body, { flag: "wx" }); return { name, path: destination, bytes: body.length, sha256: digest(body) };
    },
  };
  return { directory, source, state, config, plan, journal, context, github, remote, releases, hooks, deletes, uploads, downloads, installLane,
    install(sequence: number, manifestSha256?: string) { installLane(family, sequence, manifestSha256); } };
}
