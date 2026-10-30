/** Installer-owned updater deployment. No browser-selected commands, paths or mounts. */
import { DatabaseSync } from "node:sqlite";
import { chmodSync, lstatSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checked, ensureVolume, inspectOwned, labels, mount, resourceName, restrictions } from "../installer/docker.ts";
import type { DockerRunner } from "../installer/docker.ts";
import type { InstallationConfig } from "../installer/config.ts";
import { InstallerError } from "../installer/release.ts";
import { parseUpdateStatus, updateActive } from "../contracts/updates.ts";

export const DOCKER_SOCKET = "/var/run/docker.sock";
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const imageId = (value: string): string => { if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new InstallerError("Invalid updater image identity."); return value; };
export function updaterArguments(instance: string, image: string): string[] {
  resourceName(instance, "updater"); imageId(image);
  return ["run", "--detach", "--restart", "unless-stopped", ...restrictions, "--user", "0:1000", ...labels(instance),
    "--label", "io.gridlens.role=updater", "--name", resourceName(instance, "updater"), "--network", resourceName(instance, "network"),
    "--mount", `type=bind,src=${DOCKER_SOCKET},dst=${DOCKER_SOCKET}`,
    ...mount(resourceName(instance, "config"), "/config"), ...mount(resourceName(instance, "update-state"), "/update-state"),
    ...mount(resourceName(instance, "updates-ipc"), "/updates"),
    "--env", `GRIDLENS_UPDATER_INSTANCE=${instance}`, "--env", "GRIDLENS_UPDATER_STATE_DIR=/update-state",
    "--env", "GRIDLENS_UPDATER_SOCKET=/updates/updater.sock", "--env", "GRIDLENS_UPDATER_PUBLIC_KEY_FILE=/app/update-public-key.pem",
    image, "node", "scripts/shared-updater.ts"];
}
function validateWorkerContainer(instance: string, value: Record<string, unknown>, expected: {
  role: string; user: string; command: string[]; restart: string; image?: string;
}): void {
  const host = object(value.HostConfig), config = object(value.Config), mounts = value.Mounts;
  const volumes = new Map([[resourceName(instance, "config"), "/config"], [resourceName(instance, "update-state"), "/update-state"], [resourceName(instance, "updates-ipc"), "/updates"]]);
  if (expected.image !== undefined && value.Image !== expected.image || typeof value.Image !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.Image)
    || object(config.Labels)["io.gridlens.role"] !== expected.role || config.User !== expected.user || !equal(config.Cmd, expected.command)
    || host.ReadonlyRootfs !== true || host.Privileged !== false || host.NetworkMode !== resourceName(instance, "network")
    || !equal(host.CapDrop, ["ALL"]) || Array.isArray(host.CapAdd) && host.CapAdd.length > 0
    || ![undefined, ""].includes(host.PidMode as string | undefined) || ![undefined, "", "private"].includes(host.IpcMode as string | undefined)
    || host.UTSMode === "host" || Object.keys(object(host.PortBindings)).length || host.PublishAllPorts === true
    || Array.isArray(host.Binds) && host.Binds.length > 0 || Array.isArray(host.Devices) && host.Devices.length > 0
    || !Array.isArray(host.SecurityOpt) || !host.SecurityOpt.some(v => v === "no-new-privileges" || v === "no-new-privileges:true")
    || object(host.RestartPolicy).Name !== expected.restart || host.PidsLimit !== 128
    || !Array.isArray(mounts) || mounts.length !== 4 || !mounts.some(raw => { const m = object(raw); return m.Type === "bind" && m.Source === DOCKER_SOCKET && m.Destination === DOCKER_SOCKET && m.RW === true; })
    || [...volumes].some(([name, destination]) => !mounts.some(raw => { const m = object(raw); return m.Type === "volume" && m.Name === name && m.Destination === destination && m.RW === true; })))
    throw new InstallerError("The updater's identity or isolation changed. It was left untouched.");
}
export function validateUpdater(instance: string, value: Record<string, unknown>, expectedImage?: string): void {
  validateWorkerContainer(instance, value, { role: "updater", user: "0:1000", command: ["node", "scripts/shared-updater.ts"], restart: "unless-stopped",
    ...(expectedImage === undefined ? {} : { image: expectedImage }) });
}
function validateReplacement(instance: string, value: Record<string, unknown>, image: string, operationId: string): void {
  validateWorkerContainer(instance, value, { role: "updater-replacement", user: "0:0", restart: "no", image,
    command: ["node", "src/updater/runtime.ts", "--replace-worker", instance, operationId] });
}
export function ensureUpdater(runner: DockerRunner, config: InstallationConfig, { replace = false }: { replace?: boolean } = {}): void {
  if (!config.updater || config.phase !== "ready") throw new InstallerError("Finish the updater-capable installation before starting browser updates.");
  for (const suffix of ["updates-ipc", "update-state"]) ensureVolume(runner, resourceName(config.instance, suffix), config.instance);
  checked(runner, ["run", "--rm", "-i", ...labels(config.instance), ...restrictions, "--network", "none", "--user", "0:0",
    "--cap-add", "CHOWN",
    ...mount(resourceName(config.instance, "updates-ipc"), "/updates"), ...mount(resourceName(config.instance, "update-state"), "/update-state"),
    config.active.imageId, "node", "src/installer/container-init.ts", "updater-initialize"], "{}");
  const name = resourceName(config.instance, "updater");
  const existing = inspectOwned(runner, "container", name, config.instance);
  if (existing) {
    validateUpdater(config.instance, existing);
    if (existing.Image !== config.active.imageId && !replace) throw new InstallerError("The updater uses a different release. Finish its recorded update transaction.");
    if (existing.Image === config.active.imageId) {
      if (object(existing.State).Running !== true) checked(runner, ["start", name]);
      return;
    }
    if (object(existing.State).Running === true) checked(runner, ["stop", "--time", "30", name]);
    checked(runner, ["rm", name]);
  }
  checked(runner, updaterArguments(config.instance, config.active.imageId));
  const current = inspectOwned(runner, "container", name, config.instance);
  if (!current) throw new InstallerError("The updater was not created.");
  validateUpdater(config.instance, current, config.active.imageId);
}
/** A deliberate rollback may select a release predating browser updates. Keep
 * the worker and all durable volumes, but prevent its restart against old code. */
