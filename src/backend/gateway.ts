import { open, readFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import type { FleetContext, FleetResource, FleetSnapshots } from "../contracts/fleet.ts";
import type { FleetSource } from "../server/snapshot-source.ts";
import type { FleetIntegration, FleetServerOptions } from "../server/application.ts";
import { startFleetServer } from "../server/application.ts";
import { ownerCall, readJson, sendJson, SharedHttpError } from "./ipc.ts";
import { join } from "node:path";
import { isIP } from "node:net";

export type GatewayTransport = "https" | "vpn-http";
const cookieName = (transport: GatewayTransport): string => transport === "vpn-http" ? "gridlens-vpn" : "__Host-gridlens";

/** HTTP is an explicit private-network option, never inferred from proxy headers. */
export function validateGatewayOrigin(publicOrigin: string, transport: GatewayTransport = "https"): void {
  if (transport !== "https" && transport !== "vpn-http") throw new Error("Unsupported gateway transport.");
  const origin = new URL(publicOrigin);
  if (origin.protocol !== (transport === "vpn-http" ? "http:" : "https:") || origin.username || origin.password
    || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("Set the canonical origin for the selected gateway transport.");
  if (transport === "vpn-http") {
    const host = origin.hostname.replace(/^\[|\]$/g, ""), version = isIP(host), parts = host.split(".").map(Number);
    const privateIp = version === 4 && (parts[0] === 10 || parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31
      || parts[0] === 192 && parts[1] === 168 || parts[0] === 127)
      || version === 6 && (/^f[cd][a-f0-9]{2}:/i.test(host) || host === "::1");
    if (!privateIp || origin.origin !== publicOrigin) throw new Error("VPN HTTP requires an exact private IP origin on the existing private network.");
  }
}

export function requestToken(request: IncomingMessage, transport: GatewayTransport = "https"): string | null {
  const authorization = request.headers.authorization;
  if (authorization !== undefined) return /^Bearer [A-Za-z0-9_-]{43}$/.test(authorization) ? authorization.slice(7) : null;
  const prefix = `${cookieName(transport)}=`;
  const cookies = (request.headers.cookie ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith(prefix));
  return cookies.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(cookies[0]!.slice(prefix.length)) ? cookies[0]!.slice(prefix.length) : null;
}
export function createGatewayIntegration(socketPath: string, setupHtml: Buffer, setupScript: Buffer,
  { transport = "https", privateNetworkToken }: { transport?: GatewayTransport; privateNetworkToken?: string } = {}): FleetIntegration {
  if (transport !== "https" && transport !== "vpn-http") throw new Error("Unsupported gateway transport.");
  if (privateNetworkToken !== undefined && (transport !== "vpn-http" || !/^[A-Za-z0-9_-]{43}$/.test(privateNetworkToken)))
    throw new Error("Private-network access requires its configured HTTP gateway grant.");
  const privateNetwork = privateNetworkToken !== undefined;
  const tokenFor = (request: IncomingMessage): string | null => privateNetworkToken ?? requestToken(request, transport);
  if (privateNetwork) setupHtml = Buffer.from(setupHtml.toString("utf8")
    .replace("</head>", '<meta name="gridlens-private-network" content="1"></head>')
    .replace('<section id="login">', '<section id="login" hidden>'));
  const call = <T>(body: unknown, signal?: AbortSignal) => ownerCall<T>(socketPath, body, signal);
  const makeSource = (request: IncomingMessage): FleetSource => {
    const token = tokenFor(request);
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
        const context = await call<FleetContext>({ operation: "resolve", token: tokenFor(request) }, signal);
        if (request.headers["x-gridlens-scope"] !== undefined && request.headers["x-gridlens-scope"] !== context.scopeId
          || request.headers["x-gridlens-roster-revision"] !== undefined && request.headers["x-gridlens-roster-revision"] !== context.rosterRevision) return null;
        return context;
      } catch (error) { if (error instanceof SharedHttpError && [401, 403, 409].includes(error.status)) return null; throw error; }
    },
    async handleRequest(request, response) {
      const url = new URL(request.url ?? "/", "https://gateway.invalid");
      if (privateNetwork && url.pathname === "/connect" && (request.method === "GET" || request.method === "HEAD")) {
        // An explicit empty fragment prevents an old sign-in fragment being inherited.
        response.writeHead(302, { Location: "/#", "Content-Length": 0 }); response.end(); return true;
      }
      if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
        const token = tokenFor(request);
        let authorized = false;
        if (token) {
          try { await call({ operation: "resolve", token }); authorized = true; }
          catch (error) { if (!(error instanceof SharedHttpError && [401, 403, 409].includes(error.status))) throw error; }
        }
        if (!authorized) {
          if (privateNetwork) { sendJson(response, 403, { error: "Private-network access is disabled. Contact the backend operator." }); return true; }
          response.writeHead(302, { Location: "/connect", "Content-Length": 0 }); response.end(); return true;
        }
      }
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
        const token = tokenFor(request), route = url.pathname.slice("/api/shared/".length);
        if (privateNetwork && ["pair", "login", "pair-code", "devices", "revoke"].includes(route)) throw new SharedHttpError(404);
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
          response.setHeader("Set-Cookie", `${cookieName(transport)}=${result.token}; Path=/;${transport === "https" ? " Secure;" : ""} HttpOnly; SameSite=Strict`);
          const { token: _secret, ...publicResult } = result; sendJson(response, 200, publicResult);
        } else sendJson(response, 200, result);
      } catch (error) { sendJson(response, error instanceof SharedHttpError ? error.status : 502, { error: "Shared cache request failed. Check access and retry." }); }
      return true;
    },
  };
}
export async function startSharedGateway(options: { socketPath: string; certPath?: string; keyPath?: string; publicOrigin: string;
  directory: string; host?: string; port?: number; transport?: GatewayTransport; privateNetworkAuthFile?: string; privateNetworkToken?: string }) {
  const transport = options.transport ?? "https";
  validateGatewayOrigin(options.publicOrigin, transport);
  if ((options.privateNetworkAuthFile !== undefined || options.privateNetworkToken !== undefined) && transport !== "vpn-http")
    throw new Error("Private-network access is available only on its explicit HTTP gateway.");
  if (options.privateNetworkAuthFile !== undefined && options.privateNetworkToken !== undefined) throw new Error("Configure only one private-network grant source.");
  let privateNetworkToken = options.privateNetworkToken;
  if (options.privateNetworkAuthFile !== undefined) {
    const file = await open(options.privateNetworkAuthFile, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1024) throw new Error("Invalid private-network grant file.");
      const value = JSON.parse(await file.readFile("utf8")) as { version?: unknown; token?: unknown };
      if (value?.version !== 1 || typeof value.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.token))
        throw new Error("Invalid private-network grant file.");
      privateNetworkToken = value.token;
    } finally { await file.close(); }
  }
  if (transport === "https" && (!options.certPath || !options.keyPath)) throw new Error("HTTPS requires its saved certificate and key.");
  const [html, script, tls] = await Promise.all([
    readFile(join(options.directory, "shared-setup.html")), readFile(join(options.directory, "preview/shared-setup.js")),
    transport === "https" ? Promise.all([readFile(options.certPath!), readFile(options.keyPath!)]).then(([cert, key]) => ({ cert, key })) : undefined,
  ]);
  const integration = createGatewayIntegration(options.socketPath, html, script, { transport,
    ...(privateNetworkToken === undefined ? {} : { privateNetworkToken }) });
  const server: FleetServerOptions = { integration, directory: options.directory, host: options.host ?? "0.0.0.0",
    port: options.port ?? 8443, publicOrigin: options.publicOrigin, ...(tls ? { tls } : {}), accessCheckIntervalMs: 1000 };
  return { server: await startFleetServer(server), integration };
}
