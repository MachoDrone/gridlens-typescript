/** Actual worker acceptance on uniquely labeled Docker resources. This fixture
 * injects only its signed download transport in derived test images; normal
 * updater/owner/gateway code and deployment arguments perform every update. */
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpsRequest } from "node:https";
import { chromium } from "@playwright/test";
import type { Browser } from "@playwright/test";
import { Coordinator } from "../src/installer/coordinator.ts";
import { parseBrowserSecurityStatus } from "../src/contracts/browser-security.ts";
import { parseTreasuryConfiguration, parseTreasuryStatus, parseTreasuryUnlock } from "../src/contracts/treasury.ts";
import { parseClaimsStatus } from "../src/contracts/treasury-claims.ts";
import { verifyGateway } from "../src/installer/health.ts";
import { privateAddress } from "../src/installer/config.ts";
import { ensureVpnWeb } from "../src/installer/vpn-web.ts";
import { localDockerRunner, checked, inspectOwned, resourceName, labels, mount, restrictions, PRODUCT, PRODUCT_LABEL, INSTANCE_LABEL } from "../src/installer/docker.ts";
import type { DockerRunner } from "../src/installer/docker.ts";
import type { ModernRelease } from "../src/installer/release.ts";
import { parseUpdateStatus, updateActive } from "../src/contracts/updates.ts";
import type { UpdateStatus } from "../src/contracts/updates.ts";
import { CHANNEL_FORMAT } from "../src/updater/release.ts";
import { ensureUpdater, DOCKER_SOCKET } from "../src/updater/deployment.ts";
import { channelAssets } from "../src/updater/channel-paths.ts";
import type { ChannelFamily } from "../src/updater/channel-paths.ts";

export interface UpdaterAcceptanceOptions {
  instance: string; address: string; httpsPort: number; webPort: number; baseImage: string; previousImage?: string; report?: string;
  archiveCompression?: "none" | "gzip";
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
    else if (name === "--previous-image") options.previousImage = value;
    else if (name === "--archive-compression" && (value === "none" || value === "gzip")) options.archiveCompression = value;
    else if (name === "--report") options.report = resolve(value);
    else throw new Error("Unknown updater acceptance option.");
  }
  if (!/^fixture-[a-f0-9]{12}$/.test(options.instance) || !privateAddress(options.address) || options.address.startsWith("127.") || options.address === "::1"
    || ![options.httpsPort, options.webPort].every(port => Number.isInteger(port) && port >= 1024 && port <= 65535) || options.httpsPort === options.webPort
    || ![options.baseImage, ...(options.previousImage ? [options.previousImage] : [])].every(image => /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]+$/.test(image) && !image.startsWith("sha256:")))
    throw new Error("Use an explicit private test address, separate ports and tagged prebuilt source images.");
  if (options.report && (existsSync(options.report) || options.report.startsWith(resolve(".") + "/"))) throw new Error("Choose a new private report path outside the checkout.");
  return options;
}
/** Inspect once and derive by immutable ID, so changing a source tag cannot replace
 * the old application's code during the transition under test. */
export interface UpdaterAcceptanceSource { imageId: string; version: string; browserSecurity: boolean; treasury: boolean; treasuryProtocol: 0 | 1 | 2; financialSecurity: boolean; minimumCoordinator: 1 | 2 | 3 }
export function updaterAcceptanceSource(runner: DockerRunner, image: string, previous = false): UpdaterAcceptanceSource {
  const values: unknown = JSON.parse(checked(runner, ["image", "inspect", image]));
  if (!Array.isArray(values) || values.length !== 1) throw new Error("The fixture source image could not be verified.");
  const value = values[0] as { Id?: unknown; Config?: { Labels?: Record<string, unknown> } }, identity = value?.Config?.Labels;
  if (typeof value?.Id !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.Id) || identity?.[PRODUCT_LABEL] !== PRODUCT
    || typeof identity["io.gridlens.version"] !== "string" || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(identity["io.gridlens.version"])
    || identity["io.gridlens.updater-protocol"] !== "1"
    || ![undefined, "1"].includes(identity["io.gridlens.browser-security-protocol"] as string | undefined)
    || ![undefined, "0", "1", "2"].includes(identity["io.gridlens.treasury-protocol"] as string | undefined)
    || !previous && identity["io.gridlens.browser-security-protocol"] !== "1"
    || ["1", "2"].includes(String(identity["io.gridlens.treasury-protocol"])) && identity["io.gridlens.browser-security-protocol"] !== "1"
    || identity["io.gridlens.treasury-protocol"] === "2" && (identity["io.gridlens.financial-security-protocol"] !== "1" || identity["io.gridlens.guardian-protocol"] !== "1"))
    throw new Error(previous ? "The previous fixture source must be an updater-capable GridLens image with supported declared capabilities."
      : "The target fixture source must advertise updater and guided browser setup support.");
  const treasuryProtocol = identity["io.gridlens.treasury-protocol"] === "2" ? 2 : identity["io.gridlens.treasury-protocol"] === "1" ? 1 : 0;
  return { imageId: value.Id, version: identity["io.gridlens.version"], browserSecurity: identity["io.gridlens.browser-security-protocol"] === "1",
    treasury: treasuryProtocol !== 0, treasuryProtocol, financialSecurity: identity["io.gridlens.financial-security-protocol"] === "1", minimumCoordinator: treasuryProtocol === 2 ? 3 : treasuryProtocol === 1 ? 2 : 1 };
}
/** Inspect only mount topology and public environment names. The updater's
 * Docker authority is separate from having a mounted financial socket. */
