import { time } from "./pc-observations.ts";

export const DRIVER_REFRESH_MS = 5 * 60_000;
export const DRIVER_FRESH_MS = 6 * 60_000;
export const DRIVER_VERSION = /^[1-9][0-9]{0,3}(?:\.[0-9]{1,6}){1,3}$/;
export const CUDA_DRIVER_VERSION = /^[1-9][0-9]{0,2}\.[0-9]{1,3}$/;
export interface PcDriverObservation {
  schema: 1; source: "pc-nvidia-smi-version"; observedAtMs: number;
  status: "ok" | "missing-command" | "query-failed" | "invalid-response" | "unavailable";
  driverVersion: string | null; cudaDriverVersion: string | null;
}
export interface PcDriverUpdate { pcId: string; sshFingerprint: string; approvalAtMs: number; driver: PcDriverObservation }
export interface PcDriverRecord extends PcDriverUpdate { receivedAtMs: number; lastGoodDriver?: PcDriverObservation }
function object(value: unknown, fields: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || fields.some(field => !Object.hasOwn(value, field))
    || Object.keys(value).some(field => !fields.includes(field) && !optional.includes(field))) throw new Error("Invalid PC driver observation fields.");
  return value as Record<string, unknown>;
}
export function parsePcDriver(value: unknown): PcDriverObservation {
  const row = object(value, ["schema", "source", "observedAtMs", "status", "driverVersion", "cudaDriverVersion"]);
  if (row.schema !== 1 || row.source !== "pc-nvidia-smi-version" || !time(row.observedAtMs) || row.observedAtMs === 0
    || !["ok", "missing-command", "query-failed", "invalid-response", "unavailable"].includes(String(row.status))) throw new Error("Invalid PC driver observation.");
  if (row.status === "ok" ? typeof row.driverVersion !== "string" || !DRIVER_VERSION.test(row.driverVersion)
    || typeof row.cudaDriverVersion !== "string" || !CUDA_DRIVER_VERSION.test(row.cudaDriverVersion)
    : row.driverVersion !== null || row.cudaDriverVersion !== null) throw new Error("Invalid PC driver version values.");
  return { ...row } as unknown as PcDriverObservation;
}
export function parsePcDriverUpdate(value: unknown): PcDriverUpdate {
  const row = object(value, ["pcId", "sshFingerprint", "approvalAtMs", "driver"]);
  if (typeof row.pcId !== "string" || !/^[a-f0-9]{64}$/.test(row.pcId) || typeof row.sshFingerprint !== "string"
    || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(row.sshFingerprint) || !time(row.approvalAtMs) || row.approvalAtMs === 0) throw new Error("Invalid PC driver identity.");
  const driver = parsePcDriver(row.driver);
  if (driver.observedAtMs < row.approvalAtMs) throw new Error("Driver observation predates its approval.");
  return { pcId: row.pcId, sshFingerprint: row.sshFingerprint, approvalAtMs: row.approvalAtMs, driver };
}
export function parsePcDriverRecord(value: unknown): PcDriverRecord {
  const row = object(value, ["pcId", "sshFingerprint", "approvalAtMs", "driver", "receivedAtMs"], ["lastGoodDriver"]);
  if (!time(row.receivedAtMs)) throw new Error("Invalid PC driver receipt time.");
  const output: PcDriverRecord = { ...parsePcDriverUpdate({ pcId: row.pcId, sshFingerprint: row.sshFingerprint, approvalAtMs: row.approvalAtMs, driver: row.driver }), receivedAtMs: row.receivedAtMs };
  if (row.lastGoodDriver !== undefined) {
    output.lastGoodDriver = parsePcDriver(row.lastGoodDriver);
    if (output.lastGoodDriver.status !== "ok" || output.lastGoodDriver.observedAtMs < output.approvalAtMs
      || output.lastGoodDriver.observedAtMs > output.driver.observedAtMs) throw new Error("Invalid retained PC driver observation.");
  }
  return output;
}
export function pcDriverView(record: PcDriverRecord | undefined, now: number, transportFailed = false) {
  const latest = record?.driver, saved = latest?.status === "ok" ? latest : record?.lastGoodDriver;
  const good = saved && now >= saved.observedAtMs ? saved : undefined;
  const current = !!good && latest?.status === "ok" && !transportFailed && now >= good.observedAtMs && now < good.observedAtMs + DRIVER_FRESH_MS;
  return { driverVersion: good?.driverVersion ?? null, cudaDriverVersion: good?.cudaDriverVersion ?? null,
    observedAtMs: good?.observedAtMs ?? null, attemptedAtMs: latest?.observedAtMs ?? null,
    current, status: latest?.status ?? "unavailable" };
}
