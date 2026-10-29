import assert from "node:assert/strict";
import { test } from "node:test";
import { FLEET_RESOURCES, isFleetRoster, isFleetSnapshot, isHostMetadataRecord, isNodeInfoRecord } from "../src/contracts/fleet.ts";
import type { FleetSnapshots } from "../src/contracts/fleet.ts";
import { normalizeHostMetadata } from "../src/fleet/host-metadata.ts";
import { normalizeNodeInfo } from "../src/fleet/node-info.ts";
import type { NodeInfoRecord } from "../src/fleet/node-info.ts";
import { projectNodeState } from "../src/fleet/node-state.ts";
import { SYNTHETIC_HOST_ADDRESSES as addresses } from "./fixtures/host-addresses.ts";
import { emptyJobs } from "./fixtures/jobs.ts";
import { emptyQueue } from "./fixtures/queue.ts";
import { emptySol } from "./fixtures/sol.ts";
import { emptyNos } from "./fixtures/nos.ts";
import { emptyStaking } from "./fixtures/staking.ts";
import { blankJobHistoryRecord } from "../src/fleet/job-history.ts";

const hosts = addresses.slice(0, 2);
const at = 1_000_000;
const snapshots: FleetSnapshots = {
  metadata: { hosts: hosts.map(address => ({ address,
    values: normalizeHostMetadata(address, { nodeAddress: address }), fetchedAtMs: at,
    retained: false, error: null, marketError: null })) },
  "node-info": { hosts: hosts.map(address => ({ address,
    values: normalizeNodeInfo(address, { node: address, state: "RUNNING_JOB" }), fetchedAtMs: at,
    validUntilMs: at + 30_000, retained: false, error: null })) },
  jobs: await emptyJobs(hosts), queue: await emptyQueue(hosts), sol: await emptySol(hosts),
  "job-history": { hosts: hosts.map(blankJobHistoryRecord) },
  nos: await emptyNos(hosts), staking: await emptyStaking(hosts),
};

test("Fleet roster validation requires unique exact 32-byte public identities", () => {
  assert(isFleetRoster(hosts));
  assert(isFleetRoster([]));
  for (const value of [null, {}, [hosts[0], hosts[0]], ["2".repeat(32)], ["invalid"], [0]]) {
    assert.equal(isFleetRoster(value), false);
  }
});

for (const resource of FLEET_RESOURCES) test(`${resource} snapshots preserve observations and enforce exact complete/partial roster identity`, () => {
  const snapshot = snapshots[resource];
  const before = structuredClone(snapshot);
  assert(isFleetSnapshot(resource, snapshot, hosts));
  assert.deepEqual(snapshot, before, "validation never renews source timestamps");
  const partial = { ...snapshot, hosts: snapshot.hosts.slice(0, 1) };
  assert.equal(isFleetSnapshot(resource, partial, hosts), false);
  assert(isFleetSnapshot(resource, partial, hosts, false));
  assert.equal(isFleetSnapshot(resource, { ...snapshot, hosts: [snapshot.hosts[0], snapshot.hosts[0]] }, hosts), false);
  assert.equal(isFleetSnapshot(resource, { ...snapshot, hosts: [{ ...snapshot.hosts[0], address: addresses[3] }, snapshot.hosts[1]] }, hosts), false);
  for (const nextRefreshAtMs of [-1, Infinity, NaN, 0.1, "soon", 8_640_000_000_000_001]) {
    assert.equal(isFleetSnapshot(resource, { ...snapshot, nextRefreshAtMs }, hosts), false);
  }
  assert(isFleetSnapshot(resource, { ...snapshot, nextRefreshAtMs: null }, hosts));
  assert.equal(isFleetSnapshot(resource, { ...snapshot, complete: "true" }, hosts), false);
});

