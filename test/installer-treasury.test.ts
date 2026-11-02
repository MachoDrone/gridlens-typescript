import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Coordinator, TREASURY_PROTOCOL_LABEL, BROWSER_SECURITY_PROTOCOL_LABEL } from "../src/installer/coordinator.ts";
import { reconcileInstalledServices } from "../src/installer/installed-services.ts";
import { runTerminal } from "../src/installer/terminal.ts";
import type { TerminalPrompts } from "../src/installer/terminal.ts";
import { resourceName } from "../src/installer/docker.ts";
import type { CommandResult } from "../src/installer/docker.ts";
import type { ModernRelease } from "../src/installer/release.ts";
import { UpdateDockerFixture } from "./fixtures/updater-docker.ts";

const release=(sequence:number):ModernRelease=>({format:"gridlens-modern-release-v1",version:`0.1.0-treasury.${sequence}`,sequence,
  platform:"linux-x64",minimumCoordinator:sequence===1?1:2,imageId:`sha256:${String(sequence).repeat(64)}`,
  runtime:{name:`gridlens-runtime-treasury-${sequence}.tar`,bytes:1,sha256:"a".repeat(64)}});
class TreasuryDockerFixture extends UpdateDockerFixture {
  readonly protocols=new Map<string,string>([[release(2).imageId,"1"],[release(3).imageId,"1"]]);
  readonly controls:Record<string,unknown>[]=[];
  initializationFails=false;changedImage=false;badSetupLink=false;
  readonly certificate:string;readonly fingerprint:string;
  constructor(directory:string){
    super("treasury-fixture",join(directory,"installation.json"),[release(1),release(2),release(3)]);
    execFileSync("openssl",["req","-x509","-newkey","ec","-pkeyopt","ec_paramgen_curve:prime256v1","-nodes","-keyout",join(directory,"fixture.key"),
      "-out",join(directory,"fixture.crt"),"-days","1","-subj","/CN=Generated Wallet installer fixture","-addext","subjectAltName=IP:10.71.0.8"],{stdio:"ignore"});
    this.certificate=readFileSync(join(directory,"fixture.crt"),"utf8");this.fingerprint=createHash("sha256").update(new X509Certificate(this.certificate).raw).digest("hex");
  }
  override run(args:readonly string[],input?:string|Uint8Array):CommandResult {
    const ok=(value:unknown):CommandResult=>({status:0,stdout:JSON.stringify(value),stderr:""});
    if(args[0]==="run"&&args.at(-1)==="treasury-initialize"){
      this.calls.push([...args]);assert.equal(input,"{}");return this.initializationFails?{status:1,stdout:"",stderr:"Generated Wallet initialization failure"}:ok({initialized:true});
    }
    if(args[0]==="run"&&args.at(-1)==="public-browser-certificates"){
      this.calls.push([...args]);return ok({certificatePem:this.certificate,serverCertificatePem:this.certificate});
    }
    if(args[0]==="run"&&args.at(-1)==="--terminal-guard"){this.calls.push([...args]);return ok({ready:true});}
    if(args[0]==="exec"&&args.at(-1)==="json"&&typeof input==="string"){
      const body=JSON.parse(input) as Record<string,unknown>;
      if(body.operation==="browser-security-publish"){this.calls.push([...args]);return ok({published:true});}
      if(body.operation==="treasury-setup"||body.operation==="treasury-reset"){
        this.calls.push([...args]);this.controls.push(body);const ticket="T".repeat(43),httpsOrigin=this.config!.origin;
        return ok({version:1,ticket,httpsOrigin,expiresAtMs:Date.now()+299_000,
          setupUrl:this.badSetupLink?`https://wrong.invalid/wallet#ticket=${ticket}`:`${httpsOrigin}/wallet#ticket=${ticket}`});
      }
    }
    const result=super.run(args,input);
    if(args[0]==="image"&&args[1]==="inspect"&&result.status===0){
      const images=JSON.parse(result.stdout),protocol=this.protocols.get(args.at(-1)!);
      images[0].Config.Labels[BROWSER_SECURITY_PROTOCOL_LABEL]="1";
      if(protocol!==undefined)images[0].Config.Labels[TREASURY_PROTOCOL_LABEL]=protocol;
      if(this.changedImage)images[0].Id="sha256:"+"f".repeat(64);
      return ok(images);
    }
    if(args[0]==="run"&&args.at(-1)==="initialize"){this.save({...this.config!,certificateSha256:this.fingerprint});return ok(this.config);}
    return result;
  }
}
function fixture(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),"gridlens-installer-treasury-"));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const runner=new TreasuryDockerFixture(directory),coordinator=new Coordinator(runner),instance=runner.instance;
  const install=(sequence:number,action:"setup"|"upgrade"|"rollback"="setup")=>coordinator.install({instance,release:release(sequence),action,enableUpdater:true,
    ...(runner.config?{}:{bindAddress:"10.71.0.8",port:8790})});
  const container=(role:string)=>runner.objects.get(`container:${resourceName(instance,role)}`)!;
  return{runner,coordinator,instance,install,container};
}
const mounts=(container:Record<string,unknown>)=>container.Mounts as {Name:string;Destination:string;RW:boolean}[];
const environment=(container:Record<string,unknown>)=>(container.Config as {Env:string[]}).Env;
function terminal(answer="RESET"){
  const output:string[]=[],prompts:string[]=[];let closed=false;
  const value:TerminalPrompts={color:false,print:line=>output.push(line),ask:async prompt=>{prompts.push(prompt);return answer;},
    secret:async()=>{throw new Error("Wallet terminal must not collect a wallet password or key.");},close:()=>{closed=true;}};
  return{value,output,prompts,closed:()=>closed};
}
async function terminalRun(runner:TreasuryDockerFixture,args:string[],prompts:TerminalPrompts){const mask=process.umask();try{await runTerminal(args,prompts,runner);}finally{process.umask(mask);}}

