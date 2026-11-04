import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPcMonitor } from "../src/backend/pc-monitor.ts";
import type { PcPermission } from "../src/backend/pc-monitor.ts";
import { createObservationStore } from "../src/backend/observations.ts";
import { openSharedState } from "../src/backend/sqlite-state.ts";
import { openCredentialVault } from "../src/backend/credential-vault.ts";
import type { FleetContext } from "../src/contracts/fleet.ts";
import type { PcAssociation } from "../src/contracts/shared.ts";
import { GPU_REFRESH_MS } from "../src/fleet/pc-gpu-devices.ts";

const base = 1_800_000_000_000, pcId = "a".repeat(64), address = "1".repeat(31) + "2", fingerprint = "SHA256:" + "A".repeat(43);
const context: FleetContext = { scopeId: "generated-upgrade", rosterRevision: "one", addresses: [address] };
const association: PcAssociation = { address, binding: { pcId, runtime: "docker", wrapperId: null, nodeContainerId: "b".repeat(64) },
  name: "Generated PC", sshFingerprint: fingerprint, verifiedAtMs: base - 1000, privateIp: "10.0.0.2", gpuUuids: [] };
const scheduleKey = `monitor:${context.scopeId}:${pcId}`, permissionKey = `permission:${context.scopeId}:${pcId}`;

async function fixture(failReader = false) {
  const root = await mkdtemp(join(tmpdir(), "gridlens-gpu-upgrade-")); let at = base, reads = 0, credentialReads = 0, connections = 0;
  const state = openSharedState(join(root, "state"), { now: () => at }), vault = openCredentialVault(join(root, "vault"));
  const readCredential = vault.read.bind(vault);
  vault.read = (scopeId, pcId) => { credentialReads++; return readCredential(scopeId, pcId); };
  const observations = createObservationStore(state, "generated-server", () => at);
  const permission: PcPermission = { version: 1, computer: { id: pcId, host: "10.0.0.2", port: 22, name: "Generated PC", fingerprint, hostKey: "generated" },
    associations: [association], rosterRevision: context.rosterRevision, automaticIp: false, rewards: true, gpu: true,
    approvedAtMs: base - 1000, revokedAtMs: null, paused: false };
  observations.associate(context, [association]); state.set(permissionKey, permission);
  vault.save(context.scopeId, pcId, { username: "generated", password: "generated" });
  const old = { ipAt: base + 3_600_000, nodeAt: base + 30_000, rewardsAt: { [address]: base + 3_600_000 },
    gpuAt: { [address]: base + 3_600_000 }, retryAt: 0, driverAt: base + 3_600_000, devicesAt: base + 240_000 };
  state.set(scheduleKey, old);
  const waits = { ip: base + 3_600_000, rewards: base + 3_600_000 }; state.set("monitor/provider-waits", waits);
  const make = () => createPcMonitor({ state, vault, observations, contexts: () => [context], now: () => at,
    connect: async (_computer, _credential, work) => { connections++; return work(async () => assert.fail("No unplanned SSH command")); },
    devicesReader: async () => {
      reads++;
      const reserved = state.get<{ devicesAt: number; devicesReaderRevision: number }>(scheduleKey)!;
      assert.equal(reserved.devicesReaderRevision, 2); assert.equal(reserved.devicesAt, at + GPU_REFRESH_MS, "deadline is durable before reader execution");
      if (failReader) throw Error("Generated interrupted GPU read");
      return { schema: 1, source: "pc-nvidia-smi", observedAtMs: at, bootId: null, status: "unavailable", devices: [], allocations: [], journal: { status: "unavailable", events: [] } };
    },
    driverReader: async () => assert.fail("Upgrade must not renew the driver schedule"),
    rewardsReader: async () => assert.fail("Upgrade must not renew rewards or consume their provider allowance"),
    gpuReader: async () => assert.fail("Upgrade must not trigger a GPU recorder read"),
    networkReader: async () => assert.fail("Upgrade must not renew the IP schedule") });
  return { state, observations, permission, old, waits, make, reads: () => reads, time: (value: number) => { at = value; },
    credentialReads: () => credentialReads, connections: () => connections, forgetCredential: () => vault.forget(context.scopeId, pcId),
    async close() { vault.close(); await state.close(); await rm(root, { recursive: true, force: true }); } };
}

