import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import https from "node:https";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { TextDecoder } from "node:util";
import {
  base58,
  ownerValid,
  safeguards,
  walletBytes,
  sign,
  signerSource,
  retryAfter,
} from "./rewards-reader.ts";
import type { ClaimsDispatchResult } from "./treasury-claims.ts";

const CLAIM_URL = "https://dashboard.k8s.prd.nos.ci/api/nodes/payment";
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ENV = Object.freeze({ PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C" });
const MAX_RETRY_SECONDS = 2147483647;
const MAX_CLAIM_RESPONSE_BYTES = 16_384;
export interface ClaimHelperResult extends ClaimsDispatchResult {
  schema: 2;
  amountUnit: "base-units";
  address: string;
}
export interface ClaimHelperDeps {
  now?: () => number;
  monotonic?: () => number;
  safeguards?: () => void;
  spawnSync?: typeof spawnSync;
  https?: typeof https;
}
export function isClaimSignature(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value))
    return false;
  let integer = 0n,
    size = 0;
  for (const char of value)
    integer = integer * 58n + BigInt(ALPHABET.indexOf(char));
  while (integer) {
    size++;
    integer /= 256n;
  }
  return size + (value.match(/^1*/)?.[0].length ?? 0) === 64;
}
/** POST /nodes/payment reports atomic units. This is deliberately separate
 * from the GET rewards reader, which reports decimal NOS. Parse the original
 * numeric token without IEEE-754 rounding and never infer a different unit. */
export function claimAtomicAmount(token: unknown): string {
  if (typeof token !== "string" || token.length > 128) throw Error();
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match) throw Error();
  const exponent = Number(match[3] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100)
    throw Error();
  const fraction = match[2] ?? "";
  let amount = BigInt(match[1]! + fraction);
  const scale = fraction.length - exponent;
  if (scale > 0) {
    const divisor = 10n ** BigInt(scale);
    if (amount % divisor !== 0n) throw Error();
    amount /= divisor;
  } else {
    amount *= 10n ** BigInt(-scale);
  }
  if (amount > 18_446_744_073_709_551_615n) throw Error();
  return amount.toString();
}
/** Preserve numeric lexemes and reject duplicate top-level fields. Never retain
 * the upstream message, raw response, or arbitrary additional fields. */
export function claimResponse(
  raw: string,
): Pick<
  ClaimsDispatchResult,
  "status" | "success" | "claimedAmountAtoms" | "signature" | "amountUnit"
> {
  if (Buffer.byteLength(raw) > MAX_CLAIM_RESPONSE_BYTES) throw Error();
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error();
  const parsed = value as Record<string, unknown>;
  if (typeof parsed.success !== "boolean") throw Error();
  const text = raw.trim(),
    tokens = new Map<string, string>();
  let i = 1;
  const ws = () => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  const endString = (start: number): number => {
    for (let at = start + 1; at < text.length; at++) {
      if (text[at] === "\\") {
        at++;
        continue;
      }
      if (text[at] === '"') return at + 1;
    }
    throw Error();
  };
  for (;;) {
    ws();
    if (text[i] === "}") break;
    if (text[i] !== '"') throw Error();
    const end = endString(i),
      key = JSON.parse(text.slice(i, end)) as string;
    if (tokens.has(key)) throw Error();
    i = end;
    ws();
    if (text[i++] !== ":") throw Error();
    ws();
    const start = i;
    let depth = 0;
    while (i < text.length) {
      const char = text[i];
      if (char === '"') {
        i = endString(i);
        continue;
      }
      if (char === "[" || char === "{") {
        depth++;
        if (depth > 16) throw Error();
      }
      if (char === "]" || char === "}") {
        if (depth === 0) break;
        depth--;
      }
      if (char === "," && depth === 0) break;
      i++;
    }
    tokens.set(key, text.slice(start, i).trim());
    if (text[i] === ",") {
      i++;
      continue;
    }
    if (text[i] === "}") break;
    throw Error();
  }
  let claimedAmountAtoms: string | undefined;
  if (tokens.has("claimableAmount")) {
    const amount = claimAtomicAmount(tokens.get("claimableAmount"));
    if (amount !== "0") claimedAmountAtoms = amount;
  }
  if (
    parsed.transactionSignature !== undefined &&
    !isClaimSignature(parsed.transactionSignature)
  )
    throw Error();
  return {
    status: parsed.success ? "acknowledged" : "rejected",
    success: parsed.success,
    amountUnit: "base-units",
    ...(claimedAmountAtoms === undefined ? {} : { claimedAmountAtoms }),
    ...(typeof parsed.transactionSignature === "string"
      ? { signature: parsed.transactionSignature }
      : {}),
  };
}
/** One closure permits one fixed POST, including after timeout or response loss.
 * It is used only by the short-lived helper inside the verified source node. */
