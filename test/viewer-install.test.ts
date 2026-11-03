import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import type { DockerRunner } from "../src/installer/docker.ts";
import type { ModernRelease } from "../src/installer/release.ts";
import { installViewer, readViewerInstallation, resumeViewerInstallation, VIEWER_PRODUCT } from "../src/installer/viewer-install.ts";
import type { ViewerClientConfiguration } from "../src/backend/viewer-client.ts";

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "gridlens-viewer-install-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "generated.key", "-out", "generated.crt", "-days", "1",
    "-subj", "/CN=Generated installer fixture", "-addext", "basicConstraints=critical,CA:TRUE"], { cwd: root, stdio: "ignore" });
  const config: ViewerClientConfiguration = { version: 1, ownerOrigin: "https://10.0.0.2:8790", serverId: "generated-owner", scopeId: "generated-scope",
    caCertificatePem: fs.readFileSync(join(root, "generated.crt"), "utf8"), serverCertificateSha256: "a".repeat(64), token: crypto.randomBytes(32).toString("base64url") };
  const image: ModernRelease = { format: "gridlens-modern-release-v1", version: "0.1.0-viewer-fixture", sequence: 23, platform: "linux-x64", minimumCoordinator: 3,
    imageId: "sha256:" + "1".repeat(64), runtime: { name: "gridlens-runtime-fixture.tar", bytes: 1, sha256: "1".repeat(64) } };
  const objects = new Map<string, any>(), calls: { args: string[]; input?: string | Uint8Array }[] = []; let failCreation = false;
  const imageEnvironment = ["PATH=/usr/local/bin:/usr/bin:/bin", "GRIDLENS_TREASURY_PROTOCOL=2", "GRIDLENS_FINANCIAL_SECURITY_FLOOR=0"];
  const values = (args: readonly string[], flag: string) => args.flatMap((value, index) => value === flag ? [args[index + 1]!] : []);
  const labels = (args: readonly string[]) => Object.fromEntries(values(args, "--label").map(value => { const at = value.indexOf("="); return [value.slice(0, at), value.slice(at + 1)]; }));
  const success = (value: unknown = "") => ({ status: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
  const runner: DockerRunner = { run(args, input) {
    calls.push({ args: [...args], ...(input === undefined ? {} : { input }) });
    if (args[0] === "image" && args[1] === "inspect") return success([{ Id: image.imageId, Os: "linux", Architecture: "amd64", Config: { Env: imageEnvironment, Labels: { "io.gridlens.product": "shared-backend", "io.gridlens.version": image.version } } }]);
    if (args[1] === "inspect") { const item = objects.get(`${args[0]}:${args[2]}`); return item ? success([item]) : { status: 1, stdout: "", stderr: `Error: No such ${args[0]}: ${args[2]}` }; }
    if (args[1] === "create" && ["volume", "network"].includes(args[0]!)) {
      const name = args.at(-1)!, metadata = { Name: name, Id: `generated-${name}`, Labels: labels(args), ...(args[0] === "network" ? { Driver: "bridge" } : {}) };
      objects.set(`${args[0]}:${name}`, metadata); if (args[0] === "volume") fs.mkdirSync(join(root, name)); return success(name);
    }
    if (args[0] === "run" && args.includes("--rm")) {
      const mount = values(args, "--mount")[0]!, volume = /src=([^,]+)/.exec(mount)![1]!, volumeRoot = join(root, volume);
      const map = (value: unknown) => typeof value === "string" && (value === "/viewer" || value.startsWith("/viewer/")) ? volumeRoot + value.slice(7) : value;
      const fakeFs = new Proxy(fs, { get(target, name) {
        if (name === "readFileSync") return (path: unknown, ...rest: unknown[]) => path === 0 ? Buffer.from(input as string) : Reflect.apply(target.readFileSync, target, [map(path), ...rest]);
        const value = Reflect.get(target, name);
        if (typeof value !== "function") return value;
        return (...params: unknown[]) => Reflect.apply(value, target, name === "renameSync" ? params.map(map) : [map(params[0]), ...params.slice(1)]);
      } });
      let stdout = "", stderr = ""; const process = { exitCode: 0, stdout: { write: (value: string) => { stdout += value; } }, stderr: { write: (value: string) => { stderr += value; } } };
      runInNewContext(args.at(-1)!, { require: (name: string) => name === "node:fs" ? fakeFs : crypto, process, Buffer }, { timeout: 1000 });
      return { status: process.exitCode, stdout, stderr };
    }
    if (args[0] === "run" && args.includes("--detach")) {
      if (failCreation) return { status: 1, stdout: "", stderr: "Generated interrupted gateway creation" };
      const name = values(args, "--name")[0]!, network = values(args, "--network")[0]!, mount = values(args, "--mount")[0]!;
      const volume = /src=([^,]+)/.exec(mount)![1]!, published = values(args, "--publish")[0]!.split(":");
      const port = [{ HostIp: published[0], HostPort: published[1] }];
      const overrides = values(args, "--env"), keys = new Set(overrides.map(value => value.split("=", 1)[0]));
      const environment = [...imageEnvironment.filter(value => !keys.has(value.split("=", 1)[0])), ...overrides];
      objects.set(`container:${name}`, { Id: "c".repeat(64), Name: `/${name}`, Image: image.imageId, State: { Running: true },
        Config: { Labels: labels(args), User: values(args, "--user")[0], Cmd: ["scripts/shared-viewer.ts"], Entrypoint: [values(args, "--entrypoint")[0]], Env: environment },
        HostConfig: { ReadonlyRootfs: true, Privileged: false, NetworkMode: network, CapAdd: null, CapDrop: ["ALL"], Binds: null, VolumesFrom: null,
          Devices: [], DeviceRequests: null, PidMode: "", IpcMode: "private", UTSMode: "", PublishAllPorts: false, SecurityOpt: ["no-new-privileges:true"], PidsLimit: 128,
          RestartPolicy: { Name: "unless-stopped" }, PortBindings: { "8080/tcp": port } },
        Mounts: [{ Type: "volume", Name: volume, Destination: "/viewer", RW: false }],
        NetworkSettings: { Networks: { [network]: { NetworkID: objects.get(`network:${network}`).Id } }, Ports: { "8080/tcp": port } } });
      return success("c".repeat(64));
    }
    if (args[0] === "start") { objects.get(`container:${args[1]}`).State.Running = true; return success(args[1]); }
    throw new Error(`Unexpected generated Docker operation ${args[0]} ${args[1]}`);
  } };
  const options = { runner, image, config, instance: "generated-viewer", bindAddress: "10.0.0.9", port: 18890,
    probe: async (origin: string) => { assert.equal(origin, "http://10.0.0.9:18890"); } };
  return { root, config, image, runner, calls, objects, options, failCreation(value: boolean) { failCreation = value; }, close() { fs.rmSync(root, { recursive: true, force: true }); } };
}
test("viewer install runs only a distinct gateway with one readonly credential volume and no privileged runtime mounts", async () => {
  const f = fixture();
  try {
    const result = await installViewer(f.options); assert.equal(result.ready, true); assert.equal(result.origin, "http://10.0.0.9:18890");
    assert.equal(JSON.stringify(result).includes(f.config.token), false);
    assert.deepEqual(readViewerInstallation(f.runner, f.options.instance), result);
    const gateway = f.calls.find(call => call.args.includes("--detach"))!;
    assert.ok(gateway.args.includes(`io.gridlens.product=${VIEWER_PRODUCT}`));
    assert.ok(gateway.args.includes(`type=volume,src=${result.volumeName},dst=/viewer,readonly`));
    assert.ok(gateway.args.includes("GRIDLENS_TREASURY_PROTOCOL=0"));
    const environment = f.objects.get(`container:${result.containerName}`).Config.Env as string[];
    assert.ok(environment.includes("GRIDLENS_TREASURY_PROTOCOL=0")); assert.ok(!environment.includes("GRIDLENS_TREASURY_PROTOCOL=2"));
    assert.ok(environment.includes("GRIDLENS_FINANCIAL_SECURITY_FLOOR=0"));
    assert.ok(!gateway.args.some(value => /docker\.sock|treasury.sock|read.sock|\/credentials|\/ledger|\/tls|--privileged|SYS_MODULE/.test(value)));
    assert.ok(f.calls.every(call => !call.args.join(" ").includes(f.config.token)), "viewer bearer travels only through the private helper stdin");
    const before = f.calls.filter(call => call.args.includes("--detach")).length;
    await installViewer(f.options); assert.equal(f.calls.filter(call => call.args.includes("--detach")).length, before);
    const saved = fs.readFileSync(join(f.root, result.volumeName, "client.json"), "utf8");
    assert.equal(JSON.parse(saved).token, f.config.token); assert.equal(fs.statSync(join(f.root, result.volumeName, "client.json")).mode & 0o777, 0o600);
  } finally { f.close(); }
});
test("viewer inspection rejects a financial role or financial socket even with a protected base image", async () => {
  const f = fixture();
  try {
    const result = await installViewer(f.options), gateway = f.objects.get(`container:${result.containerName}`);
    const original = [...gateway.Config.Env] as string[];
    gateway.Config.Env = original.map(value => value === "GRIDLENS_TREASURY_PROTOCOL=0" ? "GRIDLENS_TREASURY_PROTOCOL=2" : value);
    assert.throws(() => readViewerInstallation(f.runner, f.options.instance));
    gateway.Config.Env = [...original, "GRIDLENS_TREASURY_SOCKET=/treasury/treasury.sock"];
    assert.throws(() => readViewerInstallation(f.runner, f.options.instance));
    gateway.Config.Env = original.map(value => value === "GRIDLENS_FINANCIAL_SECURITY_FLOOR=0" ? "GRIDLENS_FINANCIAL_SECURITY_FLOOR=2" : value);
    assert.throws(() => readViewerInstallation(f.runner, f.options.instance));
    gateway.Config.Env = [...original, "GRIDLENS_FINANCIAL_SECURITY_FLOOR=unknown"];
    assert.throws(() => readViewerInstallation(f.runner, f.options.instance));
  } finally { f.close(); }
});
test("interrupted gateway creation resumes the persisted viewer token and endpoint without invite redemption", async () => {
  const f = fixture();
  try {
    f.failCreation(true); await assert.rejects(installViewer(f.options));
    const before = f.calls.filter(call => call.args.includes("--interactive")).length;
    const credential = fs.readFileSync(join(f.root, "gridlens-viewer-generated-viewer-config", "client.json"), "utf8");
    f.failCreation(false); const result = await resumeViewerInstallation(f.runner, { image: f.image, instance: f.options.instance, probe: f.options.probe });
    assert.equal(result?.ready, true); assert.equal(fs.readFileSync(join(f.root, result!.volumeName, "client.json"), "utf8"), credential);
    assert.equal(f.calls.filter(call => call.args.includes("--interactive")).length, before + 1, "idempotent writer verifies exact existing bytes");
    const container = f.objects.get(`container:${result!.containerName}`); container.State.Running = false;
    await resumeViewerInstallation(f.runner, { image: f.image, instance: f.options.instance, probe: f.options.probe });
    assert.equal(container.State.Running, true); assert.ok(f.calls.some(call => call.args[0] === "start"));
  } finally { f.close(); }
});
test("viewer rerun refuses changed credentials, endpoint, mounts or foreign resources without replacement", async () => {
  const f = fixture();
  try {
    const result = await installViewer(f.options), path = join(f.root, result.volumeName, "client.json"), before = fs.readFileSync(path);
    await assert.rejects(installViewer({ ...f.options, config: { ...f.config, token: crypto.randomBytes(32).toString("base64url") } }));
    await assert.rejects(installViewer({ ...f.options, port: 18891 })); assert.deepEqual(fs.readFileSync(path), before);
    const gateway = f.objects.get(`container:${result.containerName}`); gateway.Mounts.push({ Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock", RW: true });
    const calls = f.calls.length; await assert.rejects(resumeViewerInstallation(f.runner, { image: f.image, instance: f.options.instance, probe: f.options.probe }));
    assert.ok(!f.calls.slice(calls).some(call => ["run", "start", "rm", "stop"].includes(call.args[0]!)));
    gateway.Mounts.pop(); gateway.Config.Labels["io.gridlens.product"] = "shared-backend";
    assert.throws(() => readViewerInstallation(f.runner, f.options.instance), /unrelated/);
  } finally { f.close(); }
});
test("absent viewer resume is read-only and public UI addresses are refused", async () => {
  const f = fixture();
  try {
    assert.equal(await resumeViewerInstallation(f.runner, { image: f.image, instance: f.options.instance, probe: f.options.probe }), undefined);
    assert.ok(f.calls.every(call => call.args[1] === "inspect"));
    await assert.rejects(installViewer({ ...f.options, bindAddress: "8.8.8.8" }));
    assert.ok(!f.calls.some(call => ["create", "run", "start"].includes(call.args[0]!)));
  } finally { f.close(); }
});
