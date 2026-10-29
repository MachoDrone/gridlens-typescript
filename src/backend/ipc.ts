import { request as httpRequest, createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { chmod, mkdir, lstat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export class SharedHttpError extends Error {
  readonly status: number;
  constructor(status: number) { super("Shared backend request failed."); this.status = status; }
}
export async function readJson(request: IncomingMessage, maximum = 256 * 1024): Promise<Record<string, unknown>> {
  if (!request.headers["content-type"]?.startsWith("application/json")) throw new SharedHttpError(415);
  let size = 0; const chunks: Buffer[] = [];
  const timer = setTimeout(() => request.destroy(), 10_000); timer.unref();
  try {
    for await (const chunk of request) {
      size += Buffer.byteLength(chunk as Buffer);
      if (size > maximum) throw new SharedHttpError(413);
      chunks.push(Buffer.from(chunk as Buffer));
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch (error) { if (error instanceof SharedHttpError) throw error; throw new SharedHttpError(400); }
  finally { clearTimeout(timer); }
}
export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > 16 * 1024 * 1024) throw new SharedHttpError(413);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "Content-Length": body.length, "X-Content-Type-Options": "nosniff" }); response.end(body);
}
/** The socket is in an owned Docker volume, never a Docker API or command transport. */
export async function startOwnerSocket(path: string, dispatch: (body: Record<string, unknown>) => Promise<unknown>): Promise<Server> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // The caller must acquire the single-owner SQLite lock before stale socket cleanup.
  try { if (!(await lstat(path)).isSocket()) throw new Error("Refusing non-socket IPC path."); await unlink(path); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  const server = createServer((request, response) => {
    if (request.url !== "/" || request.method !== "POST") { sendJson(response, 404, { error: "Not found." }); return; }
    void readJson(request, 16 * 1024 * 1024).then(dispatch).then(value => sendJson(response, 200, value)).catch(error => {
      if (!response.headersSent && !response.destroyed) sendJson(response, error instanceof SharedHttpError ? error.status : 502,
        { error: "Shared backend request could not be completed." });
    });
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  await chmod(path, 0o660); return server;
}
export function ownerCall<T>(socketPath: string, body: unknown, signal?: AbortSignal, timeoutMs = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(JSON.stringify(body));
    if (encoded.length > 16 * 1024 * 1024) { reject(new SharedHttpError(413)); return; }
    const request = httpRequest({ socketPath, path: "/", method: "POST", ...(signal ? { signal } : {}),
      headers: { "Content-Type": "application/json", "Content-Length": encoded.length } }, response => {
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length; if (size > 16 * 1024 * 1024) { response.destroy(new SharedHttpError(413)); return; } chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        if (response.statusCode !== 200) { reject(new SharedHttpError(response.statusCode ?? 502)); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T); } catch { reject(new SharedHttpError(502)); }
      });
    });
    const timeout = setTimeout(() => request.destroy(new SharedHttpError(504)), timeoutMs);
    request.once("close", () => clearTimeout(timeout)); request.on("error", reject); request.end(encoded);
  });
}
