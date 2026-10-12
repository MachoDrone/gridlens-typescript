// Copyright (c) 2026 MachoDrone. MIT license; see LICENSE.
// Saved compact and full IP display modes for the Fleet table.

export type IPDisplayMode = "dot" | "full" | "ext" | "int";

export interface IPAddresses {
  readonly internal: string | null;
  readonly global: string | null;
}

export function normalizeIPMode(value: unknown): IPDisplayMode {
  return value === "dot" || value === "full" || value === "ext" || value === "int"
    ? value : "dot";
}

export function nextIPMode(mode: IPDisplayMode): IPDisplayMode {
  switch (mode) {
    case "dot": return "full";
    case "full": return "ext";
    case "ext": return "int";
    case "int": return "dot";
  }
}

export function ipModeLabel(mode: IPDisplayMode): string {
  switch (mode) {
    case "dot": return "hidden";
    case "full": return "full global and internal";
    case "ext": return "global last octet";
    case "int": return "internal last octet";
  }
}

function compactAddress(value: string | null): string {
  if (value === null) return "—";
  const parts = value.split(".");
  const isIPv4 = parts.length === 4 && parts.every(part =>
    /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
  // IPv6 has no IPv4 last octet; preserve it rather than inventing a suffix.
  return isIPv4 ? `.${parts[3]}` : value;
}

/**
 * Format normalized IP strings supplied by an adapter; this is not an ingress
 * validator. IPv6 and other non-IPv4 strings remain intact in compact modes.
 * The result is plain text, not HTML, and never changes the source addresses.
 */
export function formatIPDisplay(addresses: IPAddresses, mode: IPDisplayMode): {
  text: string;
  description: string;
} {
  const internal = addresses.internal?.trim() || null;
  const global = addresses.global?.trim() || null;
  if (mode === "dot") {
    return internal !== null || global !== null
      ? { text: "•", description: "IP addresses hidden." }
      : { text: "—", description: "IP addresses not reported." };
  }
  const description = `Global: ${global ?? "not reported"}. Internal: ${internal ?? "not reported"}.`;
  if (mode === "ext") return { text: compactAddress(global), description };
  if (mode === "int") return { text: compactAddress(internal), description };
  return { text: [global, internal].filter(value => value !== null).join(" / ") || "—", description };
}
