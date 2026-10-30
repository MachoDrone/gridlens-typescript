import { readFile, mkdir, chmod, lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startOwnerSocket } from "../src/backend/ipc.ts";
import { createUpdateEngine } from "../src/updater/engine.ts";
import { openUpdateState } from "../src/updater/state.ts";
import { createUpdateRuntime } from "../src/updater/runtime.ts";
import type { UpdatePlatform } from "../src/updater/release.ts";

export async function startSharedUpdater(environment: Readonly<Record<string, string | undefined>> = process.env) {
  const instance = environment.GRIDLENS_UPDATER_INSTANCE;
  const directory = environment.GRIDLENS_UPDATER_STATE_DIR ?? "/update-state";
  const socket = environment.GRIDLENS_UPDATER_SOCKET ?? "/updates/updater.sock";
  const platform = environment.GRIDLENS_UPDATER_PLATFORM ?? `${process.platform}-${process.arch}`;
  const keyPath = environment.GRIDLENS_UPDATER_PUBLIC_KEY_FILE ?? "/app/update-public-key.pem";
  if (!instance || !/^[a-z][a-z0-9-]{0,31}$/.test(instance) || !["linux-x64", "linux-arm64"].includes(platform)
    || socket !== "/updates/updater.sock" || directory !== "/update-state" || keyPath !== "/app/update-public-key.pem") throw new Error("Invalid owned updater configuration.");
  const keyStat = await lstat(keyPath);
  if (!keyStat.isFile() || keyStat.size > 16_384) throw new Error("Invalid updater trust anchor.");
  const publicKey = await readFile(keyPath, "utf8");
  // Provisioned updater runs 0:1000; this IPC volume is shared only with owner
  // 1000:1000. The gateway never receives this volume or the Docker socket.
  await mkdir(dirname(socket), { recursive: true, mode: 0o750 });
  await chmod(dirname(socket), 0o750);
  const store = openUpdateState(directory), runtime = createUpdateRuntime({ instance, stateDirectory: directory });
  let engine: Awaited<ReturnType<typeof createUpdateEngine>> | undefined;
  try {
    engine = await createUpdateEngine({ store, runtime, directory, platform: platform as UpdatePlatform, publicKey });
    const server = await startOwnerSocket(socket, body => engine!.dispatch(body));
    // startOwnerSocket retains the restrictive socket mode; restore directory
    // traverse permission after its generic private-directory initialization.
    await chmod(dirname(socket), 0o750);
    let closing: Promise<void> | undefined;
    return { engine, close: () => closing ??= (async () => {
      await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
      await engine!.close();
    })() };
  } catch (error) { if (engine) await engine.close(); else { await runtime.release(); store.close(); } throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const updater = await startSharedUpdater();
    const stop = () => { void updater.close().catch(() => { process.exitCode = 1; }); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    console.log("GridLens updater ready.");
  } catch { console.error("GridLens updater could not start. Preserve the operation state for recovery."); process.exitCode = 1; }
}
