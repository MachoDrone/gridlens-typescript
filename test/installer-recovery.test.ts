import assert from "node:assert/strict";
import { test } from "node:test";
import { Coordinator } from "../src/installer/coordinator.ts";
import type { InstallationConfig } from "../src/installer/config.ts";
import { PRODUCT, PRODUCT_LABEL, INSTANCE_LABEL, resourceName } from "../src/installer/docker.ts";
import type { CommandResult, DockerRunner } from "../src/installer/docker.ts";
import type { ModernRelease } from "../src/installer/release.ts";

const instance = "fixture-recovery", address = "10.77.0.8";
const ownerName = resourceName(instance, "owner"), gatewayName = resourceName(instance, "gateway"), networkName = resourceName(instance, "network");
const image = (sequence = 1): ModernRelease => ({ format: "gridlens-modern-release-v1", version: `0.1.${sequence}-fixture`, sequence,
  platform: "linux-x64", minimumCoordinator: 1, imageId: "sha256:" + String(sequence).repeat(64), runtime: { name: `gridlens-fixture-${sequence}.tar`, bytes: 1, sha256: "a".repeat(64) } });
type Container = {
  Id: string; Image: string; Config: { Labels: Record<string, string>; User: string; Cmd: string[]; Env: string[] };
  HostConfig: { ReadonlyRootfs: boolean; Privileged: boolean; NetworkMode: string; CapDrop: string[]; CapAdd: string[];
    SecurityOpt: string[]; Binds: null; PidMode: string; IpcMode: string; PortBindings: Record<string, { HostIp: string; HostPort: string }[]> };
  Mounts: { Type: string; Name: string; Destination: string; RW: boolean }[];
  State: { Running: boolean; Status: string; StartedAt: string };
  NetworkSettings: { Networks: Record<string, { NetworkID: string; EndpointID: string; IPAddress: string }>; Ports: Record<string, { HostIp: string; HostPort: string }[] | null> };
};

/** Docker's configured bindings and effective endpoints are deliberately separate.
 * A failed run can leave Created state; starting that remnant can yield Running
 * with empty effective networking, matching the observed daemon failure. */
