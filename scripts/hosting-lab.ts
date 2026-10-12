import { closeFleetServer, startFleetServer } from "../src/server/application.ts";
import { createIntegration } from "./local-integration.ts";

const portText = process.env.GRIDLENS_LAB_PORT ?? "4175";
if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
  throw new Error("GRIDLENS_LAB_PORT must be a valid port.");
}
const integration = await createIntegration();
try {
  const server = await startFleetServer({ host: "127.0.0.1", port: Number(portText), integration });
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void closeFleetServer(server, integration).catch(() => { process.exitCode = 1; });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  console.log(`Isolated hosting simulation: http://127.0.0.1:${portText}/ (synthetic data; no provider calls)`);
} catch (error) { await integration.close?.(); throw error; }
