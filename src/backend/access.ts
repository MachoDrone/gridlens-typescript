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
interface Device { id: string; name: string; role: DeviceRole; scopeId: string; rosterRevision: string; hash: string; revokedAtMs: number | null; followRoster?: true; ownerDevice?: true }
interface PairCode { hash: string; scopeId: string; rosterRevision: string; role: DeviceRole; expiresAtMs: number; followRoster?: true; ownerDevice?: true }
interface AccessState { version: 1; serverId: string; fleets: FleetContext[]; devices: Device[]; codes: PairCode[]; attempts: number[] }
interface GatewayGrant { id: string; scopeId: string; hash: string; revokedAtMs: number | null }
interface GatewayState { version: 1; grants: GatewayGrant[] }
interface SecureBrowserTicket { hash: string; parentGatewayId: string; scopeId: string; rosterRevision: string; bindingHash: string; expiresAtMs: number }
interface SecureBrowserSession { id: string; hash: string; parentGatewayId: string; scopeId: string; revokedAtMs: number | null }
interface SecureBrowserState { version: 1; tickets: SecureBrowserTicket[]; sessions: SecureBrowserSession[]; issuanceAttempts: number[]; redemptionAttempts: number[] }
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const boundedName = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 80 && !/[\u0000-\u001f\u007f]/.test(value);
const validIdentifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
const validHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const validTime = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const validUuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);

