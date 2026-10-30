/** Transactional application of an already verified modern release. */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { rootCertificates } from "node:tls";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { Coordinator } from "../installer/coordinator.ts";
import { validateInstallation } from "../installer/config.ts";
import type { InstallationConfig } from "../installer/config.ts";
import { checked, inspectOwned, localDockerRunner, resourceName, PRODUCT, PRODUCT_LABEL, labels, restrictions, DockerCommandError } from "../installer/docker.ts";
import type { DockerRunner } from "../installer/docker.ts";
import { ensureVpnWeb, readVpnWebEndpoint, validateVpnWebRecovery } from "../installer/vpn-web.ts";
import type { VpnWebEndpoint } from "../installer/vpn-web.ts";
import type { ModernRelease } from "../installer/release.ts";
import { InstallerError } from "../installer/release.ts";
import { parseUpdateBuild } from "../contracts/updates.ts";
import type { UpdateBuild, UpdateOperation } from "../contracts/updates.ts";
import { ownerCall } from "../backend/ipc.ts";
import { acquireMaintenanceLock, ensureUpdater, launchWorkerReplacement, validateUpdater } from "./deployment.ts";
import { parseVerifiedCandidate, UpdateError } from "./release.ts";
import type { VerifiedCandidate } from "./release.ts";
import type { UpdateRuntime } from "./engine.ts";

interface Transaction {
  schema: 1; operationId: string; candidate: VerifiedCandidate; previous: InstallationConfig;
  previousWeb: (VpnWebEndpoint & { version: string; sequence: number }) | null;
  previousWorkerImage: string; serverId: string; rollback: boolean;
  failure?: string;
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const buildOf = (config: InstallationConfig): UpdateBuild => ({ version: config.active.version, sequence: config.active.sequence, buildId: `${config.active.sequence}:${config.active.version}` });
const sameBuild = (a: UpdateBuild, b: UpdateBuild): boolean => a.version === b.version && a.sequence === b.sequence && a.buildId === b.buildId;
function runtimeFailure(error: unknown): string {
  if (error instanceof DockerCommandError) return `Docker ${error.operation} ${error.kind === "timeout" ? "timed out" : "failed"}${error.exitCode === null ? "" : ` (exit ${error.exitCode})`}. The saved recovery pair was retained.`;
  if ((error instanceof UpdateError || error instanceof InstallerError) && error.message.length <= 400 && !/[\u0000-\u001f\u007f]/.test(error.message)) return error.message;
  return "The runtime operation failed. Its saved recovery record was retained.";
}
function saveTransaction(path: string, value: Transaction): void {
  const temporary = `${path}.${randomBytes(8).toString("hex")}`, fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const dir = openSync(resolve(path, ".."), "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
}
function readTransaction(path: string, instance: string): Transaction | undefined {
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path); if (!stat.isFile() || stat.size > 128 * 1024) throw new UpdateError("The saved update recovery record is invalid.");
  const item = JSON.parse(readFileSync(path, "utf8")) as Transaction;
  if (item.schema !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(item.operationId) || typeof item.rollback !== "boolean"
    || !/^sha256:[a-f0-9]{64}$/.test(item.previousWorkerImage) || typeof item.serverId !== "string" || !item.serverId || item.serverId.length > 256)
    throw new UpdateError("The saved update recovery record is invalid.");
  if (item.failure !== undefined && (typeof item.failure !== "string" || item.failure.length > 400 || /[\u0000-\u001f\u007f]/.test(item.failure)))
    throw new UpdateError("The saved update failure record is invalid.");
  item.previous = validateInstallation(item.previous); item.candidate = parseVerifiedCandidate(item.candidate);
  if (item.previous.instance !== instance) throw new UpdateError("The saved update belongs to another installation.");
  if (item.previousWeb !== null) {
    const web = item.previousWeb, origin = new URL(web.origin);
    if (origin.protocol !== "http:" || origin.hostname !== new URL(item.previous.origin).hostname || Number(origin.port) !== web.port
      || !Number.isInteger(web.port) || web.port < 1024 || web.port > 65535 || !/^sha256:[a-f0-9]{64}$/.test(web.imageId)
      || !Number.isSafeInteger(web.sequence) || web.sequence < 1 || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(web.version))
      throw new UpdateError("The saved browser recovery endpoint is invalid.");
  }
  return item;
}
function releaseFor(image: { imageId: string; version: string; sequence: number }): ModernRelease {
  return { format: "gridlens-modern-release-v1", ...image, platform: process.arch === "arm64" ? "linux-arm64" : "linux-x64", minimumCoordinator: 1,
    runtime: { name: "gridlens-runtime-recovery.tar", bytes: 1, sha256: "0".repeat(64) } };
}
async function archiveVerified(path: string, candidate: VerifiedCandidate, signal?: AbortSignal): Promise<void> {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size !== candidate.release.runtime.bytes) throw new UpdateError("The staged update archive is incomplete.");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { ...(signal ? { signal } : {}) })) hash.update(chunk);
  if (hash.digest("hex") !== candidate.release.runtime.sha256) throw new UpdateError("The staged update archive failed verification.");
}
/** Checks the saved canonical endpoint without skipping certificate validation. */
export async function verifyUpdateEndpoint(origin: string, certificate: string, expected: UpdateBuild, signal?: AbortSignal): Promise<void> {
  const url = new URL("/health/ready", origin), request = url.protocol === "https:" ? httpsRequest : httpRequest;
  await new Promise<void>((resolve, reject) => {
    const req = request(url, { agent: false, timeout: 2000, ...(signal ? { signal } : {}),
      ...(url.protocol === "https:" ? { ca: [...rootCertificates, certificate] } : {}), headers: { Accept: "application/json" } }, response => {
      let text = "";
      response.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); if (Buffer.byteLength(text) > 16_384) req.destroy(new Error("Readiness response too large.")); });
      response.once("error", reject);
      response.once("end", () => {
        try { const value = JSON.parse(text); if (response.statusCode !== 200 || value.status !== "ready"
          || !sameBuild(parseUpdateBuild(value.build), expected) || !sameBuild(parseUpdateBuild(value.ownerBuild), expected)) throw new Error(); resolve(); }
        catch { reject(new UpdateError("The updated dashboard has not passed its readiness checks.")); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error("Readiness request timed out.")), 4000);
    req.once("close", () => clearTimeout(timer)); req.once("timeout", () => req.destroy(new Error("Readiness request timed out."))); req.once("error", reject); req.end();
  });
}
export interface UpdateRuntimeOptions {
  instance: string; stateDirectory: string; runner?: DockerRunner; configurationPath?: string;
  probe?: typeof verifyUpdateEndpoint; lock?: typeof acquireMaintenanceLock; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}
