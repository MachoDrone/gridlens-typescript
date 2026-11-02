import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { checked, ensureVolume, inspectOwned, labels, mount, resourceName, restrictions, PRODUCT_LABEL, PRODUCT } from "./docker.ts";
import type { DockerRunner } from "./docker.ts";
import { originFor, validateInstallation } from "./config.ts";
import type { InstallationConfig, InstalledImage } from "./config.ts";
import { InstallerError } from "./release.ts";
import type { ModernRelease } from "./release.ts";
import { stopUpdater } from "../updater/deployment.ts";
import { readVpnWebEndpoint } from "./vpn-web.ts";

export const UPDATER_PROTOCOL_LABEL = "io.gridlens.updater-protocol";
export const BROWSER_SECURITY_PROTOCOL_LABEL = "io.gridlens.browser-security-protocol";
export const TREASURY_PROTOCOL_LABEL = "io.gridlens.treasury-protocol";
/** Let a dispatched claim's bounded 75-second helper return and journal its ACK. */
export const OWNER_STOP_GRACE_SECONDS = 90;
export interface BrowserSecurityPublication {
  version: 1; instance: string; httpsOrigin: string; httpOrigin: string | null;
  certificatePem: string; serverCertificatePem: string; serverCertificateSha256: string;
}
const updaterConfiguration = (config: InstallationConfig, enabled: boolean): InstallationConfig => {
  const { updater: _updater, ...rest } = config;
  return enabled ? { ...rest, updater: { protocol: 1 } } : rest;
};