/** Owner-only access ledger. Raw bearer credentials and connection codes are never persisted. */
export function createAccess(state: PrivateState, now = Date.now, options: { protectedMode?: boolean } = {}) {
  const protectionKey = "access.owner-bound.v1";
  const protection = state.get<{ version: 1; activatedAtMs: number }>(protectionKey);
  if (protection !== undefined && (!protection || protection.version !== 1 || !validTime(protection.activatedAtMs)
    || Object.keys(protection).some(key => !["version", "activatedAtMs"].includes(key)))) throw new Error("Invalid protected access state.");
  const protectedMode = options.protectedMode === true || protection !== undefined;
  // Administrative browser access is short-lived and never grants Wallet unlock.
  // Its parent credential stays in memory only, like an active Wallet session.
  const ownerSessions = new Map<string, { id: string; parentToken: string; parentId: string; scopeId: string; expiresAtMs: number }>();
  const key = "access.v1";
  const saved = state.get<AccessState>(key);
  if (saved && (saved.version !== 1 || typeof saved.serverId !== "string" || !Array.isArray(saved.fleets)
    || !Array.isArray(saved.devices) || !Array.isArray(saved.codes) || !Array.isArray(saved.attempts))) throw new Error("Invalid access ledger.");
  saved?.fleets.forEach(validateFleetContext);
  let ledger: AccessState = saved ?? { version: 1, serverId: randomUUID(), fleets: [], devices: [], codes: [], attempts: [] };
  if (!saved) state.set(key, ledger);
  const gatewayKey = protectedMode ? "gateway-access.owner-bound.v1" : "gateway-access.v1";
  const savedGateways = state.get<GatewayState>(gatewayKey)
    ?? (protectedMode && protection === undefined ? state.get<GatewayState>("gateway-access.v1") : undefined);
  if (protection && savedGateways === undefined) throw new Error("Protected gateway state requires recovery.");
  let gateways: GatewayState = savedGateways === undefined ? { version: 1, grants: [] } : savedGateways;
  if (!gateways || gateways.version !== 1 || !Array.isArray(gateways.grants) || gateways.grants.length > 32
    || gateways.grants.some(grant => !grant || typeof grant.id !== "string" || !/^[a-f0-9-]{36}$/.test(grant.id)
      || typeof grant.scopeId !== "string" || !grant.scopeId.length || grant.scopeId.length > 256 || /[\u0000-\u001f\u007f]/.test(grant.scopeId)
      || typeof grant.hash !== "string" || !/^[a-f0-9]{64}$/.test(grant.hash)
      || grant.revokedAtMs !== null && (!Number.isSafeInteger(grant.revokedAtMs) || grant.revokedAtMs < 0))
    || new Set(gateways.grants.map(grant => grant.scopeId)).size !== gateways.grants.length
    || new Set(gateways.grants.map(grant => grant.hash)).size !== gateways.grants.length)
    throw new Error("Invalid private-network gateway ledger.");
  // Older runtimes must reject these credentials by not knowing this namespace;
  // placing them in access.v1.devices would silently remove their parent constraint.
  const secureBrowserKey = protectedMode ? "secure-browser-access.owner-bound.v1" : "secure-browser-access.v1";
  const savedSecureBrowser = state.get<SecureBrowserState>(secureBrowserKey)
    ?? (protectedMode && protection === undefined ? state.get<SecureBrowserState>("secure-browser-access.v1") : undefined);
  if (protection && savedSecureBrowser === undefined) throw new Error("Protected browser state requires recovery.");
  let secureBrowser: SecureBrowserState = savedSecureBrowser === undefined
    ? { version: 1, tickets: [], sessions: [], issuanceAttempts: [], redemptionAttempts: [] } : savedSecureBrowser;
  if (!secureBrowser || secureBrowser.version !== 1 || Object.keys(secureBrowser).some(field => !["version", "tickets", "sessions", "issuanceAttempts", "redemptionAttempts"].includes(field))
    || !Array.isArray(secureBrowser.tickets) || secureBrowser.tickets.length > 128 || !Array.isArray(secureBrowser.sessions) || secureBrowser.sessions.length > 4096
    || !Array.isArray(secureBrowser.issuanceAttempts) || secureBrowser.issuanceAttempts.length > 20 || secureBrowser.issuanceAttempts.some(at => !validTime(at))
    || !Array.isArray(secureBrowser.redemptionAttempts) || secureBrowser.redemptionAttempts.length > 20 || secureBrowser.redemptionAttempts.some(at => !validTime(at))
    || secureBrowser.tickets.some(ticket => !ticket || !validHash(ticket.hash) || !validUuid(ticket.parentGatewayId) || !validIdentifier(ticket.scopeId)
      || !validIdentifier(ticket.rosterRevision) || !validHash(ticket.bindingHash) || !validTime(ticket.expiresAtMs)
      || Object.keys(ticket).some(field => !["hash", "parentGatewayId", "scopeId", "rosterRevision", "bindingHash", "expiresAtMs"].includes(field)))
    || secureBrowser.sessions.some(session => !session || !validUuid(session.id) || !validHash(session.hash) || !validUuid(session.parentGatewayId)
      || !validIdentifier(session.scopeId) || session.revokedAtMs !== null && !validTime(session.revokedAtMs)
      || Object.keys(session).some(field => !["id", "hash", "parentGatewayId", "scopeId", "revokedAtMs"].includes(field)))
    || new Set(secureBrowser.tickets.map(ticket => ticket.hash)).size !== secureBrowser.tickets.length
    || new Set(secureBrowser.sessions.map(session => session.hash)).size !== secureBrowser.sessions.length
    || new Set(secureBrowser.sessions.map(session => session.id)).size !== secureBrowser.sessions.length)
    throw new Error("Invalid secure-browser access ledger.");
  if (protectedMode && protection === undefined) {
    // Keep existing browser tokens working as viewers, but retire their old
    // operator interpretation. This migration is atomic and survives rollback.
    if (!state.batch) throw new Error("Protected access requires transactional state.");
    const at = now(); if (!validTime(at)) throw new Error("Invalid protection activation time.");
    ledger = { ...ledger, devices: ledger.devices.map(device => { const next = { ...device, role: "viewer" as const }; delete next.ownerDevice; return next; }),
      codes: ledger.codes.map(code => { const next = { ...code, role: "viewer" as const }; delete next.ownerDevice; return next; }) };
    state.batch([
      [key, ledger],
      [gatewayKey, gateways], [secureBrowserKey, secureBrowser],
      ["gateway-access.v1", { version: 1, grants: gateways.grants.map(grant => ({ ...grant, revokedAtMs: grant.revokedAtMs ?? at })) }],
      ["secure-browser-access.v1", { ...secureBrowser, tickets: [], sessions: secureBrowser.sessions.map(session => ({ ...session, revokedAtMs: session.revokedAtMs ?? at })) }],
      [protectionKey, { version: 1, activatedAtMs: at }],
    ]);
  }
  function mutateSecureBrowser(change: (next: SecureBrowserState) => void): void {
    const next = structuredClone(secureBrowser); change(next); state.set(secureBrowserKey, next); secureBrowser = next;
  }
  function reserveBrowserAttempt(kind: "issuanceAttempts" | "redemptionAttempts"): number {
    const at = now(); if (!validTime(at)) throw new AccessError("invalid");
    if (secureBrowser[kind].filter(time => time > at - 60_000).length >= 20) throw new AccessError("paused");
    mutateSecureBrowser(next => {
      next[kind] = next[kind].filter(time => time > at - 60_000); next[kind].push(at);
      next.tickets = next.tickets.filter(ticket => ticket.expiresAtMs > at);
    });
    return at;
  }
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
    const ownerSession = ownerSessions.get(tokenHash);
    if (ownerSession) {
      const at = now();
      if (ownerSession.expiresAtMs <= at || ownerSession.expiresAtMs > at + 300_000) { ownerSessions.delete(tokenHash); return null; }
      const parent = resolve(ownerSession.parentToken);
      if (!parent || parent.deviceId !== ownerSession.parentId || parent.context.scopeId !== ownerSession.scopeId) return null;
      return { ...parent, deviceId: ownerSession.id, name: "Owner browser", role: "operator" };
    }
    const gateway = gateways.grants.find(value => value.hash === tokenHash && value.revokedAtMs === null);
    if (gateway) {
      // The terminal grants this gateway one fleet, including that fleet's later
      // revisions. Paired devices below retain their original exact-revision rule.
      const context = ledger.fleets.find(value => value.scopeId === gateway.scopeId);
      return context ? { deviceId: gateway.id, name: "Private-network web gateway", role: protectedMode ? "viewer" : "operator", context: structuredClone(context) } : null;
    }
    const browser = secureBrowser.sessions.find(value => value.hash === tokenHash && value.revokedAtMs === null);
    if (browser) {
      const parent = gateways.grants.find(value => value.id === browser.parentGatewayId && value.scopeId === browser.scopeId && value.revokedAtMs === null);
      const context = parent && ledger.fleets.find(value => value.scopeId === parent.scopeId);
      return context ? { deviceId: browser.id, name: "Secure browser", role: protectedMode ? "viewer" : "operator", context: structuredClone(context) } : null;
    }
    const device = ledger.devices.find(value => value.hash === tokenHash && value.revokedAtMs === null);
    if (!device) return null;
    const role = protectedMode && device.role === "operator" && device.ownerDevice !== true ? "viewer" : device.role;
    const context = ledger.fleets.find(value => value.scopeId === device.scopeId && (role === "viewer" && device.followRoster === true
      || role === "operator" && device.ownerDevice === true || value.rosterRevision === device.rosterRevision));
    return context ? { deviceId: device.id, name: device.name, role, context: structuredClone(context) } : null;
  }
  function requireAccess(token: unknown, role?: DeviceRole): DeviceAccess {
    const access = resolve(token);
    if (!access || role === "operator" && access.role !== role) throw new AccessError("denied");
    return access;
  }
  function isDerivedSecureBrowser(token: unknown): boolean {
    const principal = resolve(token);
    return principal !== null && secureBrowser.sessions.some(session => session.id === principal.deviceId);
  }
  function requireDeviceAdministration(token: unknown): DeviceAccess {
    const access = requireAccess(token, "operator");
    if (secureBrowser.sessions.some(session => session.id === access.deviceId)) throw new AccessError("denied");
    return access;
  }
  function createCode(scopeId: string, role: DeviceRole, options: { followRoster?: true } = {}) {
    if (role !== "operator" && role !== "viewer") throw new Error("Invalid device role.");
    if (options.followRoster && role !== "viewer") throw new Error("Only an explicitly shared viewer grant can follow a fleet.");
    const context = fleet(scopeId), code = randomBytes(9).toString("base64url");
    const expiresAtMs = now() + 5 * 60_000;
    mutate(next => {
      next.codes = next.codes.filter(value => value.expiresAtMs > now()).slice(-31);
      next.codes.push({ hash: hash(code), scopeId, rosterRevision: context.rosterRevision, role, expiresAtMs,
        ...(options.followRoster ? { followRoster: true } : {}), ...(protectedMode && role === "operator" ? { ownerDevice: true } : {}) });
    });
    return { version: 1 as const, serverId: ledger.serverId, context, code, expiresAtMs };
  }
  return {
    get serverId(): string { return ledger.serverId; },
    get protectedMode(): boolean { return protectedMode; },
    issueOwnerBrowser(token: unknown) {
      if (!protectedMode || typeof token !== "string" || ownerSessions.has(hash(token))) throw new AccessError("denied");
      const parent = requireAccess(token), at = now();
      if (!validTime(at)) throw new AccessError("denied");
      for (const [key, value] of ownerSessions) if (value.parentId === parent.deviceId || value.expiresAtMs <= at) ownerSessions.delete(key);
      if (ownerSessions.size >= 16) throw new AccessError("paused");
      const ownerToken = randomBytes(32).toString("base64url"), expiresAtMs = at + 300_000;
      ownerSessions.set(hash(ownerToken), { id: randomUUID(), parentToken: token, parentId: parent.deviceId, scopeId: parent.context.scopeId, expiresAtMs });
      return { version: 1 as const, ownerToken, expiresAtMs };
    },
    ownerBrowserMatches(token: unknown, ownerToken: unknown): boolean {
      if (typeof token !== "string" || typeof ownerToken !== "string") return false;
      const session = ownerSessions.get(hash(ownerToken));
      return session?.parentToken === token && resolve(ownerToken)?.role === "operator";
    },
    clearOwnerBrowsers(): void { ownerSessions.clear(); },
    contexts: (): FleetContext[] => structuredClone(ledger.fleets), fleet, resolve, requireAccess, isDerivedSecureBrowser, requireDeviceAdministration, createCode,
    createSecureBrowserCode(token: unknown, bindingHash: string) {
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token) || !validHash(bindingHash)) throw new AccessError("denied");
      const parent = gateways.grants.find(value => value.hash === hash(token) && value.revokedAtMs === null);
      if (!parent) throw new AccessError("denied");
      const context = fleet(parent.scopeId), at = reserveBrowserAttempt("issuanceAttempts"), code = randomBytes(32).toString("base64url"), expiresAtMs = at + 300_000;
      mutateSecureBrowser(next => {
        if (next.tickets.length >= 128 || next.sessions.length >= 4096) throw new AccessError("paused");
        next.tickets.push({ hash: hash(code), parentGatewayId: parent.id, scopeId: parent.scopeId, rosterRevision: context.rosterRevision, bindingHash, expiresAtMs });
      });
      return { version: 1 as const, code, expiresAtMs };
    },
    redeemSecureBrowserCode(code: unknown, bindingHash: string) {
      const at = reserveBrowserAttempt("redemptionAttempts");
      if (typeof code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(code) || !validHash(bindingHash)) throw new AccessError("denied");
      const ticket = secureBrowser.tickets.find(value => value.hash === hash(code) && value.expiresAtMs > at && value.expiresAtMs <= at + 300_000);
      const parent = ticket && gateways.grants.find(value => value.id === ticket.parentGatewayId && value.scopeId === ticket.scopeId && value.revokedAtMs === null);
      if (!ticket || !parent || ticket.bindingHash !== bindingHash) throw new AccessError("denied");
      const context = fleet(parent.scopeId);
      if (context.rosterRevision !== ticket.rosterRevision) throw new AccessError("denied");
      const token = randomBytes(32).toString("base64url"), deviceId = randomUUID();
      mutateSecureBrowser(next => {
        if (next.sessions.length >= 4096) throw new AccessError("paused");
        next.tickets = next.tickets.filter(value => value.hash !== ticket.hash);
        next.sessions.push({ id: deviceId, hash: hash(token), parentGatewayId: parent.id, scopeId: parent.scopeId, revokedAtMs: null });
      });
      return { token, deviceId };
    },
    registerGateway(scopeId: string, token: unknown) {
      const context = fleet(scopeId);
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AccessError("invalid");
      const tokenHash = hash(token), existing = gateways.grants.find(value => value.scopeId === scopeId);
      if (existing && (existing.revokedAtMs !== null || existing.hash !== tokenHash)
        || ledger.devices.some(value => value.hash === tokenHash)
        || secureBrowser.sessions.some(value => value.hash === tokenHash)
        || gateways.grants.some(value => value.hash === tokenHash && value.scopeId !== scopeId)) throw new AccessError("denied");
      const grant = existing ?? { id: randomUUID(), scopeId, hash: tokenHash, revokedAtMs: null };
      if (!existing) mutateGateways(next => {
        if (next.grants.length >= 32) throw new Error("Gateway capacity reached.");
        next.grants.push(grant);
      });
      return { version: 1 as const, serverId: ledger.serverId, gatewayId: grant.id, scopeId, role: (protectedMode ? "viewer" : "operator") as DeviceRole, context };
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
      const role = protectedMode && selected.role === "operator" && selected.ownerDevice !== true ? "viewer" : selected.role;
      mutate(next => {
        if (next.devices.length >= 4096) throw new Error("Device capacity reached.");
        next.codes = next.codes.filter(value => value.hash !== selected.hash);
        next.devices.push({ id: deviceId, name: deviceName, role, scopeId: selected.scopeId,
          rosterRevision: selected.rosterRevision, hash: hash(token), revokedAtMs: null,
          ...(selected.followRoster && role === "viewer" ? { followRoster: true } : {}), ...(selected.ownerDevice && role === "operator" ? { ownerDevice: true } : {}) });
      });
      return { version: 1 as const, serverId: ledger.serverId, deviceId, token, role, context };
    },
    devices(token: unknown) {
      const access = requireDeviceAdministration(token);
      return [...ledger.devices.filter(value => value.scopeId === access.context.scopeId).map(value => ({
        deviceId: value.id, name: value.name, role: value.role, revokedAtMs: value.revokedAtMs,
        rosterRevision: value.rosterRevision,
      })), ...secureBrowser.sessions.filter(value => value.scopeId === access.context.scopeId).map(value => ({
        deviceId: value.id, name: "Secure browser", role: (protectedMode ? "viewer" : "operator") as DeviceRole,
        revokedAtMs: value.revokedAtMs ?? gateways.grants.find(parent => parent.id === value.parentGatewayId)?.revokedAtMs ?? null,
        rosterRevision: access.context.rosterRevision,
      }))];
    },
    revoke(token: unknown, deviceId: unknown): void {
      const access = requireDeviceAdministration(token);
      const browser = secureBrowser.sessions.find(value => value.id === deviceId && value.scopeId === access.context.scopeId);
      if (browser) { mutateSecureBrowser(next => { next.sessions.find(value => value.id === deviceId)!.revokedAtMs ??= now(); }); return; }
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
