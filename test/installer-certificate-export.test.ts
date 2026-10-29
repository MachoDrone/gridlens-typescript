import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, X509Certificate } from "node:crypto";
import { certificateExportPath, offerPublicCertificateExport, publicCertificateFingerprint, savePublicCertificate } from "../src/installer/terminal.ts";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "gridlens-public-ca-export-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(directory, "generated-key.pem"),
    "-out", join(directory, "generated-ca.crt"), "-days", "1", "-subj", "/CN=Generated export fixture", "-addext", "basicConstraints=critical,CA:TRUE"], { stdio: "ignore" });
  return { directory, certificate: readFileSync(join(directory, "generated-ca.crt"), "utf8"), close: () => rmSync(directory, { recursive: true }) };
}
function prompt(answers: string[]) {
  const messages: string[] = [], questions: string[] = [];
  return { messages, questions, print(text: string) { messages.push(text); }, async ask(text: string) { questions.push(text); assert(answers.length, "Unexpected extra export prompt"); return answers.shift()!; } };
}

test("absolute export followed by ~/ rerun is idempotent for the same public certificate", () => {
  const f = fixture();
  try {
    const destination = join(f.directory, "gridlens-default-ca.crt");
    assert.equal(certificateExportPath("~/gridlens-default-ca.crt", f.directory), destination);
    assert.equal(savePublicCertificate(destination, f.certificate, { homeDirectory: f.directory }).status, "created");
    const before = statSync(destination), bytes = readFileSync(destination);
    assert.equal(before.mode & 0o777, 0o600);
    assert.equal(savePublicCertificate("~/gridlens-default-ca.crt", f.certificate.trim(), { homeDirectory: f.directory }).status, "unchanged");
    assert.deepEqual(readFileSync(destination), bytes); assert.equal(statSync(destination).ino, before.ino); assert.equal(statSync(destination).mtimeMs, before.mtimeMs);
  } finally { f.close(); }
});

test("private CA Enter default saves a recommendation and labels its fingerprint separately from the leaf pin", async () => {
  const f = fixture();
  try {
    const terminal = prompt([""]);
    await offerPublicCertificateExport(terminal, "default", f.certificate, { homeDirectory: f.directory });
    assert.match(terminal.questions[0]!, /~\/gridlens-default-ca\.crt/);
    assert.equal(readFileSync(join(f.directory, "gridlens-default-ca.crt"), "utf8"), f.certificate.trim() + "\n");
    const fingerprint = createHash("sha256").update(new X509Certificate(f.certificate).raw).digest("hex");
    assert.equal(publicCertificateFingerprint(f.certificate), fingerprint);
    assert(terminal.messages.includes(`PUBLIC CA certificate SHA-256: ${fingerprint}`));
    assert(terminal.messages.some(value => value.includes("separate server TLS certificate pin")));
    assert(!terminal.messages.join("\n").includes("BEGIN CERTIFICATE"));
  } finally { f.close(); }
});

test("different existing public certificate is preserved and reprompts for another path", async () => {
  const f = fixture(), different = fixture();
  try {
    const existing = join(f.directory, "existing.crt"); writeFileSync(existing, different.certificate);
    const terminal = prompt([existing, "~/replacement.crt"]);
    await offerPublicCertificateExport(terminal, "default", f.certificate, { homeDirectory: f.directory });
    assert.equal(readFileSync(existing, "utf8"), different.certificate); assert.equal(readFileSync(join(f.directory, "replacement.crt"), "utf8"), f.certificate.trim() + "\n");
    assert(terminal.messages.some(value => /different public certificate.*not overwritten/.test(value)));
    assert(!terminal.messages.join("\n").includes("BEGIN CERTIFICATE"));
  } finally { f.close(); different.close(); }
});

test("symlink destinations and parent directories are refused without following or changing their targets", () => {
  const f = fixture();
  try {
    const target = join(f.directory, "target.crt"); writeFileSync(target, f.certificate);
    symlinkSync(target, join(f.directory, "linked.crt"));
    assert.throws(() => savePublicCertificate(join(f.directory, "linked.crt"), f.certificate), /Symbolic links/);
    mkdirSync(join(f.directory, "actual")); symlinkSync(join(f.directory, "actual"), join(f.directory, "parent-link"));
    assert.throws(() => savePublicCertificate(join(f.directory, "parent-link", "new.crt"), f.certificate), /Symbolic links/);
    assert.equal(readFileSync(target, "utf8"), f.certificate);
    assert.throws(() => readFileSync(join(f.directory, "actual", "new.crt")), /ENOENT/);
  } finally { f.close(); }
});

test("oversized and private-key-shaped existing files are never overwritten or exposed in messages", async () => {
  const f = fixture();
  try {
    const privateLooking = "-----BEGIN PRIVATE KEY-----\nGENERATED_PRIVATE_PAYLOAD_NOT_FOR_EXPORT\n-----END PRIVATE KEY-----\n";
    const privatePath = join(f.directory, "not-a-ca.crt"), largePath = join(f.directory, "large.crt");
    writeFileSync(privatePath, privateLooking); writeFileSync(largePath, "x".repeat(32769));
    const terminal = prompt([privatePath, largePath, "skip"]);
    await offerPublicCertificateExport(terminal, "default", f.certificate, { homeDirectory: f.directory });
    assert.equal(readFileSync(privatePath, "utf8"), privateLooking); assert.equal(statSync(largePath).size, 32769);
    assert(terminal.messages.some(value => /not a public certificate/.test(value))); assert(terminal.messages.some(value => /too large/.test(value)));
    assert(!terminal.messages.join("\n").includes("GENERATED_PRIVATE_PAYLOAD")); assert(!terminal.messages.join("\n").includes("BEGIN PRIVATE KEY"));
    assert.throws(() => savePublicCertificate(join(f.directory, "forbidden.crt"), privateLooking), /Only public certificate/);
  } finally { f.close(); }
});

test("explicit skip and existing trusted certificate flow do not require an export or new trust import", async () => {
  const f = fixture();
  try {
    const skipped = prompt(["skip"]); await offerPublicCertificateExport(skipped, "default", f.certificate, { homeDirectory: f.directory });
    assert.throws(() => readFileSync(join(f.directory, "gridlens-default-ca.crt")), /ENOENT/);
    const existing = prompt([""]); await offerPublicCertificateExport(existing, "default", f.certificate, { homeDirectory: f.directory, existingTrusted: true });
    assert(existing.messages.some(value => /needs no new CA import/.test(value))); assert.match(existing.questions[0]!, /Enter or skip to skip/);
    assert.throws(() => certificateExportPath("~/../outside.crt", f.directory), /local file path/);
  } finally { f.close(); }
});
