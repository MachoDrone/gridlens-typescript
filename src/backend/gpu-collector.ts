import { createHash } from "node:crypto";
import type { PcAssociation } from "../contracts/shared.ts";
import { parseNodeGpu } from "../fleet/pc-observations.ts";
import type { NodeGpuObservation } from "../fleet/pc-observations.ts";
import type { PrivateState } from "./access.ts";
import type { SshRun } from "./ssh.ts";
import { shellQuote } from "./ssh.ts";
import { androidRecorderName, readAndroidRecorder, ANDROID_RECORDER_SOURCE_SHA256 } from "./android-recorder.ts";
import { gpuRecorderSource } from "./gpu-recorder-runtime.ts";
import { verifyGpuBinding } from "./gpu-binding.ts";

// Docker Official Image index verified against registry-1.docker.io response bytes
// and Docker-Content-Digest; linux amd64/arm64 variants, 2026-10-28.
export const TS_GPU_IMAGE = "node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c";
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
export const tsRecorderName = (association: PcAssociation): string => `gridlens-ts-node-gpu-${hash(`${association.binding.runtime}:${association.binding.wrapperId ?? ""}:${association.binding.nodeContainerId}:${association.address}`).slice(0, 24)}`;
/** Parse only a complete recognized immutable recorder source. Unknown versions
 * remain conflicts; a label or claimed address alone does not prove its binding. */
export function existingRecorderBinding(source: string): { address: string; nodeContainerId: string; gpuUuids: string[] } {
  const android = /^BOUND_ADDRESS = '([1-9A-HJ-NP-Za-km-z]{32,44})'\nBOUND_NODE_ID = '([a-f0-9]{64})'\nBOUND_UUIDS = \[('[A-Za-z0-9,-]+'(?:,'[A-Za-z0-9,-]+')*)\]\n/.exec(source);
  if (android) {
    if (hash(source.slice(android[0].length)) !== ANDROID_RECORDER_SOURCE_SHA256) throw new Error("Unrecognized Android recorder source.");
    const gpuUuids = android[3]!.split(",").map(value => value.slice(1, -1));
    if (!gpuUuids.length || gpuUuids.length > 64 || new Set(gpuUuids).size !== gpuUuids.length
      || gpuUuids.some(value => !/^GPU-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value))) throw new Error("Invalid recorder GPUs.");
    return { address: android[1]!, nodeContainerId: android[2]!, gpuUuids };
  }
  const match = /^'use strict';\nconst GRIDLENS_GPU_BINDING=(\{[^\n]{1,8192}\});\n/.exec(source);
  if (!match) throw new Error("Unrecognized recorder source.");
  const binding = JSON.parse(match[1]!) as { address: string; nodeContainerId: string; gpuUuids: string[] };
  if (Object.keys(binding).sort().join(",") !== "address,gpuUuids,nodeContainerId" || gpuRecorderSource(binding) !== source) throw new Error("Unrecognized TypeScript recorder source.");
  return binding;
}
function blank(association: PcAssociation, status: string, now: number): NodeGpuObservation {
  return { schema: 2, address: association.address, observedAtMs: null, status, gpuUuids: [], intervalSeconds: 15,
    fromAtMs: Math.max(0, now - 86_400_000), toAtMs: now, truncated: false, clockTrusted: false, samples: [] };
}
const volumeFormat = '{{index .Labels "io.gridlens.owner"}}\t{{index .Labels "io.gridlens.component"}}\t{{index .Labels "io.gridlens.collector-version"}}\t{{index .Labels "io.gridlens.binding"}}\t{{.Driver}}\t{{.Scope}}\t{{json .Options}}';
const inspectFormat = ["{{.Id}}", '{{index .Config.Labels "io.gridlens.owner"}}', '{{index .Config.Labels "io.gridlens.component"}}',
  '{{index .Config.Labels "io.gridlens.collector-version"}}', '{{index .Config.Labels "io.gridlens.collector-sha256"}}', '{{index .Config.Labels "io.gridlens.binding"}}',
  "{{.Config.Image}}", "{{.HostConfig.NetworkMode}}", "{{.HostConfig.ReadonlyRootfs}}", "{{.HostConfig.Privileged}}", "{{.State.Running}}",
  "{{range .Mounts}}{{.Type}}:{{.Name}}:{{.Destination}}:{{.RW}};{{end}}", "{{.HostConfig.PidMode}}", "{{.HostConfig.IpcMode}}", "{{.HostConfig.UTSMode}}",
  "{{json .HostConfig.CapAdd}}", "{{json .HostConfig.CapDrop}}", "{{json .HostConfig.SecurityOpt}}", "{{json .HostConfig.Binds}}", "{{json .HostConfig.PortBindings}}",
  "{{json .HostConfig.Devices}}", "{{json .HostConfig.DeviceCgroupRules}}", "{{json .HostConfig.DeviceRequests}}", "{{json .Config.Entrypoint}}", "{{json .Config.Cmd}}",
  "{{.HostConfig.Memory}}", "{{.HostConfig.NanoCpus}}", "{{.HostConfig.PidsLimit}}", "{{.HostConfig.RestartPolicy.Name}}",
  '{{range .Config.Env}}{{if and (ge (len .) 27) (eq (slice . 0 27) "NVIDIA_DRIVER_CAPABILITIES=")}}{{.}};{{end}}{{end}}'].join("\t");
