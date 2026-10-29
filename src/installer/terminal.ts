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
import { ensureVpnWeb, readVpnWebEndpoint } from "./vpn-web.ts";
import { InstallerError, releaseURL, verifyArtifact, verifyRelease } from "./release.ts";
import type { ReleaseArtifact } from "./release.ts";
import { assertLocalDockerForSelection, chooseDashboardPort, choosePrivateEndpoint, discoverPrivateEndpoints, dockerNetworkExclusions, probeBindPort } from "./network-selection.ts";
import type { PortProbe, SelectionPrompts } from "./network-selection.ts";
import type { InstallationConfig } from "./config.ts";

declare const GRIDLENS_RELEASE_PUBLIC_KEY: string;

export interface TerminalPrompts { ask(prompt: string): Promise<string>; secret(prompt: string): Promise<string>; print(text: string): void; close(): void }

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
    terminal.print("Resuming the saved image/state transaction before assessing its dashboard endpoint.");
    return undefined;
  }
  const port = previous.pendingPort ?? previous.port, endpoint = assess(previous);
  if (!endpoint.repairRequired) {
    terminal.print(previous.pendingPort === undefined ? `Keeping the saved dashboard endpoint ${previous.origin}.`
      : "Completing the saved dashboard-port repair. Existing TLS identity, credentials and data are retained.");
    return undefined;
  }
  const availability = await probe(previous.bindAddress, port);
  if (availability === "unavailable") throw new InstallerError("The saved dashboard address cannot be bound on this PC. Restore its existing private network/VPN connection before retrying. The saved address, TLS identity and data were retained.");
  if (availability === "busy") {
    terminal.print(`The ${previous.pendingPort === undefined ? "saved" : "pending"} dashboard endpoint is not working, and port ${port} is now occupied. Choose a free replacement port to repair it. TLS identity, credentials and data will be retained; the other service stays running.`);
    return chooseDashboardPort(terminal, previous.bindAddress, { probe });
  }
  terminal.print("The saved dashboard port is available. Repairing the existing endpoint while retaining TLS identity, credentials and data.");
  return undefined;
}
export function controllingTerminal(): TerminalPrompts {
  let inputFd: number,outputFd: number;
  try {inputFd=openSync("/dev/tty","r");outputFd=openSync("/dev/tty","w");}catch{throw new InstallerError("Setup requires a controlling terminal; piped/headless secret entry is not supported.");}
  const input=new ReadStream(inputFd),output=new WriteStream(outputFd);
  if(!input.isTTY||!output.isTTY)throw new InstallerError("Setup requires a controlling terminal.");
  let closed=false;
  return {
    async ask(prompt){const line=createInterface({input,output,terminal:true});try{return (await line.question(prompt)).trim();}finally{line.close();}},
    secret(prompt){
      output.write(prompt);input.setRawMode(true);input.resume();
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
async function downloadArtifact(base: string, artifact: ReleaseArtifact): Promise<Uint8Array> {
  const bytes=await download(releaseURL(base,artifact.name),artifact.bytes);verifyArtifact(bytes,artifact);return bytes;
}
function option(args: readonly string[], name: string): string | undefined {const at=args.indexOf(name);if(at<0)return undefined;const value=args[at+1];if(!value||value.startsWith("--"))throw new InstallerError(`Missing ${name} value.`);return value;}
function savedConfiguration(coordinator: Coordinator, runner: DockerRunner, instance: string): InstallationConfig {
  const gateway = inspectOwned(runner, "container", resourceName(instance, "gateway"), instance);
  if (typeof gateway?.Image !== "string") throw new InstallerError("The saved backend is not available. Rerun setup first.");
  const config = coordinator.configuration(instance, gateway.Image);
  if (!config) throw new InstallerError("The saved backend configuration is not available. Rerun setup first.");
  return config;
}
function printSavedConnection(terminal: TerminalPrompts, coordinator: Coordinator, runner: DockerRunner, instance: string): void {
  const config = savedConfiguration(coordinator, runner, instance), web = readVpnWebEndpoint(runner, config);
  if (web) {
    if (!web.privateNetwork) throw new InstallerError("Run setup with --vpn-web to enable the permanent private browser address.");
    terminal.print(privateBrowserConnectionText(web.origin));
  } else terminal.print(browserConnectionText(config.origin, coordinator.operatorCode(instance), config.active.sequence >= 3));
}
export async function runTerminal(args=process.argv.slice(2), suppliedTerminal?:TerminalPrompts):Promise<void>{
  if(args.includes("--help")){console.log("GridLens modern coordinator v1\nRequires existing Docker and an assigned private address on your existing VPN.\n--release PINNED_HTTPS_RELEASE [--instance NAME] [--upgrade | --rollback | --connect | --ssh-sign-in | --scan RANGE]\n--vpn-web adds browser access without certificate installation on your private LAN/existing VPN; local LAN traffic uses HTTP. Optional --web-port PORT. Existing HTTPS remains available for Android.\nAll secrets are entered in the controlling terminal. No host Node or Python is required.");return;}
  if(args.includes("--version")){console.log("gridlens-modern-coordinator 1 / Node "+process.versions.node);return;}
  process.umask(0o077);
  const terminal=suppliedTerminal??controllingTerminal(),runner=localDockerRunner();
  try{
    const instance=option(args,"--instance")??"default";resourceName(instance,"owner");
    if(args.includes("--ssh-sign-in")){
      terminal.print("Sign in to the computers selected in browser setup. Credentials go only to the backend owner, never the browser.");
      const username=await terminal.ask("Computer username: ");
      const kind=await terminal.ask("Use an SSH key or password? [key/password]: ");
      let credentials:Record<string,string>;
      if(kind==="key"){
        const file=await terminal.ask("SSH private-key file path: ");
        const privateKey=readFileSync(file.startsWith("~/")?join(homedir(),file.slice(2)):file,"utf8");
        if(privateKey.length>1024*1024)throw new InstallerError("SSH key file is too large.");
        const passphrase=await terminal.secret("Key passphrase (empty if none): ");credentials={privateKey,passphrase};
      }else if(kind==="password")credentials={password:await terminal.secret("Computer password: ")};
      else throw new InstallerError("Choose key or password in the terminal.");
      const sudo=await terminal.ask("Do the selected computers require sudo for Docker inspection? [yes/no]: ");
      if(sudo==="yes")credentials.sudoPassword=await terminal.secret("Computer sudo password (empty only when its sudo policy needs none): ");
      else if(sudo!=="no")throw new InstallerError("Choose yes or no for computer sudo in the terminal.");
      const remember=(await terminal.ask("Remember encrypted credentials for approved automatic monitoring? [yes/no]: "))==="yes";
      const result=checked(runner,["exec","-i",resourceName(instance,"owner"),"node","scripts/shared-control.ts","json"],JSON.stringify({operation:"setup-auth",scopeId:"default",username,...credentials,remember}));
      terminal.print(result);
      terminal.print("Return to the browser to choose Inspect + automatic IP or Inspect only, with separate full-monitoring approval. Waiting for that selection…");
      for(;;){
        const status=JSON.parse(checked(runner,["exec",resourceName(instance,"owner"),"node","scripts/shared-control.ts","setup-status","default"])) as {phase?:string};
        if(status.phase==="inspecting"){
          terminal.print("Inspecting the selected computers. Keep this terminal open.");
          terminal.print(checked(runner,["exec",resourceName(instance,"owner"),"node","scripts/shared-control.ts","setup-inspect","default"]));
          terminal.print("Fleet coverage saved. Open GridLens:");
          printSavedConnection(terminal,new Coordinator(runner),runner,instance);break;
        }
        if(status.phase!=="review")throw new InstallerError("Setup phase changed. Review the browser status before signing in again.");
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
      return;
    }
    if(args.includes("--scan")){
      const range=option(args,"--scan")!;
      terminal.print(checked(runner,["exec",resourceName(instance,"owner"),"node","scripts/shared-control.ts","scan","default",range]));return;
    }
    const coordinator=new Coordinator(runner);
    if(args.includes("--connect")){printSavedConnection(terminal,coordinator,runner,instance);return;}
    const base=option(args,"--release");if(!base)throw new InstallerError("Use the signed release launcher or provide its pinned --release URL.");
    const manifest=await download(releaseURL(base,"modern-release.json"),16_384);
    const signature=await download(releaseURL(base,"modern-release.sig"),64);
    const release=verifyRelease(manifest,signature,GRIDLENS_RELEASE_PUBLIC_KEY);
    if(release.platform!==`${process.platform}-${process.arch}`)throw new InstallerError("This release does not support this platform.");
    checked(runner,["version","--format","{{.Server.Version}}"]);
    const image=runner.run(["image","inspect",release.imageId]);
    if(image.status!==0){
      terminal.print("Downloading and verifying the signed runtime image.");
      const bytes=await downloadArtifact(base,release.runtime),directory=mkdtempSync(join(tmpdir(),"gridlens-modern-"));
      try{const file=join(directory,"runtime.tar");writeFileSync(file,bytes,{mode:0o600});checked(runner,["load","--input",file]);}finally{rmSync(directory,{recursive:true,force:true});}
    }
    let bindAddress:string|undefined,port:number|undefined,repairPort:number|undefined,certificate:{certificate:string;privateKey:string}|undefined;
    const previous=coordinator.configuration(instance,release.imageId);
    const action=args.includes("--rollback")?"rollback":args.includes("--upgrade")||args.includes("--vpn-web")&&previous&&previous.active.sequence<4?"upgrade":"setup";
    if(!previous){
      terminal.print("Scanning and monitoring run on this chosen backend PC. Run this terminal on that PC, including through an interactive SSH login. Setup does not change VPN, DNS or host networking.");
      assertLocalDockerForSelection(runner);
      const selected=await choosePrivateEndpoint(terminal,discoverPrivateEndpoints(networkInterfaces(),dockerNetworkExclusions(runner)));
      bindAddress=selected.address;port=await chooseDashboardPort(terminal,bindAddress);
      if(!args.includes("--vpn-web"))certificate=await chooseTlsConfiguration(terminal,bindAddress);
    }else repairPort=await chooseSavedEndpointRepair(terminal,previous,config=>{
      const endpoint=coordinator.endpointStatus(config);
      if(endpoint.repairRequired)assertLocalDockerForSelection(runner);
      return endpoint;
    });
    const result=coordinator.install({instance,release,action,...(bindAddress?{bindAddress}:{}),...(port?{port}:{}),...(repairPort?{repairPort}:{}),...(certificate?{certificate}:{})});
    await verifyGateway(result.config.origin,result.certificate);
    terminal.print(result.retainedNewer?"Retained the newer installed runtime; no downgrade was performed.":`Runtime ${result.config.active.version} is ready.`);
    const requestedWebPort=option(args,"--web-port");
    const web=args.includes("--vpn-web")?ensureVpnWeb(runner,result.config,release,requestedWebPort===undefined?undefined:Number(requestedWebPort),{upgrade:true})
      :readVpnWebEndpoint(runner,result.config);
    if(web){
      if (!web.privateNetwork) throw new InstallerError("Run setup with --vpn-web to enable the permanent private browser address.");
      await verifyPrivateWeb(web.origin,true);
      terminal.print("Browser access is ready on your private LAN/existing VPN.");
      terminal.print(privateBrowserConnectionText(web.origin));
      terminal.print(`Android HTTPS remains available: ${result.config.origin}`);
      return;
    }
    terminal.print(`Dashboard: ${result.config.origin}\nServer TLS certificate SHA-256 (Android pin): ${result.config.certificateSha256}`);
    await offerPublicCertificateExport(terminal,instance,result.certificate,{existingTrusted:certificate!==undefined});
    terminal.print(browserConnectionText(result.config.origin,coordinator.operatorCode(instance),result.config.active.sequence>=3));
  }finally{terminal.close();}
}
