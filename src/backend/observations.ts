import type { FleetContext } from "../contracts/fleet.ts";
import { parseSharedObservations } from "../contracts/shared.ts";
import type { PcAssociation, SharedObservations } from "../contracts/shared.ts";
import { parsePcUpdate, parsePcNetworkUpdate, sameBinding, MAX_GPU_SAMPLES, parseNodeGpu } from "../fleet/pc-observations.ts";
import type { PcNetworkObservation, NodeGpuObservation } from "../fleet/pc-observations.ts";
import type { PrivateState } from "./access.ts";

/** Public normalized observations. Authorization remains in the private owner ledger. */
export function createObservationStore(state: PrivateState, serverId: string, now = Date.now) {
  function retainNetwork(prior: PcNetworkObservation | undefined, next: PcNetworkObservation): PcNetworkObservation | undefined {
    const newPublic = next.publicIp !== null && (next.publicObservedAtMs ?? 0) >= (prior?.publicObservedAtMs ?? 0);
    const newPrivate = next.privateIp !== null && (next.privateObservedAtMs ?? 0) >= (prior?.privateObservedAtMs ?? 0);
    const publicIp = newPublic ? next.publicIp : prior?.publicIp ?? null, privateIp = newPrivate ? next.privateIp : prior?.privateIp ?? null;
    const publicObservedAtMs = newPublic ? next.publicObservedAtMs : prior?.publicObservedAtMs ?? null;
    const privateObservedAtMs = newPrivate ? next.privateObservedAtMs : prior?.privateObservedAtMs ?? null;
    return publicIp || privateIp ? { schema: 1, source: newPublic || !prior ? next.source : prior.source, status: publicIp ? "ok" : "unavailable",
      observedAtMs: Math.max(publicObservedAtMs ?? 0, privateObservedAtMs ?? 0), publicIp, privateIp, publicObservedAtMs, privateObservedAtMs } : undefined;
  }
  const key = (context: FleetContext): string => `observations:${context.scopeId}:${context.rosterRevision}`;
  const gpuKey = (context: Pick<FleetContext, "scopeId" | "rosterRevision">, address: string): string => `gpu-history:${context.scopeId}:${context.rosterRevision}:${address}`;
  function loadGpu(context: Pick<FleetContext, "scopeId" | "rosterRevision">, address: string, summary: NodeGpuObservation | undefined,
    expected?: NonNullable<SharedObservations["gpuSummaries"]>[number]): NodeGpuObservation | undefined {
    if (!summary) return undefined;
    const stored = state.get<unknown>(gpuKey(context, address));
    // Original candidate stores had inline history. Retain it without renewing dates.
    // An empty sharded summary cannot stand in for a missing declared history.
    if (stored === undefined && expected && expected.sampleCount > summary.samples.length) throw new Error("Declared GPU history is missing.");
    const gpu = stored === undefined ? summary : parseNodeGpu(stored, address);
    const fields = ["schema", "address", "observedAtMs", "status", "gpuUuids", "intervalSeconds", "fromAtMs", "toAtMs", "truncated", "clockTrusted"] as const;
    if (fields.some(field => JSON.stringify(gpu[field]) !== JSON.stringify(summary[field])) || expected &&
      (expected.address !== address || expected.sampleCount !== gpu.samples.length || expected.fromAtMs !== gpu.fromAtMs
        || expected.toAtMs !== gpu.toAtMs || expected.truncated !== gpu.truncated)) throw new Error("GPU history and summary do not match.");
    return gpu;
  }
  function read(context: FleetContext, includeHistory = false): SharedObservations {
    const saved = state.get<SharedObservations>(key(context));
    const data = parseSharedObservations(saved ?? { version: 1, serverId, scopeId: context.scopeId, rosterRevision: context.rosterRevision,
      associations: [], observations: [], networks: [] }, serverId, context);
    if (includeHistory) data.observations = data.observations.map(row => row.gpu ? { ...row,
      gpu: loadGpu(context, row.address, row.gpu, data.gpuSummaries?.find(summary => summary.address === row.address))! } : row);
    return data;
  }
  function save(context: FleetContext, data: SharedObservations, histories = new Map<string, NodeGpuObservation>()): void {
    if (!state.batch) throw new Error("PC observations require atomic shared storage.");
    const summaries = new Map((data.gpuSummaries ?? []).map(row => [row.address, row]));
    const present = new Set(data.observations.filter(row => row.gpu).map(row => row.address));
    for (const address of summaries.keys()) if (!present.has(address)) summaries.delete(address);
    // Migrate any original inline history atomically on its next ordinary write.
    for (const row of data.observations) if (row.gpu && row.gpu.samples.length && !histories.has(row.address)) histories.set(row.address, row.gpu);
    for (const [address, gpu] of histories) summaries.set(address, { address, sampleCount: gpu.samples.length, fromAtMs: gpu.fromAtMs, toAtMs: gpu.toAtMs, truncated: gpu.truncated });
    const normalized = parseSharedObservations({ ...data, gpuSummaries: [...summaries.values()],
      observations: data.observations.map(row => row.gpu ? { ...row, gpu: { ...row.gpu, samples: [] } } : row) }, serverId, context);
    const entries: (readonly [string, unknown])[] = [...histories].map(([address, gpu]) => [gpuKey(context, address), parseNodeGpu(gpu, address)] as const);
    entries.push([key(context), normalized]); state.batch(entries);
  }
  return {
    read,
    readGpu(context: FleetContext, address: string): NodeGpuObservation | undefined {
      if (!context.addresses.includes(address)) throw new Error("GPU history is outside the fleet.");
      const data = read(context);
      return loadGpu(context, address, data.observations.find(row => row.address === address)?.gpu, data.gpuSummaries?.find(row => row.address === address));
    },
    carry(context: FleetContext, previous: SharedObservations): void {
      const data = read(context), bindings = new Map(data.associations.map(row => [row.address, row.binding]));
      save(context, { ...data,
        observations: previous.observations.filter(row => bindings.has(row.address) && sameBinding(row.binding, bindings.get(row.address)!)),
        networks: previous.networks.filter(row => data.associations.some(association => association.binding.pcId === row.pcId)),
        gpuSummaries: previous.gpuSummaries?.filter(row => bindings.has(row.address)) ?? [],
      }, new Map(previous.observations.filter(row => row.gpu && bindings.has(row.address) && sameBinding(row.binding, bindings.get(row.address)!))
        .map(row => [row.address, loadGpu(previous, row.address, row.gpu, previous.gpuSummaries?.find(summary => summary.address === row.address))!])));
    },
    associate(context: FleetContext, associations: PcAssociation[]): void {
      const previous = read(context), current = new Map(associations.map(row => [row.address, row.binding]));
      save(context, { ...previous, associations,
        observations: previous.observations.filter(row => current.has(row.address) && sameBinding(row.binding, current.get(row.address)!)),
        networks: previous.networks.filter(row => associations.some(association => association.binding.pcId === row.pcId)),
      });
    },
    ingest(context: FleetContext, value: unknown): void {
      const update = parsePcUpdate(value), data = read(context), binding = data.associations.find(row => row.address === update.address)?.binding;
      if (!binding || !sameBinding(binding, update.binding)) throw new Error("Unverified observation binding.");
      const prior = data.observations.find(row => row.address === update.address);
      if (update.gpu && prior?.gpu) prior.gpu = loadGpu(context, update.address, prior.gpu, data.gpuSummaries?.find(row => row.address === update.address))!;
      const next = { ...prior, ...update, receivedAtMs: now() };
      if (update.rewards) {
        if (update.rewards.observedAtMs > now() + 15_000 || update.rewards.observedAtMs < (prior?.rewards?.observedAtMs ?? 0)) throw new Error("Invalid rewards source time.");
        if (prior?.rewards?.observedAtMs === update.rewards.observedAtMs && prior.rewards.status === "ok" && update.rewards.status === "ok" && prior.rewards.amount !== update.rewards.amount)
          throw new Error("Changed rewards require a newer reading.");
        if (update.rewards.status === "ok") next.lastGoodRewards = update.rewards;
      }
      if (update.gpu && (update.gpu.toAtMs > now() + 5000 || update.gpu.toAtMs < (prior?.gpu?.toAtMs ?? 0))) throw new Error("Invalid GPU source time.");
      if (update.gpu?.observedAtMs !== undefined && update.gpu.observedAtMs !== null &&
        (update.gpu.observedAtMs > now() + 5000 || update.gpu.observedAtMs < (prior?.gpu?.observedAtMs ?? 0))) throw new Error("Invalid GPU observation time.");
      if (update.gpu && prior?.gpu) {
        if (update.gpu.status !== "ok" && !update.gpu.samples.length) next.gpu = { ...prior.gpu, status: update.gpu.status,
          clockTrusted: update.gpu.status.startsWith("clock-") ? false : prior.gpu.clockTrusted };
        else if (JSON.stringify(update.gpu.gpuUuids) === JSON.stringify(prior.gpu.gpuUuids)) {
          const samples = new Map(prior.gpu.samples.filter(sample => sample[0] >= update.gpu!.toAtMs - 7 * 86_400_000).map(sample => [`${sample[0]}:${sample[1]}`, sample]));
          for (const sample of update.gpu.samples) samples.set(`${sample[0]}:${sample[1]}`, sample);
          const combined = [...samples.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(-MAX_GPU_SAMPLES);
          next.gpu = { ...update.gpu, samples: combined, fromAtMs: Math.min(update.gpu.fromAtMs, combined[0]?.[0] ?? update.gpu.fromAtMs),
            truncated: update.gpu.truncated || prior.gpu.truncated || samples.size > MAX_GPU_SAMPLES };
        }
      }
      if (update.network) { const retained = retainNetwork(prior?.lastGoodNetwork, update.network); if (retained) next.lastGoodNetwork = retained; }
      data.observations = [...data.observations.filter(row => row.address !== update.address), next];
      save(context, data, new Map(update.gpu && next.gpu ? [[update.address, next.gpu]] : []));
    },
    network(context: FleetContext, value: unknown): void {
      const update = parsePcNetworkUpdate(value), data = read(context);
      if (!data.associations.some(row => row.binding.pcId === update.pcId)) throw new Error("Unverified PC network source.");
      const prior = data.networks.find(row => row.pcId === update.pcId);
      if (update.network.observedAtMs > now() + 5000 || update.network.observedAtMs < (prior?.network.observedAtMs ?? 0)) throw new Error("Invalid network source time.");
      const next = { ...prior, ...update, receivedAtMs: now(), ...(update.network.status === "ok" ? { lastGoodNetwork: update.network } : {}) };
      const retained = retainNetwork(prior?.lastGoodNetwork, update.network); if (retained) next.lastGoodNetwork = retained;
      if (prior?.network.retryAtMs !== undefined) next.network = { ...next.network, retryAtMs: Math.max(prior.network.retryAtMs, next.network.retryAtMs ?? 0) };
      data.networks = [...data.networks.filter(row => row.pcId !== update.pcId), next]; save(context, data);
    },
  };
}
