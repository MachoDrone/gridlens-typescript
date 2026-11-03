import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { openSharedState } from "../src/backend/sqlite-state.ts";
import { createSharedCollector } from "../src/backend/collector.ts";
import { createSharedService } from "../src/backend/service.ts";
import { startOwnerSocket, ownerCall } from "../src/backend/ipc.ts";
import { readInstalledBuild } from "../src/backend/build.ts";
import { openCredentialVault } from "../src/backend/credential-vault.ts";
import { createPcMonitor } from "../src/backend/pc-monitor.ts";
import type { Server } from "node:http";
import { createSolanaRpc } from "./solana-rpc.ts";
import { createProviderCheckpoint } from "./provider-checkpoint.ts";
import { openTreasuryVault } from "../src/backend/treasury-vault.ts";
import { TREASURY_LEDGER_KEY } from "../src/backend/treasury.ts";
import { createTreasuryTransferDriver } from "../src/backend/treasury-transfer.ts";
import { createTreasuryClaimDriver } from "../src/backend/treasury-claim-driver.ts";
import { TREASURY_CLAIMS_LEDGER_KEY } from "../src/backend/treasury-claims.ts";
import { claimsMarkerPresent, initializeClaimsMarker } from "../src/backend/treasury-claims-marker.ts";
import { createGuardianAdministration, OWNER_AUTHORITY_LEDGER_KEY } from "../src/backend/guardian-administration.ts";
import type { GuardianAdministration } from "../src/backend/guardian-administration.ts";

