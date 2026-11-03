import { createHash, randomBytes } from "node:crypto";
import { request } from "node:http";
import { checked } from "./docker.ts";
import type { DockerRunner } from "./docker.ts";
import { privateAddress } from "./config.ts";
import { requireReleaseImage } from "./image-identity.ts";
import type { ModernRelease } from "./release.ts";
import { parseViewerConfiguration } from "../backend/viewer-client.ts";
import type { ViewerClientConfiguration } from "../backend/viewer-client.ts";

export const VIEWER_PRODUCT = "viewer-gateway";
const PRODUCT = "io.gridlens.product", INSTANCE = "io.gridlens.viewer-instance", ROLE = "io.gridlens.role";
const CONFIG = "io.gridlens.viewer-config-sha256", ORIGIN = "io.gridlens.viewer-origin";
const command = ["scripts/shared-viewer.ts"], entrypoint = ["/usr/local/bin/node"];
const restricted = ["--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "128"];
type Metadata = Record<string, unknown>;
const object = (value: unknown): Metadata => value && typeof value === "object" && !Array.isArray(value) ? value as Metadata : {};
const empty = (value: unknown): boolean => value == null || Array.isArray(value) && value.length === 0;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
function names(instance: string) {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(instance)) throw new Error("Invalid viewer instance.");
  const prefix = `gridlens-viewer-${instance}`;
  return { containerName: `${prefix}-gateway`, volumeName: `${prefix}-config`, networkName: `${prefix}-network` };
}
function viewerOrigin(address: string, port: number): string {
  if (!privateAddress(address) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Choose an assigned private viewer address and unprivileged port.");
  return `http://${address.includes(":") ? `[${address}]` : address}:${port}`;
}
function labels(instance: string, role: string, origin: string, configurationHash: string): string[] {
  return ["--label", `${PRODUCT}=${VIEWER_PRODUCT}`, "--label", `${INSTANCE}=${instance}`, "--label", `${ROLE}=${role}`,
    "--label", `${ORIGIN}=${origin}`, "--label", `${CONFIG}=${configurationHash}`];
}
function inspect(runner: DockerRunner, kind: "container" | "volume" | "network", name: string, instance: string, role: string): Metadata | undefined {
  const result = runner.run([kind, "inspect", name]);
  if (result.status !== 0) { if (/\bNo such (?:container|volume|network|object)\b|\bnot found\b/i.test(result.stderr)) return undefined; throw new Error("Viewer resource inspection failed; no absence was assumed."); }
  let rows: unknown; try { rows = JSON.parse(result.stdout); } catch { throw new Error("Invalid viewer resource metadata."); }
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error("Invalid viewer resource metadata.");
  const item = object(rows[0]), own = object(kind === "container" ? object(item.Config).Labels : item.Labels);
  if (own[PRODUCT] !== VIEWER_PRODUCT || own[INSTANCE] !== instance || own[ROLE] !== role
    || item.Name !== (kind === "container" ? `/${name}` : name)) throw new Error("An unrelated resource occupies the viewer name; it was left unchanged.");
  return item;
}
function binding(item: Metadata, container = false) {
  const saved = object(container ? object(item.Config).Labels : item.Labels);
  if (typeof saved[ORIGIN] !== "string" || typeof saved[CONFIG] !== "string" || !/^[a-f0-9]{64}$/.test(saved[CONFIG] as string)) throw new Error("Invalid saved viewer identity.");
  const url = new URL(saved[ORIGIN] as string), address = url.hostname.replace(/^\[|\]$/g, ""), port = Number(url.port);
  const origin = viewerOrigin(address, port);
  if (url.origin !== origin || saved[ORIGIN] !== origin) throw new Error("Invalid saved viewer endpoint.");
  return { origin, address, port, configurationHash: saved[CONFIG] as string };
}
export interface ViewerInstallation { origin: string; containerName: string; volumeName: string; networkName: string; imageId: string; configurationHash: string; ready: boolean }
/** Read public owned-resource metadata only. Never extracts the viewer token. */
export function readViewerInstallation(runner: DockerRunner, instance: string): ViewerInstallation | undefined {
  const resource = names(instance), container = inspect(runner, "container", resource.containerName, instance, "viewer");
  if (!container) return undefined;
  const saved = binding(container, true), cfg = object(container.Config), host = object(container.HostConfig);
  if (typeof container.Image !== "string" || !/^sha256:[a-f0-9]{64}$/.test(container.Image)
    || typeof object(cfg.Labels)["io.gridlens.version"] !== "string") throw new Error("Saved viewer image identity is invalid.");
  const images: unknown = JSON.parse(checked(runner, ["image", "inspect", String(container.Image)]));
  if (!Array.isArray(images) || images.length !== 1) throw new Error("Saved viewer image is unavailable.");
  const image = object(images[0]), imageConfig = object(image.Config), imageLabels = object(imageConfig.Labels);
  if (image.Id !== container.Image || image.Os !== "linux" || !["amd64", "arm64"].includes(String(image.Architecture))
    || imageLabels[PRODUCT] !== "shared-backend" || imageLabels["io.gridlens.version"] !== object(cfg.Labels)["io.gridlens.version"]
    || imageConfig.Env !== undefined && (!Array.isArray(imageConfig.Env) || imageConfig.Env.some(value => typeof value !== "string"))) throw new Error("Saved viewer image identity changed.");
  const volume = inspect(runner, "volume", resource.volumeName, instance, "viewer-config"), network = inspect(runner, "network", resource.networkName, instance, "viewer-network");
  if (!volume || !network || network.Driver !== "bridge" || !same(binding(volume), saved) || !same(binding(network), saved)) throw new Error("Viewer endpoint or credential-volume identity changed.");
  const ports = object(host.PortBindings), published = ports["8080/tcp"], mounts = container.Mounts;
  if (typeof container.Image !== "string" || !/^sha256:[a-f0-9]{64}$/.test(container.Image) || cfg.User !== "1000:1000"
    || host.ReadonlyRootfs !== true || host.Privileged !== false || host.NetworkMode !== resource.networkName
    || !empty(host.CapAdd) || !same(host.CapDrop, ["ALL"]) || !empty(host.Binds) || !empty(host.VolumesFrom)
    || !empty(host.Devices) || !empty(host.DeviceRequests) || ![undefined, ""].includes(host.PidMode as string | undefined)
    || ![undefined, "", "private"].includes(host.IpcMode as string | undefined) || host.UTSMode === "host" || host.PublishAllPorts === true
    || !Array.isArray(host.SecurityOpt) || !host.SecurityOpt.some(value => value === "no-new-privileges" || value === "no-new-privileges:true")
    || host.PidsLimit !== 128 || object(host.RestartPolicy).Name !== "unless-stopped"
    || !same(cfg.Cmd, command) || !same(cfg.Entrypoint, entrypoint) || Object.keys(ports).length !== 1 || !Array.isArray(published) || published.length !== 1
    || object(published[0]).HostIp !== saved.address || object(published[0]).HostPort !== String(saved.port)
    || !Array.isArray(mounts) || mounts.length !== 1 || object(mounts[0]).Type !== "volume" || object(mounts[0]).Name !== resource.volumeName
    || object(mounts[0]).Destination !== "/viewer" || object(mounts[0]).RW !== false || !Array.isArray(cfg.Env)) throw new Error("Viewer isolation changed; existing resources were left untouched.");
  const overrides = ["GRIDLENS_VIEWER_CONFIG=/viewer/client.json", `GRIDLENS_PUBLIC_ORIGIN=${saved.origin}`, "GRIDLENS_HOST=0.0.0.0", "GRIDLENS_PORT=8080", "GRIDLENS_TREASURY_PROTOCOL=0", "NODE_OPTIONS="];
  for (const value of overrides)
    if (cfg.Env.filter(entry => typeof entry === "string" && entry.split("=", 1)[0] === value.split("=", 1)[0]).join("") !== value) throw new Error("Viewer startup configuration changed.");
  const overrideKeys = new Set(overrides.map(value => value.split("=", 1)[0]));
  const expectedEnvironment = [...((imageConfig.Env ?? []) as string[]).filter(value => !overrideKeys.has(value.split("=", 1)[0])), ...overrides].sort();
  if (!same([...cfg.Env].sort(), expectedEnvironment)) throw new Error("Viewer environment changed.");
  if (cfg.Env.some(entry => typeof entry !== "string" || entry !== "GRIDLENS_TREASURY_PROTOCOL=0"
    && /^(?:GRIDLENS_(?:SOCKET|TREASURY|OWNER|UPDATES|VPN_AUTH)|NODE_EXTRA_CA_CERTS)/.test(entry))) throw new Error("Viewer has unexpected authority configuration.");
  const ready = object(container.State).Running === true;
  if (ready) {
    const settings = object(container.NetworkSettings), attached = object(settings.Networks), actualPorts = object(settings.Ports), actual = actualPorts["8080/tcp"];
    if (Object.keys(attached).length !== 1 || object(attached[resource.networkName]).NetworkID !== network.Id
      || Object.keys(actualPorts).length !== 1 || !Array.isArray(actual) || actual.length !== 1
      || object(actual[0]).HostIp !== saved.address || object(actual[0]).HostPort !== String(saved.port)) throw new Error("Viewer effective network identity changed.");
  }
  return { ...resource, origin: saved.origin, imageId: container.Image, configurationHash: saved.configurationHash, ready };
}
const initialize = `
const fs=require('node:fs'),crypto=require('node:crypto');
try {
 const raw=fs.readFileSync(0);if(raw.length>32768)throw Error();const input=JSON.parse(raw);
 if(crypto.createHash('sha256').update(JSON.stringify(input.configuration)).digest('hex')!==input.configurationHash)throw Error();
 const path='/viewer/client.json',bytes=Buffer.from(JSON.stringify(input.configuration));
 if(fs.existsSync(path)){const stat=fs.lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32768||!fs.readFileSync(path).equals(bytes))throw Error();}
 else {const temporary='/viewer/.client-'+input.nonce;const fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,path);}
 fs.chmodSync(path,0o600);fs.chownSync(path,1000,1000);fs.chmodSync('/viewer',0o700);fs.chownSync('/viewer',1000,1000);
 const directory=fs.openSync('/viewer','r');fs.fsyncSync(directory);fs.closeSync(directory);process.stdout.write('configured');
}catch{process.stderr.write('Viewer configuration could not be committed.');process.exitCode=1;}
`;
const readSaved = `const fs=require('node:fs');try{const s=fs.lstatSync('/viewer/client.json');if(!s.isFile()||s.isSymbolicLink()||s.size>32768||(s.mode&0o077)!==0)throw Error();process.stdout.write(fs.readFileSync('/viewer/client.json','utf8'));}catch{process.stderr.write('Saved viewer configuration is unavailable.');process.exitCode=1;}`;
async function probe(origin: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const okay = await new Promise<boolean>(resolve => {
      const req = request(new URL("/health/ready", origin), { timeout: 1000 }, response => { let text = "";
        response.on("data", part => { text += part; if (text.length > 1024) response.destroy(new Error("Oversized viewer readiness response.")); });
        response.on("error", () => resolve(false)); response.on("end", () => { try { resolve(response.statusCode === 200 && JSON.parse(text).status === "ready"); } catch { resolve(false); } }); });
      req.on("error", () => resolve(false)); req.on("timeout", () => req.destroy()); req.end();
    });
    if (okay) return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("Viewer did not become ready. Its saved credential and endpoint were retained for rerun.");
}
export interface InstallViewerOptions { runner: DockerRunner; image: ModernRelease; config: ViewerClientConfiguration; instance: string; bindAddress: string; port: number; probe?: (origin: string) => Promise<void> }
export async function installViewer(options: InstallViewerOptions): Promise<ViewerInstallation> {
  const { runner, instance } = options, resource = names(instance), config = parseViewerConfiguration(options.config), imageId = requireReleaseImage(runner, options.image);
  const origin = viewerOrigin(options.bindAddress, options.port), configurationHash = hash(JSON.stringify(config));
  const existing = readViewerInstallation(runner, instance);
  if (existing) {
    if (existing.origin !== origin || existing.configurationHash !== configurationHash) throw new Error("Viewer reruns preserve the saved owner, credential and endpoint.");
    if (!existing.ready) checked(runner, ["start", resource.containerName]);
    await (options.probe ?? probe)(origin);
    return readViewerInstallation(runner, instance)!;
  }
  for (const [kind, name, role] of [["volume", resource.volumeName, "viewer-config"], ["network", resource.networkName, "viewer-network"]] as const) {
    let item = inspect(runner, kind, name, instance, role);
    if (!item) { checked(runner, [kind, "create", ...labels(instance, role, origin, configurationHash), ...(kind === "network" ? ["--driver", "bridge"] : []), name]); item = inspect(runner, kind, name, instance, role); }
    if (!item || binding(item).origin !== origin || binding(item).configurationHash !== configurationHash || kind === "network" && item.Driver !== "bridge") throw new Error("Saved viewer setup differs; no credential or endpoint was replaced.");
  }
  // Immutable volume labels journal endpoint + credential digest before the
  // exclusive atomic credential-file commit. Container creation follows both.
  checked(runner, ["run", "--rm", "--interactive", ...restricted, "--network", "none", "--user", "0:0", "--cap-add", "CHOWN", "--cap-add", "FOWNER", "--cap-add", "DAC_OVERRIDE",
    ...labels(instance, "viewer-configure", origin, configurationHash), "--mount", `type=volume,src=${resource.volumeName},dst=/viewer`, "--entrypoint", "/usr/local/bin/node", imageId, "-e", initialize],
  JSON.stringify({ configuration: config, configurationHash, nonce: randomBytes(12).toString("hex") }));
  checked(runner, ["run", "--detach", "--name", resource.containerName, ...labels(instance, "viewer", origin, configurationHash), ...restricted,
    "--label", `io.gridlens.version=${options.image.version}`,
    "--user", "1000:1000", "--network", resource.networkName, "--restart", "unless-stopped", "--mount", `type=volume,src=${resource.volumeName},dst=/viewer,readonly`,
    "--publish", `${options.bindAddress.includes(":") ? `[${options.bindAddress}]` : options.bindAddress}:${options.port}:8080`,
    "--env", "GRIDLENS_VIEWER_CONFIG=/viewer/client.json", "--env", `GRIDLENS_PUBLIC_ORIGIN=${origin}`, "--env", "GRIDLENS_HOST=0.0.0.0", "--env", "GRIDLENS_PORT=8080", "--env", "GRIDLENS_TREASURY_PROTOCOL=0", "--env", "NODE_OPTIONS=",
    "--entrypoint", "/usr/local/bin/node", imageId, ...command]);
  const installed = readViewerInstallation(runner, instance); if (!installed?.ready) throw new Error("Viewer gateway did not start; saved setup was retained.");
  await (options.probe ?? probe)(origin); return installed;
}
/** Existing committed credentials recover without redeeming another one-use invite. */
export async function resumeViewerInstallation(runner: DockerRunner, options: { image: ModernRelease; instance: string; probe?: (origin: string) => Promise<void> }): Promise<ViewerInstallation | undefined> {
  const resource = names(options.instance), existing = readViewerInstallation(runner, options.instance);
  if (existing?.ready) { await (options.probe ?? probe)(existing.origin); return existing; }
  const volume = inspect(runner, "volume", resource.volumeName, options.instance, "viewer-config");
  if (!volume) return undefined;
  const saved = binding(volume), imageId = requireReleaseImage(runner, options.image);
  const raw = checked(runner, ["run", "--rm", ...restricted, "--network", "none", "--user", "1000:1000",
    ...labels(options.instance, "viewer-read-config", saved.origin, saved.configurationHash), "--mount", `type=volume,src=${resource.volumeName},dst=/viewer,readonly`,
    "--entrypoint", "/usr/local/bin/node", imageId, "-e", readSaved]);
  let config: ViewerClientConfiguration; try { config = parseViewerConfiguration(JSON.parse(raw)); } catch { throw new Error("Saved viewer configuration is invalid; it was retained."); }
  if (hash(JSON.stringify(config)) !== saved.configurationHash) throw new Error("Saved viewer credential digest changed; it was retained.");
  return installViewer({ runner, image: options.image, config, instance: options.instance, bindAddress: saved.address, port: saved.port,
    ...(options.probe ? { probe: options.probe } : {}) });
}
