import { createHash } from "node:crypto";
import { address } from "@solana/kit";
import {
  findAssociatedTokenPda,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { SolanaRpcError } from "../../scripts/solana-rpc.ts";
import type { SolanaRpc } from "../../scripts/solana-rpc.ts";
import type { FleetContext } from "../contracts/fleet.ts";
import type { PcAssociation } from "../contracts/shared.ts";
import { NOS_MINT } from "../fleet/nos.ts";
import { parseReward, sameBinding } from "../fleet/pc-observations.ts";
import type { RewardObservation } from "../fleet/pc-observations.ts";
import type { PrivateState } from "./access.ts";
import type { CredentialVault } from "./credential-vault.ts";
import type { createObservationStore } from "./observations.ts";
import type { PcPermission } from "./pc-monitor.ts";
import { cleanNodeRuntime, verifyNode } from "./pc-rewards.ts";
import { shellQuote, withSsh } from "./ssh.ts";
import type { SshCredential, SshRun } from "./ssh.ts";
import { ClaimsNotDispatchedError } from "./treasury-claims.ts";
import type {
  ClaimsDispatchResult,
  ClaimsDriver,
  ClaimsQuote,
} from "./treasury-claims.ts";
import { TreasuryPreflightError } from "./treasury-errors.ts";
import { rewardsClaimerSource, isClaimSignature } from "./rewards-claimer.ts";
import { verifyClaimReceipt } from "./claim-receipt.ts";

const CLEAN =
  [
    "LD_PRELOAD",
    "LD_AUDIT",
    "LD_LIBRARY_PATH",
    "GLIBC_TUNABLES",
    "LD_DEBUG",
    "LD_DEBUG_OUTPUT",
    "LD_PROFILE",
    "LD_PROFILE_OUTPUT",
    "LD_ORIGIN_PATH",
    "GCONV_PATH",
    "LOCPATH",
    "NLSPATH",
  ]
    .map((name) => ` --env ${name}=`)
    .join("") + " --env LANG=C --env LC_ALL=C";
const FRESH_MS = 300_000;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export interface TreasuryClaimDriverOptions {
  rpc: SolanaRpc;
  state: PrivateState;
  vault: CredentialVault;
  observations: ReturnType<typeof createObservationStore>;
  contexts: () => readonly FleetContext[];
  now?: () => number;
  connect?: typeof withSsh;
}
interface Source {
  association: PcAssociation;
  permission: PcPermission;
  credential: SshCredential;
  reward: RewardObservation;
  binding: ClaimsQuote["sourceBinding"];
}
function amountAtoms(amount: string): string {
  if (!/^(0|[1-9]\d{0,12})\.\d{6}$/.test(amount))
    throw new TreasuryPreflightError("rewards-unavailable");
  const [whole, fraction] = amount.split(".");
  return (BigInt(whole!) * 1_000_000n + BigInt(fraction!)).toString();
}
function normalizedResult(
  raw: string,
  owner: string,
  now: number,
): ClaimsDispatchResult {
  const value: unknown = JSON.parse(raw);
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "schema",
          "address",
          "status",
          "success",
          "claimedAmountAtoms",
          "signature",
          "observedAtMs",
          "retryAfterSeconds",
        ].includes(key),
    ) ||
    value.schema !== 1 ||
    value.address !== owner ||
    ![
      "acknowledged",
      "rejected",
      "uncertain",
      "rate-limited",
      "authentication-failed",
    ].includes(String(value.status)) ||
    value.success !==
      (value.status === "acknowledged"
        ? true
        : value.status === "rejected"
          ? false
          : null) ||
    !Number.isSafeInteger(value.observedAtMs) ||
    Number(value.observedAtMs) < 0 ||
    Number(value.observedAtMs) > 8_640_000_000_000_000 ||
    (value.claimedAmountAtoms !== undefined &&
      (typeof value.claimedAmountAtoms !== "string" ||
        !/^[1-9]\d{0,18}$/.test(value.claimedAmountAtoms) ||
        BigInt(value.claimedAmountAtoms) > 9_223_372_036_854_775_807n)) ||
    (value.signature !== undefined && !isClaimSignature(value.signature)) ||
    (value.retryAfterSeconds !== undefined &&
      (!Number.isSafeInteger(value.retryAfterSeconds) ||
        Number(value.retryAfterSeconds) < 0 ||
        Number(value.retryAfterSeconds) > 2147483647))
  )
    throw Error();
  return {
    status: value.status as ClaimsDispatchResult["status"],
    success: value.success as boolean | null,
    observedAtMs: now,
    ...(typeof value.claimedAmountAtoms === "string"
      ? { claimedAmountAtoms: value.claimedAmountAtoms }
      : {}),
    ...(typeof value.signature === "string"
      ? { signature: value.signature }
      : {}),
    ...(typeof value.retryAfterSeconds === "number"
      ? { retryAfterSeconds: value.retryAfterSeconds }
      : {}),
  };
}
/** The claim helper is reached only after the financial engine journals the
 * reviewed attempt. Monitoring permission alone never calls this driver. */
