import { readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import type { FleetContext, FleetResource, FleetSnapshots } from "../contracts/fleet.ts";
import type { FleetSource } from "../server/snapshot-source.ts";
import type { FleetIntegration, FleetServerOptions } from "../server/application.ts";
import { startFleetServer } from "../server/application.ts";
import { ownerCall, readJson, sendJson, SharedHttpError } from "./ipc.ts";
import { join } from "node:path";

export function requestToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (authorization !== undefined) return /^Bearer [A-Za-z0-9_-]{43}$/.test(authorization) ? authorization.slice(7) : null;
  const cookies = (request.headers.cookie ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith("__Host-gridlens="));
  return cookies.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(cookies[0]!.slice(16)) ? cookies[0]!.slice(16) : null;
}
export function createGatewayIntegration(socketPath: string, setupHtml: Buffer, setupScript: Buffer): FleetIntegration {
  const call = <T>(body: unknown, signal?: AbortSignal) => ownerCall<T>(socketPath, body, signal);
  const makeSource = (request: IncomingMessage): FleetSource => {
    const token = requestToken(request);
    return {
      async read<K extends FleetResource>(resource: K, context: FleetContext, signal: AbortSignal): Promise<FleetSnapshots[K]> {
        if (resource === "job-history") {
          const query = new URL(request.url!, "https://gateway.invalid").searchParams;
          await call({ operation: "history-request", token, rosterRevision: context.rosterRevision, addresses: query.getAll("host"), refresh: query.get("refresh") === "1" }, signal);
        }
        return call<FleetSnapshots[K]>({ operation: "snapshot", token, resource, scopeId: context.scopeId, rosterRevision: context.rosterRevision }, signal);
      },
      // Poll only local committed SQLite snapshots. No read here dispatches routine provider work.
      async watch(resource, context, signal, onUpdate): Promise<never> {
        let previous = "";
        for (;;) {
          signal.throwIfAborted();
          const snapshot = await call<FleetSnapshots[typeof resource]>({ operation: "snapshot", token, resource,
            scopeId: context.scopeId, rosterRevision: context.rosterRevision }, signal);
          const text = JSON.stringify(snapshot);
          if (text !== previous) { onUpdate(snapshot); previous = text; }
          await new Promise<void>((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(signal.reason); };
            const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1000);
            signal.addEventListener("abort", abort, { once: true });
          });
        }
      },
    };
  };
  return {
    label: "Shared cache · source freshness shown per reading",
    sharedBackend: true,
    source: { async read() { throw new Error("Request-bound shared access required."); } }, sourceForRequest: makeSource,
    async resolveAccess(request, signal) {
      try {
        const context = await call<FleetContext>({ operation: "resolve", token: requestToken(request) }, signal);
        if (request.headers["x-gridlens-scope"] !== undefined && request.headers["x-gridlens-scope"] !== context.scopeId
          || request.headers["x-gridlens-roster-revision"] !== undefined && request.headers["x-gridlens-roster-revision"] !== context.rosterRevision) return null;
        return context;
      } catch (error) { if (error instanceof SharedHttpError && [401, 403, 409].includes(error.status)) return null; throw error; }
    },
    async handleRequest(request, response) {
      const url = new URL(request.url ?? "/", "https://gateway.invalid");
      if (["/connect", "/setup"].includes(url.pathname) && request.method === "GET") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": setupHtml.length,
          "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
        response.end(setupHtml); return true;
      }
      if (url.pathname === "/shared-setup.js" && request.method === "GET") {
        response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Content-Length": setupScript.length }); response.end(setupScript); return true;
      }
      if (!url.pathname.startsWith("/api/shared/")) return false;
      try {
        const token = requestToken(request), route = url.pathname.slice("/api/shared/".length);
        const getOperations: Record<string, string> = { status: "status", capabilities: "status", observations: "observations", devices: "devices", setup: "setup", monitoring: "monitoring" };
        const postOperations: Record<string, string> = { pair: "pair", login: "pair", "pair-code": "pair-code", revoke: "revoke", "setup-action": "setup-action", "gpu-history": "gpu-history", "monitoring-action": "monitoring-action" };
        if (request.method === "GET" && getOperations[route] && !url.search) {
          sendJson(response, 200, await call({ operation: getOperations[route], token })); return true;
        }
        if (request.method !== "POST" || !postOperations[route] || url.search) throw new SharedHttpError(405);
        const input = await readJson(request);
        const allowed: Record<string, string[]> = { pair: ["version", "code", "deviceName"], login: ["version", "code", "deviceName"],
          "pair-code": [], revoke: ["deviceId"], "setup-action": ["revision", "action", "selected", "automaticIp", "fullMonitoring"], "gpu-history": ["address", "fromAtMs", "toAtMs"], "monitoring-action": ["pcId", "action"] };
        if (Object.keys(input).some(key => !allowed[route]!.includes(key))) throw new SharedHttpError(400);
        const result = await call<Record<string, unknown>>({ ...input, operation: postOperations[route], token });
        if (route === "login") {
          if (typeof result.token !== "string") throw new SharedHttpError(502);
          response.setHeader("Set-Cookie", `__Host-gridlens=${result.token}; Path=/; Secure; HttpOnly; SameSite=Strict`);
          const { token: _secret, ...publicResult } = result; sendJson(response, 200, publicResult);
        } else sendJson(response, 200, result);
      } catch (error) { sendJson(response, error instanceof SharedHttpError ? error.status : 502, { error: "Shared cache request failed. Check access and retry." }); }
      return true;
    },
  };
}
export async function startSharedGateway(options: { socketPath: string; certPath: string; keyPath: string; publicOrigin: string;
  directory: string; host?: string; port?: number }) {
  const [cert, key, html, script] = await Promise.all([readFile(options.certPath), readFile(options.keyPath),
    readFile(join(options.directory, "shared-setup.html")), readFile(join(options.directory, "preview/shared-setup.js"))]);
  const integration = createGatewayIntegration(options.socketPath, html, script);
  const server: FleetServerOptions = { integration, directory: options.directory, host: options.host ?? "0.0.0.0",
    port: options.port ?? 8443, publicOrigin: options.publicOrigin, tls: { cert, key }, accessCheckIntervalMs: 1000 };
  return { server: await startFleetServer(server), integration };
}
