/** Public updater protocol. Never contains download URLs, paths or credentials. */
export interface UpdateBuild { version: string; sequence: number; buildId: string }
export interface UpdateCandidate extends UpdateBuild { id: string; sizeBytes: number }
export const UPDATE_PHASES = ["downloading", "verifying", "preparing", "restarting", "verifying-service", "updating-updater", "complete", "rolling-back", "rolled-back", "failed"] as const;
export type UpdatePhase = typeof UPDATE_PHASES[number];
export interface UpdateOperation {
  id: string; revision: number; target: UpdateBuild; previous: UpdateBuild; phase: UpdatePhase;
  startedAtMs: number; updatedAtMs: number; downloadedBytes: number; totalBytes: number;
  error: string | null; result: UpdateBuild | null;
}
export interface UpdateStatus {
  version: 1; supported: boolean; canUpdate: boolean; checking: boolean; current: UpdateBuild | null;
  candidate: UpdateCandidate | null; checkedAtMs: number | null; nextCheckAtMs: number | null;
  checkError: string | null; operation: UpdateOperation | null;
}
export const updateActive = (operation: UpdateOperation | null): boolean => operation !== null && !["complete", "rolled-back", "failed"].includes(operation.phase);
export const isUpdateRequestKey = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);
const message = (value: unknown): value is string | null => value === null || typeof value === "string" && value.length <= 500 && !/[\u0000-\u001f\u007f]/.test(value);
const timestamp = (value: unknown): value is number | null => value === null || integer(value);
export function parseUpdateBuild(value: unknown): UpdateBuild {
  if (!record(value) || typeof value.version !== "string" || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(value.version)
    || value.version.length > 80 || !integer(value.sequence) || value.sequence < 1 || !id(value.buildId)) throw new Error("Invalid update build.");
  return { version: value.version, sequence: value.sequence, buildId: value.buildId };
}
export function parseUpdateStatus(value: unknown): UpdateStatus {
  if (!record(value) || value.version !== 1 || typeof value.supported !== "boolean" || typeof value.canUpdate !== "boolean" || typeof value.checking !== "boolean"
    || !timestamp(value.checkedAtMs) || !timestamp(value.nextCheckAtMs) || !message(value.checkError)) throw new Error("Invalid update status.");
  const current = value.current === null ? null : parseUpdateBuild(value.current);
  let candidate: UpdateCandidate | null = null, operation: UpdateOperation | null = null;
  if (value.candidate !== null) {
    const item = value.candidate;
    if (!record(item) || typeof item.id !== "string" || !/^[a-f0-9]{64}$/.test(item.id) || !integer(item.sizeBytes) || item.sizeBytes < 1 || item.sizeBytes > 1024 ** 3) throw new Error("Invalid update candidate.");
    candidate = { ...parseUpdateBuild(item), id: item.id, sizeBytes: item.sizeBytes };
  }
  if (value.operation !== null) {
    const item = value.operation;
    if (!record(item) || !id(item.id) || !integer(item.revision) || !(UPDATE_PHASES as readonly unknown[]).includes(item.phase)
      || !integer(item.startedAtMs) || !integer(item.updatedAtMs) || item.updatedAtMs < item.startedAtMs
      || !integer(item.downloadedBytes) || !integer(item.totalBytes) || item.downloadedBytes > item.totalBytes || item.totalBytes > 1024 ** 3
      || !message(item.error)) throw new Error("Invalid update operation.");
    operation = { id: item.id, revision: item.revision, target: parseUpdateBuild(item.target), previous: parseUpdateBuild(item.previous), phase: item.phase as UpdatePhase,
      startedAtMs: item.startedAtMs, updatedAtMs: item.updatedAtMs, downloadedBytes: item.downloadedBytes, totalBytes: item.totalBytes,
      error: item.error, result: item.result === null ? null : parseUpdateBuild(item.result) };
  }
  if (value.supported && current === null || !value.supported && value.canUpdate) throw new Error("Invalid updater capability.");
  return { version: 1, supported: value.supported, canUpdate: value.canUpdate, checking: value.checking, current, candidate, checkedAtMs: value.checkedAtMs,
    nextCheckAtMs: value.nextCheckAtMs, checkError: value.checkError, operation };
}
