// Copyright (c) 2026 MachoDrone. MIT license; see LICENSE.
// Compact and expanded NVIDIA, System and CPU display values.

export type HardwareColumn = "nvidia" | "cpu" | "system";
export type HardwareDisplayMode = "compact" | "expanded";

export interface HardwareDisplay {
  readonly text: string;
  /** Complete reported text for sorting and details, independent of display mode. */
  readonly fullValue: string | null;
}

export function normalizeHardwareMode(value: unknown): HardwareDisplayMode {
  return value === "expanded" ? "expanded" : "compact";
}

export function nextHardwareMode(mode: HardwareDisplayMode): HardwareDisplayMode {
  return mode === "compact" ? "expanded" : "compact";
}

function compactHardwareValue(column: HardwareColumn, value: string): string {
  switch (column) {
    case "nvidia": return value.split(".")[0] ?? value;
    case "system": return value.split("-")[0] ?? value;
    case "cpu": return value.match(/\b\d+(?:th|st|nd|rd)\b/i)?.[0]
      ?? value.match(/\b(?:AMD|Intel|ARM|Apple)\b/i)?.[0]
      ?? value.split(/\s+/)[0] ?? value;
  }
}

/** Display reported values as plain text without numeric parsing or source I/O. */
export function formatHardwareDisplay(
  column: HardwareColumn,
  value: string | null,
  mode: HardwareDisplayMode,
): HardwareDisplay {
  const fullValue = value?.trim() || null;
  if (fullValue === null) return { text: "—", fullValue: null };
  const compact = compactHardwareValue(column, fullValue).trim() || fullValue;
  return { text: mode === "expanded" ? fullValue : compact, fullValue };
}
