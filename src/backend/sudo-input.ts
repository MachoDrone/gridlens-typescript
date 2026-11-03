import { randomBytes } from "node:crypto";
import { shellQuote } from "./ssh.ts";
/** sudo may or may not consume a password line. A fixed child consumes the
 * remaining framing before passing exact binary input to the approved command. */
export function framedSudoInput(command: string, input: string | Uint8Array | undefined, password: string) {
  if (/[\r\n\0]/.test(password)) throw new Error("Administrator input requires one password line.");
  const marker = `gridlens-input-${randomBytes(24).toString("hex")}`;
  const script = `IFS= read -r gridlens_frame || exit 64\nif [ "$gridlens_frame" != ${shellQuote(marker)} ]; then IFS= read -r gridlens_frame || exit 64; fi\n[ "$gridlens_frame" = ${shellQuote(marker)} ] || exit 64\nunset gridlens_frame\nexec ${command}`;
  return { command: `/usr/bin/sudo -S -p '' -- /bin/sh -c ${shellQuote(script)}`, script,
    input: Buffer.concat([Buffer.from(password + "\n" + marker + "\n"), input === undefined ? Buffer.alloc(0) : Buffer.from(input)]) };
}
