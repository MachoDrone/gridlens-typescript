/** User-selected labels; preserve the original response separately for details. */
export function statusLabel(raw: string | null | undefined): string | null {
  const value = raw?.trim().toUpperCase() || null;
  return value === "ONBOARDED" ? "COMMUNITY" : value;
}

export function statusTone(raw: string | null | undefined): "premium" | "community" | "rejected" | "unknown" {
  const label = statusLabel(raw);
  return label === "PREMIUM" ? "premium" : label === "COMMUNITY" ? "community" : label === "REJECTED" ? "rejected" : "unknown";
}
