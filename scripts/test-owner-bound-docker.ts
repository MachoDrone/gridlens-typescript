/** Isolated candidate-image security acceptance. Only generated source keys,
 * independent fixture owners and uniquely labeled Docker resources are used. */
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { checked, localDockerRunner, resourceName } from "../src/installer/docker.ts";
import type { DockerRunner } from "../src/installer/docker.ts";
import { createAccess } from "../src/backend/access.ts";
import { openSharedState } from "../src/backend/sqlite-state.ts";
import { openTreasuryVault } from "../src/backend/treasury-vault.ts";
import { createTreasury } from "../src/backend/treasury.ts";
import type { TreasuryDriver, TreasuryQuote } from "../src/backend/treasury.ts";
import type { TreasuryPlan, TreasuryUnlock, TreasuryOperation } from "../src/contracts/treasury.ts";
import { openOwnerAuthority } from "../src/backend/owner-authority.ts";
import { createGuardianTransport } from "../src/backend/guardian-transport.ts";
import { GUARDIAN_CONTAINER, GUARDIAN_VOLUME } from "../src/backend/source-guardian.ts";
import type { GuardianEnrollment, GuardianRequest, GuardianReply } from "../src/backend/source-guardian.ts";
import type { ClaimsDispatchResult, ClaimsQuote } from "../src/backend/treasury-claims.ts";
import type { PcAssociation } from "../src/contracts/shared.ts";
import type { withSsh } from "../src/backend/ssh.ts";
import { transferAccounts, transferTransaction, validateSignedTransfer, TREASURY_NOS_MINT } from "../src/backend/treasury-transaction.ts";
import { ownerBoundSourceFixture, ownerBoundGuardianFixture, ownerBoundClaimFixture } from "../test/fixtures/owner-bound-docker.ts";
import { parseRelease } from "../src/installer/release.ts";
import { inspectSourceGuardian } from "../src/installer/source-guardian.ts";

export interface OwnerBoundDockerOptions { image: string; report?: string; instance?: string }
export function ownerBoundDockerOptions(args: readonly string[]): OwnerBoundDockerOptions {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!["--image", "--report", "--instance"].includes(key) || !value || values.has(key)) throw Error("Use unique owner-bound fixture options."); values.set(key, value);
  }
  const image = values.get("--image"), instance = values.get("--instance");
  if (!image || image.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9_./:@-]*$/.test(image)) throw Error("Supply an explicit candidate image.");
  if (instance !== undefined && !/^fixture-[a-f0-9]{12}$/.test(instance)) throw Error("Use a unique isolated fixture instance.");
  return { image, ...(instance ? { instance } : {}), ...(values.has("--report") ? { report: values.get("--report")! } : {}) };
}
/** Only fixed transport commands and read-only runtime inspection are accepted.
 * The fixture aliases names; it never changes image, command or isolation data. */
export function fixtureGuardianArguments(command: string, container: string, volume: string, imageId: string): string[] {
  if (!/^gridlens-modern-fixture-[a-f0-9]{12}-[a-z-]+$/.test(container) || !/^gridlens-modern-fixture-[a-f0-9]{12}-[a-z-]+$/.test(volume)
    || !/^sha256:[a-f0-9]{64}$/.test(imageId) || !command.startsWith("/usr/bin/docker ")) throw Error("Invalid fixture transport identity.");
  const remaining = command.slice("/usr/bin/docker ".length), parts: string[] = []; let at = 0;
  while (at < remaining.length) {
    if (/\s/.test(remaining[at]!)) { at++; continue; }
    if (remaining[at] === "'") { const end = remaining.indexOf("'", at + 1); if (end < 0) throw Error("Unexpected fixture command quoting."); parts.push(remaining.slice(at + 1, end)); at = end + 1; }
    else { const match = /^[A-Za-z0-9_./:@{}-]+/.exec(remaining.slice(at)); if (!match) throw Error("Unexpected fixture command syntax."); parts.push(match[0]); at += match[0].length; }
  }
  const status = ["exec", GUARDIAN_CONTAINER, "node", "/app/scripts/source-guardian.ts", "status"];
  const dispatch = ["exec", "-i", GUARDIAN_CONTAINER, "node", "/app/scripts/source-guardian.ts", "dispatch"];
  const inspect = parts.length === 3 && parts[1] === "inspect" && (parts[0] === "container" && [GUARDIAN_CONTAINER, container].includes(parts[2]!)
    || parts[0] === "volume" && [GUARDIAN_VOLUME, volume].includes(parts[2]!) || parts[0] === "image" && parts[2] === imageId);
  if (JSON.stringify(parts) !== JSON.stringify(status) && JSON.stringify(parts) !== JSON.stringify(dispatch) && !inspect) throw Error("Only the fixed guardian transport is allowed in this fixture.");
  return parts.map(value => value === GUARDIAN_CONTAINER ? container : value === GUARDIAN_VOLUME ? volume : value);
}

