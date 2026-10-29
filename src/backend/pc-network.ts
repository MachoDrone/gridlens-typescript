import type { SshRun, SshResult } from "./ssh.ts";
import { normalizedIp, privateIp, publicIp, parsePcNetwork } from "../fleet/pc-observations.ts";
import type { PcNetworkObservation, PublicNetworkFailure } from "../fleet/pc-observations.ts";

export const ipCommand = (family: 4 | 6): string => "if command -v curl >/dev/null 2>&1; then curl -q -" + family
  + " --silent --show-error --connect-timeout 10 --max-time 10 --max-filesize 128 --proto '=https' --max-redirs 0 --include https://"
  + (family === 4 ? "api.ipify.org" : "api6.ipify.org") + "; else exit 127; fi";
export function providerRetryDeadline(value: string | undefined, now: number): number {
  if (!value || value.length > 128) return 0;
  if (/^\d+$/.test(value)) return Math.min(8_640_000_000_000_000, now + Number(BigInt(value) > 2147483647n ? 2147483647n : BigInt(value)) * 1000);
  const date = Date.parse(value); return Number.isFinite(date) ? Math.max(now, date) : 0;
}
function http(result: SshResult): { status?: number; retry?: string; body: string } {
  let body = result.stdout.replaceAll("\r\n", "\n"), status: number | undefined, retry: string | undefined;
  while (body.startsWith("HTTP/")) {
    const end = body.indexOf("\n\n"); if (end < 0) return { body: "" };
    const lines = body.slice(0, end).split("\n"), match = /^HTTP\/(?:1\.[01]|2|3) ([1-5][0-9]{2})(?: .*)?$/.exec(lines[0]!);
    if (!match) return { body: "" }; status = Number(match[1]); retry = undefined;
    for (const line of lines.slice(1)) if (/^retry-after:/i.test(line)) retry = line.slice(line.indexOf(":") + 1).trim();
    body = body.slice(end + 2);
  }
  return { body, ...(status === undefined ? {} : { status }), ...(retry === undefined ? {} : { retry }) };
}
const failure = (code: number): PublicNetworkFailure => code === 127 ? "missing-curl" : [5, 6].includes(code) ? "dns"
  : code === 28 ? "timeout" : [35, 51, 58, 59, 60, 77, 80, 82, 83, 90, 91].includes(code) ? "tls"
  : [63, 23, 3].includes(code) ? "invalid-response" : "connection";

/** Read the approved PC's own interfaces and fixed egress service. No sudo or node exec. */
export async function readPcNetwork(run: SshRun, sshAddress: string, now = Date.now): Promise<PcNetworkObservation> {
  const network: PcNetworkObservation = { schema: 1, observedAtMs: now(), status: "unavailable", source: "pc-egress-ipify",
    publicIp: null, publicObservedAtMs: null, privateIp: null, privateObservedAtMs: null };
  try {
    const interfaces = await run("/bin/hostname -I", { maximum: 8192 });
    if (interfaces.code !== 0) network.privateFailure = "interface-read-failure";
    else {
      const addresses = interfaces.stdout.trim().split(/\s+/).map(normalizedIp).filter((value): value is string => value !== null && privateIp(value));
      network.privateIp = addresses.includes(sshAddress) ? sshAddress : addresses.find(value => !value.includes(":")) ?? addresses[0] ?? null;
      if (network.privateIp) network.privateObservedAtMs = now();
    }
  } catch { network.privateFailure = "interface-read-failure"; }
  try {
    let family: 4 | 6 = 4, result = await run(ipCommand(family), { maximum: 16384, timeoutMs: 11000 }), parsed = http(result);
    if (parsed.status === undefined && [5, 6, 7, 28].includes(result.code)) {
      family = 6; result = await run(ipCommand(family), { maximum: 16384, timeoutMs: 11000 }); parsed = http(result);
    }
    const until = providerRetryDeadline(parsed.retry, now()); if (until) network.retryAtMs = until;
    if (parsed.status !== undefined && parsed.status !== 200) { network.publicFailure = "http-refusal"; network.httpStatus = parsed.status; }
    else if (result.code !== 0) network.publicFailure = failure(result.code);
    else {
      const ip = normalizedIp(parsed.body.trim());
      if (parsed.status === 200 && ip && publicIp(ip) && ip.includes(":") === (family === 6)) {
        network.publicIp = ip; network.publicObservedAtMs = now(); network.status = "ok";
      } else network.publicFailure = "invalid-response";
    }
  } catch { network.publicFailure = "connection"; }
  network.observedAtMs = now(); return parsePcNetwork(network);
}
