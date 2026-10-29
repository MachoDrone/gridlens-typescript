/** Real isolated acceptance. Docker connection/SSH forwarding are operator-owned. */
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "node:https";
import type { TLSSocket } from "node:tls";
import { Coordinator } from "../src/installer/coordinator.ts";
import { localDockerRunner, checked, inspectOwned, resourceName, PRODUCT_LABEL, INSTANCE_LABEL, PRODUCT, labels, restrictions, mount } from "../src/installer/docker.ts";
import type { DockerRunner } from "../src/installer/docker.ts";
import type { ModernRelease } from "../src/installer/release.ts";
import type { InstallationConfig } from "../src/installer/config.ts";
import { verifyGateway } from "../src/installer/health.ts";
import { dockerFixtureProgram } from "./shared-docker-fixture.ts";
import type { DockerFixtureEvidence } from "./shared-docker-fixture.ts";

export interface AcceptanceOptions { instance: string; port: number; prebuiltImage?: string; prebuiltVersion?: string; report?: string }
export function acceptanceOptions(args: readonly string[]): AcceptanceOptions {
  const options: AcceptanceOptions = { instance: `fixture-${randomBytes(6).toString("hex")}`, port: 18443 }, seen = new Set<string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!, value = args[index + 1];
    if (!value || seen.has(key)) throw new Error("Supply each acceptance option once with a value."); seen.add(key);
    if (key === "--instance") options.instance = value;
    else if (key === "--port" && /^\d+$/.test(value)) options.port = Number(value);
    else if (key === "--prebuilt-image") options.prebuiltImage = value;
    else if (key === "--prebuilt-version") options.prebuiltVersion = value;
    else if (key === "--report") options.report = resolve(value);
    else throw new Error("Unknown acceptance option.");
  }
  if (!/^fixture-[a-f0-9]{12}$/.test(options.instance) || !Number.isInteger(options.port) || options.port < 1024 || options.port > 65535
    || options.prebuiltImage !== undefined && !/^sha256:[a-f0-9]{64}$/.test(options.prebuiltImage)
    || options.prebuiltVersion !== undefined && !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(options.prebuiltVersion)
    || options.prebuiltVersion && !options.prebuiltImage) throw new Error("Invalid isolated acceptance options.");
  if (options.report && (existsSync(options.report) || options.report.startsWith(resolve(".") + "/"))) throw new Error("Choose a new private report path outside the checkout.");
  return options;
}
interface Reply { status: number; value: Record<string, unknown>; cookie?: string; certificateSha256: string }
function httpsCall(origin: string, route: string, ca?: string, options: { token?: string; cookie?: string; body?: unknown; servername?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = request(new URL(route, origin), { method: body === undefined ? "GET" : "POST", rejectUnauthorized: true, agent: false,
      ...(ca === undefined ? {} : { ca }), ...(options.servername ? { servername: options.servername } : {}),
      headers: { Accept: "application/json", ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}), ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }) } }, response => {
      const parts: Buffer[] = []; let size = 0;
      const peer = (response.socket as TLSSocket).getPeerCertificate(), certificateSha256 = peer.raw ? createHash("sha256").update(peer.raw).digest("hex") : "";
      response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 2 * 1024 * 1024) req.destroy(new Error("Fixture HTTPS response exceeded its bound.")); else parts.push(chunk); });
      response.once("error", reject); response.once("end", () => {
        try { const value = JSON.parse(Buffer.concat(parts).toString("utf8")) as Record<string, unknown>, cookie = response.headers["set-cookie"]?.[0];
          resolve({ status: response.statusCode ?? 0, value, certificateSha256, ...(cookie ? { cookie } : {}) });
        } catch { reject(new Error("Fixture HTTPS response was not valid JSON.")); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error("Fixture HTTPS request timed out.")), 8000);
    req.once("close", () => clearTimeout(timer)); req.once("error", reject); req.end(body);
  });
}
export function interruptGatewayOnce(runner: DockerRunner, instance: string): DockerRunner {
  let interrupted = false;
  return { run(args, input) {
    if (!interrupted && args[0] === "run" && args.includes("--name") && args[args.indexOf("--name") + 1] === resourceName(instance, "gateway")) {
      interrupted = true; throw new Error("Injected fixture interruption before gateway creation.");
    }
    return runner.run(args, input);
  } };
}

/** Fixture-only topology: collection owner has no egress; only the gateway joins
 * a second owned ingress network so Docker can publish its canonical port. */
