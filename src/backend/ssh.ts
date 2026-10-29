import { createHash } from "node:crypto";
import { Client } from "ssh2";
import type { ConnectConfig } from "ssh2";
import { isIP } from "node:net";
import { isMetadataAddress } from "../fleet/host-metadata.ts";
import { privateIp, GPU_UUID } from "../fleet/pc-observations.ts";
import type { PcAssociation } from "../contracts/shared.ts";

export interface Computer { id: string; host: string; port: number; name: string; fingerprint: string; hostKey: string }
export interface SshCredential { username: string; password?: string; privateKey?: string; passphrase?: string; sudoPassword?: string }
export type SshResult = { code: number; stdout: string };
export type SshRun = (command: string, options?: { input?: string; maximum?: number; timeoutMs?: number }) => Promise<SshResult>;
export class SshAccessError extends Error {
  readonly kind: "credential-rejected" | "identity-changed" | "connection";
  constructor(kind: SshAccessError["kind"]) { super("Approved SSH access failed."); this.kind = kind; }
}
export const fingerprint = (key: Buffer): string => `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
const pcId = (key: Buffer): string => createHash("sha256").update(key).digest("hex");
export const shellQuote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
function hostType(key: Buffer): string {
  if (key.length < 8 || key.readUInt32BE(0) > 64) throw new Error("Invalid SSH identity.");
  return key.subarray(4, 4 + key.readUInt32BE(0)).toString("ascii");
}
export function scanAddresses(range: string): string[] {
  const parts = range.split("/");
  if (parts.length === 1 && isIP(range) && privateIp(range)) return [range];
  if (parts.length !== 2 || isIP(parts[0]!) !== 4 || !/^\d+$/.test(parts[1]!)) throw new Error("Enter an explicit private address or IPv4 /23–/32 network.");
  const bits = Number(parts[1]);
  if (bits < 23 || bits > 32) throw new Error("Scan at most 512 explicitly selected addresses.");
  const input = parts[0]!.split(".").reduce((value, part) => value * 256 + Number(part), 0), size = 2 ** (32 - bits);
  const start = Math.floor(input / size) * size;
  const addresses = Array.from({ length: size }, (_, i) => [24, 16, 8, 0].map(shift => (start + i >>> shift) & 255).join("."));
  if (addresses.some(value => !privateIp(value))) throw new Error("Scanning requires an explicit private network.");
  return addresses;
}
export function probeComputer(host: string, port = 22, signal?: AbortSignal): Promise<Computer | null> {
  if (!isIP(host) || !privateIp(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid SSH scan target.");
  if (signal?.aborted) return Promise.resolve(null);
  return new Promise(resolve => {
    const client = new Client(); let result: Computer | null = null, settled = false;
    const finish = (value: Computer | null): void => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(value);
    };
    const abort = (): void => { finish(null); client.destroy(); };
    const timer = setTimeout(() => { finish(result); client.destroy(); }, 4000);
    signal?.addEventListener("abort", abort, { once: true });
    client.on("error", () => {}); client.on("close", () => finish(result));
    client.connect({ host, port, username: "gridlens-identity-probe", readyTimeout: 3500,
      hostVerifier(key: Buffer) { result = { id: pcId(key), host, port, name: host, fingerprint: fingerprint(key), hostKey: key.toString("base64") }; return false; } });
  });
}
export interface ScanProgress { total: number; completed: number; found: number }
export interface ScanOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ScanProgress) => void;
  /** Injected only by isolated tests; browser requests cannot select a probe. */
  probe?: typeof probeComputer;
}
export async function scanComputers(range: string, port = 22, options: ScanOptions = {}): Promise<Computer[]> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid SSH scan port.");
  const remaining = scanAddresses(range), found: Computer[] = [];
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const total = remaining.length, ids = new Set<string>(); let completed = 0;
  signal.throwIfAborted(); options.onProgress?.({ total, completed, found: 0 });
  const workers = Array.from({ length: Math.min(8, remaining.length) }, async () => {
    while (remaining.length) {
      signal.throwIfAborted(); const host = remaining.shift()!;
      const result = await (options.probe ?? probeComputer)(host, port, signal);
      signal.throwIfAborted();
      if (result && !ids.has(result.id)) { ids.add(result.id); found.push(result); }
      completed++; options.onProgress?.({ total, completed, found: found.length });
    }
  });
  try { await Promise.all(workers); }
  catch (error) { controller.abort(); await Promise.allSettled(workers); throw error; }
  return found.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
}
export async function withSsh<T>(computer: Computer, credential: SshCredential, work: (run: SshRun) => Promise<T>): Promise<T> {
  const client = new Client(), expected = Buffer.from(computer.hostKey, "base64");
  if (pcId(expected) !== computer.id || fingerprint(expected) !== computer.fingerprint || !isIP(computer.host)
    || !/^[A-Za-z0-9_.-]{1,64}$/.test(credential.username)) throw new Error("Invalid approved SSH identity.");
  const type = hostType(expected);
  let identityChanged = false;
  const algorithms: ConnectConfig["algorithms"] = { serverHostKey: type === "ssh-rsa" ? ["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"] : [type] as never };
  const config: ConnectConfig = { host: computer.host, port: computer.port, username: credential.username, algorithms,
    hostVerifier: (key: Buffer) => { identityChanged = !key.equals(expected); return !identityChanged; }, readyTimeout: 8000, keepaliveInterval: 5000, keepaliveCountMax: 2,
    ...(credential.password ? { password: credential.password } : {}), ...(credential.privateKey ? { privateKey: credential.privateKey } : {}),
    ...(credential.passphrase ? { passphrase: credential.passphrase } : {}) };
  try {
    await new Promise<void>((resolve, reject) => { client.once("ready", resolve); client.once("error", error => {
      reject(new SshAccessError(identityChanged ? "identity-changed" : error.level === "client-authentication" ? "credential-rejected" : "connection"));
    }); client.connect(config); });
  } catch (error) { client.destroy(); throw error; }
  const run: SshRun = (command, { input, maximum = 64 * 1024, timeoutMs = 8000 } = {}) => new Promise((resolve, reject) => {
    client.exec(command, { pty: false }, (error, stream) => {
      if (error) { reject(new Error("Approved SSH read failed.")); return; }
      const chunks: Buffer[] = []; let size = 0;
      const timeout = setTimeout(() => { stream.destroy(); reject(new Error("Approved SSH read timed out.")); }, timeoutMs);
      stream.on("data", (chunk: Buffer) => { size += chunk.length; if (size > maximum) { stream.destroy(); reject(new Error("SSH response exceeded its bound.")); } else chunks.push(Buffer.from(chunk)); });
      // Arbitrary remote stderr may contain secrets; never forward it to the gateway/logs.
      stream.stderr.on("data", () => {});
      stream.on("error", () => { clearTimeout(timeout); reject(new Error("Approved SSH read failed.")); });
      stream.on("close", (code: number | undefined) => { clearTimeout(timeout); resolve({ code: code ?? -1, stdout: Buffer.concat(chunks).toString("utf8") }); });
      stream.end(input);
    });
  });
  try { return await work(run); } finally { client.end(); client.destroy(); }
}
interface Container { id: string; image: string; name: string }
const image = (value: string, repository: string): boolean => new RegExp(`^(?:(?:docker\\.io|registry\\.hub\\.docker\\.com)/)?nosana/${repository}(?::[A-Za-z0-9_.-]+|@sha256:[a-f0-9]{64})?$`).test(value);
function inventory(text: string): Container[] {
  if (text.length > 512 * 1024) throw new Error("Inventory too large.");
  return text.trim().split(/\r?\n/).filter(Boolean).map(line => {
    const [id, image, name, extra] = line.split("\t");
    if (!id || !/^[a-f0-9]{64}$/.test(id) || !image || !/^[A-Za-z0-9][A-Za-z0-9./:@_-]{0,255}$/.test(image)
      || !name || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name) || extra !== undefined) throw new Error("Invalid inventory.");
    return { id, image, name };
  }).slice(0, 512);
}
// Runs only the already-running node's fixed local public API. No wallet module is loaded.
function addressReader(): void {
  const http = require("node:http") as typeof import("node:http");
  const timer = setTimeout(() => process.exit(1), 3000);
  const req = http.get({ host: "127.0.0.1", port: 5001, path: "/" }, response => {
    let body = ""; response.on("data", (chunk: Buffer) => { body += chunk; if (body.length > 256) process.exit(1); });
    response.on("end", () => { try { const value: unknown = JSON.parse(body); if (response.statusCode !== 200 || typeof value !== "string"
      || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) process.exit(1); process.stdout.write(value + "\n"); clearTimeout(timer); } catch { process.exit(1); } });
  }); req.on("error", () => process.exit(1));
}
export function nodeRuntime(binding: PcAssociation["binding"]): string {
  if (!["docker", "podman"].includes(binding.runtime) || binding.wrapperId !== null && binding.runtime !== "podman"
    || !/^[a-f0-9]{64}$/.test(binding.nodeContainerId) || binding.wrapperId !== null && !/^[a-f0-9]{64}$/.test(binding.wrapperId)) throw new Error("Invalid exact node binding.");
  return binding.wrapperId ? `/usr/bin/docker exec ${binding.wrapperId} /usr/bin/podman` : `/usr/bin/${binding.runtime}`;
}
export const nodeAddressCommand = (binding: PcAssociation["binding"]): string => `${nodeRuntime(binding)} exec ${binding.nodeContainerId} /usr/bin/env -i /usr/local/bin/node -e ${shellQuote(`(${addressReader.toString()})()` )}`;
export async function inspectComputer(computer: Computer, credential: SshCredential, now = Date.now): Promise<{ associations: PcAssociation[]; exclusions: string[] }> {
  return withSsh(computer, credential, async run => {
    const associations: PcAssociation[] = [], exclusions: string[] = [];
    const prefix = credential.sudoPassword !== undefined ? "/usr/bin/sudo -S -p '' -- " : "";
    const options = credential.sudoPassword !== undefined ? { input: credential.sudoPassword + "\n" } : {};
    const nameResult = await run("/bin/hostname", { maximum: 256 });
    const name = nameResult.code === 0 && /^[A-Za-z0-9_.-]{1,128}$/.test(nameResult.stdout.trim()) ? nameResult.stdout.trim() : computer.name;
    const scan = async (runtime: "docker" | "podman", wrapperId: string | null): Promise<void> => {
      const base = wrapperId ? `/usr/bin/docker exec ${wrapperId} /usr/bin/podman` : `/usr/bin/${runtime}`;
      const listed = await run(`${prefix}${base} ps --no-trunc --format '{{.ID}}\t{{.Image}}\t{{.Names}}'`, { ...options, maximum: 512 * 1024 });
      if (listed.code !== 0) { exclusions.push(`${name}: ${runtime} inventory unavailable`); return; }
      for (const container of inventory(listed.stdout)) {
        if (!wrapperId && runtime === "docker" && image(container.image, "podman")) { await scan("podman", container.id); continue; }
        if (!image(container.image, "nosana-node")) continue;
        const binding = { pcId: computer.id, runtime, wrapperId, nodeContainerId: container.id };
        const result = await run(prefix + nodeAddressCommand(binding), { ...options, maximum: 256 });
        const address = result.stdout.trim();
        if (result.code !== 0 || !isMetadataAddress(address)) { exclusions.push(`${name}: ${container.name} public identity unavailable`); continue; }
        const gpu = await run(`${prefix}${base} exec ${container.id} /usr/bin/nvidia-smi --query-gpu=uuid --format=csv,noheader`, { ...options, maximum: 8192 });
        const gpuUuids = gpu.code === 0 ? gpu.stdout.trim().split(/\r?\n/).map(value => value.trim().toLowerCase().replace(/^gpu-/, "GPU-")).filter(value => GPU_UUID.test(value)) : [];
        associations.push({ address, binding, name, sshFingerprint: computer.fingerprint, verifiedAtMs: now(), privateIp: privateIp(computer.host) ? computer.host : null, gpuUuids });
      }
    };
    await scan("docker", null); await scan("podman", null);
    return { associations, exclusions };
  });
}
