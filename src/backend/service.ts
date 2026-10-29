import type { FleetContext, FleetResource } from "../contracts/fleet.ts";
import { FLEET_RESOURCES } from "../contracts/fleet.ts";
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

export function createSharedService(state: PrivateState & { snapshots: FleetSnapshotStore }, {
  now = Date.now, requestHistory, providerWaits = () => [], vault, scan, inspect,
}: { now?: () => number; requestHistory?: (context: FleetContext, addresses: string[], refresh: boolean) => Promise<void>;
  providerWaits?: () => { provider: string; retryAtMs: number }[]; vault?: CredentialVault; scan?: typeof scanComputers; inspect?: typeof inspectComputer } = {}) {
  const access = createAccess(state, now), observations = createObservationStore(state, access.serverId, now);
  const source = createSnapshotSource(state.snapshots, { now });
  const setup = createSetup(state, access, observations, now, { ...(vault ? { vault } : {}), ...(scan ? { scan } : {}), ...(inspect ? { inspect } : {}) });
  async function read(body: Record<string, unknown>): Promise<unknown> {
    try {
      if (body.operation === "pair") {
        if (body.version !== 1) throw new SharedHttpError(400);
        return { ...access.pair(body.code, body.deviceName), capabilities: SHARED_CAPABILITIES };
      }
      const device = access.requireAccess(body.token);
      const context = device.context;
      if (body.operation === "resolve") return context;
      if (body.operation === "status") return { version: 1, serverId: access.serverId, context,
        capabilities: SHARED_CAPABILITIES, providerWaits: providerWaits(), serverTimeMs: now(), mode: "shared-cache", role: device.role };
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
          ? ["operation", "token", "revision", "selected", "username", "password", "fullMonitoring", "restorePcIds"]
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
      if (body.operation === "pair-code") return access.createCode(context.scopeId, "viewer");
      if (body.operation === "setup") return setup.read(context.scopeId);
      if (body.operation === "setup-action") return setup.action(context.scopeId, body);
      throw new SharedHttpError(404);
    } catch (error) {
      if (error instanceof AccessError) throw new SharedHttpError(error.kind === "paused" ? 429 : error.kind === "invalid" ? 400 : 401);
      throw error;
    }
  }
  async function control(body: Record<string, unknown>): Promise<unknown> {
    if (body.operation === "status") return { version: 1, serverId: access.serverId, contexts: access.contexts() };
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
  return { read, control, access, observations, setup };
}
