import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createAccess } from "../src/backend/access.ts";
import { openSharedState } from "../src/backend/sqlite-state.ts";

const address = "1".repeat(31) + "2", binding = "b".repeat(64);
test("protection migration retains browsers as viewers and retires the former operator namespaces", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-protected-access-"));
  let state = openSharedState(directory), at = Date.now();
  try {
    let access = createAccess(state, () => at); access.setFleet("fleet", [address]);
    const token = randomBytes(32).toString("base64url"); access.registerGateway("fleet", token);
    const browser = access.redeemSecureBrowserCode(access.createSecureBrowserCode(token, binding).code, binding);
    const oldOperator = access.pair(access.createCode("fleet", "operator").code, "Former operator");
    const oldCode = access.createCode("fleet", "operator");
    assert.equal(access.resolve(browser.token)?.role, "operator");
    const serverId = access.serverId;
    access = createAccess(state, () => at, { protectedMode: true });
    assert.equal(access.serverId, serverId);
    assert.equal(access.resolve(token)?.role, "viewer"); assert.equal(access.resolve(browser.token)?.role, "viewer");
    assert.equal(access.resolve(oldOperator.token)?.role, "viewer");
    assert.equal(access.canUpdate(token), true); assert.equal(access.canUpdate(browser.token), true);
    assert.equal(access.canUpdate(oldOperator.token), false);
    assert.equal(access.pair(oldCode.code, "Old pending code").role, "viewer");
    const ownerDevice = access.pair(access.createCode("fleet", "operator").code, "Terminal authorized owner");
    access.setFleet("fleet", []); assert.equal(access.resolve(ownerDevice.token)?.role, "operator");
    assert.equal(access.canUpdate(ownerDevice.token), true);
    assert.throws(() => access.requireDeviceAdministration(token));
    assert.throws(() => access.requireAccess(browser.token, "operator"));
    assert.ok(state.get<{ grants: { revokedAtMs: number }[] }>("gateway-access.v1")!.grants.every(row => row.revokedAtMs === at));
    const second = access.redeemSecureBrowserCode(access.createSecureBrowserCode(token, binding).code, binding);
    assert.equal(access.resolve(second.token)?.role, "viewer");
    await state.close(); state = openSharedState(directory);
    access = createAccess(state, () => at); // A compatibility runtime cannot undo the persisted boundary.
    assert.equal(access.protectedMode, true); assert.equal(access.resolve(browser.token)?.role, "viewer");
    access.revokeGateway("fleet"); assert.equal(access.resolve(browser.token), null); assert.equal(access.resolve(second.token), null);
    assert.equal(access.canUpdate(token), false); assert.equal(access.canUpdate(browser.token), false); assert.equal(access.canUpdate(second.token), false);
  } finally { await state.close(); await rm(directory, { recursive: true }); }
});
test("owner browser access is parent-bound, expires without polling extension, and is never persisted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-owner-browser-")), state = openSharedState(directory);
  let at = Date.now();
  try {
    const access = createAccess(state, () => at, { protectedMode: true }); access.setFleet("fleet", [address]);
    const token = randomBytes(32).toString("base64url"); access.registerGateway("fleet", token);
    const a = access.redeemSecureBrowserCode(access.createSecureBrowserCode(token, binding).code, binding);
    const b = access.redeemSecureBrowserCode(access.createSecureBrowserCode(token, binding).code, binding);
    const owner = access.issueOwnerBrowser(a.token);
    assert.equal(access.resolve(owner.ownerToken)?.role, "operator");
    assert.equal(access.canUpdate(owner.ownerToken), true);
    assert.equal(access.resolve(a.token)?.role, "viewer"); assert.equal(access.resolve(b.token)?.role, "viewer");
    assert.equal(access.ownerBrowserMatches(a.token, owner.ownerToken), true);
    assert.equal(access.ownerBrowserMatches(b.token, owner.ownerToken), false);
    assert.throws(() => access.issueOwnerBrowser(owner.ownerToken));
    access.setFleet("fleet", []); assert.deepEqual(access.resolve(owner.ownerToken)?.context.addresses, []);
    at += 299_999; assert.equal(access.ownerBrowserMatches(a.token, owner.ownerToken), true);
    at++; assert.equal(access.resolve(owner.ownerToken), null);
    assert.equal(access.canUpdate(owner.ownerToken), false); assert.equal(access.canUpdate(a.token), true);
    assert.throws(() => access.requireAccess(a.token, "operator"));
    const next = access.issueOwnerBrowser(a.token);
    assert.equal(createAccess(state, () => at).resolve(next.ownerToken), null);
    access.revokeGateway("fleet"); assert.equal(access.resolve(next.ownerToken), null);
  } finally { await state.close(); await rm(directory, { recursive: true }); }
});
test("update permission requires the exact live credential, parent and current fleet", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-protected-update-access-")), state = openSharedState(directory);
  try {
    let access = createAccess(state, Date.now, { protectedMode: true }); access.setFleet("fleet", []);
    const token = randomBytes(32).toString("base64url"), gateway = access.registerGateway("fleet", token);
    const browser = access.redeemSecureBrowserCode(access.createSecureBrowserCode(token, binding).code, binding);
    const owner = access.pair(access.createCode("fleet", "operator").code, "Terminal owner");
    const viewer = access.pair(access.createCode("fleet", "viewer", { followRoster: true }).code, "Paired viewer");
    for (const value of [undefined, null, {}, "", "x".repeat(43), viewer.token]) assert.equal(access.canUpdate(value), false);
    assert.equal(access.canUpdate(browser.token), true);
    access.revoke(owner.token, browser.deviceId); assert.equal(access.canUpdate(browser.token), false);
    const next = access.redeemSecureBrowserCode(access.createSecureBrowserCode(token, binding).code, binding);
    const saved = state.get<{ fleets: unknown[]; devices: { id: string }[] }>("access.v1")!;
    // IDs or display names alone cannot turn a paired viewer into this gateway.
    saved.devices.find(device => device.id === viewer.deviceId)!.id = gateway.gatewayId;
    state.set("access.v1", saved); access = createAccess(state);
    assert.equal(access.resolve(viewer.token)?.deviceId, gateway.gatewayId); assert.equal(access.canUpdate(viewer.token), false);
    assert.equal(access.canUpdate(next.token), true);
    saved.fleets = []; state.set("access.v1", saved); access = createAccess(state);
    for (const value of [token, next.token, owner.token, viewer.token]) assert.equal(access.canUpdate(value), false);
  } finally { await state.close(); await rm(directory, { recursive: true }); }
});
test("missing protected state fails closed instead of restoring old private-network administration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-access-recovery-")), state = openSharedState(directory);
  try {
    state.set("access.owner-bound.v1", { version: 1, activatedAtMs: Date.now() });
    assert.throws(() => createAccess(state), /requires recovery/);
  } finally { await state.close(); await rm(directory, { recursive: true }); }
});
test("null access records are corruption in both legacy and protected namespaces, never fresh state", () => {
  for (const key of ["access.v1", "gateway-access.v1", "secure-browser-access.v1", "gateway-access.owner-bound.v1", "secure-browser-access.owner-bound.v1"]) {
    const values = new Map<string, unknown>([[key, null]]);
    const state = { get: <T>(name: string) => values.get(name) as T | undefined, set: (name: string, value: unknown) => { values.set(name, value); },
      batch: () => { throw new Error("Corrupt state must never enter migration"); } };
    assert.throws(() => createAccess(state, Date.now, { protectedMode: key.includes("owner-bound") }), /access ledger|gateway ledger/);
    assert.equal(values.get(key), null);
  }
});
