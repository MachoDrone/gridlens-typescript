import type { FleetContext, FleetResource } from "../contracts/fleet.ts";
import { FLEET_RESOURCES, isFleetSnapshot } from "../contracts/fleet.ts";
import { parseUpdateStatus, isUpdateRequestKey } from "../contracts/updates.ts";
import type { UpdateBuild, UpdateStatus } from "../contracts/updates.ts";
import { SHARED_CAPABILITIES } from "../contracts/shared.ts";
import type { FleetSnapshotStore } from "../server/snapshot-store.ts";
import { createSnapshotSource } from "../server/snapshot-source.ts";
import { AccessError, createAccess } from "./access.ts";
import type { PrivateState } from "./access.ts";
import { SharedHttpError } from "./ipc.ts";
import { createObservationStore } from "./observations.ts";
import { createSetup } from "./setup.ts";
import type { scanComputers, inspectComputer } from "./ssh.ts";
import type { CredentialVault } from "./credential-vault.ts";
import type { PcPermission } from "./pc-monitor.ts";
import { createBrowserSecurity } from "./browser-security.ts";
import { createHash } from "node:crypto";
import { createTreasury } from "./treasury.ts";
import type { TreasuryDriver } from "./treasury.ts";
import type { TreasuryVault } from "./treasury-vault.ts";
import { createTreasuryClaims } from "./treasury-claims.ts";
import type { ClaimsDriver } from "./treasury-claims.ts";
import { REWARD_AMOUNT, sameBinding } from "../fleet/pc-observations.ts";
import { parseViewerRequest } from "../contracts/viewer.ts";
import type { GuardianAdministration } from "./guardian-administration.ts";
import { parseTreasuryConfiguration } from "../contracts/treasury.ts";
import { parseClaimsStatus } from "../contracts/treasury-claims.ts";

