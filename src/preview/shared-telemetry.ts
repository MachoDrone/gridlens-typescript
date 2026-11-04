import { parseSharedObservations } from "../contracts/shared.ts";
import type { SharedObservations } from "../contracts/shared.ts";
import type { FleetContext } from "../contracts/fleet.ts";
import { networkView, rewardView, rewardAtoms, parseNodeGpu, jobGpuConditions } from "../fleet/pc-observations.ts";
import type { NodeGpuObservation } from "../fleet/pc-observations.ts";
import type { JobHistoryItem } from "../fleet/job-history.ts";
import { formatIPDisplay } from "../fleet/ip-display.ts";
import type { IPDisplayMode } from "../fleet/ip-display.ts";
import { DRIVER_FRESH_MS, pcDriverView } from "../fleet/pc-drivers.ts";
import { GPU_FRESH_MS, pcGpuView } from "../fleet/pc-gpu-devices.ts";
import { gpuInformation, pcGpuInformation } from "./gpu-information.ts";
import type { InfoContent } from "./info-content.ts";

/** Optional installed-backend data adapter. Never enabled by the development preview. */
export function createSharedTelemetry(changed: () => void, now = Date.now, showInfo?: (title: string, content: InfoContent) => void) {
  const enabled = document.querySelector('meta[name="gridlens-shared-backend"]')?.getAttribute("content") === "1";
  const viewerOnly = document.querySelector('meta[name="gridlens-viewer-only"]')?.getAttribute("content") === "1";
  let data: SharedObservations | undefined, controller: AbortController | undefined, failed = false, timer: ReturnType<typeof setTimeout> | undefined;
  let driverExpiryTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleDriverExpiry(): void {
    if (driverExpiryTimer) clearTimeout(driverExpiryTimer);
    driverExpiryTimer = undefined;
    if (!enabled || document.hidden) return;
    const at = now(), deadlines = (data?.drivers ?? []).flatMap(row => row.driver.status === "ok" && row.driver.observedAtMs + DRIVER_FRESH_MS > at
      ? [row.driver.observedAtMs + DRIVER_FRESH_MS] : []);
    for (const row of data?.pcGpuDevices ?? []) {
      for (const observed of [row.gpu.observedAtMs, ...row.gpu.devices.map(device => device.observedAtMs), ...row.gpu.allocations.map(allocation => allocation.observedAtMs)]) {
        if (observed + GPU_FRESH_MS > at) deadlines.push(observed + GPU_FRESH_MS);
      }
    }
    if (deadlines.length) driverExpiryTimer = setTimeout(() => { changed(); scheduleDriverExpiry(); }, Math.max(1, Math.min(...deadlines) - at));
  }
  function driver(address: string, at: number) {
    if (!enabled) return undefined;
    const association = data?.associations.find(row => row.address === address);
    const record = data?.drivers?.find(row => row.pcId === association?.binding.pcId && row.sshFingerprint === association?.sshFingerprint);
    return record && association ? { ...pcDriverView(record, at, failed), pcName: association.name } : undefined;
  }
  function gpu(address: string, at: number) {
    const association = data?.associations.find(row => row.address === address);
    const record = data?.pcGpuDevices?.find(row => row.pcId === association?.binding.pcId && row.sshFingerprint === association?.sshFingerprint);
    if (!enabled || !record || !association) return undefined;
    const view = pcGpuView(record, association, at, failed);
    const utc = (time: number | null) => time === null ? "unknown" : new Date(time).toISOString();
    const identity = view.current ? `Measured physical GPU indices: ${view.indices.join(", ")}.`
      : view.indices.length ? `Partially measured physical GPU indices: ${view.indices.join(", ")}; complete allocation is unconfirmed.`
        : "Current physical GPU identity is unknown.";
    const retained = view.retainedIndices.length ? ` Last measured indices: ${view.retainedIndices.join(", ")}; retained, not confirmed current.` : "";
    const retainedEvidence = view.retainedDevices.map(device => `Retained physical GPU ${device.index}: ${device.uuid}, measured ${utc(device.observedAtMs)}${device.pciBusId ? `; PCI ${device.pciBusId}` : ""}.`).join(" ");
    const devices = view.devices.map(device => `${device.uuid}: ${device.status === "responds" ? `responded as physical GPU ${device.index}` : device.status.replaceAll("-", " ")}; checked ${utc(device.observedAtMs)}${device.pciBusId ? `; PCI ${device.pciBusId}` : ""}.`).join(" ");
    const events = view.events.map(event => `Recorded Xid ${event.xid} for ${event.gpuUuid} at ${utc(event.atMs)}; PCI ${event.pciBusId}; boot ${event.bootId}.`).join(" ");
    const pcEvents = view.pcEvents.map(event => `PC-level Xid ${event.xid} at ${utc(event.atMs)}; PCI ${event.pciBusId}; boot ${event.bootId}; ${event.gpuUuid ? `GPU ${event.gpuUuid} has no verified host allocation` : "device identity is unmatched"}, so this event is not assigned to this host.`).join(" ");
    const runtime = view.observedBinding ? ` GPU runtime identity verified ${utc(view.allocationObservedAtMs)}.${view.runtimeChanged ? " This runtime differs from the saved source binding; source approval is unchanged." : ""}` : "";
    const warning = view.partial || view.devices.some(device => device.status !== "responds") || view.events.length > 0 || view.pcEvents.length > 0
      || view.allocationStatus !== "ok" || view.journalStatus !== "ok" || record.gpu.status !== "ok" && (record.gpu.status !== "partial" || !view.current);
    const description = `${identity}${retained} Identity observed ${utc(view.observedAtMs)}; latest query ${utc(view.attemptedAtMs)} (${record.gpu.status}). Allocation: ${view.allocationStatus}.${runtime} ${devices} ${retainedEvidence} ${events} ${pcEvents} Kernel event coverage: ${view.journalStatus}. A device response does not establish GPU health; recorded Xid events do not establish a current fault. Job State and driver versions are separate.`;
    return { ...view, warning, description, transportFailed: failed, pcName: association.name };
  }

  function renderGpu(cell: HTMLTableCellElement, address: string, at: number): void {
    const view = gpu(address, at);
    const information = gpuInformation(view, view?.pcName ?? "this PC", at, view?.description ?? "");
    const currentIndices = view?.indices ?? [], retainedIndices = view?.retainedIndices ?? [];
    let action = cell.querySelector<HTMLButtonElement>(".gpu-id-action");
    if (!action) {
      action = document.createElement("button"); action.type = "button"; action.className = "gpu-id-action";
      const current = document.createElement("span"); current.className = "gpu-id-current";
      const retained = document.createElement("span"); retained.className = "gpu-id-retained";
      const warning = document.createElement("span"); warning.className = "gpu-id-warning"; warning.setAttribute("aria-hidden", "true");
      action.append(current, retained, warning); cell.replaceChildren(action);
      action.addEventListener("click", () => {
        const latest = gpu(address, now());
        showInfo?.(`GPU details · ${latest?.pcName ?? "Unknown PC"}`, gpuInformation(latest, latest?.pcName ?? "this PC", now(), latest?.description ?? "").content);
      });
    }
    const current = cell.querySelector<HTMLElement>(".gpu-id-current")!;
    const currentText = currentIndices.join(", ") || (retainedIndices.length ? "" : "—");
    if (current.textContent !== currentText) current.textContent = currentText;
    const retained = cell.querySelector<HTMLElement>(".gpu-id-retained")!;
    const retainedText = `${currentIndices.length && retainedIndices.length ? ", " : ""}${retainedIndices.join(", ")}`;
    if (retained.textContent !== retainedText) retained.textContent = retainedText;
    const warning = cell.querySelector<HTMLElement>(".gpu-id-warning")!;
    const warningText = information.warning ? " ⚠" : "";
    if (warning.textContent !== warningText) warning.textContent = warningText;
    warning.hidden = !information.warning;
    action.dataset.tone = information.tone;
    action.title = `${information.label} Select for details.`;
    action.setAttribute("aria-label", `${information.label} Open GPU details.`);
    cell.className = currentIndices.length || retainedIndices.length ? "gpu-id-cell" : "gpu-id-cell unknown";
    cell.dataset.gpuState = view?.current ? "current" : currentIndices.length ? "partial" : retainedIndices.length ? "retained" : "unknown";
    cell.dataset.gpuWarning = String(information.warning);
    cell.setAttribute("aria-label", information.label);
    cell.removeAttribute("title");
  }
  function renderGpuHeading(addresses: readonly string[]): void {
    const heading = document.querySelector<HTMLTableCellElement>('#column-headings th[data-col="gpuID"]');
    if (!heading) return;
    let button = heading.querySelector<HTMLButtonElement>(".gpu-pc-warning-control");
    if (!button) {
      button = document.createElement("button"); button.type = "button"; button.className = "gpu-pc-warning-control";
      button.id = "gpu-pc-warnings"; button.hidden = true; heading.append(button);
    }
    const groups = new Map<string, { pcName: string; events: ReturnType<typeof pcGpuView>["pcEvents"] }>();
    for (const address of addresses) {
      const association = data?.associations.find(row => row.address === address), view = gpu(address, now());
      if (!association || !view?.pcEvents.length || groups.has(association.binding.pcId)) continue;
      groups.set(association.binding.pcId, { pcName: association.name, events: view.pcEvents });
    }
    button.hidden = !enabled || groups.size === 0;
    heading.classList.toggle("has-gpu-pc-warning", !button.hidden);
    button.textContent = `PC ⚠ ${groups.size}`;
    button.title = `${groups.size} PC${groups.size === 1 ? "" : "s"} with recorded GPU warnings. Select for details.`;
    button.setAttribute("aria-label", `Open PC-level GPU warnings (${groups.size} ${groups.size === 1 ? "PC" : "PCs"})`);
    button.onclick = () => showInfo?.("PC-level GPU warnings", pcGpuInformation([...groups.values()]));
  }
  const gpuHistory = new Map<string, { gpu: NodeGpuObservation; receivedAtMs: number }>();
  const historyQueue = new Set<string>(); let historyActive = 0;
  const historyControllers = new Map<string, AbortController>();
  async function json(path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    const response = await fetch(path, { signal, cache: "no-store", credentials: "same-origin",
      ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error("Shared observations unavailable.");
    const reader = response.body?.getReader(); if (!reader) throw new Error("Missing shared response.");
    let bytes = 0, text = ""; const decoder = new TextDecoder("utf-8", { fatal: true });
    for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength;
      if (bytes > 16 * 1024 * 1024) { await reader.cancel(); throw new Error("Shared response too large."); } text += decoder.decode(value, { stream: true }); }
    return JSON.parse(text + decoder.decode());
  }
  function pumpHistory(): void {
    if (document.hidden || !enabled || !data || historyActive >= 2) return;
    const address = historyQueue.values().next().value as string | undefined; if (!address) return;
    historyQueue.delete(address); historyActive++;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15_000), scope = data;
    historyControllers.set(address, controller);
    const at = Math.floor(now());
    void json("/api/shared/gpu-history", controller.signal, { address, fromAtMs: Math.max(0, at - 7 * 86_400_000), toAtMs: at })
      .then(raw => {
        const value = raw as { version: number; serverId: string; scopeId: string; rosterRevision: string; address: string; gpu: unknown };
        if (data !== scope || value.version !== 1 || value.serverId !== scope.serverId || value.scopeId !== scope.scopeId
          || value.rosterRevision !== scope.rosterRevision || value.address !== address) throw new Error("GPU history identity changed.");
        if (value.gpu !== null) gpuHistory.set(address, { gpu: parseNodeGpu(value.gpu, address), receivedAtMs: Date.now() });
        changed();
      }).catch(() => { if (document.hidden) historyQueue.add(address); }).finally(() => { clearTimeout(timeout); historyControllers.delete(address); historyActive--; pumpHistory(); });
    pumpHistory();
  }
  async function refresh(): Promise<void> {
    if (!enabled || document.hidden || controller) return;
    const pending = new AbortController(); controller = pending;
    const timeout = setTimeout(() => pending.abort(), 15_000);
    try {
      const status = await json("/api/shared/status", pending.signal) as { version: number; serverId: string; context: FleetContext };
      if (status.version !== 1 || typeof status.serverId !== "string" || !status.context) throw new Error("Invalid shared identity.");
      if (data && (data.serverId !== status.serverId || data.scopeId !== status.context.scopeId || data.rosterRevision !== status.context.rosterRevision)) throw new Error("Shared fleet changed; reconnect.");
      const next = parseSharedObservations(await json("/api/shared/observations", pending.signal), status.serverId, status.context);
      if (JSON.stringify(next) !== JSON.stringify(data) || failed) { data = next; failed = false; changed(); }
    } catch { if (!failed) { failed = true; changed(); } }
    finally { clearTimeout(timeout); controller = undefined; scheduleDriverExpiry(); if (!document.hidden) timer = setTimeout(() => { void refresh(); }, 30_000); }
  }
  if (enabled) {
    const hostsLink = document.querySelector<HTMLAnchorElement>("#sidebar-hosts");
    if (hostsLink) hostsLink.hidden = viewerOnly;
    const secureLink = document.querySelector<HTMLAnchorElement>("#sidebar-secure");
    if (secureLink) secureLink.hidden = viewerOnly;
    document.querySelector<HTMLElement>(".scenario-controls")?.setAttribute("hidden", "");
    document.addEventListener("visibilitychange", () => { if (document.hidden) { if (timer) clearTimeout(timer); if (driverExpiryTimer) clearTimeout(driverExpiryTimer); controller?.abort(); for (const item of historyControllers.values()) item.abort(); }
      else { changed(); scheduleDriverExpiry(); void refresh(); pumpHistory(); } });
    window.addEventListener("pagehide", () => { if (timer) clearTimeout(timer); if (driverExpiryTimer) clearTimeout(driverExpiryTimer); controller?.abort(); for (const item of historyControllers.values()) item.abort(); });
    queueMicrotask(() => { void refresh(); });
  }
  return {
    enabled,
    driver,
    renderGpuHeading,
    requestHistory(address: string): void {
      if (!enabled || historyControllers.has(address) || !data?.associations.some(row => row.address === address) || Date.now() - (gpuHistory.get(address)?.receivedAtMs ?? 0) < 300_000) return;
      historyQueue.add(address); pumpHistory();
    },
    jobConditions(item: JobHistoryItem, now: number, current: boolean): string {
      if (!enabled) return "";
      const record = data?.observations.find(row => row.address === item.node), gpu = gpuHistory.get(item.node)?.gpu;
      const view = jobGpuConditions(record && gpu ? { ...record, gpu } : record, item, now, current);
      return `GPU conditions: ${view.label}\n${view.detail}`;
    },
    sort(address: string, now: number) {
      const association = data?.associations.find(row => row.address === address), observation = data?.observations.find(row => row.address === address);
      const network = networkView(data?.networks.find(row => row.pcId === association?.binding.pcId) ?? observation, now);
      const physical = gpu(address, now);
      return { pc: association?.name ?? "", ip: network.privateIp ?? network.publicIp, rewards: rewardAtoms(rewardView(observation, now).amount),
        gpuIndices: [...new Set([...(physical?.indices ?? []), ...(physical?.retainedIndices ?? [])])].sort((a, b) => a - b) };
    },
    render(cell: HTMLTableCellElement, key: string, address: string, now: number, ipMode: IPDisplayMode): boolean {
      if (!enabled || !["pc", "ip", "rewards", "gpuID"].includes(key)) return false;
      if (key === "gpuID") { renderGpu(cell, address, now); return true; }
      const association = data?.associations.find(row => row.address === address), observation = data?.observations.find(row => row.address === address);
      const network = networkView(data?.networks.find(row => row.pcId === association?.binding.pcId) ?? observation, now);
      const reward = rewardView(observation, now);
      const value = key === "pc" ? association?.name ?? "—" : key === "ip" ? formatIPDisplay({ internal: network.privateIp, global: network.publicIp }, ipMode).text
        : reward.amount ? ((BigInt(reward.amount.replace(".", "")) + 500_000n) / 1_000_000n).toLocaleString() : "—";
      if (cell.textContent !== value) cell.textContent = value;
      const unknown = key === "ip" ? ipMode === "public-full" || ipMode === "ext" ? network.publicIp === null
        : ipMode === "private-full" || ipMode === "int" ? network.privateIp === null : network.publicIp === null && network.privateIp === null
        : value === "—";
      cell.className = unknown ? "unknown" : failed || key === "rewards" && !reward.current || key === "ip" && (network.privateRetained || network.publicRetained) ? "retained" : "";
      cell.removeAttribute("title"); cell.removeAttribute("aria-label");
      if (key === "rewards" && reward.amount) { cell.style.color = "#0f5c2b"; cell.style.fontWeight = "400"; }
      else cell.style.removeProperty("color");
      if (key === "pc" || key === "ip") {
        const description = key === "pc" ? `Computer: ${value}`
          : `${formatIPDisplay({ internal: network.privateIp, global: network.publicIp }, ipMode).description} Public checked ${network.publicObservedAtMs ? new Date(network.publicObservedAtMs).toISOString() : "unknown"}; private checked ${network.privateObservedAtMs ? new Date(network.privateObservedAtMs).toISOString() : "unknown"}.`;
        cell.setAttribute("aria-label", description); cell.title = description;
      }
      return true;
    },
  };
}
