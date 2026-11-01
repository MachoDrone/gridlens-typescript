import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createAccess, AccessError } from "../src/backend/access.ts";
import type { PrivateState } from "../src/backend/access.ts";

const secret = () => randomBytes(32).toString("base64url");
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const binding = digest("synthetic saved origins, CA, leaf and server identity");
const denied = (kind: AccessError["kind"]) => (error: unknown) => error instanceof AccessError && error.kind === kind;
function memory() {
  const values = new Map<string, unknown>();
  const state: PrivateState = { get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    set: (key, value) => { values.set(key, structuredClone(value)); } };
  return { state, values };
}

test("secure browsers inherit only their parent gateway and cannot create independent device access", () => {
  const { state, values } = memory(), token = secret(); let access = createAccess(state);
  const original = access.setFleet("main", []); access.setFleet("other", ["1".repeat(31) + "2"]);
  const parent = access.registerGateway("main", token);
  const native = access.pair(access.createCode("main", "operator").code, "Native operator");
  const viewer = access.pair(access.createCode("main", "viewer").code, "Paired viewer");
  for (const invalid of [undefined, "bad", native.token, viewer.token]) assert.throws(() => access.createSecureBrowserCode(invalid, binding), denied("denied"));
  const code = access.createSecureBrowserCode(token, binding);
  assert.throws(() => access.pair(code.code, "Not an independent pairing code"), denied("denied"));
  const browser = access.redeemSecureBrowserCode(code.code, binding);
  assert.equal(access.resolve(browser.token)?.context.scopeId, "main");
  assert.equal(access.resolve(browser.token)?.role, "operator");
  assert.equal(access.isDerivedSecureBrowser(browser.token), true);
  for (const other of [undefined, "invalid", token, native.token, viewer.token]) assert.equal(access.isDerivedSecureBrowser(other), false);
  assert.throws(() => access.redeemSecureBrowserCode(code.code, binding), denied("denied"));
  assert.throws(() => access.createSecureBrowserCode(browser.token, binding), denied("denied"));
  assert.throws(() => access.requireDeviceAdministration(browser.token), denied("denied"));
  assert.throws(() => access.devices(browser.token), denied("denied"));
  assert.throws(() => access.revoke(browser.token, native.deviceId), denied("denied"));
  assert(access.devices(native.token).some(device => device.deviceId === browser.deviceId));
  const legacy = state.get<{ devices: { hash: string }[] }>("access.v1")!;
  assert.equal(legacy.devices.some(device => device.hash === digest(browser.token)), false);
  const serialized = JSON.stringify([...values]);
  for (const raw of [code.code, browser.token, token, native.token]) assert.equal(serialized.includes(raw), false);

  // An older runtime that does not know the new namespace cannot resolve its token.
  const ignoringNewNamespace: PrivateState = { ...state, get: <T>(key: string) => key === "secure-browser-access.v1" ? undefined : state.get<T>(key) };
  assert.equal(createAccess(ignoringNewNamespace).resolve(browser.token), null);
  access = createAccess(state); assert.equal(access.resolve(browser.token)?.deviceId, browser.deviceId);
  const pending = access.createSecureBrowserCode(token, binding);
  const current = access.setFleet("main", ["1".repeat(31) + "3"]);
  assert.notEqual(current.rosterRevision, original.rosterRevision);
  assert.equal(access.resolve(browser.token)?.context.rosterRevision, current.rosterRevision, "browser follows the approved parent fleet");
  assert.equal(access.resolve(native.token), null, "independent native devices retain exact revision semantics");
  assert.throws(() => access.redeemSecureBrowserCode(pending.code, binding), denied("denied"));
  const currentOperator = access.pair(access.createCode("main", "operator").code, "Current operator");
  access.revoke(currentOperator.token, browser.deviceId); assert.equal(access.resolve(browser.token), null);
  assert.equal(access.isDerivedSecureBrowser(browser.token), false, "classification requires a live authorized principal");
  const second = access.redeemSecureBrowserCode(access.createSecureBrowserCode(token, binding).code, binding);
  const unredeemed = access.createSecureBrowserCode(token, binding);
  access.revokeGateway("main"); access = createAccess(state);
  assert.equal(access.resolve(second.token), null);
  assert.throws(() => access.redeemSecureBrowserCode(unredeemed.code, binding), denied("denied"));
  assert.throws(() => access.registerGateway("main", token), denied("denied"));
  assert.equal(access.devices(currentOperator.token).find(device => device.deviceId === second.deviceId)?.revokedAtMs !== null, true);
  assert.equal(parent.scopeId, "main");
});

test("handoff expiry, identity binding and durable issuance/redemption limits fail closed across recreation", () => {
  const { state } = memory(); let at = 1_800_000_000_000, access = createAccess(state, () => at);
  access.setFleet("main", []); const parent = secret(); access.registerGateway("main", parent);
  const code = access.createSecureBrowserCode(parent, binding);
  assert.throws(() => access.redeemSecureBrowserCode(code.code, digest("changed certificate or origins")), denied("denied"));
  at = code.expiresAtMs; access = createAccess(state, () => at);
  assert.throws(() => access.redeemSecureBrowserCode(code.code, binding), denied("denied"));
  at += 60_001;
  for (let index = 0; index < 20; index++) { access = createAccess(state, () => at); access.createSecureBrowserCode(parent, binding); }
  access = createAccess(state, () => at);
  assert.throws(() => access.createSecureBrowserCode(parent, binding), denied("paused"));
  for (let index = 0; index < 20; index++) { access = createAccess(state, () => at); assert.throws(() => access.redeemSecureBrowserCode(secret(), binding), denied("denied")); }
  access = createAccess(state, () => at);
  assert.throws(() => access.redeemSecureBrowserCode(secret(), binding), denied("paused"));
  at += 60_001;
  const fresh = access.createSecureBrowserCode(parent, binding);
  assert(access.resolve(access.redeemSecureBrowserCode(fresh.code, binding).token));
  state.set("secure-browser-access.v1", null);
  assert.throws(() => createAccess(state), /secure-browser access ledger/);
});

test("secure browser capacity is bounded and failed atomic persistence cannot publish a usable session", () => {
  const { state } = memory(); let access = createAccess(state);
  access.setFleet("main", []); const parentToken = secret(), parent = access.registerGateway("main", parentToken);
  const code = access.createSecureBrowserCode(parentToken, binding);
  const originalSet = state.set; let writes = 0;
  state.set = (key, value) => { if (key === "secure-browser-access.v1" && ++writes === 2) throw new Error("Synthetic persistence failure"); originalSet(key, value); };
  assert.throws(() => access.redeemSecureBrowserCode(code.code, binding), /Synthetic persistence failure/);
  state.set = originalSet; access = createAccess(state);
  const browser = access.redeemSecureBrowserCode(code.code, binding);
  assert.equal(access.resolve(browser.token)?.deviceId, browser.deviceId);
  const saved = state.get<{ version: 1; sessions: unknown[] }>("secure-browser-access.v1")!;
  saved.sessions = Array.from({ length: 4096 }, (_, index) => ({ id: randomUUID(), hash: digest(`synthetic-session-${index}`),
    parentGatewayId: parent.gatewayId, scopeId: "main", revokedAtMs: null }));
  state.set("secure-browser-access.v1", saved); access = createAccess(state);
  assert.throws(() => access.createSecureBrowserCode(parentToken, binding), denied("paused"));
});
