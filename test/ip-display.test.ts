import assert from "node:assert/strict";
import test from "node:test";
import { formatIPDisplay, ipModeLabel, nextIPMode, normalizeIPMode } from "../src/fleet/ip-display.ts";
import type { IPAddresses, IPDisplayMode } from "../src/fleet/ip-display.ts";

const addresses: IPAddresses = Object.freeze({ internal: "10.42.0.11", global: "192.0.2.53" });
const modes: readonly IPDisplayMode[] = ["dot", "full", "ext", "int"];

test("IP display starts hidden and repeats the four-mode cycle", () => {
  let mode = normalizeIPMode(null);
  for (let cycle = 0; cycle < 3; cycle++) {
    for (const expected of modes) {
      assert.equal(mode, expected);
      mode = nextIPMode(mode);
    }
  }
  assert.equal(mode, "dot");
});

test("only current IP display preferences are accepted", () => {
  for (const mode of modes) assert.equal(normalizeIPMode(mode), mode);
  for (const value of [undefined, null, "", " full ", "FULL", "tail", "compact", "constructor", "__proto__", 1, false, {}, ["full"]]) {
    assert.equal(normalizeIPMode(value), "dot", String(value));
  }
});

test("mode labels identify the selected family and compact representation", () => {
  assert.deepEqual(modes.map(ipModeLabel), ["hidden", "full global and internal", "global last octet", "internal last octet"]);
});

test("full mode shows global before internal and compact modes retain a leading dot", () => {
  assert.deepEqual(modes.map(mode => formatIPDisplay(addresses, mode).text), ["•", "192.0.2.53 / 10.42.0.11", ".53", ".11"]);
  for (const mode of ["full", "ext", "int"] as const) {
    assert.equal(formatIPDisplay(addresses, mode).description, "Global: 192.0.2.53. Internal: 10.42.0.11.");
  }
});

test("compact IPv4 retains zero and 255 octets with their leading dots", () => {
  const boundary = { internal: "10.42.0.0", global: "192.0.2.255" };
  assert.equal(formatIPDisplay(boundary, "int").text, ".0");
  assert.equal(formatIPDisplay(boundary, "ext").text, ".255");
});

test("a missing address never falls back to the other family", () => {
  const internalOnly = { internal: addresses.internal, global: null };
  const globalOnly = { internal: null, global: addresses.global };
  assert.equal(formatIPDisplay(internalOnly, "ext").text, "—");
  assert.equal(formatIPDisplay(globalOnly, "int").text, "—");
  assert.equal(formatIPDisplay(internalOnly, "full").text, addresses.internal);
  assert.equal(formatIPDisplay(globalOnly, "full").text, addresses.global);
  assert.equal(formatIPDisplay(internalOnly, "full").description, "Global: not reported. Internal: 10.42.0.11.");
  assert.equal(formatIPDisplay(globalOnly, "full").description, "Global: 192.0.2.53. Internal: not reported.");
});

test("missing or blank addresses stay unknown in every mode", () => {
  for (const missing of [{ internal: null, global: null }, { internal: " \t", global: "\n" }]) {
    for (const mode of modes) assert.equal(formatIPDisplay(missing, mode).text, "—");
    assert.equal(formatIPDisplay(missing, "dot").description, "IP addresses not reported.");
    assert.equal(formatIPDisplay(missing, "full").description, "Global: not reported. Internal: not reported.");
  }
});

test("hidden mode indicates either known address without including addresses in its description", () => {
  for (const known of [addresses, { internal: addresses.internal, global: null }, { internal: null, global: addresses.global }]) {
    assert.deepEqual(formatIPDisplay(known, "dot"), { text: "•", description: "IP addresses hidden." });
  }
});

test("compact modes keep complete IPv6 addresses, including embedded IPv4", () => {
  const ipv6 = { internal: "fd00:42::11", global: "2001:db8::53" };
  assert.equal(formatIPDisplay(ipv6, "int").text, ipv6.internal);
  assert.equal(formatIPDisplay(ipv6, "ext").text, ipv6.global);
  assert.equal(formatIPDisplay(ipv6, "full").text, "2001:db8::53 / fd00:42::11");
  assert.equal(formatIPDisplay({ internal: null, global: "::ffff:192.0.2.53" }, "ext").text, "::ffff:192.0.2.53");
});

test("formatter trims surrounding whitespace without mutating or reinterpreting source values", () => {
  const input = Object.freeze({ internal: " 10.42.0.11\n", global: "\t192.0.2.53 " });
  for (const mode of modes) assert.deepEqual(formatIPDisplay(input, mode), formatIPDisplay(addresses, mode));
  assert.deepEqual(input, { internal: " 10.42.0.11\n", global: "\t192.0.2.53 " });
  for (const value of ["256.0.2.53", "192.0.2", "192.0.2.053", "sample-host", "192.0.2.53/32"]) {
    assert.equal(formatIPDisplay({ internal: value, global: null }, "int").text, value);
  }
});
