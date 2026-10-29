import { compareNosAmounts, isNosAmount } from "./nos.ts";
import { compareSolLamports } from "./sol.ts";
import { compareStakingAmounts, isStakingAmount } from "./staking.ts";

// Copyright (c) 2026 MachoDrone. MIT license; see LICENSE.
// Internal presentation model only; values come from the caller's evidence.

export const COLUMN_TYPES = Object.freeze({
  stakedNos: "num",
  status: "string",
  pc: "string",
  ip: "string",
  hostAddress: "string",
  sol: "num",
  api: "string",
  state: "string",
  queued: "string",
  duration: "num",
  nodeRuntime: "num",
  dailyUptime: "num",
  latestJob: "string",
  ram: "num",
  disk: "num",
  dl: "num",
  ul: "num",
  ping: "num",
  rewards: "num",
  nos: "num",
  market: "string",
  gpuID: "num",
  currentNode: "string",
  cuda: "string",
  nvidia: "string",
  cpu: "string",
  system: "string",
  country: "string",
} as const);

export type SortColumn = keyof typeof COLUMN_TYPES;

export interface FleetSort {
  readonly column: SortColumn;
  readonly direction: "asc" | "desc";
}

export interface SortableFleetRow {
  readonly pc: string;
  /** Verified physical GPU index, not a container-visible index. */
  readonly gpuIndex: number | null;
  readonly containerName: string;
  /** Exact SOL evidence when available; legacy numeric sample values stay separate. */
  readonly solLamports?: string | null;
  /** Exact NOS base units in the host’s standard associated token account. */
  readonly nosAmount?: string | null;
  /** Exact NOS base units currently held in the staking vault. */
  readonly stakedNosAmount?: string | null;
  /** Exact six-decimal claimable uptime reward base units, independent of other NOS balances. */
  readonly rewardAmount?: string | null;
  readonly values: Readonly<Partial<Record<SortColumn, string | number | null>>>;
}

export const DEFAULT_SORT: FleetSort = Object.freeze({ column: "pc", direction: "asc" });

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Missing readings remain last even when the selected direction is descending. */
function compareValues(
  left: number | string | null,
  right: number | string | null,
  direction: FleetSort["direction"] = "asc",
): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  const result = typeof left === "number" && typeof right === "number"
    ? left < right ? -1 : left > right ? 1 : 0
    : collator.compare(String(left), String(right));
  return direction === "desc" ? -result : result;
}

export function nextFleetSort(current: FleetSort, column: SortColumn): FleetSort {
  return {
    column,
    direction: current.column === column && current.direction === "asc" ? "desc" : "asc",
  };
}

/** Sort a copy without changing observations, row identities or source order. */
export function sortFleetRows<T extends SortableFleetRow>(
  rows: readonly T[],
  sort: FleetSort,
): T[] {
  const normalize = COLUMN_TYPES[sort.column] === "num" ? numberValue : stringValue;
  return rows.map((row, index) => ({ row, index })).sort((left, right) => {
    const a = left.row;
    const b = right.row;
    // SOL values carry integer lamport strings, so differences below a float's
    // precision and rounded display remain meaningful. Unknown stays last in both directions.
    const leftSol = a.solLamports ?? null;
    const rightSol = b.solLamports ?? null;
    const leftNos = isNosAmount(a.nosAmount) ? a.nosAmount : null;
    const rightNos = isNosAmount(b.nosAmount) ? b.nosAmount : null;
    const leftStaked = isStakingAmount(a.stakedNosAmount) ? a.stakedNosAmount : null;
    const rightStaked = isStakingAmount(b.stakedNosAmount) ? b.stakedNosAmount : null;
    const comparison = sort.column === "rewards" && (a.rewardAmount !== undefined || b.rewardAmount !== undefined)
      ? compareNosAmounts(a.rewardAmount ?? null, b.rewardAmount ?? null) * (sort.direction === "desc" && a.rewardAmount != null && b.rewardAmount != null ? -1 : 1)
      : sort.column === "sol" && (a.solLamports !== undefined || b.solLamports !== undefined)
      ? compareSolLamports(leftSol, rightSol) * (sort.direction === "desc" && leftSol !== null && rightSol !== null ? -1 : 1)
      : sort.column === "nos" && (a.nosAmount !== undefined || b.nosAmount !== undefined)
        ? compareNosAmounts(leftNos, rightNos) * (sort.direction === "desc" && leftNos !== null && rightNos !== null ? -1 : 1)
      : sort.column === "stakedNos" && (a.stakedNosAmount !== undefined || b.stakedNosAmount !== undefined)
        ? compareStakingAmounts(leftStaked, rightStaked) * (sort.direction === "desc" && leftStaked !== null && rightStaked !== null ? -1 : 1)
      : compareValues(normalize(a.values[sort.column]), normalize(b.values[sort.column]), sort.direction);
    return comparison ||
      compareValues(stringValue(a.pc), stringValue(b.pc)) ||
      compareValues(numberValue(a.gpuIndex), numberValue(b.gpuIndex)) ||
      compareValues(stringValue(a.containerName), stringValue(b.containerName)) ||
      left.index - right.index;
  }).map(({ row }) => row);
}

/** Decode an optional browser preference. Invalid storage never blocks the view. */
export function parseSortPreference(raw: string | null): FleetSort {
  if (raw === null) return DEFAULT_SORT;
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return DEFAULT_SORT;
    if (!("column" in value) || !("direction" in value)) return DEFAULT_SORT;
    const { column, direction } = value;
    if (typeof column !== "string" || !Object.hasOwn(COLUMN_TYPES, column) ||
      (direction !== "asc" && direction !== "desc")) return DEFAULT_SORT;
    return { column: column as SortColumn, direction };
  } catch {
    return DEFAULT_SORT;
  }
}