const nil = (value: string): boolean => value === "null" || value === "[]";
export function validateTsRecorder(parts: string[], association: PcAssociation, networkId: string, source: string): { id: string; running: boolean } {
  const name = tsRecorderName(association), bindingHash = hash(JSON.stringify({ ...association.binding, address: association.address, gpuUuids: [...association.gpuUuids].sort() }));
  if (parts.length !== 30 || !/^[a-f0-9]{64}$/.test(parts[0]!) || parts[1] !== "typescript" || parts[2] !== "node-gpu-recorder" || parts[3] !== "1"
    || parts[4] !== hash(source) || parts[5] !== bindingHash || parts[6] !== TS_GPU_IMAGE || parts[7] !== `container:${networkId}` || parts[8] !== "true"
    || parts[9] !== "false" || !["true", "false"].includes(parts[10]!) || parts[11] !== `volume:${name}-data:/data:true;`
    || parts[12] !== "" || parts[13] !== "private" || parts[14] !== "" || !nil(parts[15]!) || parts[16] !== '["ALL"]'
    || !['["no-new-privileges"]', '["no-new-privileges:true"]'].includes(parts[17]!) || !nil(parts[18]!) || !["null", "{}"].includes(parts[19]!)
    || !nil(parts[20]!) || !nil(parts[21]!) || parts[23] !== '["/usr/local/bin/node"]' || JSON.stringify(JSON.parse(parts[24]!)) !== JSON.stringify(["-e", source, "--", "run"])
    || parts[25] !== "134217728" || parts[26] !== "250000000" || parts[27] !== "32" || parts[28] !== "unless-stopped"
    || parts[29] !== "NVIDIA_DRIVER_CAPABILITIES=utility;") throw new Error("GPU recorder configuration changed.");
  const requests: unknown = JSON.parse(parts[22]!);
  if (!Array.isArray(requests) || requests.length !== 1) throw new Error("GPU device grant changed.");
  const request = requests[0] as { Count: number; Driver: string; DeviceIDs: unknown; Capabilities: unknown; Options: unknown };
  if (request.Count !== 0 || request.Driver !== "" || JSON.stringify(request.DeviceIDs) !== JSON.stringify([...association.gpuUuids].sort())
    || JSON.stringify(request.Capabilities) !== '[["gpu"]]' || !["null", "{}"].includes(JSON.stringify(request.Options))) throw new Error("GPU device grant changed.");
  return { id: parts[0]!, running: parts[10] === "true" };
}

/** Explicit full-monitoring approval supplies this runner. Existing Android
 * recorders retain their lifecycle owner; only absent resources can select TS. */