const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  signal?.throwIfAborted(); const abort = () => { clearTimeout(timer); reject(signal?.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms); signal?.addEventListener("abort", abort, { once: true });
});
export function createUpdateRuntime(options: UpdateRuntimeOptions): UpdateRuntime {
  // Docker loads and SQLite-copy helpers are synchronous CLI operations. Keep
  // them away from the IPC event loop so browser progress remains available.
  if (isMainThread && !options.runner && !options.lock && !options.probe && !options.sleep && !options.configurationPath)
    return threadedRuntime(options.instance, options.stateDirectory);
  const { instance, stateDirectory } = options;
  resourceName(instance, "updater");
  const runner = options.runner ?? localDockerRunner({ allowSudo: false }), coordinator = new Coordinator(runner);
  const configurationPath = options.configurationPath ?? "/config/installation.json", journalPath = join(stateDirectory, "runtime-transaction.json");
  const probe = options.probe ?? verifyUpdateEndpoint, wait = options.sleep ?? sleep, lock = options.lock ?? acquireMaintenanceLock, now = options.now ?? Date.now;
  let unlock: (() => Promise<void>) | undefined;
  const config = (): InstallationConfig => {
    const stat = lstatSync(configurationPath);
    if (!stat.isFile() || stat.size > 64 * 1024) throw new UpdateError("The installed runtime configuration is invalid.");
    const value = validateInstallation(JSON.parse(readFileSync(configurationPath, "utf8")));
    if (value.instance !== instance || !value.updater) throw new UpdateError("Browser updates are not enabled for this installation.");
    return value;
  };
  const worker = (): Record<string, unknown> => {
    const current = inspectOwned(runner, "container", resourceName(instance, "updater"), instance);
    if (!current) throw new UpdateError("The installed updater is unavailable.");
    validateUpdater(instance, current); return current;
  };
  const readiness = (): { build: UpdateBuild; serverId: string } => {
    const value = JSON.parse(checked(runner, ["exec", "-i", resourceName(instance, "owner"), "node", "scripts/shared-control.ts", "json"], JSON.stringify({ operation: "readiness" })));
    if (value.status !== "ready" || typeof value.serverId !== "string" || !value.serverId) throw new UpdateError("The collection owner is not ready.");
    return { build: parseUpdateBuild(value.build), serverId: value.serverId };
  };
  const journal = (job: UpdateOperation): Transaction => {
    const value = readTransaction(journalPath, instance);
    if (!value || value.operationId !== job.id || !sameBuild(value.candidate, job.target)) throw new UpdateError("The update recovery identity does not match this operation.");
    return value;
  };
  const assertTransactionPair = (transaction: Transaction): void => {
    const current = config(), previous = transaction.previous.active;
    const original = current.active.imageId === previous.imageId && current.active.stateVolume === previous.stateVolume;
    const selected = current.active.imageId === transaction.candidate.release.imageId && JSON.stringify(current.previous) === JSON.stringify(previous);
    if ((!original && !selected) || current.origin !== transaction.previous.origin || current.certificateSha256 !== transaction.previous.certificateSha256
      || current.pendingPort !== transaction.previous.pendingPort)
      throw new UpdateError("The installation changed outside this update. Its newer state was retained for review.");
    coordinator.validateManagedRuntime(current);
    validateVpnWebRecovery(runner, current, transaction.previousWeb ? { origin: transaction.previousWeb.origin, port: transaction.previousWeb.port,
      images: [transaction.previousWeb.imageId, transaction.candidate.release.imageId] } : null);
  };
  const release = async (): Promise<void> => { const held = unlock; unlock = undefined; await held?.(); };
  const hold = async (image: string, signal?: AbortSignal): Promise<void> => {
    if (unlock) return;
    const deadline = now() + 300_000;
    for (let attempt = 0; attempt < 300; attempt++) {
      signal?.throwIfAborted();
      try { unlock = await lock(runner, instance, image); signal?.throwIfAborted(); return; }
      catch (error) {
        if (signal?.aborted) { await release(); throw signal.reason; }
        if (now() >= deadline || attempt === 299 || !(error instanceof Error) || !/another installation|lock held/i.test(error.message)) throw error;
        await wait(1000, signal);
      }
    }
  };
  const verify = async (candidate: UpdateBuild, transaction: Transaction, signal?: AbortSignal): Promise<void> => {
    const deadline = now() + 300_000;
    for (let attempt = 0; attempt < 300; attempt++) {
      signal?.throwIfAborted();
      try {
        const current = config(), owner = readiness();
        if (!sameBuild(buildOf(current), candidate) || !sameBuild(owner.build, candidate) || owner.serverId !== transaction.serverId)
          throw new UpdateError("The updated runtime identity has not been verified.");
        coordinator.validateManagedRuntime(current);
        if (coordinator.endpointStatus(current).repairRequired) throw new UpdateError("The saved dashboard endpoint is not ready.");
        const certificate = coordinator.configuration(instance, current.active.imageId);
        if (!certificate) throw new UpdateError("The saved installation is unavailable.");
        // The public trust certificate is read by a bounded helper; no key leaves its volume.
        const ca = checked(runner, ["run", "--rm", "-i", ...labels(instance), ...restrictions, "--network", "none", "--user", "0:0",
          "--cap-add", "DAC_OVERRIDE",
          "--mount", `type=volume,src=${resourceName(instance, "config")},dst=/config,readonly`,
          "--mount", `type=volume,src=${resourceName(instance, "tls")},dst=/tls,readonly`, current.active.imageId, "node", "src/installer/container-init.ts", "certificate"], "{}");
        const remaining = Math.max(1, deadline - now()), timeout = AbortSignal.timeout(remaining);
        const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
        await probe(current.origin, ca, candidate, bounded);
        if (transaction.previousWeb) {
          const web = readVpnWebEndpoint(runner, current);
          if (!web || web.origin !== transaction.previousWeb.origin || web.imageId !== current.active.imageId) throw new UpdateError("The browser gateway has not reached the expected release.");
          await probe(web.origin, ca, candidate, bounded);
        }
        return;
      } catch (error) { if (signal?.aborted) throw signal.reason; if (now() >= deadline || attempt === 299) throw error; await wait(1000, signal); }
    }
  };
  return {
    async current() { return buildOf(config()); },
    async prepare(candidate, archivePath, job, signal) {
      signal?.throwIfAborted();
      const currentWorker = worker();
      await hold(currentWorker.Image as string, signal);
      signal?.throwIfAborted();
      const prior = readTransaction(journalPath, instance);
      if (prior?.operationId === job.id) {
        if (prior.candidate.id !== candidate.id) throw new UpdateError("Update recovery candidate changed.");
        assertTransactionPair(prior);
        if (prior.rollback) throw new UpdateError(prior.failure ?? "The update is restoring its previous installation.");
        return;
      }
      const current = config();
      if (!sameBuild(buildOf(current), job.previous)) throw new UpdateError("The installed version changed. Check for updates again before installing.");
      if (current.phase !== "ready" || current.pendingPort !== undefined) throw new UpdateError("Finish the existing installation recovery before updating.");
      if (candidate.sequence <= current.active.sequence) throw new UpdateError("The selected update is no longer newer than this installation.");
      if (resolve(archivePath) !== resolve(stateDirectory, "downloads", `${candidate.id}.tar`)) throw new UpdateError("The staged update path is invalid.");
      await archiveVerified(archivePath, candidate, signal);
      checked(runner, ["load", "--input", archivePath]);
      const images = JSON.parse(checked(runner, ["image", "inspect", candidate.release.imageId]));
      if (images?.length !== 1 || images[0].Id !== candidate.release.imageId || images[0].Config?.Labels?.[PRODUCT_LABEL] !== PRODUCT
        || images[0].Config?.Labels?.["io.gridlens.version"] !== candidate.version) throw new UpdateError("The loaded image does not match the signed release.");
      const baked = parseUpdateBuild(JSON.parse(checked(runner, ["run", "--rm", ...labels(instance), ...restrictions, "--network", "none", "--user", "1000:1000",
        candidate.release.imageId, "node", "-e", 'process.stdout.write(require("node:fs").readFileSync("/app/build.json","utf8"))'])));
      if (!sameBuild(baked, candidate)) throw new UpdateError("The image build identity does not match the signed update.");
      coordinator.validateManagedRuntime(current);
      const web = readVpnWebEndpoint(runner, current), owner = readiness();
      if (!sameBuild(owner.build, buildOf(current))) throw new UpdateError("The installed owner and runtime versions do not match.");
      mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
      saveTransaction(journalPath, { schema: 1, operationId: job.id, candidate, previous: current,
        previousWeb: web ? { ...web, version: current.active.version, sequence: current.active.sequence } : null,
        previousWorkerImage: currentWorker.Image as string, serverId: owner.serverId, rollback: false });
    },
    async apply(candidate, job, signal) {
      signal?.throwIfAborted(); const transaction = journal(job);
      if (transaction.rollback) throw new UpdateError("This update is already restoring its previous installation.");
      assertTransactionPair(transaction);
      const result = coordinator.install({ instance, release: candidate.release, action: "upgrade", enableUpdater: true });
      if (transaction.previousWeb) ensureVpnWeb(runner, result.config, candidate.release, transaction.previousWeb.port, { upgrade: true });
    },
    async verify(candidate, job, signal) { await verify(candidate, journal(job), signal); },
    async rollback(job, signal) {
      signal?.throwIfAborted(); const transaction = journal(job);
      // The failure may have been the lock helper itself. Drop that handle and
      // acquire a fresh OS lock before inspecting or restoring runtime state.
      await release();
      await hold(transaction.previousWorkerImage, signal);
      assertTransactionPair(transaction);
      transaction.rollback = true; saveTransaction(journalPath, transaction);
      const current = config();
      if (current.active.imageId !== transaction.previous.active.imageId || current.active.stateVolume !== transaction.previous.active.stateVolume || current.phase !== "ready")
        coordinator.restore(current, transaction.previous);
      if (transaction.previousWeb) ensureVpnWeb(runner, transaction.previous, releaseFor(transaction.previousWeb), transaction.previousWeb.port, { upgrade: true });
      const previous = buildOf(transaction.previous); await verify(previous, transaction, signal); return previous;
    },
    async replaceWorker(candidate, job, signal) {
      const transaction = journal(job), current = worker();
      if (current.Image === candidate.release.imageId) return;
      if (current.Image !== transaction.previousWorkerImage) throw new UpdateError("The updater changed identity during installation.");
      await release();
      await launchWorkerReplacement(runner, instance, candidate.release.imageId, job.id);
      // The detached helper owns replacement after this point. Process shutdown
      // must leave the durable updating-updater phase for its successor.
      for (;;) { signal?.throwIfAborted(); await wait(1000, signal); }
    },
    release,
  };
}

