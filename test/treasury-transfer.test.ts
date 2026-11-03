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
import { TreasuryPreflightError } from "../src/backend/treasury-errors.ts";
import type { FinancialGuardianTransport } from "../src/backend/guardian-transport.ts";

const nowBase=1_800_000_000_000, blockHash="11111111111111111111111111111112", require=createRequire(import.meta.url);
const key=generateKeyPairSync("ed25519"), other=generateKeyPairSync("ed25519");
const publicAddress=(pair:typeof key)=>getBase58Decoder().decode(pair.publicKey.export({format:"der",type:"spki"}).subarray(-32));
const sourceAddress=publicAddress(key),destinationAddress=publicAddress(other),pcId="a".repeat(64),containerId="b".repeat(64);
const context:FleetContext={scopeId:"synthetic",rosterRevision:"one",addresses:[sourceAddress]};
const association:PcAssociation={address:sourceAddress,binding:{pcId,runtime:"docker",wrapperId:null,nodeContainerId:containerId},
  name:"Synthetic",sshFingerprint:"SHA256:"+"A".repeat(43),verifiedAtMs:nowBase,privateIp:"10.0.0.2",gpuUuids:[]};
function fixture(overrides:{destinationAbsent?:boolean;fee?:number;rent?:number;sol?:number;frozen?:boolean;genesis?:string;simulationBad?:boolean;phaseDeadlineMs?:number;blockTimeMs?:number;ownerBound?:boolean;guardian?:FinancialGuardianTransport}={}) {
  let time=nowBase,selectedQuote:TreasuryQuote|undefined,submitted:TreasurySigned|undefined;
  let transactionResult:unknown=null, revoked=false,wrongIdentity=false;
  let onRpc:((method:string)=>Promise<void>)|undefined;
  let onSleep:(()=>void)|undefined,onCommand:((command:string)=>void)|undefined;
  let onPace:((target:number)=>Promise<void>)|undefined;
  let simulationError:unknown=null,simulationInvalidAccount=false,simulationSlot=1000,sourceNos=9_000_000n,destinationNos=2_000_000n;
  const calls:string[]=[],commands:string[]=[],dispatches:{method:string;at:number}[]=[];
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
  let rent=overrides.destinationAbsent?(overrides.rent??2039280):0;
  const rpc=createSolanaRpc({now:()=>time,refreshDeadlineMs:overrides.phaseDeadlineMs??28_000,sleep:async ms=>{onSleep?.();const target=time+ms;await onPace?.(target);time=Math.max(time,target);},fetch:async (_url,init)=>{
    const request=JSON.parse(String(init?.body)) as {id:number;method:string;params:unknown[]}; calls.push(request.method);dispatches.push({method:request.method,at:time});await onRpc?.(request.method);
    let result:unknown;
    switch(request.method){
      case"getGenesisHash":result=overrides.genesis??MAINNET_GENESIS_HASH;break;
      case"getMultipleAccounts":result={context:{slot:1000},value:[mint,token(sourceAddress,sourceNos,overrides.frozen),overrides.destinationAbsent?null:token(destinationAddress,destinationNos),wallet(sol)]};break;
      case"getBlockTime":result=Math.floor((overrides.blockTimeMs??time)/1000);break;
      case"getLatestBlockhash":result={context:{slot:1000},value:{blockhash:blockHash,lastValidBlockHeight:1200}};break;
      case"getFeeForMessage":result={context:{slot:1000},value:fee};break;
      case"getMinimumBalanceForRentExemption":result=rent;break;
      case"simulateTransaction":{
        const destination=token(destinationAddress,overrides.destinationAbsent?1_000_000n:destinationNos+1_000_000n);
        if(overrides.destinationAbsent)destination.lamports=rent;
        result={context:{slot:simulationSlot},value:{err:simulationError,accounts:simulationError===null?[token(simulationInvalidAccount?destinationAddress:sourceAddress,overrides.simulationBad?7_000_000n:sourceNos-1_000_000n),destination,wallet(sol-fee-rent)]:[null,null,null]}};break;
      }
      case"sendTransaction":assert.equal(request.params[0],submitted?.transactionBase64);assert.equal((request.params[1] as {maxRetries:number}).maxRetries,0);
        assert.equal((request.params[1] as {skipPreflight:boolean}).skipPreflight,false);
        assert.equal((request.params[1] as {minContextSlot:number}).minContextSlot,simulationSlot);result=submitted!.signature;break;
      case"getTransaction":assert.equal((request.params[1] as {commitment:string}).commitment,"finalized");result=transactionResult;break;
      default:throw new Error("Unexpected RPC: "+request.method);
    }
    return new Response(JSON.stringify({jsonrpc:"2.0",id:request.id,result}),{headers:{"content-type":"application/json"}});
  }});
  const connect:typeof withSsh=async (_computer,_credential,work)=>work(async command=>{
    commands.push(command);onCommand?.(command);
    if(command.includes("inspect --format"))return{code:0,stdout:`${containerId}\ttrue\tnosana/nosana-node:1.0.0`};
    if(command.includes("--gridlens-one-nos-transfer")){assert(selectedQuote);return{code:0,stdout:JSON.stringify(await signPilotTransfer(selectedQuote,work=>work(key.privateKey)))};}
    return{code:0,stdout:wrongIdentity?destinationAddress:sourceAddress};
  });
  const driver=createTreasuryTransferDriver({rpc,state,vault,observations,contexts:()=>[context],now:()=>time,connect,signerSource:"/* generated isolated fixture helper */",
    securityMode:overrides.ownerBound?"owner-bound":"legacy",...(overrides.guardian?{guardian:overrides.guardian}:{})});
  return{driver,calls,commands,dispatches,token,select:(quote:TreasuryQuote)=>{selectedQuote=quote;},submit:(signed:TreasurySigned)=>{submitted=signed;},receipt:(value:unknown)=>{transactionResult=value;},
    advance:(ms:number)=>{time+=ms;},revoke:()=>{revoked=true;},wrongIdentity:()=>{wrongIdentity=true;},hook:(value:(method:string)=>Promise<void>)=>{onRpc=value;},
    telemetry:async(count:number)=>{const provider=rpc.createSession("telemetry-fixture").eligible()!;for(let i=0;i<count;i++)await rpc.rpc(provider,"getBlockTime",[1000],new AbortController().signal,time+28_000);},
    sleepHook:(value:()=>void)=>{onSleep=value;},commandHook:(value:(command:string)=>void)=>{onCommand=value;},funds:(value:number)=>{sol=value;},fee:(value:number)=>{fee=value;},rent:(value:number)=>{rent=value;},
    paceHook:(value:(target:number)=>Promise<void>)=>{onPace=value;},
    simulationError:(value:unknown)=>{simulationError=value;},invalidSimulationAccount:()=>{simulationInvalidAccount=true;},simulationSlot:(value:number)=>{simulationSlot=value;},
    balances:(source:bigint,destination:bigint)=>{sourceNos=source;destinationNos=destination;},
    at:(value:number)=>{assert(value>=time);time=value;},time:()=>time,
    occupy:()=>rpc.rpc(rpc.createSession("occupied-fixture").eligible()!,"getBlockTime",[1000],new AbortController().signal,time+28_000),
    warm:async()=>{const provider=rpc.createSession("telemetry-fixture").eligible()!;await rpc.verifyMainnet(provider,new AbortController().signal,time+28_000);}};
}
const reason=(code:string)=>(error:unknown)=>error instanceof TreasuryPreflightError&&error.code===code;
test("owner-bound transfers have no direct SSH fallback when authority or source enrollment is missing",async()=>{
  const f=fixture({ownerBound:true});
  await assert.rejects(f.driver.prepare(context,sourceAddress,destinationAddress),reason("preflight-unavailable"));
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.commands,[]);
});
test("owner-bound transfer preserves preflight and submission checks while routing signing only through the guardian",async()=>{
  const operationId="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";let calls=0;
  const guardian:FinancialGuardianTransport={
    async status(){throw Error("not used");},async prepare(target,source,destination){assert.equal(target.computer.id,pcId);assert.equal(source,sourceAddress);assert.equal(destination,destinationAddress);},
    assertReady(){},async transfer(_target,quote,id,authorize){assert.equal(id,operationId);authorize();calls++;return signPilotTransfer(quote,work=>work(key.privateKey));},
    async claim(){throw Error("not used");},async setPolicy(){throw Error("not used");},
  };
  const f=fixture({ownerBound:true,guardian}),quote=await f.driver.prepare(context,sourceAddress,destinationAddress);
  await assert.rejects(f.driver.sign(quote),reason("preflight-unavailable"));assert.equal(calls,0);
  const signed=await f.driver.sign(quote,()=>{},operationId);f.submit(signed);await f.driver.submit(signed);
  assert.equal(calls,1);assert.deepEqual(f.commands,[]);assert.equal(f.calls.filter(method=>method==="sendTransaction").length,1);
});
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
  assert.equal(f.calls.length,9,"The complete cold transfer uses nine requests within the existing shared allowance.");
  f.receipt(receipt(signed));assert.equal((await f.driver.reconcile(signed)).status,"confirmed");
  assert.equal(f.calls.filter(value=>value==="sendTransaction").length,1);assert.equal(f.calls.filter(value=>value==="getGenesisHash").length,1);
  assert(f.commands.at(-1)!.includes("/usr/bin/env -i"));assert(!f.commands.join("\n").includes("synthetic-password"));
});
test("treasury pilot supports only idempotent receiving ATA creation plus exact TransferChecked",async()=>{
  const f=fixture({destinationAbsent:true}),quote=await f.driver.prepare(context,sourceAddress,destinationAddress);f.select(quote);
  assert.equal(quote.createDestinationAta,true);assert.equal(quote.rentLamports,"2039280");
  const signed=await f.driver.sign(quote),message=getCompiledTransactionMessageDecoder().decode(Buffer.from(quote.messageBase64,"base64"));
  f.submit(signed);await f.driver.submit(signed);assert.equal(f.calls.length,9,"Creating the receiving account requires no extra RPC round trip.");
  assert(message.version==="legacy");assert.equal(message.instructions.length,2);assert.equal(finalizedReceipt(signed,receipt(signed,true),nowBase).status,"confirmed");
});
test("treasury rejects wrong-chain, frozen source, reserve shortfall, cost excess and incorrect simulation before any signing",async()=>{
  for(const options of [{genesis:"other-chain"},{frozen:true},{sol:50_004_999},{fee:5_000_001},{simulationBad:true}]){
    const f=fixture(options);await assert.rejects(f.driver.prepare(context,sourceAddress,destinationAddress));assert.equal(f.commands.length,0);assert(!f.calls.includes("sendTransaction"));
  }
  await assert.rejects(fixture().driver.prepare(context,sourceAddress,sourceAddress));
});
test("known low balances return their specific reason before optional review requests",async()=>{
  const lowSol=fixture({sol:49_000_000});await assert.rejects(lowSol.driver.prepare(context,sourceAddress,destinationAddress),reason("insufficient-sol-reserve"));
  const lowNos=fixture();lowNos.balances(999_999n,0n);await assert.rejects(lowNos.driver.prepare(context,sourceAddress,destinationAddress),reason("insufficient-nos"));
  for(const f of[lowSol,lowNos]){
    assert(!f.calls.includes("getLatestBlockhash"));assert(!f.calls.includes("simulateTransaction"));assert.equal(f.commands.length,0);
  }
});
test("a preparation queued behind other RPC work is bounded by its phase abort signal",async()=>{
  const f=fixture({phaseDeadlineMs:30});let entered=0,ready!:()=>void,release!:()=>void;
  const busy=new Promise<void>(resolve=>{ready=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;});
  f.hook(async method=>{if(method==="getBlockTime"){if(++entered===2)ready();await hold;}});
  const first=f.occupy(),second=f.occupy();await busy;
  try{
    await assert.rejects(f.driver.prepare(context,sourceAddress,destinationAddress),reason("preflight-unavailable"));
    assert(!f.calls.includes("getGenesisHash"));assert.equal(f.commands.length,0);
  }finally{release();await Promise.all([first,second]);}
});
test("treasury expires reviews and revalidates source permission and in-container identity before signing",async()=>{
  for(const mode of["expired","revoked","identity"]){
    const f=fixture(),quote=await f.driver.prepare(context,sourceAddress,destinationAddress);f.select(quote);
    if(mode==="expired")f.advance(60_001);else if(mode==="revoked")f.revoke();else f.wrongIdentity();
    await assert.rejects(f.driver.sign(quote));assert(!f.commands.some(command=>command.includes("--gridlens-one-nos-transfer")));assert(!f.calls.includes("sendTransaction"));
  }
});
test("review expiry retains the original bank-time deadline and a stalled bank never reaches source keys",async()=>{
  const bankTimeMs=nowBase-50_000,f=fixture({blockTimeMs:bankTimeMs});
  const quote=await f.driver.prepare(context,sourceAddress,destinationAddress);f.select(quote);
  assert.equal(quote.expiresAtMs,bankTimeMs+60_000);
  assert(quote.expiresAtMs<quote.preparedAtMs+60_000);
  assert.throws(()=>f.driver.assertReady!(quote),reason("review-expired"),"Too little bank freshness must not be mislabeled as quota waiting.");
  const reads=f.calls.length;f.advance(30_000);
  await assert.rejects(f.driver.sign(quote),reason("review-expired"));
  assert.equal(f.calls.length,reads);assert.equal(f.commands.length,0);assert(!f.calls.includes("sendTransaction"));
  const ordinary=fixture(),current=await ordinary.driver.prepare(context,sourceAddress,destinationAddress);
  const observed=ordinary.dispatches.find(row=>row.method==="getBlockTime")!;
  assert.equal(current.expiresAtMs,Math.min(current.preparedAtMs+60_000,Math.floor(observed.at/1000)*1000+60_000));
});
test("financial authority revoked during an awaited RPC read prevents source-wallet signing",async()=>{
  const f=fixture(),quote=await f.driver.prepare(context,sourceAddress,destinationAddress);f.select(quote);
  let start!:()=>void,release!:()=>void,allowed=true;
  const started=new Promise<void>(resolve=>{start=resolve;}),blocked=new Promise<void>(resolve=>{release=resolve;});
  f.hook(async method=>{if(method==="getFeeForMessage"){start();await blocked;}});
  const signing=f.driver.sign(quote,()=>{if(!allowed)throw new Error("Financial authority revoked.");});
  await started;allowed=false;release();await assert.rejects(signing,/Financial authority revoked/);
  assert(!f.commands.some(command=>command.includes("--gridlens-one-nos-transfer")));assert(!f.calls.includes("sendTransaction"));
});
test("read-only review survives known execution contention while admission prevents key access",async()=>{
  const before=fixture();await before.telemetry(5);
  const busyQuote=await before.driver.prepare(context,sourceAddress,destinationAddress);
  assert.equal(busyQuote.amountBaseUnits,"1000000");assert.throws(()=>before.driver.assertReady!(busyQuote),reason("budget-wait"));
  assert.equal(before.commands.length,0);assert(!before.calls.includes("sendTransaction"));
  const after=fixture(),quote=await after.driver.prepare(context,sourceAddress,destinationAddress);after.select(quote);
  assert(after.driver.assertReady);const prior=after.calls.length;after.driver.assertReady(quote);assert.equal(after.calls.length,prior);
  await after.telemetry(4);const withTelemetry=after.calls.length;
  assert.throws(()=>after.driver.assertReady!(quote),reason("budget-wait"));assert.equal(after.calls.length,withTelemetry);
  await assert.rejects(after.driver.sign(quote),reason("budget-wait"));
  assert.equal(after.commands.length,0);assert(!after.calls.includes("sendTransaction"));
});
test("periodic Fleet SOL/NOS reads averaging five per minute coexist with review waiting and one bounded transfer",async()=>{
  const f=fixture();await f.warm();f.advance(60_000);const start=f.time();
  // Existing provider cadences: two SOL reads every 30s, two NOS reads every
  // 120s with an independent phase. This averages five/minute and gives four
  // or six telemetry reads in a rolling minute; it is not uniform five/minute.
  const due=[0,1,20,21,30,31,60,61,90,91].map(seconds=>start+seconds*1000);
  const telemetry:{due:number;dispatchedAt:number}[]=[];let pumping=false;
  const pump=async(target:number):Promise<void>=>{
    if(pumping)return;
    pumping=true;
    try{
      while(due.length&&due[0]!<=target){const scheduled=due.shift()!;f.at(Math.max(f.time(),scheduled));await f.telemetry(1);telemetry.push({due:scheduled,dispatchedAt:f.time()});}
      f.at(Math.max(f.time(),target));
    }finally{pumping=false;}
  };
  f.paceHook(pump);f.hook(async()=>pump(f.time()));
  await pump(start+35_000);
  const quote=await f.driver.prepare(context,sourceAddress,destinationAddress);f.select(quote);
  assert.equal(f.calls.filter(method=>method==="getMultipleAccounts").length,1);
  const reviewedAt=f.time(),callsAtReview=f.calls.length;
  assert.throws(()=>f.driver.assertReady!(quote),reason("budget-wait"));
  assert.equal(f.calls.length,callsAtReview);assert.equal(f.commands.length,0);
  // The same review remains visible while normal periodic telemetry continues.
  await pump(start+67_000);assert(f.time()>reviewedAt&&f.time()<quote.expiresAtMs);
  f.driver.assertReady!(quote);
  const signed=await f.driver.sign(quote);f.submit(signed);await f.driver.submit(signed);
  assert(f.time()<quote.expiresAtMs);assert.equal(f.calls.filter(method=>method==="sendTransaction").length,1);
  assert.equal(f.calls.filter(method=>method==="getMultipleAccounts").length,1,"Waiting did not redo the five-read review.");
  const walletDispatches=f.dispatches.filter(row=>row.method!=="getGenesisHash").length-telemetry.length;
  assert.equal(walletDispatches,8);
  await pump(start+119_999);assert.equal(telemetry.length,10);assert.equal(due.length,0,"No scheduled telemetry was hidden or skipped.");
  for(const row of f.dispatches)assert(f.dispatches.filter(other=>other.at>row.at-60_000&&other.at<=row.at).length<=12,"Combined rolling allowance exceeded.");
  assert.equal(f.calls.filter(method=>method==="getGenesisHash").length,1,"No provider reset or extra allowance.");
});
test("submission rechecks financial authority after shared pacing immediately before network dispatch",async()=>{
  const f=fixture(),quote=await f.driver.prepare(context,sourceAddress,destinationAddress);f.select(quote);
  const signed=await f.driver.sign(quote);f.submit(signed);let allowed=true;
  f.sleepHook(()=>{allowed=false;});
  await assert.rejects(f.driver.submit(signed,()=>{if(!allowed)throw new Error("Financial authority revoked.");}),/Financial authority revoked/);
  assert(!f.calls.includes("sendTransaction"));
});
test("current fee, post-simulation reserve, account identity and execution failures stop before source key access",async()=>{
  for(const kind of["fee","reserve","rent","execution","identity","slot"]){
    const f=fixture({destinationAbsent:kind==="rent"}),quote=await f.driver.prepare(context,sourceAddress,destinationAddress);f.select(quote);
    if(kind==="fee")f.fee(10_000);else if(kind==="reserve")f.funds(50_004_999);else if(kind==="rent")f.rent(5_000_001);
    else if(kind==="execution")f.simulationError({InstructionError:[0,"failed"]});else if(kind==="identity")f.invalidSimulationAccount();else f.simulationSlot(999);
    await assert.rejects(f.driver.sign(quote));assert.equal(f.commands.length,0);assert(!f.calls.includes("sendTransaction"));
  }
});
test("normal balance changes between review and current preflight do not require stale balance equality",async()=>{
  const f=fixture(),quote=await f.driver.prepare(context,sourceAddress,destinationAddress);f.select(quote);f.balances(10_000_000n,8_000_000n);
  const signed=await f.driver.sign(quote);f.submit(signed);await f.driver.submit(signed);
  assert.equal(f.calls.filter(method=>method==="getMultipleAccounts").length,1);assert.equal(f.calls.filter(method=>method==="simulateTransaction").length,2);
  assert.equal(f.calls.filter(method=>method==="sendTransaction").length,1);
});
test("stale preflight blocks key access and queued broadcast without automatic re-signing",async()=>{
  const beforeKey=fixture(),quote=await beforeKey.driver.prepare(context,sourceAddress,destinationAddress);beforeKey.select(quote);
  beforeKey.commandHook(command=>{if(command.includes("inspect --format"))beforeKey.advance(15_001);});
  await assert.rejects(beforeKey.driver.sign(quote),reason("review-expired"));
  assert(!beforeKey.commands.some(command=>command.includes("--gridlens-one-nos-transfer")));
  const queued=fixture(),review=await queued.driver.prepare(context,sourceAddress,destinationAddress);queued.select(review);
  const signed=await queued.driver.sign(review);queued.submit(signed);queued.sleepHook(()=>queued.advance(15_001));
  await assert.rejects(queued.driver.submit(signed),reason("review-expired"));assert(!queued.calls.includes("sendTransaction"));
  await assert.rejects(queued.driver.submit(signed),reason("review-expired"));
});
test("submit requires this process's exact signed attestation and permits no duplicate broadcast",async()=>{
  const f=fixture(),quote=await f.driver.prepare(context,sourceAddress,destinationAddress);f.select(quote);
  const signed=await f.driver.sign(quote);f.submit(signed);
  await assert.rejects(f.driver.submit({...signed,transactionBase64:signed.transactionBase64.slice(0,-4)+"AAAA"}),reason("review-expired"));
  await assert.rejects(fixture().driver.submit(signed),reason("review-expired"));
  await f.driver.submit(signed);await assert.rejects(f.driver.submit(signed),reason("review-expired"));
  assert.equal(f.calls.filter(method=>method==="sendTransaction").length,1);
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
