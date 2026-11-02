import { parseTreasuryPreflightFailure } from "../contracts/treasury.ts";
import type { TreasuryPreflightCode, TreasuryPreflightFailure } from "../contracts/treasury.ts";

/** Expected preauthorization failure only. Its message is deliberately generic:
 * public copy belongs to the browser's finite code map, never an upstream error. */
export class TreasuryPreflightError extends Error {
  readonly code: TreasuryPreflightCode;
  readonly retryAtMs: number | undefined;
  constructor(code: TreasuryPreflightCode, retryAtMs?: number) {
    super("Wallet preflight could not complete.");
    const failure = parseTreasuryPreflightFailure({ version: 1, kind: "preflight-failure", code,
      ...(retryAtMs === undefined ? {} : { retryAtMs }) });
    this.code = failure.code;
    this.retryAtMs = failure.retryAtMs;
  }
}

/** Never infer a public reason from message text, error-shaped upstream objects,
 * HTTP text or cause chains. Revalidate even trusted instances at this boundary. */
export function treasuryPreflightFailure(error: unknown): TreasuryPreflightFailure {
  if (error instanceof TreasuryPreflightError) {
    try {
      return parseTreasuryPreflightFailure({ version: 1, kind: "preflight-failure", code: error.code,
        ...(error.retryAtMs === undefined ? {} : { retryAtMs: error.retryAtMs }) });
    } catch { /* Malformed known errors get the same safe unknown result. */ }
  }
  return { version: 1, kind: "preflight-failure", code: "preflight-unavailable" };
}
