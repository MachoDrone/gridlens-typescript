import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { verifyChannel } from "../../src/updater/release.ts";
import type { UpdateChannel } from "../../src/updater/release.ts";
import { verifyRelease } from "../../src/installer/release.ts";
import { channelAssets, channelFamilyForCoordinator } from "../../src/updater/channel-paths.ts";
import type { ChannelFamily } from "../../src/updater/channel-paths.ts";
import { COMPONENT_DESCRIPTOR, COMPONENT_SIGNATURE, verifyCoordinatorComponent } from "../release-coordinator.ts";
import { ordinaryFile } from "./files.ts";
import { assetMatches, parseRemoteAsset } from "./github.ts";
import type { GitHub, RemoteAsset, RemoteRelease } from "./github.ts";
import { ReleaseSuperseded } from "./engine.ts";
import type { ReleaseContext } from "./engine.ts";
import { digest, identity } from "./model.ts";

interface Pair { channel: UpdateChannel; assets: RemoteAsset[]; bytes: Buffer; signature: Buffer }
interface PairWitness { assets: RemoteAsset[]; sequence: number; releaseTag: string; manifestSha256: string; channelSha256: string; signatureSha256: string }
interface BridgeWitness {
  releaseId: number; sourceCommit: string; manifestAssets: RemoteAsset[]; componentAssets: RemoteAsset[];
  componentReleaseId: number; componentReleaseTag: string; componentVersion: number; componentSha256: string; binaryAssets: RemoteAsset[];
  releaseAssets: RemoteAsset[]; linkedAssets: RemoteAsset[];
}
interface ChannelBaseline {
  releaseId: number; sequence: number; previousTag: string; assets: RemoteAsset[]; family: ChannelFamily;
  primary?: PairWitness; bootstrap?: BridgeWitness;
}
const selected = (release: RemoteRelease, names: readonly string[]): RemoteAsset[] => {
  const assets = release.assets.filter(asset => names.includes(asset.name));
  if (new Set(assets.map(asset => asset.name)).size !== assets.length) throw new Error("Duplicate channel assets detected.");
  return assets.sort((a, b) => a.name.localeCompare(b.name));
};
const witness = (pair: Pair): PairWitness => ({ assets: pair.assets, sequence: pair.channel.sequence, releaseTag: pair.channel.releaseTag,
  manifestSha256: pair.channel.manifestSha256, channelSha256: digest(pair.bytes), signatureSha256: digest(pair.signature) });
