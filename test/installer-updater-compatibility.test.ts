import assert from "node:assert/strict";
import test from "node:test";
import type { TestContext } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../src/installer/coordinator.ts";
import { reconcileInstalledServices } from "../src/installer/installed-services.ts";
import { resourceName } from "../src/installer/docker.ts";
import type { ModernRelease } from "../src/installer/release.ts";
import { UpdateDockerFixture } from "./fixtures/updater-docker.ts";

const release = (sequence: number): ModernRelease => ({ format: "gridlens-modern-release-v1", version: `0.1.0-compat.${sequence}`, sequence,
  platform: "linux-x64", minimumCoordinator: 1, imageId: `sha256:${String(sequence).repeat(64)}`,
  runtime: { name: `gridlens-runtime-compat-${sequence}.tar`, bytes: 1, sha256: "a".repeat(64) } });
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "gridlens-updater-compat-")), instance = "fixture-compatibility";
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runner = new UpdateDockerFixture(instance, join(directory, "installation.json"), [release(1), release(2), release(3)]);
  const coordinator = new Coordinator(runner);
  const container = (role: string) => runner.objects.get(`container:${resourceName(instance, role)}`)!;
  const install = (sequence: number, action: "setup" | "upgrade" | "rollback") => coordinator.install({ instance, release: release(sequence), action, enableUpdater: true,
    ...(runner.config ? {} : { bindAddress: "10.71.0.8", port: 8789 }) });
  return { instance, runner, coordinator, container, install };
}
const mutates = (args: string[]): boolean => ["stop", "rm", "start"].includes(args[0]!) || args.includes("--detach")
  || args[1] === "create" || args.at(-1) === "save" || args.at(-1) === "updater-initialize";

for (const capable of [false, true]) test(`an older public release preserves the entire newer ${capable ? "updater-capable" : "pre-updater"} installation`, t => {
  const f = fixture(t);
  if (!capable) f.runner.updaterImages.delete(release(2).imageId);
  const initial = f.install(2, "setup");
  reconcileInstalledServices(f.runner, initial, release(2), { action: "setup", vpnWeb: true, webPort: 8799 });
  const config = structuredClone(f.runner.config), resources = structuredClone(f.runner.objects), before = f.runner.calls.length;
  const retained = f.install(1, "upgrade");
  assert.equal(retained.retainedNewer, true);
  assert.deepEqual(retained.config, config);
  const web = reconcileInstalledServices(f.runner, retained, release(1), { action: "upgrade", vpnWeb: true });
  assert.equal(web?.origin, "http://10.71.0.8:8799"); assert.equal(web.imageId, release(2).imageId);
  assert.deepEqual(f.runner.objects, resources);
  assert.deepEqual(f.runner.config, config);
  assert.ok(!f.runner.calls.slice(before).some(mutates), "retention cannot create, restart, configure or replace resources");
});

test("an incapable selected image never receives updater mounts, volumes or worker commands", t => {
  const f = fixture(t); f.runner.updaterImages.delete(release(1).imageId);
  const first = f.install(1, "setup");
  reconcileInstalledServices(f.runner, first, release(1), { action: "setup", vpnWeb: true, webPort: 8799 });
  assert.equal(first.config.updater, undefined);
  for (const role of ["owner", "gateway", "vpn-web"]) {
    const value = f.container(role), config = value.Config as { Env: string[] }, mounts = value.Mounts as { Destination: string }[];
    assert.ok(!config.Env.some(item => /^GRIDLENS_UPDATES=|^GRIDLENS_UPDATE_SOCKET=/.test(item)));
    assert.ok(!mounts.some(item => item.Destination === "/updates"));
  }
  assert.equal(f.container("updater"), undefined);
  assert.ok(![...f.runner.objects.keys()].some(name => /(?:update-state|updates-ipc)$/.test(name)));
  assert.ok(!f.runner.calls.some(args => args.includes("scripts/shared-updater.ts")));
});

