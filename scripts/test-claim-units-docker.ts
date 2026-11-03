/** Actual old-runtime persistence and new-runtime receipt reconciliation. The
 * shared volume contains generated fixture state only. Network access is disabled. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureImageCapabilities } from "./shared-docker-fixture.ts";
import { checked, ensureVolume, inspectOwned, labels, localDockerRunner, mount, resourceName, restrictions } from "../src/installer/docker.ts";
import type { DockerRunner } from "../src/installer/docker.ts";

type Mode = "seed-old" | "correct-new" | "reject-old" | "reopen-new";
interface FixtureInput { instance: string; mode: Mode }

/** Serialized into each selected image. No application files are mounted from
 * the checkout, so the seed and rejection stages really use the old runtime. */
async function fixtureRuntime(input: FixtureInput): Promise<void> {
  const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
  const { mkdirSync, readFileSync, readdirSync } = await import("node:fs");
  const { DatabaseSync } = await import("node:sqlite");
  const { createHash } = await import("node:crypto");
  const { address, getBase58Decoder } = await import("@solana/kit");
  const { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } = await import("@solana-program/token");
  const { openSharedState } = await import("/app/src/backend/sqlite-state.ts" as string) as typeof import("../src/backend/sqlite-state.ts");
  const { openTreasuryVault } = await import("/app/src/backend/treasury-vault.ts" as string) as typeof import("../src/backend/treasury-vault.ts");
  const { createTreasuryClaims, TREASURY_CLAIMS_LEDGER_KEY } = await import("/app/src/backend/treasury-claims.ts" as string) as typeof import("../src/backend/treasury-claims.ts");
  const { initializeClaimsMarker } = await import("/app/src/backend/treasury-claims-marker.ts" as string) as typeof import("../src/backend/treasury-claims-marker.ts");
  const { NOS_MINT } = await import("/app/src/fleet/nos.ts" as string) as typeof import("../src/fleet/nos.ts");
  if (!/^fixture-[a-f0-9]{12}$/.test(input.instance) || !["seed-old", "correct-new", "reject-old", "reopen-new"].includes(input.mode)) throw new Error("Invalid isolated unit fixture.");
  const seed = input.mode === "seed-old", now = () => Date.now() - (seed ? 60_000 : 0);
  const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
  const markerKey = "fixture/claim-unit-correction-v1", source = "1".repeat(31) + "2", funder = "1".repeat(31) + "3", fundingToken = "1".repeat(31) + "4";
  const signature = getBase58Decoder().decode(Buffer.alloc(64, 7));
  const correctAmount = "2500000", legacyAmount = "2500000000000", serverId = `generated-${input.instance}`;
  const context = { scopeId: "fixture", rosterRevision: "generated-unit-revision", addresses: [source] };
  const originalTransfer = { consumed: true, operation: "original generated encrypted NOS receipt", configuration: "original generated encrypted receiving wallet", owner: "original generated verifier" };
  const [account] = await findAssociatedTokenPda({ owner: address(source), mint: address(NOS_MINT), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  mkdirSync("/fixture/credentials", { recursive: true, mode: 0o700 });
  const state = openSharedState("/fixture/state", { ledgerDirectory: "/fixture/ledger" });
  const vault = openTreasuryVault("/fixture/credentials", { create: seed });
  interface Marker { version: 1; instance: string; helperCalls: number; rpcCalls: number; rpcMethods: string[]; sourceAccessCalls: number;
    operationId?: string; entriesDigest?: string; correctionCiphertextDigest?: string; markerDigest?: string }
  const marker = (): Marker => {
    const value = state.get<Marker>(markerKey);
    if (value?.version !== 1 || value.instance !== input.instance) throw new Error("Fixture ownership marker changed.");
    return value;
  };
  const updateMarker = (change: Partial<Marker>) => state.set(markerKey, { ...marker(), ...change });
  if (seed) {
    assert.equal(state.get(markerKey), undefined); assert.equal(state.get(TREASURY_CLAIMS_LEDGER_KEY), undefined);
    state.batch([[markerKey, { version: 1, instance: input.instance, helperCalls: 0, rpcCalls: 0, rpcMethods: [], sourceAccessCalls: 0 }], ["treasury.v1", originalTransfer]]);
  } else marker();
  const ledgerDigest = () => {
    const db = new DatabaseSync("/fixture/ledger/ledger.sqlite", { readOnly: true });
    try { return hash(JSON.stringify(db.prepare("SELECT key,value FROM private_state ORDER BY key").all())); } finally { db.close(); }
  };
  // Only generated marker files are read here; exclude the fixture vault key.
  const markerHash = () => {
    const files = readdirSync("/fixture/credentials").filter(name => name !== "treasury-key-v1").sort();
    return hash(JSON.stringify(files.map(name => [name, hash(readFileSync(`/fixture/credentials/${name}`))])));
  };
  let engine: ReturnType<typeof createTreasuryClaims> | undefined;
  const unexpected = () => { updateMarker({ sourceAccessCalls: marker().sourceAccessCalls + 1 }); throw new Error("A source credential or host was accessed by a receipt-only fixture."); };
  let driver: import("../src/backend/treasury-claims.ts").ClaimsDriver;
  if (input.mode === "correct-new" || input.mode === "reopen-new") {
    const { createSolanaRpc, MAINNET_GENESIS_HASH } = await import("/app/scripts/solana-rpc.ts" as string) as typeof import("./solana-rpc.ts");
    const { createTreasuryClaimDriver } = await import("/app/src/backend/treasury-claim-driver.ts" as string) as typeof import("../src/backend/treasury-claim-driver.ts");
    const receipt = { slot: 424242, blockTime: Math.floor(now() / 1000), version: "legacy", transaction: {
      signatures: [signature], message: { accountKeys: [
        { pubkey: funder, signer: true, writable: true }, { pubkey: account, signer: false, writable: true },
        { pubkey: fundingToken, signer: false, writable: true }, { pubkey: TOKEN_PROGRAM_ADDRESS, signer: false, writable: false },
      ], recentBlockhash: "1".repeat(31) + "5", instructions: [{ program: "spl-token", programId: TOKEN_PROGRAM_ADDRESS,
        parsed: { type: "transfer", info: { authority: funder, source: fundingToken, destination: account, amount: correctAmount } } }] } },
      meta: { err: null, innerInstructions: [], preTokenBalances: [
        { accountIndex: 1, mint: NOS_MINT, owner: source, programId: TOKEN_PROGRAM_ADDRESS, uiTokenAmount: { amount: "1000000", decimals: 6 } },
        { accountIndex: 2, mint: NOS_MINT, owner: funder, programId: TOKEN_PROGRAM_ADDRESS, uiTokenAmount: { amount: "10000000", decimals: 6 } },
      ], postTokenBalances: [
        { accountIndex: 1, mint: NOS_MINT, owner: source, programId: TOKEN_PROGRAM_ADDRESS, uiTokenAmount: { amount: "3500000", decimals: 6 } },
        { accountIndex: 2, mint: NOS_MINT, owner: funder, programId: TOKEN_PROGRAM_ADDRESS, uiTokenAmount: { amount: "7500000", decimals: 6 } },
      ] } };
    const fetchOnlyGenerated: typeof fetch = async (_url, options) => {
      assert.equal(options?.method, "POST"); assert.equal(typeof options?.body, "string");
      const request = JSON.parse(options!.body as string) as { id: unknown; method: string; params: unknown[] };
      assert(["getGenesisHash", "getTransaction"].includes(request.method), "Unexpected RPC method in isolated receipt verification");
      const current = marker(); updateMarker({ rpcCalls: current.rpcCalls + 1, rpcMethods: [...current.rpcMethods, request.method] });
      if (request.method === "getTransaction") assert.deepEqual(request.params, [signature, { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: request.method === "getGenesisHash" ? MAINNET_GENESIS_HASH : receipt }),
        { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const rpc = createSolanaRpc({ fetch: fetchOnlyGenerated });
    driver = createTreasuryClaimDriver({ rpc, state,
      vault: { save: unexpected, read: unexpected, forget: unexpected, close() {} },
      observations: { read: unexpected } as unknown as ReturnType<typeof import("../src/backend/observations.ts").createObservationStore>,
      contexts: () => [context], connect: async () => unexpected(), now });
  } else {
    const { claimResponse } = await import("/app/src/backend/rewards-claimer.ts" as string) as typeof import("../src/backend/rewards-claimer.ts");
    driver = {
      async prepare(fleet, sourceAddress) {
        if (!seed) return unexpected();
        return { scopeId: fleet.scopeId, rosterRevision: fleet.rosterRevision, sourceAddress,
          sourceBinding: { pcId: "a".repeat(64), nodeId: "b".repeat(64), containerId: "c".repeat(64), sshIdentity: `SHA256:${"d".repeat(43)}` },
          sourceTokenAddress: account, mintAddress: NOS_MINT, decimals: 6, lastReportedAmountBaseUnits: correctAmount, checkedAtMs: now(), expiresAtMs: now() + 60_000 };
      }, assertReady() { if (!seed) unexpected(); },
      async dispatch(_quote, authorize) {
        if (!seed) return unexpected(); authorize(); assert.equal(marker().helperCalls, 0); updateMarker({ helperCalls: 1 });
        // Exercise the actual old decoder without invoking its signing helper or
        // HTTPS transport. These are generated atomic units, not a live amount.
        const response = claimResponse(JSON.stringify({ success: true, claimableAmount: 2_500_000, transactionSignature: signature })) as unknown as Record<string, unknown>;
        assert.equal(response.amountUnit, undefined); assert.equal(response.claimedAmountAtoms, legacyAmount);
        return { status: "acknowledged", success: true, claimedAmountAtoms: legacyAmount, signature, observedAtMs: now() };
      },
      async reconcile() { if (!seed) return unexpected(); return { status: "uncertain", observedAtMs: now() }; },
    };
  }
  const beforeOldRead = input.mode === "reject-old" ? ledgerDigest() : undefined;
  const beforeMarker = seed ? undefined : markerHash();
  try {
    engine = createTreasuryClaims(state, { serverId, vault, driver, now,
      initialize: initializeClaimsMarker("/fixture/credentials", serverId, vault.keyId, state.get(TREASURY_CLAIMS_LEDGER_KEY) !== undefined),
      authorizeOperation() { return { context, deviceId: "generated-browser", authorizationId: "generated-unlock", configurationRevision: 1, guard() {}, touch() {} }; } });
    const originalMarkerHash = markerHash();
    if (!seed) { assert.equal(originalMarkerHash, beforeMarker); assert.equal(originalMarkerHash, marker().markerDigest); }
    if (seed) {
      const plan = await engine.dispatch({ operation: "claims-prepare", sourceAddress: source }) as { planId: string; reviewDigest: string };
      const confirmed = await engine.dispatch({ operation: "claims-confirm", planId: plan.planId, reviewDigest: plan.reviewDigest, idempotencyKey: "generated-legacy-unit-request" }) as { operation: { id: string } };
      await engine.waitForIdle();
      const index = state.get<{ entries: unknown[]; unresolvedId: string | null }>(TREASURY_CLAIMS_LEDGER_KEY)!;
      const operations = await engine.dispatch({ operation: "claims-operations" }) as { operations: { phase: string; paidAmountBaseUnits: string; signature: string }[]; total: number };
      assert.equal(operations.total, 1); assert.equal(operations.operations[0]?.phase, "verifying");
      assert.equal(operations.operations[0]?.paidAmountBaseUnits, legacyAmount); assert.equal(operations.operations[0]?.signature, signature);
      assert.equal(index.unresolvedId, confirmed.operation.id); assert.equal(marker().helperCalls, 1); assert.equal(marker().rpcCalls, 0);
      updateMarker({ operationId: confirmed.operation.id, entriesDigest: hash(JSON.stringify(index.entries)), markerDigest: originalMarkerHash });
      console.log(JSON.stringify({ stage: input.mode, legacyDecoderReproduced: true, phase: "verifying", helperCalls: 1, originalAmountBaseUnits: legacyAmount, lastReportedAmountBaseUnits: correctAmount }));
    } else if (input.mode === "reject-old") {
      const status = await engine.dispatch({ operation: "claims-status" }) as { state: string; supported: boolean; eligibleHosts: unknown[] };
      assert.equal(status.state, "recovery-required"); assert.equal(status.supported, false); assert.deepEqual(status.eligibleHosts, []);
      let rejected = false; try { await engine.dispatch({ operation: "claims-prepare", sourceAddress: source }); } catch { rejected = true; }
      assert.equal(rejected, true); await engine.reconcilePending();
      assert.equal(ledgerDigest(), beforeOldRead, "Old runtime changed the corrected ledger or allowance");
      console.log(JSON.stringify({ stage: input.mode, recoveryRequired: true, sameHostRearmDenied: true, ledgerUnchanged: true }));
    } else {
      const before = marker();
      if (input.mode === "correct-new") {
        assert.equal(before.rpcCalls, 0); await engine.reconcilePending(); await engine.waitForIdle();
      } else { await engine.reconcilePending(); await engine.waitForIdle(); }
      const index = state.get<{ version: number; entries: unknown[]; unresolvedId: string | null }>(TREASURY_CLAIMS_LEDGER_KEY)!;
      assert.equal(index.version, 1); assert.equal(index.unresolvedId, null); assert.equal(index.entries.length, 1);
      assert.equal(hash(JSON.stringify(index.entries)), before.entriesDigest);
      const encrypted = state.get<string>(`${TREASURY_CLAIMS_LEDGER_KEY}/operation/${before.operationId}`)!;
      const retained = vault.open<{ public: { id: string; phase: string; paidAmountBaseUnits: string; signature: string; slot: number; confirmedAtMs: number };
        dispatch: { amountUnit: string; claimedAmountAtoms: string; signature: string }; amountCorrection: Record<string, unknown> }>(encrypted, `${serverId}:claims-v1:${before.operationId}`);
      assert.equal(retained.public.id, before.operationId); assert.equal(retained.public.phase, "confirmed");
      assert.equal(retained.public.signature, signature); assert.equal(retained.dispatch.signature, signature);
      assert.equal(retained.public.paidAmountBaseUnits, correctAmount); assert.equal(retained.dispatch.claimedAmountAtoms, correctAmount); assert.equal(retained.dispatch.amountUnit, "base-units");
      assert.deepEqual(retained.amountCorrection, { version: 1, kind: "legacy-post-base-units", originalClaimedAmountAtoms: legacyAmount,
        correctedClaimedAmountAtoms: correctAmount, factor: "1000000", signature, verifiedSlot: retained.public.slot, verifiedAtMs: retained.public.confirmedAtMs });
      assert.equal(retained.public.slot, 424242); assert(!encrypted.includes("legacy-post-base-units"), "Correction audit must remain encrypted at rest");
      const status = await engine.dispatch({ operation: "claims-status" }) as { attemptedHosts: string[]; eligibleHosts: unknown[] };
      assert.deepEqual(status.attemptedHosts, [source]); assert.deepEqual(status.eligibleHosts, []);
      let denied = false; try { await engine.dispatch({ operation: "claims-prepare", sourceAddress: source }); } catch { denied = true; }
      assert(denied, "A corrected claim cannot regain an attempt");
      const counts = marker(); assert.equal(counts.helperCalls, 1); assert.equal(counts.sourceAccessCalls, 0);
      assert.equal(counts.rpcCalls, 2); assert.deepEqual(counts.rpcMethods, ["getGenesisHash", "getTransaction"]);
      if (input.mode === "correct-new") updateMarker({ correctionCiphertextDigest: hash(encrypted) });
      else { assert.equal(counts.rpcCalls, before.rpcCalls); assert.equal(hash(encrypted), before.correctionCiphertextDigest); }
      console.log(JSON.stringify({ stage: input.mode, phase: "confirmed", operationIdRetained: true, signatureRetained: true, sameHostSpent: true,
        indexEntriesPreserved: true, encryptedCorrectionAudit: true, paidAmountBaseUnits: correctAmount, helperCalls: counts.helperCalls,
        rpcCalls: counts.rpcCalls, rpcMethods: counts.rpcMethods, noRepeatAfterReopen: input.mode === "reopen-new" }));
    }
    assert.deepEqual(state.get("treasury.v1"), originalTransfer, "Original NOS transfer state changed");
    assert.equal(markerHash(), originalMarkerHash, "Claims initialization marker changed");
    assert.equal(marker().sourceAccessCalls, 0);
  } finally { await engine?.close(); await state.close(); vault.close(); }
}

export interface ClaimUnitsDockerOptions { oldImage: string; image: string; report?: string; instance?: string }
export function claimUnitsImageIdentity(value: unknown, old: boolean): string {
  const image = fixtureImageCapabilities(value);
  if (image.treasuryProtocol === 0 || old && (image.version !== "0.1.0-dev.20" || image.treasuryProtocol !== 1))
    throw new Error("Claim-unit acceptance requires old dev.20 protocol1 and a supported Wallet candidate.");
  return image.imageId;
}
export function claimUnitsDockerOptions(args: readonly string[]): ClaimUnitsDockerOptions {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!["--old-image", "--image", "--report", "--instance"].includes(key) || !value || values.has(key)) throw new Error("Use unique claim-unit fixture options.");
    values.set(key, value);
  }
  const oldImage = values.get("--old-image"), image = values.get("--image");
  if (!oldImage || !image || ![oldImage, image].every(value => value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9_./:@-]*$/.test(value)))
    throw new Error("Supply the old dev.20 image and the new candidate image explicitly.");
  const instance = values.get("--instance");
  if (instance !== undefined && !/^fixture-[a-f0-9]{12}$/.test(instance)) throw new Error("Use an isolated fixture instance with twelve hexadecimal digits.");
  return { oldImage, image, ...(values.has("--report") ? { report: values.get("--report")! } : {}), ...(instance ? { instance } : {}) };
}
export async function runClaimUnitsDocker(options: ClaimUnitsDockerOptions, runner: DockerRunner = localDockerRunner()): Promise<void> {
  const reportPath = options.report === undefined ? undefined : resolve(options.report);
  if (reportPath) {
    if (existsSync(reportPath)) throw new Error("Use a new external report; existing evidence is never overwritten.");
    const project = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
    let ancestor = dirname(reportPath); while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    if (!statSync(ancestor).isDirectory()) throw new Error("The report requires an ordinary parent directory.");
    const actual = resolve(realpathSync(ancestor), relative(ancestor, reportPath));
    if (actual === project || actual.startsWith(project + sep)) throw new Error("Keep private acceptance evidence outside the checkout.");
  }
  const identify = (reference: string, old: boolean): string => {
    return claimUnitsImageIdentity(JSON.parse(checked(runner, ["image", "inspect", reference])), old);
  };
  const oldImage = identify(options.oldImage, true), image = identify(options.image, false);
  if (oldImage === image) throw new Error("The old and corrected fixture images must differ.");
  const instance = options.instance ?? `fixture-${randomBytes(6).toString("hex")}`;
  if (!/^fixture-[a-f0-9]{12}$/.test(instance)) throw new Error("Use an isolated fixture instance with twelve hexadecimal digits.");
  const name = resourceName(instance, "claim-units"), volume = resourceName(instance, "claim-units");
  if (inspectOwned(runner, "container", name, instance) || inspectOwned(runner, "volume", volume, instance)) throw new Error("Fixture resources already exist.");
  const evidence: Record<string, unknown> = { fixture: "claims-legacy-unit-correction-v1", instance, oldImageId: oldImage, candidateImageId: image,
    network: "none", readOnlyRoot: true, liveApiRequests: 0, sourceWalletKeyReads: 0, signingOperations: 0, stages: [] };
  let created = false, failure: unknown;
  const cleanupErrors: string[] = [];
  try {
    ensureVolume(runner, volume, instance); created = true;
    checked(runner, ["run", "--rm", ...labels(instance), ...restrictions, "--network", "none", "--user", "0:0", "--cap-add", "CHOWN", "--cap-add", "FOWNER",
      ...mount(volume, "/fixture"), image, "node", "-e", 'const fs=require("node:fs");if(fs.readdirSync("/fixture").length)throw Error("Fixture volume is not empty");fs.chownSync("/fixture",1000,1000);fs.chmodSync("/fixture",0o700);']);
    for (const mode of ["seed-old", "correct-new", "reject-old", "reopen-new"] as const) {
      const selected = mode === "seed-old" || mode === "reject-old" ? oldImage : image;
      checked(runner, ["create", "--name", name, ...labels(instance), ...restrictions, "--network", "none", "--user", "1000:1000", ...mount(volume, "/fixture"),
        selected, "node", "--input-type=module", "-e", `(${fixtureRuntime.toString()})(JSON.parse(process.argv[1])).catch(error=>{console.error(error instanceof Error?error.message:"Isolated claim-unit fixture failed.");process.exitCode=1;});`, JSON.stringify({ instance, mode })]);
      const container = inspectOwned(runner, "container", name, instance)!;
      const host = container.HostConfig as { NetworkMode: string; ReadonlyRootfs: boolean; Privileged: boolean };
      assert.equal(container.Image, selected); assert.equal(host.NetworkMode, "none"); assert.equal(host.ReadonlyRootfs, true); assert.equal(host.Privileged, false);
      const mounts = container.Mounts as { Type: string; Name: string; Destination: string }[];
      assert.equal(mounts.length, 1); assert.equal(mounts[0]?.Type, "volume"); assert.equal(mounts[0]?.Name, volume); assert.equal(mounts[0]?.Destination, "/fixture");
      const result = runner.run(["start", "--attach", name]);
      const stopped = inspectOwned(runner, "container", name, instance)!.State as { ExitCode: number; OOMKilled: boolean; Running: boolean };
      if (result.status !== 0 || stopped.ExitCode !== 0 || stopped.Running || stopped.OOMKilled) throw new Error(`Claim-unit fixture ${mode} failed: ${result.stderr.slice(-2500)} ${result.stdout.slice(-2500)}`);
      const records = result.stdout.split(/\r?\n/).filter(line => line.startsWith("{")).map(line => JSON.parse(line));
      assert.equal(records.length, 1); assert.equal(records[0].stage, mode); (evidence.stages as unknown[]).push(records[0]);
      checked(runner, ["rm", name]);
    }
    evidence.passed = true;
  } catch (error) { failure = error; evidence.passed = false; evidence.failure = error instanceof Error ? error.message : "Claim-unit fixture failed."; }
  finally {
    try { if (inspectOwned(runner, "container", name, instance)) { checked(runner, ["stop", "--time", "10", name]); checked(runner, ["rm", name]); } }
    catch (error) { cleanupErrors.push(error instanceof Error ? error.message : "Container cleanup failed."); }
    if (created) try { if (inspectOwned(runner, "volume", volume, instance)) checked(runner, ["volume", "rm", volume]); }
    catch (error) { cleanupErrors.push(error instanceof Error ? error.message : "Volume cleanup failed."); }
  }
  evidence.cleanupErrors = cleanupErrors; evidence.completedAt = new Date().toISOString();
  if (reportPath) { mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 }); writeFileSync(reportPath, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600, flag: "wx" }); }
  if (failure) throw failure;
  if (cleanupErrors.length) throw new Error("Claim-unit regression passed but isolated cleanup needs review.");
  console.log(JSON.stringify({ passed: true, instance, stages: 4, syntheticDispatchCalls: 1, generatedRpcCalls: 2, sourceWalletKeyReads: 0, liveApiRequests: 0 }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runClaimUnitsDocker(claimUnitsDockerOptions(process.argv.slice(2)));
