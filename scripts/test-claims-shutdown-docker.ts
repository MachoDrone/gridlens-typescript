/** Real SIGTERM/stop-grace acceptance with the actual claims engine and SQLite.
 * The injected driver waits for a synthetic ACK and has no network or node key. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { OWNER_STOP_GRACE_SECONDS } from "../src/installer/coordinator.ts";
import { checked, ensureVolume, inspectOwned, labels, localDockerRunner, mount, resourceName, restrictions, PRODUCT_LABEL, PRODUCT } from "../src/installer/docker.ts";

interface FixtureInput { instance: string; mode: "pending" | "idle" }
/** Serialized into node --input-type=module -e inside a new labeled fixture. */
async function fixtureRuntime(input: FixtureInput): Promise<void> {
  const { mkdirSync } = await import("node:fs");
  const { address } = await import("@solana/kit");
  const { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } = await import("@solana-program/token");
  const { openSharedState } = await import("/app/src/backend/sqlite-state.ts" as string) as typeof import("../src/backend/sqlite-state.ts");
  const { openTreasuryVault } = await import("/app/src/backend/treasury-vault.ts" as string) as typeof import("../src/backend/treasury-vault.ts");
  const { createTreasuryClaims, TREASURY_CLAIMS_LEDGER_KEY } = await import("/app/src/backend/treasury-claims.ts" as string) as typeof import("../src/backend/treasury-claims.ts");
  const { initializeClaimsMarker } = await import("/app/src/backend/treasury-claims-marker.ts" as string) as typeof import("../src/backend/treasury-claims-marker.ts");
  const { NOS_MINT } = await import("/app/src/fleet/nos.ts" as string) as typeof import("../src/fleet/nos.ts");
  if (!/^fixture-[a-f0-9]{12}$/.test(input.instance) || !["pending", "idle"].includes(input.mode)) throw new Error("Invalid isolated fixture selection.");
  mkdirSync("/fixture/credentials", { recursive: true, mode: 0o700 });
  const state = openSharedState("/fixture/state", { ledgerDirectory: "/fixture/ledger" });
  const vault = openTreasuryVault("/fixture/credentials", { create: input.mode === "pending" });
  const serverId = `generated-${input.instance}`, source = "1".repeat(31) + "2", signature = "2".repeat(88);
  const context = { scopeId: "fixture", rosterRevision: "generated-revision", addresses: [source] };
  const [account] = await findAssociatedTokenPda({ owner: address(source), mint: address(NOS_MINT), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const markerKey = "fixture/claims-shutdown-v1";
  const original = { consumed: true, operation: "original synthetic NOS receipt" };
  if (input.mode === "pending") {
    if (state.get(markerKey) !== undefined || state.get(TREASURY_CLAIMS_LEDGER_KEY) !== undefined) throw new Error("The fixture is not empty.");
    state.batch([[markerKey, { version: 1, instance: input.instance, helperCalls: 0 }], ["treasury.v1", original]]);
  }
  const marker = state.get<{ version: number; instance: string; helperCalls: number }>(markerKey);
  if (marker?.version !== 1 || marker.instance !== input.instance) throw new Error("Fixture ownership marker changed.");
  let closing = false, keepAlive: ReturnType<typeof setInterval> | undefined, acknowledge: (() => void) | undefined;
  const claims = createTreasuryClaims(state, { serverId, vault,
    initialize: initializeClaimsMarker("/fixture/credentials", serverId, vault.keyId, state.get(TREASURY_CLAIMS_LEDGER_KEY) !== undefined),
    authorizeOperation() { const guard = () => { if (closing) throw new Error("Generated owner locked."); };
      guard(); return { context, deviceId: "fixture-browser", authorizationId: "fixture-unlock", configurationRevision: 1, guard, touch: guard }; },
    driver: {
      async prepare(fleet, sourceAddress) { const now = Date.now(); return { scopeId: fleet.scopeId, rosterRevision: fleet.rosterRevision, sourceAddress,
        sourceBinding: { pcId: "a".repeat(64), nodeId: "b".repeat(64), containerId: "c".repeat(64), sshIdentity: `SHA256:${"d".repeat(43)}` },
        sourceTokenAddress: account, mintAddress: NOS_MINT, decimals: 6, lastReportedAmountBaseUnits: "2000000", checkedAtMs: now, expiresAtMs: now + 60_000 }; },
      assertReady() {},
      async dispatch(_quote, authorize) {
        authorize(); const current = state.get<typeof marker>(markerKey)!;
        if (current.helperCalls !== 0) throw new Error("Synthetic claim was dispatched more than once.");
        state.set(markerKey, { ...current, helperCalls: 1 });
        const pendingAck = new Promise<void>(done => { acknowledge = done; });
        console.log("CLAIM_HELPER_STARTED");
        // The parent sends SIGTERM only after this marker. Starting the delay
        // at that signal makes the old 30-second stop failure deterministic,
        // independent of log/SSH readiness latency. There is no HTTP request.
        await pendingAck;
        return { status: "acknowledged", success: true, claimedAmountAtoms: "2000000", signature, observedAtMs: Date.now() };
      },
      async reconcile(operation) { return { status: "confirmed", observedAtMs: Date.now(), slot: 42, paidAmountBaseUnits: operation.dispatch.claimedAmountAtoms!,
        payoutOwner: source, payoutTokenAddress: account, mintAddress: NOS_MINT }; },
    } });
  const proof = async () => {
    const result = await claims.dispatch({ operation: "claims-operations" }) as { operations: { phase: string; signature: string | null; paidAmountBaseUnits: string | null }[]; total: number };
    const current = state.get<typeof marker>(markerKey)!;
    if (JSON.stringify(state.get("treasury.v1")) !== JSON.stringify(original) || current.helperCalls !== 1 || result.total !== 1
      || result.operations[0]?.signature !== signature || result.operations[0]?.paidAmountBaseUnits !== "2000000") throw new Error("The captured acknowledgment or original receipt was not retained.");
    return { phase: result.operations[0].phase, helperCalls: current.helperCalls, signatureRetained: true, originalTransferPreserved: true };
  };
  let stopped: Promise<void> | undefined;
  const stop = () => stopped ??= (async () => {
    closing = true; clearInterval(keepAlive);
    if (acknowledge) setTimeout(acknowledge, 35_000);
    await claims.close(); await state.close(); vault.close(); process.exitCode = 0;
  })();
  process.once("SIGTERM", () => { void stop().catch(() => { process.exitCode = 1; }); });
  process.once("SIGINT", () => { void stop().catch(() => { process.exitCode = 1; }); });
  keepAlive = setInterval(() => {}, 1000);
  if (input.mode === "pending") {
    const plan = await claims.dispatch({ operation: "claims-prepare", sourceAddress: source }) as { planId: string; reviewDigest: string };
    await claims.dispatch({ operation: "claims-confirm", planId: plan.planId, reviewDigest: plan.reviewDigest, idempotencyKey: "generated-shutdown-request" });
  } else {
    const before = await proof(); if (before.phase !== "verifying") throw new Error("An interrupted acknowledgment was not journaled before exit.");
    await claims.reconcilePending(); const after = await proof(); if (after.phase !== "confirmed") throw new Error("The retained signature did not reconcile.");
    console.log(JSON.stringify({ event: "ACK_RECONCILED", ...after })); console.log("IDLE_OWNER_READY");
  }
}

export async function runClaimsShutdownDocker(image: string, report?: string): Promise<void> {
  if (!image || image.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9_./:@-]*$/.test(image)) throw new Error("Supply an explicit candidate Docker image.");
  const reportPath = report === undefined ? undefined : resolve(report);
  if (reportPath) {
    if (existsSync(reportPath)) throw new Error("Use a new external report; existing evidence is never overwritten.");
    const project = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
    let ancestor = dirname(reportPath);
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    if (!statSync(ancestor).isDirectory()) throw new Error("The report requires an ordinary parent directory.");
    const actual = resolve(realpathSync(ancestor), relative(ancestor, reportPath));
    if (actual === project || actual.startsWith(project + sep)) throw new Error("Keep private acceptance evidence outside the checkout.");
  }
  const runner = localDockerRunner(), instance = `fixture-${randomBytes(6).toString("hex")}`;
  const name = resourceName(instance, "owner"), volume = resourceName(instance, "claims-shutdown");
  const inspected = JSON.parse(checked(runner, ["image", "inspect", image]));
  if (inspected.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(inspected[0]?.Id) || inspected[0]?.Config?.Labels?.[PRODUCT_LABEL] !== PRODUCT)
    throw new Error("Use an immutable identified GridLens candidate image.");
  const imageId = inspected[0].Id as string;
  if (inspectOwned(runner, "container", name, instance) || inspectOwned(runner, "volume", volume, instance)) throw new Error("Fixture resources already exist.");
  let volumeCreated = false, failure: unknown;
  const evidence: Record<string, unknown> = { fixture: "claims-delayed-ack-shutdown-v1", instance, imageId, stopGraceSeconds: OWNER_STOP_GRACE_SECONDS,
    syntheticAckDelayAfterSignalSeconds: 35, network: "none", liveApiRequests: 0, existingWalletKeyAccess: false };
  const inspect = () => {
    const value = inspectOwned(runner, "container", name, instance); assert(value);
    const host = value.HostConfig as { NetworkMode: string; ReadonlyRootfs: boolean; Privileged: boolean };
    assert.equal(value.Image, imageId); assert.equal(host.NetworkMode, "none"); assert.equal(host.ReadonlyRootfs, true); assert.equal(host.Privileged, false);
    const mounts = value.Mounts as { Type: string; Name: string; Destination: string }[];
    assert.equal(mounts.length, 1); assert.equal(mounts[0]?.Type, "volume"); assert.equal(mounts[0]?.Name, volume); assert.equal(mounts[0]?.Destination, "/fixture");
    return value;
  };
  const waitFor = async (marker: string): Promise<string> => {
    for (let attempt = 0; attempt < 80; attempt++) {
      const value = inspect(), output = checked(runner, ["logs", name]);
      if (output.includes(marker)) return output;
      assert.equal((value.State as { Running: boolean }).Running, true, "Fixture owner exited before readiness");
      await new Promise<void>(done => setTimeout(done, 250));
    }
    throw new Error("Fixture owner readiness timed out.");
  };
  const start = (mode: FixtureInput["mode"]) => {
    checked(runner, ["run", "--detach", "--name", name, ...labels(instance), ...restrictions, "--network", "none", "--user", "1000:1000",
      ...mount(volume, "/fixture"), imageId, "node", "--input-type=module", "-e",
      `(${fixtureRuntime.toString()})(JSON.parse(process.argv[1])).catch(()=>{console.error("Isolated claim shutdown fixture failed.");process.exit(1);});`, JSON.stringify({ instance, mode })]);
  };
  try {
    ensureVolume(runner, volume, instance); volumeCreated = true;
    checked(runner, ["run", "--rm", ...labels(instance), ...restrictions, "--network", "none", "--user", "0:0", "--cap-add", "CHOWN", "--cap-add", "FOWNER",
      ...mount(volume, "/fixture"), imageId, "node", "-e", 'const fs=require("node:fs");if(fs.readdirSync("/fixture").length)throw Error("Fixture volume is not empty");fs.chownSync("/fixture",1000,1000);fs.chmodSync("/fixture",0o700);']);
    start("pending"); await waitFor("CLAIM_HELPER_STARTED");
    console.log("Synthetic claim is dispatched; verifying acknowledgment survives the owner stop grace.");
    const began = performance.now(); checked(runner, ["stop", "--time", String(OWNER_STOP_GRACE_SECONDS), name]);
    const elapsed = performance.now() - began, stopped = inspect().State as { ExitCode: number; OOMKilled: boolean; Running: boolean };
    assert.equal(stopped.ExitCode, 0, "Docker killed the owner before its bounded acknowledgment was saved"); assert.equal(stopped.Running, false); assert.equal(stopped.OOMKilled, false);
    assert(elapsed > 30_000 && elapsed < 90_000, "The delayed response must exercise the old 30-second stop failure");
    evidence.delayedStopMilliseconds = Math.round(elapsed); checked(runner, ["rm", name]);
    start("idle"); const log = await waitFor("IDLE_OWNER_READY");
    assert(log.includes('"event":"ACK_RECONCILED"')); evidence.acknowledgmentRetainedAndReconciled = true;
    const idleBegan = performance.now(); checked(runner, ["stop", "--time", String(OWNER_STOP_GRACE_SECONDS), name]);
    const idleElapsed = performance.now() - idleBegan; assert.equal((inspect().State as { ExitCode: number }).ExitCode, 0); assert(idleElapsed < 10_000);
    evidence.idleStopMilliseconds = Math.round(idleElapsed); evidence.singleSyntheticDispatch = true;
  } catch (error) { failure = error; }
  const cleanup: string[] = [];
  try { if (inspectOwned(runner, "container", name, instance)) { inspect(); checked(runner, ["stop", "--time", String(OWNER_STOP_GRACE_SECONDS), name]); checked(runner, ["rm", name]); } }
  catch { cleanup.push("Fixture container cleanup failed; inspect its exact labels before retrying."); }
  try { if (volumeCreated && inspectOwned(runner, "volume", volume, instance)) checked(runner, ["volume", "rm", volume]); }
  catch { cleanup.push("Fixture volume cleanup failed; preserve its journal for inspection."); }
  evidence.passed = !failure && cleanup.length === 0; evidence.cleanupErrors = cleanup;
  if (reportPath) {
    try { mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 }); writeFileSync(reportPath, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600, flag: "wx" }); }
    catch (error) { if (!failure) failure = error; }
  }
  if (failure) throw failure;
  if (cleanup.length) throw new Error(cleanup.join(" "));
  console.log(JSON.stringify(evidence));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), imageAt = args.indexOf("--image"), reportAt = args.indexOf("--report");
  if (imageAt < 0 || args.length !== (reportAt < 0 ? 2 : 4) || !args[imageAt + 1] || reportAt >= 0 && !args[reportAt + 1])
    throw new Error("Usage: node scripts/test-claims-shutdown-docker.ts --image CANDIDATE [--report PRIVATE_JSON]");
  await runClaimsShutdownDocker(args[imageAt + 1]!, reportAt < 0 ? undefined : args[reportAt + 1]);
}
