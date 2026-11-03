import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomBytes, X509Certificate } from "node:crypto";
import { identity } from "./model.ts";
import type { FixtureProfile } from "./model.ts";
import type { Fixture, FixtureDocker } from "./fixture-docker.ts";

interface Response { status: number; body: unknown; cookie?: string; text: string }
export function fixtureRequest(url: string, options: { ca?: string; body?: unknown; cookie?: string; token?: string } = {}): Promise<Response> {
  const parsed = new URL(url), data = options.body === undefined ? undefined : JSON.stringify(options.body);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Invalid fixture HTTP protocol.");
  if (parsed.protocol === "https:" && !options.ca) throw new Error("Fixture HTTPS requires its verified public CA.");
  return new Promise((resolve, reject) => {
    const request = (parsed.protocol === "https:" ? httpsRequest : httpRequest)(parsed, {
      method: data === undefined ? "GET" : "POST", ...(options.ca ? { ca: options.ca, rejectUnauthorized: true } : {}),
      headers: { Origin: parsed.origin, "Content-Type": "application/json", ...(data === undefined ? {} : { "Content-Length": Buffer.byteLength(data) }),
        ...(options.cookie ? { Cookie: options.cookie } : {}), ...(options.token ? { "X-GridLens-Wallet": options.token } : {}) }, timeout: 20_000
    }, response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2 * 1024 ** 2) request.destroy(new Error("Fixture response exceeded its bound.")); else chunks.push(chunk); });
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8"); let body: unknown;
        try { body = JSON.parse(text); } catch { body = text; }
        const cookie = response.headers["set-cookie"]?.[0];
        resolve({ status: response.statusCode ?? 0, body, text, ...(cookie ? { cookie } : {}) });
      });
    });
    request.on("timeout", () => request.destroy(new Error("Fixture HTTP request timed out."))); request.on("error", reject); request.end(data);
  });
}
const OWNER_PROOF = String.raw`
const fs=require('node:fs'),crypto=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('/ledger/ledger.sqlite',{readOnly:true});
try {
 db.function('fp',{deterministic:true},v=>{if(typeof v!=='string'||!v.length||v.length>90000)throw Error('Invalid fixture field');return crypto.createHash('sha256').update(v).digest('hex');});
 const row=db.prepare("SELECT fp(json_extract(value,'$.owner')) AS verifierDigest,fp(json_extract(value,'$.configuration')) AS configurationDigest,json_extract(value,'$.revision') AS revision,json_extract(value,'$.consumed') AS consumed,json_type(value,'$.operation')='null' AS noOperation FROM private_state WHERE key='treasury.v1'").get();
 if(!row||row.consumed!==0||row.noOperation!==1)throw Error('Unexpected fixture financial activity');
 const st=fs.lstatSync('/credentials/treasury-key-v1',{bigint:true});
 if(!st.isFile()||st.isSymbolicLink()||st.size!==32n||(st.mode&0o077n)!==0n)throw Error('Invalid fixture key metadata');
 process.stdout.write(JSON.stringify({verifierDigest:row.verifierDigest,configurationDigest:row.configurationDigest,revision:row.revision,keyMetadata:{inode:st.ino.toString(),size:Number(st.size),mode:Number(st.mode&0o777n),uid:Number(st.uid),gid:Number(st.gid),modifiedNs:st.mtimeNs.toString()}}));
}finally{db.close();}`;
/** Only an empty generated fixture receives an owner. Password/cookie/unlock
 * remain in this closure and are never returned or persisted in a report. */
