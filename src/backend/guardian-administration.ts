import { createHash, randomUUID } from "node:crypto";
import type { FleetContext } from "../contracts/fleet.ts";
import type { PcAssociation } from "../contracts/shared.ts";
import type { TreasuryConfiguration } from "../contracts/treasury.ts";
import type { UpdateBuild } from "../contracts/updates.ts";
import type { PrivateState } from "./access.ts";
import type { CredentialVault } from "./credential-vault.ts";
import type { createObservationStore } from "./observations.ts";
import type { PcPermission } from "./pc-monitor.ts";
import { sameBinding } from "../fleet/pc-observations.ts";
import { openOwnerAuthority, OwnerAuthorityError, parseOwnerAuthority } from "./owner-authority.ts";
import type { OwnerAuthority, OwnerAuthorityDescriptor } from "./owner-authority.ts";
import { createGuardianTransport } from "./guardian-transport.ts";
import type { FinancialGuardianTransport, GuardianTarget } from "./guardian-transport.ts";
import type { GuardianStatus } from "./source-guardian.ts";
import { TreasuryPreflightError } from "./treasury-errors.ts";
import { withSsh } from "./ssh.ts";
import type { SshRun } from "./ssh.ts";
import { fetchGuardianRelease, fetchGuardianReleaseMetadata, verifyGuardianReleaseIdentity } from "../installer/guardian-release.ts";
import type { GuardianReleaseIdentity } from "../installer/guardian-release.ts";
import { verifyRelease } from "../installer/release.ts";
import { inspectSourceGuardian, provisionSourceGuardian } from "../installer/source-guardian.ts";
import { framedSudoInput } from "./sudo-input.ts";
import { isMetadataAddress } from "../fleet/host-metadata.ts";

export const OWNER_AUTHORITY_LEDGER_KEY = "financial.owner-authority.v1";
const AUTHORITY = OWNER_AUTHORITY_LEDGER_KEY;
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
interface Target extends GuardianTarget { sources: PcAssociation[]; approvalAtMs: number }
interface EnrollmentRecord { version: 1; authorityId: string; targetHash: string; destinationAddress: string; verifiedAtMs: number;
  releaseProof: { manifest: string; signature: string } }
interface PolicySync { version: 1; state: "pending" | "verified" | "settled"; destinationAddress: string; rosterRevision: string }
interface EnrollmentJob { version: 1; id: string; state: "running" | "complete" | "interrupted"; total: number; completed: number; startedAtMs: number; updatedAtMs: number }
export interface GuardianSummary { required: true; authorityId: string | null; state: "not-enrolled" | "ready" | "recovery-required" | "enrolling" | "sync-required"; job?: EnrollmentJob }
export interface GuardianAdministrationOptions {
  state: PrivateState; vault: CredentialVault; observations: ReturnType<typeof createObservationStore>;
  contexts: () => readonly FleetContext[]; credentialsDirectory: string; cacheDirectory: string;
  trustPublicKey: string; build: UpdateBuild; now?: () => number;
  connect?: typeof withSsh; download?: typeof fetchGuardianRelease; provision?: typeof provisionSourceGuardian;
  metadata?: typeof fetchGuardianReleaseMetadata; inspect?: typeof inspectSourceGuardian;
  openAuthority?: typeof openOwnerAuthority; transportFactory?: typeof createGuardianTransport;
}

/** Ownership and enrollment records use the retained owner ledger. The only
 * create path is an explicit owner-authorized enrollment, never startup/reset. */