export interface InstallOptions {
  instance: string;
  release: ModernRelease;
  action: "setup" | "upgrade" | "rollback";
  bindAddress?: string;
  port?: number;
  certificate?: { certificate: string; privateKey: string };
  /** Explicit operator choice for an endpoint that is not effectively published. */
  repairPort?: number;
  enableUpdater?: boolean;
}
export interface InstallResult { config: InstallationConfig; retainedNewer: boolean; certificate: string }
export interface EndpointStatus { state: "healthy" | "missing" | "stopped" | "detached" | "unpublished"; repairRequired: boolean }
export class Coordinator {
  readonly runner: DockerRunner;
  constructor(runner: DockerRunner) { this.runner = runner; }
  /** The signed image ID binds this capability; release sequence is not a feature flag. */
  supportsUpdater(selected: Pick<InstalledImage, "imageId" | "version">): boolean {
    let image: { Id?: string; Config?: { Labels?: Record<string, string> } };
    try { image = JSON.parse(checked(this.runner, ["image", "inspect", selected.imageId]))[0]; }
    catch { throw new InstallerError("The selected image capability could not be verified."); }
    if (image?.Id !== selected.imageId || image.Config?.Labels?.[PRODUCT_LABEL] !== PRODUCT
      || image.Config.Labels["io.gridlens.version"] !== selected.version) throw new InstallerError("The selected image identity does not match its saved release.");
    const protocol = image.Config.Labels[UPDATER_PROTOCOL_LABEL];
    if (protocol !== undefined && protocol !== "1") throw new InstallerError("The selected image requires an unsupported updater protocol.");
    return protocol === "1";
  }
  supportsBrowserSecurity(selected: Pick<InstalledImage, "imageId" | "version">): boolean {
    let images: { Id?: string; Config?: { Labels?: Record<string, string> } }[];
    const raw = checked(this.runner, ["image", "inspect", selected.imageId]);
    try { images = JSON.parse(raw); }
    catch { throw new InstallerError("The selected browser security capability could not be verified."); }
    const image = Array.isArray(images) ? images[0] : undefined;
    if (!Array.isArray(images) || images.length !== 1 || image?.Id !== selected.imageId || image.Config?.Labels?.[PRODUCT_LABEL] !== PRODUCT
      || image.Config.Labels["io.gridlens.version"] !== selected.version) throw new InstallerError("The browser security image does not match its saved release.");
    const protocol = image.Config.Labels[BROWSER_SECURITY_PROTOCOL_LABEL];
    if (protocol !== undefined && protocol !== "1") throw new InstallerError("The selected image requires an unsupported browser security protocol.");
    return protocol === "1";
  }
  supportsTreasury(selected: Pick<InstalledImage, "imageId" | "version">): boolean {
    let images: { Id?: string; Config?: { Labels?: Record<string, string> } }[];
    try { images = JSON.parse(checked(this.runner, ["image", "inspect", selected.imageId])); }
    catch { throw new InstallerError("The selected Wallet capability could not be verified."); }
    const image = Array.isArray(images) ? images[0] : undefined;
    if (!Array.isArray(images) || images.length !== 1 || image?.Id !== selected.imageId
      || image.Config?.Labels?.[PRODUCT_LABEL] !== PRODUCT || image.Config.Labels["io.gridlens.version"] !== selected.version)
      throw new InstallerError("The Wallet image does not match its saved release.");
    const protocol = image.Config.Labels[TREASURY_PROTOCOL_LABEL];
    if (protocol !== undefined && protocol !== "0" && protocol !== "1") throw new InstallerError("The selected image requires an unsupported Wallet protocol.");
    return protocol === "1";
  }
  /** Publish public trust metadata only after the saved services are running.
   * Older images remain usable without receiving an unsupported helper/control. */
  publishBrowserSecurity(config: InstallationConfig): BrowserSecurityPublication | undefined {
    validateInstallation(config);
    if (!this.supportsBrowserSecurity(config.active)) return undefined;
    if (config.phase !== "ready" || config.pendingPort !== undefined) throw new InstallerError("Finish installation recovery before publishing secure browser setup.");
    this.validateManagedRuntime(config);
    if (this.endpointStatus(config).repairRequired) throw new InstallerError("The saved HTTPS gateway is unavailable; secure browser setup was not changed.");
    const owner = inspectOwned(this.runner, "container", resourceName(config.instance, "owner"), config.instance);
    if ((owner?.State as { Running?: boolean } | undefined)?.Running !== true) throw new InstallerError("The saved collection owner must be running before secure browser setup is published.");
    const web = readVpnWebEndpoint(this.runner, config);
    if (web && web.imageId !== config.active.imageId) throw new InstallerError("The browser gateway has not reached the saved release; finish update recovery before secure browser setup.");
    // Config belongs to UID 0; TLS belongs to UID 1000 with directory mode 0700.
    // Read/search is sufficient across those fixed read-only volumes. Preserve
    // the command runner's sanitized failure rather than relabeling it as bad PEM.
    const raw = checked(this.runner, ["run", "--rm", "-i", ...labels(config.instance), ...restrictions,
      "--network", "none", "--user", "0:0", "--cap-add", "DAC_READ_SEARCH", ...mount(resourceName(config.instance, "config"), "/config", true),
      ...mount(resourceName(config.instance, "tls"), "/tls", true), config.active.imageId,
      "node", "src/installer/container-init.ts", "public-browser-certificates"], "{}");
    let certificates: { certificatePem: string; serverCertificatePem: string };
    try {
      if (Buffer.byteLength(raw) > 68 * 1024) throw new Error();
      certificates = JSON.parse(raw);
      if (!certificates || typeof certificates.certificatePem !== "string" || typeof certificates.serverCertificatePem !== "string"
        || Object.keys(certificates).some(key => !["certificatePem", "serverCertificatePem"].includes(key))) throw new Error();
      for (const pem of [certificates.certificatePem, certificates.serverCertificatePem]) {
        const blocks = [...pem.matchAll(/-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g)];
        if (Buffer.byteLength(pem) > 32 * 1024 || !blocks.length || pem.replace(/-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g, "").trim()) throw new Error();
        blocks.forEach(block => new X509Certificate(block[0]));
      }
      const leaf = new X509Certificate(certificates.serverCertificatePem);
      if (!leaf.checkIP(config.bindAddress) || createHash("sha256").update(leaf.raw).digest("hex") !== config.certificateSha256
        || [...certificates.serverCertificatePem.matchAll(/-----BEGIN CERTIFICATE-----/g)].length !== 1) throw new Error();
    } catch { throw new InstallerError("The saved public TLS identity could not be verified; secure browser setup was not changed."); }
    const publication: BrowserSecurityPublication = { version: 1, instance: config.instance, httpsOrigin: config.origin,
      httpOrigin: web?.origin ?? null, ...certificates, serverCertificateSha256: config.certificateSha256 };
    const result = JSON.parse(checked(this.runner, ["exec", "-i", resourceName(config.instance, "owner"), "node", "scripts/shared-control.ts", "json"],
      JSON.stringify({ operation: "browser-security-publish", ...publication }))) as { published?: boolean };
    if (result?.published !== true) throw new InstallerError("Secure browser setup publication was not acknowledged.");
    return publication;
  }
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
      checked(this.runner, ["stop", "--time", role === "owner" ? String(OWNER_STOP_GRACE_SECONDS) : "30", name]);
      checked(this.runner, ["rm", name]);
    }
  }
  private runtimeArguments(config: InstallationConfig): { owner: string[]; gateway: string[] } {
    const { instance, active, origin } = config;
    const treasury = this.supportsTreasury(active);
    const common = ["--detach", "--restart", "unless-stopped", ...restrictions, "--user", "1000:1000",
      ...labels(instance), "--network", resourceName(instance, "network")];
    const ownerArgs = ["run", ...common, "--name", resourceName(instance, "owner"),
      ...mount(active.stateVolume, "/state"), ...mount(resourceName(instance, "ledger"), "/ledger"),
      ...mount(resourceName(instance, "read-ipc"), "/ipc"), ...mount(resourceName(instance, "control-ipc"), "/control"),
      ...mount(resourceName(instance, "credentials"), "/credentials"),
      ...(treasury ? [...mount(resourceName(instance, "treasury-ipc"), "/treasury"), "--env", "GRIDLENS_TREASURY_SOCKET=/treasury/treasury.sock"] : []),
      ...(config.updater ? [...mount(resourceName(instance, "updates-ipc"), "/updates", true), "--env", "GRIDLENS_UPDATE_SOCKET=/updates/updater.sock"] : []),
      "--env", "GRIDLENS_STATE_DIR=/state", "--env", "GRIDLENS_LEDGER_DIR=/ledger", "--env", "GRIDLENS_SOCKET_DIR=/ipc",
      "--env", "GRIDLENS_CONTROL_DIR=/control", "--env", "GRIDLENS_CREDENTIAL_DIR=/credentials",
      active.imageId, "node", "scripts/shared-owner.ts"];
    const bind = config.bindAddress.includes(":") ? `[${config.bindAddress}]` : config.bindAddress;
    const gatewayArgs = ["run", ...common, "--name", resourceName(instance, "gateway"),
      ...mount(resourceName(instance, "read-ipc"), "/ipc", true), ...mount(resourceName(instance, "tls"), "/tls", true),
      ...(treasury ? [...mount(resourceName(instance, "treasury-ipc"), "/treasury", true), "--env", "GRIDLENS_TREASURY_SOCKET=/treasury/treasury.sock"] : []),
      "--publish", `${bind}:${config.port}:8443/tcp`, "--env", "GRIDLENS_SOCKET=/ipc/read.sock",
      "--env", "GRIDLENS_TLS_CERT=/tls/server.crt", "--env", "GRIDLENS_TLS_KEY=/tls/server.key",
      ...(config.updater ? ["--env", "GRIDLENS_UPDATES=1"] : []),
      "--env", `GRIDLENS_PUBLIC_ORIGIN=${origin}`, active.imageId, "node", "scripts/shared-gateway.ts"];
    return { owner: ownerArgs, gateway: gatewayArgs };
  }
  private validateRuntime(config: InstallationConfig, role: "owner" | "gateway", existing: Record<string, unknown>): void {
        const { instance, active } = config, args = this.runtimeArguments(config)[role];
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
  }
  private targetConfiguration(config: InstallationConfig): InstallationConfig {
    const { pendingPort, ...saved } = config;
    return pendingPort === undefined ? saved : { ...saved, port: pendingPort, origin: originFor(config.bindAddress, pendingPort) };
  }
  private validateGateway(config: InstallationConfig, gateway: Record<string, unknown>): "saved" | "target" {
    try { this.validateRuntime(config, "gateway", gateway); return "saved"; }
    catch (error) {
      if (config.pendingPort === undefined) throw error;
      try { this.validateRuntime(this.targetConfiguration(config), "gateway", gateway); return "target"; }
      catch { throw error; }
    }
  }
  private effectiveEndpoint(config: InstallationConfig, gateway: Record<string, unknown>): EndpointStatus {
    const state = gateway.State as { Running?: boolean } | undefined;
    if (!state?.Running) return { state: "stopped", repairRequired: true };
    const settings = gateway.NetworkSettings as { Networks?: Record<string, { NetworkID?: string; EndpointID?: string; IPAddress?: string; GlobalIPv6Address?: string }>; Ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null> } | undefined;
    const network = settings?.Networks?.[resourceName(config.instance, "network")];
    const ownedNetwork = inspectOwned(this.runner, "network", resourceName(config.instance, "network"), config.instance);
    if (!ownedNetwork || typeof ownedNetwork.Id !== "string" || network?.NetworkID !== ownedNetwork.Id || !network.EndpointID
      || !network.IPAddress && !network.GlobalIPv6Address) return { state: "detached", repairRequired: true };
    const ports = settings?.Ports?.["8443/tcp"];
    if (!Array.isArray(ports) || ports.length !== 1 || ports[0]?.HostIp !== config.bindAddress || ports[0]?.HostPort !== String(config.port))
      return { state: "unpublished", repairRequired: true };
    return { state: "healthy", repairRequired: false };
  }
  endpointStatus(config: InstallationConfig): EndpointStatus {
    const gateway = inspectOwned(this.runner, "container", resourceName(config.instance, "gateway"), config.instance);
    if (!gateway) return { state: "missing", repairRequired: true };
    this.validateGateway(config, gateway);
    return this.effectiveEndpoint(this.targetConfiguration(config), gateway);
  }
  /** Validate the exact current resources before a transaction removes anything. */
  validateManagedRuntime(config: InstallationConfig): void {
    for (const role of ["owner", "gateway"] as const) {
      const existing = inspectOwned(this.runner, "container", resourceName(config.instance, role), config.instance);
      if (existing) { if (role === "gateway") this.validateGateway(config, existing); else this.validateRuntime(config, role, existing); }
    }
  }
  /** Restore an internally recorded image/state pair; never accepts browser input. */
  restore(current: InstallationConfig, previous: InstallationConfig): InstallResult {
    validateInstallation(current); validateInstallation(previous);
    if (current.instance !== previous.instance || current.origin !== previous.origin || current.certificateSha256 !== previous.certificateSha256)
      throw new InstallerError("Recovery cannot change the saved installation identity or endpoint.");
    this.validateManagedRuntime(current);
    this.removeRuntime(current.instance);
    this.save({ ...previous, phase: "applying" });
    this.startRuntime(previous);
    const config = { ...previous, phase: "ready" as const }; this.save(config);
    return { config, retainedNewer: false, certificate: this.helper(config.instance, config.active.imageId, "certificate") };
  }
  private removeGateway(config: InstallationConfig, gateway: Record<string, unknown>): void {
    this.validateGateway(config, gateway);
    const name = resourceName(config.instance, "gateway");
    if ((gateway.State as { Running?: boolean } | undefined)?.Running) checked(this.runner, ["stop", "--time", "30", name]);
    checked(this.runner, ["rm", name]);
  }
  private prepareEndpoint(config: InstallationConfig, repairPort: number | undefined): InstallationConfig {
    if (repairPort !== undefined) {
      originFor(config.bindAddress, repairPort);
      if (config.pendingPort === undefined && repairPort === config.port) return config;
      if (!this.endpointStatus(config).repairRequired && repairPort !== config.pendingPort) throw new InstallerError("The saved dashboard endpoint is working. Its port was preserved.");
      if (config.pendingPort !== undefined && repairPort !== config.pendingPort) {
        // A prior target may itself have lost a port race. Remove only its fully
        // validated, nonworking gateway before replacing that existing intent.
        const gateway = inspectOwned(this.runner, "container", resourceName(config.instance, "gateway"), config.instance);
        if (gateway && !(repairPort === config.port && this.validateGateway(config, gateway) === "saved" && !this.effectiveEndpoint(config, gateway).repairRequired)) this.removeGateway(config, gateway);
      }
      if (repairPort === config.port) { const { pendingPort: _pending, ...saved } = config; config = { ...saved, phase: "prepared" }; this.save(config); }
      else { config = { ...config, pendingPort: repairPort, phase: "prepared" }; this.save(config); }
    }
    if (config.pendingPort !== undefined) {
      const gateway = inspectOwned(this.runner, "container", resourceName(config.instance, "gateway"), config.instance);
      if (gateway && this.validateGateway(config, gateway) === "saved") this.removeGateway(config, gateway);
    }
    return config;
  }
  private startRuntime(config: InstallationConfig): void {
    const { instance } = config, arguments_ = this.runtimeArguments(config);
    for (const role of ["owner", "gateway"] as const) {
      const name = resourceName(instance, role), args = arguments_[role];
      let existing = inspectOwned(this.runner, "container", name, instance);
      if (existing) {
        this.validateRuntime(config, role, existing);
        if (!(existing.State as { Running?: boolean } | undefined)?.Running) checked(this.runner, ["start", name]);
      } else checked(this.runner, args);
      if (role === "gateway") {
        existing = inspectOwned(this.runner, "container", name, instance);
        if (!existing) throw new InstallerError("The owned gateway is missing after creation.");
        this.validateRuntime(config, role, existing);
        if (this.effectiveEndpoint(config, existing).repairRequired) {
          // A failed Docker port allocation can leave a container that later
          // starts without any endpoint. One owned replacement is bounded.
          this.removeGateway(config, existing); checked(this.runner, args);
          const repaired = inspectOwned(this.runner, "container", name, instance);
          if (!repaired) throw new InstallerError("Gateway replacement did not create an owned container.");
          this.validateRuntime(config, role, repaired);
          if (this.effectiveEndpoint(config, repaired).repairRequired) throw new InstallerError("The gateway has no effective network or HTTPS port. Saved identity and data remain intact; rerun setup to repair the endpoint.");
        }
      }
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
    const retainedNewer = !!config && options.action !== "rollback" && release.sequence < config.active.sequence;
    if (retainedNewer && config!.phase === "ready") {
      this.validateManagedRuntime(config!);
      return { config: config!, retainedNewer: true, certificate: this.helper(instance, config!.active.imageId, "certificate") };
    }
    if (!config && options.repairPort !== undefined) throw new InstallerError("Endpoint repair requires an existing installation.");
    if (config && config.phase !== "applying") {
      this.validateManagedRuntime(config);
      if (options.action === "rollback" && !config.previous) throw new InstallerError("No matched image/state recovery pair is available.");
      if (options.action !== "rollback" && release.sequence === config.active.sequence && release.imageId !== config.active.imageId)
        throw new InstallerError("The same release sequence identifies a different image; setup stopped.");
    }
    if (config && config.phase !== "applying") config = this.prepareEndpoint(config, options.repairPort);
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
      const enabled = !!(config.updater || options.enableUpdater) && this.supportsUpdater(config.previous);
      if (config.updater && !enabled) stopUpdater(this.runner, instance);
      this.removeRuntime(instance);
      config=updaterConfiguration({...config,active:config.previous,previous:prior,phase:"applying"}, enabled);
      this.save(config);
    } else if (release.sequence > config.active.sequence && options.action === "upgrade") {
      const previous=config.active;
      const enabled = !!(config.updater || options.enableUpdater) && this.supportsUpdater(release);
      if (config.updater && !enabled) stopUpdater(this.runner, instance);
      const stateVolume=resourceName(instance,`state-${release.sequence}-${randomBytes(6).toString("hex")}`);
      ensureVolume(this.runner,stateVolume,instance);
      // Stop the single writer before copying SQLite and its WAL as one matched recovery point.
      this.removeRuntime(instance);
      this.helper(instance,release.imageId,"copy-state",{},[...mount(previous.stateVolume,"/source",true),...mount(stateVolume,"/destination")]);
      const active: InstalledImage={imageId:release.imageId,version:release.version,sequence:release.sequence,stateVolume};
      config=updaterConfiguration({...config,active,previous,phase:"applying"}, enabled);
      this.save(config);
    } else if (release.sequence === config.active.sequence && release.imageId !== config.active.imageId) {
      throw new InstallerError("The same release sequence identifies a different image; setup stopped.");
    }
    const updaterEnabled = !!(config.updater || options.enableUpdater && !retainedNewer) && this.supportsUpdater(config.active);
    if (config.updater && !updaterEnabled) {
      stopUpdater(this.runner, instance);
      this.removeRuntime(instance);
      config = updaterConfiguration({ ...config, phase: "applying" }, false); this.save(config);
    }
    if (updaterEnabled) for (const suffix of ["updates-ipc", "update-state"]) ensureVolume(this.runner, resourceName(instance, suffix), instance);
    if (updaterEnabled && !config.updater) {
      // First enablement is an explicit installer operation. Existing runtimes
      // were validated above; replace them with the narrow socket composition.
      this.removeRuntime(instance);
      config = { ...config, updater: { protocol: 1 }, phase: "applying" };
      this.save(config);
    }
    const target = this.targetConfiguration(config);
    if (this.supportsTreasury(target.active)) {
      ensureVolume(this.runner, resourceName(instance, "treasury-ipc"), instance);
      this.helper(instance, target.active.imageId, "treasury-initialize", {}, [
        ...mount(resourceName(instance, "treasury-ipc"), "/treasury"),
      ]);
    }
    this.startRuntime(target);
    config={...target,phase:"ready"}; this.save(config);
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
