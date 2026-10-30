import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildCoordinator } from "./build-coordinator.ts";
import { parseRelease } from "../src/installer/release.ts";
import { checked, localDockerRunner } from "../src/installer/docker.ts";

/** Build/publish preparation only: this command never pushes an image or uploads a release. */
export async function buildModernRelease(options:{output:string;version:string;sequence:number;tag:string;signingKey:string;publicKey:string}):Promise<string>{
  if(!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(options.version)||!Number.isSafeInteger(options.sequence)||options.sequence<1)throw new Error("Use a valid version and monotonically increasing release sequence.");
  if(options.tag!==`modern-v${options.version}`)throw new Error("The signed update channel requires the exact modern-vVERSION release tag.");
  process.umask(0o077);
  const output=resolve(options.output);mkdirSync(output,{mode:0o700});
  const project=fileURLToPath(new URL("../",import.meta.url));
  const runner=localDockerRunner({execute:(command,args,settings)=>spawnSync(command,args,{...settings,cwd:project})});
  const docker=(args:string[]):string=>checked(runner,args);
  const imageName=`gridlens-modern-build:${options.version}-${options.sequence}`;
  const publicKeyText = readFileSync(options.publicKey, "utf8");
  if (createPublicKey(publicKeyText).asymmetricKeyType !== "ed25519") throw new Error("The update trust anchor must be Ed25519.");
  docker(["build","--no-cache","--file","Dockerfile.shared","--build-arg",`GRIDLENS_VERSION=${options.version}`,
    "--build-arg",`GRIDLENS_SEQUENCE=${options.sequence}`,"--build-arg",`GRIDLENS_UPDATE_PUBLIC_KEY_BASE64=${Buffer.from(publicKeyText).toString("base64")}`,"--tag",imageName,"."]);
  const imageId=docker(["image","inspect","--format","{{.Id}}",imageName]);
  const artifactName=`gridlens-runtime-${process.platform}-${process.arch}-${options.version}.tar`,artifact=join(output,artifactName);
  docker(["save","--output",artifact,imageName]);
  const bytes=readFileSync(artifact);
  const manifest=parseRelease({format:"gridlens-modern-release-v1",version:options.version,sequence:options.sequence,platform:`${process.platform}-${process.arch}`,minimumCoordinator:1,imageId,
    runtime:{name:artifactName,bytes:statSync(artifact).size,sha256:createHash("sha256").update(bytes).digest("hex")}});
  const manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+"\n"),key=createPrivateKey(readFileSync(options.signingKey)),publicKey=createPublicKey(readFileSync(options.publicKey));
  if(key.asymmetricKeyType!=="ed25519")throw new Error("Modern releases require an Ed25519 signing identity.");
  const signature=sign(null,manifestBytes,key);if(!verify(null,manifestBytes,publicKey,signature))throw new Error("Signing key does not match the release trust anchor.");
  writeFileSync(join(output,"modern-release.json"),manifestBytes,{mode:0o600});writeFileSync(join(output,"modern-release.sig"),signature,{mode:0o600});
  const channel = Buffer.from(JSON.stringify({ format: "gridlens-modern-channel-v1", channel: "development", platform: manifest.platform,
    version: manifest.version, sequence: manifest.sequence, buildId: `${manifest.sequence}:${manifest.version}`, releaseTag: options.tag,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"), workerProtocol: 1 }, null, 2) + "\n");
  writeFileSync(join(output, `modern-channel-${manifest.platform}.json`), channel, { mode: 0o600 });
  writeFileSync(join(output, `modern-channel-${manifest.platform}.sig`), sign(null, channel, key), { mode: 0o600 });
  const coordinator=await buildCoordinator({outputDirectory:join(output,"coordinator"),publicKeyPath:options.publicKey,signingKeyPath:options.signingKey,releaseTag:options.tag});
  for(const file of [`gridlens-coordinator-${process.platform}-${process.arch}`,`gridlens-coordinator-${process.platform}-${process.arch}.sig`,"coordinator-manifest.json","modern-start.sh","NODE-LICENSE"])copyFileSync(join(coordinator,file),join(output,file));
  copyFileSync(join(project,"LICENSE"),join(output,"LICENSE"));
  return output;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),get=(name:string):string=>{const at=args.indexOf(name);if(at<0||!args[at+1])throw new Error(`Missing ${name}.`);return args[at+1]!;};
  try{console.log(await buildModernRelease({output:get("--output"),version:get("--version"),sequence:Number(get("--sequence")),tag:get("--tag"),signingKey:get("--signing-key"),publicKey:get("--public-key")}));}
  catch(error){console.error(error instanceof Error?error.message:"Modern release build failed.");process.exitCode=1;}
}
