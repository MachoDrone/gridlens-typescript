import test from "node:test";
import assert from "node:assert/strict";
import { fixtureImageCapabilities } from "../scripts/shared-docker-fixture.ts";
import { claimUnitsImageIdentity } from "../scripts/test-claim-units-docker.ts";

function image(protocol: string | undefined, version = "0.1.0-dev.24") {
  return [{ Id: `sha256:${"a".repeat(64)}`, Config: { Labels: { "io.gridlens.product": "shared-backend", "io.gridlens.version": version,
    ...(protocol === undefined ? {} : { "io.gridlens.treasury-protocol": protocol }),
    ...(protocol === "2" ? { "io.gridlens.financial-security-protocol": "1", "io.gridlens.guardian-protocol": "1", "io.gridlens.browser-security-protocol": "1" } : {}) } } }];
}
test("claim fixtures accept supported compatibility/protected candidates while old20 stays exactly protocol1", () => {
  assert.equal(claimUnitsImageIdentity(image("1", "0.1.0-dev.23"), false), image("1")[0]!.Id);
  assert.equal(claimUnitsImageIdentity(image("2"), false), image("2")[0]!.Id);
  assert.equal(claimUnitsImageIdentity(image("1", "0.1.0-dev.20"), true), image("1")[0]!.Id);
  for (const value of [image("2", "0.1.0-dev.20"), image("1", "0.1.0-dev.21"), image("0", "0.1.0-dev.20")])
    assert.throws(() => claimUnitsImageIdentity(value, true));
  for (const value of [image(undefined), image("0"), image("3")]) assert.throws(() => claimUnitsImageIdentity(value, false));
});
test("protected fixture capabilities require all protection labels and select minimum coordinator3", () => {
  assert.equal(fixtureImageCapabilities(image("2")).minimumCoordinator, 3);
  assert.equal(fixtureImageCapabilities(image("1")).minimumCoordinator, 2);
  assert.equal(fixtureImageCapabilities(image("0")).minimumCoordinator, 1);
  for (const key of ["io.gridlens.financial-security-protocol", "io.gridlens.guardian-protocol", "io.gridlens.browser-security-protocol"]) {
    const value = image("2"); (value[0]!.Config.Labels as Record<string, string>)[key] = "0";
    assert.throws(() => fixtureImageCapabilities(value)); assert.throws(() => claimUnitsImageIdentity(value, false));
  }
  assert.throws(() => fixtureImageCapabilities([...image("2"), ...image("2")]));
  assert.throws(() => fixtureImageCapabilities([{ ...image("2")[0], Id: "mutable-tag" }]));
});