export function withFixtureIngress(runner: DockerRunner, instance: string): DockerRunner {
  const internal = resourceName(instance, "network"), ingress = resourceName(instance, "acceptance-ingress");
  const gateway = resourceName(instance, "gateway"), owner = resourceName(instance, "owner");
  return { run(args, input) {
    const result = runner.run(args, input);
    const target = args[0] === "run" && args.includes("--name") ? args[args.indexOf("--name") + 1]
      : args[0] === "start" ? args[1] : undefined;
    if (result.status !== 0 || target !== gateway && target !== owner) return result;
    let item = inspectOwned(runner, "container", target, instance)!;
    const memberships = () => Object.keys((item.NetworkSettings as { Networks?: Record<string, unknown> } | undefined)?.Networks ?? {}).sort();
    assert.equal((item.HostConfig as { NetworkMode?: unknown } | undefined)?.NetworkMode, internal);
    if (target === owner) assert.deepEqual(memberships(), [internal], "Fixture owner must remain exclusively isolated");
    else {
      assert(memberships().every(name => name === internal || name === ingress), "Fixture gateway has an unexpected network");
      if (!memberships().includes(ingress)) checked(runner, ["network", "connect", ingress, gateway]);
      item = inspectOwned(runner, "container", gateway, instance)!;
      assert.deepEqual(memberships(), [internal, ingress].sort());
    }
    return result;
  } };
}

