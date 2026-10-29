import type { SharedAccess, PrivateState } from "./access.ts";
import type { createObservationStore } from "./observations.ts";
import type { Computer, SshCredential } from "./ssh.ts";
import { scanAddresses, scanComputers, inspectComputer } from "./ssh.ts";
import type { PcAssociation } from "../contracts/shared.ts";
import { SharedHttpError } from "./ipc.ts";
import type { CredentialVault } from "./credential-vault.ts";
import type { PcPermission } from "./pc-monitor.ts";
import { privateIp, sameBinding } from "../fleet/pc-observations.ts";

interface SetupScan {
  range: string; port: number; total: number; completed: number; found: number;
  status: "running" | "complete" | "cancelled" | "failed";
}
interface SetupNetwork { backendName: string; backendAddress: string; suggestedRange?: string; verifiedAtMs: number; releaseTag?: string }

interface SetupState {
  version: 1; scopeId: string; revision: number;
  phase: "scan" | "scanning" | "select" | "identities" | "credentials" | "review" | "inspecting" | "done";
  computers: Computer[]; selected: string[]; trusted: string[];
  automaticIp: boolean; fullMonitoring: boolean; exclusions: string[]; savedHosts: number; inspectedPcs: number;
  monitoringStatus: string; updatedAtMs: number;
  scan?: SetupScan;
}
interface SetupView extends SetupState { network?: SetupNetwork; terminalConnected: boolean }
/** Public setup intent contains no passwords, passphrases, key files or command strings. */
export function createSetup(state: PrivateState, access: SharedAccess, observations: ReturnType<typeof createObservationStore>, now = Date.now,
  options: { vault?: CredentialVault; scan?: typeof scanComputers; inspect?: typeof inspectComputer } = {}) {
  const sessions = new Map<string, { credential: SshCredential; remember: boolean }>();
  const busy = new Set<string>();
  const terminals = new Map<string, number>();
  const pendingScans = new Set<Promise<SetupView>>();
  let activeScan: { scopeId: string; controller: AbortController; done: Promise<SetupView> } | undefined;
  let closing = false;
  const key = (scopeId: string) => `setup:${scopeId}`;
  for (const context of access.contexts()) {
    const prior = state.get<SetupState>(key(context.scopeId));
    if (prior && ["scanning", "review", "inspecting"].includes(prior.phase)) state.set(key(context.scopeId), { ...prior,
      phase: prior.phase === "scanning" ? "scan" : "credentials", revision: prior.revision + 1,
      ...(prior.phase === "scanning" && prior.scan ? { scan: { ...prior.scan, status: "failed" } } : {}),
      exclusions: [...prior.exclusions, prior.phase === "scanning" ? "Search was interrupted. Start it again."
        : "Setup was interrupted. Confirm terminal sign-in before continuing."], updatedAtMs: now() });
  }
  function readState(scopeId: string): SetupState {
    access.fleet(scopeId);
    return state.get<SetupState>(key(scopeId)) ?? { version: 1, scopeId, revision: 0, phase: "scan", computers: [], selected: [], trusted: [],
      automaticIp: true, fullMonitoring: false, exclusions: [], savedHosts: 0, inspectedPcs: 0, monitoringStatus: "Not configured", updatedAtMs: now() };
  }
  function read(scopeId: string): SetupView {
    const network = state.get<SetupNetwork>(`setup-network:${scopeId}`);
    return { ...readState(scopeId), ...(network ? { network } : {}), terminalConnected: (terminals.get(scopeId) ?? 0) > now() };
  }
  function write(value: SetupState): SetupView { const next = { ...value, revision: value.revision + 1, updatedAtMs: now() }; state.set(key(value.scopeId), next); return read(value.scopeId); }
  function acceptedComputers(scopeId: string, prior: SetupState, scanned: Computer[]): { computers: Computer[]; exclusions: string[] } {
    const known = [...prior.computers.filter(row => prior.trusted.includes(row.id)), ...state.get<Computer[]>(`ssh-identities:${scopeId}`) ?? []];
    const changed = scanned.filter(row => known.some(old => old.host === row.host && old.port === row.port && old.id !== row.id));
    return { computers: scanned.filter(row => !changed.includes(row)), exclusions: changed.map(row => `${row.name}: changed SSH identity blocked`) };
  }
  function startScan(scopeId: string, body: Record<string, unknown>): { view: SetupView; done: Promise<SetupView> } {
    const current = readState(scopeId);
    if (closing || activeScan || busy.has(scopeId) || !["scan", "select", "done"].includes(current.phase)) throw new SharedHttpError(409);
    if (typeof body.range !== "string" || body.range.length > 64 || !Number.isInteger(body.port ?? 22)
      || Number(body.port ?? 22) < 1 || Number(body.port ?? 22) > 65535) throw new SharedHttpError(400);
    const range = body.range.trim(), port = Number(body.port ?? 22);
    let total: number;
    try { total = scanAddresses(range).length; } catch { throw new SharedHttpError(400); }
    const scan: SetupScan = { range, port, total, completed: 0, found: 0, status: "running" };
    const view = write({ ...current, phase: "scanning", scan, exclusions: [] });
    sessions.delete(scopeId); busy.add(scopeId);
    const controller = new AbortController();
    const job = { scopeId, controller, done: Promise.resolve(view) };
    activeScan = job;
    let lastProgressAt = now();
    job.done = Promise.resolve().then(async () => {
      try {
        const scanned = await (options.scan ?? scanComputers)(range, port, { signal: controller.signal,
          onProgress(progress) {
            if (activeScan !== job || controller.signal.aborted || closing) return;
            if (!Number.isSafeInteger(progress.completed) || !Number.isSafeInteger(progress.found)) return;
            const completed = Math.max(scan.completed, Math.min(total, progress.completed));
            scan.completed = completed; scan.found = Math.max(0, Math.min(completed, progress.found));
            if (completed !== total && now() - lastProgressAt < 500) return;
            const latest = readState(scopeId);
            state.set(key(scopeId), { ...latest, scan: { ...scan }, updatedAtMs: now() });
            lastProgressAt = now();
          },
        });
        if (activeScan !== job || controller.signal.aborted || closing) return read(scopeId);
        const accepted = acceptedComputers(scopeId, current, scanned);
        return write({ ...readState(scopeId), ...accepted,
          selected: current.selected.filter(id => accepted.computers.some(row => row.id === id)), phase: "select",
          scan: { ...scan, completed: total, found: accepted.computers.length, status: "complete" } });
      } catch {
        if (activeScan !== job || controller.signal.aborted || closing) return read(scopeId);
        write({ ...readState(scopeId), phase: "scan", scan: { ...scan, status: "failed" }, exclusions: ["The selected network could not be scanned. Check its address and try again."] });
        throw new SharedHttpError(502);
      } finally {
        if (activeScan === job) { activeScan = undefined; busy.delete(scopeId); }
      }
    });
    // The browser receives its acknowledgement immediately; failure is persisted
    // for polling, and the detached promise always has an error observer.
    void job.done.catch(() => {});
    pendingScans.add(job.done);
    void job.done.then(() => pendingScans.delete(job.done), () => pendingScans.delete(job.done));
    return { view, done: job.done };
  }
  function action(scopeId: string, body: Record<string, unknown>): SetupView {
    const current = readState(scopeId);
    if (body.revision !== current.revision || closing) throw new SharedHttpError(409);
    if (body.action === "cancel-scan") {
      if (activeScan?.scopeId !== scopeId || current.phase !== "scanning" || !current.scan) throw new SharedHttpError(409);
      const job = activeScan; activeScan = undefined; busy.delete(scopeId); job.controller.abort();
      return write({ ...current, phase: current.computers.length ? "select" : "scan", scan: { ...current.scan, status: "cancelled" } });
    }
    if (body.action === "scan") return startScan(scopeId, body).view;
    if (body.revision !== current.revision || busy.has(scopeId)) throw new SharedHttpError(409);
    if (body.action === "select" && current.phase === "select") {
      if (!Array.isArray(body.selected) || body.selected.length < 1 || body.selected.length > 512 || new Set(body.selected).size !== body.selected.length
        || body.selected.some(id => !current.computers.some(row => row.id === id))) throw new SharedHttpError(400);
      current.selected = body.selected as string[];
      current.phase = current.selected.every(id => current.trusted.includes(id)) ? "credentials" : "identities";
    } else if (body.action === "trust" && current.phase === "identities") {
      // Approve precisely the selected new identities in one review, without another selection list.
      const identities = new Map((state.get<Computer[]>(`ssh-identities:${scopeId}`) ?? []).map(row => [row.id, row]));
      for (const computer of current.computers.filter(row => current.selected.includes(row.id))) identities.set(computer.id, computer);
      state.set(`ssh-identities:${scopeId}`, [...identities.values()]);
      current.trusted = [...new Set([...current.trusted, ...current.selected])]; current.phase = "credentials";
    } else if (body.action === "inspect" && current.phase === "review") {
      if (typeof body.automaticIp !== "boolean" || typeof body.fullMonitoring !== "boolean") throw new SharedHttpError(400);
      current.automaticIp = body.automaticIp; current.fullMonitoring = body.fullMonitoring; current.phase = "inspecting";
    } else throw new SharedHttpError(409);
    return write(current);
  }
  async function inspect(scopeId: string): Promise<SetupView> {
    const current = readState(scopeId), session = sessions.get(scopeId);
    if (current.phase !== "inspecting" || !session || busy.has(scopeId)) throw new SharedHttpError(409);
    busy.add(scopeId);
    try {
      const priorContext = access.fleet(scopeId), prior = observations.read(priorContext);
      const found: PcAssociation[] = [], exclusions: string[] = [];
      let inspected = 0;
      for (const computer of current.computers.filter(row => current.selected.includes(row.id))) {
        if (!current.trusted.includes(computer.id)) throw new Error("SSH identity was not approved.");
        try { const result = await (options.inspect ?? inspectComputer)(computer, session.credential, now); found.push(...result.associations); exclusions.push(...result.exclusions); inspected++; }
        catch { exclusions.push(`${computer.name}: SSH verification or inspection failed`); }
      }
      // Conflicting public identities must never be silently assigned to a different PC.
      const unique = new Map<string, PcAssociation>();
      for (const association of [...prior.associations, ...found]) {
        const previous = unique.get(association.address);
        if (previous && previous.binding.pcId !== association.binding.pcId) { exclusions.push(`${association.name}: conflicting host identity excluded`); continue; }
        unique.set(association.address, association);
      }
      const addresses = [...new Set([...priorContext.addresses, ...unique.keys()])], context = access.setFleet(scopeId, addresses);
      observations.associate(context, [...unique.values()]);
      // Copy only verified matching observations, including retained values and original receipt times.
      observations.carry(context, prior);
      // Roster growth must not pause unrelated approved PCs. Carry only unchanged
      // exact bindings, preserving approval times, denials and revoked flags.
      for (const pcId of new Set(prior.associations.map(row => row.binding.pcId))) {
        const permissionKey = `permission:${scopeId}:${pcId}`, previous = state.get<PcPermission>(permissionKey);
        if (!previous || previous.rosterRevision !== priorContext.rosterRevision) continue;
        const unchanged = previous.associations.every(row => {
          const next = unique.get(row.address); return next && sameBinding(row.binding, next.binding) && row.sshFingerprint === next.sshFingerprint;
        });
        if (unchanged) state.set(permissionKey, { ...previous, rosterRevision: context.rosterRevision });
        else exclusions.push(`${previous.computer.name}: changed node binding needs a new explicit monitoring approval`);
      }
      // Approval is bound to exact PC/key/container/public identity, never just an IP.
      for (const computer of current.computers.filter(row => current.selected.includes(row.id))) {
        const associations = found.filter(row => row.binding.pcId === computer.id);
        if (!associations.length) continue;
        const permissionKey = `permission:${scopeId}:${computer.id}`;
        const previous = state.get<PcPermission>(permissionKey);
        if (previous && (previous.revokedAtMs !== null || previous.paused)) { exclusions.push(`${computer.name}: prior pause or revocation retained`); continue; }
        if (session.remember && options.vault) options.vault.save(scopeId, computer.id, session.credential);
        else if (session.remember) { exclusions.push(`${computer.name}: protected credential storage unavailable`); continue; }
        const approved = new Map((previous?.associations ?? []).filter(row => {
          const next = unique.get(row.address); return next && sameBinding(row.binding, next.binding) && row.sshFingerprint === next.sshFingerprint;
        }).map(row => [row.address, row]));
        if (current.fullMonitoring && session.remember) for (const association of associations) approved.set(association.address, association);
        state.set(permissionKey, { version: 1, computer, associations: [...approved.values()], rosterRevision: context.rosterRevision,
          automaticIp: previous?.automaticIp || current.automaticIp && session.remember,
          rewards: previous?.rewards || current.fullMonitoring && session.remember,
          gpu: previous?.gpu || current.fullMonitoring && session.remember,
          approvedAtMs: current.fullMonitoring && session.remember ? now() : previous?.approvedAtMs ?? now(), revokedAtMs: null, paused: false });
      }
      current.phase = "done"; current.savedHosts = context.addresses.length; current.inspectedPcs = inspected; current.exclusions = exclusions;
      const permissions = [...new Set([...unique.values()].map(row => row.binding.pcId))].map(pcId => state.get<PcPermission>(`permission:${scopeId}:${pcId}`));
      const enabled = permissions.filter((permission): permission is PcPermission => !!permission && permission.rosterRevision === context.rosterRevision && !permission.paused && permission.revokedAtMs === null);
      const ipCount = enabled.filter(permission => permission.automaticIp).length;
      const rewardCount = enabled.reduce((count, permission) => count + (permission.rewards ? permission.associations.length : 0), 0);
      const gpuCount = enabled.reduce((count, permission) => count + (permission.gpu ? permission.associations.length : 0), 0);
      current.monitoringStatus = `Automatic IP approved on ${ipCount} PCs · rewards reads approved for ${rewardCount} hosts · GPU monitoring approved for ${gpuCount} hosts. `
        + "Existing healthy approvals are retained. Read status and freshness remain separate."
        + (!session.remember ? " New credentials were not retained." : "");
      sessions.delete(scopeId); return write(current);
    } finally { busy.delete(scopeId); }
  }
  async function control(body: Record<string, unknown>): Promise<unknown> {
    if (typeof body.scopeId !== "string") throw new SharedHttpError(400);
    const scopeId = body.scopeId, current = readState(scopeId);
    if (body.operation === "setup-status") return read(scopeId);
    if (body.operation === "setup-action") return action(scopeId, body);
    if (body.operation === "setup-terminal") {
      if (body.connected !== undefined && typeof body.connected !== "boolean") throw new SharedHttpError(400);
      if (body.connected === false) terminals.delete(scopeId); else terminals.set(scopeId, now() + 30_000);
      return read(scopeId);
    }
    if (body.operation === "setup-network-context") {
      if (typeof body.backendName !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(body.backendName)
        || typeof body.backendAddress !== "string" || !privateIp(body.backendAddress)
        || !Number.isSafeInteger(body.verifiedAtMs) || Number(body.verifiedAtMs) < 0 || Number(body.verifiedAtMs) > now() + 60_000)
        throw new SharedHttpError(400);
      if (body.suggestedRange !== undefined) {
        if (typeof body.suggestedRange !== "string" || body.suggestedRange.length > 64) throw new SharedHttpError(400);
        try { if (!scanAddresses(body.suggestedRange).includes(body.backendAddress)) throw new Error(); }
        catch { throw new SharedHttpError(400); }
      }
      if (body.releaseTag !== undefined && (typeof body.releaseTag !== "string" || body.releaseTag.length > 96
        || !/^modern-v\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(body.releaseTag) || /\s/.test(body.releaseTag))) throw new SharedHttpError(400);
      const network: SetupNetwork = { backendName: body.backendName, backendAddress: body.backendAddress, verifiedAtMs: Number(body.verifiedAtMs),
        ...(typeof body.suggestedRange === "string" ? { suggestedRange: body.suggestedRange } : {}),
        ...(typeof body.releaseTag === "string" ? { releaseTag: body.releaseTag } : {}) };
      state.set(`setup-network:${scopeId}`, network); return read(scopeId);
    }
    if (body.operation === "setup-scan") {
      if (body.revision !== undefined && body.revision !== current.revision) throw new SharedHttpError(409);
      return startScan(scopeId, body).done;
    }
    if (body.operation === "setup-auth") {
      if (body.revision !== undefined && body.revision !== current.revision) throw new SharedHttpError(409);
      if (current.phase !== "credentials" || typeof body.username !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(body.username)
        || typeof body.remember !== "boolean") throw new SharedHttpError(400);
      const credential: SshCredential = { username: body.username };
      for (const field of ["password", "privateKey", "passphrase", "sudoPassword"] as const) {
        const value = body[field]; if (value !== undefined) {
          if (typeof value !== "string" || value.length > (field === "privateKey" ? 64 * 1024 : 4096)) throw new SharedHttpError(400);
          credential[field] = value;
        }
      }
      if (!credential.password && !credential.privateKey) throw new SharedHttpError(400);
      sessions.set(scopeId, { credential, remember: body.remember }); return write({ ...current, phase: "review" });
    }
    if (body.operation === "setup-inspect") return inspect(scopeId);
    throw new SharedHttpError(404);
  }
  async function close(): Promise<void> {
    closing = true; terminals.clear(); const job = activeScan;
    job?.controller.abort(); await Promise.allSettled([...pendingScans]);
  }
  return { read, action, control, inspect, close };
}
