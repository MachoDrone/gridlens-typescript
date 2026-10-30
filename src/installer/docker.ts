import { spawn, spawnSync } from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import { InstallerError } from "./release.ts";

export const PRODUCT_LABEL = "io.gridlens.product";
export const PRODUCT = "shared-backend";
export const INSTANCE_LABEL = "io.gridlens.instance";
export interface CommandResult { status: number; stdout: string; stderr: string }
export interface DockerRunner {
  run(args: readonly string[], input?: string | Uint8Array): CommandResult;
  /** Holds a fixed helper's stdin open until release; used for an OS-owned lock. */
  hold?(args: readonly string[]): Promise<() => Promise<void>>;
}
type ProcessRunner = (command: string, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding) => SpawnSyncReturns<string>;
const DIAGNOSTIC_LIMIT = 4096;
const LOCK_OUTPUT_LIMIT = 64 * 1024;
export const MAINTENANCE_LOCK_READY = "GRIDLENS_LOCK_READY";
export const MAINTENANCE_LOCK_BUSY = "GRIDLENS_LOCK_BUSY";
export const MAINTENANCE_LOCK_BUSY_EXIT = 75;

/** Uncached dependency/image builds get their own bounded allowance. Ordinary
 * operations and terminal SSH inspection retain their existing shorter limits. */
