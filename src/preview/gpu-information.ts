import { GPU_FRESH_MS } from "../fleet/pc-gpu-devices.ts";
import type { PcGpuEvent, pcGpuView } from "../fleet/pc-gpu-devices.ts";
import type { InfoContent, InfoText, InfoTone } from "./info-content.ts";

type GpuView = ReturnType<typeof pcGpuView> & { transportFailed?: boolean };

function localTime(at: number | null): string {
  return at !== null && Number.isSafeInteger(at) && at >= 0 && at <= 8_640_000_000_000_000
    ? new Date(at).toLocaleString() : "unknown time";
}

function eventLabel(event: PcGpuEvent, pcName: string, pcLevel = false): string {
  return event.xid === 79 ? pcLevel ? `A GPU on ${pcName} fell off the bus` : `GPU fell off the bus on ${pcName}`
    : event.xid === 154 ? `Driver recovery event on ${pcName}` : `Driver event (Xid ${event.xid}) on ${pcName}`;
}

function eventText(event: PcGpuEvent, pcName: string): string {
  return `${eventLabel(event, pcName)} — recorded ${localTime(event.atMs)}.`;
}

function physicalIds(indices: number[]): string {
  return `GPU ${indices.length === 1 ? "ID" : "IDs"} ${indices.join(", ")}`;
}

/** Present existing GPU evidence without starting reads or inferring device health. */
export function gpuInformation(view: GpuView | undefined, pcName: string, now: number, technicalDetails: string): {
  content: InfoContent; label: string; warning: boolean; tone: InfoTone;
} {
  const fresh = (at: number | null) => at !== null && Number.isFinite(at) && now >= at && now < at + GPU_FRESH_MS;
  let label: string, tone: InfoTone;
  if (!view || view.attemptedAtMs === null) {
    label = "GPU ID is waiting for its first reading"; tone = "muted";
  } else if (view.transportFailed) {
    label = "GPU data is unavailable"; tone = "warning";
  } else if (!fresh(view.attemptedAtMs)) {
    label = "GPU ID reading is out of date"; tone = "warning";
  } else if (view.devices.some(device => device.status === "inaccessible" && fresh(device.observedAtMs))) {
    label = "GPU cannot be accessed"; tone = "negative";
  } else if (view.partial) {
    label = "Only some GPU IDs could be read"; tone = "warning";
  } else if (view.current) {
    label = `${physicalIds(view.indices)} read successfully`; tone = "positive";
  } else if (view.devices.some(device => device.status === "query-failed" || device.status === "unavailable")) {
    label = "GPU ID could not be read"; tone = "warning";
  } else if (view.allocationStatus !== "ok") {
    label = "GPU ID unavailable"; tone = "warning";
  } else if (view.retainedIndices.length) {
    label = "GPU ID reading is out of date"; tone = "warning";
  } else {
    label = "GPU ID could not be read"; tone = "warning";
  }

  const current = tone === "positive";
  const facts: InfoText[] = [current
    ? `${view!.indices.length === 1 ? "This physical GPU ID is" : "These physical GPU IDs are"} mapped to this host on ${pcName}.`
    : `The current physical GPU ID for this host on ${pcName} is unconfirmed.`];
  if (view?.attemptedAtMs !== null && view?.attemptedAtMs !== undefined) {
    facts.push([{ text: `Checked: ${localTime(current ? view.observedAtMs : view.attemptedAtMs)}.`, tone: "muted" }]);
  }
  if (view?.partial) {
    facts.push([{ text: `${physicalIds(view.indices)} read successfully; other assigned GPUs could not be confirmed.`, tone: "warning" }]);
  }
  if (view?.retainedIndices.length) {
    const retained = view.retainedDevices.map(device => `${physicalIds([device.index!])} — ${localTime(device.observedAtMs)}`).join("; ");
    facts.push([{ text: `Last read ${retained}; not confirmed current.`, tone: "muted" }]);
  }
  if (current) facts.push("The ID identifies the GPU. It does not prove that the GPU can run jobs.");
  const history = (view?.events ?? []).map(event => eventText(event, pcName));
  const source = [...history, technicalDetails].filter(Boolean).join("\n");
  return {
    content: { summary: [{ text: `${label}.`, tone }], facts, ...(source ? { source } : {}) },
    label, warning: tone === "warning" || tone === "negative", tone,
  };
}

/** Unassigned kernel events belong to their PC, never to an available host row. */
export function pcGpuInformation(groups: Array<{ pcName: string; events: PcGpuEvent[] }>, technicalDetails = ""): InfoContent {
  const affected = groups.filter(group => group.events.length);
  const entries = affected.flatMap(group => group.events.map(event => ({
    message: eventLabel(event, group.pcName, true), recorded: ` — recorded ${localTime(event.atMs)}.`,
  })));
  if (!affected.length) return {
    summary: [{ text: "No PC-level GPU events are recorded.", tone: "muted" }],
    ...(technicalDetails ? { source: technicalDetails } : {}),
  };
  const label = affected.length === 1 ? `PC-level GPU warning for ${affected[0]!.pcName}` : `PC-level GPU warnings for ${affected.length} PCs`;
  const scope = "These recorded events are not assigned to a host row. Select a GPU ID to see its current reading.";
  const evidence = affected.flatMap(group => group.events.map(event =>
    `${group.pcName}: Xid ${event.xid}; PCI ${event.pciBusId}; GPU ${event.gpuUuid ?? "unmatched"}; boot ${event.bootId}; recorded ${localTime(event.atMs)}.`));
  return {
    summary: [{ text: `${label}.`, tone: "warning" }, { text: ` ${scope}`, tone: "plain" }],
    facts: entries.slice(0, 4).map(({ message, recorded }) => [{ text: message, tone: "warning" }, { text: recorded, tone: "muted" }]),
    source: [scope, ...entries.map(({ message, recorded }) => message + recorded), "Technical evidence:", ...evidence, technicalDetails].filter(Boolean).join("\n"),
  };
}
