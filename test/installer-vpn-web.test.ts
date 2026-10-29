import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstallationConfig } from "../src/installer/config.ts";
import { INSTANCE_LABEL, PRODUCT, PRODUCT_LABEL, resourceName } from "../src/installer/docker.ts";
import type { CommandResult, DockerRunner } from "../src/installer/docker.ts";
import type { ModernRelease } from "../src/installer/release.ts";
import { ensureVpnWeb, readVpnWebEndpoint } from "../src/installer/vpn-web.ts";
import { vpnWebAuthorization } from "../src/installer/container-init.ts";

const instance = "fixture-vpn-web", address = "10.77.0.8", owned = { [PRODUCT_LABEL]: PRODUCT, [INSTANCE_LABEL]: instance };
const ownerName = resourceName(instance, "owner"), webName = resourceName(instance, "vpn-web"), networkName = resourceName(instance, "network"), socketName = resourceName(instance, "read-ipc");
const authName=resourceName(instance,"vpn-auth"), generatedToken="T".repeat(43);
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
  inputs: {args:string[];input:string}[]=[];
  authVolume: {Labels:Record<string,string>}|undefined;
  registeredToken: string|undefined;
  revoked=false;
  fleets=[{scopeId:"default"}];
  knownImages=new Map<string,Fixture["image"]>();
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
  run(args: readonly string[],input?:string|Uint8Array): CommandResult {
    this.calls.push([...args]); const name = args.at(-1)!, value = (flag: string) => args[args.indexOf(flag) + 1]!;
    if(input!==undefined)this.inputs.push({args:[...args],input:typeof input==="string"?input:Buffer.from(input).toString()});
    if (args[0] === "image" && args[1] === "inspect") return this.ok([name===this.image.Id?this.image:this.knownImages.get(name)??this.image]);
    if (args[0] === "network" && args[1] === "inspect" && name === networkName) return this.ok([this.network]);
    if (args[0] === "volume" && args[1] === "inspect" && name === socketName) return this.volume ? this.ok([this.volume]) : this.missing();
    if(args[0]==="volume"&&args[1]==="inspect"&&name===authName)return this.authVolume?this.ok([this.authVolume]):this.missing();
    if(args[0]==="volume"&&args[1]==="create"&&name===authName){this.authVolume={Labels:{...owned}};return this.ok(name);}
    if (args[0] === "container" && args[1] === "inspect") {
      if (name === ownerName) return this.ok([this.owner]);
      if (name === webName) return this.web ? this.ok([this.web]) : this.missing();
    }
    if(args[0]==="run"&&args.includes("vpn-web-auth")) {
      assert.equal(value("--network"),"none");assert.equal(value("--user"),"0:0");
      assert.equal(value("--mount"),`type=volume,src=${authName},dst=/vpn-auth`);
      return this.ok({version:1,token:generatedToken});
    }
    if(args[0]==="exec") {
      assert.ok(args.includes(ownerName));
      if(name==="status")return this.ok({contexts:this.fleets});
      if(args.includes("create-fleet")){this.fleets=[{scopeId:"default"}];return this.ok({});}
      const body=JSON.parse(typeof input==="string"?input:"{}");assert.equal(body.operation,"register-vpn-web");assert.equal(body.scopeId,"default");
      if(this.revoked)return{status:1,stdout:"",stderr:"Terminal control request failed."};
      assert.ok(!this.registeredToken||this.registeredToken===body.token);this.registeredToken=body.token;return this.ok({registered:true});
    }
    if (args[0] === "run") {
      assert.equal(value("--name"), webName); const at = args.findIndex(arg=>/^sha256:/.test(arg)), binding = value("--publish").match(/^(\[[^\]]+\]|[^:]+):(\d+):8443\/tcp$/)!;
      const runtime=args[at]===this.image.Id?this.image:this.knownImages.get(args[at]!)!;this.knownImages.set(runtime.Id,structuredClone(runtime));
      const readMount = value("--mount"); assert.equal(readMount, `type=volume,src=${socketName},dst=/ipc,readonly`);
      this.web = { Id: `generated-web-container-${this.knownImages.size}`, Image: args[at]!, Config: { Labels: { ...owned, "io.gridlens.version": runtime.Config.Labels["io.gridlens.version"]!, "io.gridlens.role": "vpn-web" },
        User: value("--user"), Cmd: [...args.slice(at + 1)], Env: [...runtime.Config.Env, ...args.flatMap((arg, index) => arg === "--env" ? [args[index + 1]!] : [])],
        Entrypoint: [...runtime.Config.Entrypoint] }, HostConfig: { ReadonlyRootfs: args.includes("--read-only"), Privileged: false, NetworkMode: value("--network"),
        CapDrop: [value("--cap-drop")], CapAdd: [], SecurityOpt: [value("--security-opt")], Binds: null, PidMode: "", IpcMode: "private",
        PortBindings: { "8443/tcp": [{ HostIp: binding[1]!.replace(/^\[|\]$/g, ""), HostPort: binding[2]! }] }, RestartPolicy: { Name: value("--restart") }, PidsLimit: Number(value("--pids-limit")) },
        Mounts: args.flatMap((arg,index)=>arg==="--mount"?[args[index+1]!]:[]).map(spec=>{const fields=spec.split(",");return{Type:"volume",Name:fields.find(field=>field.startsWith("src="))!.slice(4),Destination:fields.find(field=>field.startsWith("dst="))!.slice(4),RW:!fields.includes("readonly")};}), State: { Running: true }, NetworkSettings: { Networks: {}, Ports: {} } };
      this.attach(); return this.ok(this.web.Id);
    }
    if(args[0]==="stop"&&name===webName){this.web!.State.Running=false;return this.ok(name);}
    if(args[0]==="rm"&&name===webName){this.web=undefined;return this.ok(name);}
    if (args[0] === "start" && name === webName) {
      if (this.failStart) return { status: 125, stdout: "", stderr: "Generated port allocation failure" };
      this.web!.State.Running = true; this.attach(); return this.ok(webName);
    }
    throw new Error(`Unexpected Docker command: ${args.join(" ")}`);
  }
}
function installed(port?: number) { const runner = new Fixture(), saved = config(); ensureVpnWeb(runner, saved, release, port); runner.calls = []; return { runner, saved }; }
function mutations(runner: Fixture) { return runner.calls.filter(call => ["start","stop","rm"].includes(call[0]!)||call[0]==="run"&&call.includes("--name")); }

