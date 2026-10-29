// Copyright (c) 2026 MachoDrone. MIT license; see LICENSE.
// Saved compact and full IP display modes for the Fleet table.

export type IPDisplayMode = "dot" | "full" | "public-full" | "ext" | "private-full" | "int";
const IP_MODES: readonly IPDisplayMode[] = ["dot", "full", "public-full", "ext", "private-full", "int"];

export interface IPAddresses {
  readonly internal: string | null;
  readonly global: string | null;
}

export function normalizeIPMode(value: unknown): IPDisplayMode {
  return IP_MODES.find(mode => mode === value) ?? "dot";
}

export function nextIPMode(mode: IPDisplayMode): IPDisplayMode {
  return IP_MODES[(IP_MODES.indexOf(mode) + 1) % IP_MODES.length]!;
}

export function ipModeLabel(mode: IPDisplayMode): string {
  switch (mode) {
    case "dot": return "hidden";
    case "full": return "both full addresses";
    case "public-full": return "external IP / NAT";
    case "ext": return "external last octet";
    case "private-full": return "internal IP";
    case "int": return "internal last octet";
  }
}

function compactAddress(value: string | null): string {
  if (value === null) return "−";
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
  if (mode === "dot") return { text: "•", description: "IP addresses hidden." };
  const description = `External/public: ${global ?? "not reported"}. Internal/private: ${internal ?? "not reported"}.`;
  if (mode === "public-full") return { text: global ?? "−", description };
  if (mode === "private-full") return { text: internal ?? "−", description };
  if (mode === "ext") return { text: compactAddress(global), description };
  if (mode === "int") return { text: compactAddress(internal), description };
  return { text: `${global ?? "−"} / ${internal ?? "−"}`, description };
}
