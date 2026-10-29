import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAccess } from "../src/backend/access.ts";
import { createObservationStore } from "../src/backend/observations.ts";
import { createSetup } from "../src/backend/setup.ts";
import { openSharedState } from "../src/backend/sqlite-state.ts";
import { openCredentialVault } from "../src/backend/credential-vault.ts";
import type { Computer } from "../src/backend/ssh.ts";
import type { PcAssociation } from "../src/contracts/shared.ts";
const address = "1".repeat(31) + "2", second = "1".repeat(31) + "3";

test("single selected computer saves all verified hosts, remembers only verified credentials, and preserves denied permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-setup-")), state = openSharedState(join(directory, "state"));
  const vault = openCredentialVault(join(directory, "credentials"));
  try {
    const access = createAccess(state); access.setFleet("default", []);
    const observations = createObservationStore(state, access.serverId);
    const computers: Computer[] = ["a", "b"].map((char, index) => ({ id: char.repeat(64), host: `192.168.42.${index + 2}`, port: 22,
      name: `Synthetic PC ${index + 1}`, fingerprint: "SHA256:" + char.toUpperCase().repeat(43), hostKey: "generated-public-fixture" }));
    const calls: string[] = [];
    const associations: PcAssociation[] = [address, second].map((address, index) => ({ address, binding: { pcId: computers[0]!.id,
      runtime: "docker", wrapperId: null, nodeContainerId: String(index + 1).repeat(64) }, name: computers[0]!.name,
      sshFingerprint: computers[0]!.fingerprint, verifiedAtMs: Date.now(), privateIp: null, gpuUuids: [] }));
    const setup = createSetup(state, access, observations, Date.now, { vault, scan: async () => computers,
      inspect: async (computer, credential) => { calls.push(computer.id); assert.equal(credential.password, "generated-secret"); return { associations, exclusions: ["Synthetic unresolved host excluded"] }; } });
    await setup.control({ operation: "setup-scan", scopeId: "default", range: "192.168.42.0/24" });
    let view = setup.read("default"); view = setup.action("default", { action: "select", revision: view.revision, selected: [computers[0]!.id] });
    assert.equal(view.phase, "identities"); view = setup.action("default", { action: "trust", revision: view.revision });
    assert.equal(view.phase, "credentials"); await setup.control({ operation: "setup-auth", scopeId: "default", username: "fixture", password: "generated-secret", remember: true });
    view = setup.read("default"); assert.equal(view.phase, "review"); setup.action("default", { action: "inspect", revision: view.revision, automaticIp: true, fullMonitoring: false });
    const result = await setup.inspect("default"); assert.equal(result.savedHosts, 2); assert.equal(result.inspectedPcs, 1);
    assert.deepEqual(calls, [computers[0]!.id]); assert.deepEqual(access.fleet("default").addresses, [address, second]);
    assert.equal(vault.read("default", computers[0]!.id)?.password, "generated-secret"); assert.equal(vault.read("default", computers[1]!.id), undefined);
    const permissionKey = `permission:default:${computers[0]!.id}`;
    const permission = state.get<Record<string, unknown>>(permissionKey)!; assert.equal(permission.automaticIp, true); assert.equal(permission.rewards, false);
    assert.ok(!JSON.stringify(state.get("setup:default")).includes("generated-secret"));
    state.set(permissionKey, { ...permission, revokedAtMs: Date.now(), paused: true });
    await setup.control({ operation: "setup-scan", scopeId: "default", range: "192.168.42.0/24" }); view = setup.read("default");
    view = setup.action("default", { action: "select", revision: view.revision, selected: [computers[0]!.id] });
    assert.equal(view.phase, "credentials", "Matching saved SSH identities skip the second trust review");
    await setup.control({ operation: "setup-auth", scopeId: "default", username: "fixture", password: "generated-secret", remember: true });
    view = setup.read("default"); setup.action("default", { action: "inspect", revision: view.revision, automaticIp: true, fullMonitoring: true });
    await setup.inspect("default"); assert.equal(state.get<Record<string, unknown>>(permissionKey)?.paused, true);
    assert.ok(setup.read("default").exclusions.some(value => value.includes("revocation retained")));
  } finally { vault.close(); await state.close(); await rm(directory, { recursive: true }); }
});

