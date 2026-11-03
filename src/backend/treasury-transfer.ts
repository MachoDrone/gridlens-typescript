import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { getCompiledTransactionMessageDecoder, getTransactionEncoder } from "@solana/kit";
import { AccountState, getMintDecoder, getTokenDecoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { rpcObject, SolanaRpcError } from "../../scripts/solana-rpc.ts";
import type { SolanaRpc, SolanaProviderState } from "../../scripts/solana-rpc.ts";
import type { FleetContext } from "../contracts/fleet.ts";
import type { PcAssociation } from "../contracts/shared.ts";
import { sameBinding } from "../fleet/pc-observations.ts";
import type { PrivateState } from "./access.ts";
import type { CredentialVault } from "./credential-vault.ts";
import type { createObservationStore } from "./observations.ts";
import type { PcPermission } from "./pc-monitor.ts";
import { cleanNodeRuntime, verifyNode } from "./pc-rewards.ts";
import { shellQuote, withSsh } from "./ssh.ts";
import type { SshCredential, SshRun } from "./ssh.ts";
import type { TreasuryDriver, TreasuryQuote, TreasurySigned } from "./treasury.ts";
import type { FinancialGuardianTransport } from "./guardian-transport.ts";
import { TreasuryPreflightError } from "./treasury-errors.ts";
import { canonicalBase64, transferAccounts, transferTransaction, validatedTransferMessage, validateSignedTransfer,
  TREASURY_AMOUNT, TREASURY_MAX_COST, TREASURY_NOS_MINT, TREASURY_RESERVE } from "./treasury-transaction.ts";

const SYSTEM = "11111111111111111111111111111111";
const CLEAN = ["LD_PRELOAD", "LD_AUDIT", "LD_LIBRARY_PATH", "GLIBC_TUNABLES", "LD_DEBUG", "LD_DEBUG_OUTPUT", "LD_PROFILE", "LD_PROFILE_OUTPUT", "LD_ORIGIN_PATH", "GCONV_PATH", "LOCPATH", "NLSPATH"]
  .map(name => ` --env ${name}=`).join("") + " --env LANG=C --env LC_ALL=C";
export interface TreasuryTransferOptions {
  rpc: SolanaRpc; state: PrivateState; vault: CredentialVault; observations: ReturnType<typeof createObservationStore>;
  contexts: () => readonly FleetContext[]; now?: () => number; connect?: typeof withSsh;
  /** Trusted build output or isolated test fixture; never supplied by a browser request. */
  signerSource?: string;
  /** Legacy is explicit and used only by the compatibility release. */
  securityMode?: "owner-bound" | "legacy";
  guardian?: FinancialGuardianTransport;
}
interface Source { context: FleetContext; association: PcAssociation; permission: PcPermission; credential: SshCredential; binding: TreasuryQuote["sourceBinding"] }
interface ChainSnapshot { slot:number; blockTimeMs:number; sourceNos:bigint; destinationNos:bigint; sourceSol:bigint; createDestinationAta:boolean }
const PREFLIGHT_MAX_AGE_MS = 15_000;
interface PreparedReview { slot: number; expiresAtMs: number; signing: boolean }
interface SignedPreflight { reviewKey: string; wireHash: string; checkedAtMs: number; slot: number; attempted: boolean }
const integer = (value: unknown): bigint => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^(0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n) return BigInt(value);
  throw new TreasuryPreflightError("preflight-unavailable");
};
const slotNumber = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new TreasuryPreflightError("preflight-unavailable");
  return value;
};
function tokenBytes(account: unknown, size: number): Buffer {
  if (!rpcObject(account) || account.owner !== TOKEN_PROGRAM_ADDRESS || account.executable !== false
    || account.space !== undefined && account.space !== size || !Array.isArray(account.data) || account.data.length !== 2 || account.data[1] !== "base64")
    throw new TreasuryPreflightError("account-invalid");
  let bytes: Buffer;
  try { bytes = canonicalBase64(account.data[0], size); } catch { throw new TreasuryPreflightError("account-invalid"); }
  if (bytes.length !== size || (size === 82 ? [0,46] : [72,109,129]).some(offset => bytes.readUInt32LE(offset) > 1))
    throw new TreasuryPreflightError("account-invalid");
  return bytes;
}
function tokenAmount(account: unknown, owner: string): bigint {
  const token = getTokenDecoder().decode(tokenBytes(account, 165));
  if (token.mint !== TREASURY_NOS_MINT || token.owner !== owner || token.state !== AccountState.Initialized || token.isNative.__option !== "None")
    throw new TreasuryPreflightError("account-invalid");
  return token.amount;
}
function costs(sourceSol: bigint, fee: bigint, rent: bigint): void {
  if (fee <= 0n || fee + rent > BigInt(TREASURY_MAX_COST)) throw new TreasuryPreflightError("cost-limit");
  if (sourceSol - fee - rent < BigInt(TREASURY_RESERVE)) throw new TreasuryPreflightError("insufficient-sol-reserve");
}
function messageInput(quote: TreasuryQuote) {
  const { sourceAddress, destinationAddress, sourceTokenAddress, destinationTokenAddress, mintAddress, amountBaseUnits, decimals,
    createDestinationAta, blockhash, lastValidBlockHeight, messageBase64 } = quote;
  return { sourceAddress, destinationAddress, sourceTokenAddress, destinationTokenAddress, mintAddress, amountBaseUnits, decimals,
    createDestinationAta, blockhash, lastValidBlockHeight, messageBase64 };
}

