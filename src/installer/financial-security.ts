/** Installer-owned protocol selection. The retained floor is outside observation
 * snapshots; old coordinators reject schema 2 before replacing any runtime. */
export type TreasuryProtocol = 0 | 1 | 2;
export const FINANCIAL_SECURITY_PROTOCOL_LABEL = "io.gridlens.financial-security-protocol";
export const GUARDIAN_PROTOCOL_LABEL = "io.gridlens.guardian-protocol";
export interface FinancialSecurityFloor { protocol: 1; minimumTreasuryProtocol: 2; minimumCoordinator: 3 }
export const FINANCIAL_SECURITY_FLOOR: FinancialSecurityFloor = Object.freeze({ protocol: 1, minimumTreasuryProtocol: 2, minimumCoordinator: 3 });
export function walletReleaseProtocol(options: { enableWallet?: boolean; treasuryProtocol?: 1 | 2 }): TreasuryProtocol {
  if (options.treasuryProtocol !== undefined && (!options.enableWallet || ![1, 2].includes(options.treasuryProtocol))) throw new Error("Select Wallet and treasury protocol 1 (compatibility) or 2 (protected).");
  return options.enableWallet ? options.treasuryProtocol ?? 2 : 0;
}
export const walletMinimumCoordinator = (protocol: TreasuryProtocol): 1 | 2 | 3 => protocol === 2 ? 3 : protocol === 1 ? 2 : 1;
export function validFinancialFloor(value: unknown): value is FinancialSecurityFloor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.protocol === 1 && row.minimumTreasuryProtocol === 2 && row.minimumCoordinator === 3
    && Object.keys(row).sort().join("|") === "minimumCoordinator|minimumTreasuryProtocol|protocol";
}
