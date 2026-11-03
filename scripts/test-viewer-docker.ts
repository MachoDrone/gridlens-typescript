/** Real generated-owner/viewer installation acceptance; no source PCs, provider
 * requests, financial preparation, claims or existing wallet keys are involved. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";
import { Coordinator } from "../src/installer/coordinator.ts";
import { assertLocalDockerForSelection } from "../src/installer/network-selection.ts";
import { ensureVpnWeb } from "../src/installer/vpn-web.ts";
import { verifyRelease } from "../src/installer/release.ts";
import { requireReleaseImage, runtimeRelease } from "../src/installer/image-identity.ts";
import { installViewer, readViewerInstallation, resumeViewerInstallation } from "../src/installer/viewer-install.ts";
import { parseViewerInvite, redeemViewerInvite } from "../src/backend/viewer-client.ts";
import { loadPublicKey } from "./release-coordinator.ts";
import { digest } from "./release/model.ts";
import type { FixtureProfile } from "./release/model.ts";
import { fixtureDocker } from "./release/fixture-docker.ts";
import { fixtureOwner, fixtureRequest } from "./release/fixture-http.ts";
import { assertViewerFixtureAbsent, cleanupViewerFixture, verifyViewerFixture, viewerFixtureNames, viewerFixtureRunner, viewerPairCounts } from "./release/fixture-viewer.ts";

export interface ViewerDockerOptions { bundle: string; publicKey: string; address: string; sshTarget: string; httpsPort: number; webPort: number; viewerPort: number; instance?: string; report: string }
export function viewerDockerOptions(args: readonly string[]): ViewerDockerOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!, value = args[index + 1];
    if (!value || values.has(key) || !["--bundle", "--public-key", "--address", "--ssh-target", "--https-port", "--web-port", "--viewer-port", "--instance", "--report"].includes(key)) throw new Error("Use unique viewer Docker fixture options."); values.set(key, value);
  }
  const get = (key: string): string => { const value = values.get(key); if (!value) throw new Error(`Missing ${key}.`); return value; };
  const address = get("--address"), sshTarget = get("--ssh-target"), ports = ["--https-port", "--web-port", "--viewer-port"].map(key => Number(get(key))), instance = values.get("--instance");
  if (isIP(address) !== 4 || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address) || !/^[a-z_][a-z0-9_-]{0,31}@[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(sshTarget)
    || ports.some(port => !Number.isInteger(port) || port < 1024 || port > 65535 || [8789, 8790].includes(port)) || new Set(ports).size !== 3
    || instance !== undefined && !/^fixture-[a-f0-9]{12}$/.test(instance)) throw new Error("Use an explicit isolated private fixture target, identity and separate ports.");
  return { bundle: resolve(get("--bundle")), publicKey: resolve(get("--public-key")), address, sshTarget, httpsPort: ports[0]!, webPort: ports[1]!, viewerPort: ports[2]!,
    ...(instance ? { instance } : {}), report: resolve(get("--report")) };
}
export async function runViewerDocker(options: ViewerDockerOptions): Promise<void> {
  const project = realpathSync(fileURLToPath(new URL("../", import.meta.url))), report = resolve(options.report);
  if (existsSync(report)) throw new Error("Preserve existing viewer evidence; choose a fresh report path.");
  let ancestor = dirname(report); while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const actual = resolve(realpathSync(ancestor), relative(ancestor, report));
  if (!statSync(ancestor).isDirectory() || actual === project || actual.startsWith(project + sep)) throw new Error("Keep viewer evidence outside the checkout.");
  const manifest = readFileSync(resolve(options.bundle, "modern-release.json")), signature = readFileSync(resolve(options.bundle, "modern-release.sig"));
  const signed = verifyRelease(manifest, signature, loadPublicKey(options.publicKey));
  if (signed.minimumCoordinator !== 3) throw new Error("Viewer ownership smoke requires the protected candidate.");
  const suffix = options.instance?.slice(8) ?? randomBytes(6).toString("hex"), instance = options.instance ?? `fixture-${suffix}`;
  const ownerFixture = { instance, webPort: options.webPort, httpsPort: options.httpsPort }, viewerFixture = { instance: `fixture-view-${suffix}`, port: options.viewerPort };
  const profile: FixtureProfile = { sshTarget: options.sshTarget, address: options.address, webPorts: [options.webPort, options.viewerPort], requireColdDownload: false };
  const docker = fixtureDocker(profile), runner = viewerFixtureRunner(profile), images = [signed.imageId, ...(signed.configImageId ? [signed.configImageId] : [])];
  assertLocalDockerForSelection(runner);
  viewerFixtureNames(viewerFixture); await docker.absent(ownerFixture); assertViewerFixtureAbsent(runner, viewerFixture); await docker.portsAvailable([ownerFixture], [viewerFixture.port]);
  const release = runtimeRelease(signed, requireReleaseImage(runner, signed)), coordinator = new Coordinator(runner);
  const evidence: Record<string, unknown> = { fixture: "gridlens-viewer-docker-v1", instance, viewerInstance: viewerFixture.instance, candidateImageId: release.imageId,
    candidateVersion: release.version, candidateSequence: release.sequence, manifestSha256: digest(manifest), mode: "production-functions-signed-local-bundle",
    publicInstallerCommand: false, sourceHosts: 0, providerDispatchReservations: 0, financialPrepareOrConfirmRequests: 0, claimsRequested: 0, existingWalletKeyReads: 0 };
  let owner: Awaited<ReturnType<typeof fixtureOwner>> | undefined, failure: unknown; const cleanupErrors: string[] = [];
  const audit = async () => JSON.parse(await docker.exec(ownerFixture, "owner", ["node", "-e",
    "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/ledger/ledger.sqlite',{readOnly:true});try{const count=p=>db.prepare('SELECT count(*) AS n FROM private_state WHERE key LIKE ?').get(p).n;const decode=v=>{if(!Array.isArray(v))return v;const[k,e]=v;if(k==='number')return e;if(k==='object')return Object.fromEntries(e.map(([a,b])=>[a,decode(b)]));if(k==='map')return e.map(([a,b])=>[decode(a),decode(b)]);return e.map(decode);};let dispatches=0;const visit=(v,k='')=>{if(Array.isArray(v)){if(/dispatch/i.test(k))dispatches+=v.length;v.forEach(x=>visit(x));}else if(v&&typeof v==='object')for(const[a,b]of Object.entries(v))visit(b,a);};for(const row of db.prepare(\"SELECT value FROM private_state WHERE key LIKE 'provider/%'\").all())visit(decode(JSON.parse(row.value).value));const wallet=db.prepare(\"SELECT json_extract(value,'$.consumed') AS consumed,json_type(value,'$.operation')='null' AS noOperation FROM private_state WHERE key='treasury.v1'\").get();process.stdout.write(JSON.stringify({permissions:count('permission:%'),claimOperations:count('treasury.claims.v1/operation/%'),providerRows:count('provider/%'),providerDispatchReservations:dispatches,consumed:wallet?.consumed??0,noOperation:wallet?.noOperation??1}));}finally{db.close();}" ])) as { permissions: number; claimOperations: number; providerRows: number; providerDispatchReservations: number; consumed: number; noOperation: number };
  try {
    console.log(`Viewer fixture ${instance}: installing generated empty protected owner`);
    const installed = coordinator.install({ instance, release, action: "setup", bindAddress: options.address, port: options.httpsPort });
    ensureVpnWeb(runner, installed.config, release, options.webPort, { upgrade: true }); coordinator.publishBrowserSecurity(installed.config);
    const initial = await audit(); assert.equal(initial.permissions, 0); assert.equal(initial.claimOperations, 0); assert.equal(initial.consumed, 0); assert.equal(initial.noOperation, 1); assert.equal(initial.providerDispatchReservations, 0);
    owner = await fixtureOwner(profile, ownerFixture, docker);
    console.log(`Viewer fixture ${instance}: creating and redeeming viewer-only invitation`);
    const invite = await owner.createViewerInvite(), beforePairing = await viewerPairCounts(docker, ownerFixture);
    const client = await redeemViewerInvite(invite, "Generated Docker viewer");
    assert.equal(client.serverId, invite.serverId);
    const paired = await viewerPairCounts(docker, ownerFixture); assert.equal(paired.devices, beforePairing.devices + 1); assert.equal(paired.attempts, beforePairing.attempts + 1);
    const viewer = await installViewer({ runner, image: release, config: client, instance: viewerFixture.instance, bindAddress: options.address, port: viewerFixture.port });
    console.log(`Viewer fixture ${instance}: verifying reads, denial and private mount isolation`);
    const proof = await verifyViewerFixture(runner, profile, viewerFixture, { images, serverId: client.serverId });
    evidence.viewer = proof;
    assert.throws(() => parseViewerInvite({ ...invite, expiresAtMs: 1 }));
    const retained = await resumeViewerInstallation(runner, { image: release, instance: viewerFixture.instance });
    assert.deepEqual(retained, viewer); assert.deepEqual(await viewerPairCounts(docker, ownerFixture), paired);
    evidence.expiredInviteRerunWithoutRedemption = true;
    const read = readViewerInstallation(runner, viewerFixture.instance); assert.ok(read?.ready);
    const raw = JSON.parse((await docker.docker(["container", "inspect", viewer.containerName])))[0] as { Id: string };
    await docker.docker(["stop", "--time", "15", raw.Id]); await docker.docker(["container", "rm", raw.Id]);
    const recovered = await resumeViewerInstallation(runner, { image: release, instance: viewerFixture.instance });
    console.log(`Viewer fixture ${instance}: verifying saved-token recovery and cleanup`);
    assert.equal(recovered?.configurationHash, viewer.configurationHash); assert.equal(recovered?.origin, viewer.origin);
    assert.deepEqual(await viewerPairCounts(docker, ownerFixture), paired);
    await verifyViewerFixture(runner, profile, viewerFixture, { images, serverId: client.serverId });
    evidence.missingGatewayRecoveredWithoutRedemption = true;
    const final = await audit(); assert.equal(final.permissions, 0); assert.equal(final.claimOperations, 0); assert.equal(final.consumed, 0); assert.equal(final.noOperation, 1);
    assert.equal(final.providerDispatchReservations, 0); evidence.audit = final;
    const local = await fixtureRequest(`http://${options.address}:${options.webPort}/api/shared/status`);
    assert.equal((local.body as { role?: string }).role, "viewer");
  } catch (error) { failure = error; evidence.failure = error instanceof Error ? error.message : "Viewer Docker acceptance failed."; }
  finally {
    owner?.close();
    try { cleanupViewerFixture(runner, viewerFixture); } catch (error) { cleanupErrors.push(error instanceof Error ? error.message : "Viewer cleanup failed."); }
    try { await docker.cleanup([ownerFixture]); } catch (error) { cleanupErrors.push(error instanceof Error ? error.message : "Owner fixture cleanup failed."); }
  }
  evidence.passed = !failure && cleanupErrors.length === 0; evidence.cleanupVerified = cleanupErrors.length === 0; evidence.cleanupErrors = cleanupErrors;
  mkdirSync(dirname(report), { recursive: true, mode: 0o700 }); writeFileSync(report, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  if (failure) throw failure; if (cleanupErrors.length) throw new Error("Viewer acceptance cleanup needs review.");
  console.log(JSON.stringify({ passed: true, report, instance, viewerInstance: viewerFixture.instance, candidateImageId: release.imageId, cleanupVerified: true }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runViewerDocker(viewerDockerOptions(process.argv.slice(2)));
