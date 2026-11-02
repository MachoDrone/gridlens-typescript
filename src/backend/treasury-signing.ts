import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import { safeguards, walletBytes } from "./rewards-reader.ts";
import { encodeSignedTransfer, sourcePublicKey, validatedTransferMessage } from "./treasury-transaction.ts";
import type { TransferMessageInput } from "./treasury-transaction.ts";

/** The production key reader is executed only in the verified source container. */
function withNodeKey<T>(work: (key: crypto.KeyObject) => T): T {
  safeguards();
  const home = os.userInfo().homedir;
  if (typeof home !== "string" || !home.startsWith("/") || home.includes("\0")) throw new Error("Invalid node identity.");
  for (const directory of [home, home + "/.nosana"]) {
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid node identity.");
  }
  let fd: number | undefined, secret: Buffer | undefined, der: Buffer | undefined;
  const input = Buffer.alloc(4097);
  try {
    fd = fs.openSync(home + "/.nosana/nosana_key.json", fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size < 1 || info.size > 4096) throw new Error("Invalid node identity.");
    let used = 0;
    for (;;) { const size = fs.readSync(fd, input, used, input.length - used, null); if (!size) break; used += size; if (used === input.length) throw new Error("Invalid node identity."); }
    secret = walletBytes(input, used);
    der = Buffer.alloc(48); Buffer.from("302e020100300506032b657004220420", "hex").copy(der); secret.copy(der, 16, 0, 32);
    const key = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    const publicBytes = crypto.createPublicKey(key).export({ type: "spki", format: "der" }).subarray(-32);
    if (!publicBytes.equals(secret.subarray(32))) throw new Error("Invalid node identity.");
    return work(key);
  } finally {
    input.fill(0); secret?.fill(0); der?.fill(0); if (fd !== undefined) fs.closeSync(fd);
    // OpenSSL/V8 copies may survive until this short-lived process exits.
  }
}
/** Validates/reconstructs the allowlisted message before opening a key. No network or broadcast path. */
export async function signPilotTransfer(input: TransferMessageInput, keyReader = withNodeKey): Promise<{transactionBase64:string;signature:string}> {
  const transaction = await validatedTransferMessage(input);
  return keyReader(key => {
    const actual = crypto.createPublicKey(key).export({ type: "spki", format: "der" });
    if (!actual.equals(sourcePublicKey(input.sourceAddress).export({ type: "spki", format: "der" }))) throw new Error("Source identity changed.");
    const signature = crypto.sign(null, Buffer.from(transaction.messageBytes), key);
    try { return encodeSignedTransfer(transaction, input.sourceAddress, signature); } finally { signature.fill(0); }
  });
}
