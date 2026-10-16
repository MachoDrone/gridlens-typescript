import type { DurationView } from "./duration.ts";
import { isMetadataAddress } from "./host-metadata.ts";
import { JOB_DISPLAY_VALIDITY_MS, isJobTimestamp } from "./jobs.ts";
import type { JobRecord } from "./jobs.ts";
import { projectLiveDuration } from "./live-duration.ts";
import type { NodeInfoRecord } from "./node-info.ts";
import { projectNodeState, projectNodeStateDisplay } from "./node-state.ts";
import type { NodeStateView } from "./node-state.ts";
import { isQueueRecord, QUEUE_DISPLAY_VALIDITY_MS } from "./queue.ts";
import type { QueueRecord } from "./queue.ts";

export interface LiveActivityInput {
  address: string;
  state?: NodeInfoRecord | undefined;
  job?: JobRecord | undefined;
  queue?: QueueRecord | undefined;
  marketAddress?: string | null | undefined;
  nowMs: number;
  stateError?: string | null | undefined;
  jobsError?: string | null | undefined;
  queueError?: string | null | undefined;
}

export interface LiveActivityView {
  state: NodeStateView;
  duration: DurationView;
  /** Exact selected timing evidence, including retained replacement identity. */
  durationJob: JobRecord | undefined;
  /** Raw validated job evidence after supersession; never display-derived State. */
  eligibleJob: JobRecord | undefined;
}

interface Retirement {
  checkedAtMs: number;
  validUntilMs: number | null;
  kind: "queue" | "absence" | "state";
  description: string;
  queue: QueueRecord | null;
  node: NodeStateView | null;
}

interface History {
  displayedState: NodeStateView | null;
  job: JobRecord | undefined;
  lastJobCheck: number;
  lastNodeCheck: number;
  failedJobCheck: number;
  failedNodeCheck: number;
  jobError: string | null;
  retirement: Retirement | null;
  stateRetiredAt: number;
  /** Running proof invalidates older absence even after that proof expires. */
  runningCheckedAt: number;
}

function sameJob(record: JobRecord | undefined, address: string): record is JobRecord {
  return record !== undefined && record.address === address &&
    (record.job === null || isMetadataAddress(record.job.address) && record.job.node === address);
}

function checked(value: number | null | undefined, nowMs: number): value is number {
  return isJobTimestamp(value) && value <= nowMs;
}

function retainedState(view: NodeStateView, reason: string): NodeStateView {
  return { ...view, current: null, retained: true, animated: view.artwork !== null,
    description: `Retained State estimate: ${view.reported}. Current activity is unconfirmed. ${reason}\n${view.description}` };
}

function retiredDuration(retirement: Retirement, nowMs: number, queueCurrent: boolean, node: NodeStateView,
  runningCheckedAt: number, absenceCurrent: boolean): DurationView {
  const queue = retirement.queue;
  const contradicted = runningCheckedAt > retirement.checkedAtMs ||
    retirement.kind !== "absence" && runningCheckedAt === retirement.checkedAtMs;
  const nodeQueued = retirement.node?.reported === "QUEUED" && node.current === "QUEUED" &&
    node.checkedAtMs === retirement.checkedAtMs;
  if (!contradicted && (nodeQueued || queue && queueCurrent && isJobTimestamp(queue.validUntilMs) && nowMs < queue.validUntilMs)) return {
    kind: "queue", text: "⟵", elapsedSeconds: null, limitSeconds: null, percent: null,
    freshness: "current", tone: "current", animated: false, validUntilMs: retirement.validUntilMs,
    description: `${retirement.description} See the Queued column on the left.`,
  };
  const current = retirement.kind === "absence" && absenceCurrent && !contradicted;
  return { kind: "unknown", text: current ? "—" : "Populating..", elapsedSeconds: null, limitSeconds: null, percent: null,
    freshness: current ? "current" : "unknown", tone: "unbounded", animated: false, validUntilMs: retirement.validUntilMs,
    description: `${current ? "No running assignment." : "Duration pending: current assignment timing is unconfirmed."} The previous counter was superseded at ${new Date(retirement.checkedAtMs).toISOString()}. ${retirement.description}${contradicted
      ? ` Conflicting running evidence was checked at ${new Date(runningCheckedAt).toISOString()}; it supplies no new job timing.`
      : current ? "" : " The original supersession remains valid, but no current absence or queued activity is established."}` };
}

