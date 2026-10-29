import { createPrivateKey } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { ReadStream, WriteStream } from "node:tty";
import { Coordinator } from "./coordinator.ts";
import { verifyGateway } from "./health.ts";
import { checked, localDockerRunner, resourceName } from "./docker.ts";
import { InstallerError, releaseURL, verifyArtifact, verifyRelease } from "./release.ts";
import type { ReleaseArtifact } from "./release.ts";

declare const GRIDLENS_RELEASE_PUBLIC_KEY: string;

export interface TerminalPrompts { ask(prompt: string): Promise<string>; secret(prompt: string): Promise<string>; print(text: string): void; close(): void }
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
export async function runTerminal(args=process.argv.slice(2), suppliedTerminal?:TerminalPrompts):Promise<void>{
  if(args.includes("--help")){console.log("GridLens modern coordinator v1\nRequires existing Docker and an assigned private address on your existing VPN.\n--release PINNED_HTTPS_RELEASE [--instance NAME] [--upgrade | --rollback | --connect | --ssh-sign-in | --scan RANGE]\nAll secrets are entered in the controlling terminal. No host Node or Python is required.");return;}
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
          terminal.print("Fleet coverage changed. Reconnect in the browser with this new operator code:");
          terminal.print(new Coordinator(runner).operatorCode(instance));break;
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
    if(args.includes("--connect")){terminal.print(coordinator.operatorCode(instance));return;}
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
    const action=args.includes("--rollback")?"rollback":args.includes("--upgrade")?"upgrade":"setup";
    let bindAddress:string|undefined,port:number|undefined,certificate:{certificate:string;privateKey:string}|undefined;
    const previous=coordinator.configuration(instance,release.imageId);
    if(!previous){
      terminal.print("Scanning and monitoring run on this chosen backend PC. Use its existing VPN/private address; setup does not change VPN, DNS or host networking.");
      bindAddress=await terminal.ask("Assigned private IP: ");port=Number(await terminal.ask("Dashboard HTTPS port [8789]: ")||"8789");
      const mode=await terminal.ask("Use an existing trusted TLS certificate or create a private certificate? [existing/private]: ");
      if(mode==="existing"){
        const certPath=await terminal.ask("Certificate/full-chain PEM file: "),keyPath=await terminal.ask("TLS private-key PEM file: ");
        const raw=readFileSync(keyPath,"utf8");
        const passphrase=raw.includes("ENCRYPTED")?await terminal.secret("TLS key passphrase: "):undefined;
        const key=createPrivateKey({key:raw,...(passphrase?{passphrase}:{})});
        certificate={certificate:readFileSync(certPath,"utf8"),privateKey:key.export({format:"pem",type:"pkcs8"}).toString()};
      }else if(mode!=="private")throw new InstallerError("Choose existing or private certificate setup.");
    }
    const result=coordinator.install({instance,release,action,...(bindAddress?{bindAddress}:{}),...(port?{port}:{}),...(certificate?{certificate}:{})});
    await verifyGateway(result.config.origin,result.certificate);
    terminal.print(result.retainedNewer?"Retained the newer installed runtime; no downgrade was performed.":`Runtime ${result.config.active.version} is ready.`);
    terminal.print(`Dashboard: ${result.config.origin}\nServer certificate SHA-256: ${result.config.certificateSha256}`);
    terminal.print("For a private certificate, install only this public CA certificate in each browser/device trust store. Confirm its fingerprint in this terminal. Never bypass a certificate warning. Android pairing separately pins the server identity.");
    const exportPath=await terminal.ask("Optional path to save the public trust certificate (empty to skip): ");
    if(exportPath){const fd=openSync(exportPath,"wx",0o600);try{writeFileSync(fd,result.certificate);}finally{closeSync(fd);}terminal.print("Public trust certificate saved.");}
    terminal.print(coordinator.operatorCode(instance));
  }finally{terminal.close();}
}