export function createTreasuryClaimDriver(
  options: TreasuryClaimDriverOptions,
): ClaimsDriver {
  const {
    rpc,
    state,
    vault,
    observations,
    contexts,
    now = Date.now,
    connect = withSsh,
  } = options;
  const receiptSession = rpc.createSession("treasury-claim-receipts"),
    attempted = new Set<string>();
  let localWait = 0,
    waitPersistenceFailed = false;
  const hostKey = (quote: Pick<ClaimsQuote, "scopeId" | "sourceAddress">) =>
    JSON.stringify([quote.scopeId, quote.sourceAddress]);
  const waits = (): { ip: number; rewards: number } => {
    const value = state.get<{ ip: number; rewards: number }>(
      "monitor/provider-waits",
    ) ?? { ip: 0, rewards: 0 };
    if (
      !Number.isSafeInteger(value.ip) ||
      !Number.isSafeInteger(value.rewards) ||
      value.ip < 0 ||
      value.rewards < 0
    )
      throw new TreasuryPreflightError("provider-unavailable");
    return value;
  };
  const providerReady = (): void => {
    const next = Math.max(waits().rewards, localWait);
    if (waitPersistenceFailed || next > now())
      throw new TreasuryPreflightError(
        "provider-unavailable",
        next > now() ? next : undefined,
      );
  };
  function source(
    scopeId: string,
    revision: string,
    sourceAddress: string,
  ): Source {
    const context = contexts().find(
      (value) => value.scopeId === scopeId && value.rosterRevision === revision,
    );
    if (!context || !context.addresses.includes(sourceAddress))
      throw new TreasuryPreflightError("source-changed");
    const data = observations.read(context),
      association = data.associations.find(
        (value) => value.address === sourceAddress,
      );
    if (!association) throw new TreasuryPreflightError("source-changed");
    const permission = state.get<PcPermission>(
        `permission:${scopeId}:${association.binding.pcId}`,
      ),
      approved = permission?.associations.find(
        (value) => value.address === sourceAddress,
      );
    if (
      !permission ||
      permission.version !== 1 ||
      !permission.rewards ||
      permission.paused ||
      permission.revokedAtMs !== null ||
      permission.rosterRevision !== revision ||
      permission.computer.id !== association.binding.pcId ||
      permission.computer.fingerprint !== association.sshFingerprint ||
      !approved ||
      !sameBinding(approved.binding, association.binding) ||
      approved.sshFingerprint !== association.sshFingerprint
    )
      throw new TreasuryPreflightError("source-changed");
    const denial = state.get<{ approvedAtMs: number }>(
      `monitor:reward-denial:${scopeId}:${permission.computer.id}:${sourceAddress}`,
    );
    if (denial && denial.approvedAtMs >= permission.approvedAtMs)
      throw new TreasuryPreflightError("source-changed");
    const record = data.observations.find(
      (value) => value.address === sourceAddress,
    );
    if (
      !record ||
      !sameBinding(record.binding, association.binding) ||
      !record.rewards
    )
      throw new TreasuryPreflightError("rewards-unavailable");
    let reward: RewardObservation;
    try {
      reward = parseReward(record.rewards, sourceAddress);
    } catch {
      throw new TreasuryPreflightError("rewards-unavailable");
    }
    if (
      reward.status !== "ok" ||
      reward.amount === undefined ||
      reward.observedAtMs > now() + 15_000 ||
      now() - reward.observedAtMs >= FRESH_MS
    )
      throw new TreasuryPreflightError("rewards-unavailable");
    if (BigInt(amountAtoms(reward.amount)) <= 0n)
      throw new TreasuryPreflightError("no-claimable-rewards");
    const credential = vault.read(scopeId, permission.computer.id);
    if (!credential) throw new TreasuryPreflightError("source-changed");
    return {
      association,
      permission,
      credential,
      reward,
      binding: {
        pcId: permission.computer.id,
        containerId: association.binding.nodeContainerId,
        sshIdentity: association.sshFingerprint,
        nodeId: createHash("sha256")
          .update(
            JSON.stringify([
              association.binding,
              permission.computer.hostKey,
              permission.approvedAtMs,
              revision,
            ]),
          )
          .digest("hex"),
      },
    };
  }
  const current = (quote: ClaimsQuote): Source => {
    if (
      quote.mintAddress !== NOS_MINT ||
      quote.decimals !== 6 ||
      !Number.isSafeInteger(quote.checkedAtMs) ||
      quote.checkedAtMs > now() + 15_000 ||
      !Number.isSafeInteger(quote.expiresAtMs) ||
      quote.expiresAtMs <= now() ||
      quote.expiresAtMs > quote.checkedAtMs + FRESH_MS
    )
      throw new TreasuryPreflightError("review-expired");
    const latest = source(
      quote.scopeId,
      quote.rosterRevision,
      quote.sourceAddress,
    );
    if (
      (["pcId", "nodeId", "containerId", "sshIdentity"] as const).some(
        (key) => quote.sourceBinding[key] !== latest.binding[key],
      )
    )
      throw new TreasuryPreflightError("source-changed");
    providerReady();
    return latest;
  };
  const rememberWait = (result: ClaimsDispatchResult): void => {
    const seconds = Math.max(
      result.status === "rate-limited" ? 300 : 0,
      result.retryAfterSeconds ?? 0,
    );
    if (seconds === 0) return;
    localWait = Math.max(
      localWait,
      Math.min(8_640_000_000_000_000, now() + seconds * 1000),
    );
    try {
      const previous = waits();
      state.set("monitor/provider-waits", {
        ...previous,
        rewards: Math.max(previous.rewards, localWait),
      });
    } catch {
      waitPersistenceFailed = true;
    }
  };
  return {
    async prepare(context, sourceAddress) {
      providerReady();
      const selected = source(
        context.scopeId,
        context.rosterRevision,
        sourceAddress,
      );
      const [sourceTokenAddress] = await findAssociatedTokenPda({
        owner: address(sourceAddress),
        mint: address(NOS_MINT),
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      const quote: ClaimsQuote = {
        scopeId: context.scopeId,
        rosterRevision: context.rosterRevision,
        sourceAddress,
        sourceBinding: selected.binding,
        sourceTokenAddress,
        mintAddress: NOS_MINT,
        decimals: 6,
        lastReportedAmountBaseUnits: amountAtoms(selected.reward.amount!),
        checkedAtMs: selected.reward.observedAtMs,
        expiresAtMs: Math.min(
          now() + 60_000,
          selected.reward.observedAtMs + FRESH_MS,
        ),
      };
      current(quote);
      return quote;
    },
    assertReady(quote) {
      if (attempted.has(hostKey(quote)))
        throw new TreasuryPreflightError("review-expired");
      current(quote);
    },
    async dispatch(quote, authorize) {
      let invoked = false;
      const uncertain = (): ClaimsDispatchResult => ({
        status: "uncertain",
        success: null,
        observedAtMs: now(),
      });
      try {
        if (attempted.has(hostKey(quote))) throw new ClaimsNotDispatchedError();
        authorize();
        const selected = current(quote);
        const [expectedAta] = await findAssociatedTokenPda({
          owner: address(quote.sourceAddress),
          mint: address(NOS_MINT),
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
        });
        if (expectedAta !== quote.sourceTokenAddress)
          throw new ClaimsNotDispatchedError();
        const output = await connect(
          selected.permission.computer,
          selected.credential,
          async (run) => {
            const guarded: SshRun = (command, settings) => {
              authorize();
              current(quote);
              return run(
                selected.credential.sudoPassword === undefined
                  ? command
                  : `/usr/bin/sudo -S -p '' -- ${command}`,
                {
                  ...settings,
                  ...(selected.credential.sudoPassword === undefined
                    ? {}
                    : { input: selected.credential.sudoPassword + "\n" }),
                },
              );
            };
            if ((await verifyNode(guarded, selected.association)) !== "ok")
              throw new ClaimsNotDispatchedError();
            authorize();
            current(quote);
            if (attempted.has(hostKey(quote)))
              throw new ClaimsNotDispatchedError();
            const helper = rewardsClaimerSource();
            const prelude =
              'ulimit -S -c 0 && ulimit -H -c 0 && printf 0 > /proc/self/coredump_filter && exec /usr/local/bin/node -e "$1" -- --gridlens-approved-uptime-claim "$2"';
            const command = `${cleanNodeRuntime(selected.association)} exec${CLEAN} ${selected.association.binding.nodeContainerId} /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C /bin/sh -c ${shellQuote(prelude)} gridlens-approved-uptime-claim ${shellQuote(helper)} ${quote.sourceAddress}`;
            // Once handed to SSH, even a synchronous/lost-response error is
            // ambiguous. There is no later owner check that could discard an ACK.
            attempted.add(hostKey(quote));
            invoked = true;
            return run(
              selected.credential.sudoPassword === undefined
                ? command
                : `/usr/bin/sudo -S -p '' -- ${command}`,
              {
                maximum: 2048,
                timeoutMs: 75_000,
                ...(selected.credential.sudoPassword === undefined
                  ? {}
                  : { input: selected.credential.sudoPassword + "\n" }),
              },
            );
          },
        );
        if (output.code !== 0) return uncertain();
        const result = normalizedResult(
          output.stdout,
          quote.sourceAddress,
          now(),
        );
        rememberWait(result);
        return result;
      } catch {
        if (!invoked) throw new ClaimsNotDispatchedError();
        return uncertain();
      }
    },
    async reconcile(input) {
      const uncertain = { status: "uncertain" as const, observedAtMs: now() };
      if (
        input.dispatch.status !== "acknowledged" ||
        input.dispatch.success !== true ||
        !isClaimSignature(input.dispatch.signature) ||
        typeof input.dispatch.claimedAmountAtoms !== "string" ||
        !/^[1-9]\d{0,18}$/.test(input.dispatch.claimedAmountAtoms)
      )
        return uncertain;
      const provider = receiptSession.eligible();
      if (!provider) {
        const retryAtMs = receiptSession.nextEligibleAt();
        return {
          ...uncertain,
          ...(retryAtMs !== null && retryAtMs > now() ? { retryAtMs } : {}),
        };
      }
      const duration = Math.min(rpc.refreshDeadlineMs, 28_000),
        deadline = now() + duration,
        signal = AbortSignal.timeout(duration),
        healthVersion = provider.healthVersion;
      try {
        await rpc.verifyMainnet(provider, signal, deadline);
        const result = await rpc.rpc(
          provider,
          "getTransaction",
          [
            input.dispatch.signature,
            {
              encoding: "jsonParsed",
              commitment: "finalized",
              maxSupportedTransactionVersion: 0,
            },
          ],
          signal,
          deadline,
        );
        const receipt = await verifyClaimReceipt(input, result, now());
        receiptSession.success(provider, healthVersion);
        return receipt;
      } catch (error) {
        if (error instanceof SolanaRpcError)
          receiptSession.failure(provider, error);
        const retryAtMs =
          error instanceof SolanaRpcError
            ? (error.retryAtMs ?? receiptSession.nextEligibleAt())
            : receiptSession.nextEligibleAt();
        return {
          status: "uncertain",
          observedAtMs: now(),
          ...(retryAtMs !== null && retryAtMs > now() ? { retryAtMs } : {}),
        };
      }
    },
  };
}
