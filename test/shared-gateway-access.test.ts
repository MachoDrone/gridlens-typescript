import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createAccess, AccessError } from "../src/backend/access.ts";
import { createSharedService } from "../src/backend/service.ts";
import { openSharedState } from "../src/backend/sqlite-state.ts";
import { SharedHttpError } from "../src/backend/ipc.ts";

const address = "1".repeat(31) + "2";
const secret = () => randomBytes(32).toString("base64url");

test("a durable gateway follows only its registered fleet while paired device permissions retain exact revisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-gateway-access-"));
  let at = 1_800_000_000_000, state = openSharedState(directory), access = createAccess(state, () => at);
  const token = secret();
  try {
    const first = access.setFleet("default", []); access.setFleet("other", [address]);
    const native = access.pair(access.createCode("default", "viewer").code, "Native paired device");
    const grant = access.registerGateway("default", token);
    const before = JSON.stringify(state.get("gateway-access.v1"));
    assert.deepEqual(access.registerGateway("default", token), grant);
    assert.equal(JSON.stringify(state.get("gateway-access.v1")), before);
    assert.ok(!before.includes(token)); assert.ok(!JSON.stringify(state.get("access.v1")).includes(token));
    assert.equal(access.devices(token).some(device => device.deviceId === grant.gatewayId), false);
    assert.throws(() => access.registerGateway("default", secret()), AccessError);
    assert.throws(() => access.registerGateway("other", token), AccessError);
    assert.throws(() => access.registerGateway("other", native.token), AccessError);
    at += 365 * 86_400_000;
    const current = access.setFleet("default", [address]); assert.notEqual(current.rosterRevision, first.rosterRevision);
    assert.deepEqual(access.resolve(token)?.context, current);
    assert.equal(access.resolve(token)?.role, "operator");
    assert.equal(access.resolve(native.token), null);
    const serverId = access.serverId;
    await state.close(); state = openSharedState(directory); access = createAccess(state, () => at);
    assert.equal(access.serverId, serverId); assert.deepEqual(access.resolve(token)?.context, current);
    assert.equal(access.resolve(native.token), null);
    const other = access.pair(access.createCode("other", "operator").code, "Other fleet operator");
    assert.throws(() => access.revoke(token, other.deviceId), AccessError);
    const newNative = access.pair(access.createCode("default", "viewer").code, "New native pairing");
    access.revoke(token, newNative.deviceId);
    access.revokeGateway("default"); assert.equal(access.resolve(token), null);
    assert.throws(() => access.registerGateway("default", token), AccessError);
    assert.throws(() => access.registerGateway("default", secret()), AccessError);
    await state.close(); state = openSharedState(directory); access = createAccess(state, () => at);
    assert.equal(access.resolve(token), null); assert.equal(access.resolve(newNative.token), null); assert.equal(access.resolve(native.token), null);
    assert.throws(() => access.registerGateway("default", token), AccessError);
    assert.equal(access.resolve(other.token)?.context.scopeId, "other");
  } finally { await state.close(); await rm(directory, { recursive: true }); }
});

test("only terminal control can register the gateway, whose ordinary token is still checked against fleet revisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-gateway-control-")), state = openSharedState(directory);
  try {
    const service = createSharedService(state), token = secret();
    const prior = service.access.setFleet("default", []), other = service.access.setFleet("other", [address]);
    await assert.rejects(service.read({ operation: "register-vpn-web", scopeId: "default", token }), SharedHttpError);
    await assert.rejects(service.read({ operation: "status", trustedNetwork: true }), SharedHttpError);
    const grant = await service.control({ operation: "register-vpn-web", scopeId: "default", token }) as { gatewayId: string };
    assert.ok(grant.gatewayId); assert.ok(!JSON.stringify(grant).includes(token));
    assert.equal((await service.read({ operation: "status", token }) as { role: string }).role, "operator");
    await assert.rejects(service.read({ operation: "register-vpn-web", scopeId: "other", token }), SharedHttpError);
    await assert.rejects(service.read({ operation: "revoke-vpn-web", scopeId: "default", token }), SharedHttpError);
    const current = service.access.setFleet("default", [address]);
    await assert.rejects(service.read({ operation: "snapshot", token, scopeId: "default", rosterRevision: prior.rosterRevision, resource: "metadata" }), SharedHttpError);
    await assert.rejects(service.read({ operation: "snapshot", token, scopeId: "other", rosterRevision: other.rosterRevision, resource: "metadata" }), SharedHttpError);
    assert.equal((await service.read({ operation: "snapshot", token, scopeId: "default", rosterRevision: current.rosterRevision, resource: "metadata" }) as { hosts: unknown[] }).hosts.length, 1);
    await service.control({ operation: "revoke-vpn-web", scopeId: "default" });
    await assert.rejects(service.read({ operation: "status", token }), SharedHttpError);
    await assert.rejects(service.control({ operation: "register-vpn-web", scopeId: "default", token }), SharedHttpError);
  } finally { await state.close(); await rm(directory, { recursive: true }); }
});
