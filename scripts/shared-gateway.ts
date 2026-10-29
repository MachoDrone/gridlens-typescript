import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startSharedGateway } from "../src/backend/gateway.ts";
import { closeFleetServer } from "../src/server/application.ts";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const publicOrigin = process.env.GRIDLENS_PUBLIC_ORIGIN;
    if (!publicOrigin?.startsWith("https://")) throw new Error("Set the canonical HTTPS origin.");
    const { server, integration } = await startSharedGateway({ publicOrigin,
      socketPath: process.env.GRIDLENS_SOCKET ?? "/ipc/read.sock", certPath: process.env.GRIDLENS_TLS_CERT ?? "/tls/server.crt",
      keyPath: process.env.GRIDLENS_TLS_KEY ?? "/tls/server.key", directory: resolve("dist"),
      host: process.env.GRIDLENS_HOST ?? "0.0.0.0", port: Number(process.env.GRIDLENS_PORT ?? 8443) });
    const stop = () => { void closeFleetServer(server, integration).catch(() => { process.exitCode = 1; }); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    console.log("GridLens shared HTTPS gateway ready.");
  } catch { console.error("Shared HTTPS gateway could not start. Verify trusted certificate, origin and owner socket."); process.exitCode = 1; }
}
