import type { FleetContext } from "../contracts/fleet.ts";
import type { PcAssociation } from "../contracts/shared.ts";
import type { PrivateState } from "./access.ts";
import type { createObservationStore } from "./observations.ts";
import type { CredentialVault } from "./credential-vault.ts";
import type { Computer, SshCredential, SshRun } from "./ssh.ts";
import { withSsh } from "./ssh.ts";
import { readPcNetwork } from "./pc-network.ts";
import { readRewards } from "./pc-rewards.ts";
import { createGpuCollector } from "./gpu-collector.ts";
import type { NodeGpuObservation, PcNetworkObservation, RewardObservation } from "../fleet/pc-observations.ts";
import { sameBinding } from "../fleet/pc-observations.ts";

export interface PcPermission {
  version: 1; computer: Computer; associations: PcAssociation[]; rosterRevision: string;
  automaticIp: boolean; rewards: boolean; gpu: boolean; approvedAtMs: number; revokedAtMs: number | null; paused: boolean;
}
interface Schedule { ipAt: number; nodeAt: number; rewardsAt: Record<string, number>; gpuAt: Record<string, number>; retryAt: number }
interface Target { context: FleetContext; permission: PcPermission; key: string; schedule: Schedule }
export interface PcMonitorOptions {
  state: PrivateState; vault: CredentialVault; observations: ReturnType<typeof createObservationStore>;
  contexts: () => readonly FleetContext[]; now?: () => number;
  connect?: typeof withSsh;
  networkReader?: (run: SshRun, host: string, now: () => number) => Promise<PcNetworkObservation>;
  rewardsReader?: (run: SshRun, association: PcAssociation, now: () => number) => Promise<RewardObservation>;
  gpuReader?: (run: SshRun, association: PcAssociation, now: () => number) => Promise<NodeGpuObservation>;
}

/** One independent IP slot and three node slots, oldest-due first. Reservations,
 * provider waits and authorization denials are durable before delivery or another
 * command. Explicit setup owns credentials; browsers only receive observations. */
