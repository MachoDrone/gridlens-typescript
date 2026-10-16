import type { FleetResource } from "../contracts/fleet.ts";

export interface FleetConfig {
  apiBase: string;
  sourceMode: "preview" | "snapshot";
  sourceLabel: string;
}
type MetaDocument = Pick<Document, "querySelector">;

/** Configuration comes only from the application's trusted HTML, never its query. */
export function readFleetConfig(document: MetaDocument): FleetConfig {
  const base = document.querySelector<HTMLMetaElement>('meta[name="gridlens-api-base"]')?.content ?? "/preview";
  // Root-relative paths keep browser session handling same-origin. Reject URL,
  // query, fragment, dot-segment and encoded-path surprises at this boundary.
  if (!/^\/(?:[A-Za-z0-9_-]+\/?)*$/.test(base) || base.startsWith("//")) {
    throw new Error("Fleet API base must be a same-origin absolute path.");
  }
  const sourceMode = document.querySelector<HTMLMetaElement>('meta[name="gridlens-source-mode"]')?.content ?? "preview";
  if (sourceMode !== "preview" && sourceMode !== "snapshot") throw new Error("Unknown Fleet source mode.");
  const sourceLabel = document.querySelector<HTMLMetaElement>('meta[name="gridlens-source-label"]')?.content
    ?? (sourceMode === "snapshot" ? "Backend snapshots" : "Selected public Nosana observations");
  if (!sourceLabel.trim() || sourceLabel.length > 160 || /[\u0000-\u001f\u007f]/.test(sourceLabel)) {
    throw new Error("Fleet source label is invalid.");
  }
  return { apiBase: base.replace(/\/$/, ""), sourceMode, sourceLabel };
}

export function fleetResourceURL(config: FleetConfig, resource: FleetResource | "hosts" | "connection",
  scenario: "supplied" | "real200" | "online-gpu-hosts" = "supplied", revision?: string): string {
  const path = `${config.apiBase}/${resource}.json`;
  if (config.sourceMode !== "preview" || scenario === "supplied" || resource === "connection") return path;
  return `${path}?scenario=${scenario}${scenario === "online-gpu-hosts" && resource !== "hosts" && revision
    ? `&revision=${encodeURIComponent(revision)}` : ""}`;
}
