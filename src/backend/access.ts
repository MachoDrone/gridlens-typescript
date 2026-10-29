import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FleetContext } from "../contracts/fleet.ts";
import { validateFleetContext } from "../server/snapshot-store.ts";

export interface PrivateState {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  batch?(entries: readonly (readonly [string, unknown])[]): void;
}
export type DeviceRole = "operator" | "viewer";
export interface DeviceAccess { deviceId: string; name: string; role: DeviceRole; context: FleetContext }
interface Device { id: string; name: string; role: DeviceRole; scopeId: string; rosterRevision: string; hash: string; revokedAtMs: number | null }
interface PairCode { hash: string; scopeId: string; rosterRevision: string; role: DeviceRole; expiresAtMs: number }
interface AccessState { version: 1; serverId: string; fleets: FleetContext[]; devices: Device[]; codes: PairCode[]; attempts: number[] }
interface GatewayGrant { id: string; scopeId: string; hash: string; revokedAtMs: number | null }
interface GatewayState { version: 1; grants: GatewayGrant[] }
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const boundedName = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 80 && !/[\u0000-\u001f\u007f]/.test(value);

/** Owner-only access ledger. Raw bearer credentials and connection codes are never persisted. */
export function createAccess(state: PrivateState, now = Date.now) {
  const key = "access.v1";
  const saved = state.get<AccessState>(key);
  if (saved && (saved.version !== 1 || typeof saved.serverId !== "string" || !Array.isArray(saved.fleets)
    || !Array.isArray(saved.devices) || !Array.isArray(saved.codes) || !Array.isArray(saved.attempts))) throw new Error("Invalid access ledger.");
  saved?.fleets.forEach(validateFleetContext);
  let ledger: AccessState = saved ?? { version: 1, serverId: randomUUID(), fleets: [], devices: [], codes: [], attempts: [] };
  if (!saved) state.set(key, ledger);
  const gatewayKey = "gateway-access.v1";
  const savedGateways = state.get<GatewayState>(gatewayKey);
  let gateways: GatewayState = savedGateways === undefined ? { version: 1, grants: [] } : savedGateways;
  if (!gateways || gateways.version !== 1 || !Array.isArray(gateways.grants) || gateways.grants.length > 32
    || gateways.grants.some(grant => !grant || typeof grant.id !== "string" || !/^[a-f0-9-]{36}$/.test(grant.id)
      || typeof grant.scopeId !== "string" || !grant.scopeId.length || grant.scopeId.length > 256 || /[\u0000-\u001f\u007f]/.test(grant.scopeId)
      || typeof grant.hash !== "string" || !/^[a-f0-9]{64}$/.test(grant.hash)
      || grant.revokedAtMs !== null && (!Number.isSafeInteger(grant.revokedAtMs) || grant.revokedAtMs < 0))
    || new Set(gateways.grants.map(grant => grant.scopeId)).size !== gateways.grants.length
    || new Set(gateways.grants.map(grant => grant.hash)).size !== gateways.grants.length)
    throw new Error("Invalid private-network gateway ledger.");
  function mutateGateways(change: (next: GatewayState) => void): void {
    const next = structuredClone(gateways); change(next); state.set(gatewayKey, next); gateways = next;
  }
  function mutate(change: (next: AccessState) => void): void {
    const next = structuredClone(ledger); change(next); state.set(key, next); ledger = next;
  }
  function fleet(scopeId: string): FleetContext {
    const context = ledger.fleets.find(value => value.scopeId === scopeId);
    if (!context) throw new Error("Unknown fleet.");
    return structuredClone(context);
  }
  function resolve(token: unknown): DeviceAccess | null {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const tokenHash = hash(token);
    const gateway = gateways.grants.find(value => value.hash === tokenHash && value.revokedAtMs === null);
    if (gateway) {
      // The terminal grants this gateway one fleet, including that fleet's later
      // revisions. Paired devices below retain their original exact-revision rule.
      const context = ledger.fleets.find(value => value.scopeId === gateway.scopeId);
      return context ? { deviceId: gateway.id, name: "Private-network web gateway", role: "operator", context: structuredClone(context) } : null;
    }
    const device = ledger.devices.find(value => value.hash === tokenHash && value.revokedAtMs === null);
    if (!device) return null;
    const context = ledger.fleets.find(value => value.scopeId === device.scopeId && value.rosterRevision === device.rosterRevision);
    return context ? { deviceId: device.id, name: device.name, role: device.role, context: structuredClone(context) } : null;
  }
  function requireAccess(token: unknown, role?: DeviceRole): DeviceAccess {
    const access = resolve(token);
    if (!access || role === "operator" && access.role !== role) throw new AccessError("denied");
    return access;
  }
  function createCode(scopeId: string, role: DeviceRole) {
    if (role !== "operator" && role !== "viewer") throw new Error("Invalid device role.");
    const context = fleet(scopeId), code = randomBytes(9).toString("base64url");
    const expiresAtMs = now() + 5 * 60_000;
    mutate(next => {
      next.codes = next.codes.filter(value => value.expiresAtMs > now()).slice(-31);
      next.codes.push({ hash: hash(code), scopeId, rosterRevision: context.rosterRevision, role, expiresAtMs });
    });
    return { version: 1 as const, serverId: ledger.serverId, context, code, expiresAtMs };
  }
  return {
    get serverId(): string { return ledger.serverId; },
    contexts: (): FleetContext[] => structuredClone(ledger.fleets), fleet, resolve, requireAccess, createCode,
    registerGateway(scopeId: string, token: unknown) {
      const context = fleet(scopeId);
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AccessError("invalid");
      const tokenHash = hash(token), existing = gateways.grants.find(value => value.scopeId === scopeId);
      if (existing && (existing.revokedAtMs !== null || existing.hash !== tokenHash)
        || ledger.devices.some(value => value.hash === tokenHash)
        || gateways.grants.some(value => value.hash === tokenHash && value.scopeId !== scopeId)) throw new AccessError("denied");
      const grant = existing ?? { id: randomUUID(), scopeId, hash: tokenHash, revokedAtMs: null };
      if (!existing) mutateGateways(next => {
        if (next.grants.length >= 32) throw new Error("Gateway capacity reached.");
        next.grants.push(grant);
      });
      return { version: 1 as const, serverId: ledger.serverId, gatewayId: grant.id, scopeId, role: "operator" as const, context };
    },
    revokeGateway(scopeId: string): void {
      const grant = gateways.grants.find(value => value.scopeId === scopeId);
      if (!grant) throw new AccessError("denied");
      if (grant.revokedAtMs === null) mutateGateways(next => { next.grants.find(value => value.scopeId === scopeId)!.revokedAtMs = now(); });
    },
    setFleet(scopeId: string, addresses: readonly string[]): FleetContext {
      const prior = ledger.fleets.find(value => value.scopeId === scopeId);
      if (prior && JSON.stringify(prior.addresses) === JSON.stringify(addresses)) return structuredClone(prior);
      const context: FleetContext = { scopeId, rosterRevision: randomUUID(), addresses: [...addresses] };
      validateFleetContext(context);
      if (addresses.length > 10_000) throw new Error("Fleet exceeds capacity.");
      mutate(next => {
        if (!prior && next.fleets.length >= 32) throw new Error("Fleet capacity reached.");
        next.fleets = [...next.fleets.filter(value => value.scopeId !== scopeId), context];
        next.codes = next.codes.filter(value => value.scopeId !== scopeId);
        // Devices must explicitly reconnect to the new revision. An IP match never transfers access.
      });
      return structuredClone(context);
    },
    pair(code: unknown, deviceName: unknown) {
      if (typeof code !== "string" || code.length > 64 || !boundedName(deviceName)) throw new AccessError("invalid");
      const time = now();
      if (ledger.attempts.filter(at => at > time - 60_000).length >= 20) throw new AccessError("paused");
      // Reserve attempts durably before checking a secret, including unsuccessful attempts.
      mutate(next => { next.attempts = next.attempts.filter(at => at > time - 60_000); next.attempts.push(time); });
      const selected = ledger.codes.find(value => value.hash === hash(code) && value.expiresAtMs > time);
      if (!selected) throw new AccessError("denied");
      const context = fleet(selected.scopeId);
      if (context.rosterRevision !== selected.rosterRevision) throw new AccessError("denied");
      const token = randomBytes(32).toString("base64url"), deviceId = randomUUID();
      mutate(next => {
        if (next.devices.length >= 4096) throw new Error("Device capacity reached.");
        next.codes = next.codes.filter(value => value.hash !== selected.hash);
        next.devices.push({ id: deviceId, name: deviceName, role: selected.role, scopeId: selected.scopeId,
          rosterRevision: selected.rosterRevision, hash: hash(token), revokedAtMs: null });
      });
      return { version: 1 as const, serverId: ledger.serverId, deviceId, token, role: selected.role, context };
    },
    devices(token: unknown) {
      const access = requireAccess(token, "operator");
      return ledger.devices.filter(value => value.scopeId === access.context.scopeId).map(value => ({
        deviceId: value.id, name: value.name, role: value.role, revokedAtMs: value.revokedAtMs,
        rosterRevision: value.rosterRevision,
      }));
    },
    revoke(token: unknown, deviceId: unknown): void {
      const access = requireAccess(token, "operator");
      mutate(next => {
        const device = next.devices.find(value => value.id === deviceId && value.scopeId === access.context.scopeId);
        if (!device) throw new AccessError("denied");
        device.revokedAtMs ??= now();
      });
    },
  };
}
export type SharedAccess = ReturnType<typeof createAccess>;
export class AccessError extends Error {
  readonly kind: "denied" | "invalid" | "paused";
  constructor(kind: AccessError["kind"]) { super("Shared Fleet access is unavailable."); this.kind = kind; }
}
