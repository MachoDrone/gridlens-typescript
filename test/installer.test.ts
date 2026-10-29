import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { Coordinator } from "../src/installer/coordinator.ts";
import { originFor } from "../src/installer/config.ts";
import type { InstallationConfig } from "../src/installer/config.ts";
import { inspectOwned, PRODUCT_LABEL, INSTANCE_LABEL, PRODUCT } from "../src/installer/docker.ts";
import type { DockerRunner, CommandResult } from "../src/installer/docker.ts";
import { parseRelease, releaseURL, verifyArtifact, verifyRelease } from "../src/installer/release.ts";
import type { ModernRelease } from "../src/installer/release.ts";

const release=(n=1):ModernRelease=>({format:"gridlens-modern-release-v1",version:`0.1.${n}`,sequence:n,platform:"linux-x64",minimumCoordinator:1,
  imageId:`sha256:${String(n).repeat(64)}`,runtime:{name:`gridlens-runtime-${n}.tar`,bytes:3,sha256:createHash("sha256").update("abc").digest("hex")}});
class DockerFixture implements DockerRunner {
  calls:{args:string[];input?:string}[]=[];
  objects=new Map<string,Record<string,unknown>>();config:InstallationConfig|undefined;
  images=new Map<string,ModernRelease>([1,2,3].map(n=>[release(n).imageId,release(n)]));
  failOnStart=false;
  fleets:{scopeId:string;addresses:string[]}[]=[];
  run(args:readonly string[],input?:string|Uint8Array):CommandResult{
    this.calls.push({args:[...args],...(input===undefined?{}:{input:typeof input==="string"?input:Buffer.from(input).toString()})});
    const ok=(value:unknown=""):CommandResult=>({status:0,stdout:typeof value==="string"?value:JSON.stringify(value),stderr:""});
    const missing:CommandResult={status:1,stdout:"",stderr:"No such object"};
    const at=(key:string):string=>args[args.indexOf(key)+1]!;
    const name=args.at(-1)!;
    if(args[0]==="version")return ok("28.0.0");
    if(args[0]==="image"&&args[1]==="inspect"){
      const r=this.images.get(name);return r?ok([{Id:r.imageId,Config:{Labels:{[PRODUCT_LABEL]:PRODUCT,"io.gridlens.version":r.version}}}]):missing;
    }
    if(["volume","network","container"].includes(args[0]!)&&args[1]==="inspect"){
      const item=this.objects.get(`${args[0]}:${name}`);return item?ok([item]):missing;
    }
    if(["volume","network"].includes(args[0]!)&&args[1]==="create"){
      this.objects.set(`${args[0]}:${name}`,{Labels:{[PRODUCT_LABEL]:PRODUCT,[INSTANCE_LABEL]:"default"}});return ok(name);
    }
    if(args[0]==="run"&&args.includes("src/installer/container-init.ts")){
      const operation=name,body=JSON.parse(typeof input==="string"?input:"{}");
      if(operation==="read")return ok(this.config??null);
      if(operation==="initialize"){
        this.config={schema:1,instance:body.instance,bindAddress:body.bindAddress,port:body.port,origin:body.origin,
          certificateSha256:"a".repeat(64),active:body.active,phase:"prepared"};return ok(this.config);
      }
      if(operation==="save"){this.config=body;return ok({saved:true});}
      if(operation==="copy-state")return ok({copied:true});
      if(operation==="certificate")return ok("PUBLIC CERTIFICATE");
    }
    if(args[0]==="run"){
      if(this.failOnStart){this.failOnStart=false;return {status:1,stdout:"",stderr:"simulated start interruption"};}
      const imageId=args.find(p=>/^sha256:/.test(p))!;
      this.objects.set(`container:${at("--name")}`,{Image:imageId,Config:{Labels:{[PRODUCT_LABEL]:PRODUCT,[INSTANCE_LABEL]:"default"},User:at("--user"),Cmd:["node",name]},
        HostConfig:{ReadonlyRootfs:true,Privileged:false,NetworkMode:at("--network"),CapDrop:["ALL"],SecurityOpt:["no-new-privileges:true"],PortBindings:args.includes("--publish")?{"8443/tcp":[{HostIp:at("--publish").split(":")[0],HostPort:at("--publish").split(":")[1]}]}:{}},
        Mounts:args.flatMap((value,index)=>value==="--mount"?[args[index+1]!]:[]).map(spec=>{const p=spec.split(",");return {Type:"volume",Name:p.find(v=>v.startsWith("src="))!.slice(4),Destination:p.find(v=>v.startsWith("dst="))!.slice(4),RW:!p.includes("readonly")};}),State:{Running:true}});
      return ok("synthetic-container");
    }
    if(args[0]==="stop"){const item=this.objects.get(`container:${name}`);if(item)item.State={Running:false};return ok();}
    if(args[0]==="rm"){this.objects.delete(`container:${name}`);return ok();}
    if(args[0]==="start"){const item=this.objects.get(`container:${name}`);if(item)item.State={Running:true};return ok();}
    if(args[0]==="exec"){
      if(name==="status")return ok({contexts:this.fleets});
      if(args.includes("create-fleet")){this.fleets=[{scopeId:"default",addresses:[]}];return ok(this.fleets[0]);}
      return ok({ready:true});
    }
    throw new Error(`Unhandled fixture command ${args.join(" ")}`);
  }
}
test("signed release rejects substitution, malformed manifests and unsupported coordinators",()=>{
  const keys=generateKeyPairSync("ed25519"),publicKey=keys.publicKey.export({format:"pem",type:"spki"}).toString();
  const bytes=Buffer.from(JSON.stringify(release())),signature=sign(null,bytes,keys.privateKey);
  assert.deepEqual(verifyRelease(bytes,signature,publicKey),release());
  assert.throws(()=>verifyRelease(Buffer.from(JSON.stringify(release(2))),signature,publicKey));
  assert.throws(()=>verifyRelease(bytes,Buffer.alloc(64),publicKey));
  assert.throws(()=>parseRelease({...release(),minimumCoordinator:2}));
  assert.throws(()=>parseRelease({...release(),runtime:{...release().runtime,name:"../../secret"}}));
  verifyArtifact(Buffer.from("abc"),release().runtime);assert.throws(()=>verifyArtifact(Buffer.from("abd"),release().runtime));
  assert.equal(releaseURL("https://github.com/MachoDrone/gridlens-typescript/releases/download/modern-v1/","modern-release.json").protocol,"https:");
  assert.throws(()=>releaseURL("https://attacker.test/releases/","image.tar"));
});
test("canonical endpoint rejects wildcards/public IPs and accepts assigned private 10.x",()=>{
  assert.equal(originFor("10.50.0.8",8789),"https://10.50.0.8:8789");assert.equal(originFor("fd00::8",8789),"https://[fd00::8]:8789");
  for(const value of ["0.0.0.0","8.8.8.8","::","example.org","172.32.0.1"])assert.throws(()=>originFor(value,8789));
});
test("Docker install rerun and reboot preserve identity ports state and exclusive owner",()=>{
  const runner=new DockerFixture(),coordinator=new Coordinator(runner);
  const first=coordinator.install({instance:"default",release:release(),action:"setup",bindAddress:"10.50.0.8",port:8799});
  const initialContainers=runner.calls.filter(c=>c.args[0]==="run"&&c.args.includes("--detach")).length;
  const second=coordinator.install({instance:"default",release:release(),action:"setup"});
  assert.deepEqual(second.config,first.config);assert.equal(runner.calls.filter(c=>c.args[0]==="run"&&c.args.includes("--detach")).length,initialContainers);
  for(const [name,item] of runner.objects)if(name.startsWith("container:"))item.State={Running:false};
  const reboot=coordinator.install({instance:"default",release:release(),action:"setup"});assert.deepEqual(reboot.config,first.config);
  assert.equal(runner.calls.filter(c=>c.args[0]==="start").length,2);
  const gateway=runner.calls.find(c=>c.args.includes("scripts/shared-gateway.ts"))!.args.join(" ");
  assert.match(gateway,/10\.50\.0\.8:8799:8443/);assert.match(gateway,/--read-only/);
  for(const forbidden of ["docker.sock","control-ipc","credentials","/state","--privileged","type=bind","--network host"])assert.ok(!gateway.includes(forbidden));
  const owner=runner.calls.find(c=>c.args.includes("scripts/shared-owner.ts"))!.args.join(" ");assert.ok(!owner.includes("--publish"));assert.match(owner,/control-ipc/);
  assert.throws(()=>coordinator.install({instance:"default",release:release(),action:"setup",port:8789}));
});
test("upgrade and rollback retain matched images/state while never rolling back the safety ledger",()=>{
  const runner=new DockerFixture(),coordinator=new Coordinator(runner);
  const first=coordinator.install({instance:"default",release:release(),action:"setup",bindAddress:"10.50.0.8"});
  const second=coordinator.install({instance:"default",release:release(2),action:"upgrade"});
  assert.deepEqual(second.config.previous,first.config.active);assert.notEqual(second.config.active.stateVolume,first.config.active.stateVolume);
  const copy=runner.calls.find(c=>c.args.includes("copy-state"))!.args.join(" ");
  assert.ok(copy.includes(first.config.active.stateVolume));assert.ok(copy.includes(second.config.active.stateVolume));assert.ok(!copy.includes("ledger"));
  const rollback=coordinator.install({instance:"default",release:release(2),action:"rollback"});
  assert.deepEqual(rollback.config.active,first.config.active);assert.equal(rollback.config.certificateSha256,first.config.certificateSha256);
});
test("interrupted upgrade resumes the durable selected pair and preserves original failure",()=>{
  const runner=new DockerFixture(),coordinator=new Coordinator(runner);
  coordinator.install({instance:"default",release:release(),action:"setup",bindAddress:"10.50.0.8"});runner.failOnStart=true;
  assert.throws(()=>coordinator.install({instance:"default",release:release(2),action:"upgrade"}),/Docker run failed/);
  assert.equal(runner.config!.phase,"applying");const selected=structuredClone(runner.config!.active);
  const recovered=coordinator.install({instance:"default",release:release(2),action:"upgrade"});assert.deepEqual(recovered.config.active,selected);assert.equal(recovered.config.phase,"ready");
});
test("older public release retains newer runtime without claiming an upgrade",()=>{
  const runner=new DockerFixture(),coordinator=new Coordinator(runner);
  coordinator.install({instance:"default",release:release(2),action:"setup",bindAddress:"10.50.0.8"});
  const result=coordinator.install({instance:"default",release:release(),action:"upgrade"});assert.equal(result.retainedNewer,true);assert.equal(result.config.active.version,"0.1.2");
});
test("unowned same-name Docker resources and daemon errors never become adoption or replacement",()=>{
  const runner=new DockerFixture();runner.objects.set("volume:gridlens-modern-default-config",{Labels:{}});
  assert.throws(()=>new Coordinator(runner).install({instance:"default",release:release(),action:"setup",bindAddress:"10.50.0.8"}),/belongs to another/);
  assert.ok(!runner.calls.some(c=>["rm","stop"].includes(c.args[0]!)));
  assert.throws(()=>inspectOwned({run:()=>({status:1,stdout:"",stderr:"permission denied"})},"volume","thing","default"),/inspection failed/);
});
test("launcher and Docker context keep private inputs out and secret collection on terminal",()=>{
  const launcher=readFileSync(new URL("../scripts/modern-start.sh",import.meta.url),"utf8");assert.match(launcher,/\/dev\/tty/);assert.match(launcher,/sha256sum --check/);assert.ok(!launcher.includes("apt install"));
  const terminal=readFileSync(new URL("../src/installer/terminal.ts",import.meta.url),"utf8");assert.match(terminal,/setup-auth/);assert.match(terminal,/setRawMode\(true\)/);
  const dockerignore=readFileSync(new URL("../Dockerfile.shared.dockerignore",import.meta.url),"utf8");assert.ok(dockerignore.startsWith("**\n"));assert.ok(!dockerignore.includes("!evidence"));
});