test("migration rollback restores the old browser/owner composition and stops only the verified worker while keeping durable volumes", t => {
  const f = fixture(t); f.runner.updaterImages.delete(release(1).imageId);
  const first = f.install(1, "setup");
  reconcileInstalledServices(f.runner, first, release(1), { action: "setup", vpnWeb: true, webPort: 8799 });
  const next = f.install(2, "upgrade");
  reconcileInstalledServices(f.runner, next, release(2), { action: "upgrade" });
  assert.equal(next.config.updater?.protocol, 1);
  const volumes = [...f.runner.objects.keys()].filter(name => name.startsWith("volume:")).sort();
  const before = f.runner.calls.length;
  const restored = f.install(2, "rollback");
  const web = reconcileInstalledServices(f.runner, restored, release(2), { action: "rollback" });
  assert.deepEqual(restored.config.active, first.config.active);
  assert.equal(restored.config.updater, undefined);
  assert.equal(restored.config.certificateSha256, first.config.certificateSha256);
  assert.equal(web?.origin, "http://10.71.0.8:8799"); assert.equal(web.imageId, release(1).imageId);
  for (const role of ["owner", "gateway", "vpn-web"]) {
    const value = f.container(role), config = value.Config as { Env: string[] };
    assert.equal(value.Image, release(1).imageId);
    assert.ok(!config.Env.some(item => /^GRIDLENS_UPDATES=|^GRIDLENS_UPDATE_SOCKET=/.test(item)));
  }
  assert.equal(f.container("updater").Image, release(2).imageId);
  assert.deepEqual(f.container("updater").State, { Running: false });
  assert.deepEqual([...f.runner.objects.keys()].filter(name => name.startsWith("volume:")).sort(), volumes);
  assert.ok(!f.runner.calls.slice(before).some(args => args.includes("scripts/shared-updater.ts")));
  assert.ok(!f.runner.calls.slice(before).some(args => args[0] === "volume" && args[1] === "rm"));
  const enabledAgain = f.install(2, "upgrade");
  reconcileInstalledServices(f.runner, enabledAgain, release(2), { action: "upgrade" });
  assert.equal(enabledAgain.config.updater?.protocol, 1);
  assert.deepEqual(f.container("updater").State, { Running: true });
});

test("rollback among capable releases preserves browser updates and chooses the selected image for both gateways and worker", t => {
  const f = fixture(t), first = f.install(1, "setup");
  reconcileInstalledServices(f.runner, first, release(1), { action: "setup", vpnWeb: true, webPort: 8799 });
  const next = f.install(2, "upgrade"); reconcileInstalledServices(f.runner, next, release(2), { action: "upgrade" });
  const restored = f.install(2, "rollback"); reconcileInstalledServices(f.runner, restored, release(2), { action: "rollback" });
  assert.equal(restored.config.updater?.protocol, 1);
  for (const role of ["owner", "gateway", "vpn-web", "updater"]) assert.equal(f.container(role).Image, release(1).imageId);
});

test("rollback never stops a worker whose isolation drifted", t => {
  const f = fixture(t); f.runner.updaterImages.delete(release(1).imageId);
  const first = f.install(1, "setup"); reconcileInstalledServices(f.runner, first, release(1), { action: "setup", vpnWeb: true, webPort: 8799 });
  const next = f.install(2, "upgrade"); reconcileInstalledServices(f.runner, next, release(2), { action: "upgrade" });
  (f.container("updater").Mounts as unknown[]).push({ Type: "bind", Source: "/", Destination: "/unexpected", RW: true });
  const before = f.runner.calls.length, saved = structuredClone(f.runner.config);
  assert.throws(() => f.install(2, "rollback"), /isolation changed/);
  assert.deepEqual(f.runner.config, saved);
  assert.ok(!f.runner.calls.slice(before).some(args => ["stop", "rm"].includes(args[0]!)));
});

test("the release Dockerfile declares its immutable browser updater capability", () => {
  assert.match(readFileSync(new URL("../Dockerfile.shared", import.meta.url), "utf8"), /LABEL[^\n]*io\.gridlens\.updater-protocol="1"/);
});
