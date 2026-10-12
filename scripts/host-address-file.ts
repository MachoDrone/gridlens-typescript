import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const base58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export interface HostAddressInput {
  addresses: string[];
  error: string | null;
}

/** Select an operator-supplied input without accessing or creating any files. */
export function hostAddressFilePath({
  hostsFile,
  environment = process.env,
  homeDirectory = homedir(),
}: {
  hostsFile?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  homeDirectory?: string;
} = {}): string {
  return resolve(hostsFile ?? environment.GRIDLENS_HOSTS_FILE ??
    join(homeDirectory, ".local/share/gridlens-typescript/hosts.json"));
}

/** A separate fixed external roster; HTTP requests cannot choose this path. */
export function real200HostAddressFilePath({
  hostsFile,
  environment = process.env,
  homeDirectory = homedir(),
}: {
  hostsFile?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  homeDirectory?: string;
} = {}): string {
  return resolve(hostsFile ?? environment.GRIDLENS_REAL200_HOSTS_FILE ??
    join(homeDirectory, ".local/share/gridlens-typescript/real200.json"));
}

function isPublicAddress(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  let decoded = 0n;
  for (const character of value) decoded = decoded * 58n + BigInt(base58.indexOf(character));
  let bytes = 0;
  while (decoded > 0n) {
    decoded >>= 8n;
    bytes++;
  }
  // Base58's leading '1' characters each represent a zero byte.
  for (const character of value) {
    if (character !== "1") break;
    bytes++;
  }
  return bytes === 32;
}

/** Read exactly once. Invalid inputs never produce partial rows or a fallback. */
export function loadHostAddressFile(path: string): HostAddressInput {
  const failure = (message: string): HostAddressInput => ({
    addresses: [],
    error: `Host Address file ${JSON.stringify(path)}: ${message} Edit the supplied file and restart the preview.`,
  });
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "read error";
    if (code === "ENOENT") return failure("Input is missing (ENOENT).");
    return failure(`Cannot read input (${code}).`);
  }
  let addresses: unknown;
  try {
    addresses = JSON.parse(source);
  } catch {
    return failure("Invalid JSON; expected an array of public addresses.");
  }
  if (!Array.isArray(addresses)) return failure("Invalid input; expected a JSON array of public addresses.");
  const seen = new Set<string>();
  for (const [index, address] of addresses.entries()) {
    if (!isPublicAddress(address)) {
      return failure(`Invalid input. Entry ${index + 1} must be a base58 public address decoding to 32 bytes.`);
    }
    if (seen.has(address)) return failure(`Invalid input. Entry ${index + 1} repeats an earlier address.`);
    seen.add(address);
  }
  return { addresses: [...seen], error: null };
}