export function createSharedService(state: PrivateState & { snapshots: FleetSnapshotStore }, {
  now = Date.now, requestHistory, providerWaits = () => [], vault, scan, inspect, build, updates, treasury: treasuryOptions, treasuryUnavailable = false, protectedMode = false,
}: { now?: () => number; requestHistory?: (context: FleetContext, addresses: string[], refresh: boolean) => Promise<void>;
  providerWaits?: () => { provider: string; retryAtMs: number }[]; vault?: CredentialVault; scan?: typeof scanComputers; inspect?: typeof inspectComputer;
  build?: UpdateBuild; updates?: (body: Record<string, unknown>) => Promise<unknown>;
  treasuryUnavailable?: boolean;
  protectedMode?: boolean;
  treasury?: { vault: TreasuryVault; driver: (access: ReturnType<typeof createAccess>, observations: ReturnType<typeof createObservationStore>) => TreasuryDriver;
    guardians?: (access: ReturnType<typeof createAccess>, observations: ReturnType<typeof createObservationStore>) => GuardianAdministration;
    claims?: { driver: (access: ReturnType<typeof createAccess>, observations: ReturnType<typeof createObservationStore>) => ClaimsDriver;
      initialize: (serverId: string) => boolean } } } = {}) {
  const access = createAccess(state, now, { protectedMode }), observations = createObservationStore(state, access.serverId, now);
  const browserSecurity = createBrowserSecurity(state, access.serverId, now);
  const source = createSnapshotSource(state.snapshots, { now });
  const guardians = treasuryOptions?.guardians?.(access, observations);
  const setup = createSetup(state, access, observations, now, { ...(vault ? { vault } : {}), ...(scan ? { scan } : {}), ...(inspect ? { inspect } : {}) });
  const wallet = treasuryOptions ? createTreasury(state, { access, vault: treasuryOptions.vault, driver: treasuryOptions.driver(access, observations), now, protectedMode: access.protectedMode, onAuthorityCleared: () => access.clearOwnerBrowsers(),
    ...(guardians ? { guardianStatus(context: FleetContext, destinationAddress: string) {
      const { required, authorityId, state } = guardians.summary(context, destinationAddress);
      return { required, authorityId, state };
    }, onConfigure: guardians.syncDestination } : {}),
    security() {
      const { status } = browserSecurity.read();
      if (!status.available || status.status !== "ready") throw new SharedHttpError(503);
      return { httpsOrigin: status.httpsOrigin, serverCertificateSha256: status.serverCertificateSha256 };
    }, hosts: context => observations.read(context).associations.map(row => ({ address: row.address, label: row.name })) }) : undefined;
  let claims: ReturnType<typeof createTreasuryClaims> | undefined;
  if (wallet && treasuryOptions?.claims) {
    // A missing/corrupt initialization witness disables claims alone. Never
    // reinterpret recovery as a fresh allowance or disturb the original pilot.
    try {
      const initialize = treasuryOptions.claims.initialize(access.serverId);
      claims = createTreasuryClaims(state, { serverId: access.serverId, vault: treasuryOptions.vault,
        driver: treasuryOptions.claims.driver(access, observations), authorizeOperation: wallet.authorizeOperation, initialize, now,
        requireFinancialReady: wallet.requireFinancialReady,
        hosts(context) {
          const data = observations.read(context), at = now();
          return data.associations.filter(row => {
            const permission = state.get<PcPermission>(`permission:${context.scopeId}:${row.binding.pcId}`);
            const observed = data.observations.find(item => item.address === row.address), reward = observed?.rewards;
            const denial = state.get<{ approvedAtMs: number }>(`monitor:reward-denial:${context.scopeId}:${row.binding.pcId}:${row.address}`);
            return permission?.version === 1 && permission.rewards && !permission.paused && permission.revokedAtMs === null
              && permission.rosterRevision === context.rosterRevision && permission.computer.id === row.binding.pcId
              && (!denial || denial.approvedAtMs < permission.approvedAtMs)
              && permission.computer.fingerprint === row.sshFingerprint
              && permission.associations.some(item => item.address === row.address && item.sshFingerprint === row.sshFingerprint && sameBinding(item.binding, row.binding))
              && observed && sameBinding(observed.binding, row.binding) && reward?.status === "ok" && reward.address === row.address
              && at >= reward.observedAtMs && at < reward.observedAtMs + 300_000 && typeof reward.amount === "string"
              && REWARD_AMOUNT.test(reward.amount) && BigInt(reward.amount.replace(".", "")) > 0n;
          }).map(row => ({ address: row.address, label: row.name }));
        } });
    } catch { /* Retained state recovery does not disable Fleet or the Wallet owner. */ }
  }
  const capabilities = [...SHARED_CAPABILITIES, "browser-security-v1", ...(updates && build ? ["browser-updates-v1"] : []),
    ...(wallet ? ["treasury-v1", "treasury-recovery-questions-v1"] : []), ...(claims ? ["treasury-claims-pilot-v1"] : [])];
  function browserSecurityBinding() {
    const { status } = browserSecurity.read();
    if (!status.available || status.status !== "ready" || status.httpOrigin === null) throw new SharedHttpError(409);
    return { status, hash: createHash("sha256").update(JSON.stringify([status.serverId, status.instance, status.httpOrigin,
      status.httpsOrigin, status.certificateSha256, status.serverCertificateSha256])).digest("hex") };
  }
  async function readiness(): Promise<unknown> {
    if (!build) throw new SharedHttpError(503);
    // Cache/roster integrity, never a provider probe or a freshness requirement.
    for (const context of access.contexts()) {
      for (const resource of ["metadata", "node-info"] as const) {
        const snapshot = await source.read(resource, context, new AbortController().signal);
        if (!isFleetSnapshot(resource, snapshot, context.addresses)) throw new SharedHttpError(503);
      }
    }
    return { version: 1, status: "ready", build, serverId: access.serverId };
  }
  async function updateRequest(body: Record<string, unknown>, role: "operator" | "viewer"): Promise<UpdateStatus> {
    const operation = body.operation === "updates-status" ? "status" : body.operation === "updates-check" ? "check" : "start";
    const allowed = operation === "start" ? ["operation", "token", "candidateId", "idempotencyKey"] : ["operation", "token"];
    if (Object.keys(body).some(field => !allowed.includes(field))) throw new SharedHttpError(400);
    if (operation !== "status") access.requireAccess(body.token, "operator");
    if (!updates || !build) {
      if (operation !== "status") throw new SharedHttpError(503);
      return { version: 1, supported: false, canUpdate: false, checking: false, current: build ?? null, candidate: null,
        checkedAtMs: null, nextCheckAtMs: null, checkError: null, operation: null };
    }
    if (operation === "start" && (typeof body.candidateId !== "string" || !/^[a-f0-9]{64}$/.test(body.candidateId)
      || !isUpdateRequestKey(body.idempotencyKey))) throw new SharedHttpError(400);
    const value = parseUpdateStatus(await updates({ operation, ...(operation === "start"
      ? { candidateId: body.candidateId, idempotencyKey: body.idempotencyKey } : {}) }));
    // The owner knows the code actually serving this fleet. A worker journal is
    // not permitted to substitute a hoped-for version during replacement.
    return { ...value, current: build, canUpdate: value.supported && role === "operator" };
  }
  async function read(body: Record<string, unknown>): Promise<unknown> {
    try {
      if (body.operation === "viewer-read") {
        if (Object.keys(body).some(key => !["operation", "token", "request"].includes(key))) throw new SharedHttpError(400);
        const before = access.requireAccess(body.token);
        if (before.role !== "viewer") throw new SharedHttpError(403);
        let request: Record<string, unknown>;
        try { request = parseViewerRequest(body.request); } catch { throw new SharedHttpError(400); }
        const result = await read({ ...request, token: body.token });
        const after = access.requireAccess(body.token);
        if (after.role !== "viewer" || after.deviceId !== before.deviceId || after.context.scopeId !== before.context.scopeId
          || after.context.rosterRevision !== before.context.rosterRevision) throw new SharedHttpError(409);
        return { version: 1, role: "viewer", serverId: access.serverId, scopeId: after.context.scopeId, result };
      }
      if (body.operation === "owner-browser-resolve") {
        if (Object.keys(body).some(key => !["operation", "token", "ownerToken"].includes(key))) throw new SharedHttpError(400);
        access.requireAccess(body.token);
        return { authorized: access.ownerBrowserMatches(body.token, body.ownerToken) };
      }
      if (body.operation === "browser-security") {
        if (Object.keys(body).some(field => field !== "operation")) throw new SharedHttpError(400);
        return browserSecurity.read();
      }
      if (body.operation === "browser-security-connect-code") {
        if (Object.keys(body).some(field => !["operation", "token"].includes(field))) throw new SharedHttpError(400);
        return access.createSecureBrowserCode(body.token, browserSecurityBinding().hash);
      }
      if (body.operation === "browser-security-connect") {
        if (Object.keys(body).some(field => !["operation", "version", "code", "httpsOrigin", "serverCertificateSha256"].includes(field)) || body.version !== 1)
          throw new SharedHttpError(400);
        const binding = browserSecurityBinding();
        // These facts come only from the configured TLS gateway, never browser fields.
        if (body.httpsOrigin !== binding.status.httpsOrigin || body.serverCertificateSha256 !== binding.status.serverCertificateSha256)
          throw new SharedHttpError(409);
        return access.redeemSecureBrowserCode(body.code, binding.hash);
      }
      if (body.operation === "readiness") {
        if (Object.keys(body).some(field => field !== "operation")) throw new SharedHttpError(400);
        return await readiness();
      }
      if (body.operation === "pair") {
        if (body.version !== 1) throw new SharedHttpError(400);
        return { ...access.pair(body.code, body.deviceName), capabilities };
      }
      const device = access.requireAccess(body.token);
      const context = device.context;
      if (["updates-status", "updates-check", "updates-start"].includes(String(body.operation))) return await updateRequest(body, device.role);
      if (body.operation === "resolve") return context;
      if (body.operation === "status") return { version: 1, serverId: access.serverId, context,
        capabilities, providerWaits: providerWaits(), serverTimeMs: now(), mode: "shared-cache", role: device.role, ...(build ? { build } : {}),
        ...(access.protectedMode ? { protectedMode: true } : {}),
        ...(access.isDerivedSecureBrowser(body.token) ? { canManageDevices: false } : {}) };
      if (body.operation === "snapshot") {
        const resource = body.resource as FleetResource;
        if (!FLEET_RESOURCES.includes(resource) || body.scopeId !== context.scopeId || body.rosterRevision !== context.rosterRevision)
          throw new SharedHttpError(409);
        return source.read(resource, context, new AbortController().signal);
      }
      if (body.operation === "observations") {
        const data = observations.read(context);
        // Routine reads carry summaries. A 200+ host response must never include
        // every host's full seven-day sample window; detail has a separate bound.
        return { ...data, gpuSummaries: data.gpuSummaries ?? data.observations.flatMap(row => row.gpu ? [{ address: row.address, sampleCount: row.gpu.samples.length,
          fromAtMs: row.gpu.fromAtMs, toAtMs: row.gpu.toAtMs, truncated: row.gpu.truncated }] : []),
          observations: data.observations.map(row => row.gpu ? { ...row, gpu: { ...row.gpu, samples: [] } } : row) };
      }
      if (body.operation === "gpu-history") {
        if (typeof body.address !== "string" || !context.addresses.includes(body.address) || !Number.isSafeInteger(body.fromAtMs)
          || !Number.isSafeInteger(body.toAtMs) || Number(body.fromAtMs) < 0 || Number(body.toAtMs) < Number(body.fromAtMs)
          || Number(body.toAtMs) - Number(body.fromAtMs) > 7 * 86_400_000) throw new SharedHttpError(400);
        const record = observations.readGpu(context, body.address);
        const fromAtMs = record ? Math.max(record.fromAtMs, Number(body.fromAtMs)) : 0;
        const toAtMs = record ? Math.min(record.toAtMs, Number(body.toAtMs)) : 0;
        return { version: 1, serverId: access.serverId, scopeId: context.scopeId, rosterRevision: context.rosterRevision,
          address: body.address, gpu: record && fromAtMs <= toAtMs ? { ...record, fromAtMs, toAtMs,
            samples: record.samples.filter(row => row[0] >= fromAtMs && row[0] <= toAtMs) } : null };
      }
      if (body.operation === "history-request") {
        if (!Array.isArray(body.addresses) || body.addresses.length < 1 || body.addresses.length > 100
          || new Set(body.addresses).size !== body.addresses.length || body.addresses.some(value => typeof value !== "string" || !context.addresses.includes(value))
          || body.rosterRevision !== context.rosterRevision || typeof body.refresh !== "boolean") throw new SharedHttpError(400);
        // Scheduler owns this bounded work; the cache response never waits for upstream completion.
        void requestHistory?.(context, body.addresses as string[], body.refresh).catch(() => {});
        return { queued: !!requestHistory };
      }
      access.requireAccess(body.token, "operator");
      if (body.operation === "setup-configure" || body.operation === "setup-remove") {
        const allowed = body.operation === "setup-configure"
          ? ["operation", "token", "revision", "selected", "username", "password", "privateKey", "passphrase", "sudoPassword", "fullMonitoring", "restorePcIds"]
          : ["operation", "token", "revision", "pcId"];
        if (Object.keys(body).some(field => !allowed.includes(field))) throw new SharedHttpError(400);
        return body.operation === "setup-configure" ? setup.browserConfigure(context.scopeId, body) : setup.browserRemove(context.scopeId, body);
      }
      if (body.operation === "monitoring") {
        const pcs = new Map(observations.read(context).associations.map(row => [row.binding.pcId, row.name]));
        return { pcs: [...pcs].map(([pcId, name]) => {
          const permission = state.get<PcPermission>(`permission:${context.scopeId}:${pcId}`);
          return { pcId, name, status: !permission ? "not-approved" : permission.revokedAtMs !== null ? "revoked" : permission.paused ? "paused" : "approved",
            automaticIp: permission?.automaticIp ?? false, rewards: permission?.rewards ?? false, gpu: permission?.gpu ?? false,
            nodeCount: permission?.associations.length ?? 0 };
        }) };
      }
      if (body.operation === "monitoring-action") {
        if (typeof body.pcId !== "string" || !/^[a-f0-9]{64}$/.test(body.pcId) || !["pause", "revoke", "forget"].includes(String(body.action))
          || !observations.read(context).associations.some(row => row.binding.pcId === body.pcId)) throw new SharedHttpError(400);
        const key = `permission:${context.scopeId}:${body.pcId}`, permission = state.get<PcPermission>(key);
        if (!permission) throw new SharedHttpError(404);
        // Fence in-flight collection before forgetting credentials or returning success.
        state.set(key, { ...permission, paused: true, revokedAtMs: body.action === "revoke" ? permission.revokedAtMs ?? now() : permission.revokedAtMs });
        if (body.action === "forget") vault?.forget(context.scopeId, body.pcId);
        return { saved: true, status: body.action === "revoke" ? "revoked" : "paused" };
      }
      if (body.operation === "devices") return { devices: access.devices(body.token) };
      if (body.operation === "revoke") { access.revoke(body.token, body.deviceId); return { revoked: true }; }
      if (body.operation === "pair-code") { access.requireDeviceAdministration(body.token); return access.createCode(context.scopeId, "viewer"); }
      if (body.operation === "setup") return setup.read(context.scopeId);
      if (body.operation === "setup-action") return setup.action(context.scopeId, body);
      throw new SharedHttpError(404);
    } catch (error) {
      if (error instanceof AccessError) throw new SharedHttpError(error.kind === "paused" ? 429 : error.kind === "invalid" ? 400 : 401);
      throw error;
    }
  }
  async function control(body: Record<string, unknown>): Promise<unknown> {
    if (body.operation === "treasury-setup" || body.operation === "treasury-reset") {
      if (!wallet) throw new SharedHttpError(503);
      return wallet.control(body);
    }
    if (body.operation === "browser-security-publish") {
      const { operation: _operation, ...publication } = body;
      try { browserSecurity.publish(publication); return { published: true }; }
      catch { throw new SharedHttpError(400); }
    }
    if (body.operation === "readiness") {
      if (Object.keys(body).some(field => field !== "operation")) throw new SharedHttpError(400);
      return readiness();
    }
    if (body.operation === "status") return { version: 1, serverId: access.serverId, contexts: access.contexts(), capabilities };
    if (body.operation === "register-vpn-web" || body.operation === "revoke-vpn-web") {
      if (typeof body.scopeId !== "string") throw new SharedHttpError(400);
      try {
        if (body.operation === "register-vpn-web") return access.registerGateway(body.scopeId, body.token);
        access.revokeGateway(body.scopeId); return { revoked: true };
      } catch (error) {
        if (error instanceof AccessError) throw new SharedHttpError(error.kind === "invalid" ? 400 : 403);
        throw error;
      }
    }
    if (body.operation === "create-fleet") {
      if (typeof body.scopeId !== "string" || !Array.isArray(body.addresses)) throw new SharedHttpError(400);
      return access.setFleet(body.scopeId, body.addresses as string[]);
    }
    if (body.operation === "pair-code") {
      if (typeof body.scopeId !== "string" || body.role !== "operator" && body.role !== "viewer") throw new SharedHttpError(400);
      return access.createCode(body.scopeId, body.role);
    }
    return setup.control(body);
  }
  async function treasury(body: Record<string, unknown>): Promise<unknown> {
    if (!wallet && treasuryUnavailable && body.operation === "status") {
      if (Object.keys(body).some(key => !["operation", "token", "unlockToken", "httpsOrigin", "serverCertificateSha256"].includes(key))) throw new SharedHttpError(400);
      const { status } = browserSecurity.read();
      if (!status.available || status.status !== "ready" || body.httpsOrigin !== status.httpsOrigin
        || body.serverCertificateSha256 !== status.serverCertificateSha256) throw new SharedHttpError(403);
      const principal = access.requireAccess(body.token, access.protectedMode ? "viewer" : "operator");
      return { version: 1, supported: false, state: "recovery-required", pilotConsumed: true,
        serverId: access.serverId, scopeId: principal.context.scopeId, revision: 0 };
    }
    if (!wallet) throw new SharedHttpError(503);
    const financialBody = { token: body.token, unlockToken: body.unlockToken, httpsOrigin: body.httpsOrigin, serverCertificateSha256: body.serverCertificateSha256 };
    if (body.operation === "guardians-status" || body.operation === "guardians-enroll") {
      if (!guardians || Object.keys(body).some(key => !["operation", "token", "unlockToken", "httpsOrigin", "serverCertificateSha256"].includes(key))) throw new SharedHttpError(400);
      const authorization = wallet.authorizeOperation(financialBody);
      const configuration = parseTreasuryConfiguration(await wallet.dispatch({ ...financialBody, operation: "configuration" }));
      if (body.operation === "guardians-status") return { version: 1, ...guardians.summary(authorization.context, configuration.destinationAddress) };
      if (!claims) throw new SharedHttpError(409);
      const claimStatus = parseClaimsStatus(await claims.dispatch({ ...financialBody, operation: "claims-status" }));
      const activity = await wallet.dispatch({ ...financialBody, operation: "operations" }) as { operations?: { phase: string }[] };
      if (claimStatus.state !== "ready" || claimStatus.unresolvedOperationId !== null || !Array.isArray(activity.operations)
        || activity.operations.some(item => ["authorized", "signed", "submission-started", "uncertain"].includes(item.phase))) throw new SharedHttpError(409);
      const stableGuard = () => {
        const principal = access.requireAccess(financialBody.token);
        if (principal.deviceId !== authorization.deviceId || !wallet.matchesConfiguration(authorization.context, configuration.revision, configuration.destinationAddress)) throw new SharedHttpError(409);
      };
      return { version: 1, ...guardians.startEnrollment({ context: authorization.context, configuration, claimedSources: claimStatus.attemptedHosts }, authorization.guard, stableGuard) };
    }
    if (body.operation === "viewer-invite") {
      if (!access.protectedMode || Object.keys(body).some(key => !["operation", "token", "unlockToken", "httpsOrigin", "serverCertificateSha256"].includes(key))) throw new SharedHttpError(400);
      const authorization = wallet.authorizeOperation(body); authorization.guard();
      const { status } = browserSecurity.read();
      if (!status.available || status.status !== "ready") throw new SharedHttpError(503);
      const invitation = access.createCode(authorization.context.scopeId, "viewer", { followRoster: true });
      return { version: 1, kind: "gridlens-viewer-invite", ownerOrigin: status.httpsOrigin, serverId: access.serverId,
        caCertificatePem: browserSecurity.viewerTrust(), serverCertificateSha256: status.serverCertificateSha256,
        code: invitation.code, expiresAtMs: invitation.expiresAtMs };
    }
    if (body.operation === "owner-browser") {
      if (Object.keys(body).some(key => !["operation", "token", "unlockToken", "httpsOrigin", "serverCertificateSha256"].includes(key))) throw new SharedHttpError(400);
      const authorization = wallet.authorizeOperation(body); authorization.guard();
      return access.issueOwnerBrowser(body.token);
    }
    if (typeof body.operation === "string" && body.operation.startsWith("claims-")) {
      if (claims) return claims.dispatch(body);
      wallet.authorizeOperation(body).guard();
      if (body.operation !== "claims-status") throw new SharedHttpError(503);
      if (Object.keys(body).some(key => !["operation", "token", "unlockToken", "httpsOrigin", "serverCertificateSha256"].includes(key))) throw new SharedHttpError(400);
      return { version: 1, supported: false, state: "recovery-required", unresolvedOperationId: null, attemptedHosts: [], eligibleHosts: [] };
    }
    const result = await wallet.dispatch(body);
    if (body.operation === "configure") access.clearOwnerBrowsers();
    return result;
  }
  return { read, control, treasury, wallet, claims, access, observations, setup, guardians };
}
