import { createHash, X509Certificate } from "node:crypto";
import { request } from "node:https";
import { checkServerIdentity } from "node:tls";
import { privateAddress } from "../installer/config.ts";
import { parseViewerRequest } from "../contracts/viewer.ts";
import type { ViewerConfiguration, ViewerInvite } from "../contracts/viewer.ts";
import type { FleetContext } from "../contracts/fleet.ts";
import { validateFleetContext } from "../server/snapshot-store.ts";

export type ViewerClientConfiguration = ViewerConfiguration;
export class ViewerClientError extends Error {
  readonly status: number;
  constructor(status = 502) { super("The saved owner viewer connection is unavailable."); this.status = status; }
}
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("|") !== [...fields].sort().join("|")) throw new ViewerClientError(400);
  return value as Record<string, unknown>;
}
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
export function viewerOwnerOrigin(value: unknown): string {
  if (typeof value !== "string") throw new ViewerClientError(400);
  let url: URL; try { url = new URL(value); } catch { throw new ViewerClientError(400); }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || !privateAddress(hostname) || !/^\d+$/.test(url.port) || Number(url.port) < 1024 || Number(url.port) > 65535) throw new ViewerClientError(400);
  return url.origin;
}
function certificate(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > 16_384 || value.includes("PRIVATE")
    || !/^-----BEGIN CERTIFICATE-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END CERTIFICATE-----$/.test(value.trim())) throw new ViewerClientError(400);
  try { const parsed = new X509Certificate(value); if (!parsed.ca) throw Error(); return parsed.toString(); }
  catch { throw new ViewerClientError(400); }
}
function binding(row: Record<string, unknown>) {
  if (!id(row.serverId) || typeof row.serverCertificateSha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.serverCertificateSha256)) throw new ViewerClientError(400);
  return { ownerOrigin: viewerOwnerOrigin(row.ownerOrigin), serverId: row.serverId, caCertificatePem: certificate(row.caCertificatePem), serverCertificateSha256: row.serverCertificateSha256 };
}
export function parseViewerConfiguration(value: unknown): ViewerConfiguration {
  const row = record(value, ["version", "ownerOrigin", "serverId", "caCertificatePem", "serverCertificateSha256", "token", "scopeId"]);
  if (row.version !== 1 || typeof row.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(row.token) || !id(row.scopeId)) throw new ViewerClientError(400);
  return { version: 1, ...binding(row), token: row.token, scopeId: row.scopeId };
}
export function parseViewerInvite(value: unknown, now = Date.now()): ViewerInvite {
  const row = record(value, ["version", "kind", "ownerOrigin", "serverId", "caCertificatePem", "serverCertificateSha256", "code", "expiresAtMs"]);
  if (row.version !== 1 || row.kind !== "gridlens-viewer-invite" || typeof row.code !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(row.code)
    || !Number.isSafeInteger(row.expiresAtMs) || Number(row.expiresAtMs) <= now || Number(row.expiresAtMs) > 8_640_000_000_000_000) throw new ViewerClientError(400);
  return { version: 1, kind: "gridlens-viewer-invite", ...binding(row), code: row.code, expiresAtMs: Number(row.expiresAtMs) };
}
type Binding = Pick<ViewerConfiguration, "ownerOrigin" | "caCertificatePem" | "serverCertificateSha256">;
/** No redirects, cookies, ambient trust override or arbitrary URL. The token is
 * sent only after CA/hostname validation and the exact saved leaf pin succeed. */
