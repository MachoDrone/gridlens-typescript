import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, X509Certificate } from "node:crypto";
import { BROWSER_SECURITY_PROTOCOL_LABEL, Coordinator } from "../src/installer/coordinator.ts";
import type { BrowserSecurityPublication } from "../src/installer/coordinator.ts";
import { publicBrowserCertificates } from "../src/installer/container-init.ts";
import { reconcileInstalledServices } from "../src/installer/installed-services.ts";
import { printBrowserReady, printSecureBrowserGuide, printSecureBrowserReady, runTerminal } from "../src/installer/terminal.ts";
import { DockerCommandError, resourceName } from "../src/installer/docker.ts";
import type { CommandResult } from "../src/installer/docker.ts";
import type { ModernRelease } from "../src/installer/release.ts";
import { UpdateDockerFixture } from "./fixtures/updater-docker.ts";
import { createAccess } from "../src/backend/access.ts";

const release: ModernRelease = { format: "gridlens-modern-release-v1", version: "0.1.0-security.1", sequence: 1,
  platform: "linux-x64", minimumCoordinator: 1, imageId: `sha256:${"1".repeat(64)}`,
  runtime: { name: "gridlens-runtime-security.tar", bytes: 1, sha256: "a".repeat(64) } };
const fingerprint = (pem: string) => createHash("sha256").update(new X509Certificate(pem).raw).digest("hex");
function certificates(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "gridlens-browser-security-")), config = join(directory, "config"), tls = join(directory, "tls");
  t.after(() => rmSync(directory, { recursive: true, force: true })); mkdirSync(config); mkdirSync(tls);
  const openssl = (args: string[]) => execFileSync("openssl", args, { stdio: "ignore" });
  openssl(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", join(config, "ca.key"),
    "-out", join(config, "ca.crt"), "-days", "2", "-subj", "/CN=Generated browser setup test CA", "-addext", "basicConstraints=critical,CA:TRUE"]);
  openssl(["req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", join(tls, "server.key"),
    "-out", join(directory, "server.csr"), "-subj", "/CN=Generated browser setup test leaf"]);
  writeFileSync(join(directory, "leaf.ext"), "basicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:10.71.0.8\n");
  openssl(["x509", "-req", "-in", join(directory, "server.csr"), "-CA", join(config, "ca.crt"), "-CAkey", join(config, "ca.key"),
    "-set_serial", "1", "-days", "1", "-out", join(tls, "server.crt"), "-extfile", join(directory, "leaf.ext")]);
  return { directory, config, tls, certificatePem: readFileSync(join(config, "ca.crt"), "utf8"), serverCertificatePem: readFileSync(join(tls, "server.crt"), "utf8") };
}
class SecurityDockerFixture extends UpdateDockerFixture {
  protocol: string | undefined = "1";
  publicFailure: CommandResult | undefined;
  certificates: { certificatePem: string; serverCertificatePem: string };
  publications: BrowserSecurityPublication[] = [];
  readonly accessValues = new Map<string, unknown>();
  readonly access = createAccess({ get: <T>(key: string) => this.accessValues.get(key) as T | undefined,
    set: (key, value) => { this.accessValues.set(key, value); } });
  constructor(directory: string, certs: { certificatePem: string; serverCertificatePem: string }) {
    super("security-fixture", join(directory, "installation.json"), [release]);
    this.certificates = { certificatePem: certs.certificatePem, serverCertificatePem: certs.serverCertificatePem };
    this.access.setFleet("default", []);
  }
  override run(args: readonly string[], input?: string | Uint8Array): CommandResult {
    const ok = (value: unknown): CommandResult => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });
    if (args[0] === "run" && args.at(-1) === "public-browser-certificates") { this.calls.push([...args]); assert.equal(input, "{}"); return this.publicFailure ?? ok(this.certificates); }
    if (args[0] === "run" && args.at(-1) === "--terminal-guard") { this.calls.push([...args]); return ok({ ready: true }); }
    if (args[0] === "exec" && args.includes("pair-code")) {
      this.calls.push([...args]); assert.equal(args.at(-2), "default"); assert.equal(args.at(-1), "operator");
      return ok(this.access.createCode("default", "operator"));
    }
    if (args[0] === "exec" && args.at(-1) === "json" && typeof input === "string") {
      const body = JSON.parse(input);
      if (body.operation === "browser-security-publish") {
        this.calls.push([...args]); const { operation: _operation, ...publication } = body; this.publications.push(publication); return ok({ published: true });
      }
    }
    const result = super.run(args, input);
    if (args[0] === "image" && args[1] === "inspect" && result.status === 0) {
      const images = JSON.parse(result.stdout);
      if (this.protocol !== undefined) images[0].Config.Labels[BROWSER_SECURITY_PROTOCOL_LABEL] = this.protocol;
      return ok(images);
    }
    if (args[0] === "run" && args.at(-1) === "initialize") {
      this.save({ ...this.config!, certificateSha256: fingerprint(this.certificates.serverCertificatePem) }); return ok(this.config);
    }
    return result;
  }
}
function installation(t: TestContext) {
  const certs = certificates(t), runner = new SecurityDockerFixture(certs.directory, certs), coordinator = new Coordinator(runner);
  const installed = coordinator.install({ instance: runner.instance, release, action: "setup", bindAddress: "10.71.0.8", port: 9017, enableUpdater: true });
  return { ...certs, runner, coordinator, installed };
}

