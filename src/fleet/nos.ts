import { isMetadataAddress } from "./host-metadata.ts";
import { isLamports } from "./sol.ts";

/** Official NOS mint, classic SPL Token, six decimal places. */
export const NOS_MINT = "nosXBVoaCTtYdLvKY6Csb4AC8JCdQKKAaWYtx2ZMoo7";
export const NOS_REFRESH_INTERVAL_MS = 120_000;
export const NOS_DISPLAY_VALIDITY_MS = 180_000;

/** The associated token account only; other owned NOS accounts are not summed. */
export interface NosRecord {
  address: string;
  tokenAccount: string | null;
  mint: string;
  amount: string | null;
  decimals: 6;
  accountState: "absent" | "initialized" | "frozen" | null;
  provider: string | null;
  endpoint: string | null;
  contextSlot: number | null;
  blockTimeMs: number | null;
  checkedAtMs: number | null;
  validUntilMs: number | null;
  retained: boolean;
  error: string | null;
  retryAtMs: number | null;
}
export interface NosSnapshot {
  hosts: NosRecord[];
  nextRefreshAtMs: number | null;
}

export function isNosAmount(value: unknown): value is string {
  return isLamports(value);
}
export function isNosRecord(value: unknown): value is NosRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!isMetadataAddress(row.address) || row.mint !== NOS_MINT || row.decimals !== 6 ||
      !(row.tokenAccount === null || isMetadataAddress(row.tokenAccount)) ||
      !(row.amount === null || isNosAmount(row.amount)) || typeof row.retained !== "boolean" ||
      ![null, "absent", "initialized", "frozen"].includes(row.accountState as string | null)) return false;
  for (const key of ["provider", "endpoint", "error"]) {
    if (row[key] !== null && !(typeof row[key] === "string" && row[key].length <= 1024)) return false;
  }
  for (const key of ["contextSlot", "blockTimeMs", "checkedAtMs", "validUntilMs", "retryAtMs"]) {
    if (row[key] !== null && !(typeof row[key] === "number" && Number.isSafeInteger(row[key]) && row[key] >= 0 &&
        (key === "contextSlot" || row[key] <= 8_640_000_000_000_000))) return false;
  }
  if (row.checkedAtMs === null ? row.validUntilMs !== null :
    row.validUntilMs !== (row.checkedAtMs as number) + NOS_DISPLAY_VALIDITY_MS) return false;
  if (row.accountState === "absent" && row.amount !== "0") return false;
  return row.amount === null ? row.accountState === null :
    [row.tokenAccount, row.accountState, row.provider, row.endpoint, row.contextSlot,
      row.blockTimeMs, row.checkedAtMs, row.validUntilMs].every(field => field !== null);
}

export function formatNos(amount: string | null | undefined, compact = true): string {
  if (!isNosAmount(amount)) return "—";
  const units = BigInt(amount);
  if (compact) return String((units + 500_000n) / 1_000_000n);
  const fraction = String(units % 1_000_000n).padStart(6, "0").replace(/0+$/, "");
  return `${units / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}
export function compareNosAmounts(a: string | null | undefined, b: string | null | undefined): number {
  if (!isNosAmount(a)) return isNosAmount(b) ? 1 : 0;
  if (!isNosAmount(b)) return -1;
  return BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
}
