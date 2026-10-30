import { writeFileSync } from "node:fs";
import type { DockerRunner, CommandResult } from "../../src/installer/docker.ts";
import { PRODUCT, PRODUCT_LABEL, INSTANCE_LABEL } from "../../src/installer/docker.ts";
import type { InstallationConfig } from "../../src/installer/config.ts";
import type { ModernRelease } from "../../src/installer/release.ts";
export class UpdateDockerFixture implements DockerRunner {
  readonly calls: string[][] = []; readonly objects = new Map<string, Record<string, unknown>>();
  config: InstallationConfig | undefined; held = false; failRole = ""; serverId = "generated-fixture-server";
  readonly instance: string; readonly configPath: string; readonly images: ModernRelease[];
  readonly updaterImages: Set<string>;
  constructor(instance: string, configPath: string, images: ModernRelease[]) { this.instance = instance; this.configPath = configPath; this.images = images; this.updaterImages = new Set(images.map(image => image.imageId)); }
  save(config: InstallationConfig): void { this.config = structuredClone(config); writeFileSync(this.configPath, JSON.stringify(config)); }
  async hold(): Promise<() => Promise<void>> { if (this.held) throw new Error("Lock held"); this.held = true; return async () => { this.held = false; }; }
  run(args: readonly string[], input?: string | Uint8Array): CommandResult {
    this.calls.push([...args]); const at = (flag: string): string => args[args.indexOf(flag) + 1]!, name = args.at(-1)!;
    const ok = (value: unknown = ""): CommandResult => ({ status: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
    const missing = { status: 1, stdout: "", stderr: "No such object" };
    const owned = { [PRODUCT_LABEL]: PRODUCT, [INSTANCE_LABEL]: this.instance };
    const release = (id: string) => this.images.find(value => value.imageId === id)!;
    if (args[0] === "version" || args[0] === "load") return ok("29.7.2");
    if (args[0] === "image" && args[1] === "inspect") {
      const image = release(name); return image ? ok([{ Id: image.imageId, Os: "linux", Architecture: image.platform === "linux-arm64" ? "arm64" : "amd64",
        Config: { Labels: { [PRODUCT_LABEL]: PRODUCT, "io.gridlens.version": image.version,
        ...(this.updaterImages.has(image.imageId) ? { "io.gridlens.updater-protocol": "1" } : {}) }, Env: ["PATH=/fixture"], Entrypoint: null } }])
        : { ...missing, stderr: `Error response from daemon: No such image: ${name}` };
    }
    if (["volume", "network", "container"].includes(args[0]!) && args[1] === "inspect") {
      const item = this.objects.get(`${args[0]}:${name}`); return item ? ok([item]) : missing;
    }
    if (["volume", "network"].includes(args[0]!) && args[1] === "create") {
      this.objects.set(`${args[0]}:${name}`, { Id: `fixture-${name}`, Driver: "bridge", Labels: owned }); return ok(name);
    }
    if (args[0] === "run" && args.includes("src/installer/container-init.ts")) {
      const body = JSON.parse(typeof input === "string" ? input : "{}");
      if (name === "read") return ok(this.config ?? null);
      if (name === "initialize") { this.save({ schema: 1, instance: this.instance, bindAddress: body.bindAddress, port: body.port, origin: body.origin,
        certificateSha256: "a".repeat(64), phase: "prepared", active: body.active }); return ok(this.config); }
      if (name === "save") { this.save(body); return ok({ saved: true }); }
      if (name === "copy-state" || name === "updater-initialize") return ok({ done: true });
      if (name === "certificate") return ok("PUBLIC FIXTURE CERTIFICATE");
      if (name === "vpn-web-auth") return ok({ version: 1, token: "T".repeat(43) });
    }
    if (args[0] === "run" && args.includes("-e")) {
      const image = release(args.find(value => value.startsWith("sha256:"))!);
      return ok({ version: image.version, sequence: image.sequence, buildId: `${image.sequence}:${image.version}` });
    }
    if (args[0] === "run") {
      const containerName = at("--name");
      if (this.failRole && containerName.endsWith(this.failRole)) { this.failRole = ""; return { status: 1, stdout: "", stderr: "Fixture start interrupted" }; }
      const imageAt = args.findIndex(value => value.startsWith("sha256:")), image = release(args[imageAt]!);
      const mounts = args.flatMap((value, i) => value === "--mount" ? [args[i + 1]!] : []).map(spec => {
        const fields = Object.fromEntries(spec.split(",").map(part => part.split("=")));
        return { Type: fields.type, ...(fields.type === "bind" ? { Source: fields.src } : { Name: fields.src }), Destination: fields.dst, RW: !spec.includes(",readonly") };
      });
      const publish = args.includes("--publish") ? at("--publish").split(":") : null;
      const ports = publish ? { "8443/tcp": [{ HostIp: publish[0], HostPort: publish[1] }] } : {};
      const extraLabels = Object.fromEntries(args.flatMap((value, i) => value === "--label" ? [args[i + 1]!.split("=")] : []));
      this.objects.set(`container:${containerName}`, { Id: `fixture-${containerName}`, Image: image.imageId,
        Config: { Labels: { ...owned, "io.gridlens.version": image.version, ...extraLabels }, User: at("--user"), Cmd: args.slice(imageAt + 1),
          Env: ["PATH=/fixture", ...args.flatMap((value, i) => value === "--env" ? [args[i + 1]!] : [])], Entrypoint: null },
        HostConfig: { ReadonlyRootfs: true, Privileged: false, NetworkMode: at("--network"), CapDrop: ["ALL"], CapAdd: [], SecurityOpt: ["no-new-privileges:true"],
          Binds: null, PidMode: "", IpcMode: "private", PortBindings: ports, RestartPolicy: { Name: args.includes("--restart") ? at("--restart") : "no" }, PidsLimit: 128 }, Mounts: mounts, State: { Running: true },
        NetworkSettings: { Networks: { [at("--network")]: { NetworkID: `fixture-${at("--network")}`, EndpointID: "fixture-endpoint", IPAddress: "172.30.0.2" } }, Ports: ports } });
      return ok(containerName);
    }
    if (args[0] === "stop" || args[0] === "start") { this.objects.get(`container:${name}`)!.State = { Running: args[0] === "start" }; return ok(); }
    if (args[0] === "rm") { this.objects.delete(`container:${name}`); return ok(); }
    if (args[0] === "exec") {
      if (name === "status") return ok({ contexts: [{ scopeId: "default", addresses: [] }] });
      const body = typeof input === "string" ? JSON.parse(input) : {};
      if (body.operation === "readiness") return ok({ status: "ready", serverId: this.serverId,
        build: { version: this.config!.active.version, sequence: this.config!.active.sequence, buildId: `${this.config!.active.sequence}:${this.config!.active.version}` } });
      return ok({ done: true });
    }
    throw new Error(`Unexpected fixture operation ${args[0]}`);
  }
}
