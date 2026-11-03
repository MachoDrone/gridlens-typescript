/** Finite UTF-8 byte limits shared by owner signing, source IPC and provisioning.
 * Envelope headroom accounts for the fixed public identity and signature fields. */
export const GUARDIAN_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const GUARDIAN_MAX_ENVELOPE_BYTES = GUARDIAN_MAX_BODY_BYTES + 1024;
export const GUARDIAN_MAX_ENROLLMENT_BYTES = GUARDIAN_MAX_BODY_BYTES;
export const GUARDIAN_MAX_PIN_BYTES = GUARDIAN_MAX_BODY_BYTES;
export const GUARDIAN_MAX_REPLY_BYTES = GUARDIAN_MAX_BODY_BYTES;
export const GUARDIAN_MAX_LEDGER_BYTES = 64 * 1024 * 1024;
export const GUARDIAN_MAX_SOURCES = 1000;
export const GUARDIAN_MAX_CLAIM_HISTORY = 10_000;
export const GUARDIAN_MAX_KNOWN_SOURCES = GUARDIAN_MAX_SOURCES + GUARDIAN_MAX_CLAIM_HISTORY;

export function boundedGuardianJson(value: unknown, maximum: number): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded) > maximum) throw new Error("Guardian data exceeds its UTF-8 byte limit.");
  return encoded;
}
