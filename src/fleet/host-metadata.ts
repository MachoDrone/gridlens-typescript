/** The selected public backend fields; no local inventory or device mapping. */
export interface HostMetadataValues {
  status: string | null;
  marketAddress: string | null;
  marketLabel: string | null;
  ram: number | null;
  disk: number | null;
  cpu: string | null;
  cuda: string | null;
  nvidia: string | null;
  currentNode: string | null;
  system: string | null;
  /** Reported country text; older snapshots may omit this optional observation. */
  country?: string | null;
}

export interface HostMetadataRecord {
  address: string;
  values: HostMetadataValues | null;
  /** Time this preview fetched metrics, never a host heartbeat or measurement time. */
  fetchedAtMs: number | null;
  retained: boolean;
  error: string | null;
  marketError: string | null;
}

export interface HostMetadataSnapshot {
  hosts: HostMetadataRecord[];
}

const base58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Validate provider identities before constructing any fixed-origin URL. */
export function isMetadataAddress(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  let decoded = 0n;
  for (const character of value) decoded = decoded * 58n + BigInt(base58.indexOf(character));
  let bytes = 0;
  while (decoded > 0n) {
    decoded >>= 8n;
    bytes++;
  }
  for (const character of value) {
    if (character !== "1") break;
    bytes++;
  }
  return bytes === 32;
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function text(value: unknown, limit = 256): string | null {
  if (typeof value !== "string" || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return value.trim() || null;
}

function nonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Copy only the explicitly selected fields, with no inference or raw payload retention. */
export function normalizeHostMetadata(address: string, payload: unknown): HostMetadataValues {
  const host = object(payload);
  if (!isMetadataAddress(address) || host.nodeAddress !== address) {
    throw new Error("Nosana metrics response did not match the requested Host Address.");
  }
  const metrics = object(host.metrics);
  const cpu = object(metrics.cpu);
  const gpu = object(metrics.gpu);
  const network = object(metrics.network);
  return {
    status: text(host.status, 64),
    marketAddress: isMetadataAddress(host.marketAddress) ? host.marketAddress : null,
    marketLabel: null,
    ram: nonnegative(metrics.ram_gb),
    disk: nonnegative(metrics.disk_gb),
    cpu: text(cpu.cpu_model),
    cuda: text(gpu.cuda_driver_version, 64),
    nvidia: text(gpu.nvml_driver_version, 64),
    currentNode: text(metrics.package_version, 64),
    system: text(metrics.system_environment),
    country: text(network.country) ?? text(metrics.country),
  };
}

/** Prefer the market slug; name is a readable fallback for missing slugs. */
export function normalizeMarketLabel(address: string, payload: unknown): string {
  const market = object(payload);
  if (!isMetadataAddress(address) || market.address !== address) {
    throw new Error("Nosana market response did not match the requested market address.");
  }
  const label = text(market.slug) ?? text(market.name);
  if (label === null) throw new Error("Nosana market response did not provide a valid label.");
  return label;
}
