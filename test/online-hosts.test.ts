import assert from "node:assert/strict";
import test from "node:test";
import { createOnlineHostsProvider } from "../scripts/online-hosts.ts";
import { isOnlineRosterStatus } from "../src/contracts/online-hosts.ts";
import { ASCENDING_HOST_ADDRESSES } from "./fixtures/host-addresses.ts";

const [a, b, c, d, market] = ASCENDING_HOST_ADDRESSES as [string, string, string, string, string, ...string[]];
const queuedUrl = "https://blockchain-indexer.k8s.prd.nos.ci/markets/queued-nodes";
const runningUrl = "https://blockchain-indexer.k8s.prd.nos.ci/markets/running-nodes";
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const queue = (...addresses: string[]): unknown[] => addresses.map((nodeAddress, position) => ({
  marketAddress: market, nodeAddress, position,
}));

function fixture() {
  let time = 1_000_000;
  let queued: unknown = queue(b);
  let running: unknown = [c, b];
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let response: ((url: string) => Response) | null = null;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    return response?.(url) ?? Response.json(url === queuedUrl ? queued : running);
  };
  const provider = createOnlineHostsProvider({ fetch: fetcher, now: () => time });
  return { provider, calls, fetcher, now: () => time,
    advance(ms = 60_000) { time += ms; },
    payloads(q: unknown, r: unknown) { queued = q; running = r; },
    respond(value: ((url: string) => Response) | null) { response = value; },
  };
}

test("discovery is anonymous, complete, shared, cached and demand-only", async () => {
  const f = fixture();
  assert.deepEqual(f.provider.peek().addresses, []);
  assert.equal(f.calls.length, 0);
  const [first, joined] = await Promise.all([f.provider.read(), f.provider.read()]);
  assert.deepEqual(first.addresses, [b, c]);
  assert.deepEqual(joined, first);
  assert.equal(first.error, null);
  assert.equal(first.online.checkedAtMs, f.now());
  assert.equal(first.online.nextRefreshAtMs, f.now() + 60_000);
  assert.ok(first.online.revision);
  assert.equal(isOnlineRosterStatus(first.online), true);
  assert.deepEqual(f.calls.map(call => call.url).sort(), [queuedUrl, runningUrl]);
  for (const { init } of f.calls) {
    assert.equal(init?.method, "GET");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    assert.deepEqual(init?.headers, { Accept: "application/json" });
    assert.ok(init?.signal);
  }
  first.addresses.push(a);
  first.online.revision = "changed-outside";
  assert.deepEqual(f.provider.peek().addresses, [b, c]);
  assert.notEqual(f.provider.peek().online.revision, "changed-outside");
  await f.provider.read();
  assert.equal(f.calls.length, 2);
  f.advance(120_000);
  await tick();
  assert.equal(f.calls.length, 2, "an overdue cache never starts an unattended refresh");
  const unchanged = await f.provider.read();
  assert.equal(unchanged.online.revision, joined.online.revision);
  assert.equal(unchanged.online.checkedAtMs, f.now());
});

test("membership preserves survivors and appends sorted additions; removal needs two complete checks", async () => {
  const f = fixture();
  const initial = await f.provider.read();
  f.advance();
  f.payloads(queue(d), [a, b]);
  const added = await f.provider.read();
  assert.deepEqual(added.addresses, [b, c, a, d]);
  assert.notEqual(added.online.revision, initial.online.revision);
  f.advance();
  f.respond(url => url === runningUrl ? new Response("unavailable", { status: 503 }) : Response.json([]));
  const failed = await f.provider.read();
  assert.deepEqual(failed.addresses, added.addresses);
  assert.equal(failed.online.revision, added.online.revision);
  assert.equal(failed.online.checkedAtMs, added.online.checkedAtMs);
  assert.equal(failed.online.retained, true);
  assert.equal(failed.error, null);
  f.advance();
  f.respond(null);
  const removed = await f.provider.read();
  assert.deepEqual(removed.addresses, [b, a, d]);
  assert.notEqual(removed.online.revision, added.online.revision);
  assert.equal(removed.online.retained, false);
  f.advance();
  f.payloads([], [d, a, b]);
  assert.equal((await f.provider.read()).online.revision, removed.online.revision);
});

