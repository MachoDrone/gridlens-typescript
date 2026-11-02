import assert from "node:assert/strict";
import test from "node:test";
import { updaterAcceptanceOptions, updaterAcceptanceSource, verifyUpdaterTreasuryBindings } from "../scripts/test-updater-docker.ts";
import type { DockerRunner } from "../src/installer/docker.ts";

const args = ["--instance", "fixture-123456789abc", "--address", "10.71.0.8", "--https-port", "19790", "--web-port", "19789", "--base-image", "gridlens-source:current"];
const image = (security = true, treasury?: "0" | "1") => ({ Id: `sha256:${"a".repeat(64)}`, Config: { Labels: {
  "io.gridlens.product": "shared-backend", "io.gridlens.version": "0.1.0-dev.13", "io.gridlens.updater-protocol": "1",
  ...(security ? { "io.gridlens.browser-security-protocol": "1" } : {}),
  ...(treasury === undefined ? {} : { "io.gridlens.treasury-protocol": treasury }),
} } });
function runner(value: unknown): DockerRunner {
  return { run(command) { assert.deepEqual(command, ["image", "inspect", "gridlens-source:fixture"]);
    return { status: 0, stdout: JSON.stringify(value), stderr: "" }; } };
}

test("updater acceptance keeps same-source default and accepts a separate tagged older source", () => {
  assert.equal(updaterAcceptanceOptions(args).previousImage, undefined);
  const options = updaterAcceptanceOptions([...args, "--previous-image", "gridlens-modern-build:0.1.0-dev.13-13"]);
  assert.equal(options.baseImage, "gridlens-source:current"); assert.equal(options.previousImage, "gridlens-modern-build:0.1.0-dev.13-13");
  for (const value of ["sha256:" + "a".repeat(64), "bad image", "--latest", "image;command"])
    assert.throws(() => updaterAcceptanceOptions([...args, "--previous-image", value]));
  assert.throws(() => updaterAcceptanceOptions([...args, "--previous-image", "old:1", "--previous-image", "old:2"]));
});

test("source inspection pins immutable identity and distinguishes old guide migration from already supported HTTPS", () => {
  const current = image(), previous = image(false);
  assert.deepEqual(updaterAcceptanceSource(runner([current]), "gridlens-source:fixture"), { imageId: current.Id, version: "0.1.0-dev.13", browserSecurity: true, treasury: false, minimumCoordinator: 1 });
  assert.deepEqual(updaterAcceptanceSource(runner([previous]), "gridlens-source:fixture", true), { imageId: previous.Id, version: "0.1.0-dev.13", browserSecurity: false, treasury: false, minimumCoordinator: 1 });
  assert.equal(updaterAcceptanceSource(runner([current]), "gridlens-source:fixture", true).browserSecurity, true);
  assert.throws(() => updaterAcceptanceSource(runner([previous]), "gridlens-source:fixture"), /guided browser setup support/);
  for (const invalid of [[], [current, current], null, [{ ...current, Id: "mutable-tag" }],
    [{ ...current, Config: { Labels: { ...current.Config.Labels, "io.gridlens.product": "unowned" } } }],
    [{ ...previous, Config: { Labels: { ...previous.Config.Labels, "io.gridlens.updater-protocol": "2" } } }]])
    assert.throws(() => updaterAcceptanceSource(runner(invalid), "gridlens-source:fixture", true));
});

test("staged Wallet acceptance derives the coordinator requirement from the immutable image capability", () => {
  for (const previous of [false, true]) {
    const compatible = updaterAcceptanceSource(runner([image(true, "0")]), "gridlens-source:fixture", previous);
    assert.equal(compatible.treasury, false); assert.equal(compatible.minimumCoordinator, 1);
    const wallet = updaterAcceptanceSource(runner([image(true, "1")]), "gridlens-source:fixture", previous);
    assert.equal(wallet.treasury, true); assert.equal(wallet.minimumCoordinator, 2);
  }
  assert.throws(() => updaterAcceptanceSource(runner([image(false, "1")]), "gridlens-source:fixture", true));
  for (const field of ["io.gridlens.browser-security-protocol", "io.gridlens.treasury-protocol"]) {
    const current = image();
    assert.throws(() => updaterAcceptanceSource(runner([{ ...current, Config: { Labels: { ...current.Config.Labels, [field]: "2" } } }]), "gridlens-source:fixture", true));
  }
});

test("real acceptance mount checks reject financial IPC in HTTP/updater and require exact owner/HTTPS bindings", () => {
  const instance = "fixture-123456789abc", volume = `gridlens-modern-${instance}-treasury-ipc`;
  const absent = { Mounts: [], Config: { Env: ["NODE_OPTIONS=--import=/app/fixture-fetch.mjs"] } };
  const configured = (writable: boolean) => ({ Mounts: [{ Name: volume, Destination: "/treasury", Type: "volume", RW: writable }],
    Config: { Env: ["GRIDLENS_TREASURY_SOCKET=/treasury/treasury.sock"] } });
  for (const role of ["owner", "gateway", "vpn-web", "updater"]) verifyUpdaterTreasuryBindings(instance, role, absent, false);
  verifyUpdaterTreasuryBindings(instance, "owner", configured(true), true);
  verifyUpdaterTreasuryBindings(instance, "gateway", configured(false), true);
  for (const role of ["vpn-web", "updater"]) {
    verifyUpdaterTreasuryBindings(instance, role, absent, true);
    assert.throws(() => verifyUpdaterTreasuryBindings(instance, role, configured(false), true));
    assert.throws(() => verifyUpdaterTreasuryBindings(instance, role, { ...absent, Config: configured(false).Config }, true));
  }
  assert.throws(() => verifyUpdaterTreasuryBindings(instance, "owner", configured(false), true));
  assert.throws(() => verifyUpdaterTreasuryBindings(instance, "gateway", configured(true), true));
  assert.throws(() => verifyUpdaterTreasuryBindings(instance, "gateway", { ...configured(false), Mounts: [{ ...configured(false).Mounts[0], Name: "unrelated" }] }, true));
  assert.throws(() => verifyUpdaterTreasuryBindings(instance, "updater", { ...absent, Mounts: [{ Name: "unrelated", Destination: "/treasury/treasury.sock", Type: "bind", RW: false }] }, true));
});
