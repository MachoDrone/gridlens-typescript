import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { channelAssets, channelFamilyForCoordinator } from "../src/updater/channel-paths.ts";
import { promoteChannel } from "../scripts/release/channel.ts";
import { releaseContext, ReleaseSuperseded } from "../scripts/release/engine.ts";
import { loadJournal } from "../scripts/release/files.ts";
import { identity } from "../scripts/release/model.ts";
import { channelPublicationFixture } from "./fixtures/channel-publication.ts";

const legacyNames = Object.values(channelAssets("linux-x64", "legacy")), v3Names = Object.values(channelAssets("linux-x64", "coordinator3"));
const primary = (fixture: ReturnType<typeof channelPublicationFixture>) => fixture.remote.assets.filter(asset => legacyNames.includes(asset.name));
test("signed minimum coordinator chooses exactly one compatible two-asset channel family", () => {
  assert.deepEqual(channelAssets("linux-x64", channelFamilyForCoordinator(2)), { manifest: "modern-channel-linux-x64.json", signature: "modern-channel-linux-x64.sig" });
  assert.deepEqual(channelAssets("linux-x64", channelFamilyForCoordinator(3)), { manifest: "modern-channel-v3-linux-x64.json", signature: "modern-channel-v3-linux-x64.sig" });
  assert.equal(channelAssets("linux-arm64", channelFamilyForCoordinator(3)).manifest, "modern-channel-v3-linux-arm64.json");
  assert.throws(() => channelFamilyForCoordinator(4)); assert.throws(() => channelAssets("darwin-arm64" as never, "legacy"));
});
test("first coordinator3 publication proves compatibility release23 and leaves primary bytes and IDs unchanged", async t => {
  const f = channelPublicationFixture(t, { family: "coordinator3", targetSequence: 24, previousSequence: 23, initialSequence: null });
  const before = identity(primary(f));
  const result = await promoteChannel(f.context, f.github) as { family: string; primaryUnchangedVerified: boolean; primarySequence: number };
  assert.equal(result.family, "coordinator3"); assert.equal(result.primaryUnchangedVerified, true); assert.equal(result.primarySequence, 23);
  assert.equal(identity(primary(f)), before); assert.deepEqual(f.deletes, []); assert.deepEqual(f.uploads, v3Names);
  const baseline = loadJournal(f.state).mutations.find(mutation => mutation.key === "channel:baseline")!.identity as { assets: unknown[]; bootstrap: { componentVersion: number; sourceCommit: string } };
  assert.deepEqual(baseline.assets, []); assert.equal(baseline.bootstrap.componentVersion, 3); assert.equal(baseline.bootstrap.sourceCommit, f.config.verification.base);
  assert.ok(f.downloads.some(row => row.tag === f.config.previousTag && row.name === "coordinator-component.json"));
});
test("bootstrap resumes an accepted partial v3 upload without deleting primary or uploading the first asset twice", async t => {
  const f = channelPublicationFixture(t, { family: "coordinator3", targetSequence: 24, previousSequence: 23, initialSequence: null });
  const before = identity(primary(f)); let fail = true;
  f.hooks.afterUpload = () => { if (fail) { fail = false; throw Error("Generated lost upload reply"); } };
  await assert.rejects(promoteChannel(f.context, f.github), /lost upload/);
  assert.equal(f.remote.assets.length, 3); assert.equal(identity(primary(f)), before);
  await promoteChannel(releaseContext(f.state, loadJournal(f.state)), f.github);
  assert.equal(f.remote.assets.length, 4); assert.deepEqual(f.uploads, v3Names); assert.deepEqual(f.deletes, []); assert.equal(identity(primary(f)), before);
});
test("empty v3 bootstrap requires exact previous tag, compatible signed manifest, component3 and reviewed source base", async t => {
  for (const mode of ["wrong-tag", "wrong-minimum", "old-component", "wrong-source", "missing-component"] as const) {
    const f = channelPublicationFixture(t, { family: "coordinator3", targetSequence: 24, previousSequence: mode === "wrong-tag" ? 22 : 23, initialSequence: null,
      ...(mode === "wrong-minimum" ? { primaryMinimum: 3 } : {}), ...(mode === "old-component" ? { componentVersion: 2 } : {}) });
    if (mode === "wrong-source") f.hooks.tagCommit = () => "9".repeat(40);
    if (mode === "missing-component") f.releases.get(f.config.previousTag)!.assets = f.releases.get(f.config.previousTag)!.assets.filter(asset => asset.name !== "coordinator-component.sig");
    await assert.rejects(promoteChannel(f.context, f.github), /./, mode); assert.deepEqual(f.uploads, [], mode); assert.deepEqual(f.deletes, [], mode);
  }
});
test("an unrecorded partial v3 pair cannot be adopted as an empty bootstrap", async t => {
  const f = channelPublicationFixture(t, { family: "coordinator3", targetSequence: 24, previousSequence: 23, initialSequence: 24 });
  f.remote.assets = f.remote.assets.filter(asset => asset.name !== v3Names[1]);
  await assert.rejects(promoteChannel(f.context, f.github), /incomplete/); assert.deepEqual(f.uploads, []); assert.deepEqual(f.deletes, []);
});
test("existing v3 promotions keep primary untouched and reject concurrent higher v3 publication", async t => {
  const f = channelPublicationFixture(t, { family: "coordinator3", targetSequence: 25, previousSequence: 24, initialSequence: 24 });
  const before = identity(primary(f)), oldLane = f.remote.assets.filter(asset => v3Names.includes(asset.name));
  await promoteChannel(f.context, f.github); assert.equal(identity(primary(f)), before);
  assert.deepEqual(f.deletes, oldLane.map(asset => asset.id)); assert.deepEqual(f.uploads, v3Names);
  const race = channelPublicationFixture(t, { family: "coordinator3", targetSequence: 25, previousSequence: 24, initialSequence: 24 });
  race.hooks.afterDelete = () => { delete race.hooks.afterDelete; race.installLane("coordinator3", 26); };
  await assert.rejects(promoteChannel(race.context, race.github), ReleaseSuperseded);
  assert.equal(race.deletes.length, 1); assert.deepEqual(race.uploads, []); assert.equal(primary(race).length, 2);
});
test("a concurrent primary change fences a partial v3 run without restoring or deleting either publisher's assets", async t => {
  const f = channelPublicationFixture(t, { family: "coordinator3", targetSequence: 24, previousSequence: 23, initialSequence: null });
  f.hooks.afterUpload = () => { delete f.hooks.afterUpload; f.installLane("legacy", 23); };
  await assert.rejects(promoteChannel(f.context, f.github), /primary compatibility/);
  assert.equal(f.uploads.length, 1); assert.deepEqual(f.deletes, []);
  await assert.rejects(promoteChannel(releaseContext(f.state, loadJournal(f.state)), f.github), /primary compatibility/);
  assert.equal(f.uploads.length, 1); assert.deepEqual(f.deletes, []);
});
test("exact reviewed predecessors permit a sequence gap left by an unpromoted failed release", async t => {
  const bootstrap = channelPublicationFixture(t, { family: "coordinator3", targetSequence: 25, previousSequence: 23, initialSequence: null });
  await promoteChannel(bootstrap.context, bootstrap.github); assert.deepEqual(bootstrap.uploads, v3Names); assert.deepEqual(bootstrap.deletes, []);
  const existing = channelPublicationFixture(t, { family: "coordinator3", targetSequence: 27, previousSequence: 24, initialSequence: 24 });
  await promoteChannel(existing.context, existing.github); assert.equal(existing.uploads.length, 2); assert.equal(primary(existing).length, 2);
  const mismatch = channelPublicationFixture(t, { family: "coordinator3", targetSequence: 27, previousSequence: 25, initialSequence: 24 });
  await assert.rejects(promoteChannel(mismatch.context, mismatch.github), /exact reviewed preceding/); assert.deepEqual(mismatch.deletes, []);
});
test("local target drift and missing bootstrap witness cannot trigger channel mutation", async t => {
  const f = channelPublicationFixture(t, { family: "coordinator3", targetSequence: 24, previousSequence: 23, initialSequence: null });
  const asset = f.journal.candidate!.assets.find(asset => asset.name === v3Names[0])!;
  writeFileSync(asset.path, Buffer.concat([readFileSync(asset.path), Buffer.from("\n")]));
  await assert.rejects(promoteChannel(f.context, f.github), /changed after verification/); assert.deepEqual(f.uploads, []); assert.deepEqual(f.deletes, []);
  const missing = channelPublicationFixture(t, { family: "coordinator3", targetSequence: 24, previousSequence: 23, initialSequence: null });
  missing.journal.mutations.push({ key: "channel:baseline", kind: "channel-baseline", identity: { family: "coordinator3", releaseId: missing.remote.id, sequence: 23, previousTag: missing.config.previousTag, assets: [] }, status: "observed", intentAt: new Date().toISOString() });
  await assert.rejects(promoteChannel(missing.context, missing.github), /Invalid recorded/); assert.deepEqual(missing.uploads, []);
});
test("same v3 bytes are idempotent and canonical primary corruption prevents a success claim", async t => {
  const same = channelPublicationFixture(t, { family: "coordinator3", targetSequence: 24, previousSequence: 23, initialSequence: 24 });
  const result = await promoteChannel(same.context, same.github) as { unchanged: boolean; primaryUnchangedVerified: boolean };
  assert.equal(result.unchanged, true); assert.equal(result.primaryUnchangedVerified, true); assert.deepEqual(same.uploads, []);
  const corrupt = channelPublicationFixture(t, { family: "coordinator3", targetSequence: 24, previousSequence: 23, initialSequence: null });
  corrupt.hooks.afterUpload = () => { if (corrupt.uploads.length === 2) corrupt.hooks.download = (tag, name, body) => tag === "modern-development" && name === legacyNames[0] ? Buffer.from("invalid canonical primary") : body; };
  await assert.rejects(promoteChannel(corrupt.context, corrupt.github, { attempts: 1, wait: async () => {} }), /readback remains unconfirmed/);
  assert.deepEqual(corrupt.deletes, []); assert.equal(corrupt.uploads.length, 2);
});
test("removing any captured compatibility bridge asset fences the next upload and prevents successful readback", async t => {
  for (const name of ["modern-release.sig", "gridlens-runtime-generated-23.tar", "gridlens-coordinator-linux-x64", "modern-start.sh"] as const) {
    const f = channelPublicationFixture(t, { family: "coordinator3", targetSequence: 24, previousSequence: 23, initialSequence: null });
    const before = identity(primary(f));
    f.hooks.afterUpload = () => { delete f.hooks.afterUpload; const release = f.releases.get(f.config.previousTag)!; release.assets = release.assets.filter(asset => asset.name !== name); };
    await assert.rejects(promoteChannel(f.context, f.github), /bridge assets changed/, name);
    assert.equal(f.uploads.length, 1); assert.deepEqual(f.deletes, []); assert.equal(identity(primary(f)), before);
  }
  const final = channelPublicationFixture(t, { family: "coordinator3", targetSequence: 24, previousSequence: 23, initialSequence: null });
  final.hooks.afterUpload = () => { if (final.uploads.length === 2) final.hooks.download = (tag, name, bytes) => {
    if (tag === "modern-development" && name === v3Names[1]) { const release = final.releases.get(final.config.previousTag)!; release.assets = release.assets.filter(asset => asset.name !== "modern-release.sig"); }
    return bytes;
  }; };
  await assert.rejects(promoteChannel(final.context, final.github, { attempts: 1 }), /readback remains unconfirmed/);
  assert.equal(final.uploads.length, 2); assert.deepEqual(final.deletes, []);
});