export async function runDockerAcceptance(options: AcceptanceOptions, runner: DockerRunner = localDockerRunner()) {
  const { instance } = options, networkRunner = withFixtureIngress(runner, instance), coordinator = new Coordinator(networkRunner), imageTags = new Map<string, string>(), helperNames = new Set<string>();
  const evidence: Record<string, unknown> = { version: 1, instance, startedAt: new Date().toISOString(), canonicalOrigin: `https://127.0.0.1:${options.port}`,
    firstBuild: options.prebuiltImage ? "Prebuilt verified image; caller records uncached build separately" : "Full uncached Dockerfile.shared build",
    secondBuild: "Label-only derived image, not a second cold runtime build", physicalReboot: "Not performed", publishedInstaller: "Not tested; local Coordinator only",
    providerRequests: "Disabled by all scheduler fences and the owner-only internal fixture network",
    fixtureNetworks: "Owner exclusively internal; gateway also joins a separately labeled ingress bridge" };
  let claimed = false, failure: unknown;
  const progress = (message: string) => console.log(`Fixture ${instance}: ${message}`);
  const imageInfo = (id: string) => JSON.parse(checked(runner, ["image", "inspect", id]))[0] as { Id: string; RepoTags?: string[]; Config?: { Labels?: Record<string, string> } };
  const release = (imageId: string, version: string, sequence: number): ModernRelease => ({ format: "gridlens-modern-release-v1", imageId, version, sequence,
    minimumCoordinator: 1, platform: `linux-${process.arch}` as ModernRelease["platform"], runtime: { name: `gridlens-runtime-fixture-${sequence}.tar`, bytes: 1, sha256: createHash("sha256").update("isolated fixture").digest("hex") } });
  const stopRuntime = () => { for (const role of ["gateway", "owner"]) { const name = resourceName(instance, role);
    if (inspectOwned(runner, "container", name, instance)) checked(runner, ["stop", "--time", "30", name]); } };
  const helper = (config: InstallationConfig, operation: "seed" | "advance" | "inspect"): DockerFixtureEvidence => {
    for (const role of ["owner", "gateway"]) { const item = inspectOwned(runner, "container", resourceName(instance, role), instance);
      if ((item?.State as { Running?: boolean } | undefined)?.Running) throw new Error("Fixture helpers require stopped runtime containers."); }
    const name = resourceName(instance, `acceptance-${operation}-${randomBytes(4).toString("hex")}`); helperNames.add(name);
    return JSON.parse(checked(runner, ["run", "--rm", "-i", "--name", name, ...labels(instance), ...restrictions, "--network", "none", "--user", "1000:1000",
      ...mount(config.active.stateVolume, "/state"), ...mount(resourceName(instance, "ledger"), "/ledger"), config.active.imageId,
      "node", "--input-type=module", "-"], dockerFixtureProgram({ instance, operation }))) as DockerFixtureEvidence;
  };
  try {
    evidence.dockerVersion = checked(runner, ["version", "--format", "{{.Server.Version}}"]);
    for (const kind of ["container", "volume", "network"] as const) {
      const args = kind === "container" ? ["container", "ls", "-a"] : [kind, "ls"];
      const prior = checked(runner, [...args, "--filter", `label=${PRODUCT_LABEL}=${PRODUCT}`, "--filter", `label=${INSTANCE_LABEL}=${instance}`, "--format", kind === "container" ? "{{.Names}}" : "{{.Name}}"]);
      if (prior) throw new Error("Fixture identity already owns resources; choose a new instance.");
    }
    for (const suffix of ["network", "acceptance-ingress"]) if (inspectOwned(runner, "network", resourceName(instance, suffix), instance)) throw new Error("Fixture network name is in use.");
    checked(runner, ["network", "create", "--internal", ...labels(instance), resourceName(instance, "network")]); claimed = true;
    checked(runner, ["network", "create", ...labels(instance), resourceName(instance, "acceptance-ingress")]);
    let first: ModernRelease, baseReference: string;
    if (options.prebuiltImage) {
      const info = imageInfo(options.prebuiltImage), version = options.prebuiltVersion ?? info.Config?.Labels?.["io.gridlens.version"];
      if (info.Id !== options.prebuiltImage || info.Config?.Labels?.[PRODUCT_LABEL] !== PRODUCT || !version || info.Config?.Labels?.["io.gridlens.version"] !== version) throw new Error("Prebuilt image identity/version did not verify.");
      baseReference = info.RepoTags?.find(tag => tag !== "<none>:<none>") ?? "";
      if (!baseReference || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]+$/.test(baseReference)) throw new Error("Prebuilt image needs an existing tag for the child build.");
      first = release(info.Id, version, 1);
    } else {
      const tag = `gridlens-modern-${instance}:1`, version = "0.0.1-fixture";
      checked(runner, ["build", "--no-cache", "--file", "Dockerfile.shared", "--build-arg", `GRIDLENS_VERSION=${version}`, "--label", `${INSTANCE_LABEL}=${instance}`, "--tag", tag, "."]);
      first = release(imageInfo(tag).Id, version, 1); imageTags.set(tag, first.imageId); baseReference = tag;
    }
    evidence.firstImageId = first.imageId; progress("interrupted initial setup");
    assert.throws(() => new Coordinator(interruptGatewayOnce(networkRunner, instance)).install({ instance, release: first, action: "setup", bindAddress: "127.0.0.1", port: options.port }), /Injected fixture interruption/);
    const prepared = coordinator.configuration(instance, first.imageId)!; assert.equal(prepared.phase, "prepared");
    evidence.initialImageBindings = { imageInspectId: imageInfo(first.imageId).Id, ownerContainerImage: inspectOwned(runner, "container", resourceName(instance, "owner"), instance)!.Image };
    const installed = coordinator.install({ instance, release: first, action: "setup" }); assert.equal(installed.config.certificateSha256, prepared.certificateSha256);
    stopRuntime(); const seeded = helper(installed.config, "seed"); evidence.seeded = seeded;
    coordinator.install({ instance, release: first, action: "setup" }); await verifyGateway(installed.config.origin, installed.certificate);
    await assert.rejects(httpsCall(installed.config.origin, "/api/shared/status"), error => /CERT|VERIFY|SELF_SIGNED/i.test(String((error as NodeJS.ErrnoException).code)));
    await assert.rejects(httpsCall(installed.config.origin, "/api/shared/status", installed.certificate, { servername: "wrong.fixture.invalid" }), error => (error as NodeJS.ErrnoException).code === "ERR_TLS_CERT_ALTNAME_INVALID");
    const code = (role: "operator" | "viewer") => JSON.parse(checked(runner, ["exec", resourceName(instance, "owner"), "node", "scripts/shared-control.ts", "pair-code", seeded.context.scopeId, role])).code as string;
    const login = await httpsCall(installed.config.origin, "/api/shared/login", installed.certificate, { body: { version: 1, code: code("operator"), deviceName: "Synthetic browser" } });
    assert.equal(login.status, 200); assert(login.cookie && /Secure/.test(login.cookie) && /HttpOnly/.test(login.cookie) && /SameSite=Strict/.test(login.cookie));
    const browser = { cookie: login.cookie.split(";", 1)[0]! };
    const pair = async () => { const result = await httpsCall(installed.config.origin, "/api/shared/pair", installed.certificate, { body: { version: 1, code: code("viewer"), deviceName: "Synthetic phone" } });
      assert.equal(result.status, 200); assert.equal(typeof result.value.token, "string"); return { token: result.value.token as string, deviceId: result.value.deviceId as string }; };
    const phone = await pair(), doomed = await pair();
    const check = async (expectedAt: number, waitUntil: number, revoked: boolean) => {
      for (const role of ["owner", "gateway"]) {
        const item = inspectOwned(runner, "container", resourceName(instance, role), instance)!;
        assert.deepEqual(Object.keys((item.NetworkSettings as { Networks: Record<string, unknown> }).Networks).sort(),
          (role === "owner" ? [resourceName(instance, "network")] : [resourceName(instance, "network"), resourceName(instance, "acceptance-ingress")]).sort());
      }
      const web = await httpsCall(installed.config.origin, "/api/fleet/metadata.json", installed.certificate, browser);
      const mobile = await httpsCall(installed.config.origin, "/api/fleet/metadata.json", installed.certificate, { token: phone.token });
      assert.equal(web.status, 200); assert.equal(mobile.status, 200); assert.deepEqual(web.value.hosts, mobile.value.hosts);
      assert((web.value.hosts as { fetchedAtMs: number }[]).every(row => row.fetchedAtMs === expectedAt));
      assert.equal(web.certificateSha256, installed.config.certificateSha256); assert.equal(mobile.certificateSha256, installed.config.certificateSha256);
      const status = await httpsCall(installed.config.origin, "/api/shared/status", installed.certificate, browser);
      assert.equal(status.status, 200); assert.equal(status.value.serverId, seeded.serverId); assert.deepEqual(status.value.context, seeded.context);
      const waits = status.value.providerWaits as { provider: string; retryAtMs: number }[];
      for (const provider of ["jobs", "rpc", "pc-ip", "pc-rewards"]) assert(waits.some(row => row.provider === provider && row.retryAtMs === waitUntil), `Missing persisted ${provider} wait`);
      const denied = await httpsCall(installed.config.origin, "/api/fleet/metadata.json", installed.certificate, { token: doomed.token }); assert.equal(denied.status, revoked ? 401 : 200);
      return { observedAtMs: expectedAt, serverId: status.value.serverId, certificateSha256: web.certificateSha256, waits, revokedStatus: denied.status };
    };
    evidence.initialHttps = await check(seeded.initialObservedAtMs, seeded.waitUntilMs, false);
    assert.deepEqual(coordinator.install({ instance, release: first, action: "setup" }).config, installed.config);
    stopRuntime(); assert.deepEqual(helper(installed.config, "inspect"), seeded);
    coordinator.install({ instance, release: first, action: "setup" }); await verifyGateway(installed.config.origin, installed.certificate);
    evidence.afterRestart = await check(seeded.initialObservedAtMs, seeded.waitUntilMs, false);
    progress("label-only child build and interrupted upgrade"); assert.equal(imageInfo(baseReference).Id, first.imageId);
    const tag = `gridlens-modern-${instance}:2`, version = "0.0.2-fixture";
    checked(runner, ["build", "--pull=false", "--tag", tag, "-"], `FROM ${baseReference}\nLABEL io.gridlens.version="${version}" ${INSTANCE_LABEL}="${instance}"\n`);
    const second = release(imageInfo(tag).Id, version, 2); imageTags.set(tag, second.imageId); evidence.secondImageId = second.imageId;
    assert.throws(() => new Coordinator(interruptGatewayOnce(networkRunner, instance)).install({ instance, release: second, action: "upgrade" }), /Injected fixture interruption/);
    const applying = coordinator.configuration(instance, second.imageId)!; assert.equal(applying.phase, "applying"); assert.equal(applying.active.imageId, second.imageId); assert.deepEqual(applying.previous, installed.config.active);
    const upgraded = coordinator.install({ instance, release: second, action: "upgrade" }); assert.deepEqual(upgraded.config.active, applying.active);
    stopRuntime(); const advanced = helper(upgraded.config, "advance"); evidence.advanced = advanced;
    coordinator.install({ instance, release: second, action: "setup" }); await verifyGateway(installed.config.origin, installed.certificate);
    assert.equal((await httpsCall(installed.config.origin, "/api/shared/revoke", installed.certificate, { ...browser, body: { deviceId: doomed.deviceId } })).status, 200);
    assert.equal((await httpsCall(installed.config.origin, "/api/shared/monitoring-action", installed.certificate, { ...browser, body: { pcId: seeded.permissions[0]!.pcId, action: "revoke" } })).status, 200);
    evidence.afterUpgrade = await check(advanced.advancedObservedAtMs!, advanced.waitUntilMs, true);
    stopRuntime(); const beforeRollback = helper(upgraded.config, "inspect"); evidence.beforeRollback = beforeRollback; assert(beforeRollback.permissions.every(row => row.revokedAtMs !== null));
    const rollback = coordinator.install({ instance, release: second, action: "rollback" }); assert.deepEqual(rollback.config.active, installed.config.active);
    await verifyGateway(installed.config.origin, installed.certificate); evidence.afterRollback = await check(seeded.initialObservedAtMs, advanced.waitUntilMs, true);
    stopRuntime(); const restored = helper(rollback.config, "inspect"); evidence.restored = restored;
    assert.equal(restored.cache.observedAtMs, seeded.initialObservedAtMs); assert.equal(restored.cache.value, seeded.cache.value);
    assert.deepEqual(restored.permissions, beforeRollback.permissions); assert.deepEqual(restored.jobReservations, beforeRollback.jobReservations);
    assert.deepEqual(restored.rpcReservations, beforeRollback.rpcReservations); assert.deepEqual(restored.schedule, seeded.schedule);
    assert.equal(restored.waitUntilMs, advanced.waitUntilMs); assert.equal(restored.serverId, seeded.serverId);
    evidence.result = "passed"; progress("PASS: HTTPS, shared cache, durable waits/grants/revocation, restart, interruption recovery and paired rollback");
  } catch (error) {
    failure = error; evidence.result = "failed"; evidence.failure = error instanceof Error ? error.message : "Acceptance failed.";
    // Capture evidence before cleanup. Only the exact labeled fixture is read;
    // credentials, complete environment and arbitrary host paths are excluded.
    const diagnostics: Record<string, unknown> = {};
    if (claimed) for (const role of ["owner", "gateway"]) {
      const name = resourceName(instance, role);
      try {
        const item = inspectOwned(runner, "container", name, instance);
        if (!item) { diagnostics[role] = { present: false }; continue; }
        const cfg = item.Config as Record<string, unknown> | undefined;
        const mounts = item.Mounts as { Type?: unknown; Name?: unknown; Destination?: unknown; RW?: unknown }[] | undefined;
        const logs = runner.run(["logs", "--tail", "80", name]);
        diagnostics[role] = { present: true, state: item.State, image: item.Image, restartCount: item.RestartCount,
          user: cfg?.User, command: cfg?.Cmd, mounts: mounts?.map(({ Type, Name, Destination, RW }) => ({ Type, Name, Destination, RW })),
          networks: Object.keys((item.NetworkSettings as { Networks?: Record<string, unknown> } | undefined)?.Networks ?? {}),
          logs: logs.stdout.slice(-32768), stderr: logs.stderr.slice(-8192) };
      } catch { diagnostics[role] = { diagnosticError: "Owned fixture metadata/logs could not be read." }; }
    }
    evidence.failureDiagnostics = diagnostics;
  }
  const cleanupErrors: string[] = [], clean = (action: () => void) => { try { action(); } catch (error) { cleanupErrors.push(error instanceof Error ? error.message : "Cleanup failed."); } };
  if (claimed) {
    for (const name of [...helperNames, resourceName(instance, "gateway"), resourceName(instance, "owner")]) clean(() => { if (inspectOwned(runner, "container", name, instance)) { checked(runner, ["stop", "--time", "30", name]); checked(runner, ["rm", name]); } });
    clean(() => { const names = checked(runner, ["volume", "ls", "--filter", `label=${PRODUCT_LABEL}=${PRODUCT}`, "--filter", `label=${INSTANCE_LABEL}=${instance}`, "--format", "{{.Name}}"]);
      for (const name of names.split("\n").filter(Boolean)) clean(() => { if (!name.startsWith(`gridlens-modern-${instance}-`)) throw new Error("Cleanup refused a nonfixture name."); if (inspectOwned(runner, "volume", name, instance)) checked(runner, ["volume", "rm", name]); }); });
    for (const suffix of ["acceptance-ingress", "network"]) clean(() => { const name = resourceName(instance, suffix); if (inspectOwned(runner, "network", name, instance)) checked(runner, ["network", "rm", name]); });
  }
  for (const [tag, id] of [...imageTags].reverse()) clean(() => { if (imageInfo(tag).Id !== id) throw new Error("Fixture image tag changed; cleanup refused it."); checked(runner, ["image", "rm", tag]); });
  evidence.cleanupErrors = cleanupErrors; evidence.completedAt = new Date().toISOString();
  if (options.report) clean(() => { mkdirSync(dirname(options.report!), { recursive: true, mode: 0o700 }); writeFileSync(options.report!, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600, flag: "wx" }); });
  if (failure) throw failure;
  if (cleanupErrors.length) throw new Error("Acceptance passed but fixture cleanup failed; inspect the private report.");
  return evidence;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runDockerAcceptance(acceptanceOptions(process.argv.slice(2))); }
  catch (error) { console.error(error instanceof Error ? error.message : "Isolated acceptance failed."); process.exitCode = 1; }
}
