import assert from "node:assert/strict";
import { test } from "node:test";
import { isMetadataAddress, normalizeHostMetadata, normalizeMarketLabel } from "../src/fleet/host-metadata.ts";

const address = `${"1".repeat(31)}2`;
const market = `${"1".repeat(31)}3`;

test("metrics normalization selects only requested fields and keeps reported numeric units", () => {
  const payload = {
    nodeAddress: address, status: "PREMIUM", marketAddress: market, lastUpdatedAt: "unused",
    metrics: {
      ram_gb: 31.4, disk_gb: 495.2, cpu: { cpu_model: "13th Gen Intel(R) Core(TM)", physical_cores: 16 },
      gpu: { cuda_driver_version: "12.8", nvml_driver_version: "570.124.06", index: 0, uuid: "do-not-copy", model: "do-not-copy" },
      package_version: "1.0.0", system_environment: "6.8.0-52-generic", download: 23,
    },
  };
  const before = structuredClone(payload);
  assert.deepEqual(normalizeHostMetadata(address, payload), {
    status: "PREMIUM", marketAddress: market, marketLabel: null, ram: 31.4, disk: 495.2,
    cpu: "13th Gen Intel(R) Core(TM)", cuda: "12.8", nvidia: "570.124.06",
    currentNode: "1.0.0", system: "6.8.0-52-generic", country: null,
  });
  assert.deepEqual(payload, before);
});

test("missing or malformed fields stay null without inferred values", () => {
  for (const metrics of [undefined, null, [], "not metrics"]) {
    assert.deepEqual(normalizeHostMetadata(address, { nodeAddress: address, metrics }), {
      status: null, marketAddress: null, marketLabel: null, ram: null, disk: null,
      cpu: null, cuda: null, nvidia: null, currentNode: null, system: null, country: null,
    });
  }
  const result = normalizeHostMetadata(address, {
    nodeAddress: address, status: 1, marketAddress: "https://elsewhere.test/",
    metrics: { ram_gb: "32", disk_gb: -1, cpu: { cpu_model: [] }, gpu: { cuda_driver_version: 12 }, package_version: false },
  });
  assert(Object.values(result).every(value => value === null));
});

test("nonfinite and negative measurements are unknown, while a reported zero is preserved", () => {
  for (const value of [Infinity, -Infinity, NaN, -0.1, "0", true, null]) {
    const result = normalizeHostMetadata(address, { nodeAddress: address, metrics: { ram_gb: value, disk_gb: value } });
    assert.equal(result.ram, null);
    assert.equal(result.disk, null);
  }
  assert.equal(normalizeHostMetadata(address, { nodeAddress: address, metrics: { ram_gb: 0 } }).ram, 0);
});

test("country selects valid nested text before flat text without inferring a location", () => {
  const payload = { nodeAddress: address, metrics: {
    network: { country: " nl ", region: "not selected", city: "not selected" }, country: "US",
  } };
  const before = structuredClone(payload);
  const values = normalizeHostMetadata(address, payload);
  assert.equal(values.country, "nl");
  assert.equal(Object.hasOwn(values, "region"), false);
  assert.equal(Object.hasOwn(values, "city"), false);
  assert.deepEqual(payload, before);
  assert.equal(normalizeHostMetadata(address, {
    nodeAddress: address, metrics: { country: " Reported free-form country " },
  }).country, "Reported free-form country");

  for (const country of [undefined, null, [], {}, 0, false, "", "  ", "x".repeat(257), "U\nS", "U\u0000S", "US\u007f"]) {
    assert.equal(normalizeHostMetadata(address, {
      nodeAddress: address, metrics: { network: { country }, country: "CA" },
    }).country, "CA", "an invalid nested value must not hide valid flat country text");
    assert.equal(normalizeHostMetadata(address, {
      nodeAddress: address, metrics: { network: { country }, country },
    }).country, null);
  }
  assert.equal(normalizeHostMetadata(address, {
    nodeAddress: address, metrics: { network: "invalid", country: "x".repeat(256) },
  }).country, "x".repeat(256));
});

test("text is bounded, trimmed and never partly parsed", () => {
  const result = normalizeHostMetadata(address, {
    nodeAddress: address, status: " ", metrics: {
      cpu: { cpu_model: "x".repeat(257) }, gpu: { cuda_driver_version: "\u0000oops", nvml_driver_version: " 570.1 " },
      package_version: "x".repeat(65), system_environment: "\n6.8.0",
    },
  });
  assert.equal(result.status, null);
  assert.equal(result.cpu, null);
  assert.equal(result.cuda, null);
  assert.equal(result.nvidia, "570.1");
  assert.equal(result.currentNode, null);
  assert.equal(result.system, null);
});

test("host response identity must exactly match a validated requested public address", () => {
  for (const payload of [null, [], {}, { nodeAddress: market }, { nodeAddress: ` ${address}` }]) {
    assert.throws(() => normalizeHostMetadata(address, payload), /did not match/);
  }
  for (const invalid of ["https://elsewhere.test", "../nodes", "1".repeat(31), "z".repeat(44), "0".repeat(32), 12]) {
    assert.equal(isMetadataAddress(invalid), false);
  }
  assert.equal(isMetadataAddress(address), true);
  assert.equal(isMetadataAddress("1".repeat(32)), true);
  assert.throws(() => normalizeHostMetadata("bad", { nodeAddress: "bad" }), /did not match/);
});

test("market label prefers the reference slug then readable name and validates its identity", () => {
  assert.equal(normalizeMarketLabel(market, { address: market, slug: " ember-demo ", name: "Ember Demo NVIDIA" }), "ember-demo");
  assert.equal(normalizeMarketLabel(market, { address: market, slug: "", name: "Ember Demo NVIDIA" }), "Ember Demo NVIDIA");
  assert.equal(normalizeMarketLabel(market, { address: market, slug: "x".repeat(257), name: "Fallback" }), "Fallback");
  assert.throws(() => normalizeMarketLabel(market, { address, name: "Wrong" }), /did not match/);
  assert.throws(() => normalizeMarketLabel(market, { address: market, name: [] }), /valid label/);
  assert.throws(() => normalizeMarketLabel(market, { address: market, name: "\u0000wrong" }), /valid label/);
});