export function channelTransition(previousSequence: number, targetSequence: number, identical: boolean): "advance" | "unchanged" {
  if (previousSequence > targetSequence) throw new ReleaseSuperseded("A newer signed development channel is already published.");
  if (previousSequence === targetSequence) {
    if (!identical) throw new Error("Different signed bytes occupy this release sequence.");
    return "unchanged";
  }
  // The caller verifies the exact configured preceding tag and source base.
  // A failed, unpromoted immutable release may legitimately leave a sequence gap.
  return "advance";
}
export async function promoteChannel(context: ReleaseContext, github: GitHub, options: { attempts?: number; wait?: (milliseconds: number) => Promise<void> } = {}): Promise<unknown> {
  const { journal, directory } = context, { plan, candidate } = journal;
  if (!candidate) throw new Error("Missing verified release candidate.");
  const publicKey = ordinaryFile(plan.config.publicKeyPath, 8192).toString("utf8");
  const artifact = (name: string, maximum: number): Buffer => {
    const rows = candidate.assets.filter(asset => asset.name === name);
    if (rows.length !== 1) throw new Error("Missing or duplicated signed channel inventory.");
    const bytes = ordinaryFile(rows[0]!.path, maximum);
    if (bytes.length !== rows[0]!.bytes || digest(bytes) !== rows[0]!.sha256) throw new Error("Channel artifact changed after verification.");
    return bytes;
  };
  const manifestBytes = artifact("modern-release.json", 16384), manifest = verifyRelease(manifestBytes, artifact("modern-release.sig", 64), publicKey);
  if (digest(manifestBytes) !== candidate.manifestSha256 || manifest.version !== plan.config.version || manifest.sequence !== plan.config.sequence
    || manifest.platform !== plan.config.platform) throw new Error("Channel release does not bind this candidate.");
  const platform = manifest.platform, family = channelFamilyForCoordinator(manifest.minimumCoordinator), familyNames = channelAssets(platform, family);
  const names = [familyNames.manifest, familyNames.signature], primaryNames = Object.values(channelAssets(platform, "legacy"));
  const target = names.map(name => candidate.assets.find(asset => asset.name === name)!);
  const expectedBytes = artifact(names[0]!, 16384), signature = artifact(names[1]!, 64), expected = verifyChannel(expectedBytes, signature, publicKey);
  if (expected.manifestSha256 !== candidate.manifestSha256 || expected.sequence !== plan.config.sequence || expected.version !== plan.config.version
    || expected.platform !== platform || expected.releaseTag !== `modern-v${manifest.version}`) throw new Error("Channel does not bind this candidate.");
  const work = join(directory, "channel"); mkdirSync(work, { recursive: true, mode: 0o700 });
  async function current(): Promise<RemoteRelease> {
    const release = await github.release("modern-development");
    if (!release || release.draft) throw new Error("The existing public development channel release is unavailable.");
    return release;
  }
  async function downloadPair(tag: string, release: RemoteRelease, pairNames: readonly string[]): Promise<{ assets: RemoteAsset[]; bytes: Buffer; signature: Buffer }> {
    const assets = selected(release, pairNames);
    if (assets.length !== 2) throw new Error("The channel or signed metadata pair is incomplete; only a matching recorded run may recover it.");
    const paths = pairNames.map(name => join(work, `${randomUUID()}-${name}`));
    for (const [index, name] of pairNames.entries()) {
      const asset = assets.find(row => row.name === name)!;
      await github.download(tag, name, paths[index]!, { bytes: asset.size, sha256: asset.digest.slice(7) });
    }
    const bytes = ordinaryFile(paths[0]!, 16384), sig = ordinaryFile(paths[1]!, 64), after = await github.release(tag);
    if (!after || after.id !== release.id || after.draft || identity(selected(after, pairNames)) !== identity(assets)) throw new Error("Signed metadata changed during canonical readback.");
    return { assets, bytes, signature: sig };
  }
  async function canonicalPair(release: RemoteRelease, pairNames = names): Promise<Pair> {
    const pair = await downloadPair("modern-development", release, pairNames), channel = verifyChannel(pair.bytes, pair.signature, publicKey);
    if (channel.platform !== platform) throw new Error("Channel platform changed.");
    return { ...pair, channel };
  }
  const identical = (pair: Pair) => pair.bytes.equals(expectedBytes) && pair.signature.equals(signature);
  async function signedRelease(pair: Pair) {
    const release = await github.release(pair.channel.releaseTag);
    if (!release || release.draft) throw new Error("Signed channel's immutable release is unavailable.");
    const metadata = await downloadPair(pair.channel.releaseTag, release, ["modern-release.json", "modern-release.sig"]);
    const value = verifyRelease(metadata.bytes, metadata.signature, publicKey);
    if (digest(metadata.bytes) !== pair.channel.manifestSha256 || value.sequence !== pair.channel.sequence || value.version !== pair.channel.version
      || value.platform !== platform) throw new Error("Signed channel and immutable release differ.");
    return { release, metadata, value };
  }
  async function previous(pair: Pair) {
    if (pair.channel.releaseTag !== plan.config.previousTag || pair.channel.sequence >= expected.sequence)
      throw new Error("Signed prior channel does not identify the exact reviewed preceding release.");
    const prior = await signedRelease(pair), sourceCommit = await github.tagCommit(pair.channel.releaseTag);
    if (sourceCommit !== plan.config.verification.base) throw new Error("Signed prior release source differs from the reviewed verification base.");
    if (sourceCommit !== plan.config.sourceCommit) {
      const ancestry = spawnSync("git", ["-C", plan.config.sourceDirectory, "merge-base", "--is-ancestor", sourceCommit, plan.config.sourceCommit], { stdio: "ignore" });
      if (ancestry.error || ancestry.status !== 0) throw new Error("Prior release source is not a verified ancestor of this candidate.");
    }
    return { ...prior, sourceCommit };
  }
  async function primaryPair(release: RemoteRelease): Promise<Pair> {
    const pair = await canonicalPair(release, primaryNames), prior = await signedRelease(pair);
    if (channelFamilyForCoordinator(prior.value.minimumCoordinator) !== "legacy") throw new Error("The primary channel no longer supplies a coordinator-compatible release.");
    return pair;
  }
  async function bridge(primary: Pair): Promise<BridgeWitness> {
    const prior = await previous(primary);
    if (channelFamilyForCoordinator(prior.value.minimumCoordinator) !== "legacy") throw new Error("The bootstrap release is not compatible with previous coordinators.");
    const prerequisites = selected(prior.release, [prior.value.runtime.name, "modern-start.sh", "coordinator-manifest.json"]);
    const runtime = prerequisites.find(asset => asset.name === prior.value.runtime.name);
    if (prerequisites.length !== 3 || !runtime || !assetMatches(runtime, prior.value.runtime)) throw new Error("Compatibility runtime or bootstrap assets are missing or mismatched.");
    const descriptor = await downloadPair(primary.channel.releaseTag, prior.release, [COMPONENT_DESCRIPTOR, COMPONENT_SIGNATURE]);
    const component = verifyCoordinatorComponent(descriptor.bytes, descriptor.signature, publicKey);
    if (component.coordinatorVersion < 3 || component.platform !== platform) throw new Error("Compatibility release does not supply coordinator 3 support.");
    const componentRelease = component.releaseTag === primary.channel.releaseTag ? prior.release : await github.release(component.releaseTag);
    if (!componentRelease || componentRelease.draft) throw new Error("Compatibility coordinator component is not publicly available.");
    const binaryAssets = selected(componentRelease, [component.name, component.signature]);
    const binary = binaryAssets.find(asset => asset.name === component.name), binarySignature = binaryAssets.find(asset => asset.name === component.signature);
    if (binaryAssets.length !== 2 || !binary || !assetMatches(binary, { name: component.name, bytes: component.bytes, sha256: component.sha256 })
      || binarySignature?.size !== 64) throw new Error("Published compatibility coordinator binary differs from its signed descriptor.");
    if (component.releaseTag !== primary.channel.releaseTag) {
      const componentMetadata = selected(componentRelease, [COMPONENT_DESCRIPTOR, COMPONENT_SIGNATURE]);
      if (componentMetadata.length !== 2 || !componentMetadata.some(asset => assetMatches(asset, { name: COMPONENT_DESCRIPTOR, bytes: descriptor.bytes.length, sha256: digest(descriptor.bytes) }))
        || !componentMetadata.some(asset => assetMatches(asset, { name: COMPONENT_SIGNATURE, bytes: descriptor.signature.length, sha256: digest(descriptor.signature) }))) throw new Error("Referenced coordinator metadata differs from the compatibility release.");
    }
    return { releaseId: prior.release.id, sourceCommit: prior.sourceCommit, manifestAssets: prior.metadata.assets, componentAssets: descriptor.assets,
      componentReleaseId: componentRelease.id, componentReleaseTag: component.releaseTag, componentVersion: component.coordinatorVersion,
      componentSha256: digest(descriptor.bytes), binaryAssets, releaseAssets: [...prior.release.assets].sort((a, b) => a.name.localeCompare(b.name)),
      linkedAssets: [...componentRelease.assets].sort((a, b) => a.name.localeCompare(b.name)) };
  }
  const baselineRecord = journal.mutations.find(mutation => mutation.key === "channel:baseline");
  let baseline: ChannelBaseline;
  if (baselineRecord) {
    baseline = baselineRecord.identity as ChannelBaseline;
    if (!Number.isSafeInteger(baseline.releaseId) || !Number.isSafeInteger(baseline.sequence) || baseline.sequence >= expected.sequence
      || baseline.previousTag !== plan.config.previousTag || !Array.isArray(baseline.assets) || baseline.family !== family
      || baseline.assets.some(asset => !names.includes(parseRemoteAsset(asset).name))
      || baseline.assets.length !== 2 && !(family === "coordinator3" && baseline.assets.length === 0 && baseline.bootstrap && baseline.primary)) throw new Error("Invalid recorded channel baseline.");
    if (family === "coordinator3") {
      if (!baseline.primary) throw new Error("Missing preserved primary channel witness.");
      const release = await current(), primary = await primaryPair(release);
      if (release.id !== baseline.releaseId || identity(witness(primary)) !== identity(baseline.primary)) throw new Error("The primary compatibility channel changed; no coordinator lane mutation was attempted.");
      if (baseline.bootstrap && identity(await bridge(primary)) !== identity(baseline.bootstrap)) throw new Error("Recorded compatibility bootstrap witness changed.");
    }
  } else {
    const release = await current(), primary = family === "coordinator3" ? await primaryPair(release) : undefined;
    const assets = selected(release, names);
    if (assets.length === 0 && family === "coordinator3" && primary) {
      const proof = await bridge(primary), latest = await current();
      if (latest.id !== release.id || identity(selected(latest, primaryNames)) !== identity(primary.assets) || selected(latest, names).length)
        throw new Error("Channel lanes changed during bootstrap verification; no mutation was attempted.");
      baseline = { family, releaseId: release.id, sequence: primary.channel.sequence, previousTag: plan.config.previousTag, assets: [], primary: witness(primary), bootstrap: proof };
    } else {
      const pair = await canonicalPair(release);
      if (channelTransition(pair.channel.sequence, expected.sequence, identical(pair)) === "unchanged") {
        if (primary && identity(witness(await canonicalPair(await current(), primaryNames))) !== identity(witness(primary))) throw new Error("Primary channel changed during idempotent readback.");
        return { passed: true, family, sequence: expected.sequence, manifestSha256: candidate.manifestSha256, unchanged: true, ...(primary ? { primaryUnchangedVerified: true } : {}) };
      }
      const prior = await previous(pair);
      if (channelFamilyForCoordinator(prior.value.minimumCoordinator) !== family) throw new Error("Existing channel lane has an incompatible predecessor.");
      baseline = { family, releaseId: release.id, sequence: pair.channel.sequence, previousTag: plan.config.previousTag, assets: pair.assets, ...(primary ? { primary: witness(primary) } : {}) };
    }
    journal.mutations.push({ key: "channel:baseline", kind: "channel-baseline", identity: baseline, status: "observed", intentAt: new Date().toISOString(), observedAt: new Date().toISOString() });
    context.save();
  }
  async function assertBridgeUnchanged(): Promise<void> {
    const proof = baseline.bootstrap; if (!proof) return;
    const release = await github.release(baseline.previousTag);
    const linked = proof.componentReleaseTag === baseline.previousTag ? release : await github.release(proof.componentReleaseTag);
    if (!release || release.draft || release.id !== proof.releaseId || !linked || linked.draft || linked.id !== proof.componentReleaseId
      || identity([...release.assets].sort((a, b) => a.name.localeCompare(b.name))) !== identity(proof.releaseAssets)
      || identity([...linked.assets].sort((a, b) => a.name.localeCompare(b.name))) !== identity(proof.linkedAssets)
      || await github.tagCommit(baseline.previousTag) !== proof.sourceCommit) throw new Error("Compatibility bridge assets changed; no further channel mutation is allowed.");
  }
  async function inspectForMutation(): Promise<RemoteRelease> {
    await assertBridgeUnchanged();
    const release = await current();
    if (release.id !== baseline.releaseId) throw new Error("The channel release ID changed; no replacement was attempted.");
    if (baseline.primary && identity(selected(release, primaryNames)) !== identity(baseline.primary.assets)) throw new Error("A concurrent publisher changed the primary compatibility channel; it was not overwritten.");
    const assets = selected(release, names);
    for (const asset of assets) {
      const old = baseline.assets.find(item => item.id === asset.id), proposed = target.find(item => assetMatches(asset, item));
      if (!old && !proposed || old && identity(old) !== identity(asset)) {
        if (assets.length === 2) { const pair = await canonicalPair(release); channelTransition(pair.channel.sequence, expected.sequence, identical(pair)); }
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
      context.assertActive(); await github.removeAsset(old.id);
    });
  }
  for (const asset of target) {
    await context.mutate(`channel:upload:${asset.name}`, "upload-channel-asset", { releaseId: baseline.releaseId, name: asset.name, bytes: asset.bytes, sha256: asset.sha256 }, async () => {
      const release = await inspectForMutation(), found = release.assets.find(item => item.name === asset.name);
      if (!found) return undefined;
      if (!assetMatches(found, asset)) throw new Error("Concurrent channel asset name conflict."); return found;
    }, async () => {
      const release = await inspectForMutation();
      if (release.assets.some(item => item.name === asset.name)) throw new Error("Channel name appeared before upload; resume will reconcile it.");
      context.assertActive(); await github.upload(baseline.releaseId, asset, context.assertActive);
    });
  }
  const wait = options.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  let lastFailure = "Canonical channel propagation has not been verified.";
  for (let attempt = 0; attempt < (options.attempts ?? 30); attempt++) {
    const release = await inspectForMutation();
    if (target.some(asset => !release.assets.some(remote => assetMatches(remote, asset)))) throw new Error("Uploaded channel pair is incomplete.");
    try {
      const pair = await canonicalPair(release); channelTransition(pair.channel.sequence, expected.sequence, identical(pair));
      if (identical(pair)) {
        if (baseline.primary && identity(witness(await canonicalPair(await current(), primaryNames))) !== identity(baseline.primary)) throw new Error("Primary compatibility channel changed during canonical readback.");
        await assertBridgeUnchanged();
        return { passed: true, family, sequence: expected.sequence, manifestSha256: candidate.manifestSha256, channelSha256: digest(expectedBytes), canonicalBytesVerified: true,
          apiAssetDigestsVerified: true, ...(baseline.primary ? { primaryUnchangedVerified: true, primarySequence: baseline.primary.sequence } : {}) };
      }
    } catch (error) {
      if (error instanceof ReleaseSuperseded) throw error;
      lastFailure = error instanceof Error ? error.message : lastFailure;
    }
    if (attempt + 1 < (options.attempts ?? 30)) await wait(10_000);
  }
  throw new Error(`Channel assets were uploaded, but public readback remains unconfirmed: ${lastFailure}`);
}