export function dockerCommandTimeoutMs(args: readonly string[]): number {
  if (args[0] === "build" || args[0] === "image" && args[1] === "build" || args[0] === "buildx" && args[1] === "build") return 30 * 60_000;
  return args.includes("setup-inspect") || args.includes("scan") ? 600_000 : 300_000;
}
function diagnostic(result: Pick<CommandResult, "stdout" | "stderr">, input?: string | Uint8Array): string {
  let output = [result.stdout && `stdout:\n${result.stdout}`, result.stderr && `stderr:\n${result.stderr}`].filter(Boolean).join("\n");
  // Never put argv, stdin, environment, authorization or signing material into
  // the error. Redact before truncation so a clipped PEM body cannot escape.
  const secrets = new Set<string>();
  if (input !== undefined) {
    const text = typeof input === "string" ? input : Buffer.from(input).toString("utf8");
    if (text) secrets.add(text);
    try {
      const visit = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        for (const [field, child] of Object.entries(value)) {
          if (/^(?:password|passphrase|privateKey|sudoPassword|token|authorization|code)$/i.test(field) && typeof child === "string" && child) {
            secrets.add(child); secrets.add(JSON.stringify(child).slice(1, -1));
          } else if (typeof child === "object") visit(child);
        }
      }; visit(JSON.parse(text));
    } catch { /* Non-JSON stdin is redacted as a whole, never logged separately. */ }
  }
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) output = output.replaceAll(secret, "[redacted]");
  output = output
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[private key redacted]")
    .replace(/("(?:password|passphrase|privateKey|sudoPassword|token|authorization|code)"\s*:\s*)"(?:\\.|[^"\\])*(?:"|\\?$)/gi, "$1\"[redacted]\"")
    .replace(/((?:proxy-authorization|authorization|x-gridlens-token)\s*[:=]\s*)[^\r\n]+/gi, "$1[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/https?:\/\/[^\s<>"']+/gi, "[URL redacted]")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  return output.length > DIAGNOSTIC_LIMIT ? `[earlier output omitted]\n${output.slice(-DIAGNOSTIC_LIMIT)}` : output;
}
function operationName(args: readonly string[]): string { return /^[a-z-]{1,32}$/.test(args[0] ?? "") ? args[0]! : "operation"; }
export class DockerCommandError extends InstallerError {
  readonly operation: string;
  readonly kind: "exit" | "timeout" | "output-limit" | "unavailable" | "signal";
  readonly exitCode: number | null;
  readonly processCode: string | undefined;
  readonly diagnostic: string;
  constructor(args: readonly string[], kind: DockerCommandError["kind"], result: Pick<CommandResult, "stdout" | "stderr"> & { status: number | null }, input?: string | Uint8Array, processCode?: unknown) {
    const operation = operationName(args), detail = diagnostic(result, input);
    const code = typeof processCode === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(processCode) ? processCode : undefined;
    const reason = kind === "timeout" ? `timed out after ${dockerCommandTimeoutMs(args) / 1000} seconds`
      : kind === "output-limit" ? "exceeded the bounded process-output limit"
        : kind === "signal" ? `was terminated${code ? ` by ${code}` : " by a signal"}`
        : kind === "unavailable" ? `could not start${code ? ` (${code})` : ""}; verify the existing Docker executable and access`
          : `failed (exit ${result.status ?? "unknown"})`;
    super(`Docker ${operation} ${reason}.${detail ? `\n${detail}` : ""}`);
    this.name = "DockerCommandError"; this.operation = operation; this.kind = kind; this.exitCode = result.status; this.processCode = code; this.diagnostic = detail;
  }
}
export function localDockerRunner({ execute = spawnSync, environment = process.env, allowSudo = true }: { execute?: ProcessRunner; environment?: NodeJS.ProcessEnv; allowSudo?: boolean } = {}): DockerRunner {
  let sudo = false;
  let maintenance: { name: string; id?: string; lost: boolean; released: boolean } | undefined;
  return { run(args, input) {
    if (maintenance && !maintenance.released) {
      if (maintenance.lost) throw new InstallerError("The installation lock was lost. No further runtime changes were attempted.");
      const guarded = execute(sudo ? "sudo" : "docker", [...(sudo ? ["--", "docker"] : []), "container", "inspect", maintenance.name],
        { encoding: "utf8", shell: false, env: { ...environment, DOCKER_CLI_HINTS: "false" }, timeout: 10_000, maxBuffer: 64 * 1024 });
      try {
        const values = JSON.parse(guarded.stdout), item = values?.[0];
        if (guarded.status !== 0 || values.length !== 1 || item?.State?.Running !== true || typeof item.Id !== "string"
          || maintenance.id !== undefined && maintenance.id !== item.Id) throw new Error();
        maintenance.id = item.Id;
      } catch {
        maintenance.lost = true;
        throw new InstallerError("The installation lock was lost. No further runtime changes were attempted.");
      }
    }
    const options: SpawnSyncOptionsWithStringEncoding = { encoding: "utf8", ...(input === undefined ? {} : { input }), shell: false,
      maxBuffer: 16 * 1024 * 1024, env: { ...environment, DOCKER_CLI_HINTS: "false" }, timeout: dockerCommandTimeoutMs(args) };
    let result = execute(sudo ? "sudo" : "docker", sudo ? ["--", "docker", ...args] : [...args], options);
    const remote = !!environment.DOCKER_HOST && !environment.DOCKER_HOST.startsWith("unix:")
      || !!environment.DOCKER_CONTEXT && environment.DOCKER_CONTEXT !== "default";
    if (allowSudo && !sudo && !remote && result.status !== 0 && /permission denied.*(?:docker|socket)|(?:docker|socket).*permission denied/i.test(result.stderr ?? "")) {
      process.stderr.write("Docker access requires administrator approval; sudo will prompt in this terminal.\n");
      const approval = execute("sudo", ["-v"], { encoding: "utf8", stdio: "inherit", shell: false });
      if (approval.status !== 0) throw new InstallerError("Docker administrator approval was not completed.");
      sudo = true;
      result = execute("sudo", ["--", "docker", ...args], options);
    }
    if (result.error) {
      const code = "code" in result.error ? result.error.code : undefined;
      throw new DockerCommandError(args, code === "ETIMEDOUT" ? "timeout" : code === "ENOBUFS" ? "output-limit" : "unavailable", result, input, code);
    }
    if (result.status === null && result.signal) throw new DockerCommandError(args, "signal", result, input, result.signal);
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }, hold(args) {
    return new Promise((resolve, reject) => {
      if (maintenance && !maintenance.released) { reject(new InstallerError("Another installation lock is held.")); return; }
      const nameAt = args.indexOf("--name"), name = args[nameAt + 1];
      if (nameAt < 0 || !name || !/^gridlens-modern-[a-z0-9-]+-maintenance-[a-f0-9]{16}$/.test(name)) { reject(new InstallerError("The installation lock helper requires its unique owned name.")); return; }
      const held = { name, lost: false, released: false };
      const child = spawn(sudo ? "sudo" : "docker", sudo ? ["--", "docker", ...args] : [...args], {
        shell: false, env: { ...environment, DOCKER_CLI_HINTS: "false" }, stdio: ["pipe", "pipe", "pipe"],
      });
      let ready = false, output = "", stderr = "", captured = 0, finished = false, failed = false;
      const completion = new Promise<void>(done => child.once("close", () => { finished = true; done(); }));
      const timeout = setTimeout(() => {
        failed = true; child.kill("SIGTERM");
        const detail = diagnostic({ stdout: output, stderr });
        reject(new InstallerError(`The installation lock helper did not become ready within 20 seconds.${detail ? `\n${detail}` : ""}`));
      }, 20_000);
      const capture = (chunk: Buffer, target: "stdout" | "stderr"): void => {
        if (failed) return;
        const available = Math.max(0, LOCK_OUTPUT_LIMIT - captured);
        const part = chunk.subarray(0, available).toString("utf8"); captured += chunk.byteLength;
        if (target === "stdout") output += part; else stderr += part;
        if (captured > LOCK_OUTPUT_LIMIT) {
          failed = true; clearTimeout(timeout); child.kill("SIGTERM");
          reject(new DockerCommandError(args, "output-limit", { status: null, stdout: output, stderr }));
        }
      };
      child.stderr.on("data", (chunk: Buffer) => capture(chunk, "stderr"));
      child.once("error", error => {
        failed = true; clearTimeout(timeout);
        reject(new DockerCommandError(args, "unavailable", { status: null, stdout: output, stderr }, undefined,
          "code" in error ? error.code : undefined));
      });
      child.once("close", (code, signal) => {
        clearTimeout(timeout); if (ready && !held.released) held.lost = true;
        if (ready || failed) return;
        if (code === MAINTENANCE_LOCK_BUSY_EXIT && stderr.split(/\r?\n/).includes(MAINTENANCE_LOCK_BUSY)) {
          reject(new InstallerError("Another installation or update is running. Retry after it finishes."));
        } else {
          reject(new DockerCommandError(args, signal ? "signal" : "exit", { status: code, stdout: output, stderr }, undefined, signal));
        }
      });
      child.stdout.on("data", (chunk: Buffer) => {
        capture(chunk, "stdout");
        if (!failed && !ready && output.includes(`${MAINTENANCE_LOCK_READY}\n`)) {
          ready = true; maintenance = held; clearTimeout(timeout);
          resolve(async () => { held.released = true; if (maintenance === held) maintenance = undefined; if (!finished) child.stdin.end(); await completion; });
        }
      });
    });
  } };
}
export function checked(runner: DockerRunner, args: readonly string[], input?: string | Uint8Array): string {
  const result = runner.run(args, input);
  if (result.status !== 0) throw new DockerCommandError(args, "exit", result, input);
  return result.stdout.trim();
}
export function resourceName(instance: string, suffix: string): string {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(instance) || !/^[a-z0-9-]{1,100}$/.test(suffix)) throw new InstallerError("Invalid GridLens instance or resource name.");
  return `gridlens-modern-${instance}-${suffix}`;
}
export function labels(instance: string): string[] { return ["--label", `${PRODUCT_LABEL}=${PRODUCT}`, "--label", `${INSTANCE_LABEL}=${instance}`]; }
export function inspectOwned(runner: DockerRunner, kind: "container" | "volume" | "network", name: string, instance: string): Record<string, unknown> | undefined {
  const result = runner.run([kind, "inspect", name]);
  if (result.status !== 0) {
    // A failed daemon/permission check must not be mistaken for a missing object.
    if (/No such (?:object|container|volume|network)|not found/i.test(result.stderr)) return undefined;
    throw new InstallerError("Docker resource inspection failed; no existing resource was changed.");
  }
  let value: unknown;
  try { value = JSON.parse(result.stdout); } catch { throw new InstallerError("Docker returned invalid resource metadata."); }
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== "object") throw new InstallerError("Docker returned invalid resource metadata.");
  const item = value[0] as Record<string, unknown>;
  const config = item.Config as Record<string, unknown> | undefined;
  const actual = (kind === "container" ? config?.Labels : item.Labels) as Record<string, unknown> | undefined;
  if (actual?.[PRODUCT_LABEL] !== PRODUCT || actual?.[INSTANCE_LABEL] !== instance) throw new InstallerError(`The name ${name} belongs to another installation. It was left untouched.`);
  return item;
}
export function ensureVolume(runner: DockerRunner, name: string, instance: string): void {
  if (!inspectOwned(runner, "volume", name, instance)) checked(runner, ["volume", "create", ...labels(instance), name]);
}
export const mount = (name: string, target: string, readonly = false): string[] => ["--mount", `type=volume,src=${name},dst=${target}${readonly ? ",readonly" : ""}`];
export const restrictions = ["--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "128", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m"];
