import { randomUUID } from "node:crypto";
import type { UpdateBuild, UpdateOperation, UpdatePhase, UpdateStatus } from "../contracts/updates.ts";
import { isUpdateRequestKey, parseUpdateBuild, parseUpdateStatus, updateActive } from "../contracts/updates.ts";
import { SharedHttpError } from "../backend/ipc.ts";
import { discoverUpdate, downloadUpdate, parseVerifiedCandidate, pruneUpdateDownloads, UpdateError } from "./release.ts";
import type { UpdatePlatform, VerifiedCandidate } from "./release.ts";
import type { UpdateStateStore } from "./state.ts";

export interface UpdateRuntime {
  current(): Promise<UpdateBuild>;
  prepare(candidate: VerifiedCandidate, archivePath: string, job: UpdateOperation, signal?: AbortSignal): Promise<void>;
  apply(candidate: VerifiedCandidate, job: UpdateOperation, signal?: AbortSignal): Promise<void>;
  verify(candidate: VerifiedCandidate, job: UpdateOperation, signal?: AbortSignal): Promise<void>;
  rollback(job: UpdateOperation, signal?: AbortSignal): Promise<UpdateBuild>;
  replaceWorker(candidate: VerifiedCandidate, job: UpdateOperation, signal?: AbortSignal): Promise<void>;
  release(): Promise<void>;
}
export type RuntimeAdapter = UpdateRuntime;
interface SavedJob { candidate: VerifiedCandidate; idempotencyKey: string }
interface Receipt { key: string; candidateId: string; operation: UpdateOperation }
interface Journal {
  schema: 1; status: UpdateStatus; highestSequence: number; highestId: string | null;
  attemptedAtMs: number | null; retryAtMs: number | null; failures: number;
  candidate: VerifiedCandidate | null; job: SavedJob | null; receipts: Receipt[];
}
export interface UpdateEngine {
  status(): UpdateStatus;
  check(): UpdateStatus;
  start(candidateId: string, idempotencyKey: string): UpdateStatus;
  dispatch(body: Record<string, unknown>): Promise<UpdateStatus>;
  idle(): Promise<void>;
  close(): Promise<void>;
}
const MINIMUM_CHECK = 60_000, AUTOMATIC_CHECK = 15 * 60_000;
const safeTime = (value: unknown): value is number | null => value === null || Number.isSafeInteger(value) && Number(value) >= 0;
const candidateValid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const publicCandidate = ({ version, sequence, buildId, id, sizeBytes }: VerifiedCandidate) => ({ version, sequence, buildId, id, sizeBytes });
const buildOf = ({ version, sequence, buildId }: UpdateBuild): UpdateBuild => ({ version, sequence, buildId });
const safeMessage = (error: unknown, fallback: string): string => error instanceof UpdateError && error.message.length <= 500 && !/[\u0000-\u001f\u007f]/.test(error.message) ? error.message : fallback;
const wait = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  signal.throwIfAborted();
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
  signal.addEventListener("abort", abort, { once: true });
});
function savedJournal(value: unknown): Journal {
  if (!value || typeof value !== "object") throw new Error("Invalid updater journal.");
  const item = value as Journal;
  if (item.schema !== 1 || !Number.isSafeInteger(item.highestSequence) || item.highestSequence < 0
    || item.highestId !== null && !candidateValid(item.highestId) || !safeTime(item.attemptedAtMs) || !safeTime(item.retryAtMs)
    || !Number.isSafeInteger(item.failures) || item.failures < 0 || item.failures > 20 || !Array.isArray(item.receipts) || item.receipts.length > 32) throw new Error("Unsupported updater journal.");
  const status = parseUpdateStatus({ ...item.status, checking: false }), candidate = item.candidate === null ? null : parseVerifiedCandidate(item.candidate);
  const job = item.job === null ? null : { candidate: parseVerifiedCandidate(item.job?.candidate), idempotencyKey: item.job?.idempotencyKey };
  if (job && !isUpdateRequestKey(job.idempotencyKey) || updateActive(status.operation) && !job
    || job && status.operation && JSON.stringify(buildOf(job.candidate)) !== JSON.stringify(status.operation.target)
    || candidate && status.candidate && candidate.id !== status.candidate.id) throw new Error("Inconsistent updater journal.");
  const receipts = item.receipts.map(row => {
    if (!isUpdateRequestKey(row?.key) || !candidateValid(row?.candidateId)) throw new Error("Invalid update receipt.");
    const parsed = parseUpdateStatus({ ...status, operation: row.operation }).operation;
    if (!parsed) throw new Error("Invalid update receipt.");
    return { key: row.key, candidateId: row.candidateId, operation: parsed };
  });
  return { schema: 1, status, highestSequence: item.highestSequence, highestId: item.highestId,
    attemptedAtMs: item.attemptedAtMs, retryAtMs: item.retryAtMs, failures: item.failures, candidate, job, receipts };
}
export async function createUpdateEngine({ store, runtime, directory, platform, publicKey, now = Date.now, random = Math.random,
  discover, download, automatic = true }: {
  store: UpdateStateStore; runtime: UpdateRuntime; directory: string; platform: UpdatePlatform; publicKey: string;
  now?: () => number; random?: () => number; automatic?: boolean;
  discover?: (signal: AbortSignal) => Promise<VerifiedCandidate>;
  download?: (candidate: VerifiedCandidate, signal: AbortSignal, progress: (bytes: number) => void) => Promise<string>;
}): Promise<UpdateEngine> {
  const current = parseUpdateBuild(await runtime.current()), saved = store.read();
  let journal: Journal = saved === undefined ? { schema: 1,
    status: { version: 1, supported: true, canUpdate: true, checking: false, current, candidate: null, checkedAtMs: null, nextCheckAtMs: null, checkError: null, operation: null },
    highestSequence: current.sequence, highestId: null, attemptedAtMs: null, retryAtMs: null, failures: 0, candidate: null, job: null, receipts: [],
  } : savedJournal(saved);
  let stopping = false, poisoned = false, pendingCheck: Promise<void> | undefined, pendingJob: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const lifecycle = new AbortController();
  const clock = (): number => Math.max(0, Math.floor(now()));
  const persist = (value: Journal): void => {
    if (poisoned) throw new Error("Updater state requires recovery.");
    try { store.write(value); journal = value; }
    catch (error) { poisoned = true; lifecycle.abort(); throw error; }
  };
  persist({ ...journal, status: { ...journal.status, current, candidate: journal.status.candidate && journal.status.candidate.sequence > current.sequence ? journal.status.candidate : null }, highestSequence: Math.max(journal.highestSequence, current.sequence),
    highestId: current.sequence > journal.highestSequence ? null : journal.highestId });
  const status = (): UpdateStatus => { if (poisoned) throw new SharedHttpError(503); return { ...structuredClone(journal.status), checking: pendingCheck !== undefined }; };
  const discoverCandidate = discover ?? (signal => discoverUpdate({ platform, publicKey, signal, now }));
  const downloadCandidate = download ?? ((candidate, signal, onProgress) => downloadUpdate(candidate, directory, { signal, now, onProgress }));
  const setOperation = (patch: Partial<UpdateOperation>): void => {
    const old = journal.status.operation; if (!old) throw new Error("Missing updater operation.");
    const operation: UpdateOperation = { ...old, ...patch, revision: old.revision + 1, updatedAtMs: Math.max(old.updatedAtMs, clock()) };
    const receipts = journal.receipts.map(receipt => receipt.operation.id === operation.id ? { ...receipt, operation } : receipt);
    persist({ ...journal, status: { ...journal.status, operation }, receipts });
  };
  const phase = (value: UpdatePhase): void => setOperation({ phase: value });
  function schedule(): void {
    if (timer) clearTimeout(timer);
    if (!automatic || stopping || poisoned || updateActive(journal.status.operation)) return;
    const delay = Math.min(2_147_483_647, Math.max(0, (journal.status.nextCheckAtMs ?? 0) - clock()));
    timer = setTimeout(() => { timer = undefined; queueCheck(); }, delay); timer.unref();
  }
  async function refresh(): Promise<VerifiedCandidate> {
    const candidate = parseVerifiedCandidate(await discoverCandidate(lifecycle.signal));
    if (candidate.release.platform !== platform || candidate.sequence < journal.highestSequence
      || candidate.sequence === journal.highestSequence && journal.highestId !== null && candidate.id !== journal.highestId)
      throw new UpdateError("The release channel returned an older or conflicting update. The installed version was retained.");
    const at = clock(), current = journal.status.current!;
    if (candidate.sequence === current.sequence && candidate.buildId !== current.buildId) throw new UpdateError("The release channel conflicts with the installed build.");
    persist({ ...journal, candidate, highestSequence: candidate.sequence, highestId: candidate.id, failures: 0, retryAtMs: null,
      status: { ...journal.status, candidate: candidate.sequence > current.sequence ? publicCandidate(candidate) : null,
        checkedAtMs: at, nextCheckAtMs: at + AUTOMATIC_CHECK + Math.floor(Math.max(0, Math.min(1, random())) * 60_000), checkError: null } });
    return candidate;
  }
  function checkFailure(error: unknown): void {
    const failures = Math.min(journal.failures + 1, 20), at = clock();
    const deadline = Math.max(at + Math.min(AUTOMATIC_CHECK, MINIMUM_CHECK * 2 ** (failures - 1)), error instanceof UpdateError ? error.retryAtMs ?? 0 : 0);
    persist({ ...journal, failures, retryAtMs: deadline, status: { ...journal.status, nextCheckAtMs: deadline,
      checkError: safeMessage(error, "The release check could not finish. The last verified update information was retained.") } });
  }
  function queueCheck(): UpdateStatus {
    if (stopping) throw new SharedHttpError(503);
    if (pendingCheck || updateActive(journal.status.operation)) return status();
    const at = clock(), eligible = Math.max((journal.attemptedAtMs ?? -MINIMUM_CHECK) + MINIMUM_CHECK, journal.retryAtMs ?? 0);
    if (at < eligible) return status();
    persist({ ...journal, attemptedAtMs: at, status: { ...journal.status, nextCheckAtMs: Math.max(eligible, at + MINIMUM_CHECK), checkError: null } });
    pendingCheck = (async () => {
      try { await refresh(); }
      catch (error) { if (!stopping && !poisoned) checkFailure(error); }
      finally { pendingCheck = undefined; schedule(); }
    })();
    return status();
  }
  function launchJob(): void {
    if (pendingJob || !updateActive(journal.status.operation) || !journal.job) return;
    const work = journal.job, signal = lifecycle.signal;
    pendingJob = (async () => {
      let releaseFailureRecorded = false;
      try {
        let job = journal.status.operation!;
        if (job.phase === "rolling-back") {
          const result = parseUpdateBuild(await runtime.rollback(job, signal));
          persist({ ...journal, status: { ...journal.status, current: result } });
          setOperation({ phase: "rolled-back", result }); return;
        }
        let archive = "";
        if (["downloading", "verifying"].includes(job.phase)) {
          // A recent exact signed discovery can be shared with Start. Older
          // evidence revalidates through the same reservation/cooldown lane,
          // so repeated starts cannot create unlimited release-check traffic.
          if (pendingCheck) await pendingCheck;
          if (journal.retryAtMs !== null && clock() < journal.retryAtMs) throw new UpdateError("Release checks are waiting for the download service.", journal.retryAtMs);
          let available = journal.candidate;
          const checked = journal.status.checkedAtMs;
          if (!available || available.id !== work.candidate.id || checked === null || clock() < checked || clock() - checked >= MINIMUM_CHECK) {
            const eligible = Math.max((journal.attemptedAtMs ?? -MINIMUM_CHECK) + MINIMUM_CHECK, journal.retryAtMs ?? 0);
            if (clock() < eligible) await wait(eligible - clock(), signal);
            persist({ ...journal, attemptedAtMs: clock() });
            try { available = await refresh(); }
            catch (error) { if (!stopping && !poisoned) { checkFailure(error); releaseFailureRecorded = true; } throw error; }
          }
          if (available.id !== work.candidate.id) throw new UpdateError("The available release changed. Review the new update before installing.");
          let lastProgress = clock(), recordedBytes = job.downloadedBytes;
          archive = await downloadCandidate(work.candidate, signal, bytes => {
            if (stopping || poisoned || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > job.totalBytes) return;
            const at = clock();
            if (bytes === job.totalBytes || at - lastProgress >= 500 || bytes - recordedBytes >= 4 * 1024 * 1024) {
              setOperation({ downloadedBytes: bytes }); lastProgress = at; recordedBytes = bytes;
            }
          });
          phase("verifying"); setOperation({ downloadedBytes: work.candidate.sizeBytes }); phase("preparing");
          job = journal.status.operation!;
        } else {
          // The retained archive is rehashed by the downloader before an
          // interrupted runtime operation can resume. No source URLs are inputs.
          archive = await downloadCandidate(work.candidate, signal, () => {});
        }
        signal.throwIfAborted();
        await runtime.prepare(work.candidate, archive, job, signal);
        if (job.phase === "preparing" || job.phase === "restarting") {
          phase("restarting"); await runtime.apply(work.candidate, journal.status.operation!, signal);
          phase("verifying-service");
        }
        await runtime.verify(work.candidate, journal.status.operation!, signal);
        phase("updating-updater");
        await runtime.replaceWorker(work.candidate, journal.status.operation!, signal);
        signal.throwIfAborted();
        await runtime.verify(work.candidate, journal.status.operation!, signal);
        const result = parseUpdateBuild(await runtime.current());
        if (JSON.stringify(result) !== JSON.stringify(buildOf(work.candidate))) throw new UpdateError("The running installation did not match the verified update.");
        persist({ ...journal, status: { ...journal.status, current: result, candidate: null } });
        setOperation({ phase: "complete", result, error: null });
      } catch (error) {
        if (stopping || poisoned || signal.aborted) return;
        const failedAt = journal.status.operation!.phase;
        const message = safeMessage(error, `The update could not finish during ${failedAt.replaceAll("-", " ")}.`);
        setOperation({ error: message });
        if (["restarting", "verifying-service", "updating-updater", "rolling-back"].includes(failedAt)) {
          try {
            phase("rolling-back");
            const result = parseUpdateBuild(await runtime.rollback(journal.status.operation!, signal));
            persist({ ...journal, status: { ...journal.status, current: result } });
            setOperation({ phase: "rolled-back", result });
          } catch { if (!stopping && !poisoned && !signal.aborted) setOperation({ phase: "failed", error: `${message} Recovery could not be verified.`.slice(0, 500) }); }
        } else {
          if (!releaseFailureRecorded && error instanceof UpdateError && error.retryAtMs !== undefined) checkFailure(error);
          setOperation({ phase: "failed" });
        }
      } finally {
        await runtime.release().catch(() => {});
        if (!stopping && !poisoned && !updateActive(journal.status.operation)) {
          const previousId = journal.receipts.find(receipt => receipt.operation.target.buildId === journal.status.operation?.previous.buildId)?.candidateId;
          // Archive cleanup cannot erase an operation's original failure.
          await pruneUpdateDownloads(directory, [work.candidate.id, ...(previousId ? [previousId] : [])]).catch(() => {});
        }
        pendingJob = undefined; schedule();
      }
    })();
  }
  const start = (candidateId: string, idempotencyKey: string): UpdateStatus => {
    if (stopping || poisoned) throw new SharedHttpError(503);
    if (!candidateValid(candidateId) || !isUpdateRequestKey(idempotencyKey)) throw new SharedHttpError(400);
    const receipt = journal.receipts.find(row => row.key === idempotencyKey);
    if (receipt) {
      if (receipt.candidateId !== candidateId) throw new SharedHttpError(409);
      return { ...status(), operation: structuredClone(receipt.operation) };
    }
    if (updateActive(journal.status.operation)) {
      if (journal.job?.candidate.id === candidateId) {
        persist({ ...journal, receipts: [...journal.receipts.slice(-31), { key: idempotencyKey, candidateId, operation: journal.status.operation! }] });
        return status();
      }
      throw new SharedHttpError(409);
    }
    if (!journal.candidate || journal.candidate.id !== candidateId || journal.status.candidate?.id !== candidateId) throw new SharedHttpError(409);
    if ((journal.retryAtMs ?? 0) > clock()) throw new SharedHttpError(429);
    const at = clock(), candidate = journal.candidate;
    const operation: UpdateOperation = { id: randomUUID(), revision: 1, target: buildOf(candidate), previous: journal.status.current!, phase: "downloading",
      startedAtMs: at, updatedAtMs: at, downloadedBytes: 0, totalBytes: candidate.sizeBytes, error: null, result: null };
    persist({ ...journal, status: { ...journal.status, operation }, job: { candidate, idempotencyKey },
      receipts: [...journal.receipts.slice(-31), { key: idempotencyKey, candidateId, operation }] });
    launchJob(); return status();
  };
  const engine: UpdateEngine = {
    status, check: queueCheck, start,
    async dispatch(body) {
      const operation = body.operation, allowed = operation === "start" ? ["operation", "candidateId", "idempotencyKey"] : ["operation"];
      if (Object.keys(body).some(key => !allowed.includes(key))) throw new SharedHttpError(400);
      if (operation === "status") return status();
      if (operation === "check") return queueCheck();
      if (operation === "start" && typeof body.candidateId === "string" && typeof body.idempotencyKey === "string") return start(body.candidateId, body.idempotencyKey);
      throw new SharedHttpError(400);
    },
    async idle() { while (pendingCheck || pendingJob) await Promise.all([pendingCheck, pendingJob]); },
    async close() {
      if (stopping) return; stopping = true;
      if (timer) clearTimeout(timer); lifecycle.abort(new Error("Updater stopping."));
      await Promise.allSettled([pendingCheck, pendingJob]); await runtime.release().catch(() => {}); store.close();
    },
  };
  if (updateActive(journal.status.operation)) launchJob(); else schedule();
  return engine;
}