test("successful reappearance resets absence history and valid empty is established", async () => {
  const f = fixture();
  f.payloads([], []);
  const empty = await f.provider.read();
  assert.deepEqual(empty.addresses, []);
  assert.ok(empty.online.revision);
  assert.equal(empty.error, null);
  f.advance(); f.payloads([], [a]); await f.provider.read();
  f.advance(); f.payloads([], []); assert.deepEqual((await f.provider.read()).addresses, [a]);
  f.advance(); f.payloads([], [a]); await f.provider.read();
  f.advance(); f.payloads([], []); assert.deepEqual((await f.provider.read()).addresses, [a]);
  f.advance(); assert.deepEqual((await f.provider.read()).addresses, []);
  const second = createOnlineHostsProvider({ fetch: async () => Response.json([]), now: f.now });
  assert.notEqual((await second.read()).online.revision, empty.online.revision);
});

test("incomplete, malformed, duplicate and oversized rosters never publish a partial result", async t => {
  const cases: [string, unknown, unknown][] = [
    ["wrong root", {}, []],
    ["invalid host", queue(a), ["not-an-address"]],
    ["invalid market", [{ nodeAddress: a, marketAddress: "invalid", position: 0 }], [b]],
    ["fractional position", [{ nodeAddress: a, marketAddress: market, position: 0.5 }], [b]],
    ["missing queue position", [{ nodeAddress: a, marketAddress: market, position: 1 }], [b]],
    ["duplicate queued host", queue(a, a), [b]],
    ["duplicate position", [...queue(a), ...queue(b)], []],
    ["duplicate running host", [], [a, a]],
    ["capacity", [], Array.from({ length: 10_001 }, () => a)],
  ];
  for (const [name, q, r] of cases) await t.test(name, async () => {
    const f = fixture();
    const original = await f.provider.read();
    f.advance(); f.payloads(q, r);
    const next = await f.provider.read();
    assert.deepEqual(next.addresses, original.addresses);
    assert.equal(next.online.revision, original.online.revision);
    assert.equal(next.online.checkedAtMs, original.online.checkedAtMs);
    assert.equal(next.online.retained, true);
    assert.ok(next.online.discoveryError);
    assert.equal(isOnlineRosterStatus(next.online), true);
  });
});

test("initial discovery failures remain unknown and use exponential backoff with Retry-After", async () => {
  const f = fixture();
  f.respond(() => new Response("sensitive provider body", { status: 429, headers: { "Retry-After": "1" } }));
  for (const delay of [60_000, 120_000, 240_000, 480_000, 900_000, 900_000]) {
    const result = await f.provider.read();
    assert.deepEqual(result.addresses, []);
    assert.equal(result.online.revision, null);
    assert.equal(result.online.checkedAtMs, null);
    assert.equal(result.online.retained, false);
    assert.ok(result.error);
    assert.doesNotMatch(result.error!, /sensitive/);
    assert.equal(result.online.nextRefreshAtMs, f.now() + delay);
    assert.equal(isOnlineRosterStatus(result.online), true);
    const before = f.calls.length;
    await f.provider.read();
    assert.equal(f.calls.length, before);
    f.advance(delay);
  }
  f.respond(() => new Response(null, { status: 429, headers: { "Retry-After": "1800" } }));
  assert.equal((await f.provider.read()).online.nextRefreshAtMs, f.now() + 1_800_000);
  f.advance(1_800_000);
  f.respond(null);
  const recovered = await f.provider.read();
  assert.equal(recovered.error, null);
  f.advance();
  const future = f.now() + 180_000;
  f.respond(() => new Response(null, { status: 503, headers: { "Retry-After": new Date(future).toUTCString() } }));
  assert.equal((await f.provider.read()).online.nextRefreshAtMs, future);
});

test("admission rejection retains the roster and does not spend absence confirmations", async () => {
  const f = fixture();
  let admitted = true;
  const provider = createOnlineHostsProvider({ fetch: f.fetcher, now: f.now, admit: addresses => {
    assert.equal(Object.isFrozen(addresses), true);
    return admitted;
  } });
  const original = await provider.read();
  f.advance(); f.payloads([], [b]); await provider.read();
  f.advance(); admitted = false;
  const rejected = await provider.read();
  assert.deepEqual(rejected.addresses, original.addresses);
  assert.equal(rejected.online.revision, original.online.revision);
  assert.match(rejected.online.discoveryError!, /capacity/);
  f.advance(); admitted = true;
  assert.deepEqual((await provider.read()).addresses, [b]);
});

