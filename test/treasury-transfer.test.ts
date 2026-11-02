import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync, webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { address, getCompiledTransactionMessageDecoder, getBase58Decoder } from "@solana/kit";
import { AccountState, getMintEncoder, getTokenEncoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { buildTreasurySigner } from "../scripts/build-treasury-signer.ts";
import { createSolanaRpc, MAINNET_GENESIS_HASH } from "../scripts/solana-rpc.ts";
import { signPilotTransfer } from "../src/backend/treasury-signing.ts";
import { createTreasuryTransferDriver, finalizedReceipt } from "../src/backend/treasury-transfer.ts";
import { transferAccounts, transferTransaction, validateSignedTransfer, TREASURY_NOS_MINT } from "../src/backend/treasury-transaction.ts";
import type { TreasuryQuote, TreasurySigned } from "../src/backend/treasury.ts";
import type { PrivateState } from "../src/backend/access.ts";
import type { PcPermission } from "../src/backend/pc-monitor.ts";
import type { createObservationStore } from "../src/backend/observations.ts";
import type { CredentialVault } from "../src/backend/credential-vault.ts";
import type { PcAssociation } from "../src/contracts/shared.ts";
import type { FleetContext } from "../src/contracts/fleet.ts";
import type { withSsh } from "../src/backend/ssh.ts";

const nowBase=1_800_000_000_000, blockHash="11111111111111111111111111111112", require=createRequire(import.meta.url);
const key=generateKeyPairSync("ed25519"), other=generateKeyPairSync("ed25519");
const publicAddress=(pair:typeof key)=>getBase58Decoder().decode(pair.publicKey.export({format:"der",type:"spki"}).subarray(-32));
const sourceAddress=publicAddress(key),destinationAddress=publicAddress(other),pcId="a".repeat(64),containerId="b".repeat(64);
const context:FleetContext={scopeId:"synthetic",rosterRevision:"one",addresses:[sourceAddress]};
const association:PcAssociation={address:sourceAddress,binding:{pcId,runtime:"docker",wrapperId:null,nodeContainerId:containerId},
  name:"Synthetic",sshFingerprint:"SHA256:"+"A".repeat(43),verifiedAtMs:nowBase,privateIp:"10.0.0.2",gpuUuids:[]};
function fixture(overrides:{destinationAbsent?:boolean;fee?:number;rent?:number;sol?:number;frozen?:boolean;genesis?:string;simulationBad?:boolean}={}) {
  let time=nowBase,selectedQuote:TreasuryQuote|undefined,submitted:TreasurySigned|undefined;
  let transactionResult:unknown=null, revoked=false,wrongIdentity=false;
  let onRpc:((method:string)=>Promise<void>)|undefined;
  let onSleep:(()=>void)|undefined;
  const calls:string[]=[],commands:string[]=[];
  const permission:PcPermission={version:1,computer:{id:pcId,name:"Synthetic",host:"10.0.0.2",port:22,hostKey:"synthetic-host-key",fingerprint:association.sshFingerprint},
    associations:[association],rosterRevision:"one",automaticIp:true,rewards:false,gpu:false,approvedAtMs:nowBase,revokedAtMs:null,paused:false};
  const state:PrivateState={get:<T>(name:string)=>name===`permission:synthetic:${pcId}`?{...permission,revokedAtMs:revoked?time:null} as T:undefined,set:()=>{throw new Error("Unexpected driver persistence.");}};
  const vault={read:()=>({username:"synthetic",password:"synthetic-password"})} as unknown as CredentialVault;
  const observations={read:()=>({associations:[association]})} as unknown as ReturnType<typeof createObservationStore>;
  const token=(owner:string,amount:bigint,frozen=false)=>({owner:TOKEN_PROGRAM_ADDRESS,executable:false,lamports:2039280,space:165,
    data:[Buffer.from(getTokenEncoder().encode({mint:address(TREASURY_NOS_MINT),owner:address(owner),amount,delegate:null,state:frozen?AccountState.Frozen:AccountState.Initialized,
      isNative:null,delegatedAmount:0n,closeAuthority:null})).toString("base64"),"base64"]});
  const mint={owner:TOKEN_PROGRAM_ADDRESS,executable:false,lamports:1461600,space:82,
    data:[Buffer.from(getMintEncoder().encode({mintAuthority:null,supply:100_000_000_000_000n,decimals:6,isInitialized:true,freezeAuthority:null})).toString("base64"),"base64"]};
  const wallet=(lamports:number)=>({owner:"11111111111111111111111111111111",executable:false,lamports,data:["","base64"],space:0});
  let fee=overrides.fee??5000,sol=overrides.sol??100_000_000;
  const rent=overrides.destinationAbsent?(overrides.rent??2039280):0;
  const rpc=createSolanaRpc({now:()=>time,sleep:async ms=>{onSleep?.();time+=ms;},fetch:async (_url,init)=>{
    const request=JSON.parse(String(init?.body)) as {id:number;method:string;params:unknown[]}; calls.push(request.method);await onRpc?.(request.method);
    let result:unknown;
    switch(request.method){
      case"getGenesisHash":result=overrides.genesis??MAINNET_GENESIS_HASH;break;
      case"getMultipleAccounts":result={context:{slot:1000},value:[mint,token(sourceAddress,9_000_000n,overrides.frozen),overrides.destinationAbsent?null:token(destinationAddress,2_000_000n),wallet(sol)]};break;
      case"getBlockTime":result=Math.floor(time/1000);break;
      case"getLatestBlockhash":result={context:{slot:1000},value:{blockhash:blockHash,lastValidBlockHeight:1200}};break;
      case"getFeeForMessage":result={context:{slot:1000},value:fee};break;
      case"getMinimumBalanceForRentExemption":result=rent;break;
      case"simulateTransaction":result={context:{slot:1000},value:{err:null,accounts:[token(sourceAddress,overrides.simulationBad?7_000_000n:8_000_000n),token(destinationAddress,overrides.destinationAbsent?1_000_000n:3_000_000n),wallet(sol-fee-rent)]}};break;
      case"sendTransaction":assert.equal(request.params[0],submitted?.transactionBase64);assert.equal((request.params[1] as {maxRetries:number}).maxRetries,0);result=submitted!.signature;break;
      case"getTransaction":assert.equal((request.params[1] as {commitment:string}).commitment,"finalized");result=transactionResult;break;
      default:throw new Error("Unexpected RPC: "+request.method);
    }
    return new Response(JSON.stringify({jsonrpc:"2.0",id:request.id,result}),{headers:{"content-type":"application/json"}});
  }});
  const connect:typeof withSsh=async (_computer,_credential,work)=>work(async command=>{
    commands.push(command);
    if(command.includes("inspect --format"))return{code:0,stdout:`${containerId}\ttrue\tnosana/nosana-node:1.0.0`};
    if(command.includes("--gridlens-one-nos-transfer")){assert(selectedQuote);return{code:0,stdout:JSON.stringify(await signPilotTransfer(selectedQuote,work=>work(key.privateKey)))};}
    return{code:0,stdout:wrongIdentity?destinationAddress:sourceAddress};
  });
  const driver=createTreasuryTransferDriver({rpc,state,vault,observations,contexts:()=>[context],now:()=>time,connect,signerSource:"/* generated isolated fixture helper */"});
  return{driver,calls,commands,token,select:(quote:TreasuryQuote)=>{selectedQuote=quote;},submit:(signed:TreasurySigned)=>{submitted=signed;},receipt:(value:unknown)=>{transactionResult=value;},
    advance:(ms:number)=>{time+=ms;},revoke:()=>{revoked=true;},wrongIdentity:()=>{wrongIdentity=true;},hook:(value:(method:string)=>Promise<void>)=>{onRpc=value;},
    telemetry:async(count:number)=>{const provider=rpc.createSession("telemetry-fixture").eligible()!;for(let i=0;i<count;i++)await rpc.rpc(provider,"getBlockTime",[1000],new AbortController().signal,time+28_000);},
    sleepHook:(value:()=>void)=>{onSleep=value;},funds:(value:number)=>{sol=value;},fee:(value:number)=>{fee=value;}};
}
function receipt(signed:TreasurySigned,create=false) {
  const keys=getCompiledTransactionMessageDecoder().decode(Buffer.from(signed.quote.messageBase64,"base64")).staticAccounts;
  const balance=(account:string,owner:string,amount:string)=>({accountIndex:keys.indexOf(account as never),owner,mint:TREASURY_NOS_MINT,programId:TOKEN_PROGRAM_ADDRESS,uiTokenAmount:{amount,decimals:6,uiAmount:null}});
  const preBalances=keys.map(()=>2039280),postBalances=keys.map(()=>2039280),payer=keys.indexOf(sourceAddress as never);
  preBalances[payer]=100_000_000;postBalances[payer]=100_000_000-Number(signed.quote.feeLamports)-Number(signed.quote.rentLamports);
  return{slot:1100,transaction:[signed.transactionBase64,"base64"],meta:{err:null,fee:5000,preBalances,postBalances,
    preTokenBalances:[balance(signed.quote.sourceTokenAddress,sourceAddress,"9000000"),...(create?[]:[balance(signed.quote.destinationTokenAddress,destinationAddress,"2000000")])],
    postTokenBalances:[balance(signed.quote.sourceTokenAddress,sourceAddress,"8000000"),balance(signed.quote.destinationTokenAddress,destinationAddress,create?"1000000":"3000000")]}};
}

test("treasury pilot prepares, locally signs, submits once, and verifies exact finalized NOS receipt",async()=>{
  const f=fixture(),quote=await f.driver.prepare(context,sourceAddress,destinationAddress);f.select(quote);
  assert.equal(quote.amountBaseUnits,"1000000");assert.equal(quote.feeLamports,"5000");assert.equal(quote.sourceNosBaseUnits,"9000000");
  assert.equal(f.commands.length,0);const signed=await f.driver.sign(quote);f.submit(signed);
  await validateSignedTransfer(quote,signed.transactionBase64,signed.signature);await f.driver.submit(signed);
  assert.equal(f.calls.length,12,"The complete cold transfer fits the shared twelve-request minute.");
  f.receipt(receipt(signed));assert.equal((await f.driver.reconcile(signed)).status,"uncertain","Receipt lookup honestly waits for the existing shared allowance.");
  f.advance(60_000);assert.equal((await f.driver.reconcile(signed)).status,"confirmed");
  assert.equal(f.calls.filter(value=>value==="sendTransaction").length,1);assert.equal(f.calls.filter(value=>value==="getGenesisHash").length,1);
  assert(f.commands.at(-1)!.includes("/usr/bin/env -i"));assert(!f.commands.join("\n").includes("synthetic-password"));
});
test("treasury pilot supports only idempotent receiving ATA creation plus exact TransferChecked",async()=>{
  const f=fixture({destinationAbsent:true}),quote=await f.driver.prepare(context,sourceAddress,destinationAddress);f.select(quote);
  assert.equal(quote.createDestinationAta,true);assert.equal(quote.rentLamports,"2039280");
  const signed=await f.driver.sign(quote),message=getCompiledTransactionMessageDecoder().decode(Buffer.from(quote.messageBase64,"base64"));
  f.submit(signed);await f.driver.submit(signed);assert.equal(f.calls.length,12,"Creating the receiving account must fit the same shared allowance.");
  assert(message.version==="legacy");assert.equal(message.instructions.length,2);assert.equal(finalizedReceipt(signed,receipt(signed,true),nowBase).status,"confirmed");
});
test("treasury rejects wrong-chain, frozen source, reserve shortfall, cost excess and incorrect simulation before any signing",async()=>{
  for(const options of [{genesis:"other-chain"},{frozen:true},{sol:50_004_999},{fee:5_000_001},{simulationBad:true}]){
    const f=fixture(options);await assert.rejects(f.driver.prepare(context,sourceAddress,destinationAddress));assert.equal(f.commands.length,0);assert(!f.calls.includes("sendTransaction"));
  }
  await assert.rejects(fixture().driver.prepare(context,sourceAddress,sourceAddress));
});
test("treasury expires reviews and revalidates source permission and in-container identity before signing",async()=>{
  for(const mode of["expired","revoked","identity"]){
    const f=fixture(),quote=await f.driver.prepare(context,sourceAddress,destinationAddress);f.select(quote);
    if(mode==="expired")f.advance(60_001);else if(mode==="revoked")f.revoke();else f.wrongIdentity();
    await assert.rejects(f.driver.sign(quote));assert(!f.commands.some(command=>command.includes("--gridlens-one-nos-transfer")));assert(!f.calls.includes("sendTransaction"));
  }
});
test("financial authority revoked during an awaited RPC read prevents source-wallet signing",async()=>{
  const f=fixture(),quote=await f.driver.prepare(context,sourceAddress,destinationAddress);f.select(quote);
  let start!:()=>void,release!:()=>void,allowed=true;
  const started=new Promise<void>(resolve=>{start=resolve;}),blocked=new Promise<void>(resolve=>{release=resolve;});
  f.hook(async method=>{if(method==="getMultipleAccounts"){start();await blocked;}});
  const signing=f.driver.sign(quote,()=>{if(!allowed)throw new Error("Financial authority revoked.");});
  await started;allowed=false;release();await assert.rejects(signing,/Financial authority revoked/);
  assert(!f.commands.some(command=>command.includes("--gridlens-one-nos-transfer")));assert(!f.calls.includes("sendTransaction"));
});
test("known shared telemetry contention defers before an executable review or source key access",async()=>{
  const before=fixture();await before.telemetry(3);
  await assert.rejects(before.driver.prepare(context,sourceAddress,destinationAddress),/shared Solana allowance/);
  assert.equal(before.commands.length,0);assert(!before.calls.includes("sendTransaction"));
  const after=fixture(),quote=await after.driver.prepare(context,sourceAddress,destinationAddress);after.select(quote);
  assert(after.driver.assertReady);const prior=after.calls.length;after.driver.assertReady(quote);assert.equal(after.calls.length,prior);
  await after.telemetry(3);const withTelemetry=after.calls.length;
  assert.throws(()=>after.driver.assertReady!(quote),/shared Solana allowance/);assert.equal(after.calls.length,withTelemetry);
  await assert.rejects(after.driver.sign(quote),/shared Solana allowance/);
  assert.equal(after.commands.length,0);assert(!after.calls.includes("sendTransaction"));
});
test("submission rechecks financial authority after shared pacing immediately before network dispatch",async()=>{
  const f=fixture(),quote=await f.driver.prepare(context,sourceAddress,destinationAddress);f.select(quote);
  const signed=await f.driver.sign(quote);f.submit(signed);let allowed=true,revokeNextSleep=false;
  f.hook(async method=>{if(method==="simulateTransaction")revokeNextSleep=true;});
  f.sleepHook(()=>{if(revokeNextSleep)allowed=false;});
  await assert.rejects(f.driver.submit(signed,()=>{if(!allowed)throw new Error("Financial authority revoked.");}),/Financial authority revoked/);
  assert(!f.calls.includes("sendTransaction"));
});
test("changed fee or operational SOL reserve after signing stops before broadcasting",async()=>{
  for(const kind of["fee","reserve"]){
    const f=fixture(),quote=await f.driver.prepare(context,sourceAddress,destinationAddress);f.select(quote);
    const signed=await f.driver.sign(quote);f.submit(signed);
    if(kind==="fee")f.fee(10_000);else f.funds(50_004_999);
    await assert.rejects(f.driver.submit(signed));assert(!f.calls.includes("sendTransaction"));
  }
});
test("restricted signer rejects changed amount, destination, accounts and compiled bytes before opening a key",async()=>{
  const f=fixture(),quote=await f.driver.prepare(context,sourceAddress,destinationAddress);let opened=0;
  for(const change of[{amountBaseUnits:"2000000"},{mintAddress:sourceAddress},{destinationAddress:sourceAddress},{sourceTokenAddress:destinationAddress},{messageBase64:Buffer.from("wrong-message").toString("base64")}]){
    await assert.rejects(signPilotTransfer({...quote,...change},work=>{opened++;return work(key.privateKey);}));
  }
  assert.equal(opened,0);
  await assert.rejects(signPilotTransfer(quote,work=>work(other.privateKey)));
  const signed=await signPilotTransfer(quote,work=>work(key.privateKey));
  await assert.rejects(validateSignedTransfer(quote,signed.transactionBase64,destinationAddress));
});
test("receipt verification requires exact signed transaction, source/receiver token deltas and bounded SOL fee",async()=>{
  const f=fixture(),quote=await f.driver.prepare(context,sourceAddress,destinationAddress);
  const signed={quote,...await signPilotTransfer(quote,work=>work(key.privateKey))};
  for(const mutate of[(r:ReturnType<typeof receipt>)=>{r.transaction[0]="different";},(r:ReturnType<typeof receipt>)=>{r.meta.postTokenBalances[1]!.uiTokenAmount.amount="4000000";},
    (r:ReturnType<typeof receipt>)=>{r.meta.postTokenBalances[1]!.owner=sourceAddress;},(r:ReturnType<typeof receipt>)=>{r.meta.fee=5_000_001;}]){
    const r=receipt(signed);mutate(r);assert.equal(finalizedReceipt(signed,r,nowBase).status,"uncertain");
  }
  assert.equal(finalizedReceipt(signed,{...receipt(signed),meta:{...receipt(signed).meta,err:{InstructionError:[0,"failed"]}}},nowBase).status,"failed");
  f.receipt(null);assert.equal((await f.driver.reconcile(signed)).status,"uncertain");assert(!f.calls.includes("sendTransaction"));
});
test("bundled container helper runs with in-memory generated key and returns only signed transaction/signature",async()=>{
  const root=await mkdtemp(join(tmpdir(),"gridlens-treasury-signer-"));
  try{
    const bundle=join(root,"signer.cjs");buildTreasurySigner(bundle);const code=await readFile(bundle,"utf8");
    assert(Buffer.byteLength(code)<120_000);
    const accounts=await transferAccounts(sourceAddress,destinationAddress),input={sourceAddress,destinationAddress,...accounts,mintAddress:TREASURY_NOS_MINT,
      amountBaseUnits:"1000000",decimals:6,createDestinationAta:false,blockhash:blockHash,lastValidBlockHeight:1200,messageBase64:""};
    input.messageBase64=Buffer.from((await transferTransaction(input)).messageBytes).toString("base64");
    const privateBytes=key.privateKey.export({format:"der",type:"pkcs8"}).subarray(-32),publicBytes=key.publicKey.export({format:"der",type:"spki"}).subarray(-32);
    const keyJson=Buffer.from(JSON.stringify([...privateBytes,...publicBytes]));let offset=0,opened=0;
    const nativeFs=require("node:fs") as typeof import("node:fs");
    const fakeFs={constants:nativeFs.constants,readFileSync:(path:string)=>path==="/proc/self/limits"?"Max core file size         0                    0                    bytes\n":"00000000",
      lstatSync:()=>({isDirectory:()=>true,isSymbolicLink:()=>false}),openSync:(path:string)=>{assert.equal(path,"/synthetic/.nosana/nosana_key.json");opened++;return 99;},
      fstatSync:()=>({isFile:()=>true,size:keyJson.length}),readSync:(_fd:number,buffer:Buffer,start:number,length:number)=>{const used=Math.min(length,keyJson.length-offset);keyJson.copy(buffer,start,offset,offset+used);offset+=used;return used;},closeSync:()=>{}};
    const output=await new Promise<string>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error("Helper fixture timed out.")),5000);
      const processFixture={argv:["node","--gridlens-one-nos-transfer",JSON.stringify(input)],env:{PATH:"/usr/local/bin:/usr/bin:/bin",LANG:"C"},
        stdout:{write:(text:string,callback:()=>void)=>{clearTimeout(timer);resolve(text);callback();}},exit:()=>{},set exitCode(code:number){clearTimeout(timer);reject(new Error(`Helper failed ${code}`));}};
      new Script(code).runInNewContext({require:(name:string)=>name==="node:fs"?fakeFs:name==="node:os"?{userInfo:()=>({homedir:"/synthetic"})}:require(name),
        module:{exports:{}},exports:{},process:processFixture,Buffer,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,DataView,crypto:webcrypto,setTimeout,clearTimeout,console});
    });
    const signed=JSON.parse(output) as {transactionBase64:string;signature:string};assert.deepEqual(Object.keys(signed).sort(),["signature","transactionBase64"]);
    assert.equal(opened,1);await validateSignedTransfer(input,signed.transactionBase64,signed.signature);assert(!output.includes(keyJson.toString()));keyJson.fill(0);
  }finally{await rm(root,{recursive:true,force:true});}
});