/**
 * Page-memory presentation history only. No reads, timers, persistence, provider
 * scheduling or Queue inference use the projected State. Source times never move
 * forward because the page renders, ticks, reconnects or receives cached replies.
 */
export class LiveActivityDisplay {
  private readonly histories = new Map<string, History>();
  private readonly maxEntries: number;

  constructor(maxEntries = 4096) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new RangeError("Display history bound must be positive");
    this.maxEntries = maxEntries;
  }

  clear(): void { this.histories.clear(); }

  /** Invoke when the supplied roster changes, not when a view hides or refreshes. */
  prune(addresses: readonly string[]): void {
    const keep = new Set(addresses);
    for (const address of this.histories.keys()) if (!keep.has(address)) this.histories.delete(address);
  }

  get size(): number { return this.histories.size; }

  project(input: LiveActivityInput): LiveActivityView {
    const { address, nowMs } = input;
    if (!isJobTimestamp(nowMs)) throw new RangeError("Clock must be non-negative integer milliseconds in the Date range");
    if (!isMetadataAddress(address)) return { state: projectNodeStateDisplay(undefined, nowMs),
      duration: projectLiveDuration(undefined, address, nowMs), durationJob: undefined, eligibleJob: undefined };
    const history = this.histories.get(address) ?? {
      displayedState: null, job: undefined, lastJobCheck: -1, lastNodeCheck: -1,
      failedJobCheck: -1, failedNodeCheck: -1, jobError: null, retirement: null, stateRetiredAt: -1, runningCheckedAt: -1,
    };
    // Bounded least-recently-used history; active rosters also prune explicitly.
    this.histories.delete(address);
    this.histories.set(address, history);
    if (this.histories.size > this.maxEntries) this.histories.delete(this.histories.keys().next().value!);

    const nodeRecord = input.state?.address === address ? input.state : undefined;
    let node = projectNodeStateDisplay(nodeRecord, nowMs, input.stateError ?? null);
    const jobRecord = sameJob(input.job, address) ? input.job : undefined;
    const jobError = input.jobsError ?? jobRecord?.error ?? null;
    if (jobError !== null || jobRecord?.retained) {
      history.failedJobCheck = Math.max(history.failedJobCheck, history.lastJobCheck,
        checked(jobRecord?.checkedAtMs, nowMs) ? jobRecord.checkedAtMs : -1);
      history.jobError = jobError ?? "The last job check was retained after an unavailable refresh.";
    }
    if (input.stateError != null || nodeRecord?.error != null || nodeRecord?.retained || nodeRecord?.activity?.error != null) {
      history.failedNodeCheck = Math.max(history.failedNodeCheck, history.lastNodeCheck,
        node.checkedAtMs ?? -1);
    }
    if (node.checkedAtMs !== null && node.checkedAtMs <= history.failedNodeCheck && node.current !== null) {
      node = retainedState(node, "A later refresh failed; a cached response cannot renew its original confirmation.");
    }
    if (node.checkedAtMs !== null && node.checkedAtMs < history.lastNodeCheck) {
      node = projectNodeStateDisplay(undefined, nowMs);
    }

    const retire = (retirement: Retirement): void => {
      history.stateRetiredAt = Math.max(history.stateRetiredAt, retirement.checkedAtMs);
      if (history.retirement === null || retirement.checkedAtMs > history.retirement.checkedAtMs ||
          retirement.checkedAtMs === history.retirement.checkedAtMs && retirement.kind === "queue") history.retirement = retirement;
    };

    // Successful contrary evidence keeps its original supersession time even
    // after it expires. Errors, missing membership and raw OTHER prove nothing.
    const nodeProofAt = Math.max(nodeRecord?.fetchedAtMs ?? -1, node.checkedAtMs ?? -1);
    const nodeProofValid = nodeRecord !== undefined && isJobTimestamp(nodeProofAt) && nodeProofAt <= nowMs &&
      projectNodeState(nodeRecord, nodeProofAt).current !== null;
    if (node.reported === "RUNNING_JOB" && node.checkedAtMs !== null && nodeRecord && !nodeRecord.retained &&
        nodeRecord.error === null && input.stateError == null && nodeRecord.activity?.error == null &&
        nodeProofValid && node.checkedAtMs > history.failedNodeCheck) {
      history.runningCheckedAt = Math.max(history.runningCheckedAt, node.checkedAtMs);
    }
    if (node.reported !== null && node.checkedAtMs !== null && nodeRecord && !nodeRecord.retained &&
        nodeRecord.error === null && input.stateError == null && nodeRecord.activity?.error == null &&
        nodeProofValid && node.checkedAtMs > history.failedNodeCheck && node.reported !== "RUNNING_JOB") {
      history.stateRetiredAt = Math.max(history.stateRetiredAt, node.checkedAtMs);
      // A health check or restart can overlap the indexed assignment. It vetoes
      // job-backed State, but only positive queue/completion/replacement retires
      // the independent Duration clock.
      if (node.reported === "QUEUED") retire({ checkedAtMs: node.checkedAtMs, validUntilMs: node.validUntilMs, kind: "state", queue: null, node,
        description: `Node State confirmed QUEUED at ${new Date(node.checkedAtMs).toISOString()}. No ordered queue rank is established by Node State.` });
    }
    const queue = input.queue;
    const queueValid = queue !== undefined && isQueueRecord(queue) && queue.address === address &&
      isMetadataAddress(input.marketAddress) && queue.marketAddress === input.marketAddress &&
      queue.position !== null && checked(queue.checkedAtMs, nowMs) && isJobTimestamp(queue.validUntilMs) &&
      queue.validUntilMs > queue.checkedAtMs && queue.validUntilMs <= queue.checkedAtMs + QUEUE_DISPLAY_VALIDITY_MS &&
      (queue.sourceUpdatedAtMs === null || queue.sourceUpdatedAtMs <= queue.checkedAtMs) &&
      !queue.retained && queue.error === null && input.queueError == null;
    if (queueValid) retire({ checkedAtMs: queue.checkedAtMs!, validUntilMs: queue.validUntilMs, kind: "queue", queue: { ...queue }, node: null,
      description: `Confirmed queued at position ${queue.position}/${queue.total}. API checked at ${new Date(queue.checkedAtMs!).toISOString()}; local deadline ${new Date(queue.validUntilMs!).toISOString()}.` });

    const jobView = projectLiveDuration(jobRecord, address, nowMs, jobError);
    const jobChecked = jobRecord?.checkedAtMs;
    const successful = jobRecord !== undefined && checked(jobChecked, nowMs) &&
      !jobRecord.retained && jobError === null && jobChecked > history.failedJobCheck;
    // The provider preserves a successful absence timestamp when the following
    // replacement lookup is deferred or fails. That still retires the previous
    // job, but a failed or expired check cannot establish current absence.
    const confirmedAbsence = jobRecord?.job === null && checked(jobChecked, nowMs) && !jobRecord.retained;
    if ((successful || confirmedAbsence) && jobChecked! >= history.lastJobCheck) {
      const timing = jobRecord.job;
      const terminal = timing === null ||
        (["QUEUED", "COMPLETED", "STOPPED"].includes(timing.state) ||
          typeof timing.timeEnd === "number" && timing.timeEnd > 0 &&
          typeof timing.timeStart === "number" && timing.timeStart > 0 && timing.timeEnd >= timing.timeStart &&
          isJobTimestamp(timing.timeEnd * 1000) && timing.timeEnd * 1000 <= jobChecked!);
      if (terminal) {
        history.lastJobCheck = jobChecked!;
        const validUntilMs = checked(jobRecord.validUntilMs, jobChecked! + JOB_DISPLAY_VALIDITY_MS) &&
          jobRecord.validUntilMs > jobChecked! ? jobRecord.validUntilMs : null;
        retire({ checkedAtMs: jobChecked!, validUntilMs, kind: "absence", queue: null, node: null,
          description: `${timing ? `Job ${timing.address} was confirmed ${timing.state === "RUNNING" ? "ended" : timing.state}.` : "A successful assignment check confirmed no running job."} Original check ${new Date(jobChecked!).toISOString()}; local deadline ${validUntilMs === null ? "unavailable" : new Date(validUntilMs).toISOString()}.${jobError ? ` Replacement lookup: ${jobError}` : ""}` });
      }
    }
    // Invalid or mismatched replacements cannot destroy validated timing. A new
    // successful running check must be strictly newer than a retirement marker.
    const validRunning = jobRecord?.job?.state === "RUNNING" && jobRecord.job.timeEnd === 0 && jobView.kind === "duration";
    const afterRetirement = checked(jobChecked, nowMs) && jobChecked > (history.retirement?.checkedAtMs ?? -1);
    if (validRunning && afterRetirement && (successful && jobChecked >= history.lastJobCheck ||
        history.job === undefined && history.lastJobCheck < 0)) {
      if (history.displayedState?.source === "job" && history.displayedState.jobAddress !== jobRecord.job!.address) {
        history.displayedState = null;
      }
      history.job = { ...jobRecord, job: { ...jobRecord.job! } };
      history.lastJobCheck = jobChecked;
      if (successful) history.jobError = null;
    }
    if (history.job && history.job.checkedAtMs! <= (history.retirement?.checkedAtMs ?? -1)) history.job = undefined;
    if (history.displayedState?.reported === "RUNNING_JOB" &&
        history.displayedState.checkedAtMs! <= history.stateRetiredAt) history.displayedState = null;

    let eligibleJob = history.job;
    if (eligibleJob) {
      const sameIncoming = validRunning && jobChecked === eligibleJob.checkedAtMs && jobRecord?.job?.address === eligibleJob.job?.address;
      const retained = !sameIncoming || eligibleJob.checkedAtMs! <= history.failedJobCheck || jobError !== null || jobRecord?.retained === true;
      eligibleJob = retained ? { ...eligibleJob, retained: true,
        error: jobError ?? history.jobError ?? "Retained from the last verified running assignment." } : eligibleJob;
    }
    const absenceCurrent = history.retirement !== null && isJobTimestamp(history.retirement.validUntilMs) &&
      nowMs < history.retirement.validUntilMs && history.retirement.checkedAtMs > history.failedJobCheck && jobError === null;
    const duration = eligibleJob ? projectLiveDuration(eligibleJob, address, nowMs, jobError)
      : history.retirement ? retiredDuration(history.retirement, nowMs,
        queueValid && queue.checkedAtMs === history.retirement.checkedAtMs &&
          (node.current === null || node.current === "QUEUED" || node.checkedAtMs! < queue.checkedAtMs!), node,
        history.runningCheckedAt, absenceCurrent)
        : projectLiveDuration(jobRecord, address, nowMs, jobError);

    let state: NodeStateView;
    if (node.current !== null) {
      state = node;
      history.lastNodeCheck = Math.max(history.lastNodeCheck, node.checkedAtMs!);
    } else if (eligibleJob && duration.kind === "duration" && duration.freshness === "current" &&
        eligibleJob.checkedAtMs! > history.stateRetiredAt) {
      const job = eligibleJob.job!;
      state = { reported: "RUNNING_JOB", current: "RUNNING_JOB", short: "R", artwork: "running", animated: true,
        retained: false, source: "job", checkedAtMs: eligibleJob.checkedAtMs, validUntilMs: eligibleJob.validUntilMs,
        jobAddress: job.address,
        description: `Running State established by a verified job assignment for the same host. Original confirmation ${new Date(eligibleJob.checkedAtMs!).toISOString()}. Job-backed State uses this job check's original 180-second deadline; a retained ticking Duration does not establish fresh activity.\n\n${duration.description}` };
    } else if (history.displayedState) {
      const error = input.stateError ?? nodeRecord?.error ?? nodeRecord?.activity?.error ??
        (history.displayedState.source === "job" ? jobError : null);
      state = retainedState(history.displayedState, `The last useful displayed State is retained without extending its source deadline.${error ? ` Latest refresh: ${error}` : ""}`);
    } else if (node.reported !== null && !(node.reported === "RUNNING_JOB" &&
        node.checkedAtMs! <= history.stateRetiredAt)) {
      state = retainedState(node, "The original supporting read is unavailable or expired.");
      history.lastNodeCheck = Math.max(history.lastNodeCheck, node.checkedAtMs!);
    } else {
      state = projectNodeStateDisplay(nodeRecord, nowMs, input.stateError ?? null);
      if (state.reported !== null) state = projectNodeStateDisplay(undefined, nowMs);
    }
    // Keep a single source description, avoiding recursive history prose as the
    // local clock ticks or a table sort projects the same retained row again.
    if (state.reported !== null && (state.current !== null || history.displayedState === null)) history.displayedState = { ...state };
    // Queue's running arrow is activity evidence, unlike Duration's independent
    // retained clock. Remember raw contrary proof there after its display expires.
    const queueJob = eligibleJob && eligibleJob.checkedAtMs! > history.stateRetiredAt ? eligibleJob : undefined;
    return { state, duration, durationJob: eligibleJob, eligibleJob: queueJob };
  }
}
