import { randomBytes } from "node:crypto";
import { checked, ensureVolume, inspectOwned, labels, mount, resourceName, restrictions, PRODUCT_LABEL, PRODUCT } from "./docker.ts";
import type { DockerRunner } from "./docker.ts";
import { originFor, validateInstallation } from "./config.ts";
import type { InstallationConfig, InstalledImage } from "./config.ts";
import { InstallerError } from "./release.ts";
import type { ModernRelease } from "./release.ts";

export interface InstallOptions {
  instance: string;
  release: ModernRelease;
  action: "setup" | "upgrade" | "rollback";
  bindAddress?: string;
  port?: number;
  certificate?: { certificate: string; privateKey: string };
}
export interface InstallResult { config: InstallationConfig; retainedNewer: boolean; certificate: string }
export class Coordinator {
  readonly runner: DockerRunner;
  constructor(runner: DockerRunner) { this.runner = runner; }
  private helper(instance: string, imageId: string, operation: string, body: unknown = {}, extra: string[] = []): string {
    return checked(this.runner, ["run", "--rm", "-i", ...labels(instance), ...restrictions,
      "--network", "none", "--user", "0:0", "--cap-add", "CHOWN", "--cap-add", "FOWNER", "--cap-add", "DAC_OVERRIDE",
      ...mount(resourceName(instance, "config"), "/config"), ...mount(resourceName(instance, "tls"), "/tls"),
      ...extra, imageId, "node", "src/installer/container-init.ts", operation], JSON.stringify(body));
  }
  private save(config: InstallationConfig): void { this.helper(config.instance, config.active.imageId, "save", config); }
  private removeRuntime(instance: string): void {
    for (const role of ["gateway", "owner"]) {
      const name = resourceName(instance, role);
      if (!inspectOwned(this.runner, "container", name, instance)) continue;
      checked(this.runner, ["stop", "--time", "30", name]);
      checked(this.runner, ["rm", name]);
    }
  }
  private startRuntime(config: InstallationConfig): void {
    const { instance, active, origin } = config;
    const common = ["--detach", "--restart", "unless-stopped", ...restrictions, "--user", "1000:1000",
      ...labels(instance), "--network", resourceName(instance, "network")];
    const ownerArgs = ["run", ...common, "--name", resourceName(instance, "owner"),
      ...mount(active.stateVolume, "/state"), ...mount(resourceName(instance, "ledger"), "/ledger"),
      ...mount(resourceName(instance, "read-ipc"), "/ipc"), ...mount(resourceName(instance, "control-ipc"), "/control"),
      ...mount(resourceName(instance, "credentials"), "/credentials"),
      "--env", "GRIDLENS_STATE_DIR=/state", "--env", "GRIDLENS_LEDGER_DIR=/ledger", "--env", "GRIDLENS_SOCKET_DIR=/ipc",
      "--env", "GRIDLENS_CONTROL_DIR=/control", "--env", "GRIDLENS_CREDENTIAL_DIR=/credentials",
      active.imageId, "node", "scripts/shared-owner.ts"];
    const bind = config.bindAddress.includes(":") ? `[${config.bindAddress}]` : config.bindAddress;
    const gatewayArgs = ["run", ...common, "--name", resourceName(instance, "gateway"),
      ...mount(resourceName(instance, "read-ipc"), "/ipc", true), ...mount(resourceName(instance, "tls"), "/tls", true),
      "--publish", `${bind}:${config.port}:8443/tcp`, "--env", "GRIDLENS_SOCKET=/ipc/read.sock",
      "--env", "GRIDLENS_TLS_CERT=/tls/server.crt", "--env", "GRIDLENS_TLS_KEY=/tls/server.key",
      "--env", `GRIDLENS_PUBLIC_ORIGIN=${origin}`, active.imageId, "node", "scripts/shared-gateway.ts"];
    for (const [role,args] of [["owner",ownerArgs],["gateway",gatewayArgs]] as const) {
      const name = resourceName(instance, role);
      const existing = inspectOwned(this.runner, "container", name, instance);
      if (existing) {
        if (existing.Image !== active.imageId) throw new InstallerError("A previous runtime is still present. Rerun upgrade recovery before continuing.");
        const host=existing.HostConfig as Record<string,unknown>|undefined;
        const cfg=existing.Config as Record<string,unknown>|undefined;
        const actualMounts=existing.Mounts as {Type?:string;Name?:string;Destination?:string;RW?:boolean}[]|undefined;
        const expectedMounts=args.flatMap((value,index)=>value==="--mount"?[args[index+1]!]:[]).map(spec=>{
          const parts=spec.split(",");return {name:parts.find(p=>p.startsWith("src="))!.slice(4),target:parts.find(p=>p.startsWith("dst="))!.slice(4),readonly:parts.includes("readonly")};
        });
        if(cfg?.User!=="1000:1000"||host?.ReadonlyRootfs!==true||host.Privileged!==false||host.NetworkMode!==resourceName(instance,"network")
          ||host.PidMode==="host"||host.IpcMode==="host"||Array.isArray(host.CapAdd)&&host.CapAdd.length>0||!Array.isArray(host.SecurityOpt)||!host.SecurityOpt.some(value=>String(value).startsWith("no-new-privileges"))||Array.isArray(host.Binds)&&host.Binds.length>0||!Array.isArray(host.CapDrop)||!host.CapDrop.includes("ALL")
          ||!Array.isArray(actualMounts)||actualMounts.length!==expectedMounts.length||expectedMounts.some(want=>!actualMounts.some(got=>got.Type==="volume"&&got.Name===want.name&&got.Destination===want.target&&got.RW===!want.readonly))) {
          throw new InstallerError("An existing runtime has changed isolation or mounts; it was left untouched for review.");
        }
        const published=host.PortBindings as Record<string,{HostIp?:string;HostPort?:string}[]>|undefined;
        const ports=published??{};
        if(role==="owner"&&Object.keys(ports).length!==0||role==="gateway"&&(Object.keys(ports).length!==1||ports["8443/tcp"]?.length!==1
          ||ports["8443/tcp"]![0]!.HostIp!==config.bindAddress||ports["8443/tcp"]![0]!.HostPort!==String(config.port))
          ||JSON.stringify(cfg.Cmd)!==JSON.stringify(["node",`scripts/shared-${role}.ts`]))throw new InstallerError("An existing runtime has changed its command or published ports; it was left untouched for review.");
        const state = existing.State as { Running?: boolean } | undefined;
        if (!state?.Running) checked(this.runner, ["start", name]);
      } else checked(this.runner, args);
    }
    // The control socket is never exposed to the web gateway or published as a port.
    let ready=false;
    for(let attempt=0;attempt<30;attempt++){
      const result=this.runner.run(["exec",resourceName(instance,"owner"),"node","scripts/shared-control.ts","status"]);
      if(result.status===0){ready=true;break;}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);
    }
    if(!ready)throw new InstallerError("The backend control socket did not become ready. Saved image/state recovery pairs remain available.");
  }
  install(options: InstallOptions): InstallResult {
    const { instance, release } = options;
    resourceName(instance, "config");
    checked(this.runner, ["version", "--format", "{{.Server.Version}}"]);
    const imageResult = checked(this.runner, ["image", "inspect", release.imageId]);
    let image: { Id?: string; Config?: { Labels?: Record<string,string> } };
    try { image = JSON.parse(imageResult)[0]; } catch { throw new InstallerError("The release image could not be verified."); }
    if (image?.Id !== release.imageId || image.Config?.Labels?.[PRODUCT_LABEL] !== PRODUCT
      || image.Config.Labels["io.gridlens.version"] !== release.version) throw new InstallerError("The release image does not match its signed identity and version.");
    for (const suffix of ["config", "tls", "ledger", "read-ipc", "control-ipc", "credentials"]) ensureVolume(this.runner, resourceName(instance,suffix),instance);
    const network = resourceName(instance,"network");
    if (!inspectOwned(this.runner,"network",network,instance)) checked(this.runner,["network","create",...labels(instance),network]);
    const saved = this.helper(instance,release.imageId,"read");
    let config = saved === "null" ? undefined : validateInstallation(JSON.parse(saved));
    if (config && config.instance !== instance) throw new InstallerError("The saved installation belongs to a different instance.");
    if (config && (options.bindAddress !== undefined && options.bindAddress !== config.bindAddress || options.port !== undefined && options.port !== config.port || options.certificate !== undefined)) {
      throw new InstallerError("Reruns preserve the saved address, port and TLS identity. Use the saved configuration.");
    }
    let retainedNewer = false;
    if (!config) {
      if (options.action !== "setup" || !options.bindAddress) throw new InstallerError("This instance needs first-time setup with its assigned private address.");
      const origin=originFor(options.bindAddress,options.port??8789);
      const stateVolume=resourceName(instance,`state-${release.sequence}-${randomBytes(6).toString("hex")}`);
      ensureVolume(this.runner,stateVolume,instance);
      config = validateInstallation(JSON.parse(this.helper(instance,release.imageId,"initialize",{
        instance, bindAddress:options.bindAddress, port:options.port??8789, origin,
        active:{imageId:release.imageId,version:release.version,sequence:release.sequence,stateVolume},certificate:options.certificate,
      }, [...mount(stateVolume,"/state"),...mount(resourceName(instance,"ledger"),"/ledger"),
        ...mount(resourceName(instance,"read-ipc"),"/ipc"),...mount(resourceName(instance,"control-ipc"),"/control"),...mount(resourceName(instance,"credentials"),"/credentials")])));
    } else if (config.phase === "applying") {
      // A durable transaction has selected a complete image/state pair. Finish exactly that pair.
      this.removeRuntime(instance);
    } else if (options.action === "rollback") {
      if (!config.previous) throw new InstallerError("No matched image/state recovery pair is available.");
      const prior = config.active;
      config={...config,active:config.previous,previous:prior,phase:"applying"};
      this.save(config);
      this.removeRuntime(instance);
    } else if (release.sequence > config.active.sequence && options.action === "upgrade") {
      const previous=config.active;
      const stateVolume=resourceName(instance,`state-${release.sequence}-${randomBytes(6).toString("hex")}`);
      ensureVolume(this.runner,stateVolume,instance);
      // Stop the single writer before copying SQLite and its WAL as one matched recovery point.
      this.removeRuntime(instance);
      this.helper(instance,release.imageId,"copy-state",{},[...mount(previous.stateVolume,"/source",true),...mount(stateVolume,"/destination")]);
      const active: InstalledImage={imageId:release.imageId,version:release.version,sequence:release.sequence,stateVolume};
      config={...config,active,previous,phase:"applying"};
      this.save(config);
    } else if (release.sequence < config.active.sequence) {
      retainedNewer=true;
    } else if (release.sequence === config.active.sequence && release.imageId !== config.active.imageId) {
      throw new InstallerError("The same release sequence identifies a different image; setup stopped.");
    }
    this.startRuntime(config);
    config={...config,phase:"ready"}; this.save(config);
    const certificate=this.helper(instance,config.active.imageId,"certificate");
    return {config,retainedNewer,certificate};
  }
  configuration(instance: string, imageId: string): InstallationConfig | undefined {
    if (!inspectOwned(this.runner, "volume", resourceName(instance, "config"), instance)
      || !inspectOwned(this.runner, "volume", resourceName(instance, "tls"), instance)) return undefined;
    const raw=this.helper(instance,imageId,"read");return raw==="null"?undefined:validateInstallation(JSON.parse(raw));
  }
  operatorCode(instance: string): string {
    const name=resourceName(instance,"owner");
    if(!inspectOwned(this.runner,"container",name,instance))throw new InstallerError("The backend is not running.");
    const status=JSON.parse(checked(this.runner,["exec",name,"node","scripts/shared-control.ts","status"])) as {contexts?:{scopeId?:string}[]};
    if(!Array.isArray(status.contexts))throw new InstallerError("The backend did not return its authorized fleet list.");
    if(!status.contexts.some(context=>context.scopeId==="default"))checked(this.runner,["exec",name,"node","scripts/shared-control.ts","create-fleet","default"]);
    return checked(this.runner,["exec",name,"node","scripts/shared-control.ts","pair-code","default","operator"]);
  }
}
