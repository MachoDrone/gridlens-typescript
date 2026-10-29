import type { SharedAccess, PrivateState } from "./access.ts";
import type { createObservationStore } from "./observations.ts";
import type { Computer, SshCredential } from "./ssh.ts";
import { scanAddresses, scanComputers, inspectComputer, SshAccessError } from "./ssh.ts";
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
interface SetupResult { pcId: string; name: string; status: "success" | "attention" | "failed"; hosts: number; message: string }
interface SetupReport { status: "running" | "complete" | "failed"; total: number; completed: number; results: SetupResult[] }
interface ManagedComputer {
  id: string; name: string; host: string; port: number; hostCount: number; username: string | null;
  hasSavedCredential: boolean; status: "approved" | "paused" | "revoked" | "not-approved"; removed: boolean;
}

interface SetupState {
  version: 1; scopeId: string; revision: number;
  phase: "scan" | "scanning" | "select" | "identities" | "credentials" | "review" | "inspecting" | "done";
  computers: Computer[]; selected: string[]; trusted: string[];
  automaticIp: boolean; fullMonitoring: boolean; exclusions: string[]; savedHosts: number; inspectedPcs: number;
  monitoringStatus: string; updatedAtMs: number;
  scan?: SetupScan;
  report?: SetupReport;
}
interface SetupView extends SetupState { network?: SetupNetwork; terminalConnected: boolean; managed: ManagedComputer[] }
/** Public setup state/reports contain no credentials. The bounded browser
 * enrollment request is handled only by the owner and its protected vault. */
