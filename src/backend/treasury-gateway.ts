import type { IncomingMessage, ServerResponse } from "node:http";
import type { TLSSocket } from "node:tls";
import { ownerCall, readJson, sendJson, SharedHttpError } from "./ipc.ts";
import { parseBrowserSecurityStatus } from "../contracts/browser-security.ts";
import type { BrowserSecurityRead } from "./browser-security.ts";

export interface TreasuryGatewayOptions {
  transport: "https" | "vpn-http"; readSocket: string; treasurySocket?: string;
  certificateSha256?: string; html?: Buffer;
  token(request: IncomingMessage): string | null;
}

/** Only the TLS container mounts the financial socket. No request field or proxy
 * header can turn the ordinary read socket into a financial authority. */
export function treasuryGateway(options: TreasuryGatewayOptions) {
  if (options.treasurySocket && options.transport !== "https") throw new Error("Wallet requires the HTTPS gateway.");
  const prefix = "/api/shared/treasury/";
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? "/", "https://invalid.example");
    if (url.pathname !== "/wallet" && !url.pathname.startsWith(prefix) && url.pathname !== prefix.slice(0, -1)) return false;
    const fail = (status: number) => sendJson(response, status, { version: 1, error: status === 403 ? "Wallet requires HTTPS and owner authorization."
      : status === 409 ? "Wallet state changed. Unlock and review it again." : status === 429 ? "Wait before trying the Wallet password again."
        : status === 400 ? "The Wallet request is invalid." : "Wallet is unavailable. Check access and the installed version." });
    response.setHeader("Cache-Control", "no-store"); response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    try {
      if (url.search || (request.url ?? "").split("?", 1)[0] !== url.pathname) throw new SharedHttpError(400);
      if (url.pathname === "/wallet" && options.transport === "vpn-http") {
        if (!["GET", "HEAD"].includes(request.method ?? "")) throw new SharedHttpError(403);
        response.writeHead(303, { Location: "/secure-setup#return=wallet" }); response.end(); return true;
      }
      if (options.transport !== "https" || (request.socket as TLSSocket).encrypted !== true) throw new SharedHttpError(403);
      if (!options.treasurySocket || !options.certificateSha256) throw new SharedHttpError(503);
      const raw = await ownerCall<BrowserSecurityRead>(options.readSocket, { operation: "browser-security" });
      const security = parseBrowserSecurityStatus(raw.status);
      if (!security.available || security.status !== "ready" || security.serverCertificateSha256 !== options.certificateSha256
        || `https://${request.headers.host}` !== security.httpsOrigin) throw new SharedHttpError(403);
      if (url.pathname === "/wallet") {
        if (!["GET", "HEAD"].includes(request.method ?? "")) throw new SharedHttpError(405);
        if (!options.html) throw new SharedHttpError(503);
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": options.html.length,
          "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
        response.end(request.method === "HEAD" ? undefined : options.html); return true;
      }
      const route = url.pathname.slice(prefix.length);
      let operation: string, input: Record<string, unknown>;
      if (request.method === "GET" && ["status", "configuration", "operations"].includes(route)) { operation = route; input = {}; }
      else if (request.method === "GET" && /^operations\/[a-zA-Z0-9-]{1,80}$/.test(route)) { operation = "operations"; input = { id: route.slice(11) }; }
      else {
        const allowed: Record<string, string[]> = { setup: ["ticket", "password", "destinationAddress"], unlock: ["password"], lock: [],
          configuration: ["currentPassword", "destinationAddress", "newPassword"], prepare: ["sourceAddress"], confirm: ["planId", "reviewDigest", "idempotencyKey"] };
        if (request.method !== "POST" || !allowed[route]) throw new SharedHttpError(405);
        if (request.headers.origin !== security.httpsOrigin) throw new SharedHttpError(403);
        operation = route === "configuration" ? "configure" : route;
        input = await readJson(request, 8192);
        if (input.version !== 1) throw new SharedHttpError(400);
        delete input.version;
        if (Object.keys(input).some(key => !allowed[route]!.includes(key))) throw new SharedHttpError(400);
      }
      if (request.headers.origin !== undefined && request.headers.origin !== security.httpsOrigin) throw new SharedHttpError(403);
      const unlockToken = request.headers["x-gridlens-wallet"];
      if (unlockToken !== undefined && (typeof unlockToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(unlockToken))) throw new SharedHttpError(403);
      try {
        const result = await ownerCall(options.treasurySocket, { ...input, operation, token: options.token(request),
          ...(unlockToken === undefined ? {} : { unlockToken }), httpsOrigin: security.httpsOrigin, serverCertificateSha256: options.certificateSha256 }, undefined, 60_000);
        sendJson(response, 200, result);
      } finally { delete input.password; delete input.currentPassword; delete input.newPassword; delete input.ticket; }
    } catch (error) { fail(error instanceof SharedHttpError ? error.status : 503); }
    return true;
  };
}
