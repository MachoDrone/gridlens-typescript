/** Actual worker acceptance on uniquely labeled Docker resources. This fixture
 * injects only its signed download transport in derived test images; normal
 * updater/owner/gateway code and deployment arguments perform every update. */
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import type { Browser } from "@playwright/test";
import { Coordinator } from "../src/installer/coordinator.ts";
import { privateAddress } from "../src/installer/config.ts";
import { ensureVpnWeb } from "../src/installer/vpn-web.ts";
import { localDockerRunner, checked, inspectOwned, resourceName, labels, mount, restrictions, PRODUCT, PRODUCT_LABEL, INSTANCE_LABEL } from "../src/installer/docker.ts";
import type { DockerRunner } from "../src/installer/docker.ts";
import type { ModernRelease } from "../src/installer/release.ts";
import { parseUpdateStatus, updateActive } from "../src/contracts/updates.ts";
import { CHANNEL_FORMAT } from "../src/updater/release.ts";
import { ensureUpdater, DOCKER_SOCKET } from "../src/updater/deployment.ts";

export interface UpdaterAcceptanceOptions {
  instance: string; address: string; httpsPort: number; webPort: number; baseImage: string; report?: string;
}
export function updaterAcceptanceOptions(args: readonly string[]): UpdaterAcceptanceOptions {
  const options: UpdaterAcceptanceOptions = { instance: `fixture-${randomBytes(6).toString("hex")}`, address: "", httpsPort: 0, webPort: 0, baseImage: "" };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!, value = args[index + 1];
    if (!value || seen.has(name)) throw new Error("Supply each updater acceptance option once with a value."); seen.add(name);
    if (name === "--instance") options.instance = value;
    else if (name === "--address") options.address = value;
    else if (name === "--https-port" && /^\d+$/.test(value)) options.httpsPort = Number(value);
    else if (name === "--web-port" && /^\d+$/.test(value)) options.webPort = Number(value);
    else if (name === "--base-image") options.baseImage = value;
    else if (name === "--report") options.report = resolve(value);
    else throw new Error("Unknown updater acceptance option.");
  }
  if (!/^fixture-[a-f0-9]{12}$/.test(options.instance) || !privateAddress(options.address) || options.address.startsWith("127.") || options.address === "::1"
    || ![options.httpsPort, options.webPort].every(port => Number.isInteger(port) && port >= 1024 && port <= 65535) || options.httpsPort === options.webPort
    || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]+$/.test(options.baseImage) || options.baseImage.startsWith("sha256:")) throw new Error("Use an explicit private test address, separate ports and a tagged prebuilt source image.");
  if (options.report && (existsSync(options.report) || options.report.startsWith(resolve(".") + "/"))) throw new Error("Choose a new private report path outside the checkout.");
  return options;
}
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const fixtureFetch = `import { readFileSync, createReadStream, appendFileSync } from "node:fs";
import { Readable } from "node:stream";
globalThis.fetch = async function fixtureFetch(input, options = {}) {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash
    || !url.pathname.startsWith("/MachoDrone/gridlens-typescript/releases/download/")) throw new Error("Fixture blocked an external fetch.");
  let index; try { index = JSON.parse(readFileSync("/update-state/fixture/index.json", "utf8")); } catch { return new Response("Fixture release not published", {status:503}); }
  const item = index[url.pathname]; if (!item) return new Response("Fixture artifact missing", {status:404});
  if (!/^[a-zA-Z0-9.-]+$/.test(item.file) || !Number.isSafeInteger(item.bytes) || item.bytes < 1) throw new Error("Invalid fixture artifact map.");
  appendFileSync("/update-state/fixture/fetches.jsonl", JSON.stringify({path:url.pathname,at:Date.now()})+"\\n");
  const stream = createReadStream("/update-state/fixture/" + item.file, options.signal ? {signal:options.signal} : {});
  return new Response(Readable.toWeb(stream), {status:200, headers:{"content-length":String(item.bytes)}});
};
`;
interface FixtureRelease { release: ModernRelease; tag: string; manifest: Buffer; signature: Buffer; channel: Buffer; channelSignature: Buffer }
async function call(origin: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(path, origin), { ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json", Origin: origin }) }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Fixture browser API returned HTTP ${response.status}.`); }
  if (!response.body) throw new Error("Fixture browser API returned no body.");
  const parts: Buffer[] = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength; if (size > 1024 * 1024) throw new Error("Fixture browser API exceeded its response bound.");
    parts.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8")) as Record<string, unknown>;
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeout = 180_000): Promise<T> {
  const end = Date.now() + timeout; let last: unknown;
  while (Date.now() < end) {
    try { const value = await read(); if (ready(value)) return value; last = value; } catch (error) { last = error; }
    await delay(1000);
  }
  throw new Error(`Fixture condition did not complete: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

export async function runUpdaterDockerAcceptance(options: UpdaterAcceptanceOptions, runner: DockerRunner = localDockerRunner({ allowSudo: false })) {
  const { instance } = options, coordinator = new Coordinator(runner), imageTags = new Map<string, string>();
  const evidence: Record<string, unknown> = { version: 1, instance, startedAt: new Date().toISOString(), driver: "Real installed updater; browser UI and same-origin API",
    transportFixture: "Fixture-only image import maps fixed release URLs to signed artifacts in the owned update-state volume; real signature/hash/streaming code runs unchanged.",
    imageDifference: "Version/build identity and fixture import only; failure target additionally replaces owner entrypoint with a generated startup failure.",
    upstream: "Empty fixture fleet; fixture import rejects all nonrelease fetches. No computer credentials or real hosts are supplied.",
    baseBuild: "Caller-supplied tagged source image; report its separate cold build evidence.", publishedEntryPoint: "Not exercised by this worker fixture." };
  let claimed = false, failure: unknown, browser: Browser | undefined;
  const progress = (message: string) => console.log(`Updater fixture ${instance}: ${message}`);
  const imageInfo = (id: string) => JSON.parse(checked(runner, ["image", "inspect", id]))[0] as { Id: string; Config: { Labels: Record<string, string> } };
  const stateVolume = resourceName(instance, "update-state");
  const helper = (image: string, program: string, input: unknown = {}, daemon = false): string => checked(runner, ["run", "--rm", "-i", ...labels(instance), ...restrictions,
    "--network", "none", "--user", "0:0", ...mount(stateVolume, "/update-state"), ...(daemon ? ["--mount", `type=bind,src=${DOCKER_SOCKET},dst=${DOCKER_SOCKET}`] : []),
    image, "node", "--input-type=module", "-e", program], JSON.stringify(input));
  const snapshot = () => {
    const config = coordinator.configuration(instance, imageInfo(options.baseImage).Id)!;
    const roles = Object.fromEntries(["owner", "gateway", "vpn-web", "updater"].map(role => {
      const value = inspectOwned(runner, "container", resourceName(instance, role), instance)!;
      return [role, { id: value.Id, image: value.Image, readOnlyRoot: (value.HostConfig as Record<string, unknown>).ReadonlyRootfs }];
    }));
    return { config, roles };
  };
  try {
    evidence.dockerVersion = checked(runner, ["version", "--format", "{{.Server.Version}}"]);
    const base = imageInfo(options.baseImage);
    if (base.Config.Labels[PRODUCT_LABEL] !== PRODUCT) throw new Error("Base image is not the verified GridLens source image.");
    evidence.baseImageId = base.Id;
    for (const kind of ["container", "volume", "network"] as const) {
      const names = checked(runner, [...(kind === "container" ? ["container", "ls", "-a"] : [kind, "ls"]), "--filter", `label=${PRODUCT_LABEL}=${PRODUCT}`,
        "--filter", `label=${INSTANCE_LABEL}=${instance}`, "--format", kind === "container" ? "{{.Names}}" : "{{.Name}}"]);
      if (names) throw new Error("Fixture identity already owns resources; choose a fresh identity.");
    }
    if (checked(runner, ["image", "ls", "--filter", `label=${PRODUCT_LABEL}=${PRODUCT}`, "--filter", `label=${INSTANCE_LABEL}=${instance}`, "--format", "{{.ID}}"]))
      throw new Error("Fixture identity already owns images; choose a fresh identity.");
    for (const sequence of [1, 2, 3]) {
      const existing = runner.run(["image", "inspect", `gridlens-modern-${instance}:${sequence}`]);
      if (existing.status === 0) throw new Error("A fixture image tag is already in use; it was retained.");
      if (!/No such (?:image|object)|not found/i.test(existing.stderr)) throw new Error("Fixture image preflight could not verify that the tag is free.");
    }
    claimed = true;
    const keys = generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const buildImage = (sequence: number, failingOwner = false): { tag: string; imageId: string; version: string } => {
      const tag = `gridlens-modern-${instance}:${sequence}`, version = `0.0.${sequence}-updater-fixture`;
      const files = { "build.json": JSON.stringify({ version, sequence, buildId: `${sequence}:${version}` }), "update-public-key.pem": publicKey, "fixture-fetch.mjs": fixtureFetch,
        ...(failingOwner ? { "scripts/shared-owner.ts": 'throw new Error("Generated isolated updater startup failure.");\n' } : {}) };
      const program = `const fs=require("node:fs");const files=JSON.parse(Buffer.from("${Buffer.from(JSON.stringify(files)).toString("base64")}","base64"));for(const [name,text] of Object.entries(files))fs.writeFileSync("/app/"+name,text);`;
      checked(runner, ["build", "--pull=false", "--tag", tag, "-"], `FROM ${options.baseImage}\nUSER 0:0\nRUN node -e '${program}'\nLABEL io.gridlens.version="${version}" ${INSTANCE_LABEL}="${instance}"\nENV NODE_OPTIONS="--import=/app/fixture-fetch.mjs"\nUSER 1000:1000\n`);
      const imageId = imageInfo(tag).Id; imageTags.set(tag, imageId); return { tag, imageId, version };
    };
    progress("building the three isolated versioned fixture images");
    const first = buildImage(1), second = buildImage(2), third = buildImage(3, true);
    const firstRelease: ModernRelease = { format: "gridlens-modern-release-v1", imageId: first.imageId, version: first.version, sequence: 1, platform: "linux-x64",
      minimumCoordinator: 1, runtime: { name: "gridlens-runtime-fixture-bootstrap.tar", bytes: 1, sha256: hash("bootstrap fixture") } };
    progress("installing an empty isolated fleet and both gateways");
    const installed = coordinator.install({ instance, release: firstRelease, action: "setup", bindAddress: options.address, port: options.httpsPort, enableUpdater: true });
    const web = ensureVpnWeb(runner, installed.config, firstRelease, options.webPort, { upgrade: true });
    evidence.origins = { https: installed.config.origin, browser: web.origin };
    const createRelease = (target: typeof first, sequence: number): FixtureRelease => {
      const artifact = `gridlens-runtime-fixture-${sequence}.tar`;
      const recorded = JSON.parse(helper(first.imageId, `import{mkdirSync,statSync,createReadStream}from"node:fs";import{createHash}from"node:crypto";import{spawnSync}from"node:child_process";
        const input=JSON.parse(await new Promise(resolve=>{let text="";process.stdin.on("data",chunk=>text+=chunk);process.stdin.on("end",()=>resolve(text));}));mkdirSync("/update-state/fixture",{recursive:true,mode:448});
        const path="/update-state/fixture/"+input.artifact,result=spawnSync("docker",["image","save","--output",path,input.tag],{encoding:"utf8",timeout:300000});if(result.status!==0)throw Error("Fixture archive export failed");
        const hash=createHash("sha256");for await(const chunk of createReadStream(path))hash.update(chunk);process.stdout.write(JSON.stringify({bytes:statSync(path).size,sha256:hash.digest("hex")}));`, { artifact, tag: target.tag }, true)) as { bytes: number; sha256: string };
      const release: ModernRelease = { format: "gridlens-modern-release-v1", imageId: target.imageId, version: target.version, sequence, platform: "linux-x64",
        minimumCoordinator: 1, runtime: { name: artifact, ...recorded } };
      assert.ok(recorded.bytes < 1024 ** 3, "Fixture release must fit the real signed archive bound");
      const manifest = Buffer.from(JSON.stringify(release)), signature = sign(null, manifest, keys.privateKey);
      const channel = Buffer.from(JSON.stringify({ format: CHANNEL_FORMAT, channel: "development", platform: "linux-x64", version: target.version, sequence,
        buildId: `${sequence}:${target.version}`, releaseTag: `modern-v${target.version}`, manifestSha256: hash(manifest), workerProtocol: 1 }));
      const channelSignature = sign(null, channel, keys.privateKey);
      // The archive is already in the owned volume; deleting only this fixture
      // tag proves the installed worker must perform a real cold Docker load.
      assert.equal(imageInfo(target.tag).Id, target.imageId); checked(runner, ["image", "rm", target.tag]);
      assert.notEqual(runner.run(["image", "inspect", target.imageId]).status, 0);
      return { release, tag: target.tag, manifest, signature, channel, channelSignature };
    };
    progress("saving signed target archives and removing their images from the daemon");
    const target = createRelease(second, 2), broken = createRelease(third, 3);
    evidence.coldTargetImages = [target.release.imageId, broken.release.imageId];
    const publishFixture = (selected: FixtureRelease) => {
      const tag = `modern-v${selected.release.version}`, base = `/MachoDrone/gridlens-typescript/releases/download/`;
      const files = { [`manifest-${selected.release.sequence}.json`]: selected.manifest.toString("base64"), [`manifest-${selected.release.sequence}.sig`]: selected.signature.toString("base64"),
        "modern-channel-linux-x64.json": selected.channel.toString("base64"), "modern-channel-linux-x64.sig": selected.channelSignature.toString("base64") };
      const entries = {
        [`${base}modern-development/modern-channel-linux-x64.json`]: { file: "modern-channel-linux-x64.json", bytes: selected.channel.length },
        [`${base}modern-development/modern-channel-linux-x64.sig`]: { file: "modern-channel-linux-x64.sig", bytes: selected.channelSignature.length },
        [`${base}${tag}/modern-release.json`]: { file: `manifest-${selected.release.sequence}.json`, bytes: selected.manifest.length },
        [`${base}${tag}/modern-release.sig`]: { file: `manifest-${selected.release.sequence}.sig`, bytes: selected.signature.length },
        [`${base}${tag}/${selected.release.runtime.name}`]: { file: selected.release.runtime.name, bytes: selected.release.runtime.bytes },
      };
      helper(first.imageId, `import{readFileSync,writeFileSync,renameSync}from"node:fs";const input=JSON.parse(readFileSync(0,"utf8"));for(const[name,value]of Object.entries(input.files))writeFileSync("/update-state/fixture/"+name,Buffer.from(value,"base64"));
        let prior={};try{prior=JSON.parse(readFileSync("/update-state/fixture/index.json","utf8"));}catch{}writeFileSync("/update-state/fixture/index.pending",JSON.stringify({...prior,...input.entries}));renameSync("/update-state/fixture/index.pending","/update-state/fixture/index.json");`, { files, entries });
    };
    publishFixture(target); ensureUpdater(runner, installed.config);
    const readStatus = async () => parseUpdateStatus(await call(web.origin, "/api/shared/updates"));
    const available = await until(readStatus, value => value.candidate?.sequence === 2);
    const initial = snapshot(); evidence.initial = initial;
    const initialStatus = await call(web.origin, "/api/shared/status");
    assert.deepEqual((initialStatus.context as { addresses: unknown[] }).addresses, []);
    evidence.initialServerId = initialStatus.serverId;
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const pageErrors: string[] = []; page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto(web.origin, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Update available", exact: true }).click();
    progress("starting a real update from the browser");
    await page.getByRole("button", { name: "Update now", exact: true }).click();
    const active = await until(readStatus, value => updateActive(value.operation));
    const duplicate = parseUpdateStatus(await call(web.origin, "/api/shared/updates/start", { candidateId: available.candidate!.id, idempotencyKey: `fixture_duplicate_${randomBytes(8).toString("hex")}` }));
    assert.equal(duplicate.operation?.id, active.operation!.id);
    const phases = new Set<string>(); let disconnected = 0;
    const completed = await until(async () => { try { const value = await readStatus(); if (value.operation) phases.add(value.operation.phase); return value; } catch (error) { disconnected++; throw error; } },
      value => value.operation?.id === active.operation!.id && !updateActive(value.operation), 300_000);
    assert.equal(completed.operation?.phase, "complete", completed.operation?.error ?? "Worker update did not complete");
    assert.equal(completed.current?.sequence, 2);
    await page.waitForFunction(expected => document.documentElement.dataset.gridlensFleetReady === expected
      && !(document.querySelector("#update-dialog") as HTMLDialogElement | null)?.open, completed.current!.buildId, { timeout: 60_000 });
    const upgraded = snapshot();
    for (const role of ["owner", "gateway", "vpn-web", "updater"]) {
      assert.equal(upgraded.roles[role]!.image, second.imageId); assert.equal(upgraded.roles[role]!.readOnlyRoot, true);
      assert.notEqual(upgraded.roles[role]!.id, initial.roles[role]!.id);
    }
    assert.notEqual(upgraded.config.active.stateVolume, initial.config.active.stateVolume);
    assert.equal(upgraded.config.certificateSha256, initial.config.certificateSha256);
    assert.equal((await call(web.origin, "/api/shared/status")).serverId, initialStatus.serverId);
    evidence.update = { operation: completed.operation, observedPhases: [...phases], disconnectedReads: disconnected, automaticBrowserReturn: true, ...upgraded };
    progress("publishing a signed fixture with an intentionally failing owner");
    publishFixture(broken);
    await until(async () => { await call(web.origin, "/api/shared/updates/check", {}); return readStatus(); }, value => value.candidate?.sequence === 3, 90_000);
    await page.locator("#sidebar-update").click();
    await page.getByRole("button", { name: "Check for updates", exact: true }).click();
    await page.getByRole("button", { name: "Update now", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await page.getByRole("button", { name: "Update now", exact: true }).click();
    const restoring = await until(readStatus, value => value.operation?.target.sequence === 3, 60_000);
    const restored = await until(readStatus, value => value.operation?.id === restoring.operation!.id && !updateActive(value.operation), 240_000);
    assert.equal(restored.operation?.phase, "rolled-back", restored.operation?.error ?? "Fixture failure was not rolled back");
    assert.equal(restored.current?.sequence, 2); assert.ok(restored.operation?.error);
    const rolledBack = snapshot();
    assert.equal(rolledBack.config.active.stateVolume, upgraded.config.active.stateVolume);
    for (const role of ["owner", "gateway", "vpn-web", "updater"]) assert.equal(rolledBack.roles[role]!.image, second.imageId);
    assert.equal(rolledBack.config.certificateSha256, initial.config.certificateSha256);
    assert.equal((await call(web.origin, "/api/shared/status")).serverId, initialStatus.serverId);
    await page.waitForFunction(() => document.querySelector("#update-status")?.textContent === "Update failed; previous version restored", undefined, { timeout: 60_000 });
    await page.getByRole("button", { name: "Close update", exact: true }).click();
    assert.equal(await page.locator("html").getAttribute("data-gridlens-fleet-ready"), completed.current!.buildId);
    evidence.rollback = { operation: restored.operation, usableBrowser: true, ...rolledBack };
    evidence.browserPageErrors = pageErrors;
    assert.deepEqual(pageErrors, []);
    evidence.passed = true; progress("real worker upgrade, self-replacement, browser return and rollback passed");
  } catch (error) {
    failure = error; evidence.passed = false; evidence.failure = error instanceof Error ? error.message : "Updater acceptance failed.";
    const logs: Record<string, string> = {};
    for (const role of ["owner", "gateway", "vpn-web", "updater", "updater-replacement"]) {
      try { const name = resourceName(instance, role); if (inspectOwned(runner, "container", name, instance)) { const result = runner.run(["logs", "--tail", "60", name]); logs[role] = `${result.stdout}\n${result.stderr}`.slice(-20_000); } } catch { /* Preserve original failure. */ }
    }
    evidence.fixtureLogs = logs;
  } finally { await browser?.close(); }
  const cleanupErrors: string[] = [];
  const clean = (action: () => void) => { try { action(); } catch (error) { cleanupErrors.push(error instanceof Error ? error.message : "Fixture cleanup failed."); } };
  if (claimed) {
    // Stop lifecycle authorities before listing their children, so a timed-out
    // update cannot recreate a runtime while the fixture is being removed.
    for (const role of ["updater-replacement", "updater"]) clean(() => {
      const name = resourceName(instance, role);
      if (!inspectOwned(runner, "container", name, instance)) return;
      checked(runner, ["stop", "--time", "30", name]);
      if (inspectOwned(runner, "container", name, instance)) checked(runner, ["rm", name]);
    });
    for (const kind of ["container", "volume", "network"] as const) clean(() => {
      const names = checked(runner, [...(kind === "container" ? ["container", "ls", "-a"] : [kind, "ls"]), "--filter", `label=${PRODUCT_LABEL}=${PRODUCT}`,
        "--filter", `label=${INSTANCE_LABEL}=${instance}`, "--format", kind === "container" ? "{{.Names}}" : "{{.Name}}"]);
      for (const name of names.split("\n").filter(Boolean)) clean(() => {
        const owned = inspectOwned(runner, kind, name, instance); if (!owned) return;
        if (kind !== "container" && !name.startsWith(`gridlens-modern-${instance}-`)) throw new Error("Cleanup refused an unexpected fixture resource name.");
        if (kind === "container") { checked(runner, ["stop", "--time", "30", name]); if (inspectOwned(runner, kind, name, instance)) checked(runner, ["rm", name]); }
        else checked(runner, [kind, "rm", name]);
      });
    });
  }
  for (const [tag, id] of [...imageTags].reverse()) clean(() => {
    const inspected = runner.run(["image", "inspect", id]); if (inspected.status !== 0) return;
    const value = JSON.parse(inspected.stdout)[0];
    if (value.Id !== id || value.Config?.Labels?.[INSTANCE_LABEL] !== instance) throw new Error("Fixture image ownership changed; cleanup refused it.");
    const tags = value.RepoTags as string[] | undefined;
    if (tags?.some(value => value !== tag && value !== "<none>:<none>")) throw new Error("Fixture image acquired an unrelated tag; cleanup refused it.");
    checked(runner, ["image", "rm", tags?.includes(tag) ? tag : id]);
  });
  evidence.cleanupErrors = cleanupErrors; evidence.completedAt = new Date().toISOString();
  if (options.report) { mkdirSync(dirname(options.report), { recursive: true, mode: 0o700 }); writeFileSync(options.report, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: "wx" }); }
  if (failure) throw failure;
  if (cleanupErrors.length) throw new Error("Updater acceptance passed but isolated cleanup needs review.");
  return evidence;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runUpdaterDockerAcceptance(updaterAcceptanceOptions(process.argv.slice(2))); }
  catch (error) { console.error(error instanceof Error ? error.message : "Isolated updater acceptance failed."); process.exitCode = 1; }
}
