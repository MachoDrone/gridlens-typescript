import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { channelAssets, channelFamilyForCoordinator } from "../src/updater/channel-paths.ts";
import type { ChannelFamily } from "../src/updater/channel-paths.ts";
import { channelURL, discoverUpdate, UpdateError, verifyChannel } from "../src/updater/release.ts";
import { verifyRelease } from "../src/installer/release.ts";

const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const root = "https://github.com/MachoDrone/gridlens-typescript/releases/download/";
function fixture() {
  const keys = generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const files = new Map<string, { body: Uint8Array | string; status?: number; headers?: Record<string, string> }>(), calls: string[] = [];
  const put = (family: ChannelFamily, sequence: 23 | 24) => {
    const version = `0.1.0-dev.${sequence}`, tag = `modern-v${version}`;
    const release = { format: "gridlens-modern-release-v1", version, sequence, platform: "linux-x64", minimumCoordinator: sequence === 23 ? 2 : 3,
      imageId: `sha256:${hash(`generated-${sequence}`)}`, runtime: { name: `gridlens-runtime-linux-x64-${version}.tar`, bytes: 3, sha256: hash("abc") } };
    const manifest = Buffer.from(JSON.stringify(release)), channel = Buffer.from(JSON.stringify({ format: "gridlens-modern-channel-v1", channel: "development", platform: "linux-x64",
      version, sequence, buildId: `${sequence}:${version}`, releaseTag: tag, manifestSha256: hash(manifest), workerProtocol: 1 }));
    const names = channelAssets("linux-x64", family);
    files.set(root + "modern-development/" + names.manifest, { body: channel }); files.set(root + "modern-development/" + names.signature, { body: sign(null, channel, keys.privateKey) });
    files.set(root + tag + "/modern-release.json", { body: manifest }); files.set(root + tag + "/modern-release.sig", { body: sign(null, manifest, keys.privateKey) });
    return { release, manifest, channel, signature: sign(null, channel, keys.privateKey) };
  };
  const fetcher: typeof fetch = async input => {
    const url = String(input); calls.push(url); assert.ok(url.startsWith(root));
    const item = files.get(url); if (!item) return new Response("Generated absent family", { status: 404 });
    return new Response(typeof item.body === "string" ? item.body : new Uint8Array(item.body), { status: item.status ?? 200, ...(item.headers ? { headers: item.headers } : {}) });
  };
  return { publicKey, files, calls, put, fetcher, discover: () => discoverUpdate({ platform: "linux-x64", publicKey, fetch: fetcher, now: () => 1000 }) };
}
const v3 = channelAssets("linux-x64", "coordinator3"), legacy = channelAssets("linux-x64", "legacy");
const url = (name: string): string => root + "modern-development/" + name;
test("old coordinator2 keeps primary compatibility23 while coordinator3 discovers protected24", async () => {
  const f = fixture(), compatibility = f.put("legacy", 23); f.put("coordinator3", 24);
  assert.equal(channelFamilyForCoordinator(2), "legacy"); assert.equal(channelFamilyForCoordinator(3), "coordinator3");
  const oldUrl = channelURL("linux-x64", channelFamilyForCoordinator(2));
  assert.equal(oldUrl.href, url(legacy.manifest));
  const old = verifyChannel(compatibility.channel, compatibility.signature, f.publicKey);
  assert.equal(old.sequence, 23);
  const oldManifest = verifyRelease(compatibility.manifest, f.files.get(root + old.releaseTag + "/modern-release.sig")!.body as Uint8Array, f.publicKey);
  assert.ok(oldManifest.minimumCoordinator <= 2, "the unchanged old reader must have a compatible signed path");
  const next = await f.discover(); assert.equal(next.sequence, 24); assert.equal(next.release.minimumCoordinator, 3);
  assert.equal(f.calls.some(path => path === url(legacy.manifest) || path === url(legacy.signature)), false);
});
test("coordinator3 falls back only after both compatible-family files return404", async () => {
  const f = fixture(); f.put("legacy", 23);
  assert.equal((await f.discover()).sequence, 23);
  assert.deepEqual(f.calls.slice(0, 4), [url(v3.manifest), url(v3.signature), url(legacy.manifest), url(legacy.signature)]);
});
test("a partially published v3 pair never falls back to the legacy lane", async () => {
  for (const missing of [v3.manifest, v3.signature]) {
    const f = fixture(); f.put("legacy", 23); f.put("coordinator3", 24); f.files.delete(url(missing));
    await assert.rejects(f.discover(), /pair is incomplete/);
    assert.equal(f.calls.some(path => path === url(legacy.manifest) || path === url(legacy.signature)), false);
  }
});
test("tampered or mismatched valid-response pairs fail closed without legacy fallback", async () => {
  for (const kind of ["signature", "mixed-pair", "manifest", "invalid-json"] as const) {
    const f = fixture(), old = f.put("legacy", 23); f.put("coordinator3", 24);
    if (kind === "signature") f.files.set(url(v3.signature), { body: Buffer.alloc(64) });
    if (kind === "mixed-pair") f.files.set(url(v3.signature), { body: old.signature });
    if (kind === "manifest") f.files.set(root + "modern-v0.1.0-dev.24/modern-release.json", { body: old.manifest });
    if (kind === "invalid-json") f.files.set(url(v3.manifest), { body: "not a signed channel" });
    await assert.rejects(f.discover(), /signature|manifest/);
    assert.equal(f.calls.some(path => path === url(legacy.manifest) || path === url(legacy.signature)), false);
  }
});
test("denial, server errors and service cooldowns never masquerade as a missing v3 family", async () => {
  for (const status of [403, 429, 500, 503]) {
    const f = fixture(); f.put("legacy", 23); f.put("coordinator3", 24);
    f.files.set(url(v3.manifest), { body: "Generated failure", status, headers: { "retry-after": "120" } });
    await assert.rejects(f.discover(), (error: unknown) => error instanceof UpdateError && error.httpStatus === status && error.retryAtMs === 121_000);
    assert.deepEqual(f.calls, [url(v3.manifest)]);
  }
  const f = fixture(); f.put("legacy", 23); f.files.set(url(v3.manifest), { body: "Generated paused404", status: 404, headers: { "retry-after": "120" } });
  await assert.rejects(f.discover(), (error: unknown) => error instanceof UpdateError && error.retryAtMs === 121_000);
  assert.deepEqual(f.calls, [url(v3.manifest)]);
});
