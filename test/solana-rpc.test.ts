import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createSolProvider } from "../scripts/sol.ts";
import { createSolanaRpc, MAINNET_GENESIS_HASH, SOLANA_PROVIDERS, SolanaRpcError } from "../scripts/solana-rpc.ts";

const base = 1_800_000_000_000;
const host = "11111111111111111111111111111112";
function reply(id: number, result: unknown): Response { return Response.json({ jsonrpc: "2.0", id, result }); }

test("shared provider preference is Labs, PublicNode, Vibe, then OnFinality", () => {
  assert.deepEqual(SOLANA_PROVIDERS.map(provider => provider.name), ["Solana Labs", "PublicNode", "Solana Vibe Station", "OnFinality"]);
});

test("overlapping failures preserve Retry-After, failure counts and a newer working alternate", () => {
  let time = base;
  const rpc = createSolanaRpc({ now: () => time });
  const nos = rpc.createSession();
  const sol = rpc.createSession();
  const provider = nos.eligible()!;
  const earlierHealth = provider.healthVersion;
  nos.failure(provider, new SolanaRpcError("busy", "provider", base + 3_600_000, "transport"));
  sol.failure(provider, new SolanaRpcError("unavailable", "provider", null, "transport"));
  assert.equal(provider.retryAtMs, base + 3_600_000);
  assert.equal(provider.failures, 2);
  const alternate = sol.eligible()!;
  assert.notEqual(alternate, provider);
  sol.success(alternate, alternate.healthVersion);
  sol.success(provider, earlierHealth);
  assert.equal(provider.failures, 2);
  assert.equal(provider.retryAtMs, base + 3_600_000);
  time += 3_600_000;
  assert.equal(sol.eligible(), alternate, "earlier partial success must not displace the working alternate after cooldown");
});

test("a coalesced transport failure is counted once across assets", () => {
  const rpc = createSolanaRpc({ now: () => base });
  const a = rpc.createSession();
  const b = rpc.createSession();
  const provider = a.eligible()!;
  const error = new SolanaRpcError("network", "provider", null, "transport");
  a.failure(provider, error);
  b.failure(provider, error);
  assert.equal(provider.failures, 1);
  assert.equal(provider.healthVersion, 1);
  assert.equal(provider.retryAtMs, base + 60_000);
});

test("short or elapsed Retry-After cannot replace exponential transport backoff", async () => {
  for (const header of ["0", "1", new Date(base - 60_000).toUTCString()]) {
    let time = base;
    let calls = 0;
    const rpc = createSolanaRpc({ now: () => time, fetch: async () => {
      calls++;
      return new Response("busy", { status: 429, headers: { "Retry-After": header } });
    } });
    const session = rpc.createSession();
    const provider = session.eligible()!;
    const signal = new AbortController().signal;
    for (const delay of [60_000, 120_000, 240_000, 480_000, 900_000, 900_000]) {
      const attemptedAt = time;
      await assert.rejects(rpc.rpc(provider, "getGenesisHash", [], signal, time + 28_000), error => {
        assert(error instanceof SolanaRpcError);
        session.failure(provider, error);
        return true;
      });
      assert.equal(provider.retryAtMs, attemptedAt + delay,
        "the server pause is a minimum, not a replacement for local failure backoff");
      time = attemptedAt + delay - 1;
      const beforeRetry = calls;
      await assert.rejects(rpc.rpc(provider, "getGenesisHash", [], signal, time + 28_000), error =>
        error instanceof SolanaRpcError && error.kind === "deferred");
      assert.equal(calls, beforeRetry);
      time++;
    }
    assert.equal(calls, 6);
  }
});

