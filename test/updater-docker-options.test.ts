import assert from "node:assert/strict";
import test from "node:test";
import { assertViewerUpdateDenied, captureUpdaterFailure, updaterAcceptanceOptions, updaterAcceptanceSource, verifyUpdaterTreasuryBindings } from "../scripts/test-updater-docker.ts";
import type { DockerRunner } from "../src/installer/docker.ts";
import { createMemorySnapshotStore } from "../src/server/snapshot-store.ts";
import { createSharedService } from "../src/backend/service.ts";
import { SharedHttpError } from "../src/backend/ipc.ts";
import { parseUpdateStatus } from "../src/contracts/updates.ts";

const args = ["--instance", "fixture-123456789abc", "--address", "10.71.0.8", "--https-port", "19790", "--web-port", "19789", "--base-image", "gridlens-source:current"];
const image = (security = true, treasury?: "0" | "1" | "2") => ({ Id: `sha256:${"a".repeat(64)}`, Config: { Labels: {
  "io.gridlens.product": "shared-backend", "io.gridlens.version": "0.1.0-dev.13", "io.gridlens.updater-protocol": "1",
  ...(security ? { "io.gridlens.browser-security-protocol": "1" } : {}),
  ...(treasury === undefined ? {} : { "io.gridlens.treasury-protocol": treasury }),
  ...(treasury === "2" ? { "io.gridlens.financial-security-protocol": "1", "io.gridlens.guardian-protocol": "1" } : {}),
} } });
function runner(value: unknown): DockerRunner {
  return { run(command) { assert.deepEqual(command, ["image", "inspect", "gridlens-source:fixture"]);
    return { status: 0, stdout: JSON.stringify(value), stderr: "" }; } };
}
test("viewer update rejection is exactly401, retains readable identity and never dispatches an update mutation", async () => {
  const values = new Map<string, unknown>(), state = { snapshots: createMemorySnapshotStore(),
    get: <T>(key: string) => values.get(key) as T | undefined, set(key: string, value: unknown) { values.set(key, structuredClone(value)); },
    batch(entries: readonly (readonly [string, unknown])[]) { for (const [key, value] of entries) values.set(key, structuredClone(value)); } };
  const build = { version: "0.1.0-generated", sequence: 24, buildId: "24:0.1.0-generated" };
  const saved = { version: 1, supported: true, canUpdate: true, checking: false, current: build, candidate: null, checkedAtMs: 1000, nextCheckAtMs: null, checkError: null,
    operation: { id: "generated-operation", revision: 1, target: build, previous: build, phase: "complete", startedAtMs: 1000, updatedAtMs: 1001,
      downloadedBytes: 1, totalBytes: 1, error: null, result: build } };
  const updates: string[] = [], service = createSharedService(state, { protectedMode: true, build,
    updates: async body => { updates.push(String(body.operation)); return structuredClone(saved); } });
  const token = "v".repeat(43); service.access.setFleet("default", []); service.access.registerGateway("default", token);
  try {
    const before = parseUpdateStatus(await service.read({ operation: "updates-status", token }));
    await assert.rejects(service.read({ operation: "updates-check", token }), error => error instanceof SharedHttpError && error.status === 401);
    const readable = await service.read({ operation: "status", token }) as { role: string };
    const after = parseUpdateStatus(await service.read({ operation: "updates-status", token }));
    assertViewerUpdateDenied(401, readable.role, before, after);
    assert.deepEqual(updates, ["status", "status"]);
    for (const status of [200, 403, 500]) assert.throws(() => assertViewerUpdateDenied(status, "viewer", before, after));
    assert.throws(() => assertViewerUpdateDenied(401, "operator", before, after));
    assert.throws(() => assertViewerUpdateDenied(401, "viewer", before, { ...after, operation: null }));
  } finally { await service.setup.close(); }
});
test("failed updater capture preserves stopped-worker identity and uses only readonly state volumes", () => {
  const instance = "fixture-123456789abc", imageId = `sha256:${"a".repeat(64)}`, calls: readonly string[][] = [];
  const recorded = calls as string[][];
  const diagnostics = captureUpdaterFailure({ run(args) {
    recorded.push([...args]);
    if (args[1] === "inspect") {
      const labels = { "io.gridlens.product": "shared-backend", "io.gridlens.instance": instance };
      return { status: 0, stderr: "", stdout: JSON.stringify([{ Id: "generated", Image: imageId, Labels: labels,
        Config: { Labels: labels, Env: ["GRIDLENS_TREASURY_PROTOCOL=1", "GENERATED_SECRET=must-not-escape"] }, State: { Running: false, ExitCode: 0 } }]) };
    }
    assert.equal(args[0], "run"); assert.equal(args[args.indexOf("--network") + 1], "none");
    const mounts = args.flatMap((value, index) => value === "--mount" ? [args[index + 1]!] : []);
    assert.equal(mounts.length, 2); assert.ok(mounts.every(value => value.endsWith(",readonly")));
    assert.ok(mounts.some(value => value.includes("dst=/config"))); assert.ok(mounts.some(value => value.includes("dst=/update-state")));
    assert.equal(mounts.some(value => /credentials|tls|ledger/.test(value)), false);
    return { status: 0, stderr: "", stdout: JSON.stringify({ journal: { status: { operation: { phase: "failed", error: "Generated original failure" } } } }) };
  } }, instance, imageId);
  assert.ok(JSON.stringify(diagnostics).includes("Generated original failure"));
  assert.equal(JSON.stringify(diagnostics).includes("GENERATED_SECRET"), false);
  assert.equal(recorded.some(args => ["stop", "rm", "start"].includes(args[0]!)), false);
});

