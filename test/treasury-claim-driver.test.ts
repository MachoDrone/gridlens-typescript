import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { getBase58Decoder } from "@solana/kit";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  createSolanaRpc,
  MAINNET_GENESIS_HASH,
} from "../scripts/solana-rpc.ts";
import { createTreasuryClaimDriver } from "../src/backend/treasury-claim-driver.ts";
import { verifyClaimReceipt } from "../src/backend/claim-receipt.ts";
import { ClaimsNotDispatchedError } from "../src/backend/treasury-claims.ts";
import type {
  ClaimsDispatchResult,
  ClaimsQuote,
} from "../src/backend/treasury-claims.ts";
import type { PrivateState } from "../src/backend/access.ts";
import type { PcPermission } from "../src/backend/pc-monitor.ts";
import type { CredentialVault } from "../src/backend/credential-vault.ts";
import type { createObservationStore } from "../src/backend/observations.ts";
import type { withSsh } from "../src/backend/ssh.ts";
import type { FleetContext } from "../src/contracts/fleet.ts";
import type { PcAssociation } from "../src/contracts/shared.ts";
import type { RewardObservation } from "../src/fleet/pc-observations.ts";
import { TreasuryPreflightError } from "../src/backend/treasury-errors.ts";
import { NOS_MINT } from "../src/fleet/nos.ts";

const base = 1_800_000_000_000;
const key = () => generateKeyPairSync("ed25519"),
  hostKey = key(),
  funderKey = key(),
  tokenKey = key(),
  otherKey = key();
const publicKey = (pair: ReturnType<typeof key>) =>
  getBase58Decoder().decode(
    pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32),
  );
const host = publicKey(hostKey),
  funder = publicKey(funderKey),
  fundingToken = publicKey(tokenKey),
  other = publicKey(otherKey);