class RecoveryDocker implements DockerRunner {
  config: InstallationConfig | undefined;
  containers = new Map<string, Container>();
  volumes = new Map<string, Record<string, unknown>>();
  networks = new Map<string, Record<string, unknown>>();
  calls: string[][] = [];
  blockedPorts = new Set<number>();
  failFinalSaveOnce = false;
  failGatewayRemoveOnce = false;
  failGatewayRunOnce = false;
  protectedState = { serverId: "generated-stable-server", tlsFingerprint: "c".repeat(64), cache: "generated original dated cache",
    ledger: "generated spent budget and revocation", credentials: "generated encrypted vault identity" };
  unrelated = { podman: { id: "existing-podman", running: true }, legacy: { id: "existing-legacy-gridlens", running: true } };
  private sequence = 1;
  private labels = { [PRODUCT_LABEL]: PRODUCT, [INSTANCE_LABEL]: instance };
  private ok(value: unknown = ""): CommandResult { return { status: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" }; }
  private missing(): CommandResult { return { status: 1, stdout: "", stderr: "No such object" }; }
  private fail(message: string): CommandResult { return { status: 125, stdout: "", stderr: message }; }
  private attach(name: string, container: Container): void {
    container.NetworkSettings = { Networks: { [networkName]: { NetworkID: "f".repeat(64), EndpointID: this.sequence.toString(16).padStart(64, "e"),
      IPAddress: name === ownerName ? "172.30.0.2" : "172.30.0.3" } }, Ports: structuredClone(container.HostConfig.PortBindings) };
  }
  run(args: readonly string[], input?: string | Uint8Array): CommandResult {
    this.calls.push([...args]); const name = args.at(-1)!, value = (flag: string) => args[args.indexOf(flag) + 1]!;
    if (args[0] === "version") return this.ok("29.0.0-fixture");
    if (args[0] === "image" && args[1] === "inspect") {
      const release = [image(1), image(2)].find(release => release.imageId === name);
      return release ? this.ok([{ Id: release.imageId, Config: { Labels: { [PRODUCT_LABEL]: PRODUCT, "io.gridlens.version": release.version } } }]) : this.missing();
    }
    if (args[0] === "container" && args[1] === "inspect") return this.containers.has(name) ? this.ok([this.containers.get(name)]) : this.missing();
    if (["volume", "network"].includes(args[0]!) && args[1] === "inspect") {
      const collection = args[0] === "volume" ? this.volumes : this.networks;
      return collection.has(name) ? this.ok([collection.get(name)]) : this.missing();
    }
    if (["volume", "network"].includes(args[0]!) && args[1] === "create") {
      const collection = args[0] === "volume" ? this.volumes : this.networks;
      collection.set(name, { Name: name, Id: "f".repeat(64), Labels: this.labels, Driver: args[0] === "network" ? "bridge" : "local", Internal: false }); return this.ok(name);
    }
    if (args[0] === "run" && args.includes("src/installer/container-init.ts")) {
      const body = JSON.parse(typeof input === "string" ? input : Buffer.from(input ?? []).toString() || "{}");
      if (name === "read") return this.ok(this.config ?? null);
      if (name === "initialize") {
        assert.equal(this.config, undefined, "Existing identity must never be initialized again");
        this.config = { schema: 1, instance, bindAddress: body.bindAddress, port: body.port, origin: body.origin,
          certificateSha256: this.protectedState.tlsFingerprint, active: body.active, phase: "prepared" }; return this.ok(this.config);
      }
      if (name === "save") {
        if (this.failFinalSaveOnce && body.phase === "ready" && body.pendingPort === undefined) { this.failFinalSaveOnce = false; return this.fail("Generated interruption at final config commit"); }
        this.config = structuredClone(body); return this.ok({ saved: true });
      }
      if (name === "certificate") return this.ok("GENERATED PUBLIC TRUST CERTIFICATE");
      if (name === "copy-state") throw new Error("Endpoint repair must not copy or replace observation state");
      throw new Error(`Unexpected fixture helper operation ${name}`);
    }
    if (args[0] === "run") {
      const target = value("--name"), imageAt = args.findIndex(arg => /^sha256:/.test(arg));
      const published = args.includes("--publish") ? value("--publish").split(":") : undefined;
      const configured = published ? { "8443/tcp": [{ HostIp: published[0]!, HostPort: published[1]! }] } : {};
      const container: Container = { Id: String(this.sequence++).padStart(64, "0"), Image: args[imageAt]!,
        Config: { Labels: { ...this.labels }, User: value("--user"), Cmd: [...args.slice(imageAt + 1)], Env: args.flatMap((arg, index) => arg === "--env" ? [args[index + 1]!] : []) },
        HostConfig: { ReadonlyRootfs: true, Privileged: false, NetworkMode: value("--network"), CapDrop: ["ALL"], CapAdd: [],
          SecurityOpt: ["no-new-privileges:true"], Binds: null, PidMode: "", IpcMode: "private", PortBindings: configured },
        Mounts: args.flatMap((arg, index) => arg === "--mount" ? [args[index + 1]!] : []).map(spec => { const parts = spec.split(",");
          return { Type: "volume", Name: parts.find(value => value.startsWith("src="))!.slice(4), Destination: parts.find(value => value.startsWith("dst="))!.slice(4), RW: !parts.includes("readonly") }; }),
        State: { Running: false, Status: "created", StartedAt: "" }, NetworkSettings: { Networks: {}, Ports: {} } };
      this.containers.set(target, container);
      if (target === gatewayName && (this.blockedPorts.has(Number(published?.[1])) || this.failGatewayRunOnce)) {
        this.failGatewayRunOnce = false; return this.fail("Bind for selected private port failed: port is already allocated");
      }
      container.State = { Running: true, Status: "running", StartedAt: `start-${container.Id}` }; this.attach(target, container); return this.ok(container.Id);
    }
    if (args[0] === "stop") { const container = this.containers.get(name); if (!container) return this.missing(); container.State.Running = false; container.State.Status = "exited"; return this.ok(name); }
    if (args[0] === "rm") {
      if (name === gatewayName && this.failGatewayRemoveOnce) { this.failGatewayRemoveOnce = false; return this.fail("Generated gateway removal interruption"); }
      this.containers.delete(name); return this.ok(name);
    }
    if (args[0] === "start") {
      const container = this.containers.get(name); if (!container) return this.missing();
      const wasFailedCreation = container.State.Status === "created";
      container.State = { Running: true, Status: "running", StartedAt: `restart-${container.Id}` };
      // Starting a failed-created gateway is not proof that it received an endpoint.
      if (!wasFailedCreation) this.attach(name, container);
      return this.ok(name);
    }
    if (args[0] === "exec") return this.ok({ ready: true, serverId: this.protectedState.serverId, contexts: [] });
    throw new Error(`Unexpected fixture Docker command ${args.join(" ")}`);
  }
}

function installed() {
  const runner = new RecoveryDocker(), coordinator = new Coordinator(runner);
  const first = coordinator.install({ instance, release: image(), action: "setup", bindAddress: address, port: 8789 });
  return { runner, coordinator, first };
}
function preservation(runner: RecoveryDocker) {
  return { owner: structuredClone(runner.containers.get(ownerName)), protectedState: structuredClone(runner.protectedState),
    volumes: [...runner.volumes], unrelated: structuredClone(runner.unrelated), active: structuredClone(runner.config!.active), certificateSha256: runner.config!.certificateSha256 };
}
function unchanged(runner: RecoveryDocker, before: ReturnType<typeof preservation>) {
  assert.deepEqual(preservation(runner), before);
  assert(!runner.calls.some(args => ["stop", "rm"].includes(args[0]!) && args.at(-1) === ownerName), "Endpoint repair must leave the owner process running");
  assert(!runner.calls.some(args => args.some(value => value.includes("existing-podman") || value.includes("existing-legacy"))));
}

test("rerun repairs a running detached gateway using actual endpoints rather than configured port declarations", () => {
  const { runner, coordinator, first } = installed(), before = preservation(runner), old = runner.containers.get(gatewayName)!.Id;
  runner.containers.get(gatewayName)!.NetworkSettings = { Networks: {}, Ports: {} }; runner.calls = [];
  assert.equal(coordinator.endpointStatus(first.config).state, "detached");
  const repaired = coordinator.install({ instance, release: image(), action: "setup" });
  assert.equal(repaired.config.port, 8789); assert.notEqual(runner.containers.get(gatewayName)!.Id, old);
  assert.equal(coordinator.endpointStatus(repaired.config).state, "healthy"); unchanged(runner, before);
});

test("configured publication without an effective port is repairable and cannot be reported healthy", () => {
  const { runner, coordinator, first } = installed(), before = preservation(runner);
  runner.containers.get(gatewayName)!.NetworkSettings.Ports = {}; runner.calls = [];
  assert.equal(coordinator.endpointStatus(first.config).state, "unpublished");
  coordinator.install({ instance, release: image(), action: "setup" });
  assert.equal(coordinator.endpointStatus(runner.config!).state, "healthy"); unchanged(runner, before);
});

test("endpoint assessment distinguishes missing and stopped gateways from running detached remnants", () => {
  const { runner, coordinator, first } = installed(), gateway = runner.containers.get(gatewayName)!;
  gateway.State = { ...gateway.State, Running: false, Status: "exited" }; gateway.NetworkSettings = { Networks: {}, Ports: {} };
  assert.deepEqual(coordinator.endpointStatus(first.config), { state: "stopped", repairRequired: true });
  runner.containers.delete(gatewayName);
  assert.deepEqual(coordinator.endpointStatus(first.config), { state: "missing", repairRequired: true });
});

test("matching network name and port cannot authenticate an attachment to a different Docker network identity", () => {
  const { runner, coordinator, first } = installed(), before = preservation(runner);
  runner.containers.get(gatewayName)!.NetworkSettings.Networks[networkName]!.NetworkID = "d".repeat(64); runner.calls = [];
  assert.equal(coordinator.endpointStatus(first.config).state, "detached");
  coordinator.install({ instance, release: image(), action: "setup" });
  assert.equal(coordinator.endpointStatus(runner.config!).state, "healthy"); unchanged(runner, before);
});

test("an occupied-port race retains Created gateway and identity, then an explicit free port repairs only that gateway", () => {
  const runner = new RecoveryDocker(), coordinator = new Coordinator(runner); runner.blockedPorts.add(8789);
  assert.throws(() => coordinator.install({ instance, release: image(), action: "setup", bindAddress: address, port: 8789 }), /port|Docker run/i);
  assert.equal(runner.containers.get(gatewayName)!.State.Status, "created"); assert.equal(runner.config!.phase, "prepared");
  const before = preservation(runner); runner.calls = [];
  const result = coordinator.install({ instance, release: image(2), action: "setup", repairPort: 8791 });
  assert.equal(result.config.port, 8791); assert.equal(result.config.origin, `https://${address}:8791`); assert.equal(result.config.pendingPort, undefined);
  assert.equal(coordinator.endpointStatus(result.config).state, "healthy"); unchanged(runner, before);
});

test("a failed setup still occupying its requested port fails boundedly without restarting the owner", () => {
  const runner = new RecoveryDocker(), coordinator = new Coordinator(runner); runner.blockedPorts.add(8789);
  assert.throws(() => coordinator.install({ instance, release: image(), action: "setup", bindAddress: address, port: 8789 }));
  const before = preservation(runner); runner.calls = [];
  assert.throws(() => coordinator.install({ instance, release: image(), action: "setup" }), /port|Docker run/i);
  assert(runner.calls.filter(args => args[0] === "run" && args.includes(gatewayName)).length <= 1, "A bind failure must not cause an unbounded recreate loop");
  unchanged(runner, before);
});

test("healthy saved endpoints reject both implicit changes and explicit recovery-port changes without mutation", () => {
  const { runner, coordinator, first } = installed(), before = preservation(runner), gateway = structuredClone(runner.containers.get(gatewayName)); runner.calls = [];
  assert.throws(() => coordinator.install({ instance, release: image(), action: "setup", port: 8791 }));
  assert.throws(() => coordinator.install({ instance, release: image(), action: "setup", repairPort: 8791 }));
  assert.deepEqual(runner.config, first.config); assert.deepEqual(runner.containers.get(gatewayName), gateway); unchanged(runner, before);
});

test("pending port recovery survives interruption removing the old gateway and resumes without another choice", () => {
  const { runner, coordinator } = installed(), before = preservation(runner);
  runner.containers.get(gatewayName)!.NetworkSettings = { Networks: {}, Ports: {} }; runner.failGatewayRemoveOnce = true; runner.calls = [];
  assert.throws(() => coordinator.install({ instance, release: image(), action: "setup", repairPort: 8791 }), /Docker rm|interruption/i);
  assert.equal(runner.config!.phase, "prepared", "A pending repair cannot claim its target endpoint is ready");
  assert.equal(runner.config!.port, 8789); assert.equal(runner.config!.origin, `https://${address}:8789`); assert.equal(runner.config!.pendingPort, 8791);
  const result = coordinator.install({ instance, release: image(), action: "setup" });
  assert.equal(result.config.port, 8791); assert.equal(result.config.pendingPort, undefined); unchanged(runner, before);
});

test("a created target gateway after a final-save interruption is reused and its pending endpoint is committed", () => {
  const { runner, coordinator } = installed(), before = preservation(runner);
  runner.containers.get(gatewayName)!.NetworkSettings = { Networks: {}, Ports: {} }; runner.failFinalSaveOnce = true; runner.calls = [];
  assert.throws(() => coordinator.install({ instance, release: image(), action: "setup", repairPort: 8791 }), /Docker run|commit/i);
  const created = runner.containers.get(gatewayName)!.Id;
  assert.equal(runner.config!.port, 8789); assert.equal(runner.config!.pendingPort, 8791); assert.equal(runner.config!.phase, "prepared");
  const result = coordinator.install({ instance, release: image(), action: "setup" });
  assert.equal(result.config.port, 8791); assert.equal(runner.containers.get(gatewayName)!.Id, created); unchanged(runner, before);
});

test("a pending target bind failure preserves the journal and ordinary rerun completes it when available", () => {
  const { runner, coordinator } = installed(), before = preservation(runner);
  runner.containers.get(gatewayName)!.NetworkSettings = { Networks: {}, Ports: {} }; runner.blockedPorts.add(8791); runner.calls = [];
  assert.throws(() => coordinator.install({ instance, release: image(), action: "setup", repairPort: 8791 }), /port|Docker run/i);
  assert.equal(runner.config!.port, 8789); assert.equal(runner.config!.pendingPort, 8791); assert.equal(runner.config!.phase, "prepared");
  runner.blockedPorts.delete(8791);
  const result = coordinator.install({ instance, release: image(), action: "setup" });
  assert.equal(result.config.port, 8791); assert.equal(coordinator.endpointStatus(result.config).state, "healthy"); unchanged(runner, before);
});

test("a second chosen port race can be retargeted explicitly without treating the prior failed target as foreign drift", () => {
  const { runner, coordinator } = installed(), before = preservation(runner);
  runner.containers.get(gatewayName)!.NetworkSettings = { Networks: {}, Ports: {} }; runner.blockedPorts.add(8791); runner.calls = [];
  assert.throws(() => coordinator.install({ instance, release: image(), action: "setup", repairPort: 8791 }), /port|Docker run/i);
  assert.equal(runner.config!.pendingPort, 8791); assert.equal(runner.config!.phase, "prepared");
  const recovered = coordinator.install({ instance, release: image(), action: "setup", repairPort: 8792 });
  assert.equal(recovered.config.port, 8792); assert.equal(recovered.config.origin, `https://${address}:8792`);
  assert.equal(recovered.config.pendingPort, undefined); assert.equal(coordinator.endpointStatus(recovered.config).state, "healthy");
  unchanged(runner, before);
});

test("a previously authorized pending target completes even if the old endpoint becomes reachable during interruption", () => {
  const { runner, coordinator } = installed(), before = preservation(runner);
  const gateway = runner.containers.get(gatewayName)!, originalId = gateway.Id, originalNetwork = structuredClone(gateway.NetworkSettings);
  gateway.NetworkSettings = { Networks: {}, Ports: {} }; runner.failGatewayRemoveOnce = true; runner.calls = [];
  assert.throws(() => coordinator.install({ instance, release: image(), action: "setup", repairPort: 8791 }), /Docker rm|interruption/i);
  const old = runner.containers.get(gatewayName)!; old.State.Running = true; old.State.Status = "running"; old.NetworkSettings = originalNetwork;
  const resumed = coordinator.install({ instance, release: image(), action: "setup" });
  assert.equal(resumed.config.port, 8791); assert.equal(resumed.config.pendingPort, undefined);
  assert.notEqual(runner.containers.get(gatewayName)!.Id, originalId); unchanged(runner, before);
});

test("an explicit pending-port cancellation preserves a recovered healthy gateway at the saved endpoint", () => {
  const { runner, coordinator } = installed(), before = preservation(runner);
  const gateway = runner.containers.get(gatewayName)!, originalId = gateway.Id, originalNetwork = structuredClone(gateway.NetworkSettings);
  gateway.NetworkSettings = { Networks: {}, Ports: {} }; runner.failGatewayRemoveOnce = true;
  assert.throws(() => coordinator.install({ instance, release: image(), action: "setup", repairPort: 8791 }), /Docker rm|interruption/i);
  const old = runner.containers.get(gatewayName)!; old.State.Running = true; old.State.Status = "running"; old.NetworkSettings = originalNetwork; runner.calls = [];
  const resumed = coordinator.install({ instance, release: image(), action: "setup", repairPort: 8789 });
  assert.equal(resumed.config.port, 8789); assert.equal(resumed.config.origin, `https://${address}:8789`); assert.equal(resumed.config.pendingPort, undefined);
  assert.equal(runner.containers.get(gatewayName)!.Id, originalId);
  assert(!runner.calls.some(args => ["stop", "rm", "start"].includes(args[0]!)), "Cancelling to an already healthy saved endpoint must not replace any runtime");
  unchanged(runner, before);
});

test("endpoint recovery never adopts unowned or security-drifted gateways", () => {
  for (const drift of ["owner", "mount", "wildcard"] as const) {
    const { runner, coordinator } = installed(), gateway = runner.containers.get(gatewayName)!;
    if (drift === "owner") gateway.Config.Labels[INSTANCE_LABEL] = "another-instance";
    if (drift === "mount") gateway.Mounts.push({ Type: "volume", Name: "foreign-credentials", Destination: "/credentials", RW: true });
    if (drift === "wildcard") gateway.HostConfig.PortBindings["8443/tcp"] = [{ HostIp: "0.0.0.0", HostPort: "8789" }];
    gateway.NetworkSettings = { Networks: {}, Ports: {} }; runner.calls = [];
    assert.throws(() => coordinator.install({ instance, release: image(), action: "setup", repairPort: 8791 }));
    assert(!runner.calls.some(args => ["stop", "rm", "start"].includes(args[0]!)), "An ownership/isolation error is not repair permission");
  }
});