test("public certificate helper reads only fixed public files and extracts one leaf from a provided chain", t => {
  const f = certificates(t);
  assert.deepEqual(publicBrowserCertificates(f.config, f.tls), { certificatePem: f.certificatePem, serverCertificatePem: f.serverCertificatePem });
  const emptyConfig = join(f.directory, "existing-trusted"); mkdirSync(emptyConfig);
  writeFileSync(join(f.tls, "server.crt"), f.serverCertificatePem + f.certificatePem);
  assert.deepEqual(publicBrowserCertificates(emptyConfig, f.tls), { certificatePem: f.serverCertificatePem + f.certificatePem, serverCertificatePem: f.serverCertificatePem });
  writeFileSync(join(f.tls, "server.crt"), f.serverCertificatePem + "\n-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----");
  assert.throws(() => publicBrowserCertificates(emptyConfig, f.tls), /unsupported data/);
  writeFileSync(join(f.tls, "server.crt"), "x".repeat(33 * 1024));
  assert.throws(() => publicBrowserCertificates(emptyConfig, f.tls), /bounded ordinary/);
  rmSync(join(f.tls, "server.crt")); symlinkSync(join(f.config, "ca.crt"), join(f.tls, "server.crt"));
  assert.throws(() => publicBrowserCertificates(f.config, f.tls), /bounded ordinary/);
});

test("fresh installation and rerun publish actual nonadjacent endpoints without replacing services or exporting keys", t => {
  const f = installation(t);
  const web = reconcileInstalledServices(f.runner, f.installed, release, { action: "setup", vpnWeb: true, webPort: 18321 });
  assert.equal(web?.origin, "http://10.71.0.8:18321");
  assert.deepEqual(f.runner.publications[0], { version: 1, instance: f.runner.instance, httpsOrigin: "https://10.71.0.8:9017",
    httpOrigin: "http://10.71.0.8:18321", certificatePem: f.certificatePem, serverCertificatePem: f.serverCertificatePem,
    serverCertificateSha256: fingerprint(f.serverCertificatePem) });
  assert.notEqual(f.runner.publications[0]!.serverCertificateSha256, fingerprint(f.certificatePem));
  const before = structuredClone(f.runner.objects), previousConfig = structuredClone(f.runner.config);
  assert.deepEqual(f.coordinator.publishBrowserSecurity(f.installed.config), f.runner.publications[0]);
  assert.deepEqual(f.runner.objects, before); assert.deepEqual(f.runner.config, previousConfig);
  const helper = f.runner.calls.find(args => args.at(-1) === "public-browser-certificates")!;
  assert.ok(helper.includes("--read-only")); assert.equal(helper[helper.indexOf("--network") + 1], "none");
  const mounts = helper.flatMap((arg, index) => arg === "--mount" ? [helper[index + 1]!] : []);
  assert.equal(mounts.length, 2); assert.ok(mounts.every(value => value.endsWith(",readonly")));
  assert.deepEqual(helper.flatMap((value, index) => value === "--cap-add" ? [helper[index + 1]] : []), ["DAC_READ_SEARCH"]);
  assert.doesNotMatch(JSON.stringify(f.runner.publications), /PRIVATE KEY|ca\.key|server\.key|password|token/);
});

test("paired HTTPS only publication contains no invented HTTP endpoint", t => {
  const f = installation(t), publication = f.coordinator.publishBrowserSecurity(f.installed.config)!;
  assert.equal(publication.httpOrigin, null); assert.equal(publication.httpsOrigin, "https://10.71.0.8:9017");
});

test("old or unsupported image capabilities cannot reach new helper or control operations", t => {
  const f = installation(t); f.runner.protocol = undefined; const before = f.runner.calls.length;
  assert.equal(f.coordinator.publishBrowserSecurity(f.installed.config), undefined);
  assert.equal(f.runner.calls.length - before, 1); assert.deepEqual(f.runner.publications, []);
  f.runner.protocol = "2";
  assert.throws(() => f.coordinator.publishBrowserSecurity(f.installed.config), /unsupported browser security protocol/);
  f.runner.protocol = "1";
  assert.throws(() => f.coordinator.supportsBrowserSecurity({ imageId: release.imageId, version: "0.0.0" }), /does not match/);
  assert.deepEqual(f.runner.publications, []);
});

