import { address, getBase58Encoder } from "@solana/kit";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { isMetadataAddress } from "../fleet/host-metadata.ts";
import { NOS_MINT } from "../fleet/nos.ts";
import { isClaimSignature } from "./rewards-claimer.ts";
import type { ClaimsReceipt, ClaimsReconcileInput } from "./treasury-claims.ts";

const SYSTEM = "11111111111111111111111111111111";
const COMPUTE = "ComputeBudget111111111111111111111111111111";
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const atoms = (value: unknown): bigint => {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > 18_446_744_073_709_551_615n
  )
    throw Error();
  return BigInt(value);
};
interface Parsed {
  programId: string;
  type: string;
  info: Record<string, unknown>;
}
function instruction(value: unknown): Parsed | null {
  if (
    !object(value) ||
    typeof value.programId !== "string" ||
    !object(value.parsed) ||
    typeof value.parsed.type !== "string" ||
    !object(value.parsed.info)
  )
    return null;
  return {
    programId: value.programId,
    type: value.parsed.type,
    info: value.parsed.info,
  };
}
function computeBudget(value: unknown): number | null {
  if (
    !object(value) ||
    value.programId !== COMPUTE ||
    !Array.isArray(value.accounts) ||
    value.accounts.length ||
    typeof value.data !== "string" ||
    value.data.length > 32
  )
    return null;
  try {
    const bytes = getBase58Encoder().encode(value.data);
    return ((bytes[0] === 1 || bytes[0] === 2) && bytes.length === 5) ||
      (bytes[0] === 3 && bytes.length === 9)
      ? bytes[0]!
      : null;
  } catch {
    return null;
  }
}
function ataInner(
  value: unknown,
  ataIndex: number,
  ata: Parsed,
  created: boolean,
): boolean {
  if (value === null || (Array.isArray(value) && value.length === 0))
    return !created;
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    !object(value[0]) ||
    value[0].index !== ataIndex ||
    !Array.isArray(value[0].instructions)
  )
    return false;
  const rows = value[0].instructions;
  if (!rows.length) return !created;
  if (!created || rows.length < 2 || rows.length > 4) return false;
  const parsed: Parsed[] = [];
  for (const row of rows) {
    if (
      !object(row) ||
      (row.stackHeight !== undefined && row.stackHeight !== 2)
    )
      return false;
    const entry = instruction(row);
    if (!entry) return false;
    parsed.push(entry);
  }
  let at = 0;
  if (
    parsed[at]?.programId === TOKEN_PROGRAM_ADDRESS &&
    parsed[at]?.type === "getAccountDataSize"
  ) {
    const info = parsed[at++]!.info;
    if (
      info.mint !== NOS_MINT ||
      (info.extensionTypes !== undefined &&
        (!Array.isArray(info.extensionTypes) ||
          info.extensionTypes.length > 1 ||
          info.extensionTypes.some((item) => item !== "immutableOwner")))
    )
      return false;
  }
  const create = parsed[at++];
  if (
    !create ||
    create.programId !== SYSTEM ||
    create.type !== "createAccount" ||
    create.info.source !== ata.info.source ||
    create.info.newAccount !== ata.info.account ||
    create.info.owner !== TOKEN_PROGRAM_ADDRESS ||
    create.info.space !== 165 ||
    (typeof create.info.lamports !== "string" &&
      typeof create.info.lamports !== "number")
  )
    return false;
  const rent = create.info.lamports;
  if (
    typeof rent === "number"
      ? !Number.isSafeInteger(rent) || rent <= 0
      : !/^\d+$/.test(rent) || BigInt(rent) <= 0n
  )
    return false;
  if (
    parsed[at]?.programId === TOKEN_PROGRAM_ADDRESS &&
    parsed[at]?.type === "initializeImmutableOwner"
  ) {
    if (parsed[at++]!.info.account !== ata.info.account) return false;
  }
  const initialize = parsed[at++];
  return (
    at === parsed.length &&
    !!initialize &&
    initialize.programId === TOKEN_PROGRAM_ADDRESS &&
    initialize.type === "initializeAccount3" &&
    initialize.info.account === ata.info.account &&
    initialize.info.mint === NOS_MINT &&
    initialize.info.owner === ata.info.wallet
  );
}

