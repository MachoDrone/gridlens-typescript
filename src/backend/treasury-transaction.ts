import { address, appendTransactionMessageInstructions, blockhash, compileTransaction, createNoopSigner,
  createTransactionMessage, getAddressEncoder, getBase58Decoder, getTransactionDecoder, getTransactionEncoder,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, signatureBytes } from "@solana/kit";
import type { Transaction } from "@solana/kit";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { createPublicKey, verify } from "node:crypto";

export const TREASURY_NOS_MINT = "nosXBVoaCTtYdLvKY6Csb4AC8JCdQKKAaWYtx2ZMoo7";
export const TREASURY_AMOUNT = "1000000";
export const TREASURY_RESERVE = "50000000";
export const TREASURY_MAX_COST = "5000000";
export interface TransferMessageInput {
  sourceAddress: string; destinationAddress: string; sourceTokenAddress: string; destinationTokenAddress: string;
  mintAddress: string; amountBaseUnits: string; decimals: number; createDestinationAta: boolean;
  blockhash: string; lastValidBlockHeight: number; messageBase64: string;
}
export function canonicalBase64(value: unknown, maximum = 1232): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(maximum / 3) * 4 || !value.length
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("Invalid transaction encoding.");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > maximum || bytes.toString("base64") !== value) throw new Error("Invalid transaction encoding.");
  return bytes;
}
export async function transferAccounts(sourceAddress: string, destinationAddress: string): Promise<{sourceTokenAddress:string;destinationTokenAddress:string}> {
  const source = address(sourceAddress), destination = address(destinationAddress), mint = address(TREASURY_NOS_MINT);
  if (source === destination) throw new Error("Choose a receiving wallet different from the source host.");
  const [[sourceTokenAddress], [destinationTokenAddress]] = await Promise.all([
    findAssociatedTokenPda({ owner: source, tokenProgram: TOKEN_PROGRAM_ADDRESS, mint }),
    findAssociatedTokenPda({ owner: destination, tokenProgram: TOKEN_PROGRAM_ADDRESS, mint }),
  ]);
  return { sourceTokenAddress, destinationTokenAddress };
}
/** Build the entire allowlist; no arbitrary caller-supplied instruction is accepted. */
export async function transferTransaction(input: Omit<TransferMessageInput, "messageBase64">): Promise<Transaction> {
  if (input.mintAddress !== TREASURY_NOS_MINT || input.amountBaseUnits !== TREASURY_AMOUNT || input.decimals !== 6
    || typeof input.createDestinationAta !== "boolean" || !Number.isSafeInteger(input.lastValidBlockHeight) || input.lastValidBlockHeight <= 0)
    throw new Error("Only the exact 1 NOS pilot transaction is supported.");
  const accounts = await transferAccounts(input.sourceAddress, input.destinationAddress);
  if (accounts.sourceTokenAddress !== input.sourceTokenAddress || accounts.destinationTokenAddress !== input.destinationTokenAddress)
    throw new Error("The NOS account does not match the reviewed wallet.");
  const source = address(input.sourceAddress), authority = createNoopSigner(source), mint = address(TREASURY_NOS_MINT);
  const instructions = [
    ...(input.createDestinationAta ? [getCreateAssociatedTokenIdempotentInstruction({ payer: authority,
      ata: address(input.destinationTokenAddress), owner: address(input.destinationAddress), mint, tokenProgram: TOKEN_PROGRAM_ADDRESS })] : []),
    getTransferCheckedInstruction({ source: address(input.sourceTokenAddress), mint, destination: address(input.destinationTokenAddress),
      authority, amount: 1_000_000n, decimals: 6 }),
  ];
  return compileTransaction(appendTransactionMessageInstructions(instructions,
    setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(input.blockhash), lastValidBlockHeight: BigInt(input.lastValidBlockHeight) },
      setTransactionMessageFeePayer(source, createTransactionMessage({ version: "legacy" })))));
}
export async function validatedTransferMessage(input: TransferMessageInput): Promise<Transaction> {
  const transaction = await transferTransaction(input);
  if (!Buffer.from(transaction.messageBytes).equals(canonicalBase64(input.messageBase64))) throw new Error("The transaction differs from the reviewed 1 NOS transfer.");
  if (Object.keys(transaction.signatures).length !== 1 || !(input.sourceAddress in transaction.signatures)) throw new Error("Invalid transfer signer.");
  return transaction;
}
export function signatureText(bytes: Uint8Array): string { return getBase58Decoder().decode(bytes); }
export function sourcePublicKey(sourceAddress: string) {
  return createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"),
    Buffer.from(getAddressEncoder().encode(address(sourceAddress)))]), format: "der", type: "spki" });
}
export async function validateSignedTransfer(input: TransferMessageInput, transactionBase64: string, signature: string): Promise<Transaction> {
  const expected = await validatedTransferMessage(input), wire = canonicalBase64(transactionBase64);
  const transaction = getTransactionDecoder().decode(wire);
  if (!Buffer.from(getTransactionEncoder().encode(transaction)).equals(wire)
    || !Buffer.from(transaction.messageBytes).equals(Buffer.from(expected.messageBytes)) || Object.keys(transaction.signatures).length !== 1)
    throw new Error("Signed transaction differs from the reviewed transfer.");
  const signed = transaction.signatures[address(input.sourceAddress)];
  if (!signed || signatureText(signed) !== signature || !verify(null, Buffer.from(transaction.messageBytes), sourcePublicKey(input.sourceAddress), signed))
    throw new Error("Invalid source-wallet transaction signature.");
  return transaction;
}
export function encodeSignedTransfer(transaction: Transaction, owner: string, signature: Buffer): {transactionBase64:string;signature:string} {
  if (signature.length !== 64) throw new Error("Invalid source-wallet signature.");
  const signed = { ...transaction, signatures: { [address(owner)]: signatureBytes(signature) } };
  return { transactionBase64: Buffer.from(getTransactionEncoder().encode(signed)).toString("base64"), signature: signatureText(signature) };
}
