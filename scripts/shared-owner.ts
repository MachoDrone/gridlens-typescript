import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openSharedState } from "../src/backend/sqlite-state.ts";
import { createSharedCollector } from "../src/backend/collector.ts";
import { createSharedService } from "../src/backend/service.ts";
import { startOwnerSocket } from "../src/backend/ipc.ts";
import { openCredentialVault } from "../src/backend/credential-vault.ts";
import { createPcMonitor } from "../src/backend/pc-monitor.ts";
import type { Server } from "node:http";

export async function startSharedOwner(environment: Readonly<Record<string, string | undefined>> = process.env) {
  const state = openSharedState(environment.GRIDLENS_STATE_DIR ?? "/state", { ledgerDirectory: environment.GRIDLENS_LEDGER_DIR ?? "/ledger" });
  let vault: ReturnType<typeof openCredentialVault> | undefined;
  let collector: ReturnType<typeof createSharedCollector> | undefined;
  let monitor: ReturnType<typeof createPcMonitor> | undefined;
  const sockets: Server[] = [];
  let stopping: Promise<void> | undefined;
  const close = (): Promise<void> => stopping ??= (async () => {
    // Stop admission before closing the ledger; cleanup preserves the original startup error.
    await Promise.allSettled([collector?.stop(), monitor?.stop()]);
    await Promise.all(sockets.map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
    try { await state.close(); } finally { vault?.close(); }
  })();
  try {
    vault = openCredentialVault(environment.GRIDLENS_CREDENTIAL_DIR ?? "/credentials");
    const service = createSharedService(state, { vault, requestHistory: (...args) => collector!.requestHistory(...args),
      providerWaits: () => [...collector!.providerWaits(), ...monitor!.providerWaits()] });
    collector = createSharedCollector({ state, contexts: service.access.contexts,
      onError: () => console.error("A shared collection cycle could not complete; dated cache retained.") });
    monitor = createPcMonitor({ state, vault, observations: service.observations, contexts: service.access.contexts });
    sockets.push(await startOwnerSocket(join(environment.GRIDLENS_SOCKET_DIR ?? "/ipc", "read.sock"), service.read));
    sockets.push(await startOwnerSocket(join(environment.GRIDLENS_CONTROL_DIR ?? "/control", "control.sock"), service.control));
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
