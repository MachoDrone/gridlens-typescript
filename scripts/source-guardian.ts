import { createServer, request } from "node:http";
import { chmodSync, existsSync, lstatSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGuardianExecutor } from "../src/backend/guardian-executor.ts";
import { GuardianError, initializeSourceGuardian, openSourceGuardian, parseGuardianEnrollment } from "../src/backend/source-guardian.ts";
import type { GuardianExecutor } from "../src/backend/source-guardian.ts";
import type { OwnerSignedRequest } from "../src/backend/owner-authority.ts";
import { boundedGuardianJson, GUARDIAN_MAX_ENROLLMENT_BYTES, GUARDIAN_MAX_ENVELOPE_BYTES, GUARDIAN_MAX_REPLY_BYTES } from "../src/backend/guardian-limits.ts";

const ROOT = "/guardian", SOCKET = "/tmp/guardian.sock";
async function input(maximum: number): Promise<unknown> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of process.stdin) { const bytes = Buffer.from(chunk); length += bytes.length; if (length > maximum) throw new Error(); chunks.push(bytes); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
/** Validation precedes even the mode change of a newly mounted empty volume. */
export function provisionGuardianDirectory(directory: string, value: unknown) {
  const enrollment = parseGuardianEnrollment(value), root = resolve(directory), stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== root || readdirSync(root).length !== 0) throw new GuardianError("recovery-required");
  chmodSync(root, 0o700); return initializeSourceGuardian(root, enrollment);
}
/** Used by the fixed container-local dispatcher and isolated IPC fixtures. */
export async function dispatchGuardianEnvelope(socketPath: string, envelope: unknown): Promise<string> {
  const body = Buffer.from(boundedGuardianJson(envelope, GUARDIAN_MAX_ENVELOPE_BYTES));
  return new Promise<string>((done, reject) => {
    const outgoing = request({ socketPath, path: "/dispatch", method: "POST", agent: false, headers: { "Content-Length": body.length } }, response => {
      const chunks: Buffer[] = []; let bytes = 0; response.on("data", (chunk: Buffer) => {
        bytes += chunk.length; if (bytes > GUARDIAN_MAX_REPLY_BYTES) { outgoing.destroy(new Error()); return; } chunks.push(chunk);
      });
      response.once("end", () => done(Buffer.concat(chunks).toString("utf8"))); response.once("error", reject);
    });
    outgoing.setTimeout(85_000, () => outgoing.destroy(new Error())); outgoing.once("error", reject); outgoing.end(body);
  });
}
export async function sourceGuardianMain(mode: string): Promise<void> {
  process.umask(0o077);
  if (mode === "provision") {
    const status = provisionGuardianDirectory(ROOT, await input(GUARDIAN_MAX_ENROLLMENT_BYTES)); console.log(JSON.stringify({ version: 1, ready: true, authorityId: status.authorityId, pcId: status.pcId, policyEpoch: status.policyEpoch })); return;
  }
  if (mode === "status") { const guardian = openSourceGuardian(ROOT); try { console.log(boundedGuardianJson(guardian.status(), GUARDIAN_MAX_REPLY_BYTES)); } finally { guardian.close(); } return; }
  if (mode === "dispatch") {
    const reply = await dispatchGuardianEnvelope(SOCKET, await input(GUARDIAN_MAX_ENVELOPE_BYTES));
    process.stdout.write(reply); return;
  }
  if (mode !== "serve") throw new Error();
  const server = await startSourceGuardianServer({ directory: ROOT, socketPath: SOCKET, executor: createGuardianExecutor() });
  const stop = () => { void server.close().then(() => process.exit(0)).catch(() => { process.exitCode = 1; }); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
}
/** Trusted construction seam for generated-key IPC/Docker fixtures. The product
 * CLI exposes neither directory/executor overrides nor client-supplied code. */
export async function startSourceGuardianServer(options: { directory: string; socketPath: string; executor: GuardianExecutor; now?: () => number }) {
  const guardian = openSourceGuardian(options.directory, { executor: options.executor, ...(options.now ? { now: options.now } : {}) });
  if (existsSync(options.socketPath)) { guardian.close(); throw new GuardianError("recovery-required"); }
  let closing = false;
  let stopped: Promise<void> | undefined;
  const pending = new Set<Promise<void>>();
  const server = createServer((incoming, response) => {
    if (closing || incoming.method !== "POST" || incoming.url !== "/dispatch" || pending.size >= 4) { response.writeHead(503).end(); return; }
    response.on("error", () => {});
    const reply = (status: number, value: unknown) => { const encoded = boundedGuardianJson(value, GUARDIAN_MAX_REPLY_BYTES); if (!response.destroyed && !response.writableEnded) response.writeHead(status, { "Content-Type": "application/json" }).end(encoded); };
    const work = (async () => {
      try {
        const chunks: Buffer[] = []; let length = 0;
        for await (const chunk of incoming) { const bytes = Buffer.from(chunk); length += bytes.length; if (length > GUARDIAN_MAX_ENVELOPE_BYTES) throw new GuardianError("invalid"); chunks.push(bytes); }
        if (closing) throw new GuardianError("pending");
        const value = await guardian.dispatch(JSON.parse(Buffer.concat(chunks).toString("utf8")) as OwnerSignedRequest);
        reply(200, value);
      } catch (error) {
        reply(409, { version: 1, error: error instanceof GuardianError ? error.code : "recovery-required",
          dispatched: error instanceof GuardianError && error.code !== "recovery-required" ? false : null });
      }
    })();
    pending.add(work); void work.finally(() => pending.delete(work)).catch(() => {});
  });
  server.on("clientError", (_error, socket) => { socket.destroy(); });
  server.requestTimeout = 90_000; server.headersTimeout = 5000;
  try { await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(options.socketPath, done); }); }
  catch (error) { guardian.close(); throw error; }
  return { close(): Promise<void> {
    return stopped ??= (async () => {
      closing = true;
      const drained = new Promise<void>(done => server.close(() => done()));
      await Promise.allSettled([...pending]); await drained;
      guardian.close(); if (existsSync(options.socketPath)) unlinkSync(options.socketPath);
    })();
  } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  sourceGuardianMain(process.argv.length === 3 ? process.argv[2]! : "").catch(error => {
    console.error(error instanceof GuardianError ? `Financial guardian ${error.code}.` : "Financial guardian needs recovery."); process.exitCode = 1;
  });
}
