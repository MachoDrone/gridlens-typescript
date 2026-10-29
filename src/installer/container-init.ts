/** Fixed container-local installer operations. No request path or browser loads this module. */
import { X509Certificate, createHash, createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, chownSync, closeSync, copyFileSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateInstallation, originFor } from "./config.ts";
import type { InstallationConfig } from "./config.ts";
import { InstallerError } from "./release.ts";

function atomic(path: string, value: string, mode = 0o600): void {
  const temporary = `${path}.pending-${randomBytes(6).toString("hex")}`;
  const fd = openSync(temporary, "wx", mode);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const dir = openSync(path.substring(0,path.lastIndexOf("/")),"r");try{fsyncSync(dir);}finally{closeSync(dir);}
}
function openssl(args: string[]): void {
  const result=spawnSync("openssl",args,{stdio:"pipe",shell:false,timeout:30_000});
  if(result.status!==0)throw new InstallerError("Private certificate generation failed; the saved identity was retained.");
}
function checkCertificate(certificate: string, privateKey: string, address: string): X509Certificate {
  const cert = new X509Certificate(certificate), key = createPrivateKey(privateKey);
  if (!cert.checkIP(address) || new Date(cert.validFrom).getTime()>Date.now() || new Date(cert.validTo).getTime()<=Date.now()
    || !cert.publicKey.export({type:"spki",format:"der"}).equals(createPublicKey(key).export({type:"spki",format:"der"}))) {
    throw new InstallerError("The TLS certificate is expired, does not match the key, or does not cover the assigned address.");
  }
  return cert;
}
function ownedDirectory(path: string): void { mkdirSync(path,{recursive:true,mode:0o700});chmodSync(path,0o700);chownSync(path,1000,1000); }
/** Publish a new bearer atomically without replacing an existing gateway identity. */
export function vpnWebAuthorization(directory = "/vpn-auth"): { version: 1; token: string } {
  ownedDirectory(directory);
  const path=join(directory,"browser.json");
  if(!existsSync(path)) {
    const temporary=join(directory,`.browser-${randomBytes(8).toString("hex")}`);
    const fd=openSync(temporary,"wx",0o600);
    try { writeFileSync(fd,JSON.stringify({version:1,token:randomBytes(32).toString("base64url")}));fsyncSync(fd); }
    finally { closeSync(fd); }
    chownSync(temporary,1000,1000);
    try { linkSync(temporary,path); }
    catch(error) { if(!(error instanceof Error&&"code" in error&&error.code==="EEXIST"))throw error; }
    finally { unlinkSync(temporary); }
    const parent=openSync(directory,"r");try{fsyncSync(parent);}finally{closeSync(parent);}
  }
  const saved=lstatSync(path);
  if(!saved.isFile()||saved.size>256||(saved.mode&0o777)!==0o600||saved.uid!==1000||saved.gid!==1000)
    throw new InstallerError("The saved browser authorization file is invalid; it was retained for recovery.");
  let value: {version?:unknown;token?:unknown};
  try { value=JSON.parse(readFileSync(path,"utf8")); } catch { throw new InstallerError("The saved browser authorization file could not be read; it was retained for recovery."); }
  if(!value||value.version!==1||typeof value.token!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(value.token)||Object.keys(value).some(key=>!['version','token'].includes(key)))
    throw new InstallerError("The saved browser authorization file is invalid; it was retained for recovery.");
  return {version:1,token:value.token};
}
function copyDirectory(source: string, destination: string): void {
  for(const name of readdirSync(source)) {
    const from=join(source,name),to=join(destination,name),st=lstatSync(from);
    if(st.isSymbolicLink()||!st.isFile()&&!st.isDirectory())throw new InstallerError("Unexpected state object; recovery stopped without replacing it.");
    if(st.isDirectory()){mkdirSync(to,{mode:st.mode&0o777});copyDirectory(from,to);}else{copyFileSync(from,to);chmodSync(to,st.mode&0o777);const fd=openSync(to,"r");try{fsyncSync(fd);}finally{closeSync(fd);}}
    chownSync(to,1000,1000);
  }
  chownSync(destination,1000,1000);
  const fd=openSync(destination,"r");try{fsyncSync(fd);}finally{closeSync(fd);}
}
export function containerOperation(operation: string, body: unknown): unknown {
  if(operation==="vpn-web-auth")return vpnWebAuthorization();
  if(operation==="read")return existsSync("/config/installation.json")?validateInstallation(JSON.parse(readFileSync("/config/installation.json","utf8"))):null;
  if(operation==="save") {const config=validateInstallation(body);atomic("/config/installation.json",JSON.stringify(config));return {saved:true};}
  if(operation==="certificate")return readFileSync(existsSync("/config/ca.crt")?"/config/ca.crt":"/tls/server.crt","utf8");
  if(operation==="copy-state") {if(readdirSync("/destination").length)throw new InstallerError("Recovery destination is not empty.");copyDirectory("/source","/destination");return {copied:true};}
  if(operation!=="initialize"||!body||typeof body!=="object")throw new InstallerError("Unsupported installer operation.");
  if(existsSync("/config/installation.json"))return validateInstallation(JSON.parse(readFileSync("/config/installation.json","utf8")));
  const input=body as {instance:string;bindAddress:string;port:number;origin:string;active:InstallationConfig["active"];certificate?:{certificate:string;privateKey:string}};
  if(input.origin!==originFor(input.bindAddress,input.port))throw new InstallerError("Invalid certificate address.");
  const staged="/config/tls-staging";mkdirSync(staged,{recursive:true,mode:0o700});
  const keyPath=join(staged,"server.key"),certPath=join(staged,"server.crt");
  if(!existsSync(keyPath)||!existsSync(certPath)) {
    if(input.certificate){
      checkCertificate(input.certificate.certificate,input.certificate.privateKey,input.bindAddress);
      atomic(keyPath,input.certificate.privateKey);atomic(certPath,input.certificate.certificate);
    }else{
      if(!existsSync("/config/ca.key"))openssl(["genpkey","-algorithm","RSA","-pkeyopt","rsa_keygen_bits:3072","-out","/config/ca.key"]);
      if(!existsSync("/config/ca.crt"))openssl(["req","-x509","-new","-key","/config/ca.key","-out","/config/ca.crt","-days","3650","-subj","/CN=GridLens Private Trust", "-addext","basicConstraints=critical,CA:TRUE","-addext","keyUsage=critical,keyCertSign,cRLSign"]);
      if(!existsSync(keyPath))openssl(["genpkey","-algorithm","RSA","-pkeyopt","rsa_keygen_bits:3072","-out",keyPath]);
      const csr=join(staged,"server.csr"),ext=join(staged,"leaf.ext");
      atomic(ext,`basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:${input.bindAddress}\n`);
      openssl(["req","-new","-key",keyPath,"-out",csr,"-subj","/CN=GridLens"]);
      openssl(["x509","-req","-in",csr,"-CA","/config/ca.crt","-CAkey","/config/ca.key","-set_serial",`0x${randomBytes(16).toString("hex")}`,"-out",certPath,"-days","365","-extfile",ext]);
    }
  }
  const certificate=readFileSync(certPath,"utf8"),key=readFileSync(keyPath,"utf8");
  const verified=checkCertificate(certificate,key,input.bindAddress);
  // A crash after one write resumes from the same staged key/certificate pair.
  atomic("/tls/server.key",key);atomic("/tls/server.crt",certificate,0o644);
  chownSync("/tls/server.key",1000,1000);chownSync("/tls/server.crt",1000,1000);
  for(const dir of ["/state","/ledger","/ipc","/control","/credentials","/tls"])ownedDirectory(dir);
  chmodSync("/config",0o700);
  const config=validateInstallation({schema:1,instance:input.instance,bindAddress:input.bindAddress,port:input.port,origin:input.origin,
    certificateSha256:createHash("sha256").update(verified.raw).digest("hex"),phase:"prepared",active:input.active});
  atomic("/config/installation.json",JSON.stringify(config));
  return config;
}
if(process.argv[1]?.endsWith("/container-init.ts")) {
  try {process.umask(0o077);const bytes=readFileSync(0);if(bytes.length>2*1024*1024)throw new InstallerError("Installer input is too large.");
    const value=containerOperation(process.argv[2]??"",JSON.parse(bytes.toString("utf8")||"{}"));
    process.stdout.write(typeof value==="string"?value:JSON.stringify(value));
  }catch(error){console.error(error instanceof InstallerError?error.message:"Installer state operation failed; saved data was retained.");process.exitCode=1;}
}
