import type { InstallationConfig } from "../../src/installer/config.ts";

/** Frozen owner command contract from published dev.22 (a038943,
 * src/installer/coordinator.ts). Do not derive this from the new coordinator:
 * an old installed updater cannot add future environment variables. */
export function coordinatorV2OwnerArguments(config: InstallationConfig): string[] {
  const name = (suffix: string) => `gridlens-modern-${config.instance}-${suffix}`;
  const volume = (source: string, destination: string, readonly = false) => ["--mount", `type=volume,src=${source},dst=${destination}${readonly ? ",readonly" : ""}`];
  return ["run", "--detach", "--restart", "unless-stopped", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "128",
    "--user", "1000:1000", "--label", "io.gridlens.product=shared-backend", "--label", `io.gridlens.instance=${config.instance}`, "--network", name("network"), "--name", name("owner"),
    ...volume(config.active.stateVolume, "/state"), ...volume(name("ledger"), "/ledger"), ...volume(name("read-ipc"), "/ipc"), ...volume(name("control-ipc"), "/control"),
    ...volume(name("credentials"), "/credentials"), ...volume(name("treasury-ipc"), "/treasury"), "--env", "GRIDLENS_TREASURY_SOCKET=/treasury/treasury.sock",
    ...(config.updater ? [...volume(name("updates-ipc"), "/updates", true), "--env", "GRIDLENS_UPDATE_SOCKET=/updates/updater.sock"] : []),
    "--env", "GRIDLENS_STATE_DIR=/state", "--env", "GRIDLENS_LEDGER_DIR=/ledger", "--env", "GRIDLENS_SOCKET_DIR=/ipc", "--env", "GRIDLENS_CONTROL_DIR=/control",
    "--env", "GRIDLENS_CREDENTIAL_DIR=/credentials", config.active.imageId, "node", "scripts/shared-owner.ts"];
}
