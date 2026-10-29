import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startSharedGateway } from "../src/backend/gateway.ts";
import { closeFleetServer } from "../src/server/application.ts";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const publicOrigin = process.env.GRIDLENS_PUBLIC_ORIGIN;
    const transport = process.env.GRIDLENS_TRANSPORT ?? "https";
    const privateNetworkAuthFile = process.env.GRIDLENS_VPN_AUTH_FILE;
    if (!publicOrigin || transport !== "https" && transport !== "vpn-http") throw new Error("Set the canonical origin and supported transport.");
    if (privateNetworkAuthFile !== undefined && (transport !== "vpn-http" || privateNetworkAuthFile !== "/vpn-auth/browser.json"))
      throw new Error("Set the owned private-network grant path.");
    const { server, integration } = await startSharedGateway({ publicOrigin, transport,
      ...(privateNetworkAuthFile === undefined ? {} : { privateNetworkAuthFile }),
      socketPath: process.env.GRIDLENS_SOCKET ?? "/ipc/read.sock", certPath: process.env.GRIDLENS_TLS_CERT ?? "/tls/server.crt",
      keyPath: process.env.GRIDLENS_TLS_KEY ?? "/tls/server.key", directory: resolve("dist"),
      host: process.env.GRIDLENS_HOST ?? "0.0.0.0", port: Number(process.env.GRIDLENS_PORT ?? 8443) });
    const stop = () => { void closeFleetServer(server, integration).catch(() => { process.exitCode = 1; }); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    console.log(transport === "vpn-http" ? "GridLens shared gateway ready on the existing private network." : "GridLens shared HTTPS gateway ready.");
  } catch { console.error("Shared gateway could not start. Verify the selected transport, canonical origin, owner socket and HTTPS certificate when required."); process.exitCode = 1; }
}
