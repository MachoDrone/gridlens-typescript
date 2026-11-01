import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppleCertificateProfileError, createAppleCertificateProfile } from "../src/backend/apple-certificate.ts";

function certificateFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "gridlens-apple-cert-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const run = (args: string[]) => execFileSync("openssl", args, { cwd: directory, stdio: "ignore" });
  run(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", "root.key", "-out", "root.crt", "-days", "2",
    "-subj", "/CN=Generated Apple profile fixture", "-addext", "basicConstraints=critical,CA:TRUE"]);
  run(["req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", "intermediate.key", "-out", "intermediate.csr",
    "-subj", "/CN=Generated intermediate fixture", "-addext", "basicConstraints=critical,CA:TRUE"]);
  run(["x509", "-req", "-in", "intermediate.csr", "-CA", "root.crt", "-CAkey", "root.key", "-set_serial", "2", "-out", "intermediate.crt", "-days", "1", "-copy_extensions", "copy"]);
  const pem = readFileSync(join(directory, "root.crt"), "utf8"), intermediate = readFileSync(join(directory, "intermediate.crt"), "utf8");
  const certificate = new X509Certificate(pem), fingerprint = createHash("sha256").update(certificate.raw).digest("hex");
  return { directory, pem, intermediate, certificate, fingerprint };
}
function parseProfile(bytes: Buffer): Record<string, unknown> {
  // Independent standard-library XML/plist parser; no browser, trust import or
  // third-party runtime dependency is involved in this structural verification.
  const parsed = execFileSync("python3", ["-c", "import sys,plistlib,json,base64; value=plistlib.loads(sys.stdin.buffer.read(),fmt=plistlib.FMT_XML); print(json.dumps(value,default=lambda b:{'base64':base64.b64encode(b).decode('ascii')}))"],
    { input: bytes, maxBuffer: 128 * 1024, encoding: "utf8" });
  return JSON.parse(parsed) as Record<string, unknown>;
}

test("Apple profile parses as one removable unsigned root payload containing exactly the fingerprinted public DER", t => {
  const f = certificateFixture(t), other = certificateFixture(t);
  const input = { instance: "fixture", certificatePem: f.pem + other.pem, certificateSha256: f.fingerprint };
  const bytes = createAppleCertificateProfile(input), profile = parseProfile(bytes);
  assert(bytes.length < 64 * 1024); assert.match(bytes.toString(), /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.doesNotMatch(bytes.toString(), /<!DOCTYPE|<!ENTITY|PRIVATE KEY|com\.apple\.(?:mdm|vpn|proxy|accounts)|PayloadRemovalDisallowed|Password|EncryptedPayloadContent/);
  assert.deepEqual(Object.keys(profile).sort(), ["PayloadContent", "PayloadDescription", "PayloadDisplayName", "PayloadIdentifier", "PayloadOrganization", "PayloadType", "PayloadUUID", "PayloadVersion"].sort());
  assert.equal(profile.PayloadType, "Configuration"); assert.equal(profile.PayloadVersion, 1);
  assert.equal(profile.PayloadDisplayName, `GridLens fixture CA (${f.fingerprint.slice(0, 8)})`); assert.match(String(profile.PayloadDescription), /Unsigned profile/);
  assert.equal(profile.PayloadRemovalDisallowed, undefined, "omitted removal restriction retains Apple's removable default");
  assert(Array.isArray(profile.PayloadContent)); assert.equal(profile.PayloadContent.length, 1);
  const payload = profile.PayloadContent[0] as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload).sort(), ["PayloadCertificateFileName", "PayloadContent", "PayloadDescription", "PayloadDisplayName", "PayloadIdentifier", "PayloadType", "PayloadUUID", "PayloadVersion"].sort());
  assert.equal(payload.PayloadType, "com.apple.security.root"); assert.equal(payload.PayloadVersion, 1);
  assert.equal(payload.PayloadDisplayName, `GridLens fixture root certificate (${f.fingerprint.slice(0, 8)})`);
  assert.equal(payload.PayloadCertificateFileName, `gridlens-fixture-${f.fingerprint.slice(0, 8)}-ca.cer`);
  assert.deepEqual(Object.keys(payload.PayloadContent as object), ["base64"]);
  assert.deepEqual(Buffer.from((payload.PayloadContent as { base64: string }).base64, "base64"), f.certificate.raw);
  assert.notEqual(payload.PayloadUUID, profile.PayloadUUID);
  for (const identifier of [profile.PayloadUUID, payload.PayloadUUID]) assert.match(String(identifier), /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});

test("profile identifiers stay stable for the same CA and differ after CA replacement", t => {
  const f = certificateFixture(t), other = certificateFixture(t), input = { instance: "fixture", certificatePem: f.pem, certificateSha256: f.fingerprint };
  const first = createAppleCertificateProfile(input);
  assert.deepEqual(createAppleCertificateProfile(input), first);
  assert.deepEqual(createAppleCertificateProfile({ ...input, certificatePem: `\n${f.pem}\n` }), first);
  const before = parseProfile(first), renamed = parseProfile(createAppleCertificateProfile({ ...input, instance: "renamed" }));
  assert.equal(renamed.PayloadIdentifier, before.PayloadIdentifier); assert.equal(renamed.PayloadUUID, before.PayloadUUID);
  assert.equal((renamed.PayloadContent as { PayloadUUID: string }[])[0]!.PayloadUUID, (before.PayloadContent as { PayloadUUID: string }[])[0]!.PayloadUUID);
  const replaced = parseProfile(createAppleCertificateProfile({ ...input, certificatePem: other.pem, certificateSha256: other.fingerprint }));
  assert.notEqual(replaced.PayloadIdentifier, before.PayloadIdentifier); assert.notEqual(replaced.PayloadUUID, before.PayloadUUID);
});

test("profile generation rejects unmatched, invalid, private, expired and non-self-signed input", t => {
  const f = certificateFixture(t), input = { instance: "fixture", certificatePem: f.pem, certificateSha256: f.fingerprint };
  for (const fields of [{ certificateSha256: "0".repeat(64) }, { certificatePem: f.pem + readFileSync(join(f.directory, "root.key"), "utf8") },
    { certificatePem: " ".repeat(32 * 1024 + 1) }, { instance: "<dict>&\"bad" }, { PayloadType: "com.apple.mdm" }])
    assert.throws(() => createAppleCertificateProfile({ ...input, ...fields }), AppleCertificateProfileError);
  assert.throws(() => createAppleCertificateProfile(input, Date.parse(f.certificate.validFrom) - 1), AppleCertificateProfileError);
  assert.throws(() => createAppleCertificateProfile(input, Date.parse(f.certificate.validTo)), AppleCertificateProfileError);
  const intermediateHash = createHash("sha256").update(new X509Certificate(f.intermediate).raw).digest("hex");
  assert.throws(() => createAppleCertificateProfile({ ...input, certificatePem: f.intermediate + f.pem, certificateSha256: intermediateHash }),
    error => error instanceof AppleCertificateProfileError && error.kind === "unsupported");
});
