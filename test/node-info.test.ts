import assert from "node:assert/strict";
import { test } from "node:test";
import { NODE_STATES, normalizeNodeInfo } from "../src/fleet/node-info.ts";

const address = `${"1".repeat(31)}2`;
const other = `${"1".repeat(31)}3`;

test("Node Info selects only state and named network fields without changing units or payload", () => {
  const payload = {
    node: address, state: "RUNNING_JOB", uptime: 10_000, resources: { images: ["not selected"] },
    info: { version: "not selected", protocol: "not selected", network: {
      download_mbps: 831.42, upload_mbps: 245.9, ping_ms: 12.7,
      download_mbps_fast: 999, upload_mbps_ookla: 999, ping_ms_libre: 1,
    } },
  };
  const before = structuredClone(payload);
  assert.deepEqual(normalizeNodeInfo(address, payload), {
    state: "RUNNING_JOB", dl: 831.42, ul: 245.9, ping: 12.7, networkUnavailableReason: null,
  });
  assert.deepEqual(payload, before);
});

test("all eight states stay exact; unfamiliar bounded states stay honest rather than inferred", () => {
  assert.deepEqual(NODE_STATES, [
    "RUNNING_JOB", "QUEUED", "BENCHMARKING", "HEALTHCHECK", "STARTING", "RESTARTING", "JOINING_MARKET", "OTHER",
  ]);
  for (const state of [...NODE_STATES, "FUTURE_STATE"]) {
    assert.equal(normalizeNodeInfo(address, { node: address, state }).state, state);
  }
  assert.equal(normalizeNodeInfo(address, { node: address, state: " OTHER " }).state, "OTHER");
  for (const state of [null, 1, true, [], "", " ", "x".repeat(65), "\nOTHER", "bad\u0000"]) {
    assert.equal(normalizeNodeInfo(address, { node: address, state }).state, null);
  }
});

test("the exact all-zero network default never becomes a measured speed or latency", () => {
  assert.deepEqual(normalizeNodeInfo(address, {
    node: address, state: "OTHER", info: { network: { download_mbps: 0, upload_mbps: 0, ping_ms: 0 } },
  }), {
    state: "OTHER", dl: null, ul: null, ping: null,
    networkUnavailableReason: "Node Info returned default zero network readings; no measurement is established.",
  });
  const measured = normalizeNodeInfo(address, {
    node: address, info: { network: { download_mbps: 0, upload_mbps: 12.3, ping_ms: 0 } },
  });
  assert.equal(measured.dl, 0);
  assert.equal(measured.ul, 12.3);
  assert.equal(measured.ping, 0);
  assert.equal(measured.networkUnavailableReason, null);
});

test("absent and malformed network data stay unknown without speed-test or metrics fallbacks", () => {
  for (const network of [undefined, null, [], "bad", { download_mbps_fast: 20, upload_mbps_libre: 20, ping_ms_ookla: 20 }]) {
    const values = normalizeNodeInfo(address, {
      node: address, info: { network }, metrics: { download_mbps: 100, upload_mbps: 100, ping_ms: 10 },
    });
    assert.deepEqual(values, { state: null, dl: null, ul: null, ping: null, networkUnavailableReason: null });
  }
  for (const value of [Infinity, -Infinity, NaN, -0.1, "0", true, null, []]) {
    const values = normalizeNodeInfo(address, { node: address, info: {
      network: { download_mbps: value, upload_mbps: value, ping_ms: value },
    } });
    assert.equal(values.dl, null);
    assert.equal(values.ul, null);
    assert.equal(values.ping, null);
    assert.equal(values.networkUnavailableReason, null);
  }
  const partial = normalizeNodeInfo(address, { node: address, info: { network: { download_mbps: 12.5 } } });
  assert.equal(partial.dl, 12.5);
  assert.equal(partial.ul, null);
  assert.equal(partial.ping, null);
});

test("Node Info identity must exactly match the validated public Host Address", () => {
  for (const payload of [null, [], {}, { nodeAddress: address }, { node: other }, { node: ` ${address}` }]) {
    assert.throws(() => normalizeNodeInfo(address, payload), /did not match/);
  }
  for (const invalid of ["bad", "https://elsewhere.test", "1".repeat(31), "z".repeat(44), "0".repeat(32)]) {
    assert.throws(() => normalizeNodeInfo(invalid, { node: invalid }), /did not match/);
  }
});