function threadedRuntime(instance: string, stateDirectory: string): UpdateRuntime {
  let thread: Worker | undefined, sequence = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void; detach: () => void }>();
  const execute = (method: keyof UpdateRuntime, args: unknown[], signal?: AbortSignal): Promise<unknown> => {
    signal?.throwIfAborted();
    if (!thread) {
      thread = new Worker(new URL(import.meta.url), { workerData: { gridlensRuntime: true, instance, stateDirectory } });
      thread.on("message", (reply: { id: number; value?: unknown; error?: string }) => {
        const call = pending.get(reply.id); if (!call) return; pending.delete(reply.id); call.detach();
        if (reply.error) call.reject(new UpdateError(reply.error)); else call.resolve(reply.value);
        if (!pending.size) thread?.unref();
      });
      const fail = (): void => {
        for (const call of pending.values()) { call.detach(); call.reject(new UpdateError("The runtime update process stopped. Its recovery record was retained.")); }
        pending.clear(); thread = undefined;
      };
      thread.once("error", fail); thread.once("exit", fail); thread.unref();
    }
    const active = thread, id = ++sequence; active.ref();
    return new Promise((resolve, reject) => {
      const abort = () => active.postMessage({ abort: id });
      pending.set(id, { resolve, reject, detach: () => signal?.removeEventListener("abort", abort) });
      signal?.addEventListener("abort", abort, { once: true }); active.postMessage({ id, method, args });
    });
  };
  return {
    async current() { return parseUpdateBuild(await execute("current", [])); },
    async prepare(candidate, archive, job, signal) { await execute("prepare", [candidate, archive, job], signal); },
    async apply(candidate, job, signal) { await execute("apply", [candidate, job], signal); },
    async verify(candidate, job, signal) { await execute("verify", [candidate, job], signal); },
    async rollback(job, signal) { return parseUpdateBuild(await execute("rollback", [job], signal)); },
    async replaceWorker(candidate, job, signal) { await execute("replaceWorker", [candidate, job], signal); },
    async release() { if (!thread) return; await execute("release", []); const active = thread; thread = undefined; await active?.terminate(); },
  };
}
if (!isMainThread && workerData?.gridlensRuntime === true && parentPort) {
  const runtime = createUpdateRuntime({ instance: workerData.instance, stateDirectory: workerData.stateDirectory, runner: localDockerRunner({ allowSudo: false }) });
  const operations = new Map<number, AbortController>();
  parentPort.on("message", (message: { id: number; method: keyof UpdateRuntime; args: unknown[]; abort?: number }) => {
    if (message.abort !== undefined) { operations.get(message.abort)?.abort(new Error("Runtime operation stopped.")); return; }
    const controller = new AbortController(); operations.set(message.id, controller);
    const action = runtime[message.method] as (...args: unknown[]) => Promise<unknown>;
    if (typeof action !== "function" || !Array.isArray(message.args)) { parentPort!.postMessage({ id: message.id, error: "Invalid internal runtime operation." }); return; }
    void action(...message.args, controller.signal).then(value => parentPort!.postMessage({ id: message.id, value }), error => {
      parentPort!.postMessage({ id: message.id, error: runtimeFailure(error) });
    }).finally(() => operations.delete(message.id));
  });
}

