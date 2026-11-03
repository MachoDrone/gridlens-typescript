import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import { getBase58Decoder } from "@solana/kit";
import { openOwnerAuthority, verifyOwnerRequest } from "../src/backend/owner-authority.ts";
import { initializeSourceGuardian, openSourceGuardian, parseGuardianStatus } from "../src/backend/source-guardian.ts";
import type { GuardianAction, GuardianEnrollment, GuardianExecutor, GuardianRequest } from "../src/backend/source-guardian.ts";
import { createGuardianTransport } from "../src/backend/guardian-transport.ts";
import { signPilotTransfer } from "../src/backend/treasury-signing.ts";
import { transferAccounts, transferTransaction, TREASURY_NOS_MINT } from "../src/backend/treasury-transaction.ts";
import type { TreasuryQuote } from "../src/backend/treasury.ts";
import { ClaimsNotDispatchedError } from "../src/backend/treasury-claims.ts";
import type { ClaimsDispatchResult, ClaimsQuote } from "../src/backend/treasury-claims.ts";
import type { PcAssociation } from "../src/contracts/shared.ts";
import type { withSsh } from "../src/backend/ssh.ts";
import { startSourceGuardianServer } from "../scripts/source-guardian.ts";

const base = 1_800_000_000_000;
const publicAddress = (key: ReturnType<typeof generateKeyPairSync>) => getBase58Decoder().decode(key.publicKey.export({ format: "der", type: "spki" }).subarray(-32));
async function fixture(options: { transferConsumed?: boolean; importedClaim?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gridlens-owner-guardian-")), authorityDirectory = join(root, "owner"), directory = join(root, "guardian");
  const authority = openOwnerAuthority(authorityDirectory, { create: true }), foreign = openOwnerAuthority(join(root, "foreign"), { create: true });
  const key = generateKeyPairSync("ed25519"), other = generateKeyPairSync("ed25519"), receiver = generateKeyPairSync("ed25519");
  const sourceAddress = publicAddress(key), secondAddress = publicAddress(other), destinationAddress = publicAddress(receiver), pcId = "a".repeat(64);
  const association = (address: string, containerId: string): PcAssociation => ({ address, name: "Generated host", binding: { pcId, runtime: "docker", wrapperId: null, nodeContainerId: containerId },
    sshFingerprint: `SHA256:${"A".repeat(43)}`, verifiedAtMs: base, privateIp: "10.0.0.2", gpuUuids: [] });
  const sources = [association(sourceAddress, "b".repeat(64)), association(secondAddress, "c".repeat(64))];
  const enrollment: GuardianEnrollment = { ...authority.descriptor, pcId, policyEpoch: 1, destinationAddress, transferConsumed: options.transferConsumed ?? false,
    claimedSources: options.importedClaim ? [sourceAddress] : [], sources };
  initializeSourceGuardian(directory, enrollment);
  const accounts = await transferAccounts(sourceAddress, destinationAddress);
  const quote: TreasuryQuote = { scopeId: "generated-fleet", rosterRevision: "one", sourceAddress, destinationAddress, ...accounts,
    mintAddress: TREASURY_NOS_MINT, amountBaseUnits: "1000000", decimals: 6, feeLamports: "5000", rentLamports: "0", reserveLamports: "50000000", maxCostLamports: "5000000",
    preparedAtMs: base, expiresAtMs: base + 60_000, createDestinationAta: false, sourceNosBaseUnits: "9000000", sourceSolLamports: "100000000",
    sourceBinding: { pcId, nodeId: "d".repeat(64), containerId: sources[0]!.binding.nodeContainerId, sshIdentity: sources[0]!.sshFingerprint },
    blockhash: destinationAddress, lastValidBlockHeight: 1234, messageBase64: "" };
  quote.messageBase64 = Buffer.from((await transferTransaction(quote)).messageBytes).toString("base64");
  const claimQuote = (source = sources[0]!): ClaimsQuote => ({ scopeId: quote.scopeId, rosterRevision: quote.rosterRevision, sourceAddress: source.address,
    sourceBinding: { ...quote.sourceBinding, containerId: source.binding.nodeContainerId }, sourceTokenAddress: accounts.sourceTokenAddress,
    mintAddress: TREASURY_NOS_MINT, decimals: 6, lastReportedAmountBaseUnits: "2345678", checkedAtMs: base, expiresAtMs: base + 60_000 });
  const signature = getBase58Decoder().decode(sign(null, Buffer.from("generated receipt"), other.privateKey));
  const ack: ClaimsDispatchResult = { status: "acknowledged", success: true, amountUnit: "base-units", claimedAmountAtoms: "2345678", signature, observedAtMs: base };
  let time = base, transfers = 0, claims = 0, claimHook: (() => Promise<void>) | undefined;
  const executor: GuardianExecutor = {
    async transfer(_source, value, guard) { guard(); transfers++; return signPilotTransfer(value, work => work(key.privateKey)); },
    async claim(_source, _value, guard) { guard(); claims++; await claimHook?.(); return ack; },
  };
  let guardian = openSourceGuardian(directory, { now: () => time, executor });
  const request = (action: GuardianAction, operationId = randomUUID()): GuardianRequest => ({ version: 1, operationId, pcId,
    scopeId: quote.scopeId, rosterRevision: quote.rosterRevision, issuedAtMs: time, expiresAtMs: Math.min(time + 30_000, quote.expiresAtMs), action });
  return { root, authorityDirectory, directory, authority, foreign, enrollment, quote, claimQuote, sourceAddress, secondAddress, destinationAddress, sources, ack, executor, now: () => time,
    get guardian() { return guardian; }, request, counts: () => ({ transfers, claims }), at: (value: number) => { time = value; },
    hook: (value: () => Promise<void>) => { claimHook = value; },
    reopen() { guardian.close(); guardian = openSourceGuardian(directory, { now: () => time, executor }); },
    close() { guardian.close(); authority.close(); foreign.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("source guardian rejects a second installation's own authority and unsigned destination substitution", async () => {
  const f = await fixture();
  try {
    const body = f.request({ kind: "transfer", policyEpoch: 1, quote: f.quote });
    await assert.rejects(f.guardian.dispatch(f.foreign.sign(body)), /owner-mismatch/);
    const tampered = f.authority.sign(body); (tampered.body as GuardianRequest).scopeId = "different-fleet";
    await assert.rejects(f.guardian.dispatch(tampered), /owner-mismatch/);
    await assert.rejects(f.guardian.dispatch(f.authority.sign({ ...body, helper: "arbitrary code is forbidden" })), /owner-mismatch/);
    assert.deepEqual(f.counts(), { transfers: 0, claims: 0 });
    assert.equal(f.guardian.status().transferConsumed, false);
  } finally { f.close(); }
});

test("one authorized exact transfer is durably reserved, replayed only as its saved response, and never replenished", async () => {
  const f = await fixture();
  try {
    const body = f.request({ kind: "transfer", policyEpoch: 1, quote: f.quote }), envelope = f.authority.sign(body);
    const result = await f.guardian.dispatch(envelope);
    assert.equal(result.state, "complete"); assert.equal(f.guardian.status().transferConsumed, true);
    f.reopen(); assert.deepEqual(await f.guardian.dispatch(envelope), result);
    await assert.rejects(f.guardian.dispatch(f.authority.sign(f.request(body.action))), /spent/);
    await f.guardian.dispatch(f.authority.sign(f.request({ kind: "set-policy", policyEpoch: 1, destinationAddress: f.secondAddress, transferConsumed: false })));
    assert.equal(f.guardian.status().transferConsumed, true);
    assert.deepEqual(f.counts(), { transfers: 1, claims: 0 });
  } finally { f.close(); }
});

test("wrong recipient, amount, source binding and expired owner approvals cannot reach a signer", async () => {
  const f = await fixture();
  try {
    const changed = { ...f.quote, destinationAddress: f.secondAddress, ...await transferAccounts(f.sourceAddress, f.secondAddress) };
    changed.messageBase64 = Buffer.from((await transferTransaction(changed)).messageBytes).toString("base64");
    await assert.rejects(f.guardian.dispatch(f.authority.sign(f.request({ kind: "transfer", policyEpoch: 1, quote: changed }))), /spent/);
    for (const quote of [{ ...f.quote, amountBaseUnits: "2000000" }, { ...f.quote, sourceBinding: { ...f.quote.sourceBinding, containerId: "e".repeat(64) } }])
      await assert.rejects(f.guardian.dispatch(f.authority.sign(f.request({ kind: "transfer", policyEpoch: 1, quote: quote as TreasuryQuote }))));
    const expired = f.request({ kind: "transfer", policyEpoch: 1, quote: f.quote }); expired.issuedAtMs = base - 1000; expired.expiresAtMs = base - 1;
    await assert.rejects(f.guardian.dispatch(f.authority.sign(expired)), /invalid/);
    const wrongAta = { ...f.claimQuote(), sourceTokenAddress: f.quote.destinationTokenAddress };
    await assert.rejects(f.guardian.dispatch(f.authority.sign(f.request({ kind: "claim", policyEpoch: 1, quote: wrongAta }))), /invalid/);
    assert.deepEqual(f.counts(), { transfers: 0, claims: 0 }); assert.equal(f.guardian.status().transferConsumed, false);
  } finally { f.close(); }
});

test("migration imports the consumed central pilot and claims without touching the old ledger or creating per-guardian budgets", async () => {
  const f = await fixture({ transferConsumed: true, importedClaim: true });
  try {
    await assert.rejects(f.guardian.dispatch(f.authority.sign(f.request({ kind: "transfer", policyEpoch: 1, quote: f.quote }))), /spent/);
    await assert.rejects(f.guardian.dispatch(f.authority.sign(f.request({ kind: "claim", policyEpoch: 1, quote: f.claimQuote() }))), /spent/);
    assert.throws(() => initializeSourceGuardian(f.directory, { ...f.enrollment, transferConsumed: false, claimedSources: [] }), /recovery-required/);
    assert.deepEqual(f.counts(), { transfers: 0, claims: 0 });
  } finally { f.close(); }
});

test("owner-signed policy rebind retains historical claims across source removal, re-addition and process restart", async () => {
  const f = await fixture({ importedClaim: true });
  try {
    const pin = readFileSync(join(f.directory, "owner-pin.json"));
    await f.guardian.dispatch(f.authority.sign(f.request({ kind: "set-policy", policyEpoch: 1, destinationAddress: f.destinationAddress, sources: [f.sources[1]!], claimedSources: [] })));
    assert.deepEqual(f.guardian.status().claimedSources, [f.sourceAddress]);
    const rebound = { ...f.sources[0]!, binding: { ...f.sources[0]!.binding, nodeContainerId: "e".repeat(64) } };
    await f.guardian.dispatch(f.authority.sign(f.request({ kind: "set-policy", policyEpoch: 2, destinationAddress: f.destinationAddress, sources: [rebound, f.sources[1]!] })));
    f.reopen(); const status = parseGuardianStatus(f.guardian.status());
    assert.equal(status.policyEpoch, 3); assert.equal(status.sources[0]!.claimSpent, true);
    assert.deepEqual(readFileSync(join(f.directory, "owner-pin.json")), pin);
    const quote = { ...f.claimQuote(), sourceBinding: { ...f.quote.sourceBinding, containerId: rebound.binding.nodeContainerId } };
    await assert.rejects(f.guardian.dispatch(f.authority.sign(f.request({ kind: "claim", policyEpoch: 3, quote }))), /spent/);
  } finally { f.close(); }
});

test("claim reservation is single-flight and a lost client reply remains readable without another payment POST", async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    f.hook(() => new Promise<void>(done => { release = done; }));
    const body = f.request({ kind: "claim", policyEpoch: 1, quote: f.claimQuote() });
    const running = f.guardian.dispatch(f.authority.sign(body));
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(f.guardian.dispatch(f.authority.sign(f.request({ kind: "claim", policyEpoch: 1, quote: f.claimQuote() }))), /pending/);
    assert.deepEqual(f.guardian.status().claimedSources, [f.sourceAddress]);
    release(); const completed = await running;
    f.reopen();
    const query = f.request({ kind: "operation-status", operationId: body.operationId, sourceAddress: f.sourceAddress, operationKind: "claim" });
    assert.deepEqual(await f.guardian.dispatch(f.authority.sign(query)), completed);
    await assert.rejects(f.guardian.dispatch(f.authority.sign(f.request({ kind: "operation-status", operationId: body.operationId, sourceAddress: f.secondAddress, operationKind: "claim" }))), /invalid/);
    assert.equal((completed.result as ClaimsDispatchResult).signature, f.ack.signature);
    await assert.rejects(f.guardian.dispatch(f.authority.sign(f.request(body.action))), /spent/);
    assert.equal(f.counts().claims, 1);
  } finally { f.close(); }
});

test("failed durable reservation prevents helper execution; corrupt or missing guardian state cannot be reinitialized", async () => {
  const f = await fixture();
  try {
    const db = new DatabaseSync(join(f.directory, "guardian.sqlite"));
    db.exec("CREATE TRIGGER deny_reservation BEFORE UPDATE ON guardian_state BEGIN SELECT RAISE(ABORT,'generated journal failure'); END"); db.close();
    await assert.rejects(f.guardian.dispatch(f.authority.sign(f.request({ kind: "claim", policyEpoch: 1, quote: f.claimQuote() }))));
    assert.equal(f.counts().claims, 0);
    f.guardian.close(); unlinkSync(join(f.directory, "guardian.sqlite"));
    assert.throws(() => openSourceGuardian(f.directory), /not-enrolled/);
    assert.throws(() => initializeSourceGuardian(f.directory, f.enrollment), /recovery-required/);
  } finally { f.close(); }
});

test("owner authority survives a different installation identity and never regenerates missing retained identity material", async () => {
  const f = await fixture();
  try {
    const descriptor = f.authority.descriptor;
    const reopened = openOwnerAuthority(f.authorityDirectory, { create: false, expectedAuthorityId: descriptor.authorityId });
    assert.deepEqual(reopened.descriptor, descriptor);
    const value = { purpose: "generated caller-independent proof" };
    assert.deepEqual(verifyOwnerRequest(reopened.sign(value), descriptor), value); reopened.close();
    unlinkSync(join(f.authorityDirectory, "owner-authority-v1.pem"));
    assert.throws(() => openOwnerAuthority(f.authorityDirectory, { create: true }), /recovery-required/);
    unlinkSync(join(f.authorityDirectory, "owner-authority-v1.marker"));
    assert.throws(() => openOwnerAuthority(f.authorityDirectory, { create: true, expectedAuthorityId: descriptor.authorityId, allowHistoryMigration: true }), /recovery-required/);
    assert.throws(() => openOwnerAuthority(f.authorityDirectory, { create: true, historyPresent: true }), /recovery-required/);
  } finally { f.close(); }
});

test("financial transport carries only owner-signed data to the fixed dispatcher and enforces owner guard before SSH dispatch", async () => {
  const f = await fixture();
  try {
    let authorized = true, afterConnect: (() => void) | undefined;
    const commands: string[] = [];
    const target = { computer: { id: f.enrollment.pcId, host: "10.0.0.2", port: 22, name: "Generated", fingerprint: f.sources[0]!.sshFingerprint, hostKey: "generated" }, credential: { username: "generated", password: "generated" } };
    const connect: typeof withSsh = async (_computer, _credential, work) => { afterConnect?.(); return work(async (command, settings) => {
      commands.push(command);
      if (command.endsWith(" status")) return { code: 0, stdout: JSON.stringify(f.guardian.status()) };
      assert.equal(command, "/usr/bin/docker exec -i gridlens-financial-guardian node /app/scripts/source-guardian.ts dispatch");
      const envelope = JSON.parse(String(settings?.input));
      return { code: 0, stdout: JSON.stringify(await f.guardian.dispatch(envelope)) };
    }); };
    const transport = createGuardianTransport({ authority: f.authority, connect, now: () => base, verifyTarget: async () => {} }), guard = () => { if (!authorized) throw Error("Generated owner revoked"); };
    await transport.prepare(target, f.sourceAddress, undefined, guard);
    afterConnect = () => { authorized = false; };
    await assert.rejects(transport.claim(target, f.claimQuote(), randomUUID(), guard), ClaimsNotDispatchedError);
    assert.equal(f.counts().claims, 0); assert.equal(commands.length, 1);
    authorized = true; afterConnect = undefined;
    const operationId = randomUUID();
    const response = await transport.claim(target, f.claimQuote(), operationId, guard);
    assert.equal(response.signature, f.ack.signature); assert.equal(f.counts().claims, 1);
    assert.deepEqual(await transport.readOperation!(target, f.claimQuote(), operationId), response);
    assert.ok(commands.every(command => !command.includes("node -e") && !command.includes("nosana_key")));
    const changed = await transport.setPolicy(target, f.secondAddress, guard, { transferConsumed: true, claimedSources: [] });
    assert.equal(changed.policyEpoch, 2); assert.equal(changed.transferConsumed, true); assert.deepEqual(changed.claimedSources, [f.sourceAddress]);
  } finally { f.close(); }
});

test("the real guardian IPC server drains an accepted claim after its client disconnects and preserves the ACK through restart", async () => {
  const f = await fixture();
  const socketPath = join(f.root, "guardian.sock");
  const server = await startSourceGuardianServer({ directory: f.directory, socketPath, executor: f.executor, now: f.now });
  try {
    let entered!: () => void, release!: () => void;
    const active = new Promise<void>(done => { entered = done; });
    f.hook(() => { entered(); return new Promise<void>(done => { release = done; }); });
    const body = f.request({ kind: "claim", policyEpoch: 1, quote: f.claimQuote() });
    const request = httpRequest({ socketPath, method: "POST", path: "/dispatch" }); request.on("error", () => {});
    request.end(JSON.stringify(f.authority.sign(body)));
    await active; request.destroy();
    let stopped = false; const closing = server.close().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false);
    release(); await closing; f.reopen();
    const stored = await f.guardian.dispatch(f.authority.sign(f.request({ kind: "operation-status", operationId: body.operationId, sourceAddress: f.sourceAddress, operationKind: "claim" })));
    assert.equal(stored.state, "complete"); assert.equal((stored.result as ClaimsDispatchResult).signature, f.ack.signature);
    assert.equal(f.counts().claims, 1); assert.deepEqual(f.guardian.status().claimedSources, [f.sourceAddress]);
  } finally { await server.close(); f.close(); }
});

test("transport cannot exec an absent, foreign or unverified guardian before ownership inspection completes", async () => {
  const f = await fixture();
  try {
    const target = { computer: { id: f.enrollment.pcId, host: "10.0.0.2", port: 22, name: "Generated", fingerprint: f.sources[0]!.sshFingerprint, hostKey: "generated" }, credential: { username: "generated", password: "generated" } };
    let connections = 0; const commands: string[] = [];
    const connect: typeof withSsh = async (_pc, _credential, work) => { connections++; return work(async command => { commands.push(command); return { code: 0, stdout: "{}" }; }); };
    const missing = createGuardianTransport({ authority: f.authority, connect });
    await assert.rejects(missing.status(target)); assert.equal(connections, 0);
    const foreign = createGuardianTransport({ authority: f.authority, connect, verifyTarget: async run => {
      await run("/usr/bin/docker container inspect gridlens-financial-guardian"); throw Error("Generated foreign owner labels");
    } });
    await assert.rejects(foreign.status(target), /transport is unavailable/);
    assert.equal(commands.length, 1); assert.ok(commands.every(command => !command.includes(" exec ")));
    assert.deepEqual(f.counts(), { transfers: 0, claims: 0 });
  } finally { f.close(); }
});

test("transport preserves uncertainty after dispatcher handoff and recovers only its recorded ACK without re-dispatch", async () => {
  const f = await fixture();
  try {
    const target = { computer: { id: f.enrollment.pcId, host: "10.0.0.2", port: 22, name: "Generated", fingerprint: f.sources[0]!.sshFingerprint, hostKey: "generated" }, credential: { username: "generated", password: "generated" } };
    let loseReply = false;
    const connect: typeof withSsh = async (_pc, _credential, work) => work(async (command, settings) => {
      if (command.endsWith(" status")) return { code: 0, stdout: JSON.stringify(f.guardian.status()) };
      const result = await f.guardian.dispatch(JSON.parse(String(settings?.input)));
      if (loseReply) throw Error("Generated lost SSH acknowledgment");
      return { code: 0, stdout: JSON.stringify(result) };
    });
    const transport = createGuardianTransport({ authority: f.authority, connect, now: () => base, verifyTarget: async () => {} });
    await transport.prepare(target, f.sourceAddress, undefined);
    const operationId = randomUUID(); loseReply = true;
    await assert.rejects(transport.claim(target, f.claimQuote(), operationId, () => {}), error => !(error instanceof ClaimsNotDispatchedError));
    assert.equal(f.counts().claims, 1); loseReply = false;
    assert.equal((await transport.readOperation!(target, f.claimQuote(), operationId))?.signature, f.ack.signature);
    assert.equal(f.counts().claims, 1);
  } finally { f.close(); }
});
