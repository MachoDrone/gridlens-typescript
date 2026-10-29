import { build } from "esbuild";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const project=resolve(fileURLToPath(new URL("../",import.meta.url)));
const require=createRequire(import.meta.url);
const {inject}=require("postject") as {inject:(file:string,name:string,data:Buffer,options:{sentinelFuse:string;overwrite:boolean})=>Promise<void>};
export interface CoordinatorBuildOptions { outputDirectory:string;publicKeyPath:string;signingKeyPath:string;releaseTag:string }
export async function buildCoordinator(options:CoordinatorBuildOptions):Promise<string>{
  if(process.versions.node!=="24.14.1"||process.platform!=="linux"||!["x64","arm64"].includes(process.arch))throw new Error("Build the coordinator with pinned Node 24.14.1 on its Linux target architecture.");
  if(!/^[a-zA-Z0-9._-]+$/.test(options.releaseTag))throw new Error("Invalid release tag.");
  const output=resolve(options.outputDirectory);
  if(existsSync(output))throw new Error("Use a new output directory so an existing signed coordinator cannot be overwritten.");
  const publicKey=readFileSync(options.publicKeyPath,"utf8"),privateKey=createPrivateKey(readFileSync(options.signingKeyPath));
  if(privateKey.asymmetricKeyType!=="ed25519"||!createPublicKey(privateKey).export({type:"spki",format:"der"}).equals(createPublicKey(publicKey).export({type:"spki",format:"der"})))throw new Error("The release Ed25519 signing key and public key do not match.");
  const nodeLicense=join(dirname(dirname(process.execPath)),"LICENSE");
  if(!existsSync(nodeLicense))throw new Error("The pinned Node distribution license must accompany the standalone executable.");
  mkdirSync(dirname(output),{recursive:true});mkdirSync(output,{mode:0o700});
  copyFileSync(join(project,"LICENSE"),join(output,"LICENSE"));copyFileSync(nodeLicense,join(output,"NODE-LICENSE"));
  const staging=mkdtempSync(join(output,".build-")),main=join(staging,"coordinator.cjs");
  await build({entryPoints:[join(project,"src/installer/terminal-entry.ts")],bundle:true,platform:"node",target:"node24",format:"cjs",outfile:main,
    define:{GRIDLENS_RELEASE_PUBLIC_KEY:JSON.stringify(publicKey)},logLevel:"silent"});
  const config=join(staging,"sea.json"),blob=join(staging,"coordinator.blob");
  writeFileSync(config,JSON.stringify({main,output:blob,disableExperimentalSEAWarning:true,useSnapshot:false,useCodeCache:false,execArgvExtension:"none"}));
  const generated=spawnSync(process.execPath,["--experimental-sea-config",config],{stdio:"pipe"});
  if(generated.status!==0)throw new Error("Node SEA blob generation failed.");
  const name=`gridlens-coordinator-${process.platform}-${process.arch}`,binary=join(output,name);
  copyFileSync(process.execPath,binary);chmodSync(binary,0o700);
  await inject(binary,"NODE_SEA_BLOB",readFileSync(blob),{sentinelFuse:"NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",overwrite:false});
  const bytes=readFileSync(binary),signature=sign(null,bytes,privateKey);
  if(!verify(null,bytes,createPublicKey(publicKey),signature))throw new Error("Coordinator signature self-check failed.");
  writeFileSync(`${binary}.sig`,signature,{mode:0o600});
  const sha256=createHash("sha256").update(bytes).digest("hex");
  writeFileSync(join(output,"coordinator-manifest.json"),JSON.stringify({format:"gridlens-modern-coordinator-v1",coordinatorVersion:1,node:"24.14.1",platform:`${process.platform}-${process.arch}`,releaseTag:options.releaseTag,name,bytes:bytes.length,sha256,signature:`${name}.sig`,signingPublicKey:publicKey},null,2)+"\n",{mode:0o600});
  const launcher=readFileSync(join(project,"scripts/modern-start.sh"),"utf8").replaceAll("@RELEASE_TAG@",options.releaseTag).replaceAll("@COORDINATOR_NAME@",name).replaceAll("@COORDINATOR_SHA256@",sha256);
  writeFileSync(join(output,"modern-start.sh"),launcher,{mode:0o700});
  const smoke=spawnSync(binary,["--version"],{encoding:"utf8",env:{PATH:"/nonexistent",NODE_OPTIONS:"--invalid-injected-option"},cwd:output});
  if(smoke.status!==0||!smoke.stdout.includes("gridlens-modern-coordinator 1 / Node 24.14.1"))throw new Error("The standalone coordinator failed its no-host-Node smoke test.");
  rmSync(staging,{recursive:true});
  return output;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),get=(name:string):string=>{const at=args.indexOf(name);if(at<0||!args[at+1])throw new Error(`Missing ${name}.`);return args[at+1]!;};
  try{console.log(await buildCoordinator({outputDirectory:get("--output"),publicKeyPath:get("--public-key"),signingKeyPath:get("--signing-key"),releaseTag:get("--release-tag")}));}
  catch(error){console.error(error instanceof Error?error.message:"Coordinator build failed.");process.exitCode=1;}
}