test("reader upgrade refreshes once despite old future deadlines, then preserves cadence across restart", async () => {
  const f = await fixture(); let monitor = f.make();
  try {
    await monitor.tick(); assert.equal(f.reads(), 1, "revision change refreshes immediately, including with future nodeAt");
    const saved = f.state.get<typeof f.old & { devicesReaderRevision: number }>(scheduleKey)!;
    assert.equal(saved.devicesAt, base + GPU_REFRESH_MS); assert.equal(saved.devicesReaderRevision, 2);
    assert.deepEqual(saved.rewardsAt, f.old.rewardsAt); assert.deepEqual(saved.gpuAt, f.old.gpuAt);
    assert.equal(saved.ipAt, f.old.ipAt); assert.equal(saved.driverAt, f.old.driverAt);
    assert.deepEqual(f.state.get("monitor/provider-waits"), f.waits); assert.deepEqual(f.state.get(permissionKey), f.permission);
    await monitor.stop(); monitor = f.make(); await monitor.tick(); assert.equal(f.reads(), 1);
    f.time(base + GPU_REFRESH_MS - 1); await monitor.tick(); assert.equal(f.reads(), 1);
    f.time(base + GPU_REFRESH_MS); await monitor.tick(); assert.equal(f.reads(), 2);
  } finally { await monitor.stop(); await f.close(); }
});

test("failed upgrade read retains its revision reservation across restart and honors existing backoff/permission", async () => {
  const f = await fixture(true); let monitor = f.make();
  try {
    f.state.set(scheduleKey, { ...f.old, retryAt: base + 60_000 });
    await monitor.tick(); assert.equal(f.reads(), 0, "revision does not bypass transport backoff");
    f.time(base + 60_000); f.state.set(permissionKey, { ...f.permission, gpu: false });
    await monitor.tick(); assert.equal(f.reads(), 0, "revision does not bypass GPU approval");
    f.state.set(permissionKey, f.permission); await monitor.tick(); assert.equal(f.reads(), 1);
    await monitor.stop(); monitor = f.make(); f.time(base + 120_000); await monitor.tick(); assert.equal(f.reads(), 1);
    assert.equal(f.state.get<{ devicesReaderRevision: number }>(scheduleKey)!.devicesReaderRevision, 2);
    assert.deepEqual(f.state.get("monitor/provider-waits"), f.waits);
  } finally { await monitor.stop(); await f.close(); }
});

test("missing credentials back off the pending revision refresh without repeated reads or schedule writes", async () => {
  const f = await fixture(); f.forgetCredential(); const monitor = f.make();
  try {
    await monitor.tick(); assert.equal(f.credentialReads(), 1); assert.equal(f.connections(), 0); assert.equal(f.reads(), 0);
    const saved = f.state.get<typeof f.old & { devicesReaderRevision?: number }>(scheduleKey)!;
    assert.equal(saved.retryAt, base + 60_000); assert.equal(saved.devicesReaderRevision, undefined);
    assert.equal(saved.devicesAt, f.old.devicesAt, "no GPU attempt was reserved without a credential");
    for (const elapsed of [1000, 2000, 30_000, 59_999]) {
      f.time(base + elapsed); await monitor.tick();
      assert.equal(f.credentialReads(), 1); assert.deepEqual(f.state.get(scheduleKey), saved);
    }
    f.time(base + 60_000); await monitor.tick(); assert.equal(f.credentialReads(), 2);
    assert.equal(f.state.get<typeof f.old>(scheduleKey)!.retryAt, base + 120_000);
    assert.equal(f.connections(), 0); assert.equal(f.reads(), 0);
    assert.deepEqual(f.state.get("monitor/provider-waits"), f.waits);
  } finally { await monitor.stop(); await f.close(); }
});
