import { parseUpdateStatus, updateActive } from "../contracts/updates.ts";
import type { UpdateOperation, UpdateStatus } from "../contracts/updates.ts";

const RECOVERY_KEY = "gridlens.updates.recovery.v1";
const START_KEY = "gridlens.updates.start.v1";
const ENDPOINT = "/api/shared/updates";
const phases: Record<UpdateOperation["phase"], string> = {
  downloading: "Downloading update", verifying: "Verifying update", preparing: "Preparing update",
  restarting: "Restarting GridLens", "verifying-service": "Checking Fleet", "updating-updater": "Finishing update",
  complete: "Update installed", "rolling-back": "Restoring previous version",
  "rolled-back": "Update failed; previous version restored", failed: "Update failed",
};
interface Recovery { operationId: string; expectedBuildId: string | null; attemptedBuildId: string | null; startedAtMs: number }
interface PendingStart { candidateId: string; idempotencyKey: string }
function saved<T>(key: string, valid: (value: unknown) => value is T): T | null {
  try { const text = sessionStorage.getItem(key); if (!text || text.length > 2048) return null;
    const value: unknown = JSON.parse(text); return valid(value) ? value : null; } catch { return null; }
}
function save(key: string, value: unknown): void {
  try { if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* Memory state still works. */ }
}
const safeId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);
function isRecovery(value: unknown): value is Recovery {
  if (!value || typeof value !== "object") return false;
  const item = value as Recovery;
  return safeId(item.operationId) && (item.expectedBuildId === null || safeId(item.expectedBuildId))
    && (item.attemptedBuildId === null || safeId(item.attemptedBuildId)) && Number.isSafeInteger(item.startedAtMs) && item.startedAtMs >= 0;
}
function isStart(value: unknown): value is PendingStart {
  if (!value || typeof value !== "object") return false;
  const item = value as PendingStart;
  return typeof item.candidateId === "string" && /^[a-f0-9]{64}$/.test(item.candidateId)
    && typeof item.idempotencyKey === "string" && /^[a-f0-9-]{36}$/.test(item.idempotencyKey);
}
function text(node: HTMLElement, value: string): void { if (node.textContent !== value) node.textContent = value; }
function requestId(): string {
  // getRandomValues is also available on the explicitly supported private HTTP origin.
  const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = bytes[6]! & 15 | 64; bytes[8] = bytes[8]! & 63 | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Loaded independently of Fleet so a failed Fleet module cannot hide recovery. */
function startUpdates(): void {
  if (document.querySelector('meta[name="gridlens-updates"]')?.getAttribute("content") !== "1") return;
  const node = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
  const button = node<HTMLButtonElement>("sidebar-update"), dialog = node<HTMLDialogElement>("update-dialog");
  const check = node<HTMLButtonElement>("update-check"), start = node<HTMLButtonElement>("update-start");
  const retry = node<HTMLButtonElement>("update-retry-fleet"), progress = node<HTMLProgressElement>("update-download");
  const loadedBuild = document.querySelector('meta[name="gridlens-build-id"]')?.getAttribute("content") ?? "";
  let status: UpdateStatus | null = null, recovery = saved(RECOVERY_KEY, isRecovery), pendingStart = saved(START_KEY, isStart);
  if (!recovery && isRecovery(history.state?.gridlensUpdateRecovery)) recovery = history.state.gridlensUpdateRecovery as Recovery;
  let request: AbortController | null = null, pollTimer: ReturnType<typeof setTimeout> | undefined;
  let elapsedTimer: ReturnType<typeof setTimeout> | undefined, bootTimer: ReturnType<typeof setTimeout> | undefined;
  let pageHidden = false, busy = false, disconnected = false, localError: string | null = null;
  let fleetReady = document.documentElement.dataset.gridlensFleetReady === loadedBuild && loadedBuild !== "";
  let shownOperation: string | null = null, reloading = false, pendingReturn = recovery !== null;
  button.hidden = false;
  const visible = (): boolean => !document.hidden && !pageHidden;
  const available = (): boolean => !!status?.candidate && !!status.current && status.candidate.sequence > status.current.sequence;
  const active = (): boolean => updateActive(status?.operation ?? null);
  const remember = (): void => { save(RECOVERY_KEY, recovery);
    try { history.replaceState({ ...history.state, gridlensUpdateRecovery: recovery }, ""); } catch { /* Memory state still works. */ } };
  function open(): void { if (!dialog.open) dialog.showModal(); render(); }
  function elapsed(): void {
    if (elapsedTimer) clearTimeout(elapsedTimer);
    const operation = status?.operation;
    const started = active() ? operation?.startedAtMs : recovery?.startedAtMs;
    const target = node("update-elapsed"); target.hidden = started === undefined;
    if (started !== undefined) {
      const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
      text(target, `Elapsed ${Math.floor(seconds / 60)}m ${seconds % 60}s`);
      if (visible() && dialog.open) elapsedTimer = setTimeout(elapsed, 1000);
    }
  }
  function render(): void {
    const operation = status?.operation;
    const running = active(), newer = available();
    const state = running || pendingReturn ? "active" : newer ? "available" : operation?.phase === "failed" || operation?.phase === "rolled-back" ? "failed" : "current";
    button.dataset.updateState = state;
    const label = state === "available" ? "Update available" : state === "active" ? "Update in progress" : state === "failed" ? "Update needs attention" : "Update";
    button.setAttribute("aria-label", label); button.title = label;
    text(node("update-installed"), status?.current?.version ?? "Checking…");
    text(node("update-available"), status?.candidate?.version ?? (status?.checkedAtMs !== null && status?.checkedAtMs !== undefined ? "No newer release" : "Not checked"));
    text(node("update-last-check"), status?.checkedAtMs ? `Last successful check: ${new Date(status.checkedAtMs).toLocaleString()}` : "No successful check yet.");
    let summary = !status ? "Checking for updates…" : !status.supported ? "Browser updates are not enabled on this installation."
      : operation && (running || pendingReturn || operation.phase === "failed" || operation.phase === "rolled-back") ? phases[operation.phase]
      : newer ? "A GridLens update is available." : status.checkError ? "The latest update check could not finish."
        : status.checkedAtMs !== null ? "GridLens is up to date." : "No update check has completed yet.";
    if (pendingReturn && !running) summary = "Checking Fleet";
    if (status?.checking && !running && !pendingReturn) summary = "Checking for updates…";
    if (disconnected) summary = running || recovery ? "Reconnecting to GridLens…" : "Update status is unavailable.";
    text(node("update-status"), summary);
    const error = localError ?? operation?.error ?? status?.checkError ?? null;
    node("update-error").hidden = error === null;
    if (error) text(node("update-error"), error);
    const downloading = operation?.phase === "downloading" && operation.totalBytes > 0;
    progress.hidden = !downloading; node("update-transfer").hidden = !downloading;
    if (downloading) {
      progress.max = operation.totalBytes; progress.value = operation.downloadedBytes;
      text(node("update-transfer"), `${disconnected ? "Last reported · " : ""}${(operation.downloadedBytes / 1_000_000).toFixed(1)} / ${(operation.totalBytes / 1_000_000).toFixed(1)} MB · ${Math.floor(operation.downloadedBytes / operation.totalBytes * 100)}%`);
    }
    node("update-running-note").hidden = !running && !pendingReturn;
    check.hidden = status?.canUpdate === false || status?.supported === false;
    check.disabled = request !== null || busy || running || !status || !status.canUpdate || status.checking;
    start.hidden = !newer || status?.canUpdate !== true || running || pendingReturn;
    start.disabled = request !== null || busy || disconnected;
    retry.hidden = !pendingReturn || running || !localError;
    if (status?.canUpdate === false && status.supported && !running && !pendingReturn) {
      text(node("update-description"), "An operator can update this GridLens dashboard and its backend.");
    } else text(node("update-description"), "Update this GridLens dashboard and its backend.");
    elapsed();
  }
  function clearBootTimer(): void { if (bootTimer) clearTimeout(bootTimer); bootTimer = undefined; }
  function watchBoot(): void {
    const operation = status?.operation;
    if (!pendingReturn || bootTimer || !visible() || !recovery || !operation || operation.id !== recovery.operationId
      || !["complete", "rolled-back"].includes(operation.phase) || !operation.result
      || recovery.attemptedBuildId !== operation.result.buildId || loadedBuild !== operation.result.buildId || fleetReady) return;
    bootTimer = setTimeout(() => {
      bootTimer = undefined;
      if (!pendingReturn) return;
      localError = "Fleet has not finished loading. Check your connection, then retry loading Fleet.";
      render();
    }, 30_000);
  }
  function finishReturn(): void {
    if (!pendingReturn || !recovery || !status?.current || active()) return;
    const operation = status.operation;
    if (!operation || operation.id !== recovery.operationId || !["complete", "rolled-back"].includes(operation.phase)
      || !operation.result || operation.result.buildId !== status.current.buildId) return;
    recovery.expectedBuildId = operation.result.buildId; remember();
    if (recovery.attemptedBuildId !== recovery.expectedBuildId) {
      if (!visible() || reloading) return;
      recovery.attemptedBuildId = recovery.expectedBuildId; remember();
      // Every finished operation reloads once, including rollback to this same build.
      // A pre-restart render cannot establish that the recovered Fleet still works.
      reloading = true; location.reload(); return;
    }
    if (loadedBuild !== recovery.expectedBuildId) {
      localError = "The browser did not load the installed version. Retry loading Fleet."; render(); return;
    }
    if (!fleetReady) { watchBoot(); return; }
    clearBootTimer(); pendingReturn = false; recovery = null; remember(); localError = null;
    if (operation.phase === "complete") {
      if (dialog.open) dialog.close();
    } else { text(node("update-status"), phases[operation.phase]); open(); }
    render();
  }
  function accept(value: unknown): void {
    const next = parseUpdateStatus(value);
    const previous = status?.operation;
    if (previous && next.operation?.id === previous.id && next.operation.revision < previous.revision) throw new Error("Outdated update status.");
    status = next; if (disconnected) localError = null; disconnected = false;
    const operation = next.operation;
    if (operation && updateActive(operation)) {
      if (recovery?.operationId !== operation.id) {
        recovery = { operationId: operation.id, expectedBuildId: null, attemptedBuildId: null, startedAtMs: operation.startedAtMs };
      }
      pendingReturn = true; remember(); pendingStart = null; save(START_KEY, null);
      if (shownOperation !== operation.id) { shownOperation = operation.id; open(); }
    } else if (operation && ["complete", "rolled-back"].includes(operation.phase) && operation.result
      && operation.result.buildId === next.current?.buildId && loadedBuild !== next.current.buildId) {
      recovery ??= { operationId: operation.id, expectedBuildId: operation.result.buildId,
        attemptedBuildId: null, startedAtMs: operation.startedAtMs };
      pendingReturn = true; remember(); open();
    } else if (operation?.phase === "failed" && recovery?.operationId === operation.id) {
      pendingReturn = false; recovery = null; remember(); clearBootTimer(); open();
    }
    render(); finishReturn();
  }
  async function json(path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    const response = await fetch(path, { signal, cache: "no-store", redirect: "error", credentials: "same-origin",
      ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error("Update access is unavailable. Reconnect with an authorized operator session.");
      if (response.status === 409) throw new Error("The available update changed or another update is running. Check the current update status.");
      if (response.status === 429) throw new Error("The update check is waiting before another attempt. The next check will follow the server’s retry schedule.");
      throw new Error("GridLens could not be reached. Reconnecting automatically.");
    }
    if (response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") throw new Error("Update status could not be verified.");
    const reader = response.body?.getReader(); if (!reader) throw new Error("Update status could not be read.");
    let total = 0, output = ""; const decoder = new TextDecoder("utf-8", { fatal: true });
    try { for (;;) { const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength; if (total > 32_768) throw new Error("Update status exceeded its allowed size.");
      output += decoder.decode(value, { stream: true }); }
      return JSON.parse(output + decoder.decode());
    } finally { await reader.cancel().catch(() => {}); }
  }
  function schedule(): void {
    if (pollTimer) clearTimeout(pollTimer);
    if (visible() && !reloading) pollTimer = setTimeout(() => { void refresh(); }, active() || recovery || pendingStart || disconnected || status?.checking ? 2000 : 60_000);
  }
  async function refresh(action?: "check" | "start"): Promise<void> {
    if (!visible() || request || reloading) return;
    if (action && (!status?.canUpdate || active())) return;
    let body: unknown;
    if (action === "start") {
      if (!status?.candidate || !available()) return;
      if (pendingStart?.candidateId !== status.candidate.id) {
        pendingStart = { candidateId: status.candidate.id, idempotencyKey: requestId() }; save(START_KEY, pendingStart);
      }
      body = pendingStart;
    } else if (action === "check") body = {};
    const controller = new AbortController(); request = controller; busy = !!action;
    if (action) localError = null;
    render();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try { accept(await json(action ? `${ENDPOINT}/${action}` : ENDPOINT, controller.signal, body)); }
    catch (error) {
      if (controller.signal.aborted && !visible()) return;
      disconnected = true;
      localError = error instanceof Error && error.name !== "AbortError" ? error.message : "GridLens could not be reached. Reconnecting automatically.";
      if (action === "start") localError = "The update request may have been accepted. Checking its status before another attempt.";
    } finally { clearTimeout(timeout); if (request === controller) request = null; busy = false; render(); schedule(); }
  }
  button.addEventListener("click", () => { open(); void refresh(); });
  node("update-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { if (elapsedTimer) clearTimeout(elapsedTimer); });
  check.addEventListener("click", () => { void refresh("check"); });
  start.addEventListener("click", () => { void refresh("start"); });
  retry.addEventListener("click", () => { if (visible()) location.reload(); });
  document.addEventListener("gridlens:fleet-ready", () => {
    fleetReady = document.documentElement.dataset.gridlensFleetReady === loadedBuild && loadedBuild !== "";
    finishReturn();
  });
  function visibility(): void {
    if (!visible()) { if (pollTimer) clearTimeout(pollTimer); if (elapsedTimer) clearTimeout(elapsedTimer); clearBootTimer(); request?.abort(); }
    else { void refresh(); elapsed(); watchBoot(); finishReturn(); }
  }
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("pagehide", () => { pageHidden = true; visibility(); });
  window.addEventListener("pageshow", () => { pageHidden = false; visibility(); });
  window.addEventListener("online", () => { void refresh(); });
  if (recovery) { shownOperation = recovery.operationId; open(); watchBoot(); }
  render(); void refresh();
}

startUpdates();
