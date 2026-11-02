import assert from "node:assert/strict";
import test from "node:test";
import { createSolanaRpc, SolanaRpcError } from "../scripts/solana-rpc.ts";

test("revocation while a financial submission waits for shared RPC capacity prevents its network dispatch", async () => {
  const methods: string[] = [];
  const transport = createSolanaRpc({ fetch: (async (_url, options) => {
    const body = JSON.parse(String(options?.body)); methods.push(body.method);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "fixture" }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch });
  const provider = transport.createSession("treasury-test").eligible()!;
  const signal = new AbortController().signal;
  await transport.rpc(provider, "getGenesisHash", [], signal, Date.now() + 5000);
  assert.equal(transport.canDispatchBefore(3, Date.now() + 5000), true);
  assert.equal(transport.canDispatchBefore(12, Date.now() + 20_000), false);
  assert.equal(transport.canDispatchBefore(3, Date.now() + 5000), true, "forecasting must not reserve actual RPC allowance");
  let authorized = true;
  const queued = transport.rpc(provider, "sendTransaction", ["fixture-signed-bytes"], signal, Date.now() + 5000, () => {
    if (!authorized) throw new Error("Financial authorization revoked");
  });
  authorized = false;
  await assert.rejects(queued, /Financial authorization revoked/);
  assert.deepEqual(methods, ["getGenesisHash"]);
  assert.equal(provider.failures, 0);
});

for (const denied of [false, true]) test(`unsupported Wallet RPC leaves the Fleet balance provider eligible (${denied ? "HTTP denial" : "method error"})`, async () => {
  const transport = createSolanaRpc({ fetch: (async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    if (body.method === "simulateTransaction") return denied ? new Response("denied", { status: 403 })
      : new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "unsupported" } }));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { context: { slot: 1 }, value: [] } }));
  }) as typeof fetch });
  const treasury = transport.createSession("treasury"), balances = transport.createSession("nos"), provider = treasury.eligible()!;
  await assert.rejects(transport.rpc(provider, "simulateTransaction", [], new AbortController().signal, Date.now() + 5000), error => {
    assert(error instanceof SolanaRpcError); assert.equal(error.scope, "asset"); treasury.failure(provider, error); return true;
  });
  assert.equal(provider.disabled, false); assert.equal(balances.eligible(), provider);
  assert.notEqual(treasury.eligible(), provider);
  assert.deepEqual(await transport.rpc(provider, "getMultipleAccounts", [], new AbortController().signal, Date.now() + 5000), { context: { slot: 1 }, value: [] });
});