/** Mainnet only, one fixed-size transfer, no reward claim or automatic retry path. */
export function createTreasuryTransferDriver(options: TreasuryTransferOptions): TreasuryDriver {
  const { rpc: transport, state, vault, observations, contexts, connect = withSsh, now = Date.now } = options;
  const session = transport.createSession("treasury-one-nos");
  const protectedMode = options.securityMode !== "legacy";
  const target = (source: Source) => ({ computer: source.permission.computer, credential: source.credential });
  const guardian = (): FinancialGuardianTransport => { if (!options.guardian) throw new TreasuryPreflightError("preflight-unavailable"); return options.guardian; };
  // Reviews and preflight attestations are process-local. Restart recovery can
  // inspect a journaled signature, but cannot sign or broadcast it again.
  const preparedReviews = new Map<string, PreparedReview>();
  const signedPreflights = new Map<string, SignedPreflight>();
  const reviewKey = (quote: TreasuryQuote): string => createHash("sha256").update(JSON.stringify([
    quote.scopeId, quote.rosterRevision, quote.sourceAddress, quote.destinationAddress,
    quote.sourceBinding.pcId, quote.sourceBinding.nodeId, quote.sourceBinding.containerId, quote.sourceBinding.sshIdentity,
    quote.sourceTokenAddress, quote.destinationTokenAddress, quote.mintAddress, quote.amountBaseUnits, quote.decimals,
    quote.createDestinationAta, quote.blockhash, quote.lastValidBlockHeight, quote.messageBase64,
    quote.feeLamports, quote.rentLamports, quote.reserveLamports, quote.maxCostLamports,
    quote.sourceNosBaseUnits, quote.sourceSolLamports, quote.preparedAtMs, quote.expiresAtMs,
  ])).digest("hex");
  const preparedReview = (quote: TreasuryQuote): PreparedReview => {
    const record = preparedReviews.get(reviewKey(quote));
    if (!record || record.signing || record.expiresAtMs <= now()) throw new TreasuryPreflightError("review-expired");
    return record;
  };
  const freshPreflight = (checkedAtMs: number): void => {
    if (checkedAtMs > now() || now() - checkedAtMs > PREFLIGHT_MAX_AGE_MS) throw new TreasuryPreflightError("review-expired");
  };
  function source(scopeId: string, revision: string, sourceAddress: string): Source {
    const context = contexts().find(value => value.scopeId === scopeId && value.rosterRevision === revision);
    if (!context || !context.addresses.includes(sourceAddress)) throw new TreasuryPreflightError("source-changed");
    const association = observations.read(context).associations.find(row => row.address === sourceAddress);
    if (!association) throw new TreasuryPreflightError("source-changed");
    const permission = state.get<PcPermission>(`permission:${scopeId}:${association.binding.pcId}`);
    const approved = permission?.associations.find(row => row.address === sourceAddress);
    if (!permission || permission.version !== 1 || permission.paused || permission.revokedAtMs !== null
      || permission.rosterRevision !== revision || permission.computer.id !== association.binding.pcId
      || permission.computer.fingerprint !== association.sshFingerprint || !approved || !sameBinding(approved.binding, association.binding)
      || approved.sshFingerprint !== association.sshFingerprint) throw new TreasuryPreflightError("source-changed");
    const credential = vault.read(scopeId, permission.computer.id);
    if (!credential) throw new TreasuryPreflightError("source-changed");
    const binding = { pcId: permission.computer.id, containerId: association.binding.nodeContainerId, sshIdentity: association.sshFingerprint,
      nodeId: createHash("sha256").update(JSON.stringify([association.binding, permission.computer.hostKey, permission.approvedAtMs, revision])).digest("hex") };
    return { context, association, permission, credential, binding };
  }
  const sameSource = (quote: TreasuryQuote): Source => {
    const current = source(quote.scopeId, quote.rosterRevision, quote.sourceAddress);
    if ((["pcId", "nodeId", "containerId", "sshIdentity"] as const).some(key => current.binding[key] !== quote.sourceBinding[key]))
      throw new TreasuryPreflightError("source-changed");
    return current;
  };
  const quoteCurrent = (quote: TreasuryQuote): void => {
    if (!Number.isSafeInteger(quote.preparedAtMs) || !Number.isSafeInteger(quote.expiresAtMs) || quote.expiresAtMs - quote.preparedAtMs > 60_000
      || quote.preparedAtMs > now() || quote.expiresAtMs <= now() || quote.reserveLamports !== TREASURY_RESERVE || quote.maxCostLamports !== TREASURY_MAX_COST)
      throw new TreasuryPreflightError("review-expired");
    costs(integer(quote.sourceSolLamports), integer(quote.feeLamports), integer(quote.rentLamports));
    if (integer(quote.sourceNosBaseUnits) < 1_000_000n) throw new TreasuryPreflightError("insufficient-nos");
  };
  const remainingCapacity = (quote: TreasuryQuote, count: number, freshUntilMs = Infinity): void => {
    // Advisory lookahead uses the existing global budget without reserving a
    // second allowance. Leave time for the bounded source-container helper.
    if (quote.expiresAtMs - 10_000 <= now()) throw new TreasuryPreflightError("review-expired");
    const provider = session.eligible();
    const next = session.nextEligibleAt(), retryAtMs = next !== null && next > now() ? next : undefined;
    if (!provider) throw new TreasuryPreflightError("provider-unavailable", retryAtMs);
    if (!transport.canDispatchBefore(count + (provider.genesisVerified ? 0 : 1),
      Math.min(quote.expiresAtMs - 10_000, now() + transport.refreshDeadlineMs - 10_000, freshUntilMs)))
      throw new TreasuryPreflightError("budget-wait", retryAtMs);
  };
  async function usingRpc<T>(work: (provider: SolanaProviderState, read: (method:string,params:unknown[],beforeDispatch?:()=>void)=>Promise<unknown>) => Promise<T>): Promise<T> {
    const provider = session.eligible();
    if (!provider) { const next = session.nextEligibleAt(); throw new TreasuryPreflightError("provider-unavailable", next !== null && next > now() ? next : undefined); }
    const duration = Math.min(transport.refreshDeadlineMs, 28_000);
    const signal = AbortSignal.timeout(duration), deadline = now() + duration, healthVersion = provider.healthVersion;
    try {
      await transport.verifyMainnet(provider, signal, deadline);
      const result = await work(provider, (method, params, beforeDispatch) => transport.rpc(provider, method, params, signal, deadline, beforeDispatch));
      session.success(provider, healthVersion); return result;
    } catch (error) {
      if (error instanceof SolanaRpcError) {
        session.failure(provider, error);
        const next = error.retryAtMs ?? session.nextEligibleAt();
        const code=error.kind === "deferred" ? error.deferSource === "budget" ? "budget-wait"
          : error.deferSource === "provider" ? "provider-unavailable" : "preflight-unavailable"
          : error.kind === "parameters" ? "preflight-unavailable" : "provider-unavailable";
        throw new TreasuryPreflightError(code,code!=="preflight-unavailable"&&next !== null && next > now() ? next : undefined);
      }
      if (signal.aborted) throw new TreasuryPreflightError("preflight-unavailable");
      throw error;
    }
  }
  async function snapshot(read: (method:string,params:unknown[])=>Promise<unknown>, input: {sourceAddress:string;destinationAddress:string;sourceTokenAddress:string;destinationTokenAddress:string}): Promise<ChainSnapshot> {
    const data = await read("getMultipleAccounts", [[TREASURY_NOS_MINT, input.sourceTokenAddress, input.destinationTokenAddress, input.sourceAddress], { commitment: "confirmed", encoding: "base64" }]);
    if (!rpcObject(data) || !rpcObject(data.context) || !Array.isArray(data.value) || data.value.length !== 4) throw new TreasuryPreflightError("preflight-unavailable");
    const slot = slotNumber(data.context.slot), mintBytes = tokenBytes(data.value[0], 82), mint = getMintDecoder().decode(mintBytes);
    if (mint.decimals !== 6 || !mint.isInitialized || mintBytes[45] !== 1) throw new TreasuryPreflightError("account-invalid");
    if (data.value[1] === null) throw new TreasuryPreflightError("insufficient-nos");
    const sourceNos = tokenAmount(data.value[1], input.sourceAddress), createDestinationAta = data.value[2] === null;
    const destinationNos = createDestinationAta ? 0n : tokenAmount(data.value[2], input.destinationAddress), wallet = data.value[3];
    if (!rpcObject(wallet) || wallet.owner !== SYSTEM || wallet.executable !== false || wallet.space !== undefined && wallet.space !== 0
      || !Array.isArray(wallet.data) || wallet.data.length !== 2 || wallet.data[0] !== "" || wallet.data[1] !== "base64")
      throw new TreasuryPreflightError("account-invalid");
    const sourceSol = integer(wallet.lamports);
    const blockTime = await read("getBlockTime", [slot]);
    if (typeof blockTime !== "number" || !Number.isSafeInteger(blockTime) || now() - blockTime * 1000 > 60_000 || blockTime * 1000 - now() > 15_000)
      throw new TreasuryPreflightError("preflight-unavailable");
    if (sourceNos < 1_000_000n) throw new TreasuryPreflightError("insufficient-nos");
    if (sourceSol <= BigInt(TREASURY_RESERVE)) throw new TreasuryPreflightError("insufficient-sol-reserve");
    return { slot, blockTimeMs:blockTime*1000, sourceNos, destinationNos, sourceSol, createDestinationAta };
  }
  async function fee(read: (method:string,params:unknown[])=>Promise<unknown>, quote: Pick<TreasuryQuote,"messageBase64">,
    minimumSlot: number): Promise<{amount:bigint;slot:number}> {
    const result = await read("getFeeForMessage", [quote.messageBase64, { commitment: "confirmed", minContextSlot: minimumSlot }]);
    if (!rpcObject(result) || !rpcObject(result.context) || result.value === null || slotNumber(result.context.slot) < minimumSlot)
      throw new TreasuryPreflightError("preflight-unavailable");
    return { amount: integer(result.value), slot: slotNumber(result.context.slot) };
  }
  async function simulate(read: (method:string,params:unknown[])=>Promise<unknown>, quote:TreasuryQuote, before:ChainSnapshot|undefined,
    minimumSlot: number): Promise<{rent:bigint;slot:number;checkedAtMs:number}> {
    const tx = await validatedTransferMessage(quote);
    const simulation = await read("simulateTransaction", [Buffer.from(getTransactionEncoder().encode(tx)).toString("base64"),
      { encoding:"base64",commitment:"confirmed",sigVerify:false,replaceRecentBlockhash:false,minContextSlot:minimumSlot,
        accounts:{encoding:"base64",addresses:[quote.sourceTokenAddress,quote.destinationTokenAddress,quote.sourceAddress]} }]);
    if (!rpcObject(simulation) || !rpcObject(simulation.context) || slotNumber(simulation.context.slot) < minimumSlot || !rpcObject(simulation.value)
      || simulation.value.err !== null || !Array.isArray(simulation.value.accounts) || simulation.value.accounts.length !== 3)
      throw new TreasuryPreflightError("preflight-unavailable");
    const sourceNos=tokenAmount(simulation.value.accounts[0],quote.sourceAddress),destinationNos=tokenAmount(simulation.value.accounts[1],quote.destinationAddress);
    if (before&&(sourceNos !== before.sourceNos - 1_000_000n || destinationNos !== before.destinationNos + 1_000_000n) || destinationNos<1_000_000n)
      throw new TreasuryPreflightError("account-invalid");
    // The fixed ATA instruction creates only this classic 165-byte account. Its
    // simulated lamports supply the rent quote without an extra RPC allowance.
    const destination=simulation.value.accounts[1];
    const rent=quote.createDestinationAta&&rpcObject(destination)?integer(destination.lamports):0n;
    const payer = simulation.value.accounts[2];
    if (!rpcObject(payer) || payer.owner !== SYSTEM || payer.executable !== false || payer.space !== undefined && payer.space !== 0
      || !Array.isArray(payer.data) || payer.data.length !== 2 || payer.data[0] !== "" || payer.data[1] !== "base64")
      throw new TreasuryPreflightError("account-invalid");
    if (integer(payer.lamports) < BigInt(TREASURY_RESERVE)) throw new TreasuryPreflightError("insufficient-sol-reserve");
    if (before&&(before.sourceSol - integer(payer.lamports) > integer(quote.feeLamports)+rent || before.sourceSol<integer(payer.lamports)))
      throw new TreasuryPreflightError("cost-limit");
    costs(integer(payer.lamports)+integer(quote.feeLamports)+rent,integer(quote.feeLamports),rent);
    return {rent,slot:slotNumber(simulation.context.slot),checkedAtMs:now()};
  }
  return {
    assertReady(quote) { quoteCurrent(quote);const current=sameSource(quote);if(protectedMode)guardian().assertReady(target(current),quote);preparedReview(quote);remainingCapacity(quote,3); },
    async prepare(context, sourceAddress, destinationAddress) {
      preparedReviews.clear();
      const approved = source(context.scopeId, context.rosterRevision, sourceAddress), accounts = await transferAccounts(sourceAddress,destinationAddress);
      if (protectedMode) await guardian().prepare(target(approved), sourceAddress, destinationAddress);
      return usingRpc(async (_provider, read) => {
        const before = await snapshot(read,{sourceAddress,destinationAddress,...accounts});
        const latest = await read("getLatestBlockhash",[{commitment:"confirmed",minContextSlot:before.slot}]);
        if (!rpcObject(latest) || !rpcObject(latest.context) || slotNumber(latest.context.slot)<before.slot || !rpcObject(latest.value)
          || typeof latest.value.blockhash!=="string") throw new TreasuryPreflightError("preflight-unavailable");
        const lastValidBlockHeight=slotNumber(latest.value.lastValidBlockHeight), preparedAtMs=now();
        // Later fee/simulation responses cannot renew this bank-time witness.
        // Retain the existing 60-second chain-age bound through key use and send.
        const expiresAtMs=Math.min(preparedAtMs+60_000,before.blockTimeMs+60_000);
        if(expiresAtMs<=preparedAtMs)throw new TreasuryPreflightError("review-expired");
        const quote:TreasuryQuote={scopeId:context.scopeId,rosterRevision:context.rosterRevision,sourceAddress,destinationAddress,...accounts,
          mintAddress:TREASURY_NOS_MINT,amountBaseUnits:TREASURY_AMOUNT,decimals:6,createDestinationAta:before.createDestinationAta,
          sourceBinding:approved.binding,sourceNosBaseUnits:before.sourceNos.toString(),sourceSolLamports:before.sourceSol.toString(),
          blockhash:latest.value.blockhash,lastValidBlockHeight,preparedAtMs,expiresAtMs,messageBase64:"",
          feeLamports:"0",rentLamports:"0",reserveLamports:TREASURY_RESERVE,maxCostLamports:TREASURY_MAX_COST};
        const transaction=await transferTransaction(quote); quote.messageBase64=Buffer.from(transaction.messageBytes).toString("base64");
        const currentFee=await fee(read,quote,slotNumber(latest.context.slot));
        quote.feeLamports=currentFee.amount.toString();
        costs(before.sourceSol,currentFee.amount,0n);
        const simulation=await simulate(read,quote,before,currentFee.slot);
        quote.rentLamports=simulation.rent.toString();
        costs(before.sourceSol,integer(quote.feeLamports),integer(quote.rentLamports));
        // A validated read-only review remains useful while future execution
        // allowance recovers. Admission is checked only when the owner confirms.
        sameSource(quote);quoteCurrent(quote);
        preparedReviews.set(reviewKey(quote),{slot:simulation.slot,expiresAtMs:quote.expiresAtMs,signing:false});return quote;
      });
    },
    async sign(quote, authorize = () => {}, operationId) {
      if (protectedMode && (!operationId || !options.guardian)) throw new TreasuryPreflightError("preflight-unavailable");
      authorize();quoteCurrent(quote);remainingCapacity(quote,3);
      const review=preparedReview(quote),key=reviewKey(quote);
      review.signing=true;
      try {
        await validatedTransferMessage(quote);authorize();const approved=sameSource(quote);
        const preflight=await usingRpc(async (_provider,read)=>{
          const currentFee=await fee(read,quote,review.slot);
          if(currentFee.amount>integer(quote.feeLamports))throw new TreasuryPreflightError("cost-limit");
          // Reconstructing the allowlist fixes the only possible token movement.
          // Validate current simulated POST accounts, not balances from an older
          // review that may have changed through normal host activity.
          const result=await simulate(read,quote,undefined,currentFee.slot);
          if(result.rent>integer(quote.rentLamports))throw new TreasuryPreflightError("cost-limit");
          return result;
        });
        const guard=():void=>{authorize();quoteCurrent(quote);sameSource(quote);freshPreflight(preflight.checkedAtMs);remainingCapacity(quote,1,preflight.checkedAtMs+PREFLIGHT_MAX_AGE_MS);};
        guard();
        let response: unknown;
        if (protectedMode) response = await guardian().transfer(target(approved), quote, operationId!, guard);
        else {
          const helper=options.signerSource??readFileSync(new URL("../../dist/backend/treasury-signer.cjs",import.meta.url),"utf8");
          if(helper.length<1||Buffer.byteLength(helper)>120_000) throw new TreasuryPreflightError("preflight-unavailable");
          const output=await connect(approved.permission.computer,approved.credential,async run=>{
            const guarded:SshRun=(command,settings)=>{
              guard();
              return run(approved.credential.sudoPassword===undefined?command:`/usr/bin/sudo -S -p '' -- ${command}`,
                {...settings,...(approved.credential.sudoPassword===undefined?{}:{input:approved.credential.sudoPassword+"\n"})});
            };
            if(await verifyNode(guarded,approved.association)!=="ok")throw new TreasuryPreflightError("source-changed");
            const prelude='ulimit -S -c 0 && ulimit -H -c 0 && printf 0 > /proc/self/coredump_filter && exec /usr/local/bin/node -e "$1" -- --gridlens-one-nos-transfer "$2"';
            return guarded(`${cleanNodeRuntime(approved.association)} exec${CLEAN} ${approved.association.binding.nodeContainerId} /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C /bin/sh -c ${shellQuote(prelude)} gridlens-one-nos-transfer ${shellQuote(helper)} ${shellQuote(JSON.stringify(messageInput(quote)))}`,{maximum:4096,timeoutMs:10_000});
          });
          if(output.code!==0)throw new TreasuryPreflightError("preflight-unavailable");
          try{response=JSON.parse(output.stdout);}catch{throw new TreasuryPreflightError("preflight-unavailable");}
        }
        if(!rpcObject(response)||Object.keys(response).sort().join(",")!=="signature,transactionBase64"||typeof response.transactionBase64!=="string"||typeof response.signature!=="string")
          throw new TreasuryPreflightError("preflight-unavailable");
        await validateSignedTransfer(quote,response.transactionBase64,response.signature);guard();
        signedPreflights.clear();
        signedPreflights.set(response.signature,{reviewKey:key,wireHash:createHash("sha256").update(response.transactionBase64).digest("hex"),
          checkedAtMs:preflight.checkedAtMs,slot:preflight.slot,attempted:false});
        return {quote,transactionBase64:response.transactionBase64,signature:response.signature};
      } finally { preparedReviews.delete(key); }
    },
    async submit(signed, authorize = () => {}) {
      const attestation=signedPreflights.get(signed.signature);
      const guard=():void=>{
        authorize();quoteCurrent(signed.quote);sameSource(signed.quote);
        if(!attestation||attestation.attempted||attestation.reviewKey!==reviewKey(signed.quote)
          ||attestation.wireHash!==createHash("sha256").update(signed.transactionBase64).digest("hex"))
          throw new TreasuryPreflightError("review-expired");
        freshPreflight(attestation.checkedAtMs);
      };
      guard();await validateSignedTransfer(signed.quote,signed.transactionBase64,signed.signature);guard();
      // The engine durably journals the signature and wire bytes before this call.
      // RPC performs the signed preflight. Do not spend another fee/simulation
      // allowance here; the process-local attestation expires after 15 seconds.
      try { await usingRpc(async (_provider,read)=>{
        const result=await read("sendTransaction",[signed.transactionBase64,
        {encoding:"base64",skipPreflight:false,preflightCommitment:"confirmed",maxRetries:0,minContextSlot:attestation!.slot}],()=>{guard();attestation!.attempted=true;});
        if(result!==signed.signature) throw new Error("The submission outcome is uncertain; reconcile this signature before another transfer.");});
      } finally { signedPreflights.delete(signed.signature); }
    },
    async reconcile(signed) {
      await validateSignedTransfer(signed.quote,signed.transactionBase64,signed.signature);
      try{return await usingRpc(async (_provider,read)=>{
        const result=await read("getTransaction",[signed.signature,{commitment:"finalized",encoding:"base64",maxSupportedTransactionVersion:0}]);
        if(result===null)return{status:"uncertain" as const,observedAtMs:now()};
        return finalizedReceipt(signed,result,now());
      });}catch(error){
        const retryAtMs=error instanceof TreasuryPreflightError&&error.retryAtMs!==undefined?error.retryAtMs:session.nextEligibleAt();
        return{status:"uncertain",observedAtMs:now(),...(retryAtMs!==null&&retryAtMs>now()?{retryAtMs}: {})};
      }
    },
  };
}

