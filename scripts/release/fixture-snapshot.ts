import { X509Certificate } from "node:crypto";
import { fixturePrefix } from "./fixture-docker.ts";
import type { Fixture, FixtureDocker } from "./fixture-docker.ts";
import type { FixtureProfile } from "./model.ts";
import { identity } from "./model.ts";
import { fixtureRequest } from "./fixture-http.ts";
import type { ModernRelease } from "../../src/installer/release.ts";

const AUDIT = String.raw`
const {DatabaseSync}=require('node:sqlite'),fs=require('node:fs'),crypto=require('node:crypto');
const db=new DatabaseSync('/ledger/ledger.sqlite',{readOnly:true});
try {
 const count=pattern=>db.prepare('SELECT count(*) AS n FROM private_state WHERE key LIKE ?').get(pattern).n;
 const rows=db.prepare("SELECT value FROM private_state WHERE key LIKE 'provider/%'").all();
 const decode=v=>{if(!Array.isArray(v))return v;const[k,e]=v;if(k==='number')return e;if(k==='object')return Object.fromEntries(e.map(([a,b])=>[a,decode(b)]));if(k==='map')return e.map(([a,b])=>[decode(a),decode(b)]);return e.map(decode);};
 let reservations=0;const visit=(v,k='')=>{if(Array.isArray(v)){if(/dispatch/i.test(k))reservations+=v.length;v.forEach(x=>visit(x));}else if(v&&typeof v==='object')for(const[a,b]of Object.entries(v))visit(b,a);};
 for(const row of rows)visit(decode(JSON.parse(row.value).value));
 const files=fs.readdirSync('/credentials');
 if(files.some(n=>n!=='vault-key'&&n!=='treasury-key-v1'&&n!=='treasury-claims-v1.marker'&&!/^[a-f0-9]{64}$/.test(n)))throw Error('Unexpected fixture credential record');
 const wallet=db.prepare("SELECT json_type(value,'$.owner')='object' AS ownerConfigured,json_type(value,'$.operation')='null' AS noOperation,json_extract(value,'$.consumed') AS consumed FROM private_state WHERE key='treasury.v1'").get();
 const claims=db.prepare("SELECT json_array_length(value,'$.entries') AS attempts,json_type(value,'$.unresolvedId')='null' AS noUnresolved FROM private_state WHERE key='treasury.claims.v1'").get();
 if(wallet&&(wallet.noOperation!==1||wallet.consumed!==0)||claims&&(claims.attempts!==0||claims.noUnresolved!==1))throw Error('Unexpected fixture financial activity');
 const protectionActive=!!db.prepare("SELECT 1 FROM private_state WHERE key='access.owner-bound.v1'").get();
 const gatewayKey=db.prepare("SELECT 1 FROM private_state WHERE key='gateway-access.owner-bound.v1'").get()?'gateway-access.owner-bound.v1':'gateway-access.v1';
 const grants=db.prepare("SELECT json_extract(j.value,'$.id') AS id,json_extract(j.value,'$.scopeId') AS scopeId,json_extract(j.value,'$.revokedAtMs') AS revokedAtMs FROM private_state s,json_each(s.value,'$.grants') j WHERE s.key=? ORDER BY id").all(gatewayKey);
 const activeLegacyGrants=db.prepare("SELECT count(*) AS n FROM private_state s,json_each(s.value,'$.grants') j WHERE s.key='gateway-access.v1' AND json_extract(j.value,'$.revokedAtMs') IS NULL").get().n;
 if(protectionActive&&activeLegacyGrants!==0)throw Error('Legacy operator grant was revived');
 process.stdout.write(JSON.stringify({protectionActive,legacyOperatorGrantsRevoked:activeLegacyGrants===0,permissionCount:count('permission:%'),monitorCount:count('monitor:%'),credentialRecordCount:files.filter(n=>/^[a-f0-9]{64}$/.test(n)).length,providerDispatchReservations:reservations,grantIdentitySha256:crypto.createHash('sha256').update(JSON.stringify(grants)).digest('hex'),walletKeyPresent:files.includes('treasury-key-v1'),walletLedgerPresent:!!wallet,walletOwnerConfigured:wallet?.ownerConfigured===1,walletOperations:0,claimsLedgerPresent:!!claims,claimsMarkerPresent:files.includes('treasury-claims-v1.marker'),claimAttempts:claims?.attempts??0,claimOperations:count('treasury.claims.v1/operation/%'),unresolvedClaim:claims?claims.noUnresolved!==1:false}));
}finally{db.close();}`;
export interface Snapshot {
  config: { instance: string; origin: string; bindAddress: string; port: number; certificateSha256: string; active: ModernRelease; previous?: ModernRelease };
  serverId: string;
  context: unknown;
  publicCaSha256: string;
  grantIdentitySha256: string;
  audit: Record<string, unknown>;
  containers: Record<string, unknown>;
}
export async function snapshotFixture(profile: FixtureProfile, fixture: Fixture, docker: FixtureDocker, expected: ModernRelease): Promise<Snapshot> {
  const records = await Promise.all(["owner", "gateway", "vpn-web", "updater"].map(async role => [role, await docker.inspect(fixture, role)] as const));
  const config = JSON.parse(await docker.exec(fixture, "updater", ["node", "-e", "process.stdout.write(require('node:fs').readFileSync('/config/installation.json','utf8'))"])) as Snapshot["config"];
  const ca = await docker.exec(fixture, "updater", ["node", "-e", "process.stdout.write(require('node:fs').readFileSync('/config/ca.crt','utf8'))"]);
  const images = [expected.imageId, expected.configImageId].filter(Boolean);
  if (config.instance !== fixture.instance || config.bindAddress !== profile.address || config.port !== fixture.httpsPort
    || config.origin !== `https://${profile.address}:${fixture.httpsPort}` || config.active.version !== expected.version || config.active.sequence !== expected.sequence
    || !images.includes(config.active.imageId)) throw new Error("Installed fixture config does not match the signed release and declared endpoint.");
  const plain = `http://${profile.address}:${fixture.webPort}`;
  const status = await fixtureRequest(plain + "/api/shared/status"), roster = await fixtureRequest(plain + "/api/fleet/hosts.json"), observations = await fixtureRequest(plain + "/api/shared/observations");
  const data = status.body as { serverId: string; context: unknown; capabilities: string[] };
  const addresses = (roster.body as { addresses: unknown[] }).addresses;
  if (status.status !== 200 || roster.status !== 200 || !Array.isArray(addresses) || addresses.length
    || observations.status !== 200 || ((observations.body as { associations?: unknown[] }).associations ?? []).length) throw new Error("Fixture fleet is not empty.");
  for (const origin of [plain, config.origin]) {
    const response = await fixtureRequest(origin + "/health/ready", origin === plain ? {} : { ca });
    const ready = response.body as { status: string; build: unknown; ownerBuild: unknown };
    const build = { version: expected.version, sequence: expected.sequence, buildId: `${expected.sequence}:${expected.version}` };
    if (response.status !== 200 || ready.status !== "ready" || identity(ready.build) !== identity(build) || identity(ready.ownerBuild) !== identity(build)) throw new Error("Fixture readiness does not identify the expected owner and gateway build.");
  }
  const audit = JSON.parse(await docker.exec(fixture, "owner", ["node", "-e", AUDIT])) as Record<string, unknown>;
  for (const key of ["permissionCount", "monitorCount", "credentialRecordCount", "providerDispatchReservations", "walletOperations", "claimAttempts", "claimOperations"]) if (audit[key] !== 0) throw new Error("Fixture unexpectedly acquired collection or financial activity.");
  if (audit.unresolvedClaim !== false) throw new Error("Fixture has an unresolved claim.");
  const financial = audit.walletLedgerPresent === true, claims = data.capabilities.includes("treasury-claims-pilot-v1");
  if (audit.walletKeyPresent !== financial || audit.claimsLedgerPresent !== claims || audit.claimsMarkerPresent !== claims) throw new Error("Fixture capability state is inconsistent.");
  if (financial && (await fixtureRequest(plain + "/api/shared/treasury/status")).status !== 403) throw new Error("Fixture HTTP exposed the financial endpoint.");
  const containers: Record<string, unknown> = {};
  for (const [role, value] of records) {
    if (!value.State.Running || !value.HostConfig.ReadonlyRootfs || value.Image !== config.active.imageId || !images.includes(value.Image)) throw new Error("Fixture role does not run the exact signed image with a read-only root.");
    const mounts = value.Mounts.filter(mount => mount.Destination === "/treasury" || mount.Name === fixturePrefix(fixture) + "treasury-ipc");
    if (mounts.length !== (financial && ["owner", "gateway"].includes(role) ? 1 : 0)
      || mounts.some(mount => mount.Type !== "volume" || mount.Name !== fixturePrefix(fixture) + "treasury-ipc" || mount.RW !== (role === "owner"))) throw new Error("Unexpected fixture financial socket mount.");
    containers[role] = { id: value.Id, image: value.Image, running: true, readonly: true, mounts: value.Mounts.map(mount => ({ type: mount.Type, name: mount.Name ?? null, destination: mount.Destination, readWrite: mount.RW })).sort((a, b) => a.destination.localeCompare(b.destination)) };
  }
  return { config, serverId: data.serverId, context: data.context, publicCaSha256: new X509Certificate(ca).fingerprint256.replaceAll(":", "").toLowerCase(),
    grantIdentitySha256: String(audit.grantIdentitySha256), audit, containers };
}
export function assertPreserved(before: Snapshot, after: Snapshot): void {
  for (const key of ["serverId", "context", "publicCaSha256", "grantIdentitySha256"] as const) if (identity(before[key]) !== identity(after[key])) throw new Error(`Fixture preservation failed: ${key}.`);
  for (const key of ["origin", "bindAddress", "port", "certificateSha256"] as const) if (before.config[key] !== after.config[key]) throw new Error(`Fixture endpoint preservation failed: ${key}.`);
  if (identity(before.config.active) !== identity(after.config.previous)) throw new Error("Upgraded fixture did not retain its previous release.");
}
