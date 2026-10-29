import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ownerCall } from "../src/backend/ipc.ts";

export async function controlMain(args: string[], input: NodeJS.ReadableStream = process.stdin): Promise<unknown> {
  const [command, scopeId = "default", option] = args;
  let body: unknown;
  if (command === "json") {
    let text = "";
    for await (const chunk of input) { text += chunk; if (Buffer.byteLength(text) > 256 * 1024) throw new Error("Control input too large."); }
    body = JSON.parse(text);
  } else if (command === "status") body = { operation: "status" };
  else if (command === "create-fleet") body = { operation: "create-fleet", scopeId, addresses: [] };
  else if (command === "pair-code") body = { operation: "pair-code", scopeId, role: option ?? "viewer" };
  else if (command === "scan" && option) body = { operation: "setup-scan", scopeId, range: option };
  else if (command === "setup-status" || command === "setup-inspect") body = { operation: command, scopeId };
  else throw new Error("Usage: shared-control status | create-fleet SCOPE | pair-code SCOPE ROLE | scan SCOPE RANGE | setup-status SCOPE | setup-inspect SCOPE | json");
  return ownerCall(join(process.env.GRIDLENS_CONTROL_DIR ?? "/control", "control.sock"), body, undefined, 30 * 60_000);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await controlMain(process.argv.slice(2)))); }
  catch { console.error("Terminal control request failed. No credentials were logged; verify the owner and setup phase."); process.exitCode = 1; }
}
