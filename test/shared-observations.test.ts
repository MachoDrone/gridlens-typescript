import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSharedState } from "../src/backend/sqlite-state.ts";
import { createSharedService } from "../src/backend/service.ts";
import { openCredentialVault } from "../src/backend/credential-vault.ts";
import { SharedHttpError } from "../src/backend/ipc.ts";
import { parseSharedObservations } from "../src/contracts/shared.ts";
import type { PcAssociation, SharedObservations } from "../src/contracts/shared.ts";
import type { GpuSample, NodeGpuObservation, PcNetworkObservation } from "../src/fleet/pc-observations.ts";
import type { PcPermission } from "../src/backend/pc-monitor.ts";

const base = 1_800_000_000_000;
const uuid = "GPU-11111111-2222-3333-4444-555555555555";
function address(n: number): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = n, encoded = "";
  while (value) { encoded = alphabet[value % 58]! + encoded; value = Math.floor(value / 58); }
  return "1".repeat(32 - Math.ceil(Math.log2(n + 1) / 8)) + encoded;
}
function gpu(host: string, count: number, toAtMs = base - 1000): NodeGpuObservation {
  const samples: GpuSample[] = Array.from({ length: count }, (_, i) => [toAtMs - (count - i - 1) * 15_000, 0, 3, 1, 70, 240, null, null]);
  return { schema: 2, address: host, observedAtMs: toAtMs, status: "ok", gpuUuids: [uuid], intervalSeconds: 15,
    fromAtMs: samples[0]?.[0] ?? toAtMs, toAtMs, truncated: false, clockTrusted: true, samples };
}
async function fixture(count = 1) {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-observation-contract-"));
  let now = base;
  const state = openSharedState(join(directory, "state"), { ledgerDirectory: join(directory, "ledger"), now: () => now });
  const vault = openCredentialVault(join(directory, "credentials"));
  const service = createSharedService(state, { now: () => now, vault });
  const context = service.access.setFleet("generated-fleet", Array.from({ length: count }, (_, i) => address(i + 1)));
  const associations: PcAssociation[] = context.addresses.map((host, i) => ({ address: host,
    binding: { pcId: (i + 1).toString(16).padStart(64, "0"), runtime: "docker", wrapperId: null, nodeContainerId: (i + 1001).toString(16).padStart(64, "0") },
    name: `Generated PC ${i + 1}`, sshFingerprint: "SHA256:" + "A".repeat(43), verifiedAtMs: base - 60_000, privateIp: null, gpuUuids: [uuid] }));
  service.observations.associate(context, associations);
  const viewer = service.access.pair(service.access.createCode(context.scopeId, "viewer").code, "Generated phone");
  const operator = service.access.pair(service.access.createCode(context.scopeId, "operator").code, "Generated browser");
  return { state, vault, service, context, associations, viewer, operator,
    setTime(value: number) { now = value; },
    async close() { vault.close(); await state.close(); await rm(directory, { recursive: true }); },
  };
}

test("240-host observation summaries retain sample counts and source windows without sending full histories", async () => {
  const f = await fixture(240);
  try {
    let bytes = 0;
    for (const association of f.associations) {
      const reading = gpu(association.address, 6000);
      reading.samples = reading.samples.map(sample => [sample[0], sample[1], sample[2], sample[3], 9_000_000_000_000_000, 9_000_000_000_000_000, 9_000_000_000_000_000, 9_000_000_000_000_000]);
      bytes += Buffer.byteLength(JSON.stringify(reading));
      f.service.observations.ingest(f.context, { address: association.address, binding: association.binding, gpu: reading });
    }
    assert(bytes > 64 * 1024 * 1024, "The fixture exceeds the former single-value storage limit without reducing history capacity");
    const result = await f.service.read({ operation: "observations", token: f.viewer.token }) as SharedObservations;
    parseSharedObservations(result, f.service.access.serverId, f.context);
    assert.equal(result.observations.length, 240); assert.equal(result.gpuSummaries?.length, 240);
    for (const row of result.observations) {
      assert.deepEqual(row.gpu!.samples, []);
      const summary: NonNullable<SharedObservations["gpuSummaries"]>[number] = result.gpuSummaries!.find(value => value.address === row.address)!;
      assert.equal(summary.sampleCount, 6000);
      assert.equal(summary.fromAtMs, row.gpu!.fromAtMs); assert.equal(summary.toAtMs, row.gpu!.toAtMs);
      assert.equal(row.gpu!.observedAtMs, base - 1000);
    }
    assert(Buffer.byteLength(JSON.stringify(result)) < 1024 * 1024, "Routine response remains below one MiB for this 240-host fixture");
    for (const association of f.associations) assert.equal(f.service.observations.readGpu(f.context, association.address)!.samples.length, 6000,
      "Every host retains its complete bounded history in an independent atomic record");
    result.observations[0]!.gpu!.gpuUuids.length = 0;
    assert.deepEqual(f.service.observations.read(f.context).observations[0]!.gpu!.gpuUuids, [uuid], "Client replies do not alias stored readings");
  } finally { await f.close(); }
});

