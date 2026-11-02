import { signPilotTransfer } from "./treasury-signing.ts";
// A bundled CommonJS helper, invoked with a fixed marker only inside a verified node.
// Input contains public review fields and unsigned bytes, never a key or arbitrary path.
async function main(): Promise<void> {
  if (process.argv.length !== 3 || process.argv[1] !== "--gridlens-one-nos-transfer" || process.argv[2]!.length > 16_384) throw new Error();
  const input: unknown = JSON.parse(process.argv[2]!);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error();
  const result = await signPilotTransfer(input as Parameters<typeof signPilotTransfer>[0]);
  process.stdout.write(JSON.stringify(result), () => process.exit(0));
}
void main().catch(() => { process.exitCode = 1; });