const signature = getBase58Decoder().decode(
  sign(
    null,
    Buffer.from("generated fixture transaction"),
    funderKey.privateKey,
  ),
);
const ack: ClaimsDispatchResult = {
  status: "acknowledged",
  success: true,
  amountUnit: "base-units",
  claimedAmountAtoms: "2345678",
  signature,
  observedAtMs: base,
};
const context: FleetContext = {
  scopeId: "claims-fixture",
  rosterRevision: "one",
  addresses: [host],
};
const association: PcAssociation = {
  address: host,
  binding: {
    pcId: "a".repeat(64),
    runtime: "docker",
    wrapperId: null,
    nodeContainerId: "b".repeat(64),
  },
  name: "Generated source",
  sshFingerprint: "SHA256:" + "A".repeat(43),
  verifiedAtMs: base,
  privateIp: "10.0.0.2",
  gpuUuids: [],
};
function fixture() {
  let time = base,
    authorized = true,
    identity = host,
    response: ClaimsDispatchResult = ack,
    lost = false;
  let rawOutput: string | undefined;
  let afterHandoff: (() => void) | undefined,
    onRead: (() => void) | undefined,
    transaction: unknown = null;
  let reward: RewardObservation = {
    schema: 1,
    address: host,
    observedAtMs: base,
    status: "ok",
    amount: "8.765432",
  };
  const values = new Map<string, unknown>(),
    commands: { command: string; timeoutMs?: number }[] = [],
    rpcCalls: string[] = [];
  let helperCalls = 0;
  const permission: PcPermission = {
    version: 1,
    computer: {
      id: association.binding.pcId,
      host: "10.0.0.2",
      port: 22,
      name: "Generated source",
      hostKey: "fixture public SSH identity",
      fingerprint: association.sshFingerprint,
    },
    associations: [association],
    rosterRevision: "one",
    automaticIp: true,
    rewards: true,
    gpu: false,
    approvedAtMs: base,
    revokedAtMs: null,
    paused: false,
  };
  values.set(
    `permission:${context.scopeId}:${association.binding.pcId}`,
    permission,
  );
  const state: PrivateState = {
    get: <T>(name: string) => values.get(name) as T | undefined,
    set: (name, value) => {
      values.set(name, structuredClone(value));
    },
  };
  const vault = {
    read: () => ({ username: "generated", password: "generated-password" }),
  } as unknown as CredentialVault;
  const observations = {
    read: () => ({
      associations: [association],
      observations: [
        {
          address: host,
          binding: association.binding,
          rewards: reward,
          receivedAtMs: time,
        },
      ],
    }),
  } as unknown as ReturnType<typeof createObservationStore>;
  const rpc = createSolanaRpc({
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    fetch: async (_url, options) => {
      const body = JSON.parse(String(options?.body)) as {
        method: string;
        id: number;
        params: unknown[];
      };
      rpcCalls.push(body.method);
      let result: unknown;
      if (body.method === "getGenesisHash") result = MAINNET_GENESIS_HASH;
      else if (body.method === "getTransaction") {
        assert.equal(body.params[0], signature);
        assert.deepEqual(body.params[1], {
          encoding: "jsonParsed",
          commitment: "finalized",
          maxSupportedTransactionVersion: 0,
        });
        result = transaction;
      } else throw Error("Unexpected live-provider method");
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
      );
    },
  });
  const connect: typeof withSsh = async (_computer, _credential, work) =>
    work(async (command, options) => {
      commands.push({
        command,
        ...(options?.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.timeoutMs }),
      });
      if (command.includes("--gridlens-approved-uptime-claim")) {
        helperCalls++;
        afterHandoff?.();
        if (lost) throw Error("lost helper response");
        return {
          code: 0,
          stdout:
            rawOutput ??
            JSON.stringify({
              schema: 2,
              address: host,
              amountUnit: "base-units",
              ...response,
            }),
        };
      }
      onRead?.();
      return command.includes("inspect --format")
        ? {
            code: 0,
            stdout: `${association.binding.nodeContainerId}\ttrue\tnosana/nosana-node:1.0.0`,
          }
        : { code: 0, stdout: identity };
    });
  const driver = createTreasuryClaimDriver({
    rpc,
    state,
    vault,
    observations,
    contexts: () => [context],
    now: () => time,
    connect,
  });
  return {
    driver,
    values,
    permission,
    commands,
    rpcCalls,
    helperCalls: () => helperCalls,
    guard: () => {
      if (!authorized) throw Error("Owner authorization revoked");
    },
    response: (value: ClaimsDispatchResult) => {
      response = value;
    },
    rawOutput: (value: string) => {
      rawOutput = value;
    },
    reward: (value: Partial<RewardObservation>) => {
      reward = { ...reward, ...value };
    },
    advance: (ms: number) => {
      time += ms;
    },
    identity: (value: string) => {
      identity = value;
    },
    lose: () => {
      lost = true;
    },
    revoke: () => {
      authorized = false;
    },
    afterHandoff: (hook: () => void) => {
      afterHandoff = hook;
    },
    onRead: (hook: () => void) => {
      onRead = hook;
    },
    transaction: (value: unknown) => {
      transaction = value;
    },
  };
}
function payout(
  quote: ClaimsQuote,
  {
    checked = false,
    createAta = false,
    version = 0,
    amount = ack.claimedAmountAtoms!,
  }: {
    checked?: boolean;
    createAta?: boolean;
    version?: number | "legacy";
    amount?: string;
  } = {},
) {
  const keys = [
    { pubkey: funder, signer: true, writable: true },
    { pubkey: fundingToken, signer: false, writable: true },
    { pubkey: quote.sourceTokenAddress, signer: false, writable: true },
    ...[
      host,
      NOS_MINT,
      TOKEN_PROGRAM_ADDRESS,
      "ComputeBudget111111111111111111111111111111",
      "11111111111111111111111111111111",
      ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    ].map((pubkey) => ({ pubkey, signer: false, writable: false })),
  ];
  const limit = Buffer.from([2, 64, 13, 3, 0]),
    price = Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0]);
  const compute = (bytes: Buffer) => ({
    programId: "ComputeBudget111111111111111111111111111111",
    accounts: [],
    data: getBase58Decoder().decode(bytes),
    stackHeight: null,
  });
  const parsed = (
    programId: string,
    type: string,
    info: Record<string, unknown>,
    stackHeight: number | null = null,
  ) => ({ programId, parsed: { type, info }, stackHeight });
  const transfer = parsed(
    TOKEN_PROGRAM_ADDRESS,
    checked ? "transferChecked" : "transfer",
    {
      source: fundingToken,
      destination: quote.sourceTokenAddress,
      authority: funder,
      ...(checked
        ? {
            mint: NOS_MINT,
            tokenAmount: {
              amount,
              decimals: 6,
              uiAmount: Number(amount) / 1_000_000,
              uiAmountString: (Number(amount) / 1_000_000).toFixed(6),
            },
          }
        : { amount }),
    },
  );
  const ata = parsed(ASSOCIATED_TOKEN_PROGRAM_ADDRESS, "createIdempotent", {
    source: funder,
    account: quote.sourceTokenAddress,
    wallet: host,
    mint: NOS_MINT,
    systemProgram: "11111111111111111111111111111111",
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const balance = (index: number, owner: string, amount: string) => ({
    accountIndex: index,
    owner,
    mint: NOS_MINT,
    programId: TOKEN_PROGRAM_ADDRESS,
    uiTokenAmount: { amount, decimals: 6 },
  });
  return {
    version,
    slot: 12345,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: keys,
        recentBlockhash: other,
        instructions: [
          compute(limit),
          ...(createAta ? [ata] : []),
          transfer,
          compute(price),
        ],
      },
    },
    meta: {
      err: null,
      preTokenBalances: [
        balance(1, funder, "100000000"),
        ...(createAta ? [] : [balance(2, host, "38000000")]),
      ],
      postTokenBalances: [
        balance(1, funder, (100_000_000n - BigInt(amount)).toString()),
        balance(
          2,
          host,
          (BigInt(amount) + (createAta ? 0n : 38_000_000n)).toString(),
        ),
      ],
      innerInstructions: createAta
        ? [
            {
              index: 1,
              instructions: [
                parsed(
                  TOKEN_PROGRAM_ADDRESS,
                  "getAccountDataSize",
                  { mint: NOS_MINT, extensionTypes: ["immutableOwner"] },
                  2,
                ),
                parsed(
                  "11111111111111111111111111111111",
                  "createAccount",
                  {
                    source: funder,
                    newAccount: quote.sourceTokenAddress,
                    lamports: 2039280,
                    space: 165,
                    owner: TOKEN_PROGRAM_ADDRESS,
                  },
                  2,
                ),
                parsed(
                  TOKEN_PROGRAM_ADDRESS,
                  "initializeImmutableOwner",
                  { account: quote.sourceTokenAddress },
                  2,
                ),
                parsed(
                  TOKEN_PROGRAM_ADDRESS,
                  "initializeAccount3",
                  {
                    account: quote.sourceTokenAddress,
                    mint: NOS_MINT,
                    owner: host,
                  },
                  2,
                ),
              ],
            },
          ]
        : null,
    },
  };
}
test("claim review uses only fresh approved cached rewards including positive sub-NOS amounts", async () => {
  const f = fixture();
  f.reward({ amount: "0.000001" });
  const quote = await f.driver.prepare(context, host);
  assert.equal(quote.lastReportedAmountBaseUnits, "1");
  assert.equal(quote.checkedAtMs, base);
  assert.equal(quote.expiresAtMs, base + 60_000);
  assert.equal(f.commands.length, 0);
  assert.equal(f.rpcCalls.length, 0);
  for (const update of [
    { amount: "0.000000" },
    { status: "unavailable" as const },
    { observedAtMs: base - 300_000 },
  ]) {
    const g = fixture();
    g.reward(update);
    await assert.rejects(
      g.driver.prepare(context, host),
      TreasuryPreflightError,
    );
    assert.equal(g.commands.length, 0);
  }
  const denied = fixture();
  denied.values.set(
    `monitor:reward-denial:${context.scopeId}:${association.binding.pcId}:${host}`,
    { approvedAtMs: base },
  );
  await assert.rejects(
    denied.driver.prepare(context, host),
    TreasuryPreflightError,
  );
});
test("verified source gets one fixed helper invocation and ACK survives owner locking afterward", async () => {
  const f = fixture(),
    quote = await f.driver.prepare(context, host);
  f.afterHandoff(f.revoke);
  const result = await f.driver.dispatch(quote, f.guard);
  assert.equal(result.status, "acknowledged");
  assert.equal(result.claimedAmountAtoms, "2345678");
  assert.equal(result.amountUnit, "base-units");
  assert.equal(f.helperCalls(), 1);
  assert.equal(f.commands.at(-1)!.timeoutMs, 75_000);
  assert(f.commands.at(-1)!.command.includes("/usr/bin/env -i"));
  assert(!f.commands.some((row) => row.command.includes("generated-password")));
  assert.equal(f.rpcCalls.length, 0);
  await assert.rejects(
    f.driver.dispatch(quote, () => {}),
    ClaimsNotDispatchedError,
  );
  assert.equal(f.helperCalls(), 1);
});
test("new helper responses require schema two and the explicit atomic-unit marker", async () => {
  const unmarked = { ...ack };
  delete unmarked.amountUnit;
  for (const result of [
    { schema: 1, address: host, ...unmarked },
    { schema: 2, address: host, ...unmarked },
    { schema: 2, address: host, ...ack, amountUnit: "NOS" },
  ]) {
    const f = fixture(),
      quote = await f.driver.prepare(context, host);
    f.rawOutput(JSON.stringify(result));
    const response = await f.driver.dispatch(quote, f.guard);
    assert.equal(response.status, "uncertain");
    assert.equal(response.amountUnit, "base-units");
    assert.equal(response.claimedAmountAtoms, undefined);
    assert.equal(f.helperCalls(), 1);
  }
});
test("identity, owner or provider eligibility changes stop before the claim helper", async () => {
  for (const kind of ["identity", "owner", "permission", "wait"]) {
    const f = fixture(),
      quote = await f.driver.prepare(context, host);
    if (kind === "identity") f.identity(other);
    else if (kind === "owner") f.onRead(f.revoke);
    else if (kind === "permission") f.permission.rewards = false;
    else
      f.values.set("monitor/provider-waits", { ip: 0, rewards: base + 60_000 });
    await assert.rejects(
      f.driver.dispatch(quote, f.guard),
      ClaimsNotDispatchedError,
    );
    assert.equal(f.helperCalls(), 0);
  }
});
test("lost helper response remains uncertain and cannot cause a second POST", async () => {
  const f = fixture(),
    quote = await f.driver.prepare(context, host);
  f.lose();
  assert.equal((await f.driver.dispatch(quote, f.guard)).status, "uncertain");
  assert.equal(f.helperCalls(), 1);
  await assert.rejects(
    f.driver.dispatch(quote, f.guard),
    ClaimsNotDispatchedError,
  );
  assert.equal(f.helperCalls(), 1);
});
test("claim Retry-After extends shared reward waits and never shortens concurrent monitor waits", async () => {
  const f = fixture(),
    quote = await f.driver.prepare(context, host);
  f.response({
    status: "rate-limited",
    success: null,
    retryAfterSeconds: 180,
    observedAtMs: base,
  });
  f.afterHandoff(() =>
    f.values.set("monitor/provider-waits", {
      ip: base + 40_000,
      rewards: base + 900_000,
    }),
  );
  const result = await f.driver.dispatch(quote, f.guard);
  assert.equal(result.status, "rate-limited");
  assert.deepEqual(f.values.get("monitor/provider-waits"), {
    ip: base + 40_000,
    rewards: base + 900_000,
  });
});
test("receipt supports actual v0 ComputeBudget/Transfer/ComputeBudget ordering and checked legacy transfers", async () => {
  const f = fixture(),
    quote = await f.driver.prepare(context, host);
  for (const input of [
    { version: 0 },
    { version: "legacy" as const, checked: true },
    { version: 0, createAta: true },
  ]) {
    const result = await verifyClaimReceipt(
      { quote, dispatch: ack },
      payout(quote, input),
      base + 1000,
    );
    assert.equal(result.status, "confirmed");
    assert.equal(result.paidAmountBaseUnits, "2345678");
    assert.equal(result.payoutOwner, host);
    assert.equal(result.payoutTokenAddress, quote.sourceTokenAddress);
  }
});
test("extra recipients, wrong owner/mint/amount, unfamiliar inner instructions and missing API evidence never confirm", async () => {
  const f = fixture(),
    quote = await f.driver.prepare(context, host);
  const edits: ((value: ReturnType<typeof payout>) => void)[] = [
    (value) => {
      value.transaction.signatures[0] = getBase58Decoder().decode(
        Buffer.alloc(64, 9),
      );
    },
    (value) => {
      value.meta.postTokenBalances[1]!.owner = other;
    },
    (value) => {
      value.meta.postTokenBalances[1]!.mint = other;
    },
    (value) => {
      value.meta.postTokenBalances[1]!.uiTokenAmount.amount = "40345679";
    },
    (value) => {
      value.transaction.message.instructions.push(
        structuredClone(value.transaction.message.instructions[1]!),
      );
    },
    (value) => {
      value.meta.postTokenBalances.push({
        ...value.meta.postTokenBalances[1]!,
        accountIndex: 3,
      });
    },
    (value) => {
      value.version = 1;
    },
    (value) => {
      value.transaction.message.instructions[2] = structuredClone(
        value.transaction.message.instructions[0]!,
      );
    },
  ];
  for (const edit of edits) {
    const result = payout(quote);
    edit(result);
    assert.equal(
      (await verifyClaimReceipt({ quote, dispatch: ack }, result, base)).status,
      "uncertain",
    );
  }
  const nested = payout(quote, { createAta: true });
  nested.meta.innerInstructions![0]!.instructions[0]!.programId = other;
  assert.equal(
    (await verifyClaimReceipt({ quote, dispatch: ack }, nested, base)).status,
    "uncertain",
  );
  for (const dispatch of [
    { ...ack, success: false },
    { ...ack, signature: undefined },
    { ...ack, claimedAmountAtoms: undefined },
  ])
    assert.equal(
      (
        await verifyClaimReceipt(
          { quote, dispatch: dispatch as ClaimsDispatchResult },
          payout(quote),
          base,
        )
      ).status,
      "uncertain",
    );
});
test("driver reconciles only captured ACK signature through shared finalized RPC and never dispatches another claim", async () => {
  const f = fixture(),
    quote = await f.driver.prepare(context, host);
  f.transaction(payout(quote));
  assert.equal(
    (await f.driver.reconcile({ quote, dispatch: ack })).status,
    "confirmed",
  );
  assert.deepEqual(f.rpcCalls, ["getGenesisHash", "getTransaction"]);
  assert.equal(f.helperCalls(), 0);
  const noAck = fixture();
  assert.equal(
    (
      await noAck.driver.reconcile({
        quote,
        dispatch: { status: "uncertain", success: null, observedAtMs: base },
      })
    ).status,
    "uncertain",
  );
  assert.equal(noAck.rpcCalls.length, 0);
  const failed = payout(quote);
  (failed.meta as { err: unknown }).err = { InstructionError: [1, "failed"] };
  assert.equal(
    (await verifyClaimReceipt({ quote, dispatch: ack }, failed, base)).status,
    "failed",
  );
});
test("legacy normalization correction requires exact finalized proof from the same single receipt read", async () => {
  const f = fixture(),
    quote = await f.driver.prepare(context, host);
  const legacy: ClaimsDispatchResult = {
    ...ack,
    claimedAmountAtoms: (
      BigInt(ack.claimedAmountAtoms!) * 1_000_000n
    ).toString(),
  };
  delete legacy.amountUnit;
  const original = structuredClone(legacy);
  f.transaction(payout(quote));
  const result = await f.driver.reconcile({ quote, dispatch: legacy });
  assert.equal(result.status, "confirmed");
  assert.equal(result.paidAmountBaseUnits, ack.claimedAmountAtoms);
  assert.deepEqual(result.amountCorrection, {
    kind: "legacy-post-base-units",
    originalClaimedAmountAtoms: legacy.claimedAmountAtoms,
    correctedClaimedAmountAtoms: ack.claimedAmountAtoms,
  });
  assert.deepEqual(
    legacy,
    original,
    "The driver must not mutate captured audit evidence.",
  );
  assert.deepEqual(f.rpcCalls, ["getGenesisHash", "getTransaction"]);
  assert.equal(f.commands.length, 0);
  assert.equal(f.helperCalls(), 0);
});
test("legacy amounts that already match finalized payment are verified as recorded without conversion", async () => {
  const f = fixture(),
    quote = await f.driver.prepare(context, host);
  const legacy: ClaimsDispatchResult = {
    ...ack,
    claimedAmountAtoms: "2000000",
  };
  delete legacy.amountUnit;
  f.transaction(payout(quote, { amount: "2000000" }));
  const result = await f.driver.reconcile({ quote, dispatch: legacy });
  assert.equal(result.status, "confirmed");
  assert.equal(result.paidAmountBaseUnits, "2000000");
  assert.equal(result.amountCorrection, undefined);
  assert.deepEqual(f.rpcCalls, ["getGenesisHash", "getTransaction"]);
});
test("newly marked amounts, nonintegral legacy reversal and invalid payout proofs never receive a correction", async () => {
  for (const kind of [
    "marked",
    "nonintegral",
    "recipient",
    "mint",
    "amount",
    "signature",
    "unfinalized",
    "failed",
  ]) {
    const f = fixture(),
      quote = await f.driver.prepare(context, host);
    const captured: ClaimsDispatchResult = {
      ...ack,
      claimedAmountAtoms: (
        BigInt(ack.claimedAmountAtoms!) * 1_000_000n
      ).toString(),
    };
    if (kind !== "marked") delete captured.amountUnit;
    if (kind === "nonintegral")
      captured.claimedAmountAtoms = (
        BigInt(captured.claimedAmountAtoms!) + 1n
      ).toString();
    const transaction = payout(quote);
    if (kind === "recipient")
      transaction.meta.postTokenBalances[1]!.owner = other;
    if (kind === "mint") transaction.meta.postTokenBalances[1]!.mint = other;
    if (kind === "amount")
      transaction.meta.postTokenBalances[1]!.uiTokenAmount.amount = "40345679";
    if (kind === "signature")
      transaction.transaction.signatures[0] = getBase58Decoder().decode(
        Buffer.alloc(64, 7),
      );
    if (kind === "failed")
      (transaction.meta as { err: unknown }).err = {
        InstructionError: [1, "failed"],
      };
    f.transaction(kind === "unfinalized" ? null : transaction);
    const result = await f.driver.reconcile({ quote, dispatch: captured });
    assert.equal(
      result.status,
      kind === "failed" ? "failed" : "uncertain",
      kind,
    );
    assert.equal(result.amountCorrection, undefined, kind);
    assert.deepEqual(f.rpcCalls, ["getGenesisHash", "getTransaction"], kind);
    assert.equal(f.commands.length, 0);
  }
});
