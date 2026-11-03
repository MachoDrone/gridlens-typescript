import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { PrivateState } from "./access.ts";
import { SharedHttpError } from "./ipc.ts";

export const TREASURY_RECOVERY_KEY = "treasury.recovery.v1";
export const RECOVERY_ATTEMPT_WINDOW = 30 * 60_000;
export interface RecoveryQuestion { id: string; question: string; salt: string; hash: string }
interface ResetGrant { hash: string; deviceId: string; securityBinding: string; revision: number; expiresAtMs: number }
export interface RecoveryRecord {
  version: 1; binding: string; generation: string; questions: RecoveryQuestion[]; selectedIds: string[] | null;
  attempts: number[]; grant: ResetGrant | null;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const hex = (value: unknown, length: number): value is string => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const id = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
const exact = (value: Record<string, unknown>, fields: string[]) => Object.keys(value).sort().join() === fields.sort().join();
export const recoveryDigest = (value: string): string => createHash("sha256").update(value).digest("hex");
export function normalizeRecoveryAnswer(value: unknown): string {
  if (typeof value !== "string" || value.length > 256) throw new SharedHttpError(400);
  const normalized = value.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ");
  if (!normalized.length || normalized.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) throw new SharedHttpError(400);
  return normalized;
}
export function recoveryQuestion(value: unknown): string {
  if (typeof value !== "string" || value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value)) throw new SharedHttpError(400);
  const question = value.trim().replace(/\s+/gu, " ");
  if (question.length < 8) throw new SharedHttpError(400);
  return question;
}
function parse(value: unknown): RecoveryRecord | null {
  if (value === undefined || value === null) return null;
  if (!object(value) || !exact(value, ["version", "binding", "generation", "questions", "selectedIds", "attempts", "grant"])
    || value.version !== 1 || !hex(value.binding, 64) || !id(value.generation) || !Array.isArray(value.questions) || value.questions.length !== 6
    || value.questions.some(q => !object(q) || !exact(q, ["id", "question", "salt", "hash"]) || !id(q.id)
      || typeof q.question !== "string" || recoveryQuestion(q.question) !== q.question || !hex(q.salt, 64) || !hex(q.hash, 128))) throw new SharedHttpError(503);
  const questions = value.questions as RecoveryQuestion[], ids = questions.map(q => q.id);
  if (new Set(ids).size !== 6 || new Set(questions.map(q => normalizeRecoveryAnswer(q.question))).size !== 6
    || value.selectedIds !== null && (!Array.isArray(value.selectedIds) || value.selectedIds.length !== 3 || new Set(value.selectedIds).size !== 3 || value.selectedIds.some(v => !ids.includes(String(v))))
    || !Array.isArray(value.attempts) || value.attempts.length > 5 || value.attempts.some(v => !time(v))
    || value.grant !== null && (!object(value.grant) || !exact(value.grant, ["hash", "deviceId", "securityBinding", "revision", "expiresAtMs"])
      || !hex(value.grant.hash, 64) || typeof value.grant.deviceId !== "string" || !value.grant.deviceId.length || value.grant.deviceId.length > 256
      || !hex(value.grant.securityBinding, 64) || !time(value.grant.revision) || !time(value.grant.expiresAtMs) || value.selectedIds === null)) throw new SharedHttpError(503);
  return structuredClone(value) as unknown as RecoveryRecord;
}
export function createTreasuryRecovery(state: PrivateState, options: {
  now: () => number; binding: () => string; derive: (answer: string, salt: string) => Promise<Buffer>;
}) {
  let broken = false;
  const read = (): RecoveryRecord | null => { if (broken) throw new SharedHttpError(503); try { return parse(state.get(TREASURY_RECOVERY_KEY)); } catch { throw new SharedHttpError(503); } };
  const current = (): RecoveryRecord | null => { const row = read(); return row?.binding === options.binding() ? row : null; };
  const save = (row: RecoveryRecord): void => { try { state.set(TREASURY_RECOVERY_KEY, row); } catch { broken = true; throw new SharedHttpError(503); } };
  return {
    current, read,
    status() { const row = current(); return { version: 1, enrolled: !!row, questions: row?.questions.map(({ id, question }) => ({ id, question })) ?? [] }; },
    async enroll(input: unknown, authorize: () => void): Promise<RecoveryRecord> {
      if (!Array.isArray(input) || input.length !== 6) throw new SharedHttpError(400);
      const entries = input.map(q => { if (!object(q) || !exact(q, ["question", "answer"])) throw new SharedHttpError(400);
        return { question: recoveryQuestion(q.question), answer: normalizeRecoveryAnswer(q.answer) }; });
      if (new Set(entries.map(q => normalizeRecoveryAnswer(q.question))).size !== 6) throw new SharedHttpError(400);
      const expected = options.binding(), generation = read()?.generation;
      const questions: RecoveryQuestion[] = [];
      for (const entry of entries) {
        const salt = randomBytes(32).toString("hex"), derived = await options.derive(entry.answer, salt);
        try { questions.push({ id: randomUUID(), question: entry.question, salt, hash: derived.toString("hex") }); } finally { derived.fill(0); }
        authorize(); if (options.binding() !== expected || read()?.generation !== generation) throw new SharedHttpError(409);
      }
      return { version: 1, binding: expected, generation: randomUUID(), questions, selectedIds: null, attempts: read()?.attempts ?? [], grant: null };
    },
    challenge() {
      const row = current(); if (!row) return { version: 1, enrolled: false, questions: [] };
      if (!row.selectedIds) {
        const ids = row.questions.map(q => q.id);
        for (let i = ids.length - 1; i > 0; i--) { const j = randomInt(i + 1); [ids[i], ids[j]] = [ids[j]!, ids[i]!]; }
        row.selectedIds = ids.slice(0, 3); save(row);
      }
      return { version: 1, enrolled: true, questions: row.selectedIds.map(id => { const q = row.questions.find(q => q.id === id)!; return { id, question: q.question }; }) };
    },
    async verify(input: unknown, identity: { deviceId: string; securityBinding: string; revision: number }, authorize: () => void) {
      const row = current(), at = options.now();
      if (!row?.selectedIds) throw new SharedHttpError(401);
      if (!time(at) || row.attempts.some(v => v > at)) throw new SharedHttpError(429);
      const recent = row.attempts.filter(v => v > at - RECOVERY_ATTEMPT_WINDOW);
      if (recent.length >= 5) throw new SharedHttpError(429);
      row.attempts = [...recent, at]; save(row); // Reservation precedes parsing and every expensive KDF.
      if (!Array.isArray(input) || input.length !== 3) throw new SharedHttpError(400);
      const answers = new Map<string, string>();
      for (const answer of input) {
        if (!object(answer) || !exact(answer, ["id", "answer"]) || typeof answer.id !== "string" || !row.selectedIds.includes(answer.id) || answers.has(answer.id)) throw new SharedHttpError(400);
        answers.set(answer.id, normalizeRecoveryAnswer(answer.answer));
      }
      let correct = true;
      for (const id of row.selectedIds) {
        const q = row.questions.find(q => q.id === id)!, derived = await options.derive(answers.get(id)!, q.salt);
        try { correct = timingSafeEqual(derived, Buffer.from(q.hash, "hex")) && correct; } finally { derived.fill(0); }
      }
      authorize(); const latest = current();
      if (!latest || latest.generation !== row.generation || JSON.stringify(latest.selectedIds) !== JSON.stringify(row.selectedIds)) throw new SharedHttpError(409);
      if (!correct) throw new SharedHttpError(401);
      const resetToken = randomBytes(32).toString("base64url"), expiresAtMs = options.now() + 300_000;
      save({ ...latest, grant: { hash: recoveryDigest(resetToken), ...identity, expiresAtMs } });
      return { version: 1, resetToken, expiresAtMs };
    },
    authorizeReset(token: unknown, identity: { deviceId: string; securityBinding: string; revision: number }): RecoveryRecord {
      const row = current(), grant = row?.grant, at = options.now();
      if (!row || !grant || typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token) || recoveryDigest(token) !== grant.hash
        || grant.deviceId !== identity.deviceId || grant.securityBinding !== identity.securityBinding || grant.revision !== identity.revision
        || grant.expiresAtMs <= at || grant.expiresAtMs > at + 300_000) throw new SharedHttpError(401);
      return row;
    },
  };
}