test("metadata and Node Info contracts reject malformed timestamps, identities and nested history", () => {
  const metadata = snapshots.metadata.hosts[0]!;
  for (const fetchedAtMs of [-1, Infinity, NaN, 0.5, 8_640_000_000_000_001]) {
    assert.equal(isHostMetadataRecord({ ...metadata, fetchedAtMs }), false);
  }
  assert.equal(isHostMetadataRecord({ ...metadata, values: { ...metadata.values, marketAddress: "bad" } }), false);
  const node = snapshots["node-info"].hosts[0]!;
  assert.equal(isNodeInfoRecord({ ...node, validUntilMs: at + 30_001 }), false);
  assert.equal(isNodeInfoRecord({ ...node, validUntilMs: at }), false);
  assert.equal(isNodeInfoRecord({ ...node, apiCheck: { status: "other", checkedAtMs: at,
    lastConfirmed: { status: "online", checkedAtMs: at, lastConfirmed: { status: "online", checkedAtMs: at } } } }), false);
  assert(isNodeInfoRecord({ ...node, apiCheck: { status: "other", checkedAtMs: at + 60_000,
    lastConfirmed: { status: "online", checkedAtMs: at } } }), "old evidence can be returned without being made current");
});

test("metadata country remains optional for old snapshots and bounds present text", () => {
  const metadata = structuredClone(snapshots.metadata.hosts[0]!);
  delete metadata.values!.country;
  assert(isHostMetadataRecord(metadata), "legacy metadata without country remains valid");
  assert(isFleetSnapshot("metadata", { hosts: [metadata] }, [metadata.address]));
  for (const country of [null, "US", "Reported free-form country", "x".repeat(256)]) {
    assert(isHostMetadataRecord({ ...metadata, values: { ...metadata.values, country } }));
  }
  for (const country of [1, false, [], {}, "", "   ", "\u00a0", "x".repeat(257), "U\nS", "U\u0000S", "US\u007f"]) {
    assert.equal(isHostMetadataRecord({ ...metadata, values: { ...metadata.values, country } }), false);
  }
  assert.equal(metadata.fetchedAtMs, at, "validating country never renews metadata evidence");
});

test("a complete job snapshot rejects conflicting assignments and inflated display deadlines", () => {
  const result = { hosts: hosts.map(address => ({ ...snapshots.jobs.hosts[0]!, address,
    job: { address: addresses[7], node: address, state: "RUNNING", timeStart: 900, timeEnd: 0, timeout: 600 },
    checkedAtMs: at, validUntilMs: at + 180_000 })) };
  assert.equal(isFleetSnapshot("jobs", result, hosts), false);
  result.hosts[1]!.job.address = addresses[6];
  assert(isFleetSnapshot("jobs", result, hosts));
  result.hosts[1]!.validUntilMs++;
  assert.equal(isFleetSnapshot("jobs", result, hosts), false);
});

test("a longer declared activity deadline remains wire-compatible but cannot extend its original State proof", () => {
  const record: NodeInfoRecord = { ...snapshots["node-info"].hosts[0]!,
    values: normalizeNodeInfo(hosts[0]!, { node: hosts[0], state: "OTHER" }),
    activity: { source: "nosana-indexer", state: "RUNNING_JOB", checkedAtMs: at - 20_000,
      validUntilMs: at + 30_000, error: null },
  };
  const before = structuredClone(record);
  assert(isNodeInfoRecord(record));
  assert(isFleetSnapshot("node-info", { hosts: [record] }, [hosts[0]!]));
  const fresh = projectNodeState(record, at + 9_999);
  assert.equal(fresh.current, "RUNNING_JOB");
  assert.equal(fresh.checkedAtMs, at - 20_000);
  assert.equal(fresh.validUntilMs, at + 10_000);
  const expired = projectNodeState(record, at + 10_000);
  assert.equal(expired.current, null);
  assert.equal(expired.retained, true);
  assert.equal(expired.checkedAtMs, at - 20_000);
  assert.deepEqual(record, before);
  for (const validUntilMs of [at - 20_000, at - 20_001, NaN, Infinity]) {
    assert.equal(isNodeInfoRecord({ ...record, activity: { ...record.activity, validUntilMs } }), false);
  }
});
