import { parseSharedObservations } from "../contracts/shared.ts";
import type { SharedObservations } from "../contracts/shared.ts";
import type { FleetContext } from "../contracts/fleet.ts";
import { networkView, rewardView, rewardAtoms, parseNodeGpu, jobGpuConditions } from "../fleet/pc-observations.ts";
import type { NodeGpuObservation } from "../fleet/pc-observations.ts";
import type { JobHistoryItem } from "../fleet/job-history.ts";
import { formatIPDisplay } from "../fleet/ip-display.ts";
import type { IPDisplayMode } from "../fleet/ip-display.ts";

/** Optional installed-backend data adapter. Never enabled by the development preview. */
export function createSharedTelemetry(changed: () => void, now = Date.now) {
  const enabled = document.querySelector('meta[name="gridlens-shared-backend"]')?.getAttribute("content") === "1";
  let data: SharedObservations | undefined, controller: AbortController | undefined, failed = false, timer: ReturnType<typeof setTimeout> | undefined;
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
    finally { clearTimeout(timeout); controller = undefined; if (!document.hidden) timer = setTimeout(() => { void refresh(); }, 30_000); }
  }
  if (enabled) {
    const link = document.createElement("a"); link.href = "/setup"; link.textContent = "Shared cache · setup and connected devices";
    const marker = document.createElement("p"); marker.className = "sample-notice"; marker.append(link);
    document.querySelector("#preview-tools")?.before(marker);
    document.addEventListener("visibilitychange", () => { if (document.hidden) { if (timer) clearTimeout(timer); controller?.abort(); for (const item of historyControllers.values()) item.abort(); }
      else { void refresh(); pumpHistory(); } });
    window.addEventListener("pagehide", () => { if (timer) clearTimeout(timer); controller?.abort(); for (const item of historyControllers.values()) item.abort(); });
    queueMicrotask(() => { void refresh(); });
  }
  return {
    enabled,
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
      return { pc: association?.name ?? "", ip: network.privateIp, rewards: rewardAtoms(rewardView(observation, now).amount) };
    },
    render(cell: HTMLTableCellElement, key: string, address: string, now: number, ipMode: IPDisplayMode): boolean {
      if (!enabled || !["pc", "ip", "rewards"].includes(key)) return false;
      const association = data?.associations.find(row => row.address === address), observation = data?.observations.find(row => row.address === address);
      const network = networkView(data?.networks.find(row => row.pcId === association?.binding.pcId) ?? observation, now);
      const reward = rewardView(observation, now);
      const value = key === "pc" ? association?.name ?? "—" : key === "ip" ? formatIPDisplay({ internal: network.privateIp, global: network.publicIp }, ipMode).text
        : reward.amount ? ((BigInt(reward.amount.replace(".", "")) + 500_000n) / 1_000_000n).toLocaleString() : "—";
      if (cell.textContent !== value) cell.textContent = value;
      cell.className = value === "—" ? "unknown" : failed || key === "rewards" && !reward.current || key === "ip" && (network.privateRetained || network.publicRetained) ? "retained" : "";
      cell.removeAttribute("title"); cell.removeAttribute("aria-label");
      if (key === "rewards" && reward.amount) { cell.style.color = "#0f5c2b"; cell.style.fontWeight = "400"; }
      else cell.style.removeProperty("color");
      if (key === "pc" || key === "ip") {
        const description = key === "pc" ? `${value}; verified computer association at ${association ? new Date(association.verifiedAtMs).toISOString() : "unknown"}`
          : `Private ${network.privateIp ?? "unknown"}, public ${network.publicIp ?? "unknown"}. Public checked ${network.publicObservedAtMs ? new Date(network.publicObservedAtMs).toISOString() : "unknown"}; private checked ${network.privateObservedAtMs ? new Date(network.privateObservedAtMs).toISOString() : "unknown"}.`;
        cell.setAttribute("aria-label", description); cell.title = description;
      }
      return true;
    },
  };
}
