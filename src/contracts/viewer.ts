import { FLEET_RESOURCES } from "./fleet.ts";

export interface ViewerInvite {
  version: 1; kind: "gridlens-viewer-invite"; ownerOrigin: string; serverId: string;
  caCertificatePem: string; serverCertificateSha256: string; code: string; expiresAtMs: number;
}
/** Backend-only credential. Never serialize this object into browser responses. */
export interface ViewerConfiguration {
  version: 1; ownerOrigin: string; serverId: string; caCertificatePem: string;
  serverCertificateSha256: string; token: string; scopeId: string;
}
const fields: Record<string, readonly string[]> = {
  resolve: [], status: [], observations: [], snapshot: ["resource", "scopeId", "rosterRevision"],
  "gpu-history": ["address", "fromAtMs", "toAtMs"], "history-request": ["addresses", "rosterRevision", "refresh"],
};
export const VIEWER_OPERATIONS = Object.freeze(Object.keys(fields));
export function parseViewerRequest(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid viewer request.");
  const body = value as Record<string, unknown>, operation = body.operation;
  if (typeof operation !== "string" || !Object.hasOwn(fields, operation)
    || Object.keys(body).some(key => key !== "operation" && !fields[operation]!.includes(key))
    || fields[operation]!.some(key => !Object.hasOwn(body, key))) throw new Error("Viewer operation is unavailable.");
  const identifier = (input: unknown): boolean => typeof input === "string" && input.length > 0 && input.length <= 256 && !/[\u0000-\u001f\u007f]/.test(input);
  if (operation === "snapshot" && (!FLEET_RESOURCES.includes(body.resource as never) || !identifier(body.scopeId) || !identifier(body.rosterRevision))) throw new Error("Invalid viewer snapshot.");
  if (operation === "gpu-history" && (!identifier(body.address) || !Number.isSafeInteger(body.fromAtMs) || !Number.isSafeInteger(body.toAtMs)
    || Number(body.fromAtMs) < 0 || Number(body.toAtMs) < Number(body.fromAtMs) || Number(body.toAtMs) - Number(body.fromAtMs) > 7 * 86_400_000)) throw new Error("Invalid viewer history.");
  if (operation === "history-request" && (!identifier(body.rosterRevision) || typeof body.refresh !== "boolean" || !Array.isArray(body.addresses)
    || body.addresses.length < 1 || body.addresses.length > 100 || !body.addresses.every(identifier) || new Set(body.addresses).size !== body.addresses.length)) throw new Error("Invalid viewer history selection.");
  return structuredClone(body);
}
