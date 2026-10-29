import assert from "node:assert/strict";
import test from "node:test";
import type { InstallationConfig } from "../src/installer/config.ts";
import { INSTANCE_LABEL, PRODUCT, PRODUCT_LABEL, resourceName } from "../src/installer/docker.ts";
import type { CommandResult, DockerRunner } from "../src/installer/docker.ts";
import type { ModernRelease } from "../src/installer/release.ts";
import { ensureVpnWeb, readVpnWebEndpoint } from "../src/installer/vpn-web.ts";

const instance = "fixture-vpn-web", address = "10.77.0.8", owned = { [PRODUCT_LABEL]: PRODUCT, [INSTANCE_LABEL]: instance };
const ownerName = resourceName(instance, "owner"), webName = resourceName(instance, "vpn-web"), networkName = resourceName(instance, "network"), socketName = resourceName(instance, "read-ipc");
const release: ModernRelease = { format: "gridlens-modern-release-v1", version: "0.1.0-fixture.2", sequence: 2, platform: "linux-x64", minimumCoordinator: 1,
  imageId: `sha256:${"2".repeat(64)}`, runtime: { name: "gridlens-runtime-fixture.tar", bytes: 1, sha256: "3".repeat(64) } };
function config(): InstallationConfig { return { schema: 1, instance, bindAddress: address, port: 2341, origin: `https://${address}:2341`, phase: "ready",
  certificateSha256: "a".repeat(64), active: { imageId: `sha256:${"1".repeat(64)}`, version: "0.1.0-fixture.1", sequence: 1, stateVolume: resourceName(instance, "state-1-generated") } }; }
type Container = { Id: string; Image: string; Config: { Labels: Record<string, string>; User: string; Cmd: string[]; Env: string[]; Entrypoint: string[] };
  HostConfig: { ReadonlyRootfs: boolean; Privileged: boolean; NetworkMode: string; CapDrop: string[]; CapAdd: string[]; SecurityOpt: string[];
    Binds: null; PidMode: string; IpcMode: string; PortBindings: Record<string, { HostIp: string; HostPort: string }[]>; RestartPolicy: { Name: string }; PidsLimit: number };
  Mounts: { Type: string; Name: string; Destination: string; RW: boolean }[]; State: { Running: boolean };
  NetworkSettings: { Networks: Record<string, { NetworkID: string; EndpointID: string; IPAddress: string }>; Ports: Record<string, { HostIp: string; HostPort: string }[]> } };
