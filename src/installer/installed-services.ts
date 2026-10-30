import { ensureVpnWeb, readVpnWebEndpoint } from "./vpn-web.ts";
import type { VpnWebEndpoint } from "./vpn-web.ts";
import type { DockerRunner } from "./docker.ts";
import type { InstallResult } from "./coordinator.ts";
import type { ModernRelease } from "./release.ts";
import { ensureUpdater, stopUpdater } from "../updater/deployment.ts";

/** Reconcile only the revision actually selected by the coordinator. In
 * particular, a retained newer runtime never receives the older public image. */
export function reconcileInstalledServices(runner: DockerRunner, result: InstallResult, requested: ModernRelease,
  { action, vpnWeb = false, webPort }: { action: "setup" | "upgrade" | "rollback"; vpnWeb?: boolean; webPort?: number }): VpnWebEndpoint | undefined {
  const saved = readVpnWebEndpoint(runner, result.config);
  if (result.retainedNewer) return saved;
  const active = result.config.active;
  const selected = { ...requested, imageId: active.imageId, version: active.version, sequence: active.sequence };
  const web = vpnWeb || saved && (action === "upgrade" || action === "rollback")
    ? ensureVpnWeb(runner, result.config, selected, webPort ?? saved?.port, { upgrade: true }) : saved;
  if (result.config.updater) ensureUpdater(runner, result.config, { replace: true });
  else stopUpdater(runner, result.config.instance);
  return web;
}