export async function fixtureOwner(profile: FixtureProfile, fixture: Fixture, docker: FixtureDocker) {
  const plain = `http://${profile.address}:${fixture.webPort}`, secure = `https://${profile.address}:${fixture.httpsPort}`;
  const status = (await fixtureRequest(plain + "/api/shared/status")).body as { context: { addresses: unknown[] } };
  if (!Array.isArray(status?.context?.addresses) || status.context.addresses.length !== 0) throw new Error("Owner fixture is not an empty fleet.");
  const security = (await fixtureRequest(plain + "/secure-setup/status.json")).body as { instance: string; status: string; certificateSha256: string; httpsOrigin: string };
  const ca = (await fixtureRequest(plain + "/secure-setup/ca.crt")).text;
  if (security.instance !== fixture.instance || security.status !== "ready" || security.httpsOrigin !== secure
    || new X509Certificate(ca).fingerprint256.replaceAll(":", "").toLowerCase() !== security.certificateSha256) throw new Error("Fixture public HTTPS identity did not match.");
  const handoff = (await fixtureRequest(plain + "/secure-setup/connect-code", { body: {} })).body as { code: string };
  const connected = await fixtureRequest(secure + "/secure-setup/connect", { ca, body: { version: 1, code: handoff.code } });
  handoff.code = "";
  if (connected.status !== 200 || !connected.cookie?.startsWith("__Host-gridlens=")) throw new Error("Fixture HTTPS pairing failed.");
  let cookie = connected.cookie.split(";")[0]!, password = randomBytes(32).toString("base64url"), token = "";
  const destination = "11111111111111111111111111111119";
  const ticket = JSON.parse(await docker.exec(fixture, "owner", ["node", "scripts/shared-control.ts", "json"], JSON.stringify({ operation: "treasury-setup", scopeId: "default" }))) as { httpsOrigin: string; ticket: string };
  if (ticket.httpsOrigin !== secure || !/^[A-Za-z0-9_-]{43}$/.test(ticket.ticket)) throw new Error("Fixture owner ticket identity failed.");
  const setup = await fixtureRequest(secure + "/api/shared/treasury/setup", { ca, cookie, body: { version: 1, ticket: ticket.ticket, password, destinationAddress: destination } });
  ticket.ticket = "";
  const value = setup.body as { unlockToken: string; configuration: { hosts: unknown[]; destinationAddress: string; pilotConsumed: boolean } };
  if (setup.status !== 200 || !/^[A-Za-z0-9_-]{43}$/.test(value.unlockToken) || value.configuration.hosts.length || value.configuration.pilotConsumed || value.configuration.destinationAddress !== destination) throw new Error("Generated fixture owner setup failed.");
  token = value.unlockToken; value.unlockToken = "";
  const proof = JSON.parse(await docker.exec(fixture, "owner", ["node", "-e", OWNER_PROOF])) as unknown;
  return {
    async check(restarted: boolean): Promise<unknown> {
      const current = JSON.parse(await docker.exec(fixture, "owner", ["node", "-e", OWNER_PROOF])) as unknown;
      if (identity(current) !== identity(proof)) throw new Error("Generated owner, configuration or encryption metadata changed.");
      const previous = await fixtureRequest(secure + "/api/shared/treasury/configuration", { ca, cookie, token });
      if (restarted && previous.status !== 401) throw new Error("Old owner unlock survived replacement.");
      const response = await fixtureRequest(secure + "/api/shared/treasury/unlock", { ca, cookie, body: { version: 1, password } });
      const unlocked = response.body as typeof value;
      if (response.status !== 200 || !/^[A-Za-z0-9_-]{43}$/.test(unlocked.unlockToken) || unlocked.configuration.destinationAddress !== destination
        || unlocked.configuration.hosts.length || unlocked.configuration.pilotConsumed) throw new Error("Same generated password/configuration did not survive the upgrade.");
      token = unlocked.unlockToken; unlocked.unlockToken = "";
      const operations = await fixtureRequest(secure + "/api/shared/treasury/operations", { ca, cookie, token });
      if (operations.status !== 200 || (operations.body as { operations: unknown[] }).operations.length) throw new Error("Unexpected fixture financial operation.");
      const capabilities = (await fixtureRequest(plain + "/api/shared/status")).body as { capabilities: string[] };
      if (capabilities.capabilities.includes("treasury-claims-pilot-v1")) {
        const claims = await fixtureRequest(secure + "/api/shared/treasury/claims/status", { ca, cookie, token });
        const state = claims.body as { supported: boolean; state: string; attemptedHosts: unknown[]; eligibleHosts: unknown[]; unresolvedOperationId: unknown };
        const history = await fixtureRequest(secure + "/api/shared/treasury/claims/operations", { ca, cookie, token });
        if (claims.status !== 200 || !state.supported || state.state !== "ready" || state.attemptedHosts.length || state.eligibleHosts.length || state.unresolvedOperationId !== null
          || history.status !== 200 || (history.body as { total: number }).total !== 0) throw new Error("Unexpected fixture claim activity.");
      }
      return { sameGeneratedPasswordUnlocks: true, configuredOwnerPreserved: true, proof, financialPrepareOrConfirmRequests: 0, claimsRequested: 0 };
    },
    close(): void { password = ""; cookie = ""; token = ""; }
  };
}