test("updater acceptance keeps same-source default and accepts a separate tagged older source", () => {
  assert.equal(updaterAcceptanceOptions(args).previousImage, undefined);
  const options = updaterAcceptanceOptions([...args, "--previous-image", "gridlens-modern-build:0.1.0-dev.13-13"]);
  assert.equal(options.baseImage, "gridlens-source:current"); assert.equal(options.previousImage, "gridlens-modern-build:0.1.0-dev.13-13");
  for (const value of ["sha256:" + "a".repeat(64), "bad image", "--latest", "image;command"])
    assert.throws(() => updaterAcceptanceOptions([...args, "--previous-image", value]));
  assert.throws(() => updaterAcceptanceOptions([...args, "--previous-image", "old:1", "--previous-image", "old:2"]));
});

test("cold updater acceptance explicitly selects gzip without changing the legacy tar artifact contract", () => {
  assert.equal(updaterAcceptanceOptions(args).archiveCompression, undefined);
  for (const value of ["none", "gzip"] as const)
    assert.equal(updaterAcceptanceOptions([...args, "--archive-compression", value]).archiveCompression, value);
  for (const value of ["zip", "auto", "--gzip", "gzip;command"])
    assert.throws(() => updaterAcceptanceOptions([...args, "--archive-compression", value]));
});

test("source inspection pins immutable identity and distinguishes old guide migration from already supported HTTPS", () => {
  const current = image(), previous = image(false);
  assert.deepEqual(updaterAcceptanceSource(runner([current]), "gridlens-source:fixture"), { imageId: current.Id, version: "0.1.0-dev.13", browserSecurity: true, treasury: false, treasuryProtocol: 0, financialSecurity: false, minimumCoordinator: 1 });
  assert.deepEqual(updaterAcceptanceSource(runner([previous]), "gridlens-source:fixture", true), { imageId: previous.Id, version: "0.1.0-dev.13", browserSecurity: false, treasury: false, treasuryProtocol: 0, financialSecurity: false, minimumCoordinator: 1 });
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
    const protectedImage = updaterAcceptanceSource(runner([image(true, "2")]), "gridlens-source:fixture", previous);
    assert.equal(protectedImage.treasuryProtocol, 2); assert.equal(protectedImage.financialSecurity, true); assert.equal(protectedImage.minimumCoordinator, 3);
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
