import type { PcAssociation } from "../contracts/shared.ts";
import { parseReward } from "../fleet/pc-observations.ts";
import type { RewardObservation } from "../fleet/pc-observations.ts";
import { nodeRuntime, shellQuote } from "./ssh.ts";
import type { SshRun } from "./ssh.ts";
import { rewardsReaderSource } from "./rewards-reader.ts";

const CLEAN = ["LD_PRELOAD", "LD_AUDIT", "LD_LIBRARY_PATH", "GLIBC_TUNABLES", "LD_DEBUG", "LD_DEBUG_OUTPUT", "LD_PROFILE", "LD_PROFILE_OUTPUT", "LD_ORIGIN_PATH", "GCONV_PATH", "LOCPATH", "NLSPATH"]
  .map(name => ` --env ${name}=`).join("") + " --env LANG=C --env LC_ALL=C";
export function cleanNodeRuntime(association: PcAssociation): string {
  // Validation also rejects shell syntax in every container identity/runtime.
  nodeRuntime(association.binding);
  return association.binding.wrapperId ? `/usr/bin/docker exec${CLEAN} ${association.binding.wrapperId} /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C /usr/bin/podman`
    : `/usr/bin/${association.binding.runtime}`;
}
const nodeImage = (value: string, repository: string) => new RegExp(`^(?:(?:docker\\.io|registry\\.hub\\.docker\\.com)/)?nosana/${repository}(?::[A-Za-z0-9_.-]+|@sha256:[a-f0-9]{64})?$`).test(value);
function identityReader(): void {
  const http = require("node:http") as typeof import("node:http");
  const timer = setTimeout(() => process.exit(1), 3000);
  const request = http.get({ host: "127.0.0.1", port: 5001, path: "/" }, response => {
    let body = "";
    response.on("data", chunk => { body += chunk; if (body.length > 256) process.exit(1); });
    response.on("end", () => { try { const value: unknown = JSON.parse(body); if (response.statusCode !== 200 || typeof value !== "string"
      || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) process.exit(1); process.stdout.write(value); clearTimeout(timer); } catch { process.exit(1); } });
  }); request.on("error", () => process.exit(1));
}
/** Exact running container/image and local public identity, before any signer is invoked. */
export async function verifyNode(run: SshRun, association: PcAssociation): Promise<"ok" | "unavailable" | "identity-mismatch"> {
  const runtime = cleanNodeRuntime(association), binding = association.binding;
  const inspect = async (command: string, id: string, repository: string) => {
    const value = await run(`${command} inspect --format '{{.Id}}\t{{.State.Running}}\t{{.Config.Image}}' ${id}`, { maximum: 1024 });
    const fields = value.stdout.trim().split("\t");
    return value.code === 0 && fields.length === 3 && fields[0] === id && fields[1] === "true" && nodeImage(fields[2]!, repository);
  };
  if (binding.wrapperId && !await inspect("/usr/bin/docker", binding.wrapperId, "podman")) return "unavailable";
  if (!await inspect(runtime, binding.nodeContainerId, "nosana-node")) return "unavailable";
  const identity = await run(`${runtime} exec${CLEAN} ${binding.nodeContainerId} /usr/bin/env -i /usr/local/bin/node -e ${shellQuote(`(${identityReader.toString()})()`)}`, { maximum: 256 });
  return identity.code !== 0 ? "unavailable" : identity.stdout.trim() === association.address ? "ok" : "identity-mismatch";
}
export async function readRewards(run: SshRun, association: PcAssociation, now = Date.now): Promise<RewardObservation> {
  const fail = (status: RewardObservation["status"]): RewardObservation => ({ schema: 1, address: association.address, observedAtMs: now(), status });
  const verified = await verifyNode(run, association);
  if (verified !== "ok") return fail(verified);
  const source = rewardsReaderSource();
  const prelude = 'ulimit -S -c 0 && ulimit -H -c 0 && printf 0 > /proc/self/coredump_filter && exec /usr/local/bin/node -e "$1" -- --gridlens-approved-rewards "$2"';
  const result = await run(`${cleanNodeRuntime(association)} exec${CLEAN} ${association.binding.nodeContainerId} /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C /bin/sh -c ${shellQuote(prelude)} gridlens-approved-rewards ${shellQuote(source)} ${association.address}`,
    { maximum: 1024, timeoutMs: 14000 });
  if (result.code !== 0) return fail("unavailable");
  let reward: RewardObservation;
  try { reward = parseReward(JSON.parse(result.stdout), association.address); } catch { return fail("unavailable"); }
  // A bad source clock cannot erase an actual denial or shorten its provider pause.
  if (reward.observedAtMs > now() + 15_000) return { ...fail(reward.status === "ok" ? "unavailable" : reward.status),
    ...(reward.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: reward.retryAfterSeconds }) };
  return reward;
}