/** Match the exact signed wire transaction and finalized per-account movements. */
export function finalizedReceipt(signed:TreasurySigned,result:unknown,observedAtMs:number):{status:"confirmed"|"failed"|"uncertain";observedAtMs:number;slot?:number} {
  const uncertain={status:"uncertain" as const,observedAtMs};
  try{
    if(!rpcObject(result)||!Array.isArray(result.transaction)||result.transaction.length!==2||result.transaction[1]!=="base64"
      ||result.transaction[0]!==signed.transactionBase64||!rpcObject(result.meta))return uncertain;
    const slot=slotNumber(result.slot),meta=result.meta;
    if(!("err"in meta))return uncertain;
    if(meta.err!==null)return{status:"failed",observedAtMs,slot};
    const message=getCompiledTransactionMessageDecoder().decode(canonicalBase64(signed.quote.messageBase64));
    if(message.version!=="legacy"||!Array.isArray(meta.preTokenBalances)||!Array.isArray(meta.postTokenBalances)
      ||!Array.isArray(meta.preBalances)||!Array.isArray(meta.postBalances))return uncertain;
    const q=signed.quote, sourceIndex=message.staticAccounts.indexOf(q.sourceTokenAddress as never),destinationIndex=message.staticAccounts.indexOf(q.destinationTokenAddress as never);
    const amount=(rows:unknown[],index:number,owner:string,allowAbsent=false):bigint=>{
      const matches=rows.filter(row=>rpcObject(row)&&row.accountIndex===index);
      if(matches.length===0&&allowAbsent)return 0n;
      const row=matches[0];if(matches.length!==1||!rpcObject(row)||row.mint!==TREASURY_NOS_MINT||row.owner!==owner||row.programId!==TOKEN_PROGRAM_ADDRESS
        ||!rpcObject(row.uiTokenAmount)||row.uiTokenAmount.decimals!==6)throw new Error();
      return integer(row.uiTokenAmount.amount);
    };
    if(sourceIndex<0||destinationIndex<0||amount(meta.preTokenBalances,sourceIndex,q.sourceAddress)-amount(meta.postTokenBalances,sourceIndex,q.sourceAddress)!==1_000_000n
      ||amount(meta.postTokenBalances,destinationIndex,q.destinationAddress)-amount(meta.preTokenBalances,destinationIndex,q.destinationAddress,q.createDestinationAta)!==1_000_000n)return uncertain;
    const payerIndex=message.staticAccounts.indexOf(q.sourceAddress as never),before=integer(meta.preBalances[payerIndex]),after=integer(meta.postBalances[payerIndex]),fee=integer(meta.fee);
    if(after<BigInt(TREASURY_RESERVE)||before<after||fee>integer(q.feeLamports)||before-after>integer(q.feeLamports)+integer(q.rentLamports)
      ||before-after>BigInt(TREASURY_MAX_COST))return uncertain;
    return{status:"confirmed",observedAtMs,slot};
  }catch{return uncertain;}
}
