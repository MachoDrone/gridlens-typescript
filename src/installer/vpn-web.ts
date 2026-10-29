import { originFor, validateInstallation } from "./config.ts";
import type { InstallationConfig } from "./config.ts";
import { checked, inspectOwned, labels, mount, PRODUCT, PRODUCT_LABEL, resourceName, restrictions } from "./docker.ts";
import type { DockerRunner } from "./docker.ts";
import { InstallerError } from "./release.ts";
import type { ModernRelease } from "./release.ts";

const ROLE_LABEL = "io.gridlens.role", VERSION_LABEL = "io.gridlens.version";
type Metadata = Record<string, unknown>;
type Image = { Id: string; Config: { Labels: Record<string, string>; Env?: string[]; Entrypoint?: string[] | null } };
export interface VpnWebEndpoint { origin: string; port: number; imageId: string }
const object = (value: unknown): Metadata => value && typeof value === "object" && !Array.isArray(value) ? value as Metadata : {};
const empty = (value: unknown): boolean => value === undefined || value === null || Array.isArray(value) && value.length === 0;
const equal = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
function fail(message: string): never { throw new InstallerError(message); }

function configuration(config: InstallationConfig): void {
  validateInstallation(config);
  if (config.phase !== "ready" || config.pendingPort !== undefined) fail("Finish the saved HTTPS installation recovery before adding browser access.");
  if (config.bindAddress.startsWith("127.") || config.bindAddress === "::1") fail("Browser access requires this PC's assigned private LAN or VPN address.");
}
function image(runner: DockerRunner, id: unknown, version: unknown): Image {
  if (typeof id !== "string" || !/^sha256:[a-f0-9]{64}$/.test(id) || typeof version !== "string"
    || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(version)) fail("The browser gateway image identity is invalid.");
  let values: unknown;
  try { values = JSON.parse(checked(runner, ["image", "inspect", id])); }
  catch (error) { if (error instanceof InstallerError) throw error; fail("The browser gateway image metadata is invalid."); }
  if (!Array.isArray(values) || values.length !== 1) fail("The browser gateway image metadata is invalid.");
  const value = values[0] as Image;
  if (value?.Id !== id || value.Config?.Labels?.[PRODUCT_LABEL] !== PRODUCT || value.Config.Labels[VERSION_LABEL] !== version
    || value.Config.Env !== undefined && (!Array.isArray(value.Config.Env) || value.Config.Env.some(entry => typeof entry !== "string")))
    fail("The browser gateway image does not match its verified identity and version.");
  return value;
}
function dependencies(runner: DockerRunner, config: InstallationConfig): string {
  const { instance } = config, networkName = resourceName(instance, "network"), socketName = resourceName(instance, "read-ipc");
  const network = inspectOwned(runner, "network", networkName, instance);
  if (!network || typeof network.Id !== "string" || !network.Id || network.Driver !== "bridge") fail("The owned GridLens bridge network is unavailable.");
  if (!inspectOwned(runner, "volume", socketName, instance)) fail("The owned GridLens read socket volume is unavailable.");
  const owner = inspectOwned(runner, "container", resourceName(instance, "owner"), instance);
  if (!owner || object(owner.State).Running !== true || owner.Image !== config.active.imageId
    || !equal(object(owner.Config).Cmd, ["node", "scripts/shared-owner.ts"])
    || object(owner.HostConfig).NetworkMode !== networkName
    || !Array.isArray(owner.Mounts) || !owner.Mounts.some(value => { const entry = object(value);
      return entry.Type === "volume" && entry.Name === socketName && entry.Destination === "/ipc" && entry.RW === true;
    })) fail("The saved collection owner must be running with its existing read socket before browser access is added.");
  return network.Id;
}
function environment(runtime: Image, origin: string): string[] {
  const overrides = new Map([["GRIDLENS_SOCKET", "/ipc/read.sock"], ["GRIDLENS_PUBLIC_ORIGIN", origin], ["GRIDLENS_TRANSPORT", "vpn-http"]]);
  return [...(runtime.Config.Env ?? []).filter(entry => !overrides.has(entry.split("=", 1)[0]!)),
    ...[...overrides].map(([name, value]) => `${name}=${value}`)].sort();
}
function endpoint(config: InstallationConfig, container: Metadata, runtime: Image): VpnWebEndpoint {
  const cfg = object(container.Config), host = object(container.HostConfig), containerLabels = object(cfg.Labels);
  if (container.Image !== runtime.Id || containerLabels[ROLE_LABEL] !== "vpn-web" || containerLabels[VERSION_LABEL] !== runtime.Config.Labels[VERSION_LABEL])
    fail("An existing browser gateway has a different image or role; it was left unchanged.");
  const bindings = object(host.PortBindings), published = bindings["8443/tcp"];
  if (Object.keys(bindings).length !== 1 || !Array.isArray(published) || published.length !== 1
    || object(published[0]).HostIp !== config.bindAddress || typeof object(published[0]).HostPort !== "string")
    fail("The saved browser gateway has changed its published address or ports; it was left unchanged.");
  const rawPort = object(published[0]).HostPort as string, port = Number(rawPort);
  if (String(port) !== rawPort || port === config.port) fail("The browser gateway port is invalid or conflicts with the HTTPS endpoint.");
  const origin = originFor(config.bindAddress, port).replace(/^https:/, "http:");
  const mounts = container.Mounts, security = host.SecurityOpt;
  if (cfg.User !== "1000:1000" || host.ReadonlyRootfs !== true || host.Privileged !== false
    || host.NetworkMode !== resourceName(config.instance, "network") || ![undefined, ""].includes(host.PidMode as undefined | string)
    || ![undefined, "", "private"].includes(host.IpcMode as undefined | string) || host.UTSMode === "host"
    || !empty(host.CapAdd) || !equal(host.CapDrop, ["ALL"]) || !empty(host.Binds) || !empty(host.VolumesFrom)
    || !empty(host.Devices) || !empty(host.DeviceRequests) || host.PublishAllPorts === true
    || !Array.isArray(security) || !security.some(value => value === "no-new-privileges" || value === "no-new-privileges:true")
    || object(host.RestartPolicy).Name !== "unless-stopped" || host.PidsLimit !== 128
    || !Array.isArray(mounts) || mounts.length !== 1 || object(mounts[0]).Type !== "volume"
    || object(mounts[0]).Name !== resourceName(config.instance, "read-ipc") || object(mounts[0]).Destination !== "/ipc" || object(mounts[0]).RW !== false
    || !equal(cfg.Cmd, ["node", "scripts/shared-gateway.ts"]) || !equal(cfg.Entrypoint ?? null, runtime.Config.Entrypoint ?? null)
    || !Array.isArray(cfg.Env) || cfg.Env.some(value => typeof value !== "string") || !equal([...cfg.Env].sort(), environment(runtime, origin)))
    fail("An existing browser gateway has changed isolation, mounts, command or origin; it was left unchanged.");
  return { origin, port, imageId: runtime.Id };
}
function effective(config: InstallationConfig, container: Metadata, networkId: string, saved: VpnWebEndpoint): void {
  const settings = object(container.NetworkSettings), networks = object(settings.Networks), network = object(networks[resourceName(config.instance, "network")]);
  const ports = object(settings.Ports), published = ports["8443/tcp"];
  if (object(container.State).Running !== true || Object.keys(networks).length !== 1 || network.NetworkID !== networkId
    || !network.EndpointID || !network.IPAddress && !network.GlobalIPv6Address
    || Object.keys(ports).length !== 1 || !Array.isArray(published) || published.length !== 1
    || object(published[0]).HostIp !== config.bindAddress || object(published[0]).HostPort !== String(saved.port))
    fail("The browser gateway is not reachable on its saved private endpoint. Rerun browser setup after checking its Docker port; the HTTPS installation was retained.");
}