test("operator reconnect never replaces an existing verified roster with the initial empty fleet",()=>{
  const runner=new DockerFixture(),coordinator=new Coordinator(runner);
  coordinator.install({instance:"default",release:release(),action:"setup",bindAddress:"10.50.0.8"});
  runner.fleets=[{scopeId:"default",addresses:["synthetic-approved-host"]}];
  coordinator.operatorCode("default");
  assert.deepEqual(runner.fleets[0]!.addresses,["synthetic-approved-host"]);
  assert.ok(!runner.calls.some(c=>c.args.includes("create-fleet")));
});

test("rerun rejects a labeled gateway with added credential mounts or wildcard publication",()=>{
  for(const drift of ["mount","port"]){
    const runner=new DockerFixture(),coordinator=new Coordinator(runner);
    coordinator.install({instance:"default",release:release(),action:"setup",bindAddress:"10.50.0.8"});
    const gateway=runner.objects.get("container:gridlens-modern-default-gateway")!;
    if(drift==="mount")(gateway.Mounts as unknown[]).push({Type:"volume",Name:"credentials",Destination:"/credentials",RW:true});
    else (gateway.HostConfig as Record<string,unknown>).PortBindings={"8443/tcp":[{HostIp:"0.0.0.0",HostPort:"8789"}]};
    assert.throws(()=>coordinator.install({instance:"default",release:release(),action:"setup"}),/left untouched/);
  }
});
