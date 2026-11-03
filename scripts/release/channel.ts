import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { verifyChannel } from "../../src/updater/release.ts";
import { ordinaryFile } from "./files.ts";
import { assetMatches } from "./github.ts";
import type { GitHub, RemoteAsset, RemoteRelease } from "./github.ts";
import { ReleaseSuperseded } from "./engine.ts";
import type { ReleaseContext } from "./engine.ts";
import { digest, identity } from "./model.ts";

interface ChannelBaseline { releaseId: number; sequence: number; assets: RemoteAsset[] }
const selected = (release: RemoteRelease, names: readonly string[]): RemoteAsset[] => {
  const assets = release.assets.filter(asset => names.includes(asset.name));
  if (new Set(assets.map(asset => asset.name)).size !== assets.length) throw new Error("Duplicate channel assets detected.");
  return assets.sort((a, b) => a.name.localeCompare(b.name));
};
export function channelTransition(previousSequence: number, targetSequence: number, identical: boolean): "advance" | "unchanged" {
  if (previousSequence > targetSequence) throw new ReleaseSuperseded("A newer signed development channel is already published.");
  if (previousSequence === targetSequence) {
    if (!identical) throw new Error("Different signed bytes occupy this release sequence.");
    return "unchanged";
  }
  if (previousSequence !== targetSequence - 1) throw new Error("The development channel is not the reviewed preceding sequence.");
  return "advance";
}
export async function promoteChannel(context: ReleaseContext, github: GitHub, options: { attempts?: number; wait?: (milliseconds: number) => Promise<void> } = {}): Promise<unknown> {
  const { journal, directory } = context, { plan, candidate } = journal;
  if (!candidate) throw new Error("Missing verified release candidate.");
  const platform = plan.config.platform, names = [`modern-channel-${platform}.json`, `modern-channel-${platform}.sig`];
  const target = names.map(name => candidate.assets.find(asset => asset.name === name)!);
  if (target.some(asset => !asset)) throw new Error("Missing signed channel inventory.");
  const publicKey = ordinaryFile(plan.config.publicKeyPath, 8192).toString("utf8");
  const expectedBytes = ordinaryFile(target[0]!.path, 16384), signature = ordinaryFile(target[1]!.path, 64);
  const expected = verifyChannel(expectedBytes, signature, publicKey);
  if (expected.manifestSha256 !== candidate.manifestSha256 || expected.sequence !== plan.config.sequence) throw new Error("Channel does not bind this candidate.");
  const work = join(directory, "channel"); mkdirSync(work, { recursive: true, mode: 0o700 });
  async function current(): Promise<RemoteRelease> {
    const release = await github.release("modern-development");
    if (!release || release.draft) throw new Error("The existing public development channel release is unavailable.");
    return release;
  }
  async function canonicalPair(release: RemoteRelease): Promise<{ sequence: number; releaseTag: string; identical: boolean }> {
    const assets = selected(release, names);
    if (assets.length !== 2) throw new Error("The channel pair is incomplete; only a matching recorded run may recover it.");
    const paths = names.map(name => join(work, `${randomUUID()}-${name}`));
    for (const [index, name] of names.entries()) {
      const asset = assets.find(row => row.name === name)!;
      await github.download("modern-development", name, paths[index]!, { bytes: asset.size, sha256: asset.digest.slice(7) });
    }
    const bytes = ordinaryFile(paths[0]!, 16384), sig = ordinaryFile(paths[1]!, 64), value = verifyChannel(bytes, sig, publicKey);
    if (value.platform !== platform) throw new Error("Channel platform changed.");
    const after = await current();
    if (after.id !== release.id || identity(selected(after, names)) !== identity(assets)) throw new Error("Channel changed during signed readback.");
    return { sequence: value.sequence, releaseTag: value.releaseTag, identical: bytes.equals(expectedBytes) && sig.equals(signature) };
  }
  const baselineRecord = journal.mutations.find(mutation => mutation.key === "channel:baseline");
  let baseline: ChannelBaseline;
  if (baselineRecord) {
    baseline = baselineRecord.identity as ChannelBaseline;
    if (!Number.isSafeInteger(baseline.releaseId) || baseline.sequence !== expected.sequence - 1 || !Array.isArray(baseline.assets) || baseline.assets.length !== 2) throw new Error("Invalid recorded channel baseline.");
  } else {
    const release = await current(), pair = await canonicalPair(release);
    if (channelTransition(pair.sequence, expected.sequence, pair.identical) === "unchanged") return { passed: true, sequence: expected.sequence, manifestSha256: candidate.manifestSha256, unchanged: true };
    if (pair.releaseTag !== plan.config.previousTag) throw new Error("Signed prior channel does not identify the reviewed previous release.");
    baseline = { releaseId: release.id, sequence: pair.sequence, assets: selected(release, names) };
    journal.mutations.push({ key: "channel:baseline", kind: "channel-baseline", identity: baseline, status: "observed", intentAt: new Date().toISOString(), observedAt: new Date().toISOString() });
    context.save();
  }
  async function inspectForMutation(): Promise<RemoteRelease> {
    const release = await current();
    if (release.id !== baseline.releaseId) throw new Error("The channel release ID changed; no replacement was attempted.");
    const assets = selected(release, names);
    for (const asset of assets) {
      const old = baseline.assets.find(item => item.id === asset.id), proposed = target.find(item => assetMatches(asset, item));
      if (!old && !proposed || old && identity(old) !== identity(asset)) {
        if (assets.length === 2) {
          const pair = await canonicalPair(release);
          channelTransition(pair.sequence, expected.sequence, pair.identical);
        }
        throw new Error("A concurrent publisher changed the channel; no asset was overwritten.");
      }
    }
    return release;
  }
  for (const old of baseline.assets) {
    await context.mutate(`channel:delete:${old.id}`, "delete-channel-asset", { releaseId: baseline.releaseId, asset: old }, async () => {
      const release = await inspectForMutation();
      return release.assets.some(asset => asset.id === old.id) ? undefined : { absent: true, assetId: old.id };
    }, async () => {
      const release = await inspectForMutation();
      if (!release.assets.some(asset => identity(asset) === identity(old))) throw new Error("Captured old channel asset changed before deletion.");
      context.assertActive();
      await github.removeAsset(old.id);
    });
  }
  for (const asset of target) {
    await context.mutate(`channel:upload:${asset.name}`, "upload-channel-asset", { releaseId: baseline.releaseId, name: asset.name, bytes: asset.bytes, sha256: asset.sha256 }, async () => {
      const release = await inspectForMutation(), found = release.assets.find(item => item.name === asset.name);
      if (!found) return undefined;
      if (!assetMatches(found, asset)) throw new Error("Concurrent channel asset name conflict.");
      return found;
    }, async () => {
      const release = await inspectForMutation();
      if (release.assets.some(item => item.name === asset.name)) throw new Error("Channel name appeared before upload; resume will reconcile it.");
      context.assertActive();
      await github.upload(baseline.releaseId, asset, context.assertActive);
    });
  }
  const wait = options.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  let lastFailure = "Canonical channel propagation has not been verified.";
  for (let attempt = 0; attempt < (options.attempts ?? 30); attempt++) {
    const release = await inspectForMutation();
    if (target.some(asset => !release.assets.some(remote => assetMatches(remote, asset)))) throw new Error("Uploaded channel pair is incomplete.");
    try {
      const pair = await canonicalPair(release);
      channelTransition(pair.sequence, expected.sequence, pair.identical);
      if (pair.identical) return { passed: true, sequence: expected.sequence, manifestSha256: candidate.manifestSha256, channelSha256: digest(expectedBytes), canonicalBytesVerified: true, apiAssetDigestsVerified: true };
    } catch (error) {
      if (error instanceof ReleaseSuperseded) throw error;
      lastFailure = error instanceof Error ? error.message : lastFailure;
    }
    if (attempt + 1 < (options.attempts ?? 30)) await wait(10_000);
  }
  throw new Error(`Channel assets were uploaded, but public readback remains unconfirmed: ${lastFailure}`);
}