/** Runs in a separately verified image so stopping the old worker cannot stop recovery. */
export async function replaceWorkerMain(instance: string, operationId: string, options: {
  stateDirectory?: string; runner?: DockerRunner; configurationPath?: string; probe?: typeof verifyUpdateEndpoint;
  workerStatus?: () => Promise<{ current?: UpdateBuild; operation?: UpdateOperation }>; sleep?: typeof sleep; now?: () => number;
} = {}): Promise<void> {
  const stateDirectory = options.stateDirectory ?? "/update-state", runner = options.runner ?? localDockerRunner({ allowSudo: false });
  const configurationPath = options.configurationPath ?? "/config/installation.json", wait = options.sleep ?? sleep, now = options.now ?? Date.now;
  const transaction = readTransaction(join(stateDirectory, "runtime-transaction.json"), instance);
  if (!transaction || transaction.operationId !== operationId) throw new UpdateError("Updater replacement has no matching recovery transaction.");
  const status = options.workerStatus ?? (() => ownerCall<{ current?: UpdateBuild; operation?: UpdateOperation }>("/updates/updater.sock", { operation: "status" }, undefined, 3000));
  const acquire = async (): Promise<() => Promise<void>> => {
    const deadline = now() + 300_000;
    for (let attempt = 0; ; attempt++) {
      try { return await acquireMaintenanceLock(runner, instance, transaction.candidate.release.imageId); }
      catch (error) { if (now() >= deadline || attempt >= 299 || !(error instanceof Error) || !/another installation|lock held/i.test(error.message)) throw error; await wait(1000); }
    }
  };
  // Contention before ownership is not an application failure and cannot start rollback.
  let unlock: (() => Promise<void>) | undefined = await acquire();
  try {
    const current = validateInstallation(JSON.parse(readFileSync(configurationPath, "utf8")));
    if (current.active.imageId !== transaction.candidate.release.imageId) throw new UpdateError("The application has not reached the updater replacement target.");
    ensureUpdater(runner, current, { replace: true });
    await unlock(); unlock = undefined;
    const deadline = now() + 12 * 60_000;
    for (let attempt = 0; attempt < 720 && now() < deadline; attempt++) {
      try {
        const installed = inspectOwned(runner, "container", resourceName(instance, "updater"), instance);
        if (!installed || object(installed.State).Running !== true) throw new Error(); validateUpdater(instance, installed, transaction.candidate.release.imageId);
        const state = await status();
        if (state.operation?.id === operationId && ["failed", "rolled-back"].includes(state.operation.phase))
          throw new UpdateError(state.operation.error ?? "The replacement updater could not verify the updated dashboard.");
        if (state.current && sameBuild(state.current, transaction.candidate) && state.operation?.id === operationId && state.operation.phase === "complete") return;
      } catch (error) { if (error instanceof UpdateError) throw error; }
      await wait(1000);
    }
    throw new UpdateError("The replacement updater did not become ready.");
  } catch (error) {
    if (!unlock) unlock = await acquire();
    transaction.failure = error instanceof UpdateError ? error.message : "The replacement updater failed its readiness checks.";
    transaction.rollback = true;
    saveTransaction(join(stateDirectory, "runtime-transaction.json"), transaction);
    const installed = inspectOwned(runner, "container", resourceName(instance, "updater"), instance);
    if (installed) {
      validateUpdater(instance, installed);
      if (installed.Image !== transaction.candidate.release.imageId && installed.Image !== transaction.previousWorkerImage)
        throw new UpdateError("An unexpected updater identity prevented recovery.");
      if (object(installed.State).Running === true) checked(runner, ["stop", "--time", "30", resourceName(instance, "updater")]);
    }
    const runtime = createUpdateRuntime({ instance, stateDirectory, runner, configurationPath,
      lock: async () => { if (!unlock) throw new UpdateError("Recovery lost its installation lock."); const held = unlock; unlock = undefined; return held; },
      ...(options.probe ? { probe: options.probe } : {}), ...(options.sleep ? { sleep: options.sleep } : {}), ...(options.now ? { now: options.now } : {}) });
    const job: UpdateOperation = { id: operationId, revision: 0, target: transaction.candidate, previous: buildOf(transaction.previous), phase: "rolling-back",
      startedAtMs: 0, updatedAtMs: 0, downloadedBytes: 0, totalBytes: 0, error: null, result: null };
    try { await runtime.rollback(job); ensureUpdater(runner, transaction.previous, { replace: true }); }
    finally { await runtime.release(); }
    throw new UpdateError(transaction.failure);
  } finally { await unlock?.(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "--replace-worker") {
  void replaceWorkerMain(process.argv[3] ?? "", process.argv[4] ?? "").catch(() => { console.error("Updater replacement failed; its saved recovery transaction was retained."); process.exitCode = 1; });
}
