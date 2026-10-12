import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closeFleetServer, FleetConfigurationError, startFleetServer } from "../src/server/application.ts";
import type { FleetIntegration, FleetServerOptions } from "../src/server/application.ts";

export function hostedConfiguration(environment: Readonly<Record<string, string | undefined>>): {
  modulePath: string; server: Omit<FleetServerOptions, "integration">;
} {
  const modulePath = environment.GRIDLENS_INTEGRATION_MODULE;
  if (!modulePath || /[\u0000-\u001f\u007f]/.test(modulePath) || /^\w+:\/\//.test(modulePath)) {
    throw new FleetConfigurationError("Set GRIDLENS_INTEGRATION_MODULE to a trusted local integration module.");
  }
  const text = environment.GRIDLENS_PORT ?? "4173";
  if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 65535) {
    throw new FleetConfigurationError("GRIDLENS_PORT must be an integer between 1 and 65535.");
  }
  const host = environment.GRIDLENS_HOST ?? "127.0.0.1";
  const publicOrigin = environment.GRIDLENS_PUBLIC_ORIGIN;
  return { modulePath: resolve(modulePath), server: { host, port: Number(text),
    basePath: environment.GRIDLENS_BASE_PATH ?? "",
    ...(publicOrigin === undefined ? {} : { publicOrigin }) } };
}

export async function loadIntegration(modulePath: string): Promise<FleetIntegration> {
  // This path is operator configuration, never a query/header/user-supplied path.
  try {
    const module: unknown = await import(pathToFileURL(modulePath).href);
    if (!module || typeof module !== "object" || !("createIntegration" in module)
      || typeof module.createIntegration !== "function") throw new Error("Missing integration factory");
    const integration: unknown = await module.createIntegration();
    if (!integration || typeof integration !== "object" || !("resolveAccess" in integration)
      || typeof integration.resolveAccess !== "function" || !("source" in integration)
      || !integration.source || typeof integration.source !== "object" || !("read" in integration.source)
      || typeof integration.source.read !== "function") throw new Error("Invalid integration");
    return integration as FleetIntegration;
  } catch { throw new FleetConfigurationError("The trusted Fleet integration could not be initialized."); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let integration: FleetIntegration | undefined;
  try {
    const config = hostedConfiguration(process.env);
    integration = await loadIntegration(config.modulePath);
    const server = await startFleetServer({ ...config.server, integration });
    let stopping = false;
    const shutdown = (): void => {
      if (stopping) return;
      stopping = true;
      void closeFleetServer(server, integration!).catch(() => { process.exitCode = 1; });
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    console.log(`Fleet gateway listening on ${config.server.host}:${config.server.port}.`);
  } catch (error) {
    await integration?.close?.().catch(() => {});
    console.error(error instanceof FleetConfigurationError ? error.message : "The Fleet gateway could not start.");
    process.exitCode = 1;
  }
}