test("bounded bodies, invalid JSON and stalled requests fail without leaking raw errors", async t => {
  await t.test("declared length", async () => {
    const provider = createOnlineHostsProvider({ fetch: async () => new Response("[]", {
      headers: { "Content-Length": String(4 * 1024 * 1024 + 1) },
    }) });
    assert.match((await provider.read()).error!, /size limit/);
  });
  await t.test("streamed length", async () => {
    let canceled = 0;
    const provider = createOnlineHostsProvider({ fetch: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); },
      cancel() { canceled++; },
    })) });
    assert.match((await provider.read()).error!, /size limit/);
    assert.equal(canceled, 2);
  });
  await t.test("bad JSON", async () => {
    const provider = createOnlineHostsProvider({ fetch: async () => new Response("not-json") });
    assert.match((await provider.read()).error!, /valid JSON/);
  });
  await t.test("deadline including stalled fetch", async () => {
    const provider = createOnlineHostsProvider({ fetch: () => new Promise(() => {}), timeoutMs: 10 });
    assert.match((await provider.read()).error!, /timed out/);
  });
  await t.test("deadline including stalled body", async () => {
    const provider = createOnlineHostsProvider({ fetch: async () => new Response(new ReadableStream()), timeoutMs: 10 });
    assert.match((await provider.read()).error!, /timed out/);
  });
  await t.test("transport details", async () => {
    const provider = createOnlineHostsProvider({ fetch: async () => { throw new Error("secret raw URL and token"); } });
    assert.doesNotMatch((await provider.read()).error!, /secret|token|URL/);
  });
});

test("one canceled viewer leaves a shared read alive; the final cancellation abandons both requests", async () => {
  const pending: { resolve: (response: Response) => void; signal: AbortSignal }[] = [];
  const provider = createOnlineHostsProvider({ fetch: (_input, init) => new Promise(resolve => {
    pending.push({ resolve, signal: init!.signal! });
  }) });
  const first = new AbortController();
  const second = new AbortController();
  const read1 = provider.read(first.signal);
  const read2 = provider.read(second.signal);
  await tick();
  assert.equal(pending.length, 2);
  first.abort();
  await assert.rejects(read1, { name: "AbortError" });
  assert.equal(pending.some(request => request.signal.aborted), false);
  second.abort();
  await assert.rejects(read2, { name: "AbortError" });
  assert.equal(pending.every(request => request.signal.aborted), true);
  assert.equal(provider.peek().online.nextRefreshAtMs, 0);
  assert.equal(provider.peek().online.discoveryError, null);
  const replacement = provider.read();
  await tick();
  assert.equal(pending.length, 4);
  pending[2]!.resolve(Response.json(queue(a)));
  pending[3]!.resolve(Response.json([b]));
  assert.deepEqual((await replacement).addresses, [a, b]);
  pending[0]!.resolve(Response.json(queue(c)));
  pending[1]!.resolve(Response.json([d]));
  await tick();
  assert.deepEqual(provider.peek().addresses, [a, b], "abandoned responses cannot overwrite the new read");
});

test("roster status validation rejects contradictory revisions, times and retained states", () => {
  const valid = { revision: "revision-1", checkedAtMs: 1_000, nextRefreshAtMs: 61_000,
    retained: false, discoveryError: null };
  assert.equal(isOnlineRosterStatus(valid), true);
  assert.equal(isOnlineRosterStatus({ ...valid, retained: true, discoveryError: "Unavailable." }), true);
  for (const patch of [
    { revision: null }, { checkedAtMs: null }, { revision: "../file" }, { revision: "" },
    { nextRefreshAtMs: 999 }, { checkedAtMs: -1 }, { checkedAtMs: 1.5 },
    { retained: true }, { discoveryError: "Failed." }, { discoveryError: "" },
    { discoveryError: "line\nbreak", retained: true }, { nextRefreshAtMs: Infinity },
  ]) assert.equal(isOnlineRosterStatus({ ...valid, ...patch }), false, JSON.stringify(patch));
  assert.equal(isOnlineRosterStatus({ revision: null, checkedAtMs: null, nextRefreshAtMs: 0,
    retained: false, discoveryError: null }), true);
});
