import { isMetadataAddress } from "./host-metadata.ts";

export const SOL_REFRESH_INTERVAL_MS = 30_000;
export const SOL_DISPLAY_VALIDITY_MS = 60_000;

/** Decimal integer strings preserve all u64 lamports through JSON and sorting. */
export interface SolRecord {
  address: string;
  lamports: string | null;
  provider: string | null;
  endpoint: string | null;
  contextSlot: number | null;
  /** Estimated block time of this provider's oldest batch in this refresh. */
  blockTimeMs: number | null;
  checkedAtMs: number | null;
  validUntilMs: number | null;
  retained: boolean;
  error: string | null;
  retryAtMs: number | null;
}

export interface SolSnapshot {
  hosts: SolRecord[];
  /** Shared upstream deadline; viewers must not invent separate refresh loops. */
  nextRefreshAtMs: number | null;
}

export function isLamports(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d{0,19})$/.test(value) &&
    BigInt(value) <= 18_446_744_073_709_551_615n;
}

export function isSolRecord(value: unknown): value is SolRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!isMetadataAddress(row.address) || !(row.lamports === null || isLamports(row.lamports)) ||
      typeof row.retained !== "boolean") return false;
  for (const key of ["provider", "endpoint", "error"]) {
    if (row[key] !== null && !(typeof row[key] === "string" && row[key].length <= 1024)) return false;
  }
  for (const key of ["contextSlot", "blockTimeMs", "checkedAtMs", "validUntilMs", "retryAtMs"]) {
    if (row[key] !== null && !(typeof row[key] === "number" && Number.isSafeInteger(row[key]) && row[key] >= 0 &&
        (key === "contextSlot" || row[key] <= 8_640_000_000_000_000))) return false;
  }
  if (row.checkedAtMs === null ? row.validUntilMs !== null :
    row.validUntilMs !== (row.checkedAtMs as number) + SOL_DISPLAY_VALIDITY_MS) return false;
  // A balance without its evidence is never a validated reading, including zero.
  return row.lamports === null || [row.provider, row.endpoint, row.contextSlot,
    row.blockTimeMs, row.checkedAtMs, row.validUntilMs].every(field => field !== null);
}

export function formatSol(lamports: string | null | undefined, compact = true): string {
  if (!isLamports(lamports)) return "—";
  const amount = BigInt(lamports);
  if (compact) {
    // Truncate integer lamports so compact amounts never round up across a threshold.
    const thousandths = amount / 1_000_000n;
    return `${thousandths / 1_000n}.${String(thousandths % 1_000n).padStart(3, "0")}`;
  }
  const fraction = String(amount % 1_000_000_000n).padStart(9, "0").replace(/0+$/, "");
  return `${amount / 1_000_000_000n}${fraction ? `.${fraction}` : ""}`;
}

export function compareSolLamports(a: string | null | undefined, b: string | null | undefined): number {
  if (!isLamports(a)) return isLamports(b) ? 1 : 0;
  if (!isLamports(b)) return -1;
  return BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
}
