import { createHash, createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import { dirname, basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { ReadStream, WriteStream } from "node:tty";
import { Coordinator } from "./coordinator.ts";
import { verifyGateway } from "./health.ts";
import { checked, inspectOwned, localDockerRunner, resourceName } from "./docker.ts";
import type { DockerRunner } from "./docker.ts";
import { browserConnectionText, privateBrowserConnectionText, verifyPrivateWeb } from "./browser-connection.ts";
import { readVpnWebEndpoint } from "./vpn-web.ts";
import { reconcileInstalledServices } from "./installed-services.ts";
import { runTerminalSetup, verifiedSetupNetwork } from "./setup-session.ts";
import type { SetupControl } from "./setup-session.ts";
import { InstallerError, releaseURL, verifyRelease } from "./release.ts";
import { downloadArtifactToFile } from "./artifact-download.ts";
import { assertLocalDockerForSelection, chooseDashboardPort, choosePrivateEndpoint, choosePrivateWebPorts, discoverPrivateEndpoints, dockerNetworkExclusions, probeBindPort } from "./network-selection.ts";
import type { PortProbe, SelectionPrompts } from "./network-selection.ts";
import type { InstallationConfig } from "./config.ts";
import { cliColorEnabled, cliSection, cliText } from "./cli-format.ts";
import { acquireMaintenanceLock, guardTerminalUpdate } from "../updater/deployment.ts";
import { findReleaseImage, requireReleaseImage, runtimeRelease } from "./image-identity.ts";

declare const GRIDLENS_RELEASE_PUBLIC_KEY: string;

export interface TerminalPrompts { color?: boolean; ask(prompt: string): Promise<string>; secret(prompt: string): Promise<string>; print(text: string): void; close(): void }

const MAX_PUBLIC_CERTIFICATE_BYTES = 32 * 1024;
export class PublicCertificateExportError extends InstallerError {}
function publicCertificates(value: string): X509Certificate[] {
  if (Buffer.byteLength(value) > MAX_PUBLIC_CERTIFICATE_BYTES) throw new PublicCertificateExportError("The public certificate exceeds the export size limit.");
  const blocks = [...value.matchAll(/-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g)].map(match => match[0]);
  if (!blocks.length || value.replace(/-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g, "").trim())
    throw new PublicCertificateExportError("Only public certificate PEM data can be exported.");
  try { return blocks.map(block => new X509Certificate(block)); }
  catch { throw new PublicCertificateExportError("The public certificate could not be validated for export."); }
}
export function publicCertificateFingerprint(certificate: string): string {
  return createHash("sha256").update(publicCertificates(certificate)[0]!.raw).digest("hex");
}
export function certificateExportPath(value: string, homeDirectory = homedir()): string {
  const input = value.trim();
  if (!input || input.length > 4096 || /[\u0000-\u001f\u007f\\]/.test(input) || /^[a-z]+:\/\//i.test(input)
    || input.startsWith("~") && !input.startsWith("~/") || input.split("/").includes(".."))
    throw new PublicCertificateExportError("Enter a local file path, using ~/ for your home directory. Parent-directory steps and links are not supported.");
  return resolve(input.startsWith("~/") ? `${homeDirectory}/${input.slice(2)}` : input);
}
/** Only a recognized public-certificate header permits a bounded full read. A
 * private-key-shaped or arbitrary file stops at its first mismatching header byte. */
function existingPublicCertificate(fd: number): string {
  const before = fstatSync(fd);
  if (!before.isFile()) throw new PublicCertificateExportError("That destination is not an ordinary file. Choose another path or type skip.");
  if (before.size > MAX_PUBLIC_CERTIFICATE_BYTES) throw new PublicCertificateExportError("The existing file is too large to compare as a public certificate. It was not changed.");
  const byte = Buffer.alloc(1); let position = 0, character = "";
  for (;;) {
    if (position >= Math.min(before.size, 256) || readSync(fd, byte, 0, 1, position++) !== 1)
      throw new PublicCertificateExportError("The existing file is not a public certificate export. Choose another path; it was not changed.");
    character = byte.toString("ascii"); if (!/[\t\n\r ]/.test(character)) break;
  }
  const header = "-----BEGIN CERTIFICATE-----";
  if (character !== header[0]) throw new PublicCertificateExportError("The existing file is not a public certificate export. Choose another path; it was not changed.");
  for (let index = 1; index < header.length; index++) {
    if (readSync(fd, byte, 0, 1, position++) !== 1 || byte[0] !== header.charCodeAt(index))
      throw new PublicCertificateExportError("The existing file is not a public certificate export. Choose another path; it was not changed.");
  }
  const bytes = Buffer.alloc(before.size); let read = 0;
  while (read < bytes.length) { const count = readSync(fd, bytes, read, bytes.length - read, read); if (!count) break; read += count; }
  const after = fstatSync(fd);
  if (read !== bytes.length || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
    throw new PublicCertificateExportError("The existing file changed during its certificate check. It was not overwritten; choose another path.");
  return bytes.toString("utf8");
}
/** Linux-only descriptor-relative traversal rejects links in every path component,
 * including a directory replaced between checks. No existing file is written. */
export function savePublicCertificate(destination: string, certificate: string, { homeDirectory = homedir() }: { homeDirectory?: string } = {}): { path: string; status: "created" | "unchanged" } {
  const expected = publicCertificates(certificate), path = certificateExportPath(destination, homeDirectory);
  let directoryFd: number | undefined;
  try {
    directoryFd = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    for (const component of dirname(path).split("/").filter(Boolean)) {
      const next = openSync(`/proc/self/fd/${directoryFd}/${component}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      closeSync(directoryFd); directoryFd = next;
    }
    const anchored = `/proc/self/fd/${directoryFd}/${basename(path)}`;
    let fd: number;
    try { fd = openSync(anchored, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const existing = openSync(anchored, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const actual = publicCertificates(existingPublicCertificate(existing));
        if (actual.length !== expected.length || actual.some((cert, index) => !cert.raw.equals(expected[index]!.raw)))
          throw new PublicCertificateExportError("A different public certificate is already saved there. Choose another path or type skip; it was not overwritten.");
      } finally { closeSync(existing); }
      return { path, status: "unchanged" };
    }
    const created = fstatSync(fd);
    try { writeFileSync(fd, certificate.trim() + "\n"); fsyncSync(fd); fsyncSync(directoryFd); }
    catch (error) {
      // Remove only the file this invocation created, never a replacement.
      try { const current = lstatSync(anchored); if (current.dev === created.dev && current.ino === created.ino) unlinkSync(anchored); } catch { /* Preserve the original write failure. */ }
      throw error;
    } finally { closeSync(fd); }
    return { path, status: "created" };
  } catch (error) {
    if (error instanceof PublicCertificateExportError) throw error;
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ELOOP" || code === "ENOTDIR") throw new PublicCertificateExportError("Symbolic links and non-directory parents cannot be used for certificate export. Choose another path; existing files were not changed.");
    throw new PublicCertificateExportError("The public certificate could not be saved at that path. Choose an existing writable directory and another file name, or type skip.");
  } finally { if (directoryFd !== undefined) closeSync(directoryFd); }
}
export async function offerPublicCertificateExport(terminal: SelectionPrompts, instance: string, certificate: string, {
  homeDirectory = homedir(), existingTrusted = false,
}: { homeDirectory?: string; existingTrusted?: boolean } = {}): Promise<void> {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(instance)) throw new PublicCertificateExportError("Invalid instance name for certificate export.");
  const authority = publicCertificates(certificate)[0]!.ca;
  if (authority) terminal.print(`PUBLIC CA certificate SHA-256: ${publicCertificateFingerprint(certificate)}`);
  const privateCa = authority && !existingTrusted;
  if (privateCa) terminal.print("Save this PUBLIC CA certificate, then import it in clients that do not already trust it. Android also verifies the separate server TLS certificate pin. Never bypass certificate validation.");
  else terminal.print("An existing trusted server certificate needs no new CA import when the clients already trust its issuer. Exporting its public certificate is optional.");
  const recommended = `~/gridlens-${instance}-ca.crt`;
  for (;;) {
    const answer = (await terminal.ask(privateCa ? `Save PUBLIC CA certificate [${recommended}] (or type skip): ` : "Public certificate export path (Enter or skip to skip): ")).trim();
    if (answer.toLowerCase() === "skip" || !privateCa && !answer) { terminal.print("Public certificate export skipped; the backend identity and data are unchanged."); return; }
    try {
      const result = savePublicCertificate(answer || recommended, certificate, { homeDirectory });
      terminal.print(result.status === "unchanged" ? `The same public certificate is already saved: ${result.path}` : `Public certificate saved: ${result.path}`);
      return;
    } catch (error) { terminal.print(error instanceof PublicCertificateExportError ? error.message : "The public certificate could not be exported. Choose another path or type skip."); }
  }
}

export async function chooseTlsMode(terminal: SelectionPrompts): Promise<"private" | "existing"> {
  terminal.print("1) Private certificate — recommended. Import its public CA certificate in your browser or Android trust setup; Android also checks the server certificate pin.");
  terminal.print("2) Existing trusted certificate — use a certificate and private key that cover the selected dashboard IP.");
  for (;;) {
    const answer = (await terminal.ask("HTTPS certificate [1, private certificate recommended]: ")).trim().toLowerCase();
    if (answer === "" || answer === "1" || answer === "private") return "private";
    if (answer === "2" || answer === "existing") return "existing";
    terminal.print("Choose 1 (private) or 2 (existing), or press Enter for the recommended private certificate.");
  }
}
export async function chooseTlsConfiguration(terminal: Pick<TerminalPrompts, "ask" | "secret" | "print">, address: string, {
  readText = (file: string) => readFileSync(file, "utf8"), now = Date.now,
}: { readText?: (file: string) => string; now?: () => number } = {}): Promise<{ certificate: string; privateKey: string } | undefined> {
  for (;;) {
    if (await chooseTlsMode(terminal) === "private") return undefined;
    const certPath = await terminal.ask("Certificate/full-chain PEM file: "), keyPath = await terminal.ask("TLS private-key PEM file: ");
    let certificate: string, raw: string;
    try {
      certificate = readText(certPath.startsWith("~/") ? join(homedir(), certPath.slice(2)) : certPath);
      raw = readText(keyPath.startsWith("~/") ? join(homedir(), keyPath.slice(2)) : keyPath);
      if (certificate.length > 256 * 1024 || raw.length > 256 * 1024) throw new Error();
    } catch { terminal.print("The TLS files could not be read as bounded PEM files. Choose the certificate option again; installation configuration has not changed."); continue; }
    const passphrase = raw.includes("ENCRYPTED") ? await terminal.secret("TLS key passphrase: ") : undefined;
    try {
      const key = createPrivateKey({ key: raw, ...(passphrase ? { passphrase } : {}) }), cert = new X509Certificate(certificate);
      if (!cert.checkIP(address) || new Date(cert.validFrom).getTime() > now() || new Date(cert.validTo).getTime() <= now()
        || !cert.publicKey.export({ type: "spki", format: "der" }).equals(createPublicKey(key).export({ type: "spki", format: "der" }))) throw new Error();
      return { certificate, privateKey: key.export({ format: "pem", type: "pkcs8" }).toString() };
    } catch { terminal.print("The TLS certificate/key did not validate. Check the passphrase, validity dates, matching key and selected IP, then choose again. Installation configuration has not changed."); }
  }
}
export async function chooseSavedEndpointRepair(terminal: SelectionPrompts, previous: InstallationConfig,
  assess: (config: InstallationConfig) => { state: string; repairRequired: boolean }, probe: PortProbe = probeBindPort): Promise<number | undefined> {
  if (previous.phase === "applying") {
    terminal.print(cliText(terminal, "pending", "Resuming the saved installation…"));
    return undefined;
  }
  const port = previous.pendingPort ?? previous.port, endpoint = assess(previous);
  if (!endpoint.repairRequired) {
    terminal.print(cliText(terminal, "muted", previous.pendingPort === undefined ? "Saved network address and ports retained."
      : "Completing the saved port repair. Identity and data are retained."));
    return undefined;
  }
  const availability = await probe(previous.bindAddress, port);
  if (availability === "unavailable") throw new InstallerError("The saved dashboard address cannot be bound on this PC. Restore its existing private network/VPN connection before retrying. The saved address, TLS identity and data were retained.");
  if (availability === "busy") {
    terminal.print(cliText(terminal, "pending", `The ${previous.pendingPort === undefined ? "saved" : "pending"} dashboard endpoint is not working, and port ${port} is now occupied. Choose a free replacement port; identity and data are retained.`));
    return chooseDashboardPort(terminal, previous.bindAddress, { probe });
  }
  terminal.print(cliText(terminal, "pending", "Repairing the saved dashboard connection…"));
  return undefined;
}
export function controllingTerminal(): TerminalPrompts {
  let inputFd: number,outputFd: number;
  try {inputFd=openSync("/dev/tty","r");outputFd=openSync("/dev/tty","w");}catch{throw new InstallerError("Setup requires a controlling terminal; piped/headless secret entry is not supported.");}
  const input=new ReadStream(inputFd),output=new WriteStream(outputFd);
  if(!input.isTTY||!output.isTTY)throw new InstallerError("Setup requires a controlling terminal.");
  let closed=false;
  const color=cliColorEnabled(output.isTTY);
  return {
    color,
    async ask(prompt){const line=createInterface({input,output,terminal:true});try{return (await line.question(prompt)).trim();}finally{line.close();}},
    secret(prompt){
      output.write(cliText({color},"action",prompt));input.setRawMode(true);input.resume();
      return new Promise<string>((resolve,reject)=>{
        let text="";
        const cleanup=():void=>{input.off("data",data);input.setRawMode(false);input.pause();output.write("\n");};
        const data=(chunk:Buffer):void=>{for(const c of chunk.toString("utf8")){if(c==="\u0003"){cleanup();reject(new InstallerError("Cancelled in terminal."));return;}
          if(c==="\r"||c==="\n"){cleanup();resolve(text);return;}if(c==="\u007f"||c==="\b")text=text.slice(0,-1);else if(c>=" "&&text.length<16_384)text+=c;}};
        input.on("data",data);
      });
    },
    print(text){output.write(text+"\n");},
    close(){if(closed)return;closed=true;input.pause();input.destroy();output.end();},
  };
}
async function download(url: URL, limit: number): Promise<Uint8Array> {
  const response=await fetch(url,{signal:AbortSignal.timeout(300_000),redirect:"follow"});
  if(!response.ok||!response.body||new URL(response.url).protocol!=="https:")throw new InstallerError("The signed release download failed.");
  const parts:Uint8Array[]=[];let total=0;
  for await(const part of response.body){total+=part.byteLength;if(total>limit){await response.body.cancel().catch(()=>{});throw new InstallerError("Release download exceeded its declared size.");}parts.push(part);}
  return Buffer.concat(parts);
}
function option(args: readonly string[], name: string): string | undefined {const at=args.indexOf(name);if(at<0)return undefined;const value=args[at+1];if(!value||value.startsWith("--"))throw new InstallerError(`Missing ${name} value.`);return value;}
function savedConfiguration(coordinator: Coordinator, runner: DockerRunner, instance: string): InstallationConfig {
  const gateway = inspectOwned(runner, "container", resourceName(instance, "gateway"), instance);
  if (typeof gateway?.Image !== "string") throw new InstallerError("The saved backend is not available. Rerun setup first.");
  const config = coordinator.configuration(instance, gateway.Image);
  if (!config) throw new InstallerError("The saved backend configuration is not available. Rerun setup first.");
  return config;
}
export function printBrowserReady(terminal: TerminalPrompts, origin: string): void {
  // Keep the existing private-origin validation before presenting a clickable URL.
  privateBrowserConnectionText(origin);
  terminal.print("");
  terminal.print(cliText(terminal, "success", "Ready."));
  terminal.print(cliText(terminal, "action", `${origin}/`));
  terminal.print("");
  terminal.print("Open this address, then choose Hosts in the left menu to find, add or update PCs.");
  terminal.print(cliText(terminal, "muted", "Use your existing VPN when away."));
  terminal.print("");
}
function printSavedConnection(terminal: TerminalPrompts, coordinator: Coordinator, runner: DockerRunner, instance: string): void {
  const config = savedConfiguration(coordinator, runner, instance), web = readVpnWebEndpoint(runner, config);
  if (web) {
    if (!web.privateNetwork) throw new InstallerError("Run setup with --vpn-web to enable the permanent private browser address.");
    printBrowserReady(terminal,web.origin);
  } else terminal.print(browserConnectionText(config.origin, coordinator.operatorCode(instance), config.active.sequence >= 3));
}
function setupControl(runner: DockerRunner, instance: string): SetupControl {
  return body => JSON.parse(body.operation === "setup-inspect"
    ? checked(runner,["exec",resourceName(instance,"owner"),"node","scripts/shared-control.ts","setup-inspect","default"])
    : checked(runner,["exec","-i",resourceName(instance,"owner"),"node","scripts/shared-control.ts","json"],JSON.stringify(body)));
}
function publishSetupNetwork(runner: DockerRunner, config: InstallationConfig): void {
  // Local interface information must never be presented as a remote Docker host's network.
  try { assertLocalDockerForSelection(runner); } catch { return; }
  const interfaces=networkInterfaces();
  if(!discoverPrivateEndpoints(interfaces,dockerNetworkExclusions(runner)).choices.some(choice=>choice.address===config.bindAddress))return;
  const context=verifiedSetupNetwork(config.bindAddress,config.active.version,interfaces);
  if(context)setupControl(runner,config.instance)({operation:"setup-network-context",scopeId:"default",...context});
}
export async function runTerminal(args=process.argv.slice(2), suppliedTerminal?:TerminalPrompts):Promise<void>{
  if(args.includes("--help")){console.log("GridLens modern coordinator v1\nRequires existing Docker and an assigned private address on your existing LAN/VPN.\n\n--release PINNED_HTTPS_RELEASE [--instance NAME] [--upgrade | --rollback | --connect]\n--vpn-web installs the browser dashboard. Optional --web-port PORT.\n\nInstallation ends with the dashboard URL. Manage computers and sign in in the browser.\nAdvanced terminal operations: --ssh-sign-in | --scan RANGE\nNo host Node or Python installation is required.");return;}
  if(args.includes("--version")){console.log("gridlens-modern-coordinator 1 / Node "+process.versions.node);return;}
  process.umask(0o077);
  const terminal=suppliedTerminal??controllingTerminal(),runner=localDockerRunner();
  let releaseMaintenanceLock: (() => Promise<void>) | undefined;
  try{
    const instance=option(args,"--instance")??"default";resourceName(instance,"owner");
    const webPortInput=option(args,"--web-port");
    if(webPortInput!==undefined&&(!args.includes("--vpn-web")||!/^\d+$/.test(webPortInput)||Number(webPortInput)<1024||Number(webPortInput)>65535))
      throw new InstallerError("Use --web-port with --vpn-web and a port from 1024 through 65535.");
    let webPort=webPortInput===undefined?undefined:Number(webPortInput);
    if(args.includes("--ssh-sign-in")){
      const coordinator=new Coordinator(runner),config=savedConfiguration(coordinator,runner,instance);
      if(config.active.sequence<6)throw new InstallerError("Run the current installer with --vpn-web first to update terminal setup.");
      publishSetupNetwork(runner,config);
      if((await runTerminalSetup(terminal,setupControl(runner,instance))).completed)printSavedConnection(terminal,coordinator,runner,instance);
      return;
    }
    if(args.includes("--scan")){
      const range=option(args,"--scan")!;
      terminal.print(checked(runner,["exec",resourceName(instance,"owner"),"node","scripts/shared-control.ts","scan","default",range]));return;
    }
    const coordinator=new Coordinator(runner);
    if(args.includes("--connect")){printSavedConnection(terminal,coordinator,runner,instance);return;}
    cliSection(terminal,"GridLens installation");
    terminal.print("GridLens will run on this PC. After installation, open its URL to add your Nosana PCs.");
    const base=option(args,"--release");if(!base)throw new InstallerError("Use the signed release launcher or provide its pinned --release URL.");
    const manifest=await download(releaseURL(base,"modern-release.json"),16_384);
    const signature=await download(releaseURL(base,"modern-release.sig"),64);
    let release=verifyRelease(manifest,signature,GRIDLENS_RELEASE_PUBLIC_KEY);
    if(release.platform!==`${process.platform}-${process.arch}`)throw new InstallerError("This release does not support this platform.");
    checked(runner,["version","--format","{{.Server.Version}}"]);
    if(findReleaseImage(runner,release)===undefined){
      terminal.print("");
      terminal.print(cliText(terminal,"pending","Downloading and verifying GridLens…"));
      const directory=mkdtempSync(join(tmpdir(),"gridlens-modern-"));
      try{const file=await downloadArtifactToFile(base,release.runtime,directory);checked(runner,["load","--input",file]);}finally{rmSync(directory,{recursive:true,force:true});}
    }
    // Resolve the signed manifest/config identity on this Docker store before
    // any helper container or installation lock is started.
    release=runtimeRelease(release,requireReleaseImage(runner,release));
    let bindAddress:string|undefined,port:number|undefined,repairPort:number|undefined,certificate:{certificate:string;privateKey:string}|undefined;
    const observed=coordinator.configuration(instance,release.imageId);
    if(observed&&observed.phase==="ready"&&!args.includes("--rollback")&&release.sequence<observed.active.sequence){
      coordinator.validateManagedRuntime(observed);
      const saved=readVpnWebEndpoint(runner,observed);
      terminal.print(cliText(terminal,"muted",`The newer installed version ${observed.active.version} was retained. No public release was applied.`));
      terminal.print(cliText(terminal,"action",`Dashboard: ${saved?.origin??observed.origin}`));
      return;
    }
    releaseMaintenanceLock=await acquireMaintenanceLock(runner,instance,observed?.updater?observed.active.imageId:release.imageId);
    const previous=coordinator.configuration(instance,release.imageId);
    if(previous)guardTerminalUpdate(runner,previous);
    const action=args.includes("--rollback")?"rollback":args.includes("--upgrade")||previous&&!previous.updater&&release.sequence>previous.active.sequence
      ||args.includes("--vpn-web")&&previous&&previous.active.sequence<9?"upgrade":"setup";
    if(!previous){
      assertLocalDockerForSelection(runner);
      const selected=await choosePrivateEndpoint(terminal,discoverPrivateEndpoints(networkInterfaces(),dockerNetworkExclusions(runner)));
      bindAddress=selected.address;
      if(args.includes("--vpn-web")){
        const selectedPorts=await choosePrivateWebPorts(terminal,bindAddress,webPort===undefined?{}:{requestedWebPort:webPort});
        webPort=selectedPorts.webPort;port=selectedPorts.httpsPort;
      }else{port=await chooseDashboardPort(terminal,bindAddress);certificate=await chooseTlsConfiguration(terminal,bindAddress);}
    }else repairPort=await chooseSavedEndpointRepair(terminal,previous,config=>{
      const endpoint=coordinator.endpointStatus(config);
      if(endpoint.repairRequired)assertLocalDockerForSelection(runner);
      return endpoint;
    });
    terminal.print("");terminal.print(cliText(terminal,"pending","Preparing GridLens…"));
    const result=coordinator.install({instance,release,action,enableUpdater:true,...(bindAddress?{bindAddress}:{}),...(port?{port}:{}),...(repairPort?{repairPort}:{}),...(certificate?{certificate}:{})});
    await verifyGateway(result.config.origin,result.certificate);
    if(result.retainedNewer){
      const saved=readVpnWebEndpoint(runner,result.config);
      terminal.print(cliText(terminal,"muted",`The newer installed version ${result.config.active.version} was retained. No public release was applied.`));
      terminal.print(cliText(terminal,"action",`Dashboard: ${saved?.origin??result.config.origin}`));
      return;
    }
    if(args.includes("--vpn-web")&&webPort===undefined&&!inspectOwned(runner,"container",resourceName(instance,"vpn-web"),instance)){
      assertLocalDockerForSelection(runner);
      webPort=await chooseDashboardPort(terminal,result.config.bindAddress,{preferred:result.config.port===65535?65534:result.config.port+1,label:"Web dashboard port"});
    }
    const web=reconcileInstalledServices(runner,result,release,{action,vpnWeb:args.includes("--vpn-web"),...(webPort===undefined?{}:{webPort})});
    if(web){
      if (!web.privateNetwork) throw new InstallerError("Run setup with --vpn-web to enable the permanent private browser address.");
      await verifyPrivateWeb(web.origin,true);
      publishSetupNetwork(runner,result.config);
      printBrowserReady(terminal,web.origin);
      return;
    }
    terminal.print(`Server TLS certificate SHA-256 (Android pin): ${result.config.certificateSha256}`);
    await offerPublicCertificateExport(terminal,instance,result.certificate,{existingTrusted:certificate!==undefined});
    if(result.config.active.sequence>=5)publishSetupNetwork(runner,result.config);
    terminal.print(browserConnectionText(result.config.origin,coordinator.operatorCode(instance),result.config.active.sequence>=3));
  }finally{await releaseMaintenanceLock?.();terminal.close();}
}