test("browser sibling uses a protected persistent grant and read-only socket, preserving HTTPS and owner state", () => {
  const runner = new Fixture(), saved = config(), original = structuredClone({ saved, owner: runner.owner, volume: runner.volume, network: runner.network });
  assert.deepEqual(ensureVpnWeb(runner, saved, release), { origin: `http://${address}:2342`, port: 2342, imageId: release.imageId,privateNetwork:true });
  assert.deepEqual({ saved, owner: runner.owner, volume: runner.volume, network: runner.network }, original);
  assert.equal(mutations(runner).length, 1); assert.equal(mutations(runner)[0]![0], "run");
  assert.equal(runner.web!.Mounts.length, 2); assert.ok(runner.web!.Mounts.every(mount=>mount.RW===false));
  assert.equal(runner.registeredToken,generatedToken);assert.ok(runner.calls.every(call=>!call.join(" ").includes(generatedToken)));
  assert.ok(!runner.web!.Config.Env.some(value=>value.includes(generatedToken)));
  assert(!runner.calls.some(call => call.includes("/tls") || call.includes("/config") || call.includes("/state") || call.includes("/credentials")));
});

test("healthy reruns and read-only detection retain the saved alternative port and container identity", () => {
  const { runner, saved } = installed(9432), before = structuredClone(runner.web);
  assert.equal(ensureVpnWeb(runner, saved, release).port, 9432);
  assert.equal(readVpnWebEndpoint(runner, saved)!.origin, `http://${address}:9432`);
  assert.deepEqual(runner.web, before); assert.deepEqual(mutations(runner), []);
  assert.equal(runner.registeredToken,generatedToken);
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

test("explicit legacy browser upgrade preserves port and owner while registering before replacement", () => {
  const {runner,saved}=installed(9432),owner=structuredClone(runner.owner);
  runner.web!.Mounts=runner.web!.Mounts.filter(mount=>mount.Destination!=="/vpn-auth");
  runner.web!.Config.Env=runner.web!.Config.Env.filter(value=>!value.startsWith("GRIDLENS_VPN_AUTH_FILE="));
  assert.equal(readVpnWebEndpoint(runner,saved)!.privateNetwork,undefined);
  const oldImage=runner.web!.Image;
  runner.image={...structuredClone(runner.image),Id:`sha256:${"4".repeat(64)}`};
  runner.image.Config.Labels["io.gridlens.version"]="0.1.0-fixture.4";
  const next={...release,sequence:4,version:"0.1.0-fixture.4",imageId:runner.image.Id};
  assert.throws(()=>ensureVpnWeb(runner,saved,next),/explicit browser update/);
  runner.calls=[];
  const result=ensureVpnWeb(runner,saved,next,undefined,{upgrade:true});
  assert.equal(result.port,9432);assert.equal(result.privateNetwork,true);assert.equal(result.imageId,next.imageId);
  assert.deepEqual(runner.owner,owner);assert.ok(runner.knownImages.has(oldImage));
  const register=runner.calls.findIndex(call=>call[0]==="exec"&&call.at(-1)==="json");
  assert.ok(register>=0&&register<runner.calls.findIndex(call=>call[0]==="stop"));
  assert.deepEqual(mutations(runner).map(call=>call[0]),["stop","rm","run"]);
  runner.calls=[];ensureVpnWeb(runner,saved,next);assert.deepEqual(mutations(runner),[]);
});

test("revoked gateway grant and unowned authorization volume never replace the existing web gateway", () => {
  for(const change of [(runner:Fixture)=>{runner.revoked=true;},(runner:Fixture)=>{runner.authVolume!.Labels[INSTANCE_LABEL]="other";}]) {
    const {runner,saved}=installed();const before=structuredClone(runner.web);change(runner);
    assert.throws(()=>ensureVpnWeb(runner,saved,release,undefined,{upgrade:true}));
    assert.deepEqual(runner.web,before);assert.deepEqual(mutations(runner),[]);
  }
});

test("fresh private-network installation creates an empty default fleet once and older releases cannot replace newer gateways", () => {
  const runner=new Fixture();runner.fleets=[];const saved=config();ensureVpnWeb(runner,saved,release);
  assert.equal(runner.calls.filter(call=>call.includes("create-fleet")).length,1);
  runner.calls=[];ensureVpnWeb(runner,saved,release);assert.ok(!runner.calls.some(call=>call.includes("create-fleet")));
  const before=structuredClone(runner.web),next={...release,imageId:`sha256:${"4".repeat(64)}`,version:"0.1.0-fixture.4",sequence:4};
  saved.active={...saved.active,imageId:next.imageId,version:next.version,sequence:next.sequence};runner.owner.Image=next.imageId;
  runner.image={...structuredClone(runner.image),Id:next.imageId};runner.image.Config.Labels["io.gridlens.version"]=next.version;
  ensureVpnWeb(runner,saved,next,undefined,{upgrade:true});const updated=structuredClone(runner.web);runner.calls=[];
  assert.throws(()=>ensureVpnWeb(runner,saved,release,undefined,{upgrade:true}),/older than/);
  assert.deepEqual(runner.web,updated);assert.notEqual(runner.web!.Image,before!.Image);assert.deepEqual(mutations(runner),[]);
});

test("authorization file is private, persistent and never silently regenerates malformed saved content", () => {
  const directory=mkdtempSync(join(tmpdir(),"gridlens-vpn-auth-"));
  try {
    const authorization=vpnWebAuthorization(directory),path=join(directory,"browser.json"),before=statSync(path);
    assert.match(authorization.token,/^[A-Za-z0-9_-]{43}$/);assert.equal(before.mode&0o777,0o600);
    assert.equal(before.uid,1000);assert.equal(before.gid,1000);assert.equal(statSync(directory).mode&0o777,0o700);
    assert.deepEqual(vpnWebAuthorization(directory),authorization);assert.equal(statSync(path).ino,before.ino);
    writeFileSync(path,"broken");assert.throws(()=>vpnWebAuthorization(directory),/retained for recovery/);assert.equal(readFileSync(path,"utf8"),"broken");
  } finally {rmSync(directory,{recursive:true,force:true});}
});