export function createClaimRequest(deps: ClaimHelperDeps = {}) {
  let used = false;
  const now = deps.now ?? Date.now,
    monotonic = deps.monotonic ?? (() => performance.now()),
    transport = deps.https ?? https;
  return (
    authorization: string,
    deadline: number,
  ): Promise<ClaimsDispatchResult> => {
    const uncertain = (): ClaimsDispatchResult => ({
      status: "uncertain",
      success: null,
      amountUnit: "base-units",
      observedAtMs: now(),
    });
    if (used) return Promise.resolve(uncertain());
    used = true;
    return new Promise((resolve) => {
      let outgoing: ReturnType<typeof https.request> | undefined,
        timer: ReturnType<typeof setTimeout> | undefined,
        finished = false;
      const finish = (result: ClaimsDispatchResult): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        outgoing?.destroy();
        resolve(result);
      };
      const remaining = Math.floor(Math.min(60_000, deadline - monotonic()));
      if (remaining <= 0) {
        finish(uncertain());
        return;
      }
      timer = setTimeout(() => finish(uncertain()), remaining);
      try {
        outgoing = transport.request(
          CLAIM_URL,
          {
            method: "POST",
            agent: false,
            rejectUnauthorized: true,
            minVersion: "TLSv1.2",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "Content-Length": "0",
              Authorization: authorization,
            },
          },
          (response) => {
            const retry = retryAfter(response.headers["retry-after"], now()),
              wait = retry === undefined ? {} : { retryAfterSeconds: retry };
            const status = response.statusCode;
            response.on("error", () => finish({ ...uncertain(), ...wait }));
            response.on("aborted", () => finish({ ...uncertain(), ...wait }));
            if (status !== 200) {
              finish({
                ...uncertain(),
                ...wait,
                status:
                  status === 429
                    ? "rate-limited"
                    : status === 401 || status === 403
                      ? "authentication-failed"
                      : "uncertain",
              });
              response.destroy();
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > MAX_CLAIM_RESPONSE_BYTES) {
                finish({ ...uncertain(), ...wait });
                response.destroy();
              } else chunks.push(Buffer.from(chunk));
            });
            response.on("end", () => {
              try {
                const result = claimResponse(
                  new TextDecoder("utf-8", { fatal: true }).decode(
                    Buffer.concat(chunks),
                  ),
                );
                // A reflected authentication signature is not a public receipt.
                // The known host address would make it a reusable credential.
                if (
                  result.signature ===
                  authorization.slice(authorization.indexOf(":") + 1)
                ) {
                  finish({ ...uncertain(), ...wait });
                  return;
                }
                finish({
                  ...result,
                  observedAtMs: now(),
                  ...wait,
                });
              } catch {
                finish({ ...uncertain(), ...wait });
              }
            });
          },
        );
        outgoing.on("error", () => finish(uncertain()));
        outgoing.end();
      } catch {
        finish(uncertain());
      }
    });
  };
}
export async function claimMain(
  argv: string[],
  deps: ClaimHelperDeps = {},
): Promise<ClaimHelperResult> {
  const now = deps.now ?? Date.now,
    monotonic = deps.monotonic ?? (() => performance.now()),
    owner = argv[1];
  const result: ClaimHelperResult = {
    schema: 2,
    amountUnit: "base-units",
    address: ownerValid(owner) ? owner : "",
    status: "uncertain",
    success: null,
    observedAtMs: now(),
  };
  if (
    argv.length !== 2 ||
    argv[0] !== "--gridlens-approved-uptime-claim" ||
    !ownerValid(owner)
  )
    return result;
  try {
    (deps.safeguards ?? safeguards)();
  } catch {
    return result;
  }
  let child: ReturnType<typeof spawnSync> | undefined;
  try {
    child = (deps.spawnSync ?? spawnSync)(
      process.execPath,
      ["-e", signerSource(), owner],
      {
        env: ENV,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
        killSignal: "SIGKILL",
        maxBuffer: 256,
        encoding: "buffer",
        windowsHide: true,
      },
    );
    if (
      child.error ||
      child.status !== 0 ||
      child.signal ||
      !Buffer.isBuffer(child.stdout)
    )
      return { ...result, observedAtMs: now() };
    const authorization = child.stdout.toString("ascii");
    if (
      !authorization.startsWith(owner + ":") ||
      !isClaimSignature(authorization.slice(owner.length + 1))
    )
      throw Error();
    return {
      schema: 2,
      amountUnit: "base-units",
      address: owner,
      ...(await createClaimRequest(deps)(authorization, monotonic() + 60_000)),
    };
  } catch {
    return { ...result, observedAtMs: now() };
  } finally {
    if (Buffer.isBuffer(child?.stdout)) child.stdout.fill(0);
  }
}
/** Authentication never crosses the source-container boundary. This source does
 * not import application files, fetch code, or accept arbitrary destinations. */
export function rewardsClaimerSource(): string {
  // The imports below are represented explicitly inside this standalone helper.
  void fs;
  void crypto;
  void os;
  return (
    "'use strict';const fs=require('node:fs'),crypto=require('node:crypto'),os=require('node:os'),https=require('node:https');" +
    "const {spawnSync}=require('node:child_process'),{performance}=require('node:perf_hooks'),{TextDecoder}=require('node:util');" +
    "const ALPHABET=" +
    JSON.stringify(ALPHABET) +
    ";const ENV=" +
    JSON.stringify(ENV) +
    ";const MAX_RETRY_SECONDS=" +
    MAX_RETRY_SECONDS +
    ";const CLAIM_URL=" +
    JSON.stringify(CLAIM_URL) +
    ";const MAX_CLAIM_RESPONSE_BYTES=" +
    MAX_CLAIM_RESPONSE_BYTES +
    ";" +
    [
      base58,
      ownerValid,
      safeguards,
      walletBytes,
      sign,
      signerSource,
      retryAfter,
      claimAtomicAmount,
      isClaimSignature,
      claimResponse,
      createClaimRequest,
      claimMain,
    ]
      .map((fn) => fn.toString())
      .join("\n") +
    "\nclaimMain(process.argv.slice(1)).then(result=>{process.stdout.write(JSON.stringify(result)+'\\n');process.exitCode=0}).catch(()=>{process.exitCode=1});"
  );
}