export function verifyUpdaterTreasuryBindings(instance: string, role: string, value: Record<string, unknown>, enabled: boolean): void {
  assert.ok(["owner", "gateway", "vpn-web", "updater"].includes(role), "Unknown fixture runtime role");
  const financial = resourceName(instance, "treasury-ipc"), expected = enabled && ["owner", "gateway"].includes(role);
  const mounts = value.Mounts;
  assert.ok(Array.isArray(mounts), "Fixture container mounts could not be inspected");
  const matches = (mounts as { Name?: string; Destination?: string; RW?: boolean; Type?: string }[])
    .filter(item => item.Name === financial || item.Destination === "/treasury" || item.Destination?.startsWith("/treasury/"));
  assert.equal(matches.length, expected ? 1 : 0, `Unexpected Wallet socket mount for ${role}`);
  if (expected) {
    assert.equal(matches[0]!.Type, "volume"); assert.equal(matches[0]!.Name, financial); assert.equal(matches[0]!.Destination, "/treasury");
    assert.equal(matches[0]!.RW, role === "owner", `Wrong Wallet socket mount mode for ${role}`);
  }
  const environment = (value.Config as { Env?: unknown } | undefined)?.Env;
  assert.ok(Array.isArray(environment), "Fixture container environment could not be inspected");
  const socket = (environment as unknown[]).filter(item => typeof item === "string" && item.startsWith("GRIDLENS_TREASURY_SOCKET="));
  assert.deepEqual(socket, expected ? ["GRIDLENS_TREASURY_SOCKET=/treasury/treasury.sock"] : [], `Unexpected Wallet socket selection for ${role}`);
}
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export function assertViewerUpdateDenied(status: number, role: unknown, before: UpdateStatus, after: UpdateStatus): void {
  // Shared service maps AccessError("denied") to401.403 belongs to other
  // transport/endpoint guards and is not interchangeable with this contract.
  assert.equal(status, 401, "Viewer update denial did not match the access contract");
  assert.equal(role, "viewer", "Denied client lost its readable viewer identity");
  assert.equal(after.canUpdate, false, "Viewer acquired update authority");
  assert.deepEqual(after.current, before.current, "Denied viewer request changed the running build");
  assert.deepEqual(after.operation, before.operation, "Denied viewer request changed an update operation");
}
/** Read-only, fixed-file diagnostics before fixture cleanup. No credentials,
 * certificate keys or complete environment values leave the owned containers. */