test("bounded GPU detail intersects a prior summary window after newer ingestion without renewing its source time", async () => {
  const f = await fixture();
  try {
    const association = f.associations[0]!, initial = gpu(association.address, 4, base - 15_000);
    f.service.observations.ingest(f.context, { address: association.address, binding: association.binding, gpu: initial });
    const summary = await f.service.read({ operation: "observations", token: f.viewer.token }) as SharedObservations;
    const requested = { fromAtMs: initial.fromAtMs + 15_000, toAtMs: summary.observations[0]!.gpu!.toAtMs };
    f.setTime(base + 20_000);
    const newer = gpu(association.address, 1, base + 15_000);
    f.service.observations.ingest(f.context, { address: association.address, binding: association.binding, gpu: newer });
    const result = await f.service.read({ operation: "gpu-history", token: f.viewer.token, address: association.address, ...requested }) as { gpu: NodeGpuObservation };
    assert.equal(result.gpu.fromAtMs, requested.fromAtMs); assert.equal(result.gpu.toAtMs, requested.toAtMs);
    assert.equal(result.gpu.observedAtMs, newer.observedAtMs, "Response framing cannot rewrite the last actual source read");
    assert.deepEqual(result.gpu.samples, initial.samples.slice(1));
    const noOverlap = await f.service.read({ operation: "gpu-history", token: f.viewer.token, address: association.address, fromAtMs: 1, toAtMs: 2 }) as { gpu: unknown };
    assert.equal(noOverlap.gpu, null);
    await assert.rejects(f.service.read({ operation: "gpu-history", token: f.viewer.token, address: address(1000), ...requested }), SharedHttpError);
    await assert.rejects(f.service.read({ operation: "gpu-history", token: f.viewer.token, address: association.address, fromAtMs: 0, toAtMs: 7 * 86_400_000 + 1 }), SharedHttpError);
  } finally { await f.close(); }
});

test("partial network failures preserve independent public/private source times and later provider waits", async () => {
  const f = await fixture();
  try {
    const pcId = f.associations[0]!.binding.pcId;
    const first: PcNetworkObservation = { schema: 1, source: "pc-egress-ipify", status: "ok", observedAtMs: base - 60_000,
      publicIp: "8.8.8.8", publicObservedAtMs: base - 60_000, privateIp: "10.42.0.2", privateObservedAtMs: base - 90_000 };
    f.service.observations.network(f.context, { pcId, network: first });
    const failedPublic: PcNetworkObservation = { schema: 1, source: "pc-egress-ipify", status: "unavailable", observedAtMs: base - 30_000,
      publicIp: null, publicObservedAtMs: null, publicFailure: "http-refusal", httpStatus: 429,
      privateIp: "10.42.0.3", privateObservedAtMs: base - 30_000, retryAtMs: base + 120_000 };
    f.service.observations.network(f.context, { pcId, network: failedPublic });
    let row = f.service.observations.read(f.context).networks[0]!;
    assert.equal(row.network.status, "unavailable"); assert.equal(row.lastGoodNetwork!.publicIp, first.publicIp);
    assert.equal(row.lastGoodNetwork!.publicObservedAtMs, first.publicObservedAtMs); assert.equal(row.lastGoodNetwork!.privateObservedAtMs, failedPublic.privateObservedAtMs);
    const failedPrivate: PcNetworkObservation = { schema: 1, source: "pc-egress-ipify", status: "ok", observedAtMs: base - 10_000,
      publicIp: "1.1.1.1", publicObservedAtMs: base - 10_000, privateIp: null, privateObservedAtMs: null, privateFailure: "interface-read-failure" };
    f.service.observations.network(f.context, { pcId, network: failedPrivate });
    row = f.service.observations.read(f.context).networks[0]!;
    assert.equal(row.lastGoodNetwork!.publicIp, failedPrivate.publicIp); assert.equal(row.lastGoodNetwork!.publicObservedAtMs, failedPrivate.publicObservedAtMs);
    assert.equal(row.lastGoodNetwork!.privateIp, failedPublic.privateIp); assert.equal(row.lastGoodNetwork!.privateObservedAtMs, failedPublic.privateObservedAtMs);
    assert.equal(row.network.retryAtMs, failedPublic.retryAtMs, "A later delivered reading cannot erase the known provider wait");
  } finally { await f.close(); }
});

test("a failed GPU read retains exact sample history and original dates while recording failure meaning", async () => {
  const f = await fixture();
  try {
    const association = f.associations[0]!, original = gpu(association.address, 4);
    f.service.observations.ingest(f.context, { address: association.address, binding: association.binding, gpu: original });
    f.setTime(base + 30_000);
    f.service.observations.ingest(f.context, { address: association.address, binding: association.binding,
      gpu: { ...gpu(association.address, 0, base + 30_000), status: "query-failed", observedAtMs: null } });
    const retained = f.service.observations.readGpu(f.context, association.address)!;
    assert.equal(retained.status, "query-failed"); assert.equal(retained.observedAtMs, original.observedAtMs);
    assert.equal(retained.fromAtMs, original.fromAtMs); assert.equal(retained.toAtMs, original.toAtMs);
    assert.deepEqual(retained.samples, original.samples);
    f.service.observations.ingest(f.context, { address: association.address, binding: association.binding,
      gpu: { ...gpu(association.address, 0, base + 30_000), status: "clock-untrusted", observedAtMs: null } });
    assert.equal(f.service.observations.read(f.context).observations[0]!.gpu!.clockTrusted, false);
  } finally { await f.close(); }
});