test("paced work rechecks permanent disable after another asset's denied response", async () => {
  let time = base;
  let releaseResponse!: () => void;
  let releaseSleep!: () => void;
  let sleeping = false;
  let calls = 0;
  const rpc = createSolanaRpc({ now: () => time,
    sleep: async ms => { sleeping = true; await new Promise<void>(resolve => { releaseSleep = resolve; }); time += ms; },
    fetch: async () => { calls++; await new Promise<void>(resolve => { releaseResponse = resolve; }); return new Response("denied", { status: 403 }); } });
  const session = rpc.createSession();
  const provider = session.eligible()!;
  const signal = new AbortController().signal;
  const first = rpc.rpc(provider, "getAccountInfo", [], signal, base + 28_000).catch((error: unknown) => {
    assert(error instanceof SolanaRpcError);
    session.failure(provider, error);
  });
  const second = rpc.rpc(provider, "getMultipleAccounts", [], signal, base + 28_000);
  const rejected = assert.rejects(second, /disabled/);
  while (!sleeping) await setImmediate();
  releaseResponse();
  await first;
  assert(provider.disabled);
  releaseSleep();
  await rejected;
  assert.equal(calls, 1);
});

test("partial SOL success and alternate recovery cannot reset a newer NOS transport failure", async () => {
  let time = base;
  let calls = 0;
  let injected = false;
  const rpc = createSolanaRpc({ now: () => time, sleep: async ms => {
    time += ms;
    if (calls === 3 && !injected) {
      injected = true;
      other.failure(provider, new SolanaRpcError("overlapping NOS failure", "provider", null, "transport"));
    }
  }, fetch: async (_input, init) => {
    calls++;
    const { id, method, params } = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    if (method === "getGenesisHash") return reply(id, MAINNET_GENESIS_HASH);
    if (method === "getBlockTime") return reply(id, time / 1000);
    return reply(id, { context: { slot: time / 1000 }, value: (params[0] as string[]).map(() => ({ lamports: 5 })) });
  } });
  const other = rpc.createSession();
  const provider = other.eligible()!;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const roster = Array.from({ length: 101 }, (_, index) => {
    const value = index + 1;
    return "1".repeat(31) + (value >= 58 ? alphabet[Math.floor(value / 58)] : "") + alphabet[value % 58];
  });
  const result = await createSolProvider({ rpc })(roster);
  assert.equal(result.hosts.filter(row => row.lamports === "5").length, 101);
  assert(result.hosts.slice(0, 100).every(row => row.provider === "Solana Labs" && row.error === null));
  assert.equal(result.hosts[100]!.provider, "PublicNode");
  assert.equal(result.hosts[100]!.error, null);
  assert(result.hosts[0]!.checkedAtMs! < result.hosts[100]!.checkedAtMs!);
  assert.equal(provider.failures, 1);
  assert(provider.retryAtMs > time, "alternate recovery retains the original provider's pause");
  assert.equal(calls, 6, "only the unvalidated remaining batch is read on the alternate");
});

test("RPC bounds total concurrency and canceled queued calls never dispatch", async () => {
  let time = base;
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const releases: (() => void)[] = [];
  const rpc = createSolanaRpc({ now: () => time, sleep: async ms => { time += ms; }, fetch: async (_input, init) => {
    calls++;
    active++;
    maximum = Math.max(maximum, active);
    await new Promise<void>(resolve => { releases.push(resolve); });
    active--;
    const { id } = JSON.parse(String(init?.body)) as { id: number };
    return reply(id, true);
  } });
  const provider = rpc.createSession().eligible()!;
  const signal = new AbortController().signal;
  const cancel = new AbortController();
  const first = rpc.rpc(provider, "getMultipleAccounts", [[host]], signal, base + 28_000);
  const second = rpc.rpc(provider, "getMultipleAccounts", [[host]], signal, base + 28_000);
  const third = rpc.rpc(provider, "getMultipleAccounts", [[host]], cancel.signal, base + 28_000);
  const canceled = assert.rejects(third, { name: "AbortError" });
  while (calls < 2) await setImmediate();
  cancel.abort();
  await canceled;
  for (const release of releases) release();
  await Promise.all([first, second]);
  assert.equal(calls, 2);
  assert.equal(maximum, 2);
});
