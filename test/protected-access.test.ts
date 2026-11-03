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
    assert.equal(access.pair(oldCode.code, "Old pending code").role, "viewer");
    const ownerDevice = access.pair(access.createCode("fleet", "operator").code, "Terminal authorized owner");
    access.setFleet("fleet", []); assert.equal(access.resolve(ownerDevice.token)?.role, "operator");
    assert.throws(() => access.requireDeviceAdministration(token));
    assert.throws(() => access.requireAccess(browser.token, "operator"));
    assert.ok(state.get<{ grants: { revokedAtMs: number }[] }>("gateway-access.v1")!.grants.every(row => row.revokedAtMs === at));
    const second = access.redeemSecureBrowserCode(access.createSecureBrowserCode(token, binding).code, binding);
    assert.equal(access.resolve(second.token)?.role, "viewer");
    await state.close(); state = openSharedState(directory);
    access = createAccess(state, () => at); // A compatibility runtime cannot undo the persisted boundary.
    assert.equal(access.protectedMode, true); assert.equal(access.resolve(browser.token)?.role, "viewer");
    access.revokeGateway("fleet"); assert.equal(access.resolve(browser.token), null); assert.equal(access.resolve(second.token), null);
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
    assert.equal(access.resolve(a.token)?.role, "viewer"); assert.equal(access.resolve(b.token)?.role, "viewer");
    assert.equal(access.ownerBrowserMatches(a.token, owner.ownerToken), true);
    assert.equal(access.ownerBrowserMatches(b.token, owner.ownerToken), false);
    assert.throws(() => access.issueOwnerBrowser(owner.ownerToken));
    access.setFleet("fleet", []); assert.deepEqual(access.resolve(owner.ownerToken)?.context.addresses, []);
    at += 299_999; assert.equal(access.ownerBrowserMatches(a.token, owner.ownerToken), true);
    at++; assert.equal(access.resolve(owner.ownerToken), null);
    const next = access.issueOwnerBrowser(a.token);
    assert.equal(createAccess(state, () => at).resolve(next.ownerToken), null);
    access.revokeGateway("fleet"); assert.equal(access.resolve(next.ownerToken), null);
  } finally { await state.close(); await rm(directory, { recursive: true }); }
});
test("missing protected state fails closed instead of restoring old private-network administration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-access-recovery-")), state = openSharedState(directory);
  try {
    state.set("access.owner-bound.v1", { version: 1, activatedAtMs: Date.now() });
    assert.throws(() => createAccess(state), /requires recovery/);
  } finally { await state.close(); await rm(directory, { recursive: true }); }
});
