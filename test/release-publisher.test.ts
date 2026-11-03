import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { releaseArguments } from "../scripts/release.ts";
import { abortRelease, cleanupRelease, releaseContext, ReleaseAborted, ReleaseSuperseded, runRelease } from "../scripts/release/engine.ts";
import type { ReleaseEffects } from "../scripts/release/engine.ts";
import { atomicJson, createJournal, loadJournal, lockRun } from "../scripts/release/files.ts";
import { digest, identity, parseConfig, parsePlan, PUBLIC_KEY_SHA256, REPOSITORY, STAGES } from "../scripts/release/model.ts";
import type { Asset, ReleaseConfig, ReleasePlan } from "../scripts/release/model.ts";
import { channelTransition, promoteChannel } from "../scripts/release/channel.ts";
import { channelPublicationFixture } from "./fixtures/channel-publication.ts";
import { assetMatches, createGitHub, parseRemoteAsset, verifyRemoteInventory, withVerifiedUploadFile } from "../scripts/release/github.ts";
import type { RemoteAsset, RemoteRelease } from "../scripts/release/github.ts";
import { checked } from "../scripts/release/commands.ts";
import { addressAnswer } from "../scripts/release/public-installer.ts";
import { assertOwned } from "../scripts/release/fixture-docker.ts";
import { validateAcceptanceReport } from "../scripts/release/acceptance.ts";
import { claimUnitsDockerOptions } from "../scripts/test-claim-units-docker.ts";
import { claimsShutdownOptions } from "../scripts/test-claims-shutdown-docker.ts";
import { acceptanceOptions } from "../scripts/test-shared-docker.ts";
import { assertDockerDestination, dockerIdentity, publishSource } from "../scripts/release/source.ts";
import type { CommandRunner } from "../scripts/release/commands.ts";

