import { createHash } from "node:crypto";
import type { PcAssociation } from "../contracts/shared.ts";
import { parseNodeGpu, GPU_UUID } from "../fleet/pc-observations.ts";
import type { NodeGpuObservation } from "../fleet/pc-observations.ts";
import type { SshRun } from "./ssh.ts";
import { shellQuote } from "./ssh.ts";
import { cleanNodeRuntime, verifyNode } from "./pc-rewards.ts";

// Compatibility source from GridLens Android 0.2.15/versionCode18 node_gpu.py.
// The backend reuses that exact existing Python recorder; it never installs,
// starts, restarts, relabels or replaces an Android lifecycle-owned resource.
export const ANDROID_RECORDER_SOURCE_SHA256 = "b123a3abaa03d28bff6976a18d49877458bc3804c020c375aa074e397613476c";
export const ANDROID_RECORDER_IMAGE = "python:3.13.11-slim-bookworm@sha256:20080e807bfc404f8450b185cf0fc95d553462673598549613735f70a5b4d5d0";
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
export function androidRecorderName(association: PcAssociation): string {
  const b = association.binding;
  return `gridlens-node-gpu-${hash(`${b.runtime}:${b.wrapperId ?? ""}:${b.nodeContainerId}:${association.address}`).slice(0, 24)}`;
}
function unknown(association: PcAssociation, status: string, now: number): NodeGpuObservation {
  return { schema: 2, address: association.address, observedAtMs: null, status, gpuUuids: [], intervalSeconds: 15,
    fromAtMs: Math.max(0, now - 86_400_000), toAtMs: now, truncated: false, clockTrusted: false, samples: [] };
}
const nilArray = (text: string): boolean => text === "null" || text === "[]";
const label = (key: string): string => `{{index .Config.Labels ${JSON.stringify(key)}}}`;
const projection = [label("io.gridlens.owner"), label("io.gridlens.component"), label("io.gridlens.collector-version"), label("io.gridlens.collector-sha256"),
  "{{.Config.Image}}", "{{.HostConfig.NetworkMode}}", "{{.HostConfig.ReadonlyRootfs}}", "{{.HostConfig.Privileged}}",
  "{{range .Mounts}}{{.Type}}:{{.Name}}:{{.Destination}}:{{.RW}};{{end}}", "{{.State.Running}}", "{{.HostConfig.PidMode}}", "{{.HostConfig.IpcMode}}", "{{.HostConfig.UTSMode}}",
  "{{json .HostConfig.CapAdd}}", "{{json .HostConfig.CapDrop}}", "{{json .HostConfig.SecurityOpt}}", "{{json .HostConfig.Binds}}", "{{json .HostConfig.PortBindings}}",
  "{{json .HostConfig.Devices}}", "{{json .HostConfig.DeviceCgroupRules}}", "{{json .HostConfig.DeviceRequests}}", "{{json .Config.Entrypoint}}",
  "{{.HostConfig.Memory}}", "{{.HostConfig.NanoCpus}}", "{{.HostConfig.PidsLimit}}", "{{.HostConfig.RestartPolicy.Name}}",
  '{{range .Config.Env}}{{if and (ge (len .) 27) (eq (slice . 0 27) "NVIDIA_DRIVER_CAPABILITIES=")}}{{.}};{{end}}{{end}}', "{{.Id}}"].join("\t");

/** Validate safe configuration and exact source/bindings before executing the installed read operation. */
export function validateAndroidRecorder(parts: string[], command: unknown, association: PcAssociation, networkId: string,
  expectedBaseHash = ANDROID_RECORDER_SOURCE_SHA256): { id: string; source: string } {
  const name = androidRecorderName(association), volume = `${name}-data`, uuids = [...association.gpuUuids].sort();
  if (parts.length !== 28 || parts[0] !== "android" || parts[1] !== "node-gpu-recorder" || parts[2] !== "1"
    || parts[4] !== ANDROID_RECORDER_IMAGE || parts[5] !== `container:${networkId}` || parts[6] !== "true" || parts[7] !== "false"
    || parts[8] !== `volume:${volume}:/data:true;` || parts[9] !== "true" || parts[10] !== "" || parts[11] !== "private" || parts[12] !== ""
    || !nilArray(parts[13]!) || parts[14] !== '["ALL"]' || !['["no-new-privileges"]', '["no-new-privileges:true"]'].includes(parts[15]!)
    || !nilArray(parts[16]!) || !["null", "{}"].includes(parts[17]!) || !nilArray(parts[18]!) || !nilArray(parts[19]!) || !nilArray(parts[21]!)
    || parts[22] !== "134217728" || parts[23] !== "250000000" || parts[24] !== "32" || parts[25] !== "unless-stopped"
    || parts[26] !== "NVIDIA_DRIVER_CAPABILITIES=utility;" || !/^[a-f0-9]{64}$/.test(parts[27]!)) throw new Error("Android recorder ownership/configuration mismatch.");
  const devices: unknown = JSON.parse(parts[20]!);
  if (!Array.isArray(devices) || devices.length !== 1) throw new Error("Invalid recorder GPU access.");
  const device = devices[0] as { Count: number; Driver: string; DeviceIDs: unknown; Capabilities: unknown; Options: unknown };
  if (device.Count !== 0 || device.Driver !== "" || JSON.stringify(device.DeviceIDs) !== JSON.stringify(uuids)
    || JSON.stringify(device.Capabilities) !== '[["gpu"]]' || !["{}", "null"].includes(JSON.stringify(device.Options))) throw new Error("Recorder GPU binding changed.");
  if (!Array.isArray(command) || command.length !== 5 || command[0] !== "python" || command[1] !== "-B" || command[2] !== "-c"
    || command[4] !== "run" || typeof command[3] !== "string" || Buffer.byteLength(command[3]) > 64 * 1024) throw new Error("Unrecognized recorder command.");
  const source: string = command[3];
  const prefix = `BOUND_ADDRESS = '${association.address}'\nBOUND_NODE_ID = '${association.binding.nodeContainerId}'\nBOUND_UUIDS = ['${uuids.join("','")}']\n`;
  if (!source.startsWith(prefix) || hash(source) !== parts[3] || hash(source.slice(prefix.length)) !== expectedBaseHash) throw new Error("Recorder source/binding changed.");
  return { id: parts[27]!, source };
}

