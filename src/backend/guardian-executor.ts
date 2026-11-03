import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { cleanNodeRuntime, verifyNode } from "./pc-rewards.ts";
import { shellQuote } from "./ssh.ts";
import type { SshRun } from "./ssh.ts";
import type { GuardianExecutor } from "./source-guardian.ts";
import { rewardsClaimerSource } from "./rewards-claimer.ts";
import { parseDispatch } from "./treasury-claims.ts";
import type { TreasuryQuote } from "./treasury.ts";

const CLEAN = ["LD_PRELOAD", "LD_AUDIT", "LD_LIBRARY_PATH", "GLIBC_TUNABLES", "LD_DEBUG", "LD_DEBUG_OUTPUT", "LD_PROFILE", "LD_PROFILE_OUTPUT", "LD_ORIGIN_PATH", "GCONV_PATH", "LOCPATH", "NLSPATH"]
  .map(name => ` --env ${name}=`).join("") + " --env LANG=C --env LC_ALL=C";
export const guardianLocalRun: SshRun = (command, settings = {}) => new Promise((resolve, reject) => {
  // All commands originate in this module or the fixed public identity reader.
  // No signed request can supply executable text, paths or Docker arguments.
  if (!command.startsWith("/usr/bin/docker ")) { reject(new Error("Unsupported source runtime.")); return; }
  const child = spawn("/bin/sh", ["-c", command.replace(/^\/usr\/bin\/docker /, "/usr/local/bin/docker ")],
    { stdio: ["ignore", "pipe", "ignore"], env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C" } });
  const chunks: Buffer[] = []; let size = 0, finished = false;
  const timer = setTimeout(() => { child.kill("SIGKILL"); if (!finished) { finished = true; reject(new Error("Source operation deadline.")); } }, settings.timeoutMs ?? 8000);
  child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > (settings.maximum ?? 4096)) { child.kill("SIGKILL"); return; } chunks.push(chunk); });
  child.once("error", () => { clearTimeout(timer); if (!finished) { finished = true; reject(new Error("Source operation unavailable.")); } });
  child.once("close", code => { clearTimeout(timer); if (!finished) { finished = true; resolve({ code: size > (settings.maximum ?? 4096) ? 1 : code ?? 1, stdout: size > (settings.maximum ?? 4096) ? "" : Buffer.concat(chunks).toString("utf8") }); } });
});
function messageInput(quote: TreasuryQuote) {
  const { sourceAddress, destinationAddress, sourceTokenAddress, destinationTokenAddress, mintAddress, amountBaseUnits, decimals, createDestinationAta, blockhash, lastValidBlockHeight, messageBase64 } = quote;
  return { sourceAddress, destinationAddress, sourceTokenAddress, destinationTokenAddress, mintAddress, amountBaseUnits, decimals, createDestinationAta, blockhash, lastValidBlockHeight, messageBase64 };
}
export function createGuardianExecutor(run: SshRun = guardianLocalRun): GuardianExecutor {
  return {
    async transfer(source, quote, authorize) {
      const guarded: SshRun = (command, settings) => { authorize(); return run(command, { ...settings, timeoutMs: settings?.timeoutMs ?? 4000 }); };
      if (await verifyNode(guarded, source) !== "ok") throw new Error("Source identity changed.");
      const helper = readFileSync(new URL("../../dist/backend/treasury-signer.cjs", import.meta.url), "utf8");
      if (!helper.length || Buffer.byteLength(helper) > 120_000) throw new Error("Invalid signer bundle.");
      const prelude = 'ulimit -S -c 0 && ulimit -H -c 0 && printf 0 > /proc/self/coredump_filter && exec /usr/local/bin/node -e "$1" -- --gridlens-one-nos-transfer "$2"';
      const result = await guarded(`${cleanNodeRuntime(source)} exec${CLEAN} ${source.binding.nodeContainerId} /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C /bin/sh -c ${shellQuote(prelude)} gridlens-one-nos-transfer ${shellQuote(helper)} ${shellQuote(JSON.stringify(messageInput(quote)))}`, { maximum: 4096, timeoutMs: 10_000 });
      if (result.code !== 0) throw new Error("Signing unavailable.");
      const value: unknown = JSON.parse(result.stdout);
      if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "signature,transactionBase64"
        || typeof (value as { signature?: unknown }).signature !== "string" || typeof (value as { transactionBase64?: unknown }).transactionBase64 !== "string") throw new Error("Invalid signer reply.");
      return value as { signature: string; transactionBase64: string };
    },
    async claim(source, _quote, authorize) {
      const guarded: SshRun = (command, settings) => { authorize(); return run(command, { ...settings, timeoutMs: settings?.timeoutMs ?? 4000 }); };
      if (await verifyNode(guarded, source) !== "ok") throw new Error("Source identity changed.");
      const helper = rewardsClaimerSource();
      const prelude = 'ulimit -S -c 0 && ulimit -H -c 0 && printf 0 > /proc/self/coredump_filter && exec /usr/local/bin/node -e "$1" -- --gridlens-approved-uptime-claim "$2"';
      const result = await guarded(`${cleanNodeRuntime(source)} exec${CLEAN} ${source.binding.nodeContainerId} /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C /bin/sh -c ${shellQuote(prelude)} gridlens-approved-uptime-claim ${shellQuote(helper)} ${source.address}`, { maximum: 2048, timeoutMs: 65_000 });
      if (result.code !== 0) throw new Error("Claim reply unavailable.");
      const raw = JSON.parse(result.stdout) as Record<string, unknown>;
      if (raw.schema !== 2 || raw.address !== source.address || raw.success !== (raw.status === "acknowledged" ? true : raw.status === "rejected" ? false : null)) throw new Error("Invalid claim reply.");
      const { schema: _schema, address: _address, ...value } = raw;
      return parseDispatch(value);
    },
  };
}