export function captureUpdaterFailure(runner: DockerRunner, instance: string, imageId: string): Record<string, unknown> {
  if (!/^fixture-[a-f0-9]{12}$/.test(instance) || !/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error("Invalid updater diagnostic fixture identity.");
  const containers: Record<string, unknown> = {};
  for (const role of ["owner", "gateway", "vpn-web", "updater", "updater-replacement"]) {
    try {
      const value = inspectOwned(runner, "container", resourceName(instance, role), instance);
      if (!value) { containers[role] = { present: false }; continue; }
      const config = value.Config as { Env?: unknown[] };
      containers[role] = { present: true, id: value.Id, image: value.Image, state: value.State, restartCount: value.RestartCount,
        financialEnvironment: (config.Env ?? []).filter((entry): entry is string => typeof entry === "string"
          && /^GRIDLENS_(?:TREASURY_PROTOCOL|FINANCIAL_SECURITY_FLOOR)=[012]$/.test(entry)) };
    } catch { containers[role] = { inspectionUnavailable: true }; }
  }
  for (const suffix of ["config", "update-state"]) if (!inspectOwned(runner, "volume", resourceName(instance, suffix), instance)) return { containers, retainedState: "unavailable" };
  const program = String.raw`
const fs=require('node:fs'),{DatabaseSync}=require('node:sqlite');
const read=path=>{try{const stat=fs.lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>131072)throw Error();return JSON.parse(fs.readFileSync(path,'utf8'));}catch{return null;}};
const config=read('/config/installation.json'),transaction=read('/update-state/runtime-transaction.json');let journal=null;
if(fs.existsSync('/update-state/updates.sqlite')){const db=new DatabaseSync('/update-state/updates.sqlite',{readOnly:true});try{const row=db.prepare('SELECT value FROM journal WHERE id=1').get();if(typeof row?.value==='string'&&row.value.length<=131072){const value=JSON.parse(row.value);journal={status:value.status,highestSequence:value.highestSequence,retryAtMs:value.retryAtMs,attemptedAtMs:value.attemptedAtMs};}}finally{db.close();}}
process.stdout.write(JSON.stringify({configuration:config?{schema:config.schema,phase:config.phase,active:config.active,previous:config.previous,financialSecurity:config.financialSecurity,origin:config.origin}:null,
transaction:transaction?{operationId:transaction.operationId,rollback:transaction.rollback,failure:transaction.failure,targetImageId:transaction.targetImageId,previousWorkerImage:transaction.previousWorkerImage,previousActive:transaction.previous?.active,previousSchema:transaction.previous?.schema,previousFinancialSecurity:transaction.previous?.financialSecurity}:null,journal}));`;
  try {
    const state = checked(runner, ["run", "--rm", ...labels(instance), ...restrictions, "--network", "none", "--user", "0:0",
      ...mount(resourceName(instance, "config"), "/config", true), ...mount(resourceName(instance, "update-state"), "/update-state", true), imageId, "node", "-e", program]);
    if (Buffer.byteLength(state) > 256 * 1024) throw new Error();
    return { containers, retainedState: JSON.parse(state) };
  } catch { return { containers, retainedState: "read-only capture failed" }; }
}
const fixtureFetch = `import { readFileSync, createReadStream, appendFileSync } from "node:fs";
import { Readable } from "node:stream";
globalThis.fetch = async function fixtureFetch(input, options = {}) {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash
    || !url.pathname.startsWith("/MachoDrone/gridlens-typescript/releases/download/")) throw new Error("Fixture blocked an external fetch.");
  let index; try { index = JSON.parse(readFileSync("/update-state/fixture/index.json", "utf8")); } catch { return new Response("Fixture release not published", {status:503}); }
  const item = index[url.pathname];
  appendFileSync("/update-state/fixture/fetches.jsonl", JSON.stringify({path:url.pathname,status:item?200:404,at:Date.now()})+"\\n");
  if (!item) return new Response("Fixture artifact missing", {status:404});
  if (!/^[a-zA-Z0-9.-]+$/.test(item.file) || !Number.isSafeInteger(item.bytes) || item.bytes < 1) throw new Error("Invalid fixture artifact map.");
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
/** Real certificate validation, with fixture session material retained only in memory. */
async function secureCall(origin: string, path: string, ca: string, { body, cookie, unlockToken }: { body?: unknown; cookie?: string; unlockToken?: string } = {}): Promise<{
  status: number; value: Record<string, unknown>; cookie?: string;
}> {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = httpsRequest(new URL(path, origin), { ca, rejectUnauthorized: true, agent: false, method: encoded ? "POST" : "GET",
      headers: { Accept: "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(unlockToken ? { "X-GridLens-Wallet": unlockToken } : {}),
        ...(encoded ? { Origin: origin, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(encoded) } : {}) } }, response => {
      let size = 0; const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 1024 * 1024) req.destroy(new Error("Fixture HTTPS response exceeded its bound.")); else chunks.push(chunk); });
      response.on("error", reject); response.on("end", () => {
        try { const setCookie = response.headers["set-cookie"]?.[0]; resolve({ status: response.statusCode ?? 0,
          value: JSON.parse(Buffer.concat(chunks).toString("utf8")), ...(setCookie ? { cookie: setCookie } : {}) }); }
        catch { reject(new Error("Fixture HTTPS response was invalid.")); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error("Fixture HTTPS request timed out.")), 8000);
    req.on("error", reject); req.on("close", () => clearTimeout(timer)); req.end(encoded);
  });
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
    baseBuild: "Caller-supplied tagged source image; report its separate cold build evidence.", publishedEntryPoint: "Not exercised by this worker fixture.",
    archiveCompression: options.archiveCompression ?? "none", fixtureArchives: [] };
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
  const checkTreasuryIsolation = (enabled: boolean): void => {
    for (const role of ["owner", "gateway", "vpn-web", "updater"]) {
      const value = inspectOwned(runner, "container", resourceName(instance, role), instance);
      assert.ok(value, `Missing fixture ${role}`); verifyUpdaterTreasuryBindings(instance, role, value, enabled);
    }
  };
  try {
    evidence.dockerVersion = checked(runner, ["version", "--format", "{{.Server.Version}}"]);
    const base = updaterAcceptanceSource(runner, options.baseImage);
    const previous = options.previousImage ? updaterAcceptanceSource(runner, options.previousImage, true) : undefined;
    if (base.treasuryProtocol === 2 && !previous?.financialSecurity) throw new Error("Protected Wallet acceptance requires the previously published floor-aware compatibility runtime.");
    evidence.baseImageId = base.imageId; evidence.targetCapabilities = { browserSecurity: base.browserSecurity, treasury: base.treasury, minimumCoordinator: base.minimumCoordinator };
    if (previous) evidence.previousSource = { reference: options.previousImage, ...previous,
      codePreserved: "Only fixture build metadata, update public key and fetch transport are replaced; application and worker source stay from this older image." };
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
    const buildImage = (sequence: number, failingOwner = false): { tag: string; imageId: string; version: string; minimumCoordinator: 1 | 2 | 3 } => {
      const tag = `gridlens-modern-${instance}:${sequence}`, version = `0.0.${sequence}-updater-fixture`;
      const files = { "build.json": JSON.stringify({ version, sequence, buildId: `${sequence}:${version}` }), "update-public-key.pem": publicKey, "fixture-fetch.mjs": fixtureFetch,
        ...(failingOwner ? { "scripts/shared-owner.ts": 'throw new Error("Generated isolated updater startup failure.");\n' } : {}) };
      const program = `const fs=require("node:fs");const files=JSON.parse(Buffer.from("${Buffer.from(JSON.stringify(files)).toString("base64")}","base64"));for(const [name,text] of Object.entries(files))fs.writeFileSync("/app/"+name,text);`;
      const source = sequence === 1 && previous ? previous : base;
      checked(runner, ["build", "--pull=false", "--tag", tag, "-"], `FROM ${source.imageId}\nUSER 0:0\nRUN node -e '${program}'\nLABEL io.gridlens.version="${version}" ${INSTANCE_LABEL}="${instance}"\nENV NODE_OPTIONS="--import=/app/fixture-fetch.mjs"\nUSER 1000:1000\n`);
      const imageId = imageInfo(tag).Id; imageTags.set(tag, imageId); return { tag, imageId, version, minimumCoordinator: source.minimumCoordinator };
    };
    progress("building the three isolated versioned fixture images");
    const first = buildImage(1), second = buildImage(2), third = buildImage(3, true);
    const firstRelease: ModernRelease = { format: "gridlens-modern-release-v1", imageId: first.imageId, version: first.version, sequence: 1, platform: "linux-x64",
      minimumCoordinator: first.minimumCoordinator, runtime: { name: "gridlens-runtime-fixture-bootstrap.tar", bytes: 1, sha256: hash("bootstrap fixture") } };
    progress("installing an empty isolated fleet and both gateways");
    const installed = coordinator.install({ instance, release: firstRelease, action: "setup", bindAddress: options.address, port: options.httpsPort, enableUpdater: true });
    const web = ensureVpnWeb(runner, installed.config, firstRelease, options.webPort, { upgrade: true });
    evidence.origins = { https: installed.config.origin, browser: web.origin };
    const initialStatus = await call(web.origin, "/api/shared/status");
    let protectedNow = (previous ?? base).treasuryProtocol === 2;
    assert.equal(initialStatus.role, protectedNow ? "viewer" : "operator");
    assert.deepEqual((initialStatus.context as { addresses: unknown[] }).addresses, []);
    evidence.initialServerId = initialStatus.serverId;
    const publicCertificateSha256 = hash(new X509Certificate(installed.certificate).raw);
    const initialBrowserSecurity = { serverId: initialStatus.serverId, certificateSha256: publicCertificateSha256,
      serverCertificateSha256: installed.config.certificateSha256, httpsOrigin: installed.config.origin, httpOrigin: web.origin };
    const migratesBrowserSecurity = previous !== undefined && !previous.browserSecurity;
    if (migratesBrowserSecurity) {
      // Do not seed the new ledger record here: the old worker and replacement
      // worker must perform the real migration, without a new coordinator repair.
      for (const path of ["/secure-setup", "/secure-setup/status.json"]) {
        const response = await fetch(new URL(path, web.origin), { signal: AbortSignal.timeout(8000) });
        await response.body?.cancel(); assert.equal(response.status, 404, `The previous application unexpectedly serves ${path}`);
      }
      const response = await fetch(web.origin, { signal: AbortSignal.timeout(8000) });
      assert.equal(response.status, 200); const html = await response.text();
      assert.ok(html.length < 256 * 1024); assert.doesNotMatch(html, /id=["']sidebar-secure["']/);
      evidence.browserSecurityInitial = { ...initialBrowserSecurity, available: false, guideStatus: 404, metadataStatus: 404, newMetadataBootstrap: false };
    } else {
      assert.ok(coordinator.publishBrowserSecurity(installed.config), "The candidate must advertise guided browser setup");
    }
    const checkBrowserSecurity = async () => {
      const status = parseBrowserSecurityStatus(await call(web.origin, "/secure-setup/status.json"));
      assert.equal(status.available, true);
      if (!status.available) throw new Error("Guided browser setup metadata is unavailable.");
      assert.equal(status.httpsOrigin, installed.config.origin); assert.equal(status.httpOrigin, web.origin);
      assert.equal(status.certificateSha256, publicCertificateSha256);
      assert.equal(status.serverCertificateSha256, installed.config.certificateSha256);
      const response = await fetch(new URL("/secure-setup/ca.crt", web.origin), { signal: AbortSignal.timeout(8000) });
      assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
      const certificate = await response.text(); assert.ok(!certificate.includes("PRIVATE KEY"));
      assert.equal(hash(new X509Certificate(certificate).raw), publicCertificateSha256);
      await verifyGateway(installed.config.origin, installed.certificate);
      return { serverId: status.serverId, certificateSha256: status.certificateSha256,
        serverCertificateSha256: status.serverCertificateSha256, httpsOrigin: status.httpsOrigin, httpOrigin: status.httpOrigin };
    };
    let browserCookie: string | undefined;
    const checkSecureBrowser = async () => {
      assert.ok(browserCookie, "The fixture has not established its HTTPS browser session.");
      const result = await secureCall(installed.config.origin, "/api/shared/status", installed.certificate, { cookie: browserCookie });
      assert.equal(result.status, 200); assert.equal(result.value.serverId, initialBrowserSecurity.serverId); assert.equal(result.value.role, protectedNow ? "viewer" : "operator");
    };
    const connectSecureBrowser = async () => {
      const handoff = await call(web.origin, "/secure-setup/connect-code", {});
      assert.equal(handoff.version, 1); assert.match(String(handoff.code), /^[A-Za-z0-9_-]{43}$/);
      const connected = await secureCall(installed.config.origin, "/secure-setup/connect", installed.certificate, { body: { version: 1, code: handoff.code } });
      assert.equal(connected.status, 200); assert.equal(connected.value.connected, true);
      assert.equal(connected.value.token, undefined); assert.ok(connected.cookie);
      assert.match(connected.cookie, /Secure/); assert.match(connected.cookie, /HttpOnly/); assert.match(connected.cookie, /SameSite=Strict/);
      browserCookie = connected.cookie.split(";", 1)[0]!;
      await checkSecureBrowser();
      assert.notEqual((await secureCall(installed.config.origin, "/secure-setup/connect", installed.certificate, { body: { version: 1, code: handoff.code } })).status, 200);
      evidence.secureBrowserHandoff = "Verified HTTPS browser connected once without a terminal code; no bearer in JSON";
    };
    if (!migratesBrowserSecurity) {
      assert.deepEqual(await checkBrowserSecurity(), initialBrowserSecurity); evidence.browserSecurityInitial = initialBrowserSecurity;
      await connectSecureBrowser();
    }
    const createRelease = (target: typeof first, sequence: number): FixtureRelease => {
      const artifact = `gridlens-runtime-fixture-${sequence}.tar`;
      const recorded = JSON.parse(helper(first.imageId, `import{mkdirSync,statSync,createReadStream,createWriteStream,renameSync}from"node:fs";import{createHash}from"node:crypto";import{spawnSync}from"node:child_process";import{createGzip,createGunzip}from"node:zlib";import{pipeline}from"node:stream/promises";
        const input=JSON.parse(await new Promise(resolve=>{let text="";process.stdin.on("data",chunk=>text+=chunk);process.stdin.on("end",()=>resolve(text));}));mkdirSync("/update-state/fixture",{recursive:true,mode:448});
        const path="/update-state/fixture/"+input.artifact,result=spawnSync("docker",["image","save","--output",path,input.tag],{encoding:"utf8",timeout:300000});if(result.status!==0)throw Error("Fixture archive export failed");
        const expandedBytes=statSync(path).size;if(expandedBytes>1024**3)throw Error("Expanded fixture archive exceeds limit");
        if(input.compression==="gzip"){
          const rawHash=createHash("sha256");for await(const chunk of createReadStream(path))rawHash.update(chunk);const expected=rawHash.digest("hex");
          const packed=path+".gzip";await pipeline(createReadStream(path),createGzip({level:1}),createWriteStream(packed,{flags:"wx",mode:384}));
          const expanded=createReadStream(packed).pipe(createGunzip()),verifyHash=createHash("sha256");let count=0;
          for await(const chunk of expanded){count+=chunk.length;if(count>expandedBytes||count>1024**3)throw Error("Expanded fixture changed");verifyHash.update(chunk);}
          if(count!==expandedBytes||verifyHash.digest("hex")!==expected)throw Error("Fixture gzip roundtrip changed bytes");renameSync(packed,path);
        }else if(input.compression!=="none")throw Error("Unsupported fixture compression");
        const hash=createHash("sha256");for await(const chunk of createReadStream(path))hash.update(chunk);process.stdout.write(JSON.stringify({bytes:statSync(path).size,sha256:hash.digest("hex"),expandedBytes,compression:input.compression}));`,
        { artifact, tag: target.tag, compression: options.archiveCompression ?? "none" }, true)) as { bytes: number; sha256: string; expandedBytes: number; compression: string };
      assert.equal(recorded.compression, options.archiveCompression ?? "none");
      assert.ok(recorded.expandedBytes > 0 && recorded.expandedBytes < 1024 ** 3);
      if (recorded.compression === "gzip") assert.ok(recorded.bytes < recorded.expandedBytes);
      (evidence.fixtureArchives as unknown[]).push({ sequence, ...recorded });
      const release: ModernRelease = { format: "gridlens-modern-release-v1", imageId: target.imageId, version: target.version, sequence, platform: "linux-x64",
        minimumCoordinator: target.minimumCoordinator, runtime: { name: artifact, bytes: recorded.bytes, sha256: recorded.sha256 } };
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
    const publishFixture = (selected: FixtureRelease, family: ChannelFamily) => {
      const tag = `modern-v${selected.release.version}`, base = `/MachoDrone/gridlens-typescript/releases/download/`;
      const names = channelAssets(selected.release.platform, family);
      const files = { [`manifest-${selected.release.sequence}.json`]: selected.manifest.toString("base64"), [`manifest-${selected.release.sequence}.sig`]: selected.signature.toString("base64"),
        [names.manifest]: selected.channel.toString("base64"), [names.signature]: selected.channelSignature.toString("base64") };
      const entries = {
        [`${base}modern-development/${names.manifest}`]: { file: names.manifest, bytes: selected.channel.length },
        [`${base}modern-development/${names.signature}`]: { file: names.signature, bytes: selected.channelSignature.length },
        [`${base}${tag}/modern-release.json`]: { file: `manifest-${selected.release.sequence}.json`, bytes: selected.manifest.length },
        [`${base}${tag}/modern-release.sig`]: { file: `manifest-${selected.release.sequence}.sig`, bytes: selected.signature.length },
        [`${base}${tag}/${selected.release.runtime.name}`]: { file: selected.release.runtime.name, bytes: selected.release.runtime.bytes },
      };
      helper(first.imageId, `import{readFileSync,writeFileSync,renameSync}from"node:fs";const input=JSON.parse(readFileSync(0,"utf8"));for(const[name,value]of Object.entries(input.files))writeFileSync("/update-state/fixture/"+name,Buffer.from(value,"base64"));
        let prior={};try{prior=JSON.parse(readFileSync("/update-state/fixture/index.json","utf8"));}catch{}writeFileSync("/update-state/fixture/index.pending",JSON.stringify({...prior,...input.entries}));renameSync("/update-state/fixture/index.pending","/update-state/fixture/index.json");`, { files, entries });
    };
    const initialFamily: ChannelFamily = target.release.minimumCoordinator >= 3 ? "coordinator3" : "legacy";
    if (initialFamily === "coordinator3") {
      // The already-installed compatibility source remains the primary lane;
      // no old reader is ever shown the protected min-coordinator3 candidate.
      const manifest = Buffer.from(JSON.stringify(firstRelease)), signature = sign(null, manifest, keys.privateKey);
      const channel = Buffer.from(JSON.stringify({ format: CHANNEL_FORMAT, channel: "development", platform: firstRelease.platform, version: firstRelease.version,
        sequence: firstRelease.sequence, buildId: `${firstRelease.sequence}:${firstRelease.version}`, releaseTag: `modern-v${firstRelease.version}`, manifestSha256: hash(manifest), workerProtocol: 1 }));
      publishFixture({ release: firstRelease, tag: first.tag, manifest, signature, channel, channelSignature: sign(null, channel, keys.privateKey) }, "legacy");
    }
    publishFixture(target, initialFamily); ensureUpdater(runner, installed.config);
    const readStatus = async () => parseUpdateStatus(await call(web.origin, "/api/shared/updates"));
    const available = await until(readStatus, value => value.candidate?.sequence === 2);
    const initial = snapshot(); evidence.initial = initial;
    checkTreasuryIsolation((previous ?? base).treasury);
    evidence.initialTreasuryBindings = (previous ?? base).treasury ? "Financial socket mounted only by owner and HTTPS gateway" : "Financial socket absent from all runtime roles";
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
    protectedNow = base.treasuryProtocol === 2;
    if (protectedNow) {
      assert.equal(upgraded.config.schema, 2); assert.equal(upgraded.config.financialSecurity?.minimumTreasuryProtocol, 2);
      assert.equal(upgraded.config.financialSecurity?.minimumCoordinator, 3);
    }
    checkTreasuryIsolation(base.treasury);
    for (const role of ["owner", "gateway", "vpn-web", "updater"]) {
      assert.equal(upgraded.roles[role]!.image, second.imageId); assert.equal(upgraded.roles[role]!.readOnlyRoot, true);
      assert.notEqual(upgraded.roles[role]!.id, initial.roles[role]!.id);
    }
    assert.notEqual(upgraded.config.active.stateVolume, initial.config.active.stateVolume);
    assert.equal(upgraded.config.certificateSha256, initial.config.certificateSha256);
    assert.deepEqual(await checkBrowserSecurity(), initialBrowserSecurity);
    if (migratesBrowserSecurity) {
      await connectSecureBrowser();
      evidence.browserSecurityMigration = "Older application initially returned 404; the real old-worker update and replacement worker published metadata without driver bootstrap. Original public CA, leaf and endpoints retained.";
    }
    await checkSecureBrowser();
    evidence.browserSecurityAfterUpgrade = "Public CA, saved endpoints, server identity and verified HTTPS preserved";
    assert.equal((await call(web.origin, "/api/shared/status")).serverId, initialStatus.serverId);
    evidence.update = { operation: completed.operation, observedPhases: [...phases], disconnectedReads: disconnected, automaticBrowserReturn: true, ...upgraded };
    // This owner and its receiving address belong only to the empty, labeled
    // fixture. No source hosts, source keys or transfer requests are introduced.
    let walletPassword: string | undefined, walletUnlock: string | undefined, ownerBrowserCookie: string | undefined;
    const walletDestination = "1".repeat(31) + "9";
    const targetStatus = await call(web.origin, "/api/shared/status");
    const claimsSupported = Array.isArray(targetStatus.capabilities) && targetStatus.capabilities.includes("treasury-claims-pilot-v1");
    interface WalletStateProof { keyDigest: string; configurationDigest: string; verifierDigest: string; keyMatchesLedger: boolean; consumed: boolean; noOperation: boolean;
      claimLedgerDigest: string | null; claimMarkerDigest: string | null }
    const walletStateProof = (): WalletStateProof => {
      const result = checked(runner, ["exec", resourceName(instance, "owner"), "node", "--input-type=module", "-e",
        'import{readFileSync,existsSync}from"node:fs";import{createHash}from"node:crypto";import{DatabaseSync}from"node:sqlite";'
        + 'const hash=value=>createHash("sha256").update(value).digest("hex"),key=readFileSync("/credentials/treasury-key-v1");'
        + 'if(key.length!==32)throw Error("Fixture Wallet key has an invalid size");const keyDigest=hash(key);key.fill(0);'
        + 'const db=new DatabaseSync("/ledger/ledger.sqlite",{readOnly:true});try{const row=db.prepare("SELECT value FROM private_state WHERE key = ?").get("treasury.v1");'
        + 'if(!row||typeof row.value!=="string")throw Error("Fixture Wallet state is unavailable");const value=JSON.parse(row.value);'
        + 'if(!value.owner||typeof value.configuration!=="string")throw Error("Fixture Wallet was not configured");'
        + 'const claims=db.prepare("SELECT value FROM private_state WHERE key = ?").get("treasury.claims.v1"),marker="/credentials/treasury-claims-v1.marker";'
        + 'process.stdout.write(JSON.stringify({keyDigest,configurationDigest:hash(value.configuration),verifierDigest:hash(JSON.stringify(value.owner)),keyMatchesLedger:keyDigest===value.keyId,consumed:value.consumed,noOperation:value.operation===null,'
        + 'claimLedgerDigest:claims?hash(claims.value):null,claimMarkerDigest:existsSync(marker)?hash(readFileSync(marker)):null}));}finally{db.close();}'
      ]);
      const proof = JSON.parse(result) as WalletStateProof;
      assert.ok([proof.keyDigest, proof.configurationDigest, proof.verifierDigest].every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)), "Invalid fixture Wallet state proof");
      assert.ok(proof.keyMatchesLedger && proof.consumed === false && proof.noOperation === true, "The empty fixture unexpectedly consumed its Wallet pilot");
      if (claimsSupported) assert.ok([proof.claimLedgerDigest, proof.claimMarkerDigest].every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)),
        "Fixture claims require both retained initialization records");
      return proof;
    };
    const walletCall = (path: string, body?: unknown, unlockToken?: string) => {
      assert.ok(browserCookie, "The fixture needs its HTTPS browser session");
      return secureCall(installed.config.origin, `/api/shared/treasury/${path}`, installed.certificate,
        { cookie: browserCookie, ...(body === undefined ? {} : { body }), ...(unlockToken ? { unlockToken } : {}) });
    };
    const checkWalletHttpDenied = async (): Promise<void> => {
      for (const path of ["status", "setup", "unlock", "prepare", "confirm", "operations", "claims/status", "claims/operations", "claims/prepare", "claims/confirm"]) {
        const body = ["status", "operations", "claims/status", "claims/operations"].includes(path) ? undefined : JSON.stringify({ version: 1 });
        const response = await fetch(new URL(`/api/shared/treasury/${path}`, web.origin), { method: body === undefined ? "GET" : "POST",
          headers: { Origin: web.origin, "X-Forwarded-Proto": "https", ...(body ? { "Content-Type": "application/json" } : {}) },
          ...(body === undefined ? {} : { body }), signal: AbortSignal.timeout(8000) });
        await response.body?.cancel(); assert.equal(response.status, 403, `HTTP unexpectedly accepted fixture Wallet ${path}`);
      }
    };
    let initialWalletProof: WalletStateProof | undefined;
    if (base.treasury) {
      progress("verifying HTTPS-only Wallet setup on the empty fixture");
      await checkWalletHttpDenied();
      const status = await walletCall("status"); assert.equal(status.status, 200);
      const parsed = parseTreasuryStatus(status.value); assert.ok(parsed.supported && parsed.state === "setup-required" && !parsed.pilotConsumed);
      const terminal = JSON.parse(checked(runner, ["exec", "-i", resourceName(instance, "owner"), "node", "scripts/shared-control.ts", "json"],
        JSON.stringify({ operation: "treasury-setup", scopeId: "default" }))) as { ticket?: unknown; setupUrl?: unknown; httpsOrigin?: unknown };
      assert.ok(typeof terminal.ticket === "string" && /^[A-Za-z0-9_-]{43}$/.test(terminal.ticket), "Fixture terminal Wallet setup returned no valid ticket");
      assert.ok(terminal.httpsOrigin === installed.config.origin && terminal.setupUrl === `${installed.config.origin}/wallet#ticket=${terminal.ticket}`,
        "Fixture terminal Wallet setup did not bind the saved HTTPS address");
      walletPassword = randomBytes(32).toString("base64url");
      const setup = await walletCall("setup", { version: 1, ticket: terminal.ticket, password: walletPassword, destinationAddress: walletDestination });
      delete terminal.ticket; delete terminal.setupUrl;
      assert.equal(setup.status, 200); const unlocked = parseTreasuryUnlock(setup.value); walletUnlock = unlocked.unlockToken;
      assert.ok(unlocked.configuration.destinationAddress === walletDestination && unlocked.configuration.hosts.length === 0 && !unlocked.configuration.pilotConsumed,
        "Fixture Wallet setup returned an unexpected fleet or receiving address");
      initialWalletProof = walletStateProof();
      const activity = await walletCall("operations", undefined, walletUnlock); assert.equal(activity.status, 200); assert.deepEqual(activity.value.operations, []);
      if (claimsSupported) {
        const status = await walletCall("claims/status", undefined, walletUnlock); assert.equal(status.status, 200);
        const claims = parseClaimsStatus(status.value); assert.equal(claims.state, "ready"); assert.deepEqual(claims.eligibleHosts, []);
        const history = await walletCall("claims/operations", undefined, walletUnlock); assert.equal(history.status, 200); assert.deepEqual(history.value.operations, []);
        evidence.claimsAfterUpgrade = { retainedInitializationEstablished: true, httpsOwnerStatusVerified: true, emptyFleet: true, claimsRequested: 0 };
      }
      if (base.treasuryProtocol === 2) {
        assert.equal(targetStatus.role, "viewer", "The private gateway must become a viewer after protection");
        const beforeDenied = await readStatus();
        const denied = await fetch(new URL("/api/shared/updates/check", web.origin), { method: "POST", headers: { Origin: web.origin, "Content-Type": "application/json" }, body: "{}" });
        await denied.body?.cancel();
        const stillReadable = await call(web.origin, "/api/shared/status");
        assertViewerUpdateDenied(denied.status, stillReadable.role, beforeDenied, await readStatus());
        const granted = await walletCall("owner-browser", { version: 1 }, walletUnlock);
        const grantedCookie = granted.cookie;
        assert.equal(granted.status, 200); assert.ok(typeof grantedCookie === "string" && grantedCookie.startsWith("__Host-gridlens-owner="));
        ownerBrowserCookie = `${browserCookie}; ${grantedCookie.split(";")[0]}`;
        evidence.protectedOwnerAuthorization = { privateGatewayRole: "viewer", privateHttpAdministrationDenied: true, privateHttpDenialStatus: 401,
          viewerReadAccessPreserved: true, deniedRequestLeftOperationUnchanged: true, walletAuthorizedHttpsOwnerCookie: true, financialRequests: 0 };
      }
      evidence.walletAfterUpgrade = { sourceCapability: (previous ?? base).treasuryProtocol, targetCapability: base.treasuryProtocol,
        minimumCoordinator: target.release.minimumCoordinator, socketIsolation: "owner and HTTPS gateway only; absent from HTTP gateway and updater",
        httpsCertificateValidated: true, httpFinancialRequestsDenied: true, terminalSetupAndOwnerPasswordVerified: true,
        encryptedConfigurationEstablished: true, emptyFleet: true, transactionsRequested: 0 };
    } else evidence.walletAfterUpgrade = { targetCapability: 0, minimumCoordinator: target.release.minimumCoordinator,
      financialSocketAbsent: true, ownerSetupAttempted: false, transactionsRequested: 0 };
    progress("publishing a signed fixture with an intentionally failing owner");
    // The replacement worker contains coordinator3. This second phase proves
    // it can follow the new lane, while primary retains the compatible source.
    publishFixture(broken, "coordinator3");
    const next = await until(async () => {
      if (base.treasuryProtocol === 2) {
        const checked = await secureCall(installed.config.origin, "/api/shared/updates/check", installed.certificate, { cookie: ownerBrowserCookie!, body: {} });
        assert.equal(checked.status, 200);
      } else await call(web.origin, "/api/shared/updates/check", {});
      return readStatus();
    }, value => value.candidate?.sequence === 3, 90_000);
    if (base.treasuryProtocol === 2) {
      const started = await secureCall(installed.config.origin, "/api/shared/updates/start", installed.certificate, { cookie: ownerBrowserCookie!,
        body: { candidateId: next.candidate!.id, idempotencyKey: `fixture_protected_${randomBytes(8).toString("hex")}` } });
      assert.equal(started.status, 200);
    } else {
      await page.locator("#sidebar-update").click();
      await page.getByRole("button", { name: "Check for updates", exact: true }).click();
      await page.getByRole("button", { name: "Update now", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
      await page.getByRole("button", { name: "Update now", exact: true }).click();
    }
    const restoring = await until(readStatus, value => value.operation?.target.sequence === 3, 60_000);
    const restored = await until(readStatus, value => value.operation?.id === restoring.operation!.id && !updateActive(value.operation), 240_000);
    assert.equal(restored.operation?.phase, "rolled-back", restored.operation?.error ?? "Fixture failure was not rolled back");
    assert.equal(restored.current?.sequence, 2); assert.ok(restored.operation?.error);
    const rolledBack = snapshot();
    checkTreasuryIsolation(base.treasury);
    assert.equal(rolledBack.config.active.stateVolume, upgraded.config.active.stateVolume);
    for (const role of ["owner", "gateway", "vpn-web", "updater"]) assert.equal(rolledBack.roles[role]!.image, second.imageId);
    assert.equal(rolledBack.config.certificateSha256, initial.config.certificateSha256);
    assert.deepEqual(await checkBrowserSecurity(), initialBrowserSecurity);
    await checkSecureBrowser();
    if (base.treasury) {
      assert.ok(initialWalletProof && walletPassword && walletUnlock, "Fixture Wallet proof was not established before rollback");
      await checkWalletHttpDenied();
      const after = walletStateProof();
      assert.ok(after.keyDigest === initialWalletProof.keyDigest, "Rollback changed the fixture Wallet encryption key");
      assert.ok(after.configurationDigest === initialWalletProof.configurationDigest, "Rollback changed the encrypted fixture Wallet configuration");
      assert.ok(after.verifierDigest === initialWalletProof.verifierDigest, "Rollback changed the fixture Wallet password verifier");
      assert.equal(after.claimLedgerDigest, initialWalletProof.claimLedgerDigest, "Rollback changed the fixture claim ledger");
      assert.equal(after.claimMarkerDigest, initialWalletProof.claimMarkerDigest, "Rollback changed the fixture claim initialization marker");
      assert.equal((await walletCall("configuration", undefined, walletUnlock)).status, 401, "Old Wallet unlock unexpectedly survived owner replacement");
      const reopened = await walletCall("unlock", { version: 1, password: walletPassword }); assert.equal(reopened.status, 200);
      walletPassword = undefined; const unlocked = parseTreasuryUnlock(reopened.value); walletUnlock = unlocked.unlockToken;
      const configuration = await walletCall("configuration", undefined, walletUnlock); assert.equal(configuration.status, 200);
      const restoredConfiguration = parseTreasuryConfiguration(configuration.value);
      assert.ok(restoredConfiguration.destinationAddress === walletDestination && restoredConfiguration.hosts.length === 0 && !restoredConfiguration.pilotConsumed,
        "Fixture Wallet configuration was not retained through rollback");
      const activity = await walletCall("operations", undefined, walletUnlock); assert.equal(activity.status, 200); assert.deepEqual(activity.value.operations, []);
      if (claimsSupported) {
        const status = await walletCall("claims/status", undefined, walletUnlock); assert.equal(status.status, 200); assert.equal(parseClaimsStatus(status.value).state, "ready");
        evidence.claimsAfterRollback = { ledgerAndMarkerPreserved: true, httpsOwnerStatusVerified: true, claimsRequested: 0 };
      }
      assert.equal((await walletCall("lock", { version: 1 }, walletUnlock)).status, 200); walletUnlock = undefined;
      evidence.walletAfterRollback = { socketIsolationPreserved: true, httpFinancialRequestsDenied: true, httpsCertificateValidated: true,
        encryptionKeyPreserved: true, encryptedConfigurationPreserved: true, passwordVerifierPreserved: true,
        oldUnlockDenied: true, passwordUnlockVerified: true, receivingAddressPreserved: true, emptyFleet: true, transactionsRequested: 0 };
    }
    evidence.browserSecurityAfterRollback = "Public CA, saved endpoints, server identity and verified HTTPS preserved";
    assert.equal((await call(web.origin, "/api/shared/status")).serverId, initialStatus.serverId);
    if (base.treasuryProtocol === 2) {
      const beforeExpired = await readStatus();
      const expired = await secureCall(installed.config.origin, "/api/shared/updates/check", installed.certificate, { cookie: ownerBrowserCookie!, body: {} });
      const readable = await secureCall(installed.config.origin, "/api/shared/status", installed.certificate, { cookie: ownerBrowserCookie! });
      assert.equal(readable.status, 200);
      assertViewerUpdateDenied(expired.status, readable.value.role, beforeExpired, await readStatus());
      await page.goto(web.origin, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(expected => document.documentElement.dataset.gridlensFleetReady === expected, completed.current!.buildId, { timeout: 60_000 });
    } else {
      await page.waitForFunction(() => document.querySelector("#update-status")?.textContent === "Update failed; previous version restored", undefined, { timeout: 60_000 });
      await page.getByRole("button", { name: "Close update", exact: true }).click();
    }
    assert.equal(await page.locator("html").getAttribute("data-gridlens-fleet-ready"), completed.current!.buildId);
    evidence.rollback = { operation: restored.operation, usableBrowser: true, ...rolledBack };
    evidence.browserPageErrors = pageErrors;
    assert.deepEqual(pageErrors, []);
    await page.close();
    checked(runner, ["exec", "-i", resourceName(instance, "owner"), "node", "scripts/shared-control.ts", "json"],
      JSON.stringify({ operation: "revoke-vpn-web", scopeId: "default" }));
    assert.ok(browserCookie);
    assert.equal((await secureCall(installed.config.origin, "/api/shared/status", installed.certificate, { cookie: browserCookie })).status, 401);
    evidence.secureBrowserParentRevocation = "Derived browser access revoked with its private-network gateway grant";
    const channelReads = JSON.parse(helper(first.imageId, 'import{readFileSync}from"node:fs";const text=readFileSync("/update-state/fixture/fetches.jsonl","utf8");if(text.length>1048576)throw Error("Fixture trace bound");process.stdout.write(JSON.stringify(text.trim().split("\\n").filter(Boolean).map(line=>JSON.parse(line))));')) as { path: string; status: number }[];
    const prefix = "/MachoDrone/gridlens-typescript/releases/download/modern-development/";
    const primary = channelAssets("linux-x64", "legacy"), modern = channelAssets("linux-x64", "coordinator3");
    const legacyReads = channelReads.filter(row => row.path === prefix + primary.manifest && row.status === 200).length;
    const modernReads = channelReads.filter(row => row.path === prefix + modern.manifest && row.status === 200).length;
    if (initialFamily === "legacy") assert.ok(legacyReads > 0, "The old/compatibility worker never read its retained primary channel");
    assert.ok(modernReads > 0, "The replacement coordinator3 worker never read its v3 channel");
    evidence.channelFamilies = { initialFamily, replacementFamily: "coordinator3", legacySuccessfulReads: legacyReads, v3SuccessfulReads: modernReads,
      legacyPrimaryRetained: true, legacyMinimumCoordinator: initialFamily === "legacy" ? target.release.minimumCoordinator : firstRelease.minimumCoordinator,
      protectedMinimumCoordinator: target.release.minimumCoordinator };
    evidence.passed = true; progress("real worker upgrade, self-replacement, browser return and rollback passed");
  } catch (error) {
    failure = error; evidence.passed = false; evidence.failure = error instanceof Error ? error.message : "Updater acceptance failed.";
    if (typeof evidence.baseImageId === "string") {
      try { evidence.failureState = captureUpdaterFailure(runner, instance, evidence.baseImageId); }
      catch { evidence.failureState = { unavailable: true }; }
    }
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