export async function readAndroidRecorder(run: SshRun, association: PcAssociation, now = Date.now, sinceAtMs?: number): Promise<NodeGpuObservation> {
  const missing = (status: string) => unknown(association, status, now());
  if (!association.gpuUuids.length || association.gpuUuids.some(uuid => !GPU_UUID.test(uuid))) return missing("unsupported");
  try {
    if (await verifyNode(run, association) !== "ok") return missing("binding-mismatch");
    const b = association.binding, runtime = cleanNodeRuntime(association);
    const nodeMode = (await run(`${runtime} inspect --format '{{.HostConfig.NetworkMode}}' ${b.nodeContainerId}`, { maximum: 256 })).stdout.trim();
    const isolated = (value: string) => value !== "host" && value !== "none" && !value.startsWith("container:") && /^[A-Za-z0-9_.-]+$/.test(value);
    let networkId: string | null = null;
    if (b.runtime === "docker" && b.wrapperId === null && isolated(nodeMode)) networkId = b.nodeContainerId;
    if (b.wrapperId && nodeMode === "host") {
      const wrapperMode = (await run(`/usr/bin/docker inspect --format '{{.HostConfig.NetworkMode}}' ${b.wrapperId}`, { maximum: 256 })).stdout.trim();
      if (isolated(wrapperMode)) networkId = b.wrapperId;
    }
    if (!networkId) return missing("unsupported");
    const visible = await run(`${runtime} exec ${b.nodeContainerId} /usr/bin/nvidia-smi --query-gpu=uuid --format=csv,noheader`, { maximum: 8192 });
    const uuids = visible.stdout.trim().split(/\r?\n/).map(value => value.trim().toLowerCase().replace(/^gpu-/, "GPU-")).sort();
    if (visible.code !== 0 || JSON.stringify(uuids) !== JSON.stringify([...association.gpuUuids].sort())) return missing("binding-mismatch");
    const name = androidRecorderName(association);
    const inspected = await run(`/usr/bin/docker container inspect --format ${shellQuote(projection)} ${name}`, { maximum: 8192 });
    if (inspected.code !== 0) return missing("not-enabled");
    const command = await run(`/usr/bin/docker container inspect --format '{{json .Config.Cmd}}' ${name}`, { maximum: 128 * 1024 });
    if (command.code !== 0) return missing("unavailable");
    const owned = validateAndroidRecorder(inspected.stdout.replace(/\r?\n$/, "").split("\t"), JSON.parse(command.stdout), association, networkId);
    const volume = await run(`/usr/bin/docker volume inspect --format '{{index .Labels "io.gridlens.owner"}}\t{{index .Labels "io.gridlens.component"}}\t{{index .Labels "io.gridlens.collector-version"}}\t{{.Driver}}\t{{.Scope}}\t{{json .Options}}' ${name}-data`, { maximum: 1024 });
    if (volume.code !== 0 || !["android\tnode-gpu-recorder\t1\tlocal\tlocal\tnull", "android\tnode-gpu-recorder\t1\tlocal\tlocal\t{}"].includes(volume.stdout.trim())) return missing("binding-mismatch");
    const targetNs = await run(`/usr/bin/docker exec ${networkId} /usr/bin/readlink /proc/self/ns/net`, { maximum: 128 });
    const recorderNs = await run(`/usr/bin/docker exec ${owned.id} /usr/bin/readlink /proc/self/ns/net`, { maximum: 128 });
    if (targetNs.code !== 0 || recorderNs.code !== 0 || !/^net:\[[0-9]{1,20}\]$/.test(targetNs.stdout.trim()) || targetNs.stdout.trim() !== recorderNs.stdout.trim()) return missing("binding-mismatch");
    const since = sinceAtMs === undefined ? "" : Number.isSafeInteger(sinceAtMs) && sinceAtMs >= 0 ? ` ${sinceAtMs}` : (() => { throw new Error("Invalid GPU history boundary."); })();
    const response = await run(`/usr/bin/docker exec ${owned.id} python -B -c ${shellQuote(owned.source)} read${since}`, { maximum: 1024 * 1024 });
    if (response.code !== 0) return missing("unavailable");
    const result = parseNodeGpu(JSON.parse(response.stdout), association.address);
    if (result.toAtMs > now() + 5000 || result.observedAtMs !== null && result.observedAtMs > now() + 5000) return missing("clock-untrusted");
    return result;
  } catch { return missing("unavailable"); }
}
