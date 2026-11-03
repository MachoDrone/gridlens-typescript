import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getBase58Decoder } from "@solana/kit";
import { openOwnerAuthority, verifyOwnerRequest } from "../src/backend/owner-authority.ts";
import type { OwnerAuthorityDescriptor } from "../src/backend/owner-authority.ts";
import { initializeSourceGuardian, openSourceGuardian, parseGuardianStatus, serializeGuardianEnrollment } from "../src/backend/source-guardian.ts";
import type { GuardianEnrollment, GuardianReply, GuardianRequest } from "../src/backend/source-guardian.ts";
import { GUARDIAN_MAX_BODY_BYTES, GUARDIAN_MAX_ENROLLMENT_BYTES, GUARDIAN_MAX_ENVELOPE_BYTES, GUARDIAN_MAX_REPLY_BYTES } from "../src/backend/guardian-limits.ts";
import { dispatchGuardianEnvelope, provisionGuardianDirectory, startSourceGuardianServer } from "../scripts/source-guardian.ts";

const base = 1_800_000_000_000, pcId = "a".repeat(64);
function generatedAddress(index: number): string {
  const bytes = Buffer.alloc(32, 7); bytes.writeUInt32BE(index, 28); return getBase58Decoder().decode(bytes);
}
function enrollment(owner: OwnerAuthorityDescriptor, count: number, histories: number): GuardianEnrollment {
  return { ...owner, pcId, policyEpoch: 1, destinationAddress: generatedAddress(30_001), transferConsumed: true,
    claimedSources: Array.from({ length: histories }, (_, index) => generatedAddress(index + 10_001)),
    sources: Array.from({ length: count }, (_, index) => ({ address: generatedAddress(index + 1), name: `Generated 🚀 Nosana source ${index + 1}`,
      binding: { pcId, runtime: "docker", wrapperId: null, nodeContainerId: (index + 1).toString(16).padStart(64, "0") },
      sshFingerprint: `SHA256:${"A".repeat(43)}`, verifiedAtMs: base, privateIp: "10.0.0.2",
      gpuUuids: [`GPU-${index.toString(16).padStart(8, "0")}-1111-2222-3333-444444444444`] })) };
}
function policy(value: GuardianEnrollment): GuardianRequest {
  return { version: 1, operationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", pcId, scopeId: "generated-capacity-fleet", rosterRevision: "one",
    issuedAtMs: base, expiresAtMs: base + 60_000, action: { kind: "set-policy", policyEpoch: 1, destinationAddress: value.destinationAddress,
      sources: value.sources, claimedSources: value.claimedSources, transferConsumed: true } };
}