export function stopUpdater(runner: DockerRunner, instance: string): void {
  const replacement = inspectOwned(runner, "container", resourceName(instance, "updater-replacement"), instance);
  if (replacement && object(replacement.State).Running === true)
    throw new InstallerError("Updater replacement is still finishing. Retry maintenance after it completes.");
  const name = resourceName(instance, "updater"), existing = inspectOwned(runner, "container", name, instance);
  if (!existing) return;
  validateUpdater(instance, existing);
  if (object(existing.State).Running === true) checked(runner, ["stop", "--time", "30", name]);
}
/** SQLite's OS lock disappears on helper death. It is never a timer-based lease. */
export async function acquireMaintenanceLock(runner: DockerRunner, instance: string, image: string): Promise<() => Promise<void>> {
  if (!runner.hold) throw new InstallerError("The Docker runner cannot hold the installation lock.");
  ensureVolume(runner, resourceName(instance, "config"), instance);
  return runner.hold(["run", "--rm", "-i", "--name", resourceName(instance, `maintenance-${randomBytes(8).toString("hex")}`),
    ...labels(instance), ...restrictions, "--network", "none", "--user", "0:0",
    ...mount(resourceName(instance, "config"), "/config"), imageId(image), "node", "src/updater/deployment.ts", "--hold-lock"]);
}
/** Terminal work consults durable state even while the updater is being replaced. */
export function assertNoActiveUpdate(directory = "/update-state"): void {
  const path = join(directory, "updates.sqlite"), stat = lstatSync(path);
  if (!stat.isFile()) throw new InstallerError("The updater journal cannot be verified. Existing runtime was retained.");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM journal WHERE id=1").get();
    if (!row || typeof row.value !== "string" || Buffer.byteLength(row.value) > 128 * 1024) throw new InstallerError("The updater journal cannot be verified. Existing runtime was retained.");
    const state = parseUpdateStatus(JSON.parse(row.value).status);
    if (updateActive(state.operation)) throw new InstallerError("A browser update is still in progress. Let it finish before running installer maintenance.");
  } finally { db.close(); }
}
export function guardTerminalUpdate(runner: DockerRunner, config: InstallationConfig): void {
  if (!config.updater) return;
  if (!inspectOwned(runner, "volume", resourceName(config.instance, "update-state"), config.instance))
    throw new InstallerError("The updater journal is missing. Existing runtime was retained.");
  checked(runner, ["run", "--rm", ...labels(config.instance), ...restrictions, "--network", "none", "--user", "0:0",
    ...mount(resourceName(config.instance, "update-state"), "/update-state", true), config.active.imageId,
    "node", "src/updater/deployment.ts", "--terminal-guard"]);
}
export async function holdMaintenanceLock(path = "/config/maintenance.sqlite"): Promise<void> {
  const database = new DatabaseSync(path);
  try {
    chmodSync(path, 0o600); database.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
    process.stdout.write("GRIDLENS_LOCK_READY\n");
    await new Promise<void>(done => { process.stdin.resume(); process.stdin.once("end", done); process.stdin.once("error", done); process.once("SIGTERM", done); process.once("SIGINT", done); });
    database.exec("ROLLBACK");
  } finally { database.close(); process.stdin.pause(); process.stdin.destroy(); }
}
export async function launchWorkerReplacement(runner: DockerRunner, instance: string, image: string, operationId: string): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(operationId)) throw new InstallerError("Invalid update operation.");
  const name = resourceName(instance, "updater-replacement"), existing = inspectOwned(runner, "container", name, instance);
  if (existing) {
    validateReplacement(instance, existing, image, operationId);
    if (object(existing.State).Running === true) return;
    checked(runner, ["rm", name]);
  }
  checked(runner, ["run", "--detach", "--rm", ...restrictions, "--user", "0:0", ...labels(instance), "--label", "io.gridlens.role=updater-replacement",
    "--name", name, "--network", resourceName(instance, "network"), "--mount", `type=bind,src=${DOCKER_SOCKET},dst=${DOCKER_SOCKET}`,
    ...mount(resourceName(instance, "config"), "/config"), ...mount(resourceName(instance, "update-state"), "/update-state"),
    ...mount(resourceName(instance, "updates-ipc"), "/updates"), imageId(image), "node", "src/updater/runtime.ts", "--replace-worker", instance, operationId]);
  const created = inspectOwned(runner, "container", name, instance);
  if (!created) throw new InstallerError("The updater replacement helper could not be verified.");
  validateReplacement(instance, created, image, operationId);
}
if (typeof import.meta.url === "string" && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--hold-lock") void holdMaintenanceLock().catch(() => { process.stderr.write("Installation lock unavailable.\n"); process.exitCode = 1; });
  else if (process.argv[2] === "--terminal-guard") {
    try { assertNoActiveUpdate(); process.stdout.write("No active browser update.\n"); }
    catch (error) { console.error(error instanceof InstallerError ? error.message : "The updater journal cannot be verified. Existing runtime was retained."); process.exitCode = 1; }
  } else process.exitCode = 1;
}