export async function startSharedOwner(environment: Readonly<Record<string, string | undefined>> = process.env) {
  const state = openSharedState(environment.GRIDLENS_STATE_DIR ?? "/state", { ledgerDirectory: environment.GRIDLENS_LEDGER_DIR ?? "/ledger" });
  let vault: ReturnType<typeof openCredentialVault> | undefined;
  let treasuryVault: ReturnType<typeof openTreasuryVault> | undefined;
  let reconciliation: ReturnType<typeof setInterval> | undefined;
  let collector: ReturnType<typeof createSharedCollector> | undefined;
  let monitor: ReturnType<typeof createPcMonitor> | undefined;
  let service: ReturnType<typeof createSharedService> | undefined;
  let guardians: GuardianAdministration | undefined;
  const sockets: Server[] = [];
  let stopping: Promise<void> | undefined;
  const close = (): Promise<void> => stopping ??= (async () => {
    // Stop admission before closing the ledger; cleanup preserves the original startup error.
    clearInterval(reconciliation);
    await Promise.allSettled([collector?.stop(), monitor?.stop(), service?.setup.close(), service?.wallet?.close(), service?.claims?.close(), guardians?.close()]);
    await Promise.all(sockets.map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
    try { await state.close(); } finally { vault?.close(); treasuryVault?.close(); }
  })();
  try {
    const updateSocket = environment.GRIDLENS_UPDATE_SOCKET;
    const treasurySocket = environment.GRIDLENS_TREASURY_SOCKET;
    const protocol = environment.GRIDLENS_TREASURY_PROTOCOL ?? (treasurySocket ? "1" : "0"), floor = environment.GRIDLENS_FINANCIAL_SECURITY_FLOOR ?? "0";
    if (!["0", "1", "2"].includes(protocol) || !["0", "2"].includes(floor) || floor === "2" && protocol === "1") throw new Error("Invalid financial security protocol.");
    const protectedMode = protocol === "2" || floor === "2";
    if (treasurySocket !== undefined && treasurySocket !== "/treasury/treasury.sock") throw new Error("Use the owned Wallet socket.");
    if (updateSocket !== undefined && updateSocket !== "/updates/updater.sock") throw new Error("Use the owned updater socket.");
    const build = readInstalledBuild("/app/build.json", updateSocket !== undefined || protectedMode && treasurySocket !== undefined);
    vault = openCredentialVault(environment.GRIDLENS_CREDENTIAL_DIR ?? "/credentials");
    if (treasurySocket) {
      try { treasuryVault = openTreasuryVault(environment.GRIDLENS_CREDENTIAL_DIR ?? "/credentials", {
        create: state.get(TREASURY_LEDGER_KEY) === undefined && state.get(TREASURY_CLAIMS_LEDGER_KEY) === undefined
          && state.get(OWNER_AUTHORITY_LEDGER_KEY) === undefined
          && !existsSync(join(environment.GRIDLENS_CREDENTIAL_DIR ?? "/credentials", "owner-authority-v1.marker"))
          && !existsSync(join(environment.GRIDLENS_CREDENTIAL_DIR ?? "/credentials", "owner-authority-v1.pem"))
          && !claimsMarkerPresent(environment.GRIDLENS_CREDENTIAL_DIR ?? "/credentials") }); }
      catch { console.error("Wallet is locked because its retained encryption state needs recovery. Fleet monitoring remains available."); }
    }
    const rpc = createSolanaRpc({ checkpoint: createProviderCheckpoint(state, "rpc") });
    service = createSharedService(state, { vault, requestHistory: (...args) => collector!.requestHistory(...args),
      protectedMode,
      providerWaits: () => [...collector!.providerWaits(), ...monitor!.providerWaits()], ...(build ? { build } : {}),
      treasuryUnavailable: treasurySocket !== undefined && treasuryVault === undefined,
      ...(treasuryVault ? { treasury: { vault: treasuryVault,
        ...(protectedMode ? { guardians: (access, observations) => guardians = createGuardianAdministration({ state, vault: vault!, observations, contexts: access.contexts,
          credentialsDirectory: environment.GRIDLENS_CREDENTIAL_DIR ?? "/credentials", cacheDirectory: environment.GRIDLENS_GUARDIAN_CACHE_DIR ?? "/guardian-cache",
          trustPublicKey: readFileSync("/app/update-public-key.pem", "utf8"), build: build! }) } : {}),
        driver: (access, observations) => createTreasuryTransferDriver({
        state, rpc, vault: vault!, observations, contexts: access.contexts, securityMode: protectedMode ? "owner-bound" : "legacy", ...(guardians ? { guardian: guardians.transport } : {}) }), claims: {
          initialize: serverId => initializeClaimsMarker(environment.GRIDLENS_CREDENTIAL_DIR ?? "/credentials", serverId,
            treasuryVault!.keyId, state.get(TREASURY_CLAIMS_LEDGER_KEY) !== undefined),
          driver: (access, observations) => createTreasuryClaimDriver({ state, rpc, vault: vault!, observations, contexts: access.contexts,
            securityMode: protectedMode ? "owner-bound" : "legacy", ...(guardians ? { guardian: guardians.transport } : {}) }),
        } } } : {}),
      ...(updateSocket ? { updates: (body: Record<string, unknown>) => ownerCall(updateSocket, body, undefined, 10_000) } : {}) });
    collector = createSharedCollector({ state, contexts: service.access.contexts, rpc,
      onError: () => console.error("A shared collection cycle could not complete; dated cache retained.") });
    monitor = createPcMonitor({ state, vault, observations: service.observations, contexts: service.access.contexts });
    sockets.push(await startOwnerSocket(join(environment.GRIDLENS_SOCKET_DIR ?? "/ipc", "read.sock"), service.read));
    sockets.push(await startOwnerSocket(join(environment.GRIDLENS_CONTROL_DIR ?? "/control", "control.sock"), service.control));
    if (treasurySocket) sockets.push(await startOwnerSocket(treasurySocket, service.treasury));
    const reconcile = () => {
      void service?.wallet?.reconcilePending().catch(() => { console.error("Wallet receipt is not yet verified; no transfer was repeated."); });
      void service?.claims?.reconcilePending().catch(() => { console.error("Rewards receipt is not yet verified; no claim was repeated."); });
    };
    if (service.wallet) { reconcile(); reconciliation = setInterval(reconcile, 15_000); reconciliation.unref(); }
    collector.start(); monitor.start();
    return { close, service };
  } catch (error) { await close().catch(() => {}); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const owner = await startSharedOwner();
    process.once("SIGINT", () => { void owner.close().catch(() => { process.exitCode = 1; }); });
    process.once("SIGTERM", () => { void owner.close().catch(() => { process.exitCode = 1; }); });
    console.log("GridLens single collection owner ready.");
  } catch { console.error("Shared owner could not start. Preserve state and investigate the owner lock or configuration."); process.exitCode = 1; }
}