/** Read only: the sibling's persisted Docker metadata owns its endpoint. */
export function readVpnWebEndpoint(runner: DockerRunner, config: InstallationConfig): VpnWebEndpoint | undefined {
  const existing = inspectOwned(runner, "container", resourceName(config.instance, "vpn-web"), config.instance);
  if (!existing) return undefined;
  configuration(config);
  const runtime = image(runner, existing.Image, object(object(existing.Config).Labels)[VERSION_LABEL]);
  const saved = endpoint(config, existing, runtime), networkId = dependencies(runner, config);
  effective(config, existing, networkId, saved); return saved;
}

/** The caller has already verified the signed release. Only this optional web
 * sibling may be created/started; HTTPS identity, owner and volumes are untouched. */
export function ensureVpnWeb(runner: DockerRunner, config: InstallationConfig, release: ModernRelease, port?: number): VpnWebEndpoint {
  configuration(config);
  const runtime = image(runner, release.imageId, release.version), networkId = dependencies(runner, config);
  const name = resourceName(config.instance, "vpn-web");
  let existing = inspectOwned(runner, "container", name, config.instance);
  if (existing) {
    if (existing.Image !== release.imageId) fail("The saved browser gateway uses a different release. It was preserved; browser-gateway upgrades require an explicit update.");
    const saved = endpoint(config, existing, runtime);
    if (port !== undefined && port !== saved.port) fail("The browser gateway keeps its saved port on rerun; the requested port change was not applied.");
    if (object(existing.State).Running !== true) checked(runner, ["start", name]);
  } else {
    const selectedPort = port ?? config.port + 1;
    const origin = originFor(config.bindAddress, selectedPort).replace(/^https:/, "http:");
    if (selectedPort === config.port) fail("Choose a browser port different from the existing HTTPS port.");
    const bind = config.bindAddress.includes(":") ? `[${config.bindAddress}]` : config.bindAddress;
    checked(runner, ["run", "--detach", "--name", name, "--restart", "unless-stopped", ...restrictions,
      "--user", "1000:1000", ...labels(config.instance), "--label", `${ROLE_LABEL}=vpn-web`,
      "--network", resourceName(config.instance, "network"), ...mount(resourceName(config.instance, "read-ipc"), "/ipc", true),
      "--publish", `${bind}:${selectedPort}:8443/tcp`, "--env", "GRIDLENS_SOCKET=/ipc/read.sock",
      "--env", `GRIDLENS_PUBLIC_ORIGIN=${origin}`, "--env", "GRIDLENS_TRANSPORT=vpn-http",
      runtime.Id, "node", "scripts/shared-gateway.ts"]);
  }
  existing = inspectOwned(runner, "container", name, config.instance);
  if (!existing) fail("The browser gateway was not created; the HTTPS installation was retained.");
  const saved = endpoint(config, existing, runtime); effective(config, existing, networkId, saved); return saved;
}
