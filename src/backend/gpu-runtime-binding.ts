import type { PcAssociation } from "../contracts/shared.ts";
import type { NodeBinding } from "../fleet/pc-observations.ts";
import { sameBinding } from "../fleet/pc-observations.ts";
import { cleanNodeRuntime, verifyNode } from "./pc-rewards.ts";
import { nodeRuntime } from "./ssh.ts";
import type { SshRun } from "./ssh.ts";

const inventoryFormat = "--no-trunc --format '{{.ID}}\t{{.Image}}'";
const official = (value: string, repository: "podman" | "nosana-node") =>
  new RegExp(`^(?:(?:docker\\.io|registry\\.hub\\.docker\\.com)/)?nosana/${repository}(?::[A-Za-z0-9_.-]+|@sha256:[a-f0-9]{64})?$`).test(value);
interface Container { id: string; image: string }
interface Candidate { binding: NodeBinding; soleNode: boolean }
function containers(output: string): Container[] {
  if (Buffer.byteLength(output) > 65_536) throw new Error("GPU runtime inventory exceeded its bound.");
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length > 512) throw new Error("GPU runtime inventory exceeded its bound.");
  const rows = lines.map(line => {
    const [id, image, extra] = line.split("\t");
    if (!id || !/^[a-f0-9]{64}$/.test(id) || !image || !/^[A-Za-z0-9][A-Za-z0-9./:@_-]{0,255}$/.test(image) || extra !== undefined)
      throw new Error("Invalid GPU runtime inventory.");
    return { id, image };
  });
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error("Duplicate GPU runtime identity.");
  return rows;
}

/** Read-only, per-PC runtime evidence. The supplied association remains the
 * approval anchor; a replacement runtime is returned only for GPU observation.
 * Nothing here writes associations, permissions, financial pins or containers. */
export function createGpuRuntimeBindingReader(run: SshRun, pcId: string) {
  if (!/^[a-f0-9]{64}$/.test(pcId)) throw new Error("Invalid approved GPU PC.");
  const inventories = new Map<string, Promise<Container[]>>();
  const identities = new Map<string, ReturnType<typeof verifyNode>>();
  let scan: Promise<Candidate[] | null> | undefined;
  const list = (runtime: string): Promise<Container[]> => {
    const existing = inventories.get(runtime); if (existing) return existing;
    const pending = (async () => {
      const result = await run(`${runtime} ps ${inventoryFormat}`, { maximum: 65_536 });
      if (result.code !== 0 || result.stderrPresent) throw new Error("GPU runtime inventory unavailable.");
      return containers(result.stdout);
    })();
    inventories.set(runtime, pending); return pending;
  };
  const verify = (association: PcAssociation) => {
    const key = `${JSON.stringify(association.binding)}:${association.address}`;
    const prior = identities.get(key); if (prior) return prior;
    const result = verifyNode(run, association); identities.set(key, result); return result;
  };
  const wrappedNodes = async (association: PcAssociation): Promise<Container[]> =>
    (await list(cleanNodeRuntime(association))).filter(row => official(row.image, "nosana-node"));
  const discover = (anchor: PcAssociation): Promise<Candidate[] | null> => {
    if (scan) return scan;
    scan = (async () => {
      try {
        const candidates: Candidate[] = [];
        const append = (binding: NodeBinding, soleNode: boolean) => {
          if (candidates.length >= 64) throw new Error("GPU runtime candidates exceeded their bound.");
          candidates.push({ binding, soleNode });
        };
        let wrapperCount = 0;
        for (const container of await list("/usr/bin/docker")) {
          if (official(container.image, "nosana-node")) append({ pcId, runtime: "docker", wrapperId: null, nodeContainerId: container.id }, true);
          else if (official(container.image, "podman")) {
            if (++wrapperCount > 64) return null;
            const binding: NodeBinding = { pcId, runtime: "podman", wrapperId: container.id, nodeContainerId: anchor.binding.nodeContainerId };
            const nodes = await wrappedNodes({ ...anchor, binding });
            for (const node of nodes) append({ ...binding, nodeContainerId: node.id }, nodes.length === 1);
          }
        }
        const native = await run("/usr/bin/test -x /usr/bin/podman", { maximum: 256 });
        if (native.code === 0 && !native.stderrPresent) for (const container of await list("/usr/bin/podman")) {
          if (official(container.image, "nosana-node")) append({ pcId, runtime: "podman", wrapperId: null, nodeContainerId: container.id }, true);
        }
        else if (native.code !== 1 || native.stderrPresent) return null;
        return candidates;
      } catch { return null; }
    })();
    return scan;
  };
  return {
    async resolve(association: PcAssociation): Promise<NodeBinding | null> {
      if (association.binding.pcId !== pcId) return null;
      // Validates IDs/runtime before they can appear in an SSH command.
      nodeRuntime(association.binding);
      try {
        const status = await verify(association);
        if (status === "ok") {
          if (!association.binding.wrapperId) return association.binding;
          const nodes = await wrappedNodes(association);
          return nodes.length === 1 && nodes[0]!.id === association.binding.nodeContainerId ? association.binding : null;
        }
        // An existing container reporting another public identity is contrary
        // evidence, not permission to search for a more convenient replacement.
        if (status === "identity-mismatch") return null;
        // Prove staleness from a complete running inventory. Permission failure,
        // a changed image, or an unreadable still-running node is not absence.
        if (association.binding.wrapperId) {
          const wrapper = (await list("/usr/bin/docker")).find(row => row.id === association.binding.wrapperId);
          if (wrapper && (!official(wrapper.image, "podman")
            || (await list(cleanNodeRuntime(association))).some(row => row.id === association.binding.nodeContainerId))) return null;
        } else if ((await list(nodeRuntime(association.binding))).some(row => row.id === association.binding.nodeContainerId)) return null;
        const candidates = await discover(association);
        if (!candidates || candidates.some(candidate => sameBinding(candidate.binding, association.binding))) return null;
        const matched: Candidate[] = [];
        for (const candidate of candidates) {
          const status = await verify({ ...association, binding: candidate.binding });
          // An unreadable official node could be another copy of this public
          // identity. A partial scan cannot establish unique rediscovery.
          if (status === "unavailable") return null;
          if (status === "ok") matched.push(candidate);
        }
        return matched.length === 1 && matched[0]!.soleNode ? matched[0]!.binding : null;
      } catch { return null; }
    },
  };
}

export function gpuAllocationCommand(binding: NodeBinding): string {
  nodeRuntime(binding);
  // Podman workloads use the outer Docker wrapper's GPU namespace. The inner
  // Nosana orchestrator need not contain nvidia-smi (confirmed deployed layout).
  const target = binding.wrapperId ? `/usr/bin/docker exec ${binding.wrapperId}`
    : `${nodeRuntime(binding)} exec ${binding.nodeContainerId}`;
  return `${target} /usr/bin/nvidia-smi --query-gpu=uuid --format=csv,noheader`;
}
