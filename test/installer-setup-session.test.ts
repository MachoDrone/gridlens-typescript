import assert from "node:assert/strict";
import test from "node:test";
import { verifiedSetupNetwork } from "../src/installer/setup-session.ts";

test("network suggestions use actual assigned prefixes rather than guessing a network from the dashboard address", () => {
  const address = "192.168.42.18", entry = { address, family: "IPv4" as const, netmask: "255.255.254.0", cidr: `${address}/23`, mac: "00:00:00:00:00:00", internal: false };
  const context = verifiedSetupNetwork(address, "0.1.0-dev.5", { enp1s0: [entry] }, "fixture-backend", 1234)!;
  assert.equal(context.suggestedRange, "192.168.42.0/23"); assert.equal(context.releaseTag, "modern-v0.1.0-dev.5");
  assert.equal(context.verifiedAtMs, 1234);
  assert.equal(verifiedSetupNetwork(address, "0.1.0-dev.5", {}, "fixture-backend"), undefined);
  assert.equal(verifiedSetupNetwork(address, "0.1.0-dev.5", { docker0: [entry] }, "fixture-backend"), undefined);
  assert.equal(verifiedSetupNetwork(address, "0.1.0-dev.5", { enp1s0: [{ ...entry, cidr: `${address}/16` }] }, "fixture-backend")!.suggestedRange, address);
});