class Fixture implements DockerRunner {
  calls: string[][] = [];
  web: Container | undefined;
  failStart = false;
  failPublication = false;
  image = { Id: release.imageId, Config: { Labels: { [PRODUCT_LABEL]: PRODUCT, "io.gridlens.version": release.version }, Env: ["PATH=/fixture/bin"], Entrypoint: ["docker-entrypoint.sh"] } };
  owner = { Id: "generated-existing-owner", Image: config().active.imageId, Config: { Labels: owned, Cmd: ["node", "scripts/shared-owner.ts"] },
    HostConfig: { NetworkMode: networkName }, Mounts: [{ Type: "volume", Name: socketName, Destination: "/ipc", RW: true }], State: { Running: true } };
  network = { Id: "f".repeat(64), Driver: "bridge", Labels: { ...owned } };
  volume: { Labels: Record<string, string> } | undefined = { Labels: { ...owned } };
  private ok(value: unknown): CommandResult { return { status: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" }; }
  private missing(): CommandResult { return { status: 1, stdout: "", stderr: "No such object" }; }
  attach(): void {
    this.web!.NetworkSettings = { Networks: { [networkName]: { NetworkID: this.network.Id, EndpointID: "e".repeat(64), IPAddress: "172.30.0.3" } },
      Ports: this.failPublication ? {} : structuredClone(this.web!.HostConfig.PortBindings) };
  }
  run(args: readonly string[]): CommandResult {
    this.calls.push([...args]); const name = args.at(-1)!, value = (flag: string) => args[args.indexOf(flag) + 1]!;
    if (args[0] === "image" && args[1] === "inspect") return this.ok([this.image]);
    if (args[0] === "network" && args[1] === "inspect" && name === networkName) return this.ok([this.network]);
    if (args[0] === "volume" && args[1] === "inspect" && name === socketName) return this.volume ? this.ok([this.volume]) : this.missing();
    if (args[0] === "container" && args[1] === "inspect") {
      if (name === ownerName) return this.ok([this.owner]);
      if (name === webName) return this.web ? this.ok([this.web]) : this.missing();
    }
    if (args[0] === "run") {
      assert.equal(value("--name"), webName); const at = args.indexOf(release.imageId), binding = value("--publish").match(/^(\[[^\]]+\]|[^:]+):(\d+):8443\/tcp$/)!;
      const readMount = value("--mount"); assert.equal(readMount, `type=volume,src=${socketName},dst=/ipc,readonly`);
      this.web = { Id: "generated-web-container", Image: args[at]!, Config: { Labels: { ...owned, "io.gridlens.version": release.version, "io.gridlens.role": "vpn-web" },
        User: value("--user"), Cmd: [...args.slice(at + 1)], Env: [...this.image.Config.Env, ...args.flatMap((arg, index) => arg === "--env" ? [args[index + 1]!] : [])],
        Entrypoint: [...this.image.Config.Entrypoint] }, HostConfig: { ReadonlyRootfs: args.includes("--read-only"), Privileged: false, NetworkMode: value("--network"),
        CapDrop: [value("--cap-drop")], CapAdd: [], SecurityOpt: [value("--security-opt")], Binds: null, PidMode: "", IpcMode: "private",
        PortBindings: { "8443/tcp": [{ HostIp: binding[1]!.replace(/^\[|\]$/g, ""), HostPort: binding[2]! }] }, RestartPolicy: { Name: value("--restart") }, PidsLimit: Number(value("--pids-limit")) },
        Mounts: [{ Type: "volume", Name: socketName, Destination: "/ipc", RW: false }], State: { Running: true }, NetworkSettings: { Networks: {}, Ports: {} } };
      this.attach(); return this.ok(this.web.Id);
    }
    if (args[0] === "start" && name === webName) {
      if (this.failStart) return { status: 125, stdout: "", stderr: "Generated port allocation failure" };
      this.web!.State.Running = true; this.attach(); return this.ok(webName);
    }
    throw new Error(`Unexpected Docker command: ${args.join(" ")}`);
  }
}
function installed(port?: number) { const runner = new Fixture(), saved = config(); ensureVpnWeb(runner, saved, release, port); runner.calls = []; return { runner, saved }; }
function mutations(runner: Fixture) { return runner.calls.filter(call => !["image", "container", "volume", "network"].includes(call[0]!)); }

test("browser sibling uses the private HTTP endpoint and only the existing read-only socket, preserving HTTPS and owner state", () => {
  const runner = new Fixture(), saved = config(), original = structuredClone({ saved, owner: runner.owner, volume: runner.volume, network: runner.network });
  assert.deepEqual(ensureVpnWeb(runner, saved, release), { origin: `http://${address}:2342`, port: 2342, imageId: release.imageId });
  assert.deepEqual({ saved, owner: runner.owner, volume: runner.volume, network: runner.network }, original);
  assert.equal(mutations(runner).length, 1); assert.equal(mutations(runner)[0]![0], "run");
  assert.equal(runner.web!.Mounts.length, 1); assert.equal(runner.web!.Mounts[0]!.RW, false);
  assert(!runner.calls.some(call => call.includes("/tls") || call.includes("/config") || call.includes("/state") || call.includes("/credentials")));
});

test("healthy reruns and read-only detection retain the saved alternative port and container identity", () => {
  const { runner, saved } = installed(9432), before = structuredClone(runner.web);
  assert.equal(ensureVpnWeb(runner, saved, release).port, 9432);
  assert.equal(readVpnWebEndpoint(runner, saved)!.origin, `http://${address}:9432`);
  assert.deepEqual(runner.web, before); assert.deepEqual(mutations(runner), []);
  assert.throws(() => ensureVpnWeb(runner, saved, release, 9433), /saved port/); assert.deepEqual(runner.web, before);
});

test("a stopped owned sibling resumes without changing the owner, HTTPS config or endpoint", () => {
  const { runner, saved } = installed(); runner.web!.State.Running = false; runner.web!.NetworkSettings = { Networks: {}, Ports: {} };
  const owner = structuredClone(runner.owner), before = structuredClone(saved), id = runner.web!.Id;
  assert.throws(() => readVpnWebEndpoint(runner, saved), /not reachable/); assert.deepEqual(mutations(runner), []);
  ensureVpnWeb(runner, saved, release); assert.deepEqual(mutations(runner), [["start", webName]]);
  assert.equal(runner.web!.Id, id); assert.deepEqual(runner.owner, owner); assert.deepEqual(saved, before);
});

test("changed ownership, mounts, ports, environment and isolation are refused before any mutation", () => {
  const changes: ((container: Container) => void)[] = [
    container => { container.Config.Labels[INSTANCE_LABEL] = "other"; }, container => { container.Config.Labels["io.gridlens.role"] = "owner"; },
    container => { container.Mounts[0]!.RW = true; }, container => { container.Mounts.push({ Type: "bind", Name: "", Destination: "/host", RW: true }); },
    container => { container.HostConfig.PortBindings["8443/tcp"]![0]!.HostIp = "0.0.0.0"; },
    container => { container.HostConfig.PortBindings["8443/tcp"]![0]!.HostPort = "9876"; },
    container => { container.Config.Env.push("NODE_OPTIONS=--require=/generated/injected.js"); },
    container => { container.Config.Env = container.Config.Env.map(value => value.startsWith("GRIDLENS_PUBLIC_ORIGIN=") ? "GRIDLENS_PUBLIC_ORIGIN=http://10.77.0.9:2342" : value); },
    container => { container.HostConfig.Privileged = true; }, container => { container.HostConfig.PidMode = "host"; },
    container => { container.HostConfig.CapAdd = ["SYS_ADMIN"]; }, container => { container.Config.User = "0:0"; },
    container => { container.HostConfig.ReadonlyRootfs = false; }, container => { container.Config.Cmd = ["sh"]; },
    container => { container.Config.Entrypoint = ["sh"]; }, container => { container.HostConfig.SecurityOpt = ["no-new-privileges:false"]; },
  ];
  for (const change of changes) {
    const { runner, saved } = installed(); change(runner.web!); const before = structuredClone(runner.web);
    assert.throws(() => ensureVpnWeb(runner, saved, release)); assert.throws(() => readVpnWebEndpoint(runner, saved));
    assert.deepEqual(mutations(runner), []); assert.deepEqual(runner.web, before);
  }
});

test("actual Docker networking and publication are required before reporting a working URL", () => {
  for (const change of [(runner: Fixture) => { runner.web!.NetworkSettings.Networks[networkName]!.NetworkID = "d".repeat(64); },
    (runner: Fixture) => { runner.web!.NetworkSettings.Ports = {}; }, (runner: Fixture) => { runner.web!.NetworkSettings.Networks = {}; }]) {
    const { runner, saved } = installed(); change(runner);
    assert.throws(() => ensureVpnWeb(runner, saved, release), /not reachable/); assert.throws(() => readVpnWebEndpoint(runner, saved), /not reachable/);
    assert.deepEqual(mutations(runner), []);
  }
  const runner = new Fixture(); runner.failPublication = true;
  assert.throws(() => ensureVpnWeb(runner, config(), release), /not reachable/); assert.equal(mutations(runner).length, 1);
});

test("missing or unowned dependencies and stopped owner never trigger resource creation", () => {
  for (const change of [(runner: Fixture) => { runner.volume = undefined; }, (runner: Fixture) => { runner.volume!.Labels[INSTANCE_LABEL] = "other"; },
    (runner: Fixture) => { runner.network.Labels[INSTANCE_LABEL] = "other"; }, (runner: Fixture) => { runner.owner.State.Running = false; },
    (runner: Fixture) => { runner.owner.Image = release.imageId; }, (runner: Fixture) => { runner.owner.Mounts[0]!.Name = "unrelated-socket"; }]) {
    const runner = new Fixture(); change(runner); assert.throws(() => ensureVpnWeb(runner, config(), release)); assert.deepEqual(mutations(runner), []);
  }
});

test("selected image and version are verified, while a saved sibling is never implicitly upgraded", () => {
  for (const change of [(runner: Fixture) => { runner.image.Id = `sha256:${"5".repeat(64)}`; },
    (runner: Fixture) => { runner.image.Config.Labels[PRODUCT_LABEL] = "other"; }, (runner: Fixture) => { runner.image.Config.Labels["io.gridlens.version"] = "0.1.0-other"; }]) {
    const runner = new Fixture(); change(runner); assert.throws(() => ensureVpnWeb(runner, config(), release), /image/); assert.deepEqual(mutations(runner), []);
  }
  const { runner, saved } = installed(), before = structuredClone(runner.web);
  runner.image.Id = `sha256:${"6".repeat(64)}`; runner.image.Config.Labels["io.gridlens.version"] = "0.1.0-fixture.3";
  assert.throws(() => ensureVpnWeb(runner, saved, { ...release, imageId: runner.image.Id, version: "0.1.0-fixture.3", sequence: 3 }), /different release/);
  assert.deepEqual(runner.web, before); assert.deepEqual(mutations(runner), []);
});

test("absent sibling is read-only and invalid ports or incomplete installation do not create one", () => {
  const runner = new Fixture(); assert.equal(readVpnWebEndpoint(runner, config()), undefined); assert.deepEqual(mutations(runner), []);
  const loopback = { ...config(), bindAddress: "127.0.0.1", origin: "https://127.0.0.1:2341" };
  assert.equal(readVpnWebEndpoint(runner, loopback), undefined, "An ordinary HTTPS fixture without a sibling stays compatible");
  assert.throws(() => ensureVpnWeb(runner, loopback, release), /private LAN or VPN/);
  for (const port of [0, 1023, 65536, 2341, 2342.5]) assert.throws(() => ensureVpnWeb(runner, config(), release, port));
  assert.throws(() => ensureVpnWeb(runner, { ...config(), phase: "applying" }, release), /recovery/);
  assert.throws(() => ensureVpnWeb(runner, { ...config(), pendingPort: 2343 }, release), /recovery/);
  assert.deepEqual(mutations(runner), []);
});