function fixture(t: { after(callback: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), "gridlens-release-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "source"), state = join(directory, "run"); mkdirSync(source); mkdirSync(state, { mode: 0o700 });
  const config: ReleaseConfig = { sourceDirectory: source, sourceCommit: "a".repeat(40), version: "0.1.0-dev.22", sequence: 22, platform: "linux-x64", repository: REPOSITORY,
    publicKeyPath: join(directory, "public.pem"), signingKeyPath: join(directory, "never-read.pem"), notesPath: join(directory, "notes.txt"), previousTag: "modern-v0.1.0-dev.21",
    enableWallet: true, verification: { base: "b".repeat(40), full: true }, build: { cold: true }, fixture: { sshTarget: "fixture@192.168.55.5", address: "192.168.55.5", webPorts: [23001, 23003], requireColdDownload: false } };
  const definition = { format: "gridlens-release-plan-v1" as const, config, sourceTree: "c".repeat(40), sourceFingerprint: "d".repeat(64), notesSha256: "e".repeat(64), publicKeySha256: PUBLIC_KEY_SHA256, toolchain: { node: "24.14.1", npm: "11.11.0" }, docker: { endpointFingerprint: "f".repeat(64), daemonId: "generated-daemon-identity" } };
  const plan: ReleasePlan = { ...definition, planHash: identity(definition) };
  const journal = createJournal(state, plan), context = releaseContext(state, journal);
  return { directory, source, state, config, plan, journal, context };
}
function fakeEffects(order: string[]): ReleaseEffects {
  return { validate: async () => { order.push("validate"); }, cleanup: async () => ({ cleanupVerified: true }),
    stages: Object.fromEntries(STAGES.map(stage => [stage, async (_context: unknown, previous?: unknown) => { order.push(stage); return previous ?? { passed: true, stage }; }])) as ReleaseEffects["stages"] };
}
test("release plan rejects identity drift, unsupported paths and unisolated fixture profiles", t => {
  const { plan, config } = fixture(t);
  assert.deepEqual(parsePlan(plan), plan);
  assert.throws(() => parsePlan({ ...plan, config: { ...config, sequence: 23 } }), /changed/);
  assert.throws(() => parseConfig({ ...config, signingKeyPath: "relative.pem" }), /absolute/);
  assert.throws(() => parseConfig({ ...config, fixture: { ...config.fixture, address: "8.8.8.8" } }), /fixture/);
  assert.throws(() => parseConfig({ ...config, fixture: { ...config.fixture, webPorts: [23001, 23002] } }), /fixture/);
  assert.throws(() => parseConfig({ ...config, repository: "other/repository" }), /configuration/);
});
test("one publish command runs every stage; prepare and its resume never gain publication authority", async t => {
  const { context, journal } = fixture(t), order: string[] = [], effects = fakeEffects(order);
  await runRelease(context, effects, "prepare");
  assert.deepEqual(order, ["validate", "checks", "build", "bundle", "acceptance"]);
  order.length = 0; await runRelease(context, effects, "resume");
  assert.equal(journal.publicationAuthorized, false); assert.equal(order.includes("source"), false);
  order.length = 0; await runRelease(context, effects, "publish");
  assert.deepEqual(order, ["validate", ...STAGES]); assert.equal(journal.status, "complete"); assert.equal(journal.publicationAuthorized, true);
});
test("durable intent precedes a request and a lost accepted reply is adopted without retransmission", async t => {
  const { context, state } = fixture(t);
  let remote: { assetId: number } | undefined, sends = 0;
  const operation = () => context.mutate("asset:x", "upload", { digest: "f".repeat(64) }, async () => remote, async () => {
    assert.equal(loadJournal(state).mutations[0]?.status, "intent"); sends++; remote = { assetId: 42 }; throw new Error("Injected lost reply");
  });
  await assert.rejects(operation(), /lost reply/);
  const resumed = releaseContext(state, loadJournal(state));
  const result = await resumed.mutate("asset:x", "upload", { digest: "f".repeat(64) }, async () => remote, async () => { sends++; });
  assert.deepEqual(result, { assetId: 42 }); assert.equal(sends, 1); assert.equal(loadJournal(state).mutations[0]?.status, "observed");
});
test("an observed remote operation disappearing is not silently recreated", async t => {
  const { context } = fixture(t); let present: number | undefined = 7, calls = 0;
  await context.mutate("x", "publish", { id: 7 }, async () => present, async () => { calls++; });
  present = undefined;
  await assert.rejects(context.mutate("x", "publish", { id: 7 }, async () => present, async () => { calls++; }), /no longer present/);
  assert.equal(calls, 0);
});
test("journal lock excludes a second writer and releases on close", t => {
  const { state } = fixture(t), unlock = lockRun(state);
  assert.throws(() => lockRun(state), /Another release writer/); unlock();
  lockRun(state)();
});
test("cooperative abort fences the next write while retaining an accepted in-flight outcome", async t => {
  const { context, state, journal } = fixture(t); let sends = 0, remote: number | undefined;
  const result = await context.mutate("first", "upload", { id: 1 }, async () => remote, async () => {
    sends++; remote = 1;
    atomicJson(join(state, "abort-request.json"), { runId: journal.runId, planHash: journal.plan.planHash });
  });
  assert.equal(result, 1); assert.equal(loadJournal(state).mutations[0]?.status, "observed");
  await assert.rejects(context.mutate("second", "upload", { id: 2 }, async () => undefined, async () => { sends++; }), ReleaseAborted);
  assert.equal(sends, 1);
});
test("a queued abort records aborted status and runs only owned cleanup before another stage", async t => {
  const { context, state, journal } = fixture(t), order: string[] = [], effects = fakeEffects(order); let cleanups = 0;
  effects.stages.checks = async () => { atomicJson(join(state, "abort-request.json"), { runId: journal.runId, planHash: journal.plan.planHash }); return { passed: true }; };
  effects.cleanup = async () => { cleanups++; return { cleanupVerified: true }; };
  await assert.rejects(runRelease(context, effects, "publish"), ReleaseAborted);
  assert.equal(journal.status, "aborted"); assert.equal(order.includes("build"), false); assert.equal(cleanups, 1);
});
test("failure survives cleanup failure and abort cannot unpublish or implicitly resume", async t => {
  const { context, journal } = fixture(t), effects = fakeEffects([]);
  effects.stages.assets = async () => { throw new Error("original upload outcome unknown"); };
  effects.cleanup = async () => { throw new Error("owned cleanup failed"); };
  await assert.rejects(runRelease(context, effects, "publish"), /original/);
  await assert.rejects(cleanupRelease(context, effects), /cleanup/);
  assert.equal(journal.failure?.message, "original upload outcome unknown"); assert.equal(journal.cleanupFailure, "owned cleanup failed");
  effects.cleanup = async () => ({ cleanupVerified: true }); await abortRelease(context, effects);
  await assert.rejects(runRelease(context, effects, "resume"), /aborted/); assert.equal(journal.publicationAuthorized, true);
});
test("CLI supports one-command publish and rejects ambiguous command options", () => {
  assert.equal(releaseArguments(["publish", "--plan", "/tmp/plan.json", "--run", "/tmp/run"]).command, "publish");
  assert.equal(releaseArguments(["publish", "--run", "/tmp/run", "--acceptance", "/tmp/one", "--acceptance", "/tmp/two"]).acceptances.length, 2);
  assert.throws(() => releaseArguments(["resume", "--plan", "/tmp/plan", "--run", "/tmp/run"]));
  assert.throws(() => releaseArguments(["publish", "--run", "/tmp/run", "--run", "/tmp/other"]));
});

function channelFixture(t: { after(callback: () => void): void }, beforeSequence = 21) {
  return channelPublicationFixture(t, { initialSequence: beforeSequence });
}
test("channel promotion recovers a partial pair after an accepted upload loses its response", async t => {
  const f = channelFixture(t); let fail = true;
  f.hooks.afterUpload = () => { if (fail) { fail = false; throw new Error("lost accepted upload reply"); } };
  await assert.rejects(promoteChannel(f.context, f.github), /lost accepted/);
  assert.equal(f.remote.assets.length, 1);
  const resumed = releaseContext(f.state, loadJournal(f.state));
  await promoteChannel(resumed, f.github);
  assert.deepEqual(f.deletes, [1, 2]); assert.equal(f.uploads.length, 2); assert.equal(f.remote.assets.length, 2);
  await promoteChannel(resumed, f.github); assert.equal(f.uploads.length, 2);
});
test("a concurrent higher channel is never deleted or overwritten", async t => {
  const f = channelFixture(t);
  f.hooks.afterDelete = () => { delete f.hooks.afterDelete; f.install(23); };
  await assert.rejects(promoteChannel(f.context, f.github), ReleaseSuperseded);
  assert.deepEqual(f.deletes, [1]); assert.equal(f.uploads.length, 0); assert.equal(f.remote.assets.length, 2);
});
test("unrecorded incomplete channel blocks mutation instead of guessing recovery", async t => {
  const f = channelFixture(t); f.remote.assets.pop();
  await assert.rejects(promoteChannel(f.context, f.github), /incomplete/); assert.deepEqual(f.deletes, []); assert.deepEqual(f.uploads, []);
});
test("equal sequence requires exact bytes and a higher initial sequence is superseding", async t => {
  const equal = channelFixture(t, 22); equal.install(22, "9".repeat(64));
  await assert.rejects(promoteChannel(equal.context, equal.github), /Different signed/); assert.equal(equal.deletes.length, 0);
  const newer = channelFixture(t, 23); await assert.rejects(promoteChannel(newer.context, newer.github), ReleaseSuperseded); assert.equal(newer.deletes.length, 0);
  assert.equal(channelTransition(21, 22, false), "advance"); assert.equal(channelTransition(20, 22, false), "advance");
});
test("same signed channel is idempotent without delete/upload requests", async t => {
  const f = channelFixture(t, 22); await promoteChannel(f.context, f.github); assert.equal(f.deletes.length, 0); assert.equal(f.uploads.length, 0);
});
test("explicit asset inventory rejects extra files and immutable name conflicts", () => {
  const asset: Asset = { name: "runtime.tar", path: "/unused", bytes: 3, sha256: "a".repeat(64) };
  const remote: RemoteAsset = { id: 1, name: asset.name, size: 3, digest: `sha256:${asset.sha256}`, state: "uploaded" };
  const release: RemoteRelease = { id: 2, tag_name: "modern-v0.1.0-dev.22", target_commitish: "a".repeat(40), draft: true, prerelease: true, assets: [remote] };
  verifyRemoteInventory(release, [asset], true); assert.equal(assetMatches(remote, asset), true);
  assert.throws(() => verifyRemoteInventory({ ...release, assets: [remote, { ...remote, id: 3, name: "private-evidence.json" }] }, [asset], true), /differ/);
  assert.throws(() => verifyRemoteInventory({ ...release, assets: [{ ...remote, digest: `sha256:${"b".repeat(64)}` }] }, [asset], true), /differ/);
});
test("changing GitHub download counters cannot impersonate a concurrent asset replacement", () => {
  const stable = { id: 1, name: "manifest.json", size: 100, digest: `sha256:${"a".repeat(64)}`, state: "uploaded" };
  assert.deepEqual(parseRemoteAsset({ ...stable, download_count: 0, updated_at: "old" }), parseRemoteAsset({ ...stable, download_count: 3, updated_at: "new" }));
  assert.deepEqual(Object.keys(parseRemoteAsset(stable)).sort(), ["digest", "id", "name", "size", "state"]);
});
test("regular-file gh upload sends Content-Length and exact bytes to an isolated HTTP server", async t => {
  if (spawnSync("gh", ["--version"], { encoding: "utf8" }).status !== 0) { t.skip("Existing gh CLI is not available for the HTTP encoding acceptance."); return; }
  const { directory } = fixture(t), body = Buffer.from("generated release fixture\n"), path = join(directory, "fixture.bin"); writeFileSync(path, body);
  let length: string | undefined, observed = Buffer.alloc(0);
  const server = createServer((request, response) => {
    length = request.headers["content-length"]; const parts: Buffer[] = [];
    request.on("data", chunk => parts.push(chunk)); request.on("end", () => { observed = Buffer.concat(parts); response.writeHead(201, { "content-type": "application/json" }); response.end('{"created":true}'); });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  await withVerifiedUploadFile(directory, { name: "fixture.bin", path, bytes: body.length, sha256: digest(body) }, async temporary => {
    await checked("gh", ["api", "--method", "POST", `http://127.0.0.1:${port}/upload`, "--header", "Content-Type: application/octet-stream", "--input", temporary],
      { env: { PATH: process.env.PATH, GH_TOKEN: "generated-unused-test-token", GH_CONFIG_DIR: directory, GH_PROMPT_DISABLED: "1" }, timeoutMs: 10_000 });
  });
  assert.equal(length, String(body.length)); assert.deepEqual(observed, body); assert.equal(readdirSync(directory).some(name => name.startsWith(".upload-")), false);
});
test("failed upload cleans its private temporary file and changed bytes never dispatch", async t => {
  const { directory } = fixture(t), path = join(directory, "asset"); writeFileSync(path, "original");
  const asset = { name: "asset", path, bytes: 8, sha256: digest("original") }; let calls = 0;
  await assert.rejects(withVerifiedUploadFile(directory, asset, async () => { calls++; throw new Error("network loss"); }), /network loss/);
  assert.equal(readdirSync(directory).some(name => name.startsWith(".upload-")), false);
  writeFileSync(path, "modified"); await assert.rejects(withVerifiedUploadFile(directory, asset, async () => { calls++; }), /changed/); assert.equal(calls, 1);
});
test("public PTY chooses only the declared address, not a recommended unrelated interface", () => {
  const text = "1) 192.168.44.1 — recommended\n\n2) 10.2.3.4 · VPN\n\nChoose address number [1, recommended]: ";
  assert.equal(addressAnswer(text, "10.2.3.4"), "2\n"); assert.throws(() => addressAnswer(text, "10.2.3.9"), /unambiguous/);
  assert.equal(addressAnswer("Downloading and verifying GridLens…", "10.2.3.4"), undefined);
});
test("fixture cleanup rejects default and mismatched product ownership", () => {
  const fixture = { instance: "fixture-rel-abcdef123456-new", webPort: 23001, httpsPort: 23002 };
  assert.throws(() => assertOwned({ Name: "/gridlens-modern-default-owner", Config: { Labels: { "io.gridlens.product": "shared-backend", "io.gridlens.instance": "default" } } }, fixture, "container"), /Refusing/);
  assert.throws(() => assertOwned({ Name: "gridlens-modern-fixture-rel-abcdef123456-new-volume", Labels: { "io.gridlens.product": "other", "io.gridlens.instance": fixture.instance } }, fixture, "volume"), /Refusing/);
});
test("acceptance proof requires cold gzip coverage, exact image identity and cleanup", () => {
  const image = `sha256:${"1".repeat(64)}`, old = `sha256:${"2".repeat(64)}`;
  const report = { passed: true, cleanupErrors: [], baseImageId: image, previousSource: { imageId: old }, archiveCompression: "gzip",
    coldTargetImages: [`sha256:${"3".repeat(64)}`, `sha256:${"4".repeat(64)}`], fixtureArchives: [1, 2].map(sequence => ({ sequence, compression: "gzip", bytes: 100, expandedBytes: 300, sha256: "5".repeat(64) })), update: {}, rollback: {} };
  validateAcceptanceReport("docker-updater", report, [image], [old]);
  assert.throws(() => validateAcceptanceReport("docker-updater", { ...report, archiveCompression: "none" }, [image], [old]), /gzip/);
  assert.throws(() => validateAcceptanceReport("docker-updater", { ...report, cleanupErrors: ["leftover"] }, [image], [old]), /cleanup/);
  assert.throws(() => validateAcceptanceReport("docker-updater", report, [old], [old]), /candidate/);
});
test("claim fixture IDs are explicit, bounded and retain random defaults", () => {
  const instance = "fixture-abcdef123456";
  assert.equal(claimUnitsDockerOptions(["--old-image", "fixture:old", "--image", "fixture:new", "--instance", instance]).instance, instance);
  assert.equal(claimsShutdownOptions(["--image", "fixture:new", "--instance", instance]).instance, instance);
  assert.equal(claimsShutdownOptions(["--image", "fixture:new"]).instance, undefined);
  for (const invalid of ["default", "fixture-bad", "fixture-ABCDEF123456", "fixture-abcdef123456;touch"]) {
    assert.throws(() => claimsShutdownOptions(["--image", "fixture:new", "--instance", invalid]));
    assert.throws(() => claimUnitsDockerOptions(["--old-image", "fixture:old", "--image", "fixture:new", "--instance", invalid]));
  }
});
test("atomic journal file remains complete after an evidence replacement", t => {
  const { state, journal } = fixture(t); journal.events.push({ at: new Date().toISOString(), kind: "test", detail: "generated" });
  atomicJson(join(state, "journal.json"), journal); assert.equal(loadJournal(state).events.at(-1)?.detail, "generated");
  assert.equal(readdirSync(state).some(name => name.endsWith(".tmp")), false);
});
test("shared Docker acceptance accepts an explicit private address and preserves loopback default", () => {
  assert.equal(acceptanceOptions([]).address, undefined);
  assert.equal(acceptanceOptions(["--address", "192.168.55.5"]).address, "192.168.55.5");
  assert.equal(acceptanceOptions(["--address", "127.0.0.1"]).address, "127.0.0.1");
  for (const address of ["8.8.8.8", "0.0.0.0", "localhost", "192.168.55.5;true"]) assert.throws(() => acceptanceOptions(["--address", address]));
});
test("Docker destination binds effective context inputs and daemon identity before recovery", async () => {
  let daemon = "generated-daemon-one", endpoint = '{"Host":"ssh://generated@192.168.5.5"}';
  const runner: CommandRunner = async (_command, args) => ({ stdout: args[0] === "info" ? daemon : args[1] === "show" ? "generated-context" : endpoint, stderr: "", exitCode: 0 });
  const planned = await dockerIdentity(runner); await assertDockerDestination(planned, runner);
  daemon = "generated-daemon-two"; await assert.rejects(assertDockerDestination(planned, runner), /destination/);
  daemon = "generated-daemon-one"; endpoint = '{"Host":"ssh://generated@192.168.5.6"}'; await assert.rejects(assertDockerDestination(planned, runner), /destination/);
});
test("source publication uses one atomic dual-ref push and adopts a lost success reply", async t => {
  const { context, state, config } = fixture(t);
  let remote = "b".repeat(40), pushes = 0;
  const runner: CommandRunner = async (_command, args) => {
    if (args[0] === "ls-remote") return { stdout: `${remote}\trefs/heads/main\n${remote}\trefs/heads/review/fleet-duration-freshness\n`, stderr: "", exitCode: 0 };
    if (args[0] === "push") {
      pushes++; assert.deepEqual(args, ["push", "--atomic", "origin", `${config.sourceCommit}:refs/heads/main`, `${config.sourceCommit}:refs/heads/review/fleet-duration-freshness`]);
      remote = config.sourceCommit; return { stdout: "", stderr: "generated lost reply", exitCode: 1 };
    }
    assert.ok(["fetch", "merge-base"].includes(args[0]!)); return { stdout: "", stderr: "", exitCode: 0 };
  };
  await assert.rejects(publishSource(context, runner, async () => {}), /No mutation retry/);
  await publishSource(releaseContext(state, loadJournal(state)), runner, async () => {});
  assert.equal(pushes, 1);
});
test("divergent concurrent source work prevents every push without a force fallback", async t => {
  const { context } = fixture(t); let pushes = 0;
  const runner: CommandRunner = async (_command, args) => {
    if (args[0] === "ls-remote") return { stdout: `${"b".repeat(40)}\trefs/heads/main\n${"c".repeat(40)}\trefs/heads/review/fleet-duration-freshness\n`, stderr: "", exitCode: 0 };
    if (args[0] === "push") pushes++;
    return { stdout: "", stderr: "", exitCode: args[0] === "merge-base" ? 1 : 0 };
  };
  await assert.rejects(publishSource(context, runner, async () => {}), /Concurrent source work/); assert.equal(pushes, 0);
});
test("GitHub adapter fixes the host/repository and aborts an upload before launching gh", async t => {
  const { directory } = fixture(t); let calls = 0;
  const runner: CommandRunner = async (_command, args, options) => {
    calls++; assert.equal(options?.env?.GH_HOST, "github.com");
    if (args[0] === "release") assert.equal(args[args.indexOf("--repo") + 1], `github.com/${REPOSITORY}`);
    else assert.equal(args[args.indexOf("--hostname") + 1], "github.com");
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  const github = createGitHub(directory, runner);
  await github.create("modern-v0.1.0-dev.22", "a".repeat(40), "/generated-notes"); await github.removeAsset(1);
  const path = join(directory, "upload.bin"); writeFileSync(path, "generated");
  await assert.rejects(github.upload(1, { name: "upload.bin", path, bytes: 9, sha256: digest("generated") }, () => { throw new Error("generated abort"); }), /generated abort/);
  assert.equal(calls, 2); assert.equal(readdirSync(directory).some(name => name.startsWith(".upload-")), false);
});
