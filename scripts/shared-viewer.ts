import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseViewerConfiguration } from "../src/backend/viewer-client.ts";
import { startViewerGateway } from "../src/backend/viewer-gateway.ts";
import { closeFleetServer } from "../src/server/application.ts";

export function readViewerConfiguration(path = "/viewer/client.json") {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 1 || stat.size > 32 * 1024 || (stat.mode & 0o077) !== 0) throw new Error("Invalid private viewer configuration.");
    return parseViewerConfiguration(JSON.parse(readFileSync(descriptor, "utf8")));
  } finally { closeSync(descriptor); }
}
/** The shared image's financial role is explicitly disabled for this runtime.
 * No other owner, socket or trust-override environment is admitted. */
export function validateViewerEnvironment(environment: NodeJS.ProcessEnv): void {
  if (environment.GRIDLENS_TREASURY_PROTOCOL !== "0" || Object.keys(environment).some(name => name !== "GRIDLENS_TREASURY_PROTOCOL"
    && /^(?:GRIDLENS_(?:SOCKET|TREASURY|OWNER|UPDATES|VPN_AUTH)|NODE_EXTRA_CA_CERTS)/.test(name))) throw new Error("Viewer financial authority must remain disabled.");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    validateViewerEnvironment(process.env);
    if (process.env.GRIDLENS_VIEWER_CONFIG !== "/viewer/client.json" || !process.env.GRIDLENS_PUBLIC_ORIGIN) throw new Error("Missing viewer configuration.");
    const { server, integration } = await startViewerGateway({ configuration: readViewerConfiguration(), publicOrigin: process.env.GRIDLENS_PUBLIC_ORIGIN,
      directory: resolve("dist"), host: process.env.GRIDLENS_HOST ?? "0.0.0.0", port: Number(process.env.GRIDLENS_PORT ?? 8080) });
    const stop = () => { void closeFleetServer(server, integration).catch(() => { process.exitCode = 1; }); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    console.log("GridLens read-only viewer gateway ready.");
  } catch { console.error("Viewer gateway could not start. Verify its saved owner identity, viewer access and private endpoint."); process.exitCode = 1; }
}