export function createSetup(state: PrivateState, access: SharedAccess, observations: ReturnType<typeof createObservationStore>, now = Date.now,
  options: { vault?: CredentialVault; scan?: typeof scanComputers; inspect?: typeof inspectComputer } = {}) {
  const sessions = new Map<string, { credential?: SshCredential; credentials?: Map<string, SshCredential>; remember: boolean;
    browser?: boolean; restore?: Set<string>; signal?: AbortSignal; failures?: Map<string, string> }>();
  const busy = new Set<string>();
  const terminals = new Map<string, number>();
  const pendingScans = new Set<Promise<SetupView>>();
  const pendingConfigurations = new Map<string, { controller: AbortController; done: Promise<SetupView> }>();
  let activeScan: { scopeId: string; controller: AbortController; done: Promise<SetupView> } | undefined;
  let closing = false;
  const key = (scopeId: string) => `setup:${scopeId}`;
  for (const context of access.contexts()) {
    const prior = state.get<SetupState>(key(context.scopeId));
    if (prior && ["scanning", "review", "inspecting"].includes(prior.phase)) state.set(key(context.scopeId), { ...prior,
      phase: prior.phase === "scanning" ? "scan" : "credentials", revision: prior.revision + 1,
      ...(prior.phase === "scanning" && prior.scan ? { scan: { ...prior.scan, status: "failed" } } : {}),
      ...(prior.report?.status === "running" ? { report: { ...prior.report, status: "failed" } } : {}),
      exclusions: [...prior.exclusions, prior.phase === "scanning" ? "Search was interrupted. Start it again."
        : prior.report ? "Setup was interrupted. Enter the computer sign-in again to retry." : "Setup was interrupted. Confirm terminal sign-in before continuing."], updatedAtMs: now() });
  }
  function readState(scopeId: string): SetupState {
    access.fleet(scopeId);
    return state.get<SetupState>(key(scopeId)) ?? { version: 1, scopeId, revision: 0, phase: "scan", computers: [], selected: [], trusted: [],
      automaticIp: true, fullMonitoring: false, exclusions: [], savedHosts: 0, inspectedPcs: 0, monitoringStatus: "Not configured", updatedAtMs: now() };
  }
  function read(scopeId: string): SetupView {
    const network = state.get<SetupNetwork>(`setup-network:${scopeId}`);
    const current = readState(scopeId), data = observations.read(access.fleet(scopeId));
    const known = new Map((state.get<Computer[]>(`ssh-identities:${scopeId}`) ?? []).map(row => [row.id, row]));
    for (const row of current.computers) if (!known.has(row.id)) known.set(row.id, row);
    const managed: ManagedComputer[] = [];
    for (const computer of known.values()) {
      const permission = state.get<PcPermission>(`permission:${scopeId}:${computer.id}`);
      const associations = data.associations.filter(row => row.binding.pcId === computer.id);
      if (!permission && !associations.length) continue;
      let credential: SshCredential | undefined;
      try { credential = options.vault?.read(scopeId, computer.id); } catch { /* A damaged saved sign-in requires a new one. */ }
      managed.push({ id: computer.id, name: associations[0]?.name ?? computer.name, host: computer.host, port: computer.port,
        hostCount: associations.length, username: credential?.username ?? null, hasSavedCredential: !!credential,
        status: !permission ? "not-approved" : permission.revokedAtMs !== null ? "revoked" : permission.paused ? "paused" : "approved",
        removed: !associations.length && permission?.revokedAtMs !== null && permission?.revokedAtMs !== undefined });
    }
    return { ...current, managed, ...(network ? { network } : {}), terminalConnected: (terminals.get(scopeId) ?? 0) > now() };
  }
  function write(value: SetupState): SetupView { const next = { ...value, revision: value.revision + 1, updatedAtMs: now() }; state.set(key(value.scopeId), next); return read(value.scopeId); }
  function acceptedComputers(scopeId: string, prior: SetupState, scanned: Computer[]): { computers: Computer[]; exclusions: string[] } {
    const known = [...prior.computers.filter(row => prior.trusted.includes(row.id)), ...state.get<Computer[]>(`ssh-identities:${scopeId}`) ?? []];
    const changed = scanned.filter(row => known.some(old => old.host === row.host && old.port === row.port && old.id !== row.id));
    return { computers: scanned.filter(row => !changed.includes(row)), exclusions: changed.map(row => `${row.name}: changed SSH identity blocked`) };
  }
  function startScan(scopeId: string, body: Record<string, unknown>): { view: SetupView; done: Promise<SetupView> } {
    const current = readState(scopeId);
    if (closing || activeScan || pendingConfigurations.size || busy.has(scopeId) || !["scan", "select", "done"].includes(current.phase)) throw new SharedHttpError(409);
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
    if (body.revision !== current.revision || closing || pendingConfigurations.has(scopeId)) throw new SharedHttpError(409);
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
  async function inspect(scopeId: string, browserJob = false): Promise<SetupView> {
    const current = readState(scopeId), session = sessions.get(scopeId);
    if (current.phase !== "inspecting" || !session || busy.has(scopeId) || pendingConfigurations.has(scopeId) && !browserJob) throw new SharedHttpError(409);
    busy.add(scopeId);
    try {
      const priorContext = access.fleet(scopeId), prior = observations.read(priorContext);
      const found: PcAssociation[] = [], exclusions: string[] = [];
      let inspected = 0; const verifiedComputers = new Set<string>();
      const report: SetupReport | undefined = session.browser ? { status: "running", total: current.selected.length, completed: 0, results: [] } : undefined;
      for (const computer of current.computers.filter(row => current.selected.includes(row.id))) {
        if (closing || session.signal?.aborted) throw new Error("Setup interrupted");
        if (!current.trusted.includes(computer.id)) throw new Error("SSH identity was not approved.");
        const credential = session.credentials?.get(computer.id) ?? session.credential;
        if (!credential) {
          const message = session.failures?.get(computer.id) ?? "Enter this computer's username and password.";
          exclusions.push(`${computer.name}: ${message}`);
          report?.results.push({ pcId: computer.id, name: computer.name, status: "failed", hosts: 0, message });
        } else try {
          const result = await (options.inspect ?? inspectComputer)(computer, credential, now, { autoSudo: !!session.browser, ...(session.signal ? { signal: session.signal } : {}) });
          if (closing || session.signal?.aborted) throw new Error("Setup interrupted");
          const safeText = (value: string): string => {
            for (const secret of [credential.password, credential.passphrase, credential.privateKey, credential.sudoPassword])
              if (secret) value = value.replaceAll(secret, "[redacted]");
            return value;
          };
          found.push(...result.associations.map(row => ({ ...row, name: safeText(row.name) })));
          exclusions.push(...result.exclusions.map(safeText)); inspected++; verifiedComputers.add(computer.id);
          if (result.credential && session.credentials) session.credentials.set(computer.id, result.credential);
          if (result.name) computer.name = safeText(result.name);
          report?.results.push({ pcId: computer.id, name: computer.name, status: result.associations.length && !result.exclusions.length ? "success" : "attention",
            hosts: result.associations.length, message: result.exclusions.length ? "Some inventory checks need attention. Review the details below."
              : result.associations.length ? `${result.associations.length} Nosana hosts verified.` : "Sign-in worked, but no running Nosana hosts were found." });
        } catch (error) {
          if (closing || session.signal?.aborted) throw error;
          const message = error instanceof SshAccessError ? error.kind === "credential-rejected" ? "Sign-in rejected. Check the username and password."
            : error.kind === "identity-changed" ? "The SSH identity changed. This computer was not trusted or changed." : "Could not connect to this computer."
            : "Computer inspection could not complete. Check access and try again.";
          exclusions.push(`${computer.name}: ${message}`);
          report?.results.push({ pcId: computer.id, name: computer.name, status: "failed", hosts: 0, message });
        }
        if (report) { report.completed++; state.set(key(scopeId), { ...readState(scopeId), report: structuredClone(report), updatedAtMs: now() }); }
      }
      if (closing || session.signal?.aborted) throw new Error("Setup interrupted");
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
        const permissionKey = `permission:${scopeId}:${computer.id}`;
        const previous = state.get<PcPermission>(permissionKey);
        if (!associations.length) {
          // Updating a verified existing PC's login can succeed while its nodes
          // are temporarily unavailable; keep original bindings and timestamps.
          const credential = session.credentials?.get(computer.id);
          if (session.browser && verifiedComputers.has(computer.id) && previous && !previous.paused && previous.revokedAtMs === null
            && prior.associations.some(row => row.binding.pcId === computer.id && row.sshFingerprint === computer.fingerprint)
            && credential && options.vault) options.vault.save(scopeId, computer.id, credential);
          continue;
        }
        const restoring = !!session.restore?.has(computer.id);
        if (previous && (previous.revokedAtMs !== null || previous.paused) && !restoring) {
          exclusions.push(`${computer.name}: prior pause or revocation retained`);
          const row = report?.results.find(row => row.pcId === computer.id); if (row) { row.status = "attention"; row.message = "Monitoring remains paused or removed. Explicitly select Restore to enable it again."; }
          continue;
        }
        const credential = session.credentials?.get(computer.id) ?? session.credential;
        if (session.remember && options.vault && credential) options.vault.save(scopeId, computer.id, credential);
        else if (session.remember) { exclusions.push(`${computer.name}: protected credential storage unavailable`); continue; }
        const approved = new Map((restoring ? [] : previous?.associations ?? []).filter(row => {
          const next = unique.get(row.address); return next && sameBinding(row.binding, next.binding) && row.sshFingerprint === next.sshFingerprint;
        }).map(row => [row.address, row]));
        if (current.fullMonitoring && session.remember) for (const association of associations) approved.set(association.address, association);
        state.set(permissionKey, { version: 1, computer, associations: [...approved.values()], rosterRevision: context.rosterRevision,
          automaticIp: !restoring && previous?.automaticIp || current.automaticIp && session.remember,
          rewards: !restoring && previous?.rewards || current.fullMonitoring && session.remember,
          gpu: !restoring && previous?.gpu || current.fullMonitoring && session.remember,
          approvedAtMs: restoring || current.fullMonitoring && session.remember ? now() : previous?.approvedAtMs ?? now(), revokedAtMs: null, paused: false });
      }
      current.phase = "done"; current.savedHosts = context.addresses.length; current.inspectedPcs = inspected; current.exclusions = exclusions;
      if (report) current.report = { ...report, status: "complete" };
      const identities = new Map((state.get<Computer[]>(`ssh-identities:${scopeId}`) ?? []).map(row => [row.id, row]));
      for (const computer of current.computers.filter(row => current.selected.includes(row.id))) if (identities.has(computer.id)) identities.set(computer.id, computer);
      state.set(`ssh-identities:${scopeId}`, [...identities.values()]);
      const permissions = [...new Set([...unique.values()].map(row => row.binding.pcId))].map(pcId => state.get<PcPermission>(`permission:${scopeId}:${pcId}`));
      const enabled = permissions.filter((permission): permission is PcPermission => !!permission && permission.rosterRevision === context.rosterRevision && !permission.paused && permission.revokedAtMs === null);
      const ipCount = enabled.filter(permission => permission.automaticIp).length;
      const rewardCount = enabled.reduce((count, permission) => count + (permission.rewards ? permission.associations.length : 0), 0);
      const gpuCount = enabled.reduce((count, permission) => count + (permission.gpu ? permission.associations.length : 0), 0);
      current.monitoringStatus = `Automatic IP approved on ${ipCount} PCs · rewards reads approved for ${rewardCount} hosts · GPU monitoring approved for ${gpuCount} hosts. `
        + "Existing healthy approvals are retained. Read status and freshness remain separate."
        + (!session.remember ? " New credentials were not retained." : "");
      return write(current);
    } finally { session.credentials?.clear(); sessions.delete(scopeId); busy.delete(scopeId); }
  }
  function browserConfigure(scopeId: string, body: Record<string, unknown>): SetupView {
    const current = readState(scopeId);
    if (closing || activeScan || pendingConfigurations.size || busy.has(scopeId) || current.phase === "inspecting"
      || body.revision !== current.revision) throw new SharedHttpError(409);
    if (!Array.isArray(body.selected) || body.selected.length < 1 || body.selected.length > 512
      || new Set(body.selected).size !== body.selected.length || body.selected.some(value => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
      || body.username !== undefined && (typeof body.username !== "string" || body.username !== "" && !/^[A-Za-z0-9_.-]{1,64}$/.test(body.username))
      || body.password !== undefined && (typeof body.password !== "string" || body.password.length > 4096)
      || body.fullMonitoring !== undefined && typeof body.fullMonitoring !== "boolean"
      || body.restorePcIds !== undefined && (!Array.isArray(body.restorePcIds) || new Set(body.restorePcIds).size !== body.restorePcIds.length
        || body.restorePcIds.some(id => !(body.selected as unknown[]).includes(id)))) throw new SharedHttpError(400);
    const username = typeof body.username === "string" ? body.username : "", password = typeof body.password === "string" ? body.password : "";
    if (password && !username) throw new SharedHttpError(400);
    const known = state.get<Computer[]>(`ssh-identities:${scopeId}`) ?? [];
    const candidates = new Map(known.map(row => [row.id, row]));
    for (const row of current.computers) candidates.set(row.id, row);
    const selected = body.selected as string[], computers = selected.map(id => candidates.get(id));
    if (computers.some(row => !row)) throw new SharedHttpError(400);
    const approved = computers as Computer[];
    // A selected scan result is the initial pin. A saved endpoint's changed key
    // cannot be accepted through this convenient setup action.
    if (approved.some(row => known.some(old => old.host === row.host && old.port === row.port && old.id !== row.id))) throw new SharedHttpError(409);
    const restore = new Set((body.restorePcIds ?? []) as string[]), credentials = new Map<string, SshCredential>(), failures = new Map<string, string>();
    for (const computer of approved) {
      const permission = state.get<PcPermission>(`permission:${scopeId}:${computer.id}`);
      if (permission && (permission.paused || permission.revokedAtMs !== null) && !restore.has(computer.id)) {
        failures.set(computer.id, "This computer is paused or removed. Select Restore to enable it again."); continue;
      }
      if (password) credentials.set(computer.id, { username, password });
      else {
        let saved: SshCredential | undefined;
        try { saved = options.vault?.read(scopeId, computer.id); } catch { /* Request fresh credentials instead. */ }
        if (saved && (!username || saved.username === username)) credentials.set(computer.id, saved);
      }
    }
    const pins = new Map(known.map(row => [row.id, row]));
    for (const computer of approved) pins.set(computer.id, computer);
    state.set(`ssh-identities:${scopeId}`, [...pins.values()]);
    const controller = new AbortController();
    sessions.set(scopeId, { credentials, failures, remember: true, browser: true, restore, signal: controller.signal });
    const report: SetupReport = { status: "running", total: approved.length, completed: 0, results: [] };
    const allComputers = new Map(current.computers.map(row => [row.id, row]));
    for (const computer of approved) allComputers.set(computer.id, computer);
    const view = write({ ...current, phase: "inspecting", computers: [...allComputers.values()], selected,
      trusted: [...new Set([...current.trusted, ...selected])], automaticIp: true, fullMonitoring: body.fullMonitoring === true,
      report, exclusions: [] });
    const job = { controller, done: Promise.resolve(view) };
    pendingConfigurations.set(scopeId, job);
    job.done = Promise.resolve().then(() => inspect(scopeId, true)).catch(() => {
      if (!closing) {
        const latest = readState(scopeId), previous = latest.report ?? report;
        return write({ ...latest, phase: "done", report: { ...previous, status: "failed" },
          exclusions: [...latest.exclusions, "Setup could not finish. Review the results and retry the affected computers."] });
      }
      return read(scopeId);
    }).finally(() => { credentials.clear(); failures.clear(); sessions.delete(scopeId); pendingConfigurations.delete(scopeId); });
    // A disconnected browser does not cancel its authorized setup operation.
    void job.done.catch(() => {});
    return view;
  }
  function browserRemove(scopeId: string, body: Record<string, unknown>): SetupView {
    const current = readState(scopeId);
    if (closing || activeScan || pendingConfigurations.size || busy.has(scopeId) || body.revision !== current.revision) throw new SharedHttpError(409);
    if (typeof body.pcId !== "string" || !/^[a-f0-9]{64}$/.test(body.pcId)) throw new SharedHttpError(400);
    const pcId = body.pcId, priorContext = access.fleet(scopeId), prior = observations.read(priorContext);
    const removed = prior.associations.filter(row => row.binding.pcId === pcId), permissionKey = `permission:${scopeId}:${pcId}`;
    const permission = state.get<PcPermission>(permissionKey);
    const computer = permission?.computer ?? (state.get<Computer[]>(`ssh-identities:${scopeId}`) ?? []).find(row => row.id === pcId);
    if (!computer || !removed.length && !permission) throw new SharedHttpError(404);
    // Fence in-flight work and erase this sign-in before changing membership.
    if (permission) state.set(permissionKey, { ...permission, paused: true, revokedAtMs: permission.revokedAtMs ?? now() });
    options.vault?.forget(scopeId, pcId);
    const removedAddresses = new Set(removed.map(row => row.address)), kept = prior.associations.filter(row => row.binding.pcId !== pcId);
    const context = access.setFleet(scopeId, priorContext.addresses.filter(address => !removedAddresses.has(address)));
    observations.associate(context, kept); observations.carry(context, prior);
    for (const otherId of new Set(kept.map(row => row.binding.pcId))) {
      const otherKey = `permission:${scopeId}:${otherId}`, previous = state.get<PcPermission>(otherKey);
      if (previous?.rosterRevision === priorContext.rosterRevision) state.set(otherKey, { ...previous, rosterRevision: context.rosterRevision });
    }
    return write({ ...current, phase: "done", selected: current.selected.filter(id => id !== pcId), savedHosts: context.addresses.length,
      exclusions: [], monitoringStatus: "Computer removed. Monitoring stopped and its stored sign-in was forgotten. Other computers are unchanged.",
      report: { status: "complete", total: 1, completed: 1, results: [{ pcId, name: removed[0]?.name ?? computer.name,
        status: "success", hosts: removed.length, message: `Removed ${removed.length} hosts from the fleet. Monitoring stopped and the stored sign-in was forgotten.` }] } });
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
    job?.controller.abort(); for (const pending of pendingConfigurations.values()) pending.controller.abort();
    await Promise.allSettled([...pendingScans, ...[...pendingConfigurations.values()].map(pending => pending.done)]); sessions.clear();
  }
  return { read, action, control, inspect, browserConfigure, browserRemove, close };
}