test("future and regressing rewards, GPU windows and PC network readings are rejected without mutating established observations", async () => {
  const f = await fixture();
  try {
    const association = f.associations[0]!, binding = association.binding;
    f.service.observations.ingest(f.context, { address: association.address, binding, gpu: gpu(association.address, 2),
      rewards: { schema: 1, address: association.address, observedAtMs: base - 1000, status: "ok", amount: "12.345678" } });
    const network: PcNetworkObservation = { schema: 1, source: "pc-egress-ipify", status: "ok", observedAtMs: base - 1000,
      publicIp: "8.8.8.8", publicObservedAtMs: base - 1000, privateIp: null, privateObservedAtMs: null };
    f.service.observations.network(f.context, { pcId: binding.pcId, network });
    const before = f.service.observations.read(f.context);
    for (const at of [base + 15_001, base - 2000]) assert.throws(() => f.service.observations.ingest(f.context, { address: association.address, binding,
      rewards: { schema: 1, address: association.address, observedAtMs: at, status: "ok", amount: "0.000000" } }));
    for (const at of [base + 5001, base - 2000]) assert.throws(() => f.service.observations.ingest(f.context, { address: association.address, binding, gpu: gpu(association.address, 1, at) }));
    for (const at of [base + 5001, base - 2000]) assert.throws(() => f.service.observations.network(f.context, { pcId: binding.pcId, network: { ...network, observedAtMs: at, publicObservedAtMs: at } }));
    assert.deepEqual(f.service.observations.read(f.context), before);
  } finally { await f.close(); }
});

test("viewer summary/detail reads cannot mutate setup, device access, PC grants or remembered credentials", async () => {
  const f = await fixture();
  try {
    const association = f.associations[0]!, pcId = association.binding.pcId;
    const permission: PcPermission = { version: 1, computer: { id: pcId, host: "10.42.0.2", port: 22, name: association.name,
      fingerprint: association.sshFingerprint, hostKey: "generated-key" }, associations: [association], rosterRevision: f.context.rosterRevision,
      automaticIp: true, rewards: true, gpu: true, approvedAtMs: base, revokedAtMs: null, paused: false };
    const key = `permission:${f.context.scopeId}:${pcId}`;
    f.state.set(key, permission); f.vault.save(f.context.scopeId, pcId, { username: "fixture", password: "generated-secret" });
    const accessBefore = f.state.get("access.v1"), setupBefore = f.service.setup.read(f.context.scopeId);
    for (const body of [
      { operation: "monitoring-action", pcId, action: "pause" }, { operation: "monitoring-action", pcId, action: "revoke" },
      { operation: "monitoring-action", pcId, action: "forget" }, { operation: "revoke", deviceId: f.operator.deviceId },
      { operation: "pair-code" }, { operation: "setup-action", action: "inspect", automaticIp: true, fullMonitoring: true, revision: setupBefore.revision },
      { operation: "setup-auth", scopeId: f.context.scopeId, password: "untrusted-browser-input" },
    ]) await assert.rejects(f.service.read({ ...body, token: f.viewer.token }), error => error instanceof SharedHttpError && [401, 403].includes(error.status));
    assert.deepEqual(f.state.get(key), permission); assert.deepEqual(f.state.get("access.v1"), accessBefore);
    assert.deepEqual(f.service.setup.read(f.context.scopeId), setupBefore); assert.equal(f.vault.read(f.context.scopeId, pcId)?.password, "generated-secret");
    await f.service.read({ operation: "observations", token: f.viewer.token });
    await f.service.read({ operation: "monitoring-action", token: f.operator.token, pcId, action: "pause" });
    assert.equal(f.state.get<PcPermission>(key)!.paused, true, "The authorized operator control remains available");
  } finally { await f.close(); }
});

test("GPU observation timestamps cannot be future or regress behind an established successful source reading", async () => {
  const f = await fixture();
  try {
    const association = f.associations[0]!, original = gpu(association.address, 2);
    f.service.observations.ingest(f.context, { address: association.address, binding: association.binding, gpu: original });
    const before = f.service.observations.read(f.context);
    for (const observedAtMs of [base + 5001, original.observedAtMs! - 1]) assert.throws(() => f.service.observations.ingest(f.context, {
      address: association.address, binding: association.binding, gpu: { ...gpu(association.address, 1, base), observedAtMs },
    }), "A valid window end cannot validate an impossible or regressing source timestamp");
    assert.deepEqual(f.service.observations.read(f.context), before);
  } finally { await f.close(); }
});