async function post(target: Binding, path: "/api/shared/pair" | "/api/shared/viewer/read", body: unknown, token?: string, signal?: AbortSignal): Promise<unknown> {
  const encoded = Buffer.from(JSON.stringify(body)); if (encoded.length > 256 * 1024) throw new ViewerClientError(400);
  const url = new URL(path, target.ownerOrigin), abort = AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]);
  return new Promise((resolve, reject) => {
    const fail = (status = 502): void => reject(new ViewerClientError(status));
    const req = request(url, { method: "POST", agent: false, ca: target.caCertificatePem, rejectUnauthorized: true, minVersion: "TLSv1.2", servername: "",
      signal: abort, checkServerIdentity(hostname, peer) {
        const error = checkServerIdentity(hostname, peer); if (error) return error;
        if (!peer.raw || createHash("sha256").update(peer.raw).digest("hex") !== target.serverCertificateSha256) return new ViewerClientError();
        return undefined;
      }, headers: { "Content-Type": "application/json", "Content-Length": encoded.length, Origin: target.ownerOrigin,
        ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, response => {
      if (response.statusCode !== 200) { response.resume(); fail([401, 403, 409, 429].includes(response.statusCode ?? 0) ? response.statusCode : 502); return; }
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 16 * 1024 * 1024) response.destroy(new ViewerClientError()); else chunks.push(chunk); });
      response.on("error", () => fail());
      response.on("end", () => { try { resolve(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))); } catch { fail(); } });
    });
    req.on("error", () => fail(abort.aborted ? 504 : 502)); req.end(encoded);
  });
}
function context(value: unknown, scopeId?: string): FleetContext {
  validateFleetContext(value);
  if (scopeId !== undefined && value.scopeId !== scopeId) throw new ViewerClientError(403);
  return { scopeId: value.scopeId, rosterRevision: value.rosterRevision, addresses: [...value.addresses] };
}
export async function redeemViewerInvite(value: unknown, deviceName: string, now = Date.now): Promise<ViewerConfiguration> {
  const invite = parseViewerInvite(value, now());
  if (!id(deviceName) || deviceName.length > 80) throw new ViewerClientError(400);
  const result = await post(invite, "/api/shared/pair", { version: 1, code: invite.code, deviceName }) as Record<string, unknown>;
  if (!result || result.version !== 1 || result.serverId !== invite.serverId || result.role !== "viewer") throw new ViewerClientError(403);
  const selected = context(result.context);
  return parseViewerConfiguration({ version: 1, ownerOrigin: invite.ownerOrigin, serverId: invite.serverId, caCertificatePem: invite.caCertificatePem,
    serverCertificateSha256: invite.serverCertificateSha256, token: result.token, scopeId: selected.scopeId });
}
export function createViewerClient(input: unknown) {
  const config = parseViewerConfiguration(input), closing = new AbortController();
  async function read<T = unknown>(input: unknown, signal?: AbortSignal): Promise<T> {
    const body = parseViewerRequest(input);
    if (body.operation === "snapshot" && body.scopeId !== config.scopeId) throw new ViewerClientError(403);
    const raw = await post(config, "/api/shared/viewer/read", body, config.token,
      AbortSignal.any([closing.signal, ...(signal ? [signal] : [])]));
    const envelope = record(raw, ["version", "role", "serverId", "scopeId", "result"]);
    if (envelope.version !== 1 || envelope.role !== "viewer" || envelope.serverId !== config.serverId || envelope.scopeId !== config.scopeId) throw new ViewerClientError(403);
    return envelope.result as T;
  }
  return {
    async resolve(signal?: AbortSignal): Promise<FleetContext> { return context(await read({ operation: "resolve" }, signal), config.scopeId); },
    async status(signal?: AbortSignal) {
      const result = await read<Record<string, unknown>>({ operation: "status" }, signal);
      if (!result || result.version !== 1 || result.role !== "viewer" || result.serverId !== config.serverId) throw new ViewerClientError(403);
      return { version: 1, serverId: config.serverId, role: "viewer" as const, context: context(result.context, config.scopeId),
        canManageDevices: false, viewerOnly: true, capabilities: ["shared-cache-v1", "pc-associations-v1", "gpu-history-v1"] };
    },
    read,
    close() { closing.abort(); },
    serverId: config.serverId,
  };
}
export type ViewerClient = ReturnType<typeof createViewerClient>;
