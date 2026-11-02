import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { generateKeyPairSync, sign } from "node:crypto";
import https from "node:https";
import type { spawnSync } from "node:child_process";
import { Script } from "node:vm";
import { base58 } from "../src/backend/rewards-reader.ts";
import {
  claimMain,
  claimResponse,
  createClaimRequest,
  isClaimSignature,
  rewardsClaimerSource,
} from "../src/backend/rewards-claimer.ts";
import { claimSignature } from "../src/contracts/treasury-claims.ts";

const key = generateKeyPairSync("ed25519"),
  owner = base58(
    key.publicKey.export({ type: "spki", format: "der" }).subarray(-32),
  );
const authorizationSignature = base58(
    sign(null, Buffer.from(owner), key.privateKey),
  ),
  signature = base58(
    sign(null, Buffer.from("generated payout transaction"), key.privateKey),
  ),
  authorization = owner + ":" + authorizationSignature,
  now = 1_800_000_000_000;
const require = createRequire(import.meta.url);
function transport(
  options: {
    status?: number;
    body?: string;
    headers?: Record<string, string>;
    loss?: boolean;
    stall?: boolean;
  } = {},
) {
  const requests: {
    url: unknown;
    options: Record<string, unknown>;
    endArgs: unknown[];
  }[] = [];
  const fake = {
    request: (
      url: unknown,
      input: Record<string, unknown>,
      callback: (response: EventEmitter) => void,
    ) => {
      const outgoing = new EventEmitter() as EventEmitter & {
        end: (...args: unknown[]) => void;
        destroy: () => void;
      };
      const record = { url, options: input, endArgs: [] as unknown[] };
      requests.push(record);
      outgoing.destroy = () => {};
      outgoing.end = (...args) => {
        record.endArgs = args;
        if (options.stall) return;
        queueMicrotask(() => {
          if (options.loss) {
            outgoing.emit("error", new Error("sensitive transport detail"));
            return;
          }
          const response = Object.assign(new EventEmitter(), {
            statusCode: options.status ?? 200,
            headers: options.headers ?? {},
            destroy: () => {},
          });
          callback(response);
          response.emit(
            "data",
            Buffer.from(
              options.body ??
                JSON.stringify({
                  success: true,
                  claimableAmount: 0.000001,
                  transactionSignature: signature,
                  message: "private provider prose",
                }),
            ),
          );
          response.emit("end");
        });
      };
      return outgoing;
    },
  } as unknown as typeof https;
  return { https: fake, requests };
}
function signerFixture() {
  const output = Buffer.from(authorization);
  let calls = 0;
  const child = ((
    file: string,
    args: string[],
    options: Record<string, unknown>,
  ) => {
    calls++;
    assert.equal(file, process.execPath);
    assert.equal(args[0], "-e");
    assert.equal(args[2], owner);
    assert.deepEqual(options.env, {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LANG: "C",
    });
    assert.deepEqual(options.stdio, ["ignore", "pipe", "ignore"]);
    assert(!args.includes(authorization));
    return {
      pid: 123,
      output: [null, output, null],
      stdout: output,
      stderr: Buffer.alloc(0),
      status: 0,
      signal: null,
    };
  }) as unknown as typeof spawnSync;
  return { spawnSync: child, output, calls: () => calls };
}
test("claim response preserves exact positive six-decimal numeric lexemes and only public receipt fields", () => {
  assert.equal(
    claimResponse('{"success":true,"claimableAmount":9007199254.740991}')
      .claimedAmountAtoms,
    "9007199254740991",
  );
  assert.equal(
    claimResponse('{"success":true,"claimableAmount":1.001e-3}')
      .claimedAmountAtoms,
    "1001",
  );
  assert.equal(
    claimResponse('{"success":true,"claimableAmount":0.000001}')
      .claimedAmountAtoms,
    "1",
  );
  const result = claimResponse(
    JSON.stringify({
      success: true,
      claimableAmount: 1,
      transactionSignature: signature,
      message: "Authorization: secret",
      privateKey: "secret",
      daysProcessed: 4,
    }),
  );
  assert.deepEqual(result, {
    status: "acknowledged",
    success: true,
    claimedAmountAtoms: "1000000",
    signature,
  });
  assert.equal(
    claimResponse('{"success":true,"claimableAmount":0}').claimedAmountAtoms,
    undefined,
  );
  for (const raw of [
    '{"success":true,"claimableAmount":1,"claimableAmount":2}',
    '{"success":true,"claimableAmount":"1"}',
    '{"success":true,"claimableAmount":0.0000001}',
    '{"success":true,"claimableAmount":-1}',
    '{"success":true,"success":false}',
    '{"success":true,"transactionSignature":"bad"}',
  ])
    assert.throws(() => claimResponse(raw));
});
test("claim signature validation agrees with browser contract and requires exactly 64 decoded bytes", () => {
  for (const value of [
    signature,
    "1".repeat(64),
    "1".repeat(63),
    "z".repeat(88),
    "1".repeat(65),
    "bad",
    null,
  ])
    assert.equal(isClaimSignature(value), claimSignature(value));
  assert(isClaimSignature(signature));
  assert(!isClaimSignature("z".repeat(88)));
});
test("one fixed HTTPS empty-body POST keeps authorization inside the helper and wipes child output", async () => {
  const network = transport(),
    child = signerFixture();
  let guarded = 0;
  const result = await claimMain(["--gridlens-approved-uptime-claim", owner], {
    ...network,
    ...child,
    safeguards: () => {
      guarded++;
    },
    now: () => now,
    monotonic: () => 0,
  });
  assert.equal(guarded, 1);
  assert.equal(child.calls(), 1);
  assert.equal(network.requests.length, 1);
  const request = network.requests[0]!;
  assert.equal(
    request.url,
    "https://dashboard.k8s.prd.nos.ci/api/nodes/payment",
  );
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.rejectUnauthorized, true);
  assert.equal(request.options.agent, false);
  assert.deepEqual(request.endArgs, []);
  assert.deepEqual(request.options.headers, {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Content-Length": "0",
    Authorization: authorization,
  });
  assert.deepEqual(result, {
    schema: 1,
    address: owner,
    status: "acknowledged",
    success: true,
    claimedAmountAtoms: "1",
    signature,
    observedAtMs: now,
  });
  assert(child.output.every((byte) => byte === 0));
  assert(!JSON.stringify(result).includes(authorization));
});
test("redirect, refusal, timeout and response loss never follow or repeat a claim POST", async () => {
  for (const options of [
    { status: 302, headers: { location: "https://other.invalid/claim" } },
    { status: 503 },
    { loss: true },
    { stall: true },
  ]) {
    const network = transport(options),
      request = createClaimRequest({
        ...network,
        now: () => now,
        monotonic: () => 0,
      });
    const result = await request(authorization, options.stall ? 5 : 1000);
    assert.equal(result.status, "uncertain");
    await request(authorization, 1000);
    assert.equal(network.requests.length, 1);
  }
});
test("an API-echoed authentication signature never leaves the source helper as a receipt", async () => {
  assert.notEqual(signature, authorizationSignature);
  const network = transport({
    body: JSON.stringify({
      success: true,
      claimableAmount: 2,
      transactionSignature: authorizationSignature,
    }),
    headers: { "retry-after": "180" },
  });
  const child = signerFixture();
  const result = await claimMain(["--gridlens-approved-uptime-claim", owner], {
    ...network,
    ...child,
    safeguards: () => {},
    now: () => now,
    monotonic: () => 0,
  });
  assert.deepEqual(result, {
    schema: 1,
    address: owner,
    status: "uncertain",
    success: null,
    observedAtMs: now,
    retryAfterSeconds: 180,
  });
  assert.equal(network.requests.length, 1);
  assert(child.output.every((byte) => byte === 0));
  assert(!JSON.stringify(result).includes(authorizationSignature));
  assert(!JSON.stringify(result).includes(authorization));
});
test("rate limits carry bounded Retry-After without leaking response messages or headers", async () => {
  const network = transport({
    status: 429,
    headers: { "retry-after": "180" },
    body: '{"message":"secret provider error"}',
  });
  const result = await createClaimRequest({
    ...network,
    now: () => now,
    monotonic: () => 0,
  })(authorization, 1000);
  assert.deepEqual(result, {
    status: "rate-limited",
    success: null,
    observedAtMs: now,
    retryAfterSeconds: 180,
  });
  const oversized = transport({ body: "x".repeat(16_385) });
  assert.equal(
    (
      await createClaimRequest({
        ...oversized,
        now: () => now,
        monotonic: () => 0,
      })(authorization, 1000)
    ).status,
    "uncertain",
  );
});
test("invalid markers, extra arguments and failed safeguards never invoke authentication or HTTP", async () => {
  for (const args of [
    ["--wrong", owner],
    ["--gridlens-approved-uptime-claim", owner, "https://other.invalid"],
    ["--gridlens-approved-uptime-claim", "invalid"],
  ]) {
    const network = transport(),
      child = signerFixture();
    await claimMain(args, {
      ...network,
      ...child,
      safeguards: () => {},
      now: () => now,
    });
    assert.equal(child.calls(), 0);
    assert.equal(network.requests.length, 0);
  }
  const network = transport(),
    child = signerFixture();
  await claimMain(["--gridlens-approved-uptime-claim", owner], {
    ...network,
    ...child,
    safeguards: () => {
      throw Error();
    },
    now: () => now,
  });
  assert.equal(child.calls(), 0);
  assert.equal(network.requests.length, 0);
});
test("standalone generated helper executes without app imports and exports only normalized acknowledgment", async () => {
  const network = transport(),
    source = rewardsClaimerSource();
  new Script(source);
  let childCalls = 0;
  const output = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(Error("Fixture helper timed out")),
      2000,
    );
    const child = ((_file: string, args: string[]) => {
      childCalls++;
      assert.equal(args[2], owner);
      return {
        pid: 1,
        output: [],
        stdout: Buffer.from(authorization),
        stderr: Buffer.alloc(0),
        status: 0,
        signal: null,
      };
    }) as unknown as typeof spawnSync;
    const fakeFs = {
      readFileSync: (path: string) => {
        if (path === "/proc/self/limits")
          return "Max core file size  0  0  bytes\n";
        if (path === "/proc/self/coredump_filter") return "00000000";
        throw Error("No wallet file may be read in parent fixture");
      },
    };
    const processFixture = {
      argv: ["node", "--gridlens-approved-uptime-claim", owner],
      execPath: "fixture-node",
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C" },
      stdout: {
        write: (text: string) => {
          clearTimeout(timeout);
          resolve(text);
        },
      },
      set exitCode(value: number) {
        if (value) {
          clearTimeout(timeout);
          reject(Error("Helper failed"));
        }
      },
    };
    new Script(source).runInNewContext({
      require: (name: string) =>
        name === "node:https"
          ? network.https
          : name === "node:child_process"
            ? { spawnSync: child }
            : name === "node:fs"
              ? fakeFs
              : require(name),
      process: processFixture,
      Buffer,
      TextDecoder,
      setTimeout,
      clearTimeout,
    });
  });
  assert.equal(childCalls, 1);
  assert.equal(network.requests.length, 1);
  const parsed = JSON.parse(output);
  assert.equal(parsed.status, "acknowledged");
  assert.equal(parsed.claimedAmountAtoms, "1");
  assert(!output.includes(authorization));
  assert(!output.includes("private provider prose"));
});
