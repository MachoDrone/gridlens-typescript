import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface CommandOptions { cwd?: string; input?: Uint8Array | string; timeoutMs?: number; maximumBytes?: number; env?: NodeJS.ProcessEnv; logPath?: string }
export interface CommandResult { stdout: string; stderr: string; exitCode: number }
export type CommandRunner = (command: string, args: readonly string[], options?: CommandOptions) => Promise<CommandResult>;
export const runCommand: CommandRunner = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, [...args], { cwd: options.cwd, env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
  const maximum = options.maximumBytes ?? 8 * 1024 ** 2;
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  let bytes = 0, failure: Error | undefined;
  const stop = (message: string): void => { failure ??= new Error(message); child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 2000).unref(); };
  const timer = setTimeout(() => stop("Release command exceeded its time limit."), options.timeoutMs ?? 60_000);
  const collect = (parts: Buffer[]) => (chunk: Buffer): void => { bytes += chunk.length; if (bytes > maximum) stop("Release command exceeded its output limit."); else parts.push(chunk); };
  child.stdout.on("data", collect(stdout)); child.stderr.on("data", collect(stderr));
  child.on("error", error => { failure = error; });
  child.stdin.on("error", () => { /* Process exit is reconciled below. */ });
  child.on("close", code => {
    clearTimeout(timer);
    const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exitCode: code ?? -1 };
    if (options.logPath) {
      mkdirSync(dirname(options.logPath), { recursive: true, mode: 0o700 });
      writeFileSync(options.logPath, result.stdout + result.stderr, { mode: 0o600, flag: "wx" });
    }
    if (failure) reject(failure); else resolve(result);
  });
  child.stdin.end(options.input);
});
export async function checked(command: string, args: readonly string[], options?: CommandOptions, runner: CommandRunner = runCommand): Promise<string> {
  const result = await runner(command, args, options);
  if (result.exitCode !== 0) throw new Error(`${command} failed (exit ${result.exitCode}); inspect the private stage log. No mutation retry was attempted.`);
  return result.stdout.trim();
}
export const shellQuote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;
export const shellWords = (args: readonly string[]): string => args.map(shellQuote).join(" ");