export function createPcMonitor({ state, vault, observations, contexts, now = Date.now, connect = withSsh,
  networkReader = readPcNetwork, rewardsReader = readRewards, gpuReader }: PcMonitorOptions) {
  const collectGpu = gpuReader ?? createGpuCollector({ state, now });
  const active = new Map<string, Promise<void>>();
  let stopped = false, timer: ReturnType<typeof setInterval> | undefined;
  const waits = () => state.get<{ ip: number; rewards: number }>("monitor/provider-waits") ?? { ip: 0, rewards: 0 };
  const schedule = (key: string): Schedule => state.get<Schedule>(`monitor:${key}`) ?? { ipAt: 0, nodeAt: 0, rewardsAt: {}, gpuAt: {}, retryAt: 0 };
  const rewardDenied = (target: Target, association: PcAssociation): boolean => {
    const denial = state.get<{ approvedAtMs: number }>(`monitor:reward-denial:${target.key}:${association.address}`);
    return denial !== undefined && denial.approvedAtMs >= target.permission.approvedAtMs;
  };
  const permitted = (target: Target, kind: "ip" | "node"): PcPermission | null => {
    if (stopped) return null;
    const current = contexts().find(context => context.scopeId === target.context.scopeId && context.rosterRevision === target.context.rosterRevision);
    const permission = state.get<PcPermission>(`permission:${target.key}`);
    if (!current || !permission || permission.version !== 1 || permission.paused || permission.revokedAtMs !== null
      || permission.rosterRevision !== current.rosterRevision || permission.computer.id !== target.permission.computer.id
      || permission.computer.fingerprint !== target.permission.computer.fingerprint || permission.approvedAtMs !== target.permission.approvedAtMs
      || (kind === "ip" ? !permission.automaticIp : !permission.rewards && !permission.gpu)) return null;
    return permission;
  };
  const targets = (): Target[] => {
    const result: Target[] = [];
    for (const context of contexts()) {
      const data = observations.read(context);
      for (const pcId of new Set(data.associations.map(row => row.binding.pcId))) {
        const key = `${context.scopeId}:${pcId}`, permission = state.get<PcPermission>(`permission:${key}`);
        if (!permission) continue;
        const target = { context, permission, key, schedule: schedule(key) };
        if (permitted(target, "ip") || permitted(target, "node")) result.push(target);
      }
    }
    return result;
  };
  const saveSchedule = (target: Target, update: Partial<Schedule>) => state.set(`monitor:${target.key}`, { ...schedule(target.key), ...update });
  const suspend = (target: Target, kind: "credential-rejected" | "identity-changed", credential: SshCredential): void => {
    for (const item of targets()) {
      if (item.key !== target.key && (kind !== "credential-rejected" || JSON.stringify(vault.read(item.context.scopeId, item.permission.computer.id)) !== JSON.stringify(credential))) continue;
      const latest = state.get<PcPermission>(`permission:${item.key}`);
      if (latest) state.set(`permission:${item.key}`, { ...latest, paused: true });
    }
  };
  const collect = (target: Target, kind: "ip" | "node"): Promise<void> => {
    const key = `${kind}:${target.key}`;
    const existing = active.get(key); if (existing) return existing;
    // Reserve the appropriate lane before connecting. A crash cannot immediately
    // repeat expensive node reads or refill routine attempts.
    saveSchedule(target, kind === "ip" ? { ipAt: now() + 60_000 } : { nodeAt: now() + 30_000 });
    const task = (async () => {
      const credential = vault.read(target.context.scopeId, target.permission.computer.id);
      if (!credential) return;
      try {
        await connect(target.permission.computer, credential, async run => {
          const guarded: SshRun = (command, options) => {
            if (!permitted(target, kind)) return Promise.reject(new Error("Monitoring permission changed."));
            return run(command, options);
          };
          if (kind === "ip") {
            const network = await networkReader(guarded, target.permission.computer.host, now);
            const currentWait = waits();
            if (network.retryAtMs) state.set("monitor/provider-waits", { ...currentWait, ip: Math.max(currentWait.ip, network.retryAtMs) });
            saveSchedule(target, { ipAt: Math.max(now() + (network.status === "ok" ? 1_800_000 : 60_000), network.retryAtMs ?? 0) });
            if (permitted(target, kind)) observations.network(target.context, { pcId: target.permission.computer.id, network });
            return;
          }
          const privileged: SshRun = (command, options) => guarded(credential.sudoPassword === undefined ? command : `/usr/bin/sudo -S -p '' -- ${command}`,
            { ...options, ...(credential.sudoPassword === undefined ? {} : { input: credential.sudoPassword + "\n" }) });
          for (const association of target.permission.associations) {
            const permission = permitted(target, "node"); if (!permission) break;
            const known = observations.read(target.context).associations.find(row => row.address === association.address);
            if (!known || !sameBinding(known.binding, association.binding) || known.sshFingerprint !== permission.computer.fingerprint) continue;
            const saved = schedule(target.key);
            if (permission.rewards && !rewardDenied(target, association) && (saved.rewardsAt[association.address] ?? 0) <= now() && waits().rewards <= now()) {
              saved.rewardsAt[association.address] = now() + 300_000; saveSchedule(target, { rewardsAt: saved.rewardsAt });
              const rewardRun: SshRun = (command, options) => {
                if (waits().rewards > now() || rewardDenied(target, association) || !permitted(target, "node")?.rewards)
                  return Promise.reject(new Error("Rewards permission or provider eligibility changed."));
                return privileged(command, options);
              };
              const rewards = await rewardsReader(rewardRun, association, now);
              const until = now() + Math.max(rewards.status === "rate-limited" ? 300 : 0, rewards.retryAfterSeconds ?? 0) * 1000;
              const currentWait = waits();
              if (until > now()) state.set("monitor/provider-waits", { ...currentWait, rewards: Math.max(currentWait.rewards, until) });
              // Only the exact node's wallet-read grant is suspended. PC IP and GPU
              // permissions stay independent; a denial never starts another signer.
              if (rewards.status === "authentication-failed" || rewards.status === "identity-mismatch") {
                state.set(`monitor:reward-denial:${target.key}:${association.address}`, { at: now(), status: rewards.status, approvedAtMs: permission.approvedAtMs });
              }
              if (permitted(target, "node")) observations.ingest(target.context, { address: association.address, binding: association.binding, rewards,
                monitoring: { status: rewards.status === "authentication-failed" || rewards.status === "identity-mismatch" ? "authorization-required" : "active", checkedAtMs: now() } });
            }
            if (permission.gpu && (saved.gpuAt[association.address] ?? 0) <= now() && permitted(target, "node")) {
              saved.gpuAt[association.address] = now() + 30_000; saveSchedule(target, { gpuAt: saved.gpuAt });
              const gpu = await collectGpu(privileged, association, now);
              if (permitted(target, "node")) observations.ingest(target.context, { address: association.address, binding: association.binding, gpu });
            }
          }
        });
      } catch (error) {
        const errorKind = error && typeof error === "object" && "kind" in error ? error.kind : undefined;
        if (errorKind === "credential-rejected" || errorKind === "identity-changed") suspend(target, errorKind, credential);
        saveSchedule(target, { retryAt: now() + 60_000 });
      }
    })().finally(() => active.delete(key));
    active.set(key, task); return task;
  };
  const tick = async (): Promise<void> => {
    if (stopped) return;
    const current = targets(), pending: Promise<void>[] = [];
    for (const kind of ["ip", "node"] as const) {
      const slots = (kind === "ip" ? 1 : 3) - [...active.keys()].filter(key => key.startsWith(`${kind}:`)).length;
      const due = current.filter(target => permitted(target, kind) && target.schedule.retryAt <= now()
        && (kind === "ip" ? Math.max(target.schedule.ipAt, waits().ip) <= now() : target.schedule.nodeAt <= now()
          && target.permission.associations.some(association => target.permission.gpu && (target.schedule.gpuAt[association.address] ?? 0) <= now()
            || target.permission.rewards && !rewardDenied(target, association) && waits().rewards <= now() && (target.schedule.rewardsAt[association.address] ?? 0) <= now())));
      due.sort((a, b) => (kind === "ip" ? a.schedule.ipAt - b.schedule.ipAt : a.schedule.nodeAt - b.schedule.nodeAt) || a.key.localeCompare(b.key));
      for (const target of due.slice(0, Math.max(0, slots))) pending.push(collect(target, kind));
    }
    await Promise.all(pending);
  };
  return {
    tick,
    start() { if (stopped || timer) return; const turn = () => { void tick().catch(() => {}); }; turn(); timer = setInterval(turn, 1000); timer.unref(); },
    async stop() { stopped = true; if (timer) clearInterval(timer); await Promise.allSettled([...active.values()]); },
    providerWaits: () => Object.entries(waits()).filter(([, at]) => at > now()).map(([provider, retryAtMs]) => ({ provider: `pc-${provider}`, retryAtMs })),
  };
}