test("200 sources and 1000 historical claims cross signing and real IPC with UTF-8 split across chunks", async () => {
  const root = mkdtempSync(join(tmpdir(), "gridlens-guardian-capacity-"));
  const owner = openOwnerAuthority(join(root, "owner"), { create: true });
  const directory = join(root, "guardian"), socketPath = join(root, "guardian.sock");
  let server: Awaited<ReturnType<typeof startSourceGuardianServer>> | undefined, helpers = 0;
  try {
    const initial = enrollment(owner.descriptor, 1, 0), large = enrollment(owner.descriptor, 200, 1000);
    const serialized = serializeGuardianEnrollment(large), body = policy(large), signed = owner.sign(body), wire = Buffer.from(JSON.stringify(signed));
    assert.ok(Buffer.byteLength(serialized) > 32_768); assert.ok(wire.length < GUARDIAN_MAX_ENVELOPE_BYTES);
    assert.deepEqual(verifyOwnerRequest(signed, owner.descriptor), body);
    initializeSourceGuardian(directory, initial);
    server = await startSourceGuardianServer({ directory, socketPath, now: () => base, executor: {
      async transfer() { helpers++; throw Error("No financial helper permitted in capacity proof"); },
      async claim() { helpers++; throw Error("No financial helper permitted in capacity proof"); },
    } });
    const split = wire.indexOf(Buffer.from("🚀")) + 2; assert.ok(split > 2);
    const response = await new Promise<{ status: number; bytes: Buffer }>((done, reject) => {
      const outgoing = request({ socketPath, path: "/dispatch", method: "POST", headers: { "Content-Length": wire.length } }, incoming => {
        const chunks: Buffer[] = []; incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.once("end", () => done({ status: incoming.statusCode!, bytes: Buffer.concat(chunks) })); incoming.once("error", reject);
      });
      outgoing.once("error", reject); outgoing.write(wire.subarray(0, split)); setTimeout(() => outgoing.end(wire.subarray(split)), 5);
    });
    assert.equal(response.status, 200); assert.ok(response.bytes.length > 65_536); assert.ok(response.bytes.length <= GUARDIAN_MAX_REPLY_BYTES);
    const reply = JSON.parse(response.bytes.toString("utf8")) as GuardianReply, status = parseGuardianStatus(reply.result);
    assert.equal(status.sources.length, 200); assert.equal(status.claimedSources.length, 1000); assert.equal(status.policyEpoch, 2);
    assert.equal(status.transferConsumed, true); assert.equal(helpers, 0);
    const second = { ...body, operationId: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee", action: { ...body.action, policyEpoch: 2 } };
    const throughCliClient = await dispatchGuardianEnvelope(socketPath, owner.sign(second));
    assert.ok(Buffer.byteLength(throughCliClient) > 65_536);
    assert.equal(parseGuardianStatus((JSON.parse(throughCliClient) as GuardianReply).result).policyEpoch, 3);
    const oversizedWire = Buffer.from(JSON.stringify({ padding: "x".repeat(GUARDIAN_MAX_ENVELOPE_BYTES) }));
    const oversizedStatus = await new Promise<number>(done => {
      let status = 0;
      const outgoing = request({ socketPath, path: "/dispatch", method: "POST", agent: false, headers: { "Content-Length": oversizedWire.length } }, incoming => {
        status = incoming.statusCode!; incoming.on("error", () => {}); incoming.resume();
      });
      outgoing.on("error", () => {}); outgoing.once("close", () => done(status));
      outgoing.setTimeout(5000, () => outgoing.destroy()); outgoing.end(oversizedWire);
    });
    assert.ok(oversizedStatus === 0 || oversizedStatus === 409);
    const check = openSourceGuardian(directory); try { assert.equal(check.status().policyEpoch, 3); } finally { check.close(); }
    assert.equal(helpers, 0);
  } finally { await server?.close(); owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test("1000 current sources plus 10000 disjoint historical claims initialize and reopen within finite bounds", () => {
  const root = mkdtempSync(join(tmpdir(), "gridlens-guardian-union-")), owner = openOwnerAuthority(join(root, "owner"), { create: true });
  try {
    const value = enrollment(owner.descriptor, 1000, 10_000), serialized = serializeGuardianEnrollment(value), directory = join(root, "guardian");
    assert.ok(Buffer.byteLength(serialized) <= GUARDIAN_MAX_ENROLLMENT_BYTES);
    const initial = initializeSourceGuardian(directory, value), bytes = Buffer.byteLength(JSON.stringify(initial));
    assert.ok(bytes > 512 * 1024); assert.ok(bytes <= GUARDIAN_MAX_REPLY_BYTES);
    const guardian = openSourceGuardian(directory);
    try {
      const status = parseGuardianStatus(guardian.status()); assert.equal(status.sources.length, 1000); assert.equal(status.claimedSources.length, 10_000);
      assert.equal(status.transferConsumed, true); assert.deepEqual(status, initial);
    } finally { guardian.close(); }
  } finally { owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test("oversized valid-count enrollment is rejected before directory creation, volume chmod, ledger writes or signing", () => {
  const root = mkdtempSync(join(tmpdir(), "gridlens-guardian-oversize-")), owner = openOwnerAuthority(join(root, "owner"), { create: true });
  try {
    const oversized = enrollment(owner.descriptor, 1000, 10_000);
    for (const source of oversized.sources) {
      source.name = "g".repeat(256);
      source.gpuUuids = Array.from({ length: 64 }, (_, index) => `GPU-${index.toString(16).padStart(8, "0")}-1111-2222-3333-444444444444`);
    }
    assert.ok(Buffer.byteLength(JSON.stringify(oversized)) > GUARDIAN_MAX_ENROLLMENT_BYTES);
    assert.throws(() => serializeGuardianEnrollment(oversized), /byte limit/);
    const absent = join(root, "not-created"); assert.throws(() => initializeSourceGuardian(absent, oversized), /byte limit/); assert.equal(existsSync(absent), false);
    const mounted = join(root, "empty-mounted-volume"); mkdirSync(mounted); chmodSync(mounted, 0o755);
    assert.throws(() => provisionGuardianDirectory(mounted, oversized), /byte limit/);
    assert.equal(statSync(mounted).mode & 0o777, 0o755); assert.deepEqual(readdirSync(mounted), []);
    assert.throws(() => owner.sign({ padding: "x".repeat(GUARDIAN_MAX_BODY_BYTES) }), /exceeds its bound/);
  } finally { owner.close(); rmSync(root, { recursive: true, force: true }); }
});