test("Wallet capability is bound to exact immutable image identity, label 1 only",t=>{
  const f=fixture(t);assert.equal(f.coordinator.supportsTreasury(release(1)),false);assert.equal(f.coordinator.supportsTreasury(release(2)),true);
  f.runner.protocols.set(release(2).imageId,"0");assert.equal(f.coordinator.supportsTreasury(release(2)),false);
  f.runner.protocols.set(release(2).imageId,"2");assert.throws(()=>f.coordinator.supportsTreasury(release(2)),/unsupported Wallet protocol/);
  f.runner.protocols.set(release(2).imageId,"1");f.runner.changedImage=true;assert.throws(()=>f.coordinator.supportsTreasury(release(2)),/does not match/);
  f.runner.changedImage=false;assert.throws(()=>f.coordinator.supportsTreasury({...release(2),version:"0.0.0"}),/does not match/);
  assert(!f.runner.calls.some(args=>args[0]==="run"));
});
test("fresh Wallet runtime mounts financial IPC only into owner and HTTPS gateway, and rerun preserves existing resources",t=>{
  const f=fixture(t),first=f.install(2);reconcileInstalledServices(f.runner,first,release(2),{action:"setup",vpnWeb:true,webPort:8789});
  for(const role of["owner","gateway"]){
    const financial=mounts(f.container(role)).filter(row=>row.Destination==="/treasury");assert.equal(financial.length,1);
    assert.equal(financial[0]!.Name,resourceName(f.instance,"treasury-ipc"));assert.equal(financial[0]!.RW,role==="owner");
    assert(environment(f.container(role)).includes("GRIDLENS_TREASURY_SOCKET=/treasury/treasury.sock"));
  }
  for(const role of["vpn-web","updater"]){assert(!mounts(f.container(role)).some(row=>row.Destination==="/treasury"));assert(!environment(f.container(role)).some(row=>row.startsWith("GRIDLENS_TREASURY")));}
  const volumes=structuredClone([...f.runner.objects.entries()].filter(([name])=>name.startsWith("volume:"))),config=structuredClone(f.runner.config),before=f.runner.calls.length;
  const second=f.install(2);reconcileInstalledServices(f.runner,second,release(2),{action:"setup"});
  assert.deepEqual(f.runner.config,config);assert.deepEqual([...f.runner.objects.entries()].filter(([name])=>name.startsWith("volume:")),volumes);
  assert(!f.runner.calls.slice(before).some(args=>args[0]==="run"&&args.includes("--detach")));
  assert(!f.runner.calls.some(args=>args[0]==="volume"&&args[1]==="rm"));
});
test("Wallet upgrade and rollback preserve shared ledger and financial IPC volume while older image gets no financial mount",t=>{
  const f=fixture(t),old=f.install(1);reconcileInstalledServices(f.runner,old,release(1),{action:"setup",vpnWeb:true,webPort:8789});
  assert(![...f.runner.objects.keys()].some(name=>name.endsWith("treasury-ipc")));
  const ledgerName=`volume:${resourceName(f.instance,"ledger")}`,ledger=f.runner.objects.get(ledgerName)!;ledger.fixtureFinancialRecord={consumed:true,signature:"synthetic-saved-transaction"};
  const next=f.install(2,"upgrade");reconcileInstalledServices(f.runner,next,release(2),{action:"upgrade"});
  const financialName=`volume:${resourceName(f.instance,"treasury-ipc")}`,financial=f.runner.objects.get(financialName)!;
  assert.equal(f.runner.objects.get(ledgerName),ledger);assert(mounts(f.container("owner")).some(row=>row.Destination==="/treasury"));
  const rollback=f.install(2,"rollback");reconcileInstalledServices(f.runner,rollback,release(2),{action:"rollback"});
  assert.deepEqual(rollback.config.active,old.config.active);assert.equal(f.runner.objects.get(ledgerName),ledger);assert.equal(f.runner.objects.get(financialName),financial);
  for(const role of["owner","gateway","vpn-web","updater"]){assert(!mounts(f.container(role)).some(row=>row.Destination==="/treasury"));}
  for(const call of f.runner.calls.filter(args=>args.includes("copy-state"))){assert(!call.some(value=>value.includes("-ledger,")||value.includes("treasury-ipc")));}
  assert(!f.runner.calls.some(args=>args[0]==="volume"&&args[1]==="rm"));
});
test("Wallet IPC initialization failure prevents capable runtime start and later retry preserves prepared state",t=>{
  const f=fixture(t);f.runner.initializationFails=true;
  assert.throws(()=>f.install(2),/Wallet initialization failure/);
  assert.equal(f.container("owner"),undefined);assert.equal(f.container("gateway"),undefined);
  assert(!f.runner.calls.some(args=>args[0]==="run"&&args.includes("--detach")));
  const initial=structuredClone(f.runner.config);f.runner.initializationFails=false;const ready=f.install(2);
  assert.deepEqual(ready.config.active,initial!.active);assert.equal(ready.config.certificateSha256,initial!.certificateSha256);assert.equal(ready.config.phase,"ready");
});
test("terminal Wallet setup and explicit reset use only fixed owner control and verify saved HTTPS link",async t=>{
  const f=fixture(t),installed=f.install(2);reconcileInstalledServices(f.runner,installed,release(2),{action:"setup"});
  const objects=structuredClone(f.runner.objects),config=structuredClone(f.runner.config),setup=terminal();
  await terminalRun(f.runner,["--treasury-setup","--instance",f.instance],setup.value);
  assert.deepEqual(f.runner.controls,[{operation:"treasury-setup",scopeId:"default"}]);assert.equal(setup.prompts.length,0);
  assert(setup.output.includes(`${installed.config.origin}/wallet#ticket=${"T".repeat(43)}`));assert(setup.output.some(line=>/moves no funds/.test(line)));
  assert.equal(setup.closed(),true);assert.equal(f.runner.held,false);assert.deepEqual(f.runner.objects,objects);assert.deepEqual(f.runner.config,config);
  const cancelled=terminal("yes");await terminalRun(f.runner,["--treasury-reset","--instance",f.instance],cancelled.value);
  assert.equal(f.runner.controls.length,1);assert(cancelled.output.includes("Wallet recovery cancelled."));
  const reset=terminal();await terminalRun(f.runner,["--treasury-reset","--instance",f.instance],reset.value);
  assert.deepEqual(f.runner.controls[1],{operation:"treasury-reset",scopeId:"default"});assert.match(reset.prompts[0]!,/history.*1 NOS.*preserved/);
  f.runner.badSetupLink=true;await assert.rejects(terminalRun(f.runner,["--treasury-setup","--instance",f.instance],terminal().value),/link could not be verified/);
  assert.equal(f.runner.held,false);
  await assert.rejects(terminalRun(f.runner,["--treasury-setup","--vpn-web","--instance",f.instance],terminal().value),/one Wallet/);
});
test("older runtime refuses terminal Wallet setup without starting financial control",async t=>{
  const f=fixture(t);f.install(1);
  await assert.rejects(terminalRun(f.runner,["--treasury-setup","--instance",f.instance],terminal().value),/Wallet-capable release/);
  assert.deepEqual(f.runner.controls,[]);assert.equal(f.runner.held,false);
});