const digest = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
export async function runOwnerBoundDocker(options: OwnerBoundDockerOptions, runner: DockerRunner = localDockerRunner()): Promise<void> {
  options = ownerBoundDockerOptions(["--image", options.image, ...(options.instance ? ["--instance", options.instance] : []), ...(options.report ? ["--report", options.report] : [])]);
  const reportPath = options.report ? resolve(options.report) : undefined, project = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
  if (reportPath) {
    if (existsSync(reportPath)) throw Error("Keep prior acceptance evidence; use a new external report.");
    let ancestor = dirname(reportPath); while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    const actual = resolve(realpathSync(ancestor), relative(ancestor, reportPath));
    if (!statSync(ancestor).isDirectory() || actual === project || actual.startsWith(project + sep)) throw Error("Keep acceptance evidence outside the checkout.");
  }
  const inspected = JSON.parse(checked(runner, ["image", "inspect", options.image]));
  if (!Array.isArray(inspected) || inspected.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(inspected[0]?.Id)
    || inspected[0]?.Config?.Labels?.["io.gridlens.product"] !== "shared-backend" || inspected[0].Config.Labels["io.gridlens.financial-security-protocol"] !== "1"
    || inspected[0].Config.Labels["io.gridlens.guardian-protocol"] !== "1" || !["1", "2"].includes(String(inspected[0].Config.Labels["io.gridlens.treasury-protocol"]))) throw Error("Candidate is not the immutable owner-bound GridLens image.");
  const imageId: string = inspected[0].Id, version: string = inspected[0].Config.Labels["io.gridlens.version"];
  const instance = options.instance ?? `fixture-${randomBytes(6).toString("hex")}`, sourceName = resourceName(instance, "source"), sourceVolume = resourceName(instance, "source-wallet");
  const guardianName = resourceName(instance, "guardian"), guardianVolume = resourceName(instance, "guardian-state"), claimName = resourceName(instance, "claim-guardian"), claimVolume = resourceName(instance, "claim-state");
  const sourceTag = `nosana/nosana-node:${instance}`, root = mkdtempSync(join(tmpdir(), "gridlens-owner-bound-"));
  const created: { kind: "container" | "volume"; name: string; product: string; id?: string }[] = [], cleanupErrors: string[] = [];
  let tagged = false, failure: unknown;
  const evidence: Record<string, unknown> = { fixture: "gridlens-owner-bound-docker-v1", instance, candidateImageId: imageId, candidateVersion: version,
    existingWalletKeyReads: 0, existingWalletKeyAccess: false, liveApiRequests: 0, actualChainSubmissions: 0, guardianDockerSocket: true, ownerDockerSocket: false,
    network: "none", sourceKeys: "generated only inside the disposable source wallet volume", stages: [] };
  const flags = ["--read-only", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "128", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m"];
  const ownLabels = (product: string, role: string) => ["--label", `io.gridlens.product=${product}`, "--label", `io.gridlens.instance=${instance}`, "--label", `io.gridlens.role=${role}`];
  function inspect(kind: "container" | "volume", name: string, product: string, absent = false): Record<string, any> | undefined {
    const result = runner.run([kind, "inspect", name]);
    if (result.status !== 0) { if (absent && /No such (?:container|volume|object)|not found/i.test(result.stderr)) return undefined; throw Error("Fixture ownership inspection failed."); }
    const rows = JSON.parse(result.stdout), row = rows?.[0], labels = kind === "container" ? row?.Config?.Labels : row?.Labels;
    if (!Array.isArray(rows) || rows.length !== 1 || labels?.["io.gridlens.instance"] !== instance || labels?.["io.gridlens.product"] !== product
      || String(row.Name).replace(/^\//, "") !== name) throw Error("Fixture ownership changed; resource retained.");
    const known = created.find(item => item.kind === kind && item.name === name);
    if (known?.id && row.Id !== known.id) throw Error("Fixture container identity changed.");
    return row;
  }
  const exec = (name: string, product: string, args: string[], input?: string) => { inspect("container", name, product); return checked(runner, ["exec", ...(input === undefined ? [] : ["-i"]), name, ...args], input); };
  const volume = (name: string, product: string, extra: string[] = []) => {
    if (inspect("volume", name, product, true)) throw Error("Fixture volume already exists.");
    created.push({ kind: "volume", name, product }); checked(runner, ["volume", "create", ...ownLabels(product, "fixture-state"), ...extra, name]); inspect("volume", name, product);
  };
  const container = (name: string, product: string, args: string[]) => {
    if (inspect("container", name, product, true)) throw Error("Fixture container already exists.");
    const tracked: (typeof created)[number] = { kind: "container", name, product }; created.push(tracked);
    const id = checked(runner, ["run", "--detach", "--name", name, ...args]);
    if (!/^[a-f0-9]{64}$/.test(id)) throw Error("Fixture start identity is invalid.");
    tracked.id = id; const row = inspect("container", name, product)!;
    assert.equal(row.Image, imageId); assert.equal(row.HostConfig.NetworkMode, "none"); assert.equal(row.HostConfig.ReadonlyRootfs, true); assert.equal(row.HostConfig.Privileged, false);
    assert.notEqual(row.HostConfig.PidMode, "host"); return id;
  };
  const temporary = (suffix: string, product: string, args: string[], input?: string) => {
    const name = resourceName(instance, suffix);
    if (inspect("container", name, product, true)) throw Error("Fixture helper name already exists.");
    created.push({ kind: "container", name, product });
    return checked(runner, ["run", "--rm", "--name", name, ...args], input);
  };
  const ready = async (name: string, product: string, path: string) => {
    for (let attempt = 0; attempt < 50; attempt++) {
      inspect("container", name, product); const result = runner.run(["exec", name, "node", "-e", `require('node:fs').accessSync(${JSON.stringify(path)})`]);
      if (result.status === 0) return;
      await new Promise(done => setTimeout(done, 100));
    } throw Error("Isolated fixture did not become ready.");
  };
  const authorities: ReturnType<typeof openOwnerAuthority>[] = [];
  const owners: { treasury: ReturnType<typeof createTreasury>; vault: ReturnType<typeof openTreasuryVault>; state: ReturnType<typeof openSharedState> }[] = [];
  try {
    authorities.push(openOwnerAuthority(join(root, "owner-a-authority"), { create: true }));
    authorities.push(openOwnerAuthority(join(root, "owner-b-authority"), { create: true }));
    const tagState = runner.run(["image", "inspect", sourceTag]);
    if (tagState.status === 0 || !/No such (?:image|object)/i.test(tagState.stderr)) throw Error("Fixture image alias already exists or cannot be inspected.");
    assert(Array.isArray(inspected[0].RepoTags) && inspected[0].RepoTags.some((tag: unknown) => typeof tag === "string" && tag !== sourceTag), "Candidate needs an existing non-fixture image tag for safe alias cleanup");
    tagged = true; checked(runner, ["tag", imageId, sourceTag]);
    volume(sourceVolume, "shared-backend");
    temporary("source-init", "shared-backend", [...ownLabels("shared-backend", "fixture-initialize"), ...flags, "--user", "0:0", "--cap-add", "CHOWN", "--cap-add", "FOWNER",
      "--mount", `type=volume,src=${sourceVolume},dst=/fixture`, imageId, "node", "-e", 'const fs=require("node:fs");if(fs.readdirSync("/fixture").length)throw Error("Nonempty fixture volume");fs.chownSync("/fixture",1000,1000);fs.chmodSync("/fixture",0o700);']);
    const sourceId = container(sourceName, "shared-backend", [...ownLabels("shared-backend", "fixture-source"), ...flags, "--user", "1000:1000", "--ulimit", "core=0:0",
      "--mount", `type=volume,src=${sourceVolume},dst=/home/node/.nosana`, sourceTag, "node", "--input-type=module", "-e", `(${ownerBoundSourceFixture.toString()})(JSON.parse(process.argv[1])).catch(()=>{process.exitCode=1});`, JSON.stringify({ instance })]);
    await ready(sourceName, "shared-backend", "/home/node/.nosana/fixture-ready");
    const source = JSON.parse(exec(sourceName, "shared-backend", ["node", "-e", 'process.stdout.write(require("node:fs").readFileSync("/home/node/.nosana/fixture-public.json","utf8"))']));
    assert.equal(source.instance, instance);
    assert.equal(source.build.version, version);
    const release = parseRelease({ format: "gridlens-modern-release-v1", version, sequence: source.build.sequence,
      platform: inspected[0].Architecture === "arm64" ? "linux-arm64" : "linux-x64", minimumCoordinator: 3, imageId,
      runtime: { name: "gridlens-runtime-generated-guardian.tar", bytes: 1, sha256: digest("generated metadata-only guardian identity") } });
    const releaseKeys = generateKeyPairSync("ed25519"), manifest = Buffer.from(JSON.stringify(release));
    const releaseIdentity = { release, manifest, signature: sign(null, manifest, releaseKeys.privateKey), trustPublicKey: releaseKeys.publicKey.export({ type: "spki", format: "pem" }).toString() };
    const at = Date.now(), pcId = digest(instance), association: PcAssociation = { address: source.sourceAddress, name: "Generated source", binding: { pcId, runtime: "docker", wrapperId: null, nodeContainerId: sourceId },
      sshFingerprint: "SHA256:" + "A".repeat(43), verifiedAtMs: at, privateIp: null, gpuUuids: [] };
    const enrollment: GuardianEnrollment = { ...authorities[0]!.descriptor, pcId, policyEpoch: 1, destinationAddress: source.destinationAddress, transferConsumed: false, claimedSources: [], sources: [association] };
    const guardianLabels = (role: string) => [...ownLabels("financial-guardian", role), "--label", "io.gridlens.guardian-protocol=1", "--label", `io.gridlens.guardian-owner=${enrollment.authorityId}`, "--label", `io.gridlens.guardian-pc=${pcId}`];
    volume(guardianVolume, "financial-guardian", guardianLabels("fixture-guardian-state"));
    temporary("guardian-provision", "financial-guardian", ["--interactive", ...guardianLabels("fixture-provision"), ...flags, "--user", "0:0", "--mount", `type=volume,src=${guardianVolume},dst=/guardian`, imageId, "node", "/app/scripts/source-guardian.ts", "provision"], JSON.stringify(enrollment));
    container(guardianName, "financial-guardian", [...guardianLabels("fixture-guardian"), ...flags, "--user", "0:0", "--restart", "unless-stopped", "--stop-timeout", "90", "--stop-signal", "SIGTERM",
      "--mount", `type=volume,src=${guardianVolume},dst=/guardian`, "--mount", "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock", imageId, "node", "/app/scripts/source-guardian.ts", "serve"]);
    await ready(guardianName, "financial-guardian", "/tmp/guardian.sock");
    const pinHash = () => exec(guardianName, "financial-guardian", ["node", "-e", 'const fs=require("node:fs"),c=require("node:crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync("/guardian/owner-pin.json")).digest("hex"))']);
    const originalPin = pinHash();
    const target = { computer: { id: pcId, host: "10.0.0.2", port: 22, name: "Generated source", fingerprint: association.sshFingerprint, hostKey: "generated" }, credential: { username: "generated", password: "unused-generated-fixture-password" } };
    let firstTransferEnvelope: unknown;
    const connect: typeof withSsh = async (computer, _credential, work) => {
      assert.equal(computer.id, pcId);
      return work(async (command, settings) => {
        inspect("container", guardianName, "financial-guardian"); inspect("container", sourceName, "shared-backend");
        const args = fixtureGuardianArguments(command, guardianName, guardianVolume, imageId);
        if (args.at(-1) === "dispatch" && settings?.input) { const envelope = JSON.parse(String(settings.input)); if (envelope.body?.action?.kind === "transfer" && !firstTransferEnvelope) firstTransferEnvelope = envelope; }
        const result = runner.run(args, settings?.input);
        return { code: result.status, stdout: result.stdout };
      });
    };
    const transports = authorities.map(authority => createGuardianTransport({ authority, connect,
      verifyTarget: async (run, target) => { await inspectSourceGuardian(run, { authorityId: authority.descriptor.authorityId, pcId: target.computer.id }, releaseIdentity, { containerName: guardianName, volumeName: guardianVolume }); } }));
    const quote = async (context: { scopeId: string; rosterRevision: string }, destination = source.destinationAddress): Promise<TreasuryQuote> => {
      const preparedAtMs = Date.now();
      const value: TreasuryQuote = { scopeId: context.scopeId, rosterRevision: context.rosterRevision, sourceAddress: source.sourceAddress, destinationAddress: destination, ...await transferAccounts(source.sourceAddress, destination),
        mintAddress: TREASURY_NOS_MINT, amountBaseUnits: "1000000", decimals: 6, feeLamports: "5000", rentLamports: "0", reserveLamports: "50000000", maxCostLamports: "5000000",
        preparedAtMs, expiresAtMs: preparedAtMs + 60_000, createDestinationAta: false, sourceNosBaseUnits: "9000000", sourceSolLamports: "100000000",
        sourceBinding: { pcId, nodeId: digest("generated node"), containerId: sourceId, sshIdentity: association.sshFingerprint }, blockhash: source.wrongDestination, lastValidBlockHeight: 1000, messageBase64: "" };
      value.messageBase64 = Buffer.from((await transferTransaction(value)).messageBytes).toString("base64"); return value;
    };
    let transferQuote!: TreasuryQuote, signature = "", simulatedSubmissions = 0;
    async function owner(index: number) {
      const directory = join(root, `owner-${index}`); mkdirSync(directory, { mode: 0o700 });
      const state = openSharedState(join(directory, "state")), credentials = join(directory, "credentials"); mkdirSync(credentials, { mode: 0o700 });
      const vault = openTreasuryVault(credentials, { create: true }), access = createAccess(state, Date.now, { protectedMode: true }), context = access.setFleet(`fixture-owner-${index}`, [source.sourceAddress]);
      const browser = access.pair(access.createCode(context.scopeId, "viewer").code, "Generated owner browser");
      const transport = transports[index]!, security = { httpsOrigin: `https://127.0.0.1:${25961 + index}`, serverCertificateSha256: String(index + 1).repeat(64) };
      const driver: TreasuryDriver = {
        async prepare(scope, _source, destination) { await transport.prepare(target, source.sourceAddress, destination); return quote(scope, destination); },
        assertReady(value) { transport.assertReady(target, value); },
        async sign(value, authorize, id) { assert.equal(index, 0); assert(id); const signed = await transport.transfer(target, value, id, authorize!); transferQuote = value; signature = signed.signature; return { quote: value, ...signed }; },
        async submit(signed, authorize) { authorize?.(); await validateSignedTransfer(signed.quote, signed.transactionBase64, signed.signature); simulatedSubmissions++; },
        async reconcile() { return { status: "confirmed", observedAtMs: Date.now(), slot: 42 }; },
      };
      const treasury = createTreasury(state, { access, vault, driver, security: () => security, protectedMode: true,
        guardianStatus: () => ({ required: true, state: "ready", authorityId: authorities[index]!.descriptor.authorityId }) });
      owners.push({ treasury, state, vault });
      const request = (operation: string, input: Record<string, unknown> = {}) => treasury.dispatch({ operation, token: browser.token, ...security, ...input });
      const password = `Generated independent owner ${index} ${randomBytes(16).toString("hex")}`;
      const ticket = treasury.control({ operation: "treasury-setup", scopeId: context.scopeId }) as { ticket: string };
      let unlock = await request("setup", { ticket: ticket.ticket, password, destinationAddress: source.destinationAddress }) as TreasuryUnlock;
      return { context, request, treasury, password, get unlock() { return unlock; }, async reset() {
        const ticket = treasury.control({ operation: "treasury-reset", scopeId: context.scopeId }) as { ticket: string };
        unlock = await request("setup", { ticket: ticket.ticket, password, destinationAddress: source.destinationAddress }) as TreasuryUnlock;
      } };
    }
    const ownerA = await owner(0), ownerB = await owner(1);
    assert.notEqual(authorities[0]!.descriptor.authorityId, authorities[1]!.descriptor.authorityId); assert.notEqual(ownerA.password, ownerB.password);
    const foreign = await ownerB.request("prepare", { unlockToken: ownerB.unlock.unlockToken, sourceAddress: source.sourceAddress }) as { kind?: string };
    assert.equal(foreign.kind, "preflight-failure");
    const raw = (name: string, body: unknown) => JSON.parse(exec(name, "financial-guardian", ["node", "/app/scripts/source-guardian.ts", "dispatch"], JSON.stringify(body))) as GuardianReply & { error?: string };
    const request = (action: GuardianRequest["action"], id = randomUUID()): GuardianRequest => {
      const issuedAtMs = Date.now();
      return { version: 1, operationId: id, pcId, scopeId: ownerA.context.scopeId, rosterRevision: ownerA.context.rosterRevision, issuedAtMs,
        expiresAtMs: Math.min(issuedAtMs + 60_000, action.kind === "transfer" || action.kind === "claim" ? action.quote.expiresAtMs : Number.MAX_SAFE_INTEGER), action };
    };
    const validQuote = await quote(ownerA.context);
    assert.equal(raw(guardianName, authorities[1]!.sign(request({ kind: "transfer", policyEpoch: 1, quote: validQuote }))).error, "owner-mismatch");
    const wrong = await quote(ownerA.context, source.wrongDestination);
    assert.equal(raw(guardianName, authorities[0]!.sign(request({ kind: "transfer", policyEpoch: 1, quote: wrong }))).error, "spent");
    const plan = await ownerA.request("prepare", { unlockToken: ownerA.unlock.unlockToken, sourceAddress: source.sourceAddress }) as TreasuryPlan;
    assert(plan.planId);
    const accepted = await ownerA.request("confirm", { unlockToken: ownerA.unlock.unlockToken, planId: plan.planId, reviewDigest: plan.reviewDigest, idempotencyKey: "generated-owner-bound-transfer" }) as { operation: TreasuryOperation };
    await ownerA.treasury.waitForIdle();
    const completed = await ownerA.request("operations", { unlockToken: ownerA.unlock.unlockToken, id: accepted.operation.id }) as { operation: TreasuryOperation };
    assert.equal(completed.operation.phase, "confirmed"); assert.equal(completed.operation.amountBaseUnits, "1000000"); assert.equal(completed.operation.signature, signature);
    assert(firstTransferEnvelope); const replay = raw(guardianName, firstTransferEnvelope); assert.equal((replay.result as { signature: string }).signature, signature);
    const originalBody = (firstTransferEnvelope as { body: GuardianRequest }).body;
    assert.equal(raw(guardianName, authorities[0]!.sign({ ...originalBody, action: { ...originalBody.action, policyEpoch: 2 } })).error, "invalid");
    await assert.rejects(transports[0]!.transfer(target, transferQuote, randomUUID(), () => {}));
    await ownerA.reset(); await assert.rejects(ownerA.request("prepare", { unlockToken: ownerA.unlock.unlockToken, sourceAddress: source.sourceAddress }));
    const resetHistory = await ownerA.request("operations", { unlockToken: ownerA.unlock.unlockToken, id: accepted.operation.id }) as { operation: TreasuryOperation };
    assert.equal(resetHistory.operation.signature, signature); assert.equal(resetHistory.operation.id, accepted.operation.id);
    inspect("container", guardianName, "financial-guardian"); checked(runner, ["stop", "--time", "90", guardianName]); checked(runner, ["start", guardianName]);
    await ready(guardianName, "financial-guardian", "/tmp/guardian.sock"); assert.equal(pinHash(), originalPin);
    const status = await transports[0]!.status(target); assert.equal(status.transferConsumed, true);
    inspect("container", guardianName, "financial-guardian"); const deniedReset = runner.run(["exec", "-i", guardianName, "node", "/app/scripts/source-guardian.ts", "provision"], JSON.stringify({ ...enrollment, transferConsumed: false }));
    assert.notEqual(deniedReset.status, 0); assert.equal(pinHash(), originalPin); assert.equal(simulatedSubmissions, 1);
    (evidence.stages as unknown[]).push({ scope: "production-guardian-serve-and-transport", independentOwnerSetups: 2, foreignOwnerRejected: true,
      wrongDestinationRejected: true, exactOneNosSignatureVerified: true, replayUsedSavedResponse: true, newOperationAfterSpentRejected: true,
      ownerPasswordResetPreservedSpent: true, guardianRestartPreservedPinAndSpent: true, guardianReinitializationRejected: true, simulatedSubmissions });

    // Separate labeled injected-executor container: real crypto, journal and IPC;
    // no production runtime-inspector bypass or spoofed Cmd metadata.
    volume(claimVolume, "financial-guardian", guardianLabels("fixture-claim-state"));
    temporary("claim-provision", "financial-guardian", ["--interactive", ...guardianLabels("fixture-claim-provision"), ...flags, "--user", "0:0", "--mount", `type=volume,src=${claimVolume},dst=/guardian`, imageId,
      "node", "/app/scripts/source-guardian.ts", "provision"], JSON.stringify({ ...enrollment, transferConsumed: true }));
    container(claimName, "financial-guardian", [...guardianLabels("fixture-claim-guardian"), ...flags, "--user", "0:0", "--stop-timeout", "90",
      "--mount", `type=volume,src=${claimVolume},dst=/guardian`, "--mount", "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock", imageId,
      "node", "--input-type=module", "-e", `(${ownerBoundGuardianFixture.toString()})(JSON.parse(process.argv[1])).catch(()=>{process.exitCode=1});`,
      JSON.stringify({ instance, sourceContainerId: sourceId, nowMs: at, claimProgram: `(${ownerBoundClaimFixture.toString()})(process.argv[1]).catch(()=>{process.exitCode=1});` })]);
    await ready(claimName, "financial-guardian", "/tmp/guardian.sock");
    const claimAt = Date.now();
    const claimQuote: ClaimsQuote = { scopeId: ownerA.context.scopeId, rosterRevision: ownerA.context.rosterRevision, sourceAddress: source.sourceAddress,
      sourceBinding: validQuote.sourceBinding, sourceTokenAddress: validQuote.sourceTokenAddress, mintAddress: TREASURY_NOS_MINT, decimals: 6,
      lastReportedAmountBaseUnits: "2345678", checkedAtMs: claimAt, expiresAtMs: claimAt + 60_000 };
    const claimRequest = request({ kind: "claim", policyEpoch: 1, quote: claimQuote });
    const firstAck = raw(claimName, authorities[0]!.sign(claimRequest)); assert.equal(firstAck.state, "complete");
    // Discard the client result, then obtain it only through a signed journal read.
    inspect("container", claimName, "financial-guardian"); checked(runner, ["stop", "--time", "90", claimName]); checked(runner, ["start", claimName]); await ready(claimName, "financial-guardian", "/tmp/guardian.sock");
    const recovered = raw(claimName, authorities[0]!.sign(request({ kind: "operation-status", operationId: claimRequest.operationId, operationKind: "claim", sourceAddress: source.sourceAddress })));
    assert.deepEqual(recovered, firstAck); assert.equal((recovered.result as ClaimsDispatchResult).claimedAmountAtoms, "2345678");
    assert.equal(raw(claimName, authorities[0]!.sign(request(claimRequest.action))).error, "spent");
    assert.equal(raw(claimName, authorities[1]!.sign(request({ kind: "operation-status", operationId: claimRequest.operationId, operationKind: "claim", sourceAddress: source.sourceAddress }))).error, "owner-mismatch");
    const counts = JSON.parse(exec(claimName, "financial-guardian", ["node", "-e", 'process.stdout.write(require("node:fs").readFileSync("/guardian/fixture-counters.json","utf8"))']));
    const posts = JSON.parse(exec(sourceName, "shared-backend", ["node", "-e", 'process.stdout.write(require("node:fs").readFileSync("/home/node/.nosana/fixture-claims.json","utf8"))']));
    assert.equal(counts.claimHelpers, 1); assert.equal(posts.posts, 1); assert.equal(posts.authorizationVerified, true);
    (evidence.stages as unknown[]).push({ scope: "injected-executor-guardian-with-real-signed-IPC-and-source-claim-helper", productionInspectorBypassed: false,
      acknowledgementRecoveredAfterRestart: true, repeatedClaimRejected: true, foreignJournalReadRejected: true, claimHelpers: 1, generatedHttpsPosts: 1,
      generatedSourceAuthorizationVerified: true, externalHttpsRequests: 0 });
    Object.assign(evidence, { ownerTransferValidated: true, foreignOwnerRejected: true, replayRejected: true, historyPreserved: true, claimAckRecovered: true,
      replayScope: "Changed request under an existing operation ID is rejected; identical request returns only its stored response" });
    evidence.viewerContainer = { checked: false, reason: "Viewer TLS/permissions and installer isolation have separate focused fixtures; this harness exercises the source guardian boundary." };
    evidence.passed = true;
  } catch (error) { failure = error; evidence.passed = false; evidence.failure = error instanceof Error ? error.message : "Owner-bound fixture failed."; }
  finally {
    for (const owner of owners) { try { await owner.treasury.close(); owner.vault.close(); await owner.state.close(); } catch (error) { cleanupErrors.push(error instanceof Error ? error.message : "Generated owner cleanup failed."); } }
    for (const authority of authorities) authority.close();
    for (const item of [...created].reverse()) {
      try { if (inspect(item.kind, item.name, item.product, true)) { if (item.kind === "container") { checked(runner, ["stop", "--time", "90", item.name]); checked(runner, ["rm", item.name]); }
        else checked(runner, ["volume", "rm", item.name]); } }
      catch (error) { cleanupErrors.push(error instanceof Error ? error.message : "Owned Docker cleanup failed."); }
    }
    if (tagged) try { const values = JSON.parse(checked(runner, ["image", "inspect", sourceTag])); if (values?.[0]?.Id !== imageId || !Array.isArray(values[0].RepoTags) || !values[0].RepoTags.some((tag: unknown) => typeof tag === "string" && tag !== sourceTag)) throw Error("Fixture image alias or candidate retention changed; retained."); checked(runner, ["image", "rm", sourceTag]); }
    catch (error) { cleanupErrors.push(error instanceof Error ? error.message : "Fixture alias cleanup failed."); }
    rmSync(root, { recursive: true, force: true });
  }
  evidence.cleanupErrors = cleanupErrors; evidence.cleanupVerified = cleanupErrors.length === 0; evidence.completedAt = new Date().toISOString();
  if (reportPath) { mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 }); writeFileSync(reportPath, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600, flag: "wx" }); }
  if (failure) throw failure; if (cleanupErrors.length) throw Error("Owner-bound fixture passed but cleanup requires review.");
  console.log(JSON.stringify({ passed: true, instance, candidateImageId: imageId, cleanupVerified: true, liveApiRequests: 0, existingWalletKeyReads: 0 }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runOwnerBoundDocker(ownerBoundDockerOptions(process.argv.slice(2)));
