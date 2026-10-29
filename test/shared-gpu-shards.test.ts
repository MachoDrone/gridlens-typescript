import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openSharedState } from "../src/backend/sqlite-state.ts";
import { createObservationStore } from "../src/backend/observations.ts";
import type { PcAssociation, SharedObservations } from "../src/contracts/shared.ts";
import type { NodeGpuObservation } from "../src/fleet/pc-observations.ts";

const time = 1_800_000_000_000, address = "11111111111111111111111111111112", uuid = "GPU-11111111-2222-3333-4444-555555555555";
const context = { scopeId: "synthetic", rosterRevision: "one", addresses: [address] };
const summaryKey = "observations:synthetic:one", historyKey = `gpu-history:synthetic:one:${address}`;
const association: PcAssociation = { address, binding: { pcId: "a".repeat(64), runtime: "docker", wrapperId: null, nodeContainerId: "b".repeat(64) },
  name: "Generated PC", sshFingerprint: "SHA256:" + "A".repeat(43), verifiedAtMs: time - 1000, privateIp: null, gpuUuids: [uuid] };
const reading: NodeGpuObservation = { schema: 2, address, observedAtMs: time - 1000, status: "ok", gpuUuids: [uuid], intervalSeconds: 15,
  fromAtMs: time - 16_000, toAtMs: time - 1000, truncated: false, clockTrusted: true,
  samples: [[time - 16_000, 0, 1, 0, 10, null, null, null], [time - 1000, 0, 1, 1, 20, null, null, null]] };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-gpu-shards-"));
  const state = openSharedState(directory, { now: () => time });
  const observations = createObservationStore(state, "generated-server", () => time);
  observations.associate(context, [association]); observations.ingest(context, { address, binding: association.binding, gpu: reading });
  return { state, observations,
    deleteShard() { const fault = new DatabaseSync(join(directory, "ledger.sqlite")); try {
      fault.prepare("DELETE FROM private_state WHERE key = ?").run(historyKey);
    } finally { fault.close(); } },
    async close() { await state.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("a missing declared nonempty GPU shard fails instead of becoming an empty successful history", async () => {
  const f = await fixture();
  try {
    assert.equal(f.observations.read(context).gpuSummaries![0]!.sampleCount, 2);
    f.deleteShard();
    assert.throws(() => f.observations.readGpu(context, address), /history is missing/);
    assert.throws(() => f.observations.read(context, true), /history is missing/);
    assert.throws(() => f.observations.ingest(context, { address, binding: association.binding, gpu: reading }), /history is missing/);
    assert.equal(f.observations.read(context).gpuSummaries![0]!.sampleCount, 2, "failed access does not rewrite retained summary evidence");
  } finally { await f.close(); }
});

test("GPU shard status, clock, truncation, counts and source fields must match the atomic summary", async () => {
  const f = await fixture();
  try {
    for (const change of [{ status: "query-failed" }, { clockTrusted: false }, { truncated: true }, { samples: reading.samples.slice(1) },
      { observedAtMs: reading.observedAtMs! - 1 }, { gpuUuids: [uuid.replace("11111111", "99999999")] }]) {
      f.state.set(historyKey, { ...reading, ...change });
      assert.throws(() => f.observations.readGpu(context, address), /do not match/);
    }
    // Property order has no identity meaning and must not create false corruption.
    f.state.set(historyKey, Object.fromEntries(Object.entries(reading).reverse()));
    assert.deepEqual(f.observations.readGpu(context, address), reading);
    const data = f.state.get<SharedObservations>(summaryKey)!;
    data.gpuSummaries![0]!.sampleCount = 1; f.state.set(summaryKey, data);
    assert.throws(() => f.observations.readGpu(context, address), /do not match/);
  } finally { await f.close(); }
});

test("legitimate inline legacy GPU history remains readable and migrates atomically without renewing dates", async () => {
  const f = await fixture();
  try {
    const legacy = f.observations.read(context, true); delete legacy.gpuSummaries;
    f.state.set(summaryKey, legacy); f.deleteShard();
    assert.deepEqual(f.observations.readGpu(context, address), reading);
    f.observations.network(context, { pcId: association.binding.pcId, network: { schema: 1, observedAtMs: time, status: "unavailable",
      source: "pc-egress-ipify", publicIp: null, publicObservedAtMs: null, privateIp: null, privateObservedAtMs: null } });
    assert.deepEqual(f.state.get(historyKey), reading);
    const migrated = f.observations.read(context);
    assert.deepEqual(migrated.observations[0]!.gpu!.samples, []);
    assert.equal(migrated.gpuSummaries![0]!.sampleCount, 2);
    assert.equal(migrated.observations[0]!.receivedAtMs, legacy.observations[0]!.receivedAtMs);
    assert.deepEqual(f.observations.readGpu(context, address), reading);
  } finally { await f.close(); }
});