export function createGpuCollector({ state, now = Date.now }: { state: PrivateState; now?: () => number }) {
  return async (run: SshRun, association: PcAssociation): Promise<NodeGpuObservation> => {
    const missing = (status: string) => blank(association, status, now());
    const name = tsRecorderName(association), androidName = androidRecorderName(association), volume = `${name}-data`;
    const key = `gpu-lifecycle:${association.binding.pcId}:${association.address}`;
    try {
      // Canonical Android name is checked even when its ownership labels are wrong.
      const android = await run(`/usr/bin/docker container ls -a --no-trunc --filter ${shellQuote(`name=^/${androidName}$`)} --format '{{.ID}}'`, { maximum: 1024 });
      if (android.code !== 0) return missing("unavailable");
      if (android.stdout.trim()) return readAndroidRecorder(run, association, now);
      const legacy = await run("/usr/bin/docker container ls -a --no-trunc --filter 'name=^/gridlens-gpu-recorder$' --format '{{.ID}}'", { maximum: 1024 });
      if (legacy.code !== 0) return missing("unavailable");
      // The older PC-wide Android recorder has no exact node history binding.
      // Keep its lifecycle intact and require an explicit migration, never a
      // second background recorder silently querying the same GPUs.
      if (legacy.stdout.trim()) return missing("unsupported");
      // A prior binding on the same PC may have another name. Never create a
      // competing recorder for its public node, including stopped resources.
      const listed = await run("/usr/bin/docker container ls -a --no-trunc --filter label=io.gridlens.component=node-gpu-recorder --format '{{.ID}}\t{{.Names}}'", { maximum: 64 * 1024 });
      if (listed.code !== 0) return missing("unavailable");
      const lines = listed.stdout.trim() ? listed.stdout.trim().split(/\r?\n/) : [];
      if (lines.length > 512) return missing("unavailable");
      for (const line of lines) {
        const [id, candidate, extra] = line.split("\t");
        if (!id || !/^[a-f0-9]{64}$/.test(id) || !candidate || extra !== undefined) return missing("unavailable");
        if (candidate === name) continue;
        const command = await run(`/usr/bin/docker container inspect --format '{{json .Config.Cmd}}' ${id}`, { maximum: 128 * 1024 });
        if (command.code !== 0) return missing("unavailable");
        const argv: unknown = JSON.parse(command.stdout);
        if (!Array.isArray(argv) || argv.some(value => typeof value !== "string")) return missing("binding-mismatch");
        const source = argv.find(value => typeof value === "string" && (value.startsWith("BOUND_ADDRESS = ") || value.startsWith("'use strict';\nconst GRIDLENS_GPU_BINDING=")));
        if (typeof source !== "string") return missing("binding-mismatch");
        const existing = existingRecorderBinding(source);
        if (existing.address === association.address || existing.gpuUuids.some(uuid => association.gpuUuids.includes(uuid))) return missing("binding-mismatch");
        const grants = await run(`/usr/bin/docker container inspect --format '{{json .HostConfig.DeviceRequests}}' ${id}`, { maximum: 8192 });
        if (grants.code !== 0) return missing("binding-mismatch");
        const requests: unknown = JSON.parse(grants.stdout);
        if (!Array.isArray(requests) || requests.length !== 1) return missing("binding-mismatch");
        const request = requests[0] as { Count?: unknown; DeviceIDs?: unknown };
        if (request.Count !== 0 || !Array.isArray(request.DeviceIDs) || request.DeviceIDs.some(uuid => typeof uuid !== "string")
          || JSON.stringify([...request.DeviceIDs].sort()) !== JSON.stringify([...existing.gpuUuids].sort())) return missing("binding-mismatch");
      }
      const networkId = await verifyGpuBinding(run, association); if (!networkId) return missing("binding-mismatch");
      const binding = { address: association.address, nodeContainerId: association.binding.nodeContainerId, gpuUuids: [...association.gpuUuids].sort() };
      const source = gpuRecorderSource(binding), digest = hash(source);
      const bindingHash = hash(JSON.stringify({ ...association.binding, address: association.address, gpuUuids: binding.gpuUuids }));
      const labels = `--label io.gridlens.owner=typescript --label io.gridlens.component=node-gpu-recorder --label io.gridlens.collector-version=1 --label io.gridlens.binding=${bindingHash}`
        + ` --label io.gridlens.node-address=${association.address} --label io.gridlens.gpu-uuids=${binding.gpuUuids.join(",")}`;
      const listedOwn = await run(`/usr/bin/docker container ls -a --no-trunc --filter ${shellQuote(`name=^/${name}$`)} --format '{{.ID}}'`, { maximum: 1024 });
      if (listedOwn.code !== 0) return missing("unavailable");
      const volumeSafe = async (): Promise<boolean> => {
        const result = await run(`/usr/bin/docker volume inspect --format ${shellQuote(volumeFormat)} ${volume}`, { maximum: 1024 });
        return result.code === 0 && [`typescript\tnode-gpu-recorder\t1\t${bindingHash}\tlocal\tlocal\tnull`, `typescript\tnode-gpu-recorder\t1\t${bindingHash}\tlocal\tlocal\t{}`].includes(result.stdout.trim());
      };
      if (!listedOwn.stdout.trim()) {
        const volumes = await run(`/usr/bin/docker volume ls --filter ${shellQuote(`name=^${volume}$`)} --format '{{.Name}}'`, { maximum: 1024 });
        if (volumes.code !== 0 || volumes.stdout.trim() && volumes.stdout.trim() !== volume) return missing("setup-failed");
        state.set(key, { version: 1, phase: "creating", bindingHash, digest, startedAtMs: now() });
        if (!volumes.stdout.trim()) {
          const created = await run(`/usr/bin/docker volume create ${labels} ${volume}`, { maximum: 1024 });
          if (created.code !== 0 || created.stdout.trim() !== volume) return missing("setup-failed");
        }
        if (!await volumeSafe()) return missing("binding-mismatch");
        const pulled = await run(`/usr/bin/docker pull ${TS_GPU_IMAGE}`, { maximum: 64 * 1024, timeoutMs: 150_000 });
        if (pulled.code !== 0) return missing("setup-failed");
        if (await verifyGpuBinding(run, association) !== networkId) return missing("binding-mismatch");
        const created = await run(`/usr/bin/docker run --detach --name ${name} ${labels} --label io.gridlens.collector-sha256=${digest}`
          + ` --network container:${networkId} --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 32 --memory 128m --cpus 0.25`
          + ` --restart unless-stopped --gpus ${shellQuote(`"device=${binding.gpuUuids.join(",")}"`)} --env NVIDIA_DRIVER_CAPABILITIES=utility`
          + ` --mount type=volume,source=${volume},target=/data --entrypoint /usr/local/bin/node ${TS_GPU_IMAGE} -e ${shellQuote(source)} -- run`, { maximum: 1024, timeoutMs: 15000 });
        if (created.code !== 0) return missing("setup-failed");
      }
      const inspected = await run(`/usr/bin/docker container inspect --format ${shellQuote(inspectFormat)} ${name}`, { maximum: 128 * 1024 });
      if (inspected.code !== 0 || !await volumeSafe()) return missing("unavailable");
      const owned = validateTsRecorder(inspected.stdout.replace(/\r?\n$/, "").split("\t"), association, networkId, source);
      if (!owned.running) {
        const prior = state.get<{ phase: string; bindingHash: string; digest: string }>(key);
        if (prior?.phase !== "creating" || prior.bindingHash !== bindingHash || prior.digest !== digest) return missing("not-enabled");
        const started = await run(`/usr/bin/docker container start ${owned.id}`, { maximum: 1024, timeoutMs: 15000 });
        if (started.code !== 0 || started.stdout.trim() !== owned.id) return missing("setup-failed");
      }
      // A runtime namespace mismatch is reported, never repaired by restarting a
      // workload or an Android-owned recorder.
      const target = await run(`/usr/bin/docker exec ${networkId} /usr/bin/readlink /proc/self/ns/net`, { maximum: 128 });
      const recorder = await run(`/usr/bin/docker exec ${owned.id} /usr/bin/readlink /proc/self/ns/net`, { maximum: 128 });
      if (target.code !== 0 || recorder.code !== 0 || !/^net:\[[0-9]{1,20}\]$/.test(target.stdout.trim()) || target.stdout.trim() !== recorder.stdout.trim()) return missing("binding-mismatch");
      state.set(key, { version: 1, phase: "active", bindingHash, digest, startedAtMs: now() });
      const response = await run(`/usr/bin/docker exec ${owned.id} /usr/local/bin/node -e ${shellQuote(source)} -- read`, { maximum: 1024 * 1024 });
      if (response.code !== 0) return missing("starting");
      const result = parseNodeGpu(JSON.parse(response.stdout), association.address);
      return result.toAtMs <= now() + 5000 && (result.observedAtMs === null || result.observedAtMs <= now() + 5000) ? result : missing("clock-untrusted");
    } catch { return missing("unavailable"); }
  };
}