export function createGuardianAdministration(options: GuardianAdministrationOptions) {
  const { state, vault, observations, contexts } = options, now = options.now ?? Date.now;
  const connect = options.connect ?? withSsh, download = options.download ?? fetchGuardianRelease;
  const provision = options.provision ?? provisionSourceGuardian, openAuthority = options.openAuthority ?? openOwnerAuthority;
  let authority: OwnerAuthority | undefined, delegate: FinancialGuardianTransport | undefined, recovery = false, closed = false;
  const abort = new AbortController();
  let work: Promise<void> | undefined;
  let currentIdentity: Promise<GuardianReleaseIdentity> | undefined;
  const verifiedIdentities = new Map<string, GuardianReleaseIdentity>();
  const jobKey = (scope: string) => `financial.guardian-job.v1:${scope}`;
  const recordKey = (scope: string, pc: string) => `financial.guardian-enrollment.v1:${scope}:${pc}`;
  const syncKey = (scope: string) => `financial.guardian-policy-sync.v1:${scope}`;
  function readSync(scope: string): PolicySync | undefined {
    const value = state.get<PolicySync>(syncKey(scope));
    if (value !== undefined && (!value || value.version !== 1 || !["pending", "verified", "settled"].includes(value.state)
      || !isMetadataAddress(value.destinationAddress) || typeof value.rosterRevision !== "string")) throw new TreasuryPreflightError("source-changed");
    return value;
  }
  async function identityFor(target: GuardianTarget): Promise<GuardianReleaseIdentity> {
    const records = contexts().map(context => state.get<EnrollmentRecord>(recordKey(context.scopeId, target.computer.id))).filter(row => row?.releaseProof);
    let identity: GuardianReleaseIdentity;
    if (records.length) {
      if (new Set(records.map(record => JSON.stringify(record!.releaseProof))).size !== 1) throw new TreasuryPreflightError("source-changed");
      const proof = records[0]!.releaseProof;
      if (typeof proof.manifest !== "string" || typeof proof.signature !== "string" || proof.manifest.length > 32_768 || proof.signature.length > 128) throw new TreasuryPreflightError("source-changed");
      const manifest = Buffer.from(proof.manifest, "base64"), signature = Buffer.from(proof.signature, "base64");
      if (manifest.toString("base64") !== proof.manifest || signature.toString("base64") !== proof.signature) throw new TreasuryPreflightError("source-changed");
      identity = { manifest, signature, release: verifyRelease(manifest, signature, options.trustPublicKey), trustPublicKey: options.trustPublicKey };
    } else {
      currentIdentity ??= (options.metadata ?? fetchGuardianReleaseMetadata)({ cacheDirectory: options.cacheDirectory, trustPublicKey: options.trustPublicKey,
        build: options.build, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(12_000)]) }).catch(error => { currentIdentity = undefined; throw error; });
      identity = await currentIdentity;
    }
    verifyGuardianReleaseIdentity(identity); return identity;
  }
  function load(create: boolean): OwnerAuthority | undefined {
    if (authority) return authority;
    const retained = state.get<OwnerAuthorityDescriptor>(AUTHORITY);
    try {
      const expected = retained === undefined ? undefined : parseOwnerAuthority(retained).authorityId;
      authority = openAuthority(options.credentialsDirectory, { create, historyPresent: true, allowHistoryMigration: create,
        ...(expected ? { expectedAuthorityId: expected } : {}) });
      if (!create && retained === undefined) throw new OwnerAuthorityError("recovery-required");
      if (expected && authority.descriptor.authorityId !== expected) throw new Error("Owner identity changed.");
      state.set(AUTHORITY, authority.descriptor);
      delegate = (options.transportFactory ?? createGuardianTransport)({ authority, connect, now,
        async verifyTarget(run, target) {
          const identity = await identityFor(target);
          await (options.inspect ?? inspectSourceGuardian)(run, { authorityId: authority!.descriptor.authorityId, pcId: target.computer.id }, identity);
          verifiedIdentities.set(target.computer.id, identity);
        } });
      return authority;
    } catch (error) {
      authority?.close(); authority = undefined; delegate = undefined;
      if (retained !== undefined || !(error instanceof OwnerAuthorityError) || error.kind !== "not-initialized") recovery = true;
      if (create) throw new TreasuryPreflightError("source-changed");
      return undefined;
    }
  }
  load(false);
  function targets(context: FleetContext): Target[] {
    const current = contexts().find(item => item.scopeId === context.scopeId);
    if (!current || current.rosterRevision !== context.rosterRevision) throw new TreasuryPreflightError("source-changed");
    const grouped = new Map<string, PcAssociation[]>();
    for (const row of observations.read(context).associations) {
      const rows = grouped.get(row.binding.pcId) ?? []; rows.push(row); grouped.set(row.binding.pcId, rows);
    }
    return [...grouped].map(([pcId, sources]) => {
      const permission = state.get<PcPermission>(`permission:${context.scopeId}:${pcId}`), credential = vault.read(context.scopeId, pcId);
      if (!permission || permission.version !== 1 || permission.paused || permission.revokedAtMs !== null
        || permission.rosterRevision !== context.rosterRevision || permission.computer.id !== pcId || !credential
        || sources.some(source => source.sshFingerprint !== permission.computer.fingerprint || !permission.associations.some(item => item.address === source.address && sameBinding(item.binding, source.binding))))
        throw new TreasuryPreflightError("source-changed");
      return { computer: permission.computer, credential, sources, approvalAtMs: permission.approvedAtMs };
    });
  }
  const targetHash = (target: Target): string => digest([
    [target.computer.id, target.computer.host, target.computer.port, target.computer.fingerprint, target.computer.hostKey], target.approvalAtMs,
    target.sources.map(source => ({ address: source.address, binding: source.binding, sshFingerprint: source.sshFingerprint }))
      .sort((left, right) => left.address.localeCompare(right.address)),
  ]);
  function assertAuthority(): void { if (closed || recovery || !delegate) throw new TreasuryPreflightError("source-changed"); }
  function assertLive(): void {
    assertAuthority();
    if (work || contexts().some(context => { const sync = readSync(context.scopeId); return sync && sync.state !== "settled"; })) throw new TreasuryPreflightError("source-changed");
  }
  const transport: FinancialGuardianTransport = {
    status(target) { assertAuthority(); return delegate!.status(target); },
    prepare(...args) { assertLive(); return delegate!.prepare(...args); },
    assertReady(...args) { assertLive(); return delegate!.assertReady(...args); },
    transfer(...args) { assertLive(); return delegate!.transfer(...args); },
    claim(...args) { assertLive(); return delegate!.claim(...args); },
    readOperation(...args) { assertAuthority(); return delegate!.readOperation?.(...args) ?? Promise.resolve(null); },
    setPolicy(...args) { assertLive(); return delegate!.setPolicy(...args); },
  };
  function summary(context: FleetContext, destinationAddress: string): GuardianSummary {
    const job = state.get<EnrollmentJob>(jobKey(context.scopeId));
    let mode: GuardianSummary["state"] = recovery ? "recovery-required" : "not-enrolled";
    if (!recovery && authority && !work) {
      try {
        const rows = targets(context);
        const ready = rows.length > 0 && rows.every(target => {
          const record = state.get<EnrollmentRecord>(recordKey(context.scopeId, target.computer.id));
          return record?.version === 1 && record.authorityId === authority!.descriptor.authorityId
            && !!record.releaseProof && record.targetHash === targetHash(target) && record.destinationAddress === destinationAddress;
        });
        const sync = readSync(context.scopeId);
        if (sync && sync.state !== "settled") {
          if (sync.state === "verified" && sync.destinationAddress === destinationAddress && sync.rosterRevision === context.rosterRevision && ready) {
            state.set(syncKey(context.scopeId), { ...sync, state: "settled" }); mode = "ready";
          } else mode = "sync-required";
        } else if (ready) mode = "ready";
      } catch { /* Changes in approval or identity require an explicit owner sync. */ }
    }
    if (work && !recovery) mode = "enrolling";
    return { required: true, authorityId: authority?.descriptor.authorityId ?? null, state: mode,
      ...(job ? { job: job.state === "running" && !work ? { ...job, state: "interrupted" as const } : job } : {}) };
  }
  function remember(context: FleetContext, target: Target, status: GuardianStatus): void {
    if (status.authorityId !== authority?.descriptor.authorityId || status.pcId !== target.computer.id) throw new TreasuryPreflightError("source-changed");
    const identity = verifiedIdentities.get(target.computer.id);
    if (!identity) throw new TreasuryPreflightError("source-changed");
    state.set(recordKey(context.scopeId, target.computer.id), { version: 1, authorityId: status.authorityId,
      targetHash: targetHash(target), destinationAddress: status.destinationAddress, verifiedAtMs: now(),
      releaseProof: { manifest: Buffer.from(identity.manifest).toString("base64"), signature: Buffer.from(identity.signature).toString("base64") } } satisfies EnrollmentRecord);
  }
  function sudo(run: SshRun, target: Target): SshRun {
    if (target.credential.sudoPassword === undefined) return run;
    const password = target.credential.sudoPassword;
    return (command, settings = {}) => {
      const framed = framedSudoInput(command, settings.input, password);
      return run(framed.command, { ...settings, input: framed.input });
    };
  }
  function startEnrollment(input: { context: FleetContext; configuration: TreasuryConfiguration; claimedSources: string[] }, authorize: () => void,
    stableGuard: () => void): GuardianSummary {
    authorize(); if (closed || work || recovery) throw new TreasuryPreflightError("source-changed");
    const context = structuredClone(input.context), configuration = structuredClone(input.configuration), selected = targets(context);
    const claimedSources = [...new Set(input.claimedSources)];
    if (claimedSources.length > 10_000 || !claimedSources.every(isMetadataAddress)) throw new TreasuryPreflightError("source-changed");
    if (!selected.length) throw new TreasuryPreflightError("source-changed");
    const owner = load(true)!;
    const identities = new Map(selected.map(target => [target.computer.id, targetHash(target)]));
    const guard = () => {
      if (closed) throw new TreasuryPreflightError("source-changed"); stableGuard();
      const current = targets(context);
      if (current.length !== selected.length || current.some(target => identities.get(target.computer.id) !== targetHash(target))) throw new TreasuryPreflightError("source-changed");
    };
    const job: EnrollmentJob = { version: 1, id: randomUUID(), state: "running", total: selected.length, completed: 0, startedAtMs: now(), updatedAtMs: now() };
    state.set(jobKey(context.scopeId), job);
    state.set(syncKey(context.scopeId), { version: 1, state: "pending", destinationAddress: configuration.destinationAddress, rosterRevision: context.rosterRevision } satisfies PolicySync);
    // Provisioning installs only a public owner pin and preserved spent history.
    // This approved batch may finish after Wallet locks, but never spends funds.
    const task = async () => {
      try {
        guard();
        const release = await download({ cacheDirectory: options.cacheDirectory, trustPublicKey: options.trustPublicKey, build: options.build, signal: abort.signal });
        currentIdentity = Promise.resolve(release);
        for (const target of selected) {
          guard();
          let status: GuardianStatus;
          // Existing guardians are read and owner-synchronized. Only the
          // provisioner can establish confirmed absence and create a new pin.
          try {
            status = await delegate!.status(target);
            guard();
            if (status.transferConsumed && !configuration.pilotConsumed) throw new TreasuryPreflightError("source-changed");
            const prior = state.get<EnrollmentRecord>(recordKey(context.scopeId, target.computer.id));
            const matches = prior?.targetHash === targetHash(target) && status.destinationAddress === configuration.destinationAddress
              && (!configuration.pilotConsumed || status.transferConsumed) && claimedSources.every(address => status.claimedSources.includes(address))
              && status.sources.length === target.sources.length && target.sources.every(source => status.sources.some(row => row.address === source.address && row.containerId === source.binding.nodeContainerId));
            if (!matches) status = await delegate!.setPolicy(target, configuration.destinationAddress, guard, { sources: target.sources,
              claimedSources, transferConsumed: configuration.pilotConsumed });
          } catch (error) {
            guard();
            const enrollment = { ...owner.descriptor, pcId: target.computer.id, policyEpoch: 1, destinationAddress: configuration.destinationAddress,
              transferConsumed: configuration.pilotConsumed, claimedSources, sources: target.sources };
            status = await connect(target.computer, target.credential, run => provision(sudo(run, target), { release, enrollment }, guard));
            verifiedIdentities.set(target.computer.id, release);
          }
          guard();
          if (status.transferConsumed && !configuration.pilotConsumed) throw new TreasuryPreflightError("source-changed");
          remember(context, target, status);
          job.completed++; job.updatedAtMs = now(); state.set(jobKey(context.scopeId), job);
        }
        job.state = "complete";
        state.set(syncKey(context.scopeId), { version: 1, state: "verified", destinationAddress: configuration.destinationAddress, rosterRevision: context.rosterRevision } satisfies PolicySync);
      } catch { job.state = "interrupted"; }
      finally { job.updatedAtMs = now(); state.set(jobKey(context.scopeId), job); }
    };
    work = task().finally(() => { work = undefined; });
    return summary(context, configuration.destinationAddress);
  }
  async function syncDestination(change: { context: FleetContext; destinationAddress: string }, authorize: () => void): Promise<void> {
    authorize(); if (!authority && !recovery) return;
    assertAuthority();
    // Configuration is an immediate local owner action. Synchronizing 200+
    // source PCs belongs to the separately confirmed, resumable enrollment job,
    // not a 20-second browser request. Money remains fenced by this intent.
    state.set(syncKey(change.context.scopeId), { version: 1, state: "pending", destinationAddress: change.destinationAddress, rosterRevision: change.context.rosterRevision } satisfies PolicySync);
  }
  return { transport, summary, startEnrollment, syncDestination,
    async close(): Promise<void> { closed = true; abort.abort(); await work; authority?.close(); delegate = undefined; } };
}
export type GuardianAdministration = ReturnType<typeof createGuardianAdministration>;
