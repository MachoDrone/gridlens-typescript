import assert from "node:assert/strict";
import test from "node:test";
import { updaterAcceptanceOptions, updaterAcceptanceSource } from "../scripts/test-updater-docker.ts";
import type { DockerRunner } from "../src/installer/docker.ts";

const args = ["--instance", "fixture-123456789abc", "--address", "10.71.0.8", "--https-port", "19790", "--web-port", "19789", "--base-image", "gridlens-source:current"];
const image = (security = true) => ({ Id: `sha256:${"a".repeat(64)}`, Config: { Labels: {
  "io.gridlens.product": "shared-backend", "io.gridlens.version": "0.1.0-dev.13", "io.gridlens.updater-protocol": "1",
  ...(security ? { "io.gridlens.browser-security-protocol": "1" } : {}),
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

test("source inspection pins immutable identity and distinguishes legacy first image from guided-setup targets", () => {
  const current = image(), previous = image(false);
  assert.deepEqual(updaterAcceptanceSource(runner([current]), "gridlens-source:fixture"), { imageId: current.Id, version: "0.1.0-dev.13" });
  assert.deepEqual(updaterAcceptanceSource(runner([previous]), "gridlens-source:fixture", true), { imageId: previous.Id, version: "0.1.0-dev.13" });
  assert.throws(() => updaterAcceptanceSource(runner([current]), "gridlens-source:fixture", true), /predating guided browser setup/);
  assert.throws(() => updaterAcceptanceSource(runner([previous]), "gridlens-source:fixture"), /guided browser setup support/);
  for (const invalid of [[], [current, current], null, [{ ...current, Id: "mutable-tag" }],
    [{ ...current, Config: { Labels: { ...current.Config.Labels, "io.gridlens.product": "unowned" } } }],
    [{ ...previous, Config: { Labels: { ...previous.Config.Labels, "io.gridlens.updater-protocol": "2" } } }]])
    assert.throws(() => updaterAcceptanceSource(runner(invalid), "gridlens-source:fixture", true));
});
