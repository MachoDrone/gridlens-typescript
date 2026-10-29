import type { FleetContext } from "./fleet.ts";
import { isFleetRoster } from "./fleet.ts";
import { parseBinding, parseSavedObservation, parsePcNetworkRecord, normalizedIp, time, sameBinding } from "../fleet/pc-observations.ts";
import type { NodeBinding, PcObservation, PcNetworkRecord } from "../fleet/pc-observations.ts";

export const SHARED_VERSION = 1;
export const SHARED_CAPABILITIES = ["shared-cache-v1", "device-pairing-v1", "pc-associations-v1", "pc-network-v1",
  "exact-uptime-rewards-v1", "gpu-history-v1", "operator-setup-v1"] as const;
export interface PcAssociation {
  address: string; binding: NodeBinding; name: string; sshFingerprint: string; verifiedAtMs: number;
  privateIp: string | null; gpuUuids: string[];
}
export interface SharedObservations {
  version: 1; serverId: string; scopeId: string; rosterRevision: string;
  associations: PcAssociation[]; observations: PcObservation[]; networks: PcNetworkRecord[];
  gpuSummaries?: { address: string; sampleCount: number; fromAtMs: number; toAtMs: number; truncated: boolean }[];
}
export function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}
export function parseAssociation(value: unknown, context: FleetContext): PcAssociation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid PC association.");
  const row = value as PcAssociation;
  if (!context.addresses.includes(row.address) || !validId(row.name) || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(row.sshFingerprint)
    || !time(row.verifiedAtMs) || row.privateIp !== null && normalizedIp(row.privateIp) === null
    || !Array.isArray(row.gpuUuids) || row.gpuUuids.length > 64 || row.gpuUuids.some(value =>
      typeof value !== "string" || !/^GPU-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value))
    || new Set(row.gpuUuids).size !== row.gpuUuids.length) throw new Error("Invalid verified PC association.");
  return { address: row.address, binding: parseBinding(row.binding), name: row.name, sshFingerprint: row.sshFingerprint,
    verifiedAtMs: row.verifiedAtMs, privateIp: row.privateIp, gpuUuids: [...row.gpuUuids] };
}
export function parseSharedObservations(value: unknown, serverId: string, context: FleetContext): SharedObservations {
  if (!value || typeof value !== "object" || Array.isArray(value) || !isFleetRoster(context.addresses)) throw new Error("Invalid shared observations.");
  const input = value as SharedObservations;
  if (input.version !== 1 || input.serverId !== serverId || input.scopeId !== context.scopeId || input.rosterRevision !== context.rosterRevision
    || !Array.isArray(input.associations) || !Array.isArray(input.observations) || !Array.isArray(input.networks)
    || [input.associations, input.observations, input.networks].some(rows => rows.length > 10_000)) throw new Error("Shared fleet identity changed.");
  const associations = input.associations.map(row => parseAssociation(row, context));
  if (new Set(associations.map(row => row.address)).size !== associations.length) throw new Error("Duplicate PC association.");
  const bindings = new Map(associations.map(row => [row.address, row.binding]));
  const pcs = new Set(associations.map(row => row.binding.pcId));
  const observations = input.observations.map(parseSavedObservation);
  const networks = input.networks.map(parsePcNetworkRecord);
  if (new Set(observations.map(row => row.address)).size !== observations.length || new Set(networks.map(row => row.pcId)).size !== networks.length
    || observations.some(row => !bindings.has(row.address) || !sameBinding(row.binding, bindings.get(row.address)!))
    || networks.some(row => !pcs.has(row.pcId))) throw new Error("Observation is outside the verified fleet bindings.");
  if (input.gpuSummaries !== undefined && (!Array.isArray(input.gpuSummaries) || input.gpuSummaries.length > context.addresses.length
    || new Set(input.gpuSummaries.map(row => row.address)).size !== input.gpuSummaries.length
    || input.gpuSummaries.some(row => !bindings.has(row.address) || !Number.isSafeInteger(row.sampleCount) || row.sampleCount < 0 || row.sampleCount > 6000
      || !time(row.fromAtMs) || !time(row.toAtMs) || row.toAtMs < row.fromAtMs || row.toAtMs - row.fromAtMs > 7 * 86_400_000 || typeof row.truncated !== "boolean")))
    throw new Error("Invalid GPU summary.");
  return { version: 1, serverId, scopeId: context.scopeId, rosterRevision: context.rosterRevision, associations, observations, networks,
    ...(input.gpuSummaries ? { gpuSummaries: structuredClone(input.gpuSummaries) } : {}) };
}
