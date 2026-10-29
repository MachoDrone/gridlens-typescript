import type { PcAssociation } from "../contracts/shared.ts";
import type { SshRun } from "./ssh.ts";
import { cleanNodeRuntime, verifyNode } from "./pc-rewards.ts";
import { GPU_UUID } from "../fleet/pc-observations.ts";

/** Exact current node, GPU allocation and isolated Docker namespace. A PC IP,
 * container name, NVIDIA minor number or reported device index is insufficient. */
export async function verifyGpuBinding(run: SshRun, association: PcAssociation): Promise<string | null> {
  if (!association.gpuUuids.length || association.gpuUuids.some(uuid => !GPU_UUID.test(uuid)) || await verifyNode(run, association) !== "ok") return null;
  const b = association.binding, runtime = cleanNodeRuntime(association);
  const node = await run(`${runtime} inspect --format '{{.HostConfig.NetworkMode}}' ${b.nodeContainerId}`, { maximum: 256 });
  if (node.code !== 0) return null;
  const nodeMode = node.stdout.trim();
  const isolated = (value: string) => value !== "host" && value !== "none" && !value.startsWith("container:") && /^[A-Za-z0-9_.-]+$/.test(value);
  let networkId: string | null = null;
  if (b.runtime === "docker" && b.wrapperId === null && isolated(nodeMode)) networkId = b.nodeContainerId;
  if (b.wrapperId && nodeMode === "host") {
    const wrapper = await run(`/usr/bin/docker inspect --format '{{.HostConfig.NetworkMode}}' ${b.wrapperId}`, { maximum: 256 });
    if (wrapper.code === 0 && isolated(wrapper.stdout.trim())) networkId = b.wrapperId;
  }
  if (!networkId) return null;
  const visible = await run(`${runtime} exec ${b.nodeContainerId} /usr/bin/nvidia-smi --query-gpu=uuid --format=csv,noheader`, { maximum: 8192 });
  const uuids = visible.stdout.trim().split(/\r?\n/).map(value => value.trim().toLowerCase().replace(/^gpu-/, "GPU-")).sort();
  return visible.code === 0 && JSON.stringify(uuids) === JSON.stringify([...association.gpuUuids].sort()) ? networkId : null;
}