test("interrupted setup retains selections and reviewed identities but requires terminal sign-in again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-setup-restart-")); const state = openSharedState(directory);
  try {
    const access = createAccess(state); access.setFleet("default", []);
    const observations = createObservationStore(state, access.serverId), first = createSetup(state, access, observations);
    const base = first.read("default"); state.set("setup:default", { ...base, phase: "inspecting", selected: ["a".repeat(64)], trusted: ["a".repeat(64)] });
    const restored = createSetup(state, access, observations); assert.equal(restored.read("default").phase, "credentials");
    assert.deepEqual(restored.read("default").selected, ["a".repeat(64)]); await assert.rejects(restored.inspect("default"));
  } finally { await state.close(); await rm(directory, { recursive: true }); }
});

function syntheticComputer(char: string, suffix: number): Computer {
  return { id: char.repeat(64), host: `192.168.42.${suffix}`, port: 22, name: `Synthetic PC ${suffix}`,
    fingerprint: "SHA256:" + char.toUpperCase().repeat(43), hostKey: "generated-public-fixture" };
}
function syntheticAssociation(computer: Computer, address: string, container: string, checkedAtMs: number): PcAssociation {
  return { address, binding: { pcId: computer.id, runtime: "docker", wrapperId: null, nodeContainerId: container.repeat(64) },
    name: computer.name, sshFingerprint: computer.fingerprint, verifiedAtMs: checkedAtMs, privateIp: null, gpuUuids: [] };
}
async function setupHarness() {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-setup-regression-"));
  const state = openSharedState(join(directory, "state")), vault = openCredentialVault(join(directory, "credentials"));
  const access = createAccess(state); access.setFleet("default", []);
  const observations = createObservationStore(state, access.serverId);
  let now = Date.now();
  let computers: Computer[] = [];
  const results = new Map<string, { associations: PcAssociation[]; exclusions: string[] }>();
  const inspected: string[] = [];
  const dependencies = { vault, scan: async () => structuredClone(computers), inspect: async (computer: Computer) => {
    inspected.push(computer.id); return structuredClone(results.get(computer.id) ?? { associations: [], exclusions: ["Synthetic incomplete inspection"] });
  } };
  let setup = createSetup(state, access, observations, () => now, dependencies);
  return {
    state, vault, access, observations, results, inspected,
    get setup() { return setup; }, get now() { return now; },
    setComputers(rows: Computer[]) { computers = rows; },
    async scan() { return setup.control({ operation: "setup-scan", scopeId: "default", range: "192.168.42.0/24" }); },
    restart() { setup = createSetup(state, access, observations, () => now, dependencies); },
    async inspect(selected: Computer[], { fullMonitoring = false, automaticIp = true, remember = true } = {}) {
      now += 100;
      await this.scan();
      let view = setup.read("default");
      view = setup.action("default", { action: "select", revision: view.revision, selected: selected.map(row => row.id) });
      if (view.phase === "identities") view = setup.action("default", { action: "trust", revision: view.revision });
      assert.equal(view.phase, "credentials");
      await setup.control({ operation: "setup-auth", scopeId: "default", username: "fixture", password: "generated-regression-secret", remember });
      view = setup.read("default"); setup.action("default", { action: "inspect", revision: view.revision, fullMonitoring, automaticIp });
      return setup.inspect("default");
    },
    async close() { vault.close(); await state.close(); await rm(directory, { recursive: true }); },
  };
}

test("a changed SSH identity stays blocked across repeated scans, absence and owner restart", async () => {
  const h = await setupHarness();
  try {
    const original = syntheticComputer("a", 2), replacement = { ...syntheticComputer("b", 2), host: original.host };
    h.setComputers([original]);
    h.results.set(original.id, { associations: [syntheticAssociation(original, address, "1", h.now)], exclusions: [] });
    await h.inspect([original]);
    h.setComputers([replacement]);
    for (let scan = 0; scan < 2; scan++) {
      await h.scan();
      assert.equal(h.setup.read("default").computers.length, 0, "A changed endpoint never becomes a selectable new identity");
      assert.ok(h.setup.read("default").exclusions.some(value => value.includes("changed SSH identity blocked")));
    }
    h.setComputers([]); await h.scan(); h.restart(); h.setComputers([replacement]); await h.scan();
    assert.equal(h.setup.read("default").computers.length, 0);
    assert.deepEqual(h.access.fleet("default").addresses, [address], "A scan cannot replace the verified fleet roster");
    h.setComputers([original]); await h.scan();
    const view = h.setup.read("default");
    assert.equal(h.setup.action("default", { action: "select", revision: view.revision, selected: [original.id] }).phase, "credentials",
      "The original matching identity still skips repeated approval");
  } finally { await h.close(); }
});