/** This validates an external API-acknowledged payout, not a transaction created
 * by GridLens. The own-transfer exact-wire validator remains separate. */
export async function verifyClaimReceipt(
  input: ClaimsReconcileInput,
  result: unknown,
  observedAtMs: number,
): Promise<ClaimsReceipt> {
  const unknown: ClaimsReceipt = { status: "uncertain", observedAtMs };
  try {
    const { quote, dispatch } = input;
    if (
      dispatch.status !== "acknowledged" ||
      dispatch.success !== true ||
      !isClaimSignature(dispatch.signature) ||
      dispatch.claimedAmountAtoms === undefined ||
      atoms(dispatch.claimedAmountAtoms) <= 0n ||
      quote.mintAddress !== NOS_MINT ||
      quote.decimals !== 6 ||
      !isMetadataAddress(quote.sourceAddress)
    )
      return unknown;
    const [expectedAta] = await findAssociatedTokenPda({
      owner: address(quote.sourceAddress),
      mint: address(NOS_MINT),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    if (
      quote.sourceTokenAddress !== expectedAta ||
      !object(result) ||
      !Number.isSafeInteger(result.slot) ||
      Number(result.slot) < 1 ||
      !(["legacy", 0] as unknown[]).includes(result.version) ||
      !object(result.transaction) ||
      !object(result.meta)
    )
      return unknown;
    const transaction = result.transaction,
      meta = result.meta,
      slot = Number(result.slot);
    if (
      !Array.isArray(transaction.signatures) ||
      transaction.signatures.length < 1 ||
      transaction.signatures.length > 16 ||
      transaction.signatures[0] !== dispatch.signature ||
      transaction.signatures.some((value) => !isClaimSignature(value)) ||
      !("err" in meta)
    )
      return unknown;
    if (meta.err !== null) return { status: "failed", observedAtMs, slot };
    if (
      !object(transaction.message) ||
      !Array.isArray(transaction.message.accountKeys) ||
      transaction.message.accountKeys.length > 256 ||
      !Array.isArray(transaction.message.instructions) ||
      transaction.message.instructions.length < 1 ||
      transaction.message.instructions.length > 6
    )
      return unknown;
    const keys = transaction.message.accountKeys;
    if (
      keys.some(
        (key) =>
          !object(key) ||
          !isMetadataAddress(key.pubkey) ||
          typeof key.signer !== "boolean" ||
          typeof key.writable !== "boolean",
      ) ||
      new Set(keys.map((key) => (key as Record<string, unknown>).pubkey))
        .size !== keys.length ||
      keys.filter((key) => (key as Record<string, unknown>).signer === true)
        .length !== transaction.signatures.length
    )
      return unknown;
    const keyRows = keys as {
      pubkey: string;
      signer: boolean;
      writable: boolean;
    }[];
    const signers = new Set(
      keyRows.filter((key) => key.signer).map((key) => key.pubkey),
    );
    let transfer: Parsed | undefined,
      ata: Parsed | undefined,
      ataIndex = -1;
    const computeTags = new Set<number>();
    for (const [index, row] of transaction.message.instructions.entries()) {
      const computeTag = computeBudget(row);
      if (computeTag !== null) {
        if (computeTags.has(computeTag) || computeTags.size >= 3)
          return unknown;
        computeTags.add(computeTag);
        continue;
      }
      const parsed = instruction(row);
      if (!parsed) return unknown;
      if (
        parsed.programId === ASSOCIATED_TOKEN_PROGRAM_ADDRESS &&
        ["create", "createIdempotent"].includes(parsed.type)
      ) {
        if (
          ata ||
          transfer ||
          parsed.info.account !== expectedAta ||
          parsed.info.wallet !== quote.sourceAddress ||
          parsed.info.mint !== NOS_MINT ||
          parsed.info.systemProgram !== SYSTEM ||
          parsed.info.tokenProgram !== TOKEN_PROGRAM_ADDRESS ||
          typeof parsed.info.source !== "string" ||
          !signers.has(parsed.info.source)
        )
          return unknown;
        ata = parsed;
        ataIndex = index;
        continue;
      }
      if (
        parsed.programId !== TOKEN_PROGRAM_ADDRESS ||
        transfer ||
        !["transfer", "transferChecked"].includes(parsed.type)
      )
        return unknown;
      if (
        !isMetadataAddress(parsed.info.source) ||
        parsed.info.source === expectedAta ||
        parsed.info.destination !== expectedAta ||
        typeof parsed.info.authority !== "string" ||
        !signers.has(parsed.info.authority)
      )
        return unknown;
      const amount =
        parsed.type === "transfer"
          ? atoms(parsed.info.amount)
          : object(parsed.info.tokenAmount) &&
              parsed.info.tokenAmount.decimals === 6 &&
              parsed.info.mint === NOS_MINT
            ? atoms(parsed.info.tokenAmount.amount)
            : -1n;
      if (amount !== atoms(dispatch.claimedAmountAtoms)) return unknown;
      transfer = parsed;
    }
    if (
      !transfer ||
      !Array.isArray(meta.preTokenBalances) ||
      !Array.isArray(meta.postTokenBalances) ||
      meta.preTokenBalances.length > 2 ||
      meta.postTokenBalances.length !== 2
    )
      return unknown;
    const sourceIndex = keyRows.findIndex(
        (key) => key.pubkey === transfer!.info.source,
      ),
      destinationIndex = keyRows.findIndex((key) => key.pubkey === expectedAta);
    if (
      sourceIndex < 0 ||
      destinationIndex < 0 ||
      !keyRows[sourceIndex]!.writable ||
      !keyRows[destinationIndex]!.writable
    )
      return unknown;
    const balances = (
      rows: unknown[],
    ): Map<number, { amount: bigint; owner: string }> => {
      const values = new Map<number, { amount: bigint; owner: string }>();
      for (const row of rows) {
        if (
          !object(row) ||
          ![sourceIndex, destinationIndex].includes(Number(row.accountIndex)) ||
          typeof row.accountIndex !== "number" ||
          values.has(row.accountIndex) ||
          row.mint !== NOS_MINT ||
          row.programId !== TOKEN_PROGRAM_ADDRESS ||
          !isMetadataAddress(row.owner) ||
          !object(row.uiTokenAmount) ||
          row.uiTokenAmount.decimals !== 6
        )
          throw Error();
        values.set(row.accountIndex, {
          amount: atoms(row.uiTokenAmount.amount),
          owner: row.owner,
        });
      }
      return values;
    };
    const before = balances(meta.preTokenBalances),
      after = balances(meta.postTokenBalances),
      sourceBefore = before.get(sourceIndex),
      sourceAfter = after.get(sourceIndex),
      destinationBefore = before.get(destinationIndex),
      destinationAfter = after.get(destinationIndex),
      paid = atoms(dispatch.claimedAmountAtoms);
    if (
      !sourceBefore ||
      !sourceAfter ||
      !destinationAfter ||
      sourceBefore.owner !== sourceAfter.owner ||
      sourceBefore.amount - sourceAfter.amount !== paid ||
      destinationAfter.owner !== quote.sourceAddress ||
      (destinationBefore && destinationBefore.owner !== quote.sourceAddress) ||
      destinationAfter.amount - (destinationBefore?.amount ?? 0n) !== paid ||
      (!destinationBefore && !ata)
    )
      return unknown;
    if (ata) {
      if (!ataInner(meta.innerInstructions, ataIndex, ata, !destinationBefore))
        return unknown;
    } else if (
      meta.innerInstructions !== null &&
      (!Array.isArray(meta.innerInstructions) ||
        meta.innerInstructions.length !== 0)
    )
      return unknown;
    return {
      status: "confirmed",
      observedAtMs,
      slot,
      paidAmountBaseUnits: paid.toString(),
      payoutOwner: quote.sourceAddress,
      payoutTokenAddress: expectedAta,
      mintAddress: NOS_MINT,
    };
  } catch {
    return unknown;
  }
}
