import { randomUUID } from "node:crypto";
import { GUARDIAN_CONTAINER, parseGuardianStatus } from "./source-guardian.ts";
import type { GuardianAction, GuardianReply, GuardianRequest, GuardianStatus } from "./source-guardian.ts";
import type { OwnerAuthority } from "./owner-authority.ts";
import { withSsh } from "./ssh.ts";
import type { Computer, SshCredential, SshRun } from "./ssh.ts";
import { framedSudoInput } from "./sudo-input.ts";
import type { PcAssociation } from "../contracts/shared.ts";
import { ClaimsNotDispatchedError, parseDispatch } from "./treasury-claims.ts";
import type { ClaimsDispatchResult, ClaimsQuote } from "./treasury-claims.ts";
import type { TreasuryQuote } from "./treasury.ts";
import { TreasuryPreflightError } from "./treasury-errors.ts";
import { validateSignedTransfer } from "./treasury-transaction.ts";
import { boundedGuardianJson, GUARDIAN_MAX_ENVELOPE_BYTES, GUARDIAN_MAX_REPLY_BYTES } from "./guardian-limits.ts";

export interface GuardianTarget { computer: Computer; credential: SshCredential }
export interface GuardianPolicyUpdate { sources?: PcAssociation[]; claimedSources?: string[]; transferConsumed?: boolean }
export interface FinancialGuardianTransport {
  status(target: GuardianTarget): Promise<GuardianStatus>;
  assertReady(target: GuardianTarget, quote: TreasuryQuote | ClaimsQuote): void;
  prepare(target: GuardianTarget, sourceAddress: string, destinationAddress: string | undefined, authorize?: () => void): Promise<void>;
  transfer(target: GuardianTarget, quote: TreasuryQuote, operationId: string, authorize: () => void): Promise<{ transactionBase64: string; signature: string }>;
  claim(target: GuardianTarget, quote: ClaimsQuote, operationId: string, authorize: () => void): Promise<ClaimsDispatchResult>;
  readOperation?(target: GuardianTarget, quote: ClaimsQuote, operationId: string): Promise<ClaimsDispatchResult | null>;
  setPolicy(target: GuardianTarget, destinationAddress: string, authorize: () => void, update?: GuardianPolicyUpdate): Promise<GuardianStatus>;
}
const DISPATCH = `/usr/bin/docker exec -i ${GUARDIAN_CONTAINER} node /app/scripts/source-guardian.ts dispatch`;
const STATUS = `/usr/bin/docker exec ${GUARDIAN_CONTAINER} node /app/scripts/source-guardian.ts status`;
class GuardianTransportFailure extends Error {
  readonly dispatched: boolean;
  constructor(dispatched: boolean) { super("Financial guardian transport is unavailable."); this.dispatched = dispatched; }
}
export interface GuardianTransportOptions {
  authority: OwnerAuthority; connect?: typeof withSsh; now?: () => number;
  /** Owner-injected signed-release/owned-resource inspection. No exec or writes.
   * Absence never enables a legacy or unverified dispatch fallback. */
  verifyTarget?: (run: SshRun, target: GuardianTarget) => Promise<void>;
}
export function createGuardianTransport({ authority, connect = withSsh, now = Date.now, verifyTarget }: GuardianTransportOptions): FinancialGuardianTransport {
  const checked = new Map<string, { status: GuardianStatus; checkedAt: number }>();
  const targetId = (target: GuardianTarget) => `${target.computer.id}:${target.computer.fingerprint}`;
  async function run(target: GuardianTarget, command: string, payload: string | undefined, authorize: () => void, timeoutMs = 80_000): Promise<unknown> {
    let dispatched = false;
    try {
      if (!verifyTarget) throw new TreasuryPreflightError("preflight-unavailable");
      authorize();
      const result = await connect(target.computer, target.credential, async execute => {
        authorize();
        const guarded: SshRun = (fixed, settings = {}) => {
          authorize();
          if (target.credential.sudoPassword === undefined) return execute(fixed, settings);
          const framed = framedSudoInput(fixed, settings.input, target.credential.sudoPassword);
          return execute(framed.command, { ...settings, input: framed.input });
        };
        await verifyTarget(guarded, target);
        authorize();
        const framed = target.credential.sudoPassword === undefined ? { command, input: payload } : framedSudoInput(command, payload, target.credential.sudoPassword);
        // After this boundary an SSH error may hide an accepted guardian call.
        dispatched = true;
        return execute(framed.command, { ...(framed.input === undefined ? {} : { input: framed.input }), maximum: GUARDIAN_MAX_REPLY_BYTES, timeoutMs });
      });
      if (result.code !== 0) throw new Error();
      return JSON.parse(result.stdout);
    } catch { throw new GuardianTransportFailure(dispatched); }
  }
  function accept(target: GuardianTarget, value: unknown): GuardianStatus {
    const status = parseGuardianStatus(value);
    if (status.authorityId !== authority.descriptor.authorityId || status.publicKeyDer !== authority.descriptor.publicKeyDer || status.pcId !== target.computer.id)
      throw new TreasuryPreflightError("source-changed");
    checked.set(targetId(target), { status, checkedAt: now() }); return status;
  }
  const status = async (target: GuardianTarget) => accept(target, await run(target, STATUS, undefined, () => {}, 10_000));
  function prior(target: GuardianTarget, quote: TreasuryQuote | ClaimsQuote): GuardianStatus {
    const prior = checked.get(targetId(target));
    if (!prior || prior.checkedAt > now() || now() - prior.checkedAt > 60_000
      || !prior.status.sources.some(source => source.address === quote.sourceAddress && source.containerId === quote.sourceBinding.containerId))
      throw new TreasuryPreflightError("source-changed");
    return prior.status;
  }
  async function dispatch(target: GuardianTarget, request: GuardianRequest, authorize: () => void): Promise<GuardianReply> {
    let envelope;
    try { authorize(); envelope = authority.sign(request); } catch { throw new GuardianTransportFailure(false); }
    const value = await run(target, DISPATCH, boundedGuardianJson(envelope, GUARDIAN_MAX_ENVELOPE_BYTES), authorize, request.action.kind === "operation-status" || request.action.kind === "set-policy" ? 10_000 : 80_000) as Partial<GuardianReply> & { error?: unknown; dispatched?: unknown };
    if (value?.error !== undefined) {
      if (request.action.kind === "claim" && value.dispatched === false) throw new ClaimsNotDispatchedError();
      throw new TreasuryPreflightError("source-changed");
    }
    if (!value || value.version !== 1 || value.operationId !== (request.action.kind === "operation-status" ? request.action.operationId : request.operationId) || !["complete", "uncertain"].includes(String(value.state))
      || Object.keys(value).sort().join(",") !== "operationId,result,state,version") throw new TreasuryPreflightError("preflight-unavailable");
    return value as GuardianReply;
  }
  const request = (target: GuardianTarget, action: GuardianAction, operationId: string, context: { scopeId: string; rosterRevision: string }, expires: number): GuardianRequest => ({
    version: 1, operationId, pcId: target.computer.id, scopeId: context.scopeId, rosterRevision: context.rosterRevision,
    issuedAtMs: now(), expiresAtMs: Math.min(expires, now() + (action.kind === "transfer" ? 15_000 : 60_000)), action,
  });
  return {
    status,
    assertReady(target, quote) {
      const enrollment = prior(target, quote), source = enrollment.sources.find(source => source.address === quote.sourceAddress)!;
      if ("destinationAddress" in quote ? enrollment.transferConsumed || enrollment.destinationAddress !== quote.destinationAddress : source.claimSpent)
        throw new TreasuryPreflightError("source-changed");
    },
    async prepare(target, sourceAddress, destinationAddress, authorize = () => {}) {
      authorize(); const status = accept(target, await run(target, STATUS, undefined, authorize, 10_000)); authorize();
      const source = status.sources.find(source => source.address === sourceAddress);
      if (!source || destinationAddress === undefined && source.claimSpent || destinationAddress !== undefined && (status.transferConsumed || status.destinationAddress !== destinationAddress))
        throw new TreasuryPreflightError("source-changed");
    },
    async transfer(target, quote, operationId, authorize) {
      const enrollment = prior(target, quote);
      const reply = await dispatch(target, request(target, { kind: "transfer", policyEpoch: enrollment.policyEpoch, quote }, operationId, quote, quote.expiresAtMs), authorize);
      if (reply.state !== "complete" || !reply.result || typeof reply.result !== "object") throw new TreasuryPreflightError("preflight-unavailable");
      const signed = reply.result as { transactionBase64: string; signature: string };
      await validateSignedTransfer(quote, signed.transactionBase64, signed.signature); return signed;
    },
    async claim(target, quote, operationId, authorize) {
      let entered = false;
      try {
        const enrollment = prior(target, quote), body = request(target, { kind: "claim", policyEpoch: enrollment.policyEpoch, quote }, operationId, quote, quote.expiresAtMs);
        entered = true;
        const reply = await dispatch(target, body, authorize);
        return reply.state === "complete" ? parseDispatch(reply.result) : { status: "uncertain", success: null, amountUnit: "base-units", observedAtMs: now() };
      } catch (error) {
        if (!entered || error instanceof GuardianTransportFailure && !error.dispatched) throw new ClaimsNotDispatchedError();
        throw error;
      }
    },
    async readOperation(target, quote, operationId) {
      const reply = await dispatch(target, request(target, { kind: "operation-status", operationId, sourceAddress: quote.sourceAddress, operationKind: "claim" }, randomUUID(), quote, now() + 30_000), () => {});
      return reply.state === "complete" ? parseDispatch(reply.result) : null;
    },
    async setPolicy(target, destinationAddress, authorize, update = {}) {
      authorize(); const enrollment = accept(target, await run(target, STATUS, undefined, authorize, 10_000)); authorize();
      const action: GuardianAction = { kind: "set-policy", policyEpoch: enrollment.policyEpoch, destinationAddress, ...update };
      const reply = await dispatch(target, request(target, action, randomUUID(), { scopeId: "owner-policy", rosterRevision: String(enrollment.policyEpoch) }, now() + 60_000), authorize);
      if (reply.state !== "complete") throw new TreasuryPreflightError("preflight-unavailable");
      return accept(target, reply.result);
    },
  };
}