test("adding another computer retains the unselected healthy computer's exact monitoring approval", async () => {
  const h = await setupHarness();
  try {
    const pc1 = syntheticComputer("a", 2), pc2 = syntheticComputer("b", 3);
    const firstAssociation = syntheticAssociation(pc1, address, "1", h.now);
    h.setComputers([pc1]); h.results.set(pc1.id, { associations: [firstAssociation], exclusions: [] });
    await h.inspect([pc1], { fullMonitoring: true });
    const key = `permission:default:${pc1.id}`, before = h.state.get<Record<string, unknown>>(key)!;
    const firstContext = h.access.fleet("default");
    h.setComputers([pc1, pc2]); h.results.set(pc2.id, { associations: [syntheticAssociation(pc2, second, "2", h.now)], exclusions: [] });
    await h.inspect([pc2], { fullMonitoring: false });
    const context = h.access.fleet("default"), after = h.state.get<Record<string, unknown>>(key)!;
    assert.notEqual(context.rosterRevision, firstContext.rosterRevision);
    assert.deepEqual(context.addresses, [address, second]);
    assert.deepEqual(after, { ...before, rosterRevision: context.rosterRevision }, "Only the roster binding advances for unchanged approved nodes");
    assert.equal(h.vault.read("default", pc1.id)?.password, "generated-regression-secret");
    assert.deepEqual(h.inspected, [pc1.id, pc2.id], "Unselected computers are not reinspected or reauthenticated");
    const added = h.state.get<Record<string, unknown>>(`permission:default:${pc2.id}`)!;
    assert.equal(added.automaticIp, true); assert.equal(added.rewards, false); assert.equal(added.gpu, false);
    assert.deepEqual(added.associations, [], "PC-only approval cannot authorize node-level reads");
  } finally { await h.close(); }
});

test("Inspect only and partial results retain old exact grants without granting a newly found node", async () => {
  const h = await setupHarness();
  try {
    const pc = syntheticComputer("a", 2), third = "1".repeat(31) + "4";
    const original = [syntheticAssociation(pc, address, "1", h.now), syntheticAssociation(pc, second, "2", h.now)];
    h.setComputers([pc]); h.results.set(pc.id, { associations: original, exclusions: [] });
    await h.inspect([pc], { fullMonitoring: true });
    const key = `permission:default:${pc.id}`, before = h.state.get<Record<string, unknown>>(key)!;
    const added = syntheticAssociation(pc, third, "3", h.now);
    h.results.set(pc.id, { associations: [original[0]!, added], exclusions: ["Second previously approved node temporarily unavailable"] });
    await h.inspect([pc], { automaticIp: false, fullMonitoring: false });
    const after = h.state.get<Record<string, unknown>>(key)!, context = h.access.fleet("default");
    assert.deepEqual(context.addresses, [address, second, third], "Verified additions save automatically while incomplete prior coverage is retained");
    assert.equal(after.rosterRevision, context.rosterRevision);
    assert.equal(after.automaticIp, true); assert.equal(after.rewards, true); assert.equal(after.gpu, true);
    assert.equal(after.approvedAtMs, before.approvedAtMs, "Routine inspection cannot erase a prior authorization-denial epoch");
    assert.deepEqual(after.associations, original, "Existing exact bindings survive a partial result; the new node receives no old grant");
    h.results.set(pc.id, { associations: [], exclusions: ["Synthetic complete inspection failure"] });
    await h.inspect([pc], { automaticIp: false, fullMonitoring: false, remember: false });
    assert.deepEqual(h.state.get(key), after, "An unsuccessful inspect-only visit cannot revoke healthy remembered coverage");
  } finally { await h.close(); }
});
