/** Only injected through stdin into a stopped, uniquely labeled fixture helper. */
export interface DockerFixtureInput { operation: "seed" | "advance" | "inspect"; instance: string }
export interface DockerFixtureEvidence {
  serverId: string; context: { scopeId: string; rosterRevision: string; addresses: string[] };
  initialObservedAtMs: number; advancedObservedAtMs: number | null; waitUntilMs: number;
  cache: { revision: number; observedAtMs: number | null; value: string | null }; schedule: Record<string, number>;
  jobReservations: number[]; rpcReservations: number[]; permissions: { pcId: string; paused: boolean; revokedAtMs: number | null }[];
}
async function fixtureHelper(input: DockerFixtureInput): Promise<DockerFixtureEvidence> {
  const root = "/app", { createHash } = await import("node:crypto");
  const { openSharedState } = await import(`${root}/src/backend/sqlite-state.ts`) as typeof import("../src/backend/sqlite-state.ts");
  const { createSharedService } = await import(`${root}/src/backend/service.ts`) as typeof import("../src/backend/service.ts");
  const { emptyFleetSnapshots } = await import(`${root}/src/server/snapshot-store.ts`) as typeof import("../src/server/snapshot-store.ts");
  const { FLEET_RESOURCES } = await import(`${root}/src/contracts/fleet.ts`) as typeof import("../src/contracts/fleet.ts");
  const { createProviderCheckpoint } = await import(`${root}/scripts/provider-checkpoint.ts`) as typeof import("./provider-checkpoint.ts");
  const { createJobProvider } = await import(`${root}/scripts/jobs.ts`) as typeof import("./jobs.ts");
  const { createSolanaRpc, SolanaRpcError } = await import(`${root}/scripts/solana-rpc.ts`) as typeof import("./solana-rpc.ts");
  if (!/^fixture-[a-f0-9]{12}$/.test(input.instance) || !["seed", "advance", "inspect"].includes(input.operation)) throw new Error("Invalid fixture operation.");
  const state = openSharedState("/state", { ledgerDirectory: "/ledger" });
  try {
    const service = createSharedService(state);
    type Marker = { version: 1; instance: string; context: DockerFixtureEvidence["context"]; initialObservedAtMs: number;
      advancedObservedAtMs: number | null; waitUntilMs: number; pcIds: string[] };
    let marker = state.get<Marker>("fixture/docker-acceptance");
    if (input.operation === "seed") {
      if (marker || service.access.contexts().length) throw new Error("Seeding requires a new empty fixture.");
      const context = service.access.setFleet("docker-fixture", ["2", "3", "4"].map(end => "1".repeat(31) + end));
      const now = Date.now(), observedAtMs = now - 60_000, waitUntilMs = now + 7 * 86_400_000;
      const hash = createHash("sha256").update(JSON.stringify(context)).digest("hex");
      state.set("collector/schedule", Object.fromEntries(FLEET_RESOURCES.map(resource => [`${hash}/${resource}`, waitUntilMs])));
      const snapshots = emptyFleetSnapshots(context.addresses);
      snapshots.metadata.hosts = context.addresses.map(address => ({ address, fetchedAtMs: observedAtMs, retained: false, error: null, marketError: null,
        values: { status: "PREMIUM", marketAddress: null, marketLabel: null, ram: null, disk: null, cpu: "Synthetic Docker cache epoch one",
          cuda: null, nvidia: null, currentNode: null, system: null, country: null } }));
      await state.snapshots.commit(context, snapshots, 0);
      const pcIds = ["a".repeat(64), "b".repeat(64)];
      const associations = context.addresses.map((address, index) => ({ address, binding: { pcId: pcIds[index < 2 ? 0 : 1]!, runtime: "docker" as const,
        wrapperId: null, nodeContainerId: (index + 100).toString(16).padStart(64, "0") }, name: `Synthetic PC ${index < 2 ? 1 : 2}`,
        sshFingerprint: "SHA256:" + "A".repeat(43), verifiedAtMs: observedAtMs, privateIp: null, gpuUuids: [] }));
      service.observations.associate(context, associations);
      for (const [index, pcId] of pcIds.entries()) state.set(`permission:${context.scopeId}:${pcId}`, { version: 1,
        computer: { id: pcId, host: "192.0.2.10", port: 22, name: `Synthetic PC ${index + 1}`, fingerprint: "SHA256:" + "A".repeat(43), hostKey: "Z2VuZXJhdGVkLWZpeHR1cmU=" },
        associations: associations.filter(row => row.binding.pcId === pcId), rosterRevision: context.rosterRevision,
        automaticIp: true, rewards: true, gpu: true, approvedAtMs: observedAtMs, paused: true, revokedAtMs: index ? observedAtMs : null });
      const jobs = createProviderCheckpoint(state, "jobs"); createJobProvider({ checkpoint: jobs }).observeStates?.({ hosts: [] });
      jobs.write({ ...jobs.read<Record<string, unknown>>()!, pauseUntil: waitUntilMs, dispatches: [now - 2000], discoveryDispatches: [now - 2000] });
      const rpcState = createProviderCheckpoint(state, "rpc"), rpc = createSolanaRpc({ checkpoint: rpcState }), session = rpc.createSession("sol");
      session.failure(session.eligible()!, new SolanaRpcError("Synthetic fixture provider wait", "provider", waitUntilMs, "transport"));
      rpcState.write({ ...rpcState.read<Record<string, unknown>>()!, dispatches: [now - 1000] });
      state.set("monitor/provider-waits", { ip: waitUntilMs, rewards: waitUntilMs });
      marker = { version: 1, instance: input.instance, context: { ...context, addresses: [...context.addresses] }, initialObservedAtMs: observedAtMs,
        advancedObservedAtMs: null, waitUntilMs, pcIds }; state.set("fixture/docker-acceptance", marker);
    }
    if (!marker || marker.version !== 1 || marker.instance !== input.instance) throw new Error("Fixture ownership marker missing or different.");
    const context = service.access.fleet(marker.context.scopeId);
    if (JSON.stringify(context) !== JSON.stringify(marker.context)) throw new Error("Fixture roster changed.");
    if (input.operation === "advance") {
      const stored = await state.snapshots.read(context), metadata = structuredClone(stored.snapshots.metadata), now = Date.now();
      for (const row of metadata.hosts) { row.fetchedAtMs = now; if (row.values) row.values.cpu = "Synthetic Docker cache epoch two"; }
      await state.snapshots.commit(context, { metadata }, stored.revision);
      marker.advancedObservedAtMs = now; marker.waitUntilMs += 3_600_000;
      for (const name of ["jobs", "rpc"]) {
        const checkpoint = createProviderCheckpoint(state, name), saved = checkpoint.read<Record<string, unknown>>()!, dispatches = [...saved.dispatches as number[], now];
        if (name === "jobs") checkpoint.write({ ...saved, dispatches, discoveryDispatches: [...saved.discoveryDispatches as number[], now], pauseUntil: marker.waitUntilMs });
        else { const providers = saved.providers as { retryAtMs: number }[]; providers[0]!.retryAtMs = marker.waitUntilMs; checkpoint.write({ ...saved, dispatches, providers }); }
      }
      state.set("monitor/provider-waits", { ip: marker.waitUntilMs, rewards: marker.waitUntilMs }); state.set("fixture/docker-acceptance", marker);
    }
    const schedule = state.get<Record<string, number>>("collector/schedule") ?? {}, hash = createHash("sha256").update(JSON.stringify(context)).digest("hex");
    for (const resource of FLEET_RESOURCES) if ((schedule[`${hash}/${resource}`] ?? 0) <= Date.now()) throw new Error("A fixture provider deadline is missing or expired.");
    const snapshot = await state.snapshots.read(context), job = createProviderCheckpoint(state, "jobs").read<{ dispatches: number[] }>()!, rpc = createProviderCheckpoint(state, "rpc").read<{ dispatches: number[] }>()!;
    return { serverId: service.access.serverId, context: marker.context, initialObservedAtMs: marker.initialObservedAtMs,
      advancedObservedAtMs: marker.advancedObservedAtMs, waitUntilMs: marker.waitUntilMs,
      cache: { revision: snapshot.revision, observedAtMs: snapshot.snapshots.metadata.hosts[0]?.fetchedAtMs ?? null, value: snapshot.snapshots.metadata.hosts[0]?.values?.cpu ?? null },
      schedule, jobReservations: job.dispatches, rpcReservations: rpc.dispatches, permissions: marker.pcIds.map(pcId => {
        const permission = state.get<{ paused: boolean; revokedAtMs: number | null }>(`permission:${context.scopeId}:${pcId}`)!;
        if (!permission.paused && permission.revokedAtMs === null) throw new Error("Fixture PC collection must stay disabled.");
        return { pcId, paused: permission.paused, revokedAtMs: permission.revokedAtMs };
      }) };
  } finally { await state.close(); }
}
export function dockerFixtureProgram(input: DockerFixtureInput): string {
  if (!/^fixture-[a-f0-9]{12}$/.test(input.instance) || !["seed", "advance", "inspect"].includes(input.operation)) throw new Error("Invalid fixture operation.");
  return `(${fixtureHelper.toString()})(${JSON.stringify(input)}).then(value=>process.stdout.write(JSON.stringify(value))).catch(()=>{process.stderr.write("Isolated fixture state operation failed.\\n");process.exitCode=1;});`;
}