test("changed public identity or unavailable actual endpoint fails before changing published metadata", t => {
  const f = installation(t); f.coordinator.publishBrowserSecurity(f.installed.config); const saved = structuredClone(f.runner.publications);
  assert.throws(() => f.coordinator.publishBrowserSecurity({ ...f.installed.config, certificateSha256: "0".repeat(64) }), /public TLS identity/);
  f.runner.certificates = { certificatePem: f.certificatePem, serverCertificatePem: f.serverCertificatePem + "secret" };
  assert.throws(() => f.coordinator.publishBrowserSecurity(f.installed.config), /public TLS identity/);
  f.runner.certificates = { certificatePem: f.certificatePem, serverCertificatePem: f.serverCertificatePem };
  f.runner.objects.get(`container:${resourceName(f.runner.instance, "gateway")}`)!.State = { Running: false };
  assert.throws(() => f.coordinator.publishBrowserSecurity(f.installed.config), /HTTPS gateway is unavailable/);
  assert.deepEqual(f.runner.publications, saved);
});

test("public helper failures preserve sanitized Docker diagnostics without being mislabeled as invalid certificates", t => {
  const f = installation(t);
  f.runner.publicFailure = { status: 1, stdout: "", stderr: "Public server certificate could not be read (EACCES).\nAuthorization: Bearer fixture-sensitive-auth" };
  assert.throws(() => f.coordinator.publishBrowserSecurity(f.installed.config), error => error instanceof DockerCommandError
    && error.message.includes("EACCES") && !error.message.includes("fixture-sensitive-auth") && error.exitCode === 1);
  assert.deepEqual(f.runner.publications, []);
});

test("ordinary optional guide adds no prompts; secure-browser output provides independently labeled public CA fingerprint", t => {
  const f = installation(t), publication = f.coordinator.publishBrowserSecurity(f.installed.config)!, output: string[] = [];
  const terminal = { color: false, print(value: string) { output.push(value); }, async ask() { throw new Error("No prompt expected"); },
    async secret() { throw new Error("No secret expected"); }, close() {} };
  printBrowserReady(terminal, "http://10.71.0.8:18321", true);
  assert.ok(output.includes("http://10.71.0.8:18321/")); assert.ok(output.includes("Secure this device: http://10.71.0.8:18321/secure-setup"));
  printSecureBrowserReady(terminal, publication);
  assert.ok(output.includes(`PUBLIC CA certificate SHA-256: ${fingerprint(f.certificatePem)}`));
  assert.ok(output.includes("Secure this device: https://10.71.0.8:9017/secure-setup"));
  assert.doesNotMatch(output.join("\n"), /BEGIN CERTIFICATE|PRIVATE KEY|#code=/);
  printSecureBrowserGuide(terminal, "http://[fd71::8]:18321");
  assert.ok(output.includes("Secure this device: http://[fd71::8]:18321/secure-setup"));
  for (const origin of ["https://attacker.invalid:9017", "http://10.71.0.8:18321/path", "http://8.8.8.8:18321"])
    assert.throws(() => printSecureBrowserGuide(terminal, origin));
});

test("secure-browser CLI refreshes an existing publication, prints its guide, and releases maintenance without changing services", async t => {
  const f = installation(t);
  reconcileInstalledServices(f.runner, f.installed, release, { action: "setup", vpnWeb: true, webPort: 18321 });
  const before = structuredClone(f.runner.objects), config = structuredClone(f.runner.config), output: string[] = [];
  let closed = false;
  const terminal = { color: false, print(value: string) { output.push(value); }, async ask() { throw new Error("No prompt expected"); },
    async secret() { throw new Error("No secret expected"); }, close() { closed = true; } };
  const priorUmask = process.umask();
  try { await runTerminal(["--secure-browser", "--instance", f.runner.instance], terminal, f.runner); }
  finally { process.umask(priorUmask); }
  assert.equal(f.runner.publications.length, 2); assert.equal(f.runner.held, false); assert.equal(closed, true);
  assert.deepEqual(f.runner.objects, before); assert.deepEqual(f.runner.config, config);
  assert.ok(output.includes("Secure this device: http://10.71.0.8:18321/secure-setup"));
  assert.ok(output.includes(`PUBLIC CA certificate SHA-256: ${fingerprint(f.certificatePem)}`));
  const connection = /OPEN GRIDLENS: (https:\/\/10\.71\.0\.8:9017\/connect#code=([A-Za-z0-9_-]{12}))/.exec(output.join("\n"));
  assert.ok(connection, "The first HTTPS browser receives an actual terminal-issued connection code");
  assert.ok(output.includes(`Connection code: ${connection[2]}`));
  const paired = f.runner.access.pair(connection[2], "First guided HTTPS browser");
  assert.equal(f.runner.access.requireAccess(paired.token).role, "operator");
  assert.throws(() => f.runner.access.pair(connection[2], "Attempted reuse"));
  assert.match(output.join("\n"), /expires in five minutes/); assert.match(output.join("\n"), /rerun --secure-browser/);
  assert.equal(f.runner.calls.filter(args => args.includes("pair-code")).length, 1);
  assert.doesNotMatch(output.join("\n"), /http:\/\/[^\s]+#code=/);
  const publications = f.runner.publications.length; f.runner.protocol = undefined;
  try { await assert.rejects(runTerminal(["--secure-browser", "--instance", f.runner.instance], terminal, f.runner), /does not support/); }
  finally { process.umask(priorUmask); }
  assert.equal(f.runner.publications.length, publications); assert.equal(f.runner.held, false);
});
