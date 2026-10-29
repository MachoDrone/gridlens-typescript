import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { createJobProvider } from "../scripts/jobs.ts";
import type { JobHistorySnapshot } from "../src/fleet/job-history.ts";

function address(value: number): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let encoded = "";
  for (let n = value; n; n = Math.floor(n / 58)) encoded = alphabet[n % 58]! + encoded;
  const bytes = value === 0 ? 0 : Math.ceil(Math.log2(value + 1) / 8);
  return "1".repeat(32 - bytes) + encoded;
}
const host = address(1);
const baseTime = 1_000_000;
const job = (node = host, id = address(1000)) => ({ address: id, node, state: 1, timeStart: 900, timeEnd: 0, timeout: 600 });
const page = (jobs: unknown[], totalJobs = jobs.length) => ({ jobs, totalJobs });

test("history is an explicit anonymous bounded read, preserves outcomes and strips workload data", async () => {
  const calls: string[] = [];
  const provider = createJobProvider({ now: () => baseTime, fetch: async (input, init) => {
    calls.push(String(input));
    assert.equal(String(input), `https://blockchain-indexer.k8s.prd.nos.ci/jobs/?node=${host}&limit=10&offset=0`);
    assert.equal(init?.method, "GET");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    assert.deepEqual(init?.headers, { Accept: "application/json" });
    return Response.json(page([
      { ...job(), state: 2, timeEnd: 950, jobStatus: "failed", jobDefinition: { secret: "never expose" },
        results: { token: "private" }, payer: "unrelated" },
      { ...job(host, address(1001)), state: 2, timeStart: 800, timeEnd: 850, jobStatus: "success" },
      { ...job(host, address(1002)), state: 2, timeStart: 700, timeEnd: 750, jobStatus: "completed" },
    ]));
  } });
  assert.equal(calls.length, 0);
  const blank = provider.peekHistory!([host]);
  assert.equal(blank.hosts[0]!.checkedAtMs, null);
  assert.deepEqual(blank.hosts[0]!.jobs, []);
  assert.equal(calls.length, 0);
  const updates: JobHistorySnapshot[] = [];
  const first = await provider.history!([host], undefined, update => updates.push(update));
  assert.equal(calls.length, 1);
  assert.equal(updates.length, 1);
  assert.deepEqual(first.hosts[0]!.jobs.map(item => [item.state, item.result]),
    [["COMPLETED", "failed"], ["COMPLETED", "success"], ["COMPLETED", null]]);
  assert.equal(first.hosts[0]!.validUntilMs, baseTime + 300_000);
  assert.equal(/secret|results|payer|token|never expose/.test(JSON.stringify(first)), false);
  first.hosts[0]!.jobs[0]!.state = "STOPPED";
  assert.equal(provider.peekHistory!([host]).hosts[0]!.jobs[0]!.state, "COMPLETED");
  const current = provider.peek!([host]);
  assert.equal(current.hosts[0]!.checkedAtMs, null, "historical pages never establish a current assignment");
});

test("page reuse, manual refresh floor, restart and retained failures preserve original check times", async () => {
  let now = baseTime;
  let calls = 0;
  let failed = false;
  const fetcher: typeof fetch = async () => {
    calls++;
    return failed ? new Response("", { status: 503 }) : Response.json(page([job()]));
  };
  const provider = createJobProvider({ now: () => now, fetch: fetcher });
  const initial = (await provider.history!([host])).hosts[0]!;
  now += 59_999;
  assert.equal((await provider.history!([host])).hosts[0]!.checkedAtMs, baseTime);
  assert.equal((await provider.history!([host], undefined, undefined, true)).hosts[0]!.retryAtMs, baseTime + 60_000);
  assert.equal(calls, 1);
  now++;
  await provider.history!([host]);
  assert.equal(calls, 2, "deferred manual refresh can complete on the next explicit read");
  failed = true;
  now += 300_000;
  const retained = (await provider.history!([host])).hosts[0]!;
  assert.equal(retained.checkedAtMs, baseTime + 60_000);
  assert.equal(retained.jobs[0]!.checkedAtMs, baseTime + 60_000);
  assert.equal(retained.retained, true);
  assert.match(retained.error!, /503/);
  assert.equal(retained.retryAtMs, now + 60_000);
  now += 59_999;
  await provider.history!([host], undefined, undefined, true);
  assert.equal(calls, 3, "manual refresh cannot bypass a failed-read backoff");
  failed = false;
  const restarted = createJobProvider({ now: () => now, fetch: fetcher });
  assert.equal(restarted.peekHistory!([host]).hosts[0]!.checkedAtMs, null);
  assert.equal((await restarted.history!([host])).hosts[0]!.checkedAtMs, now);
  assert.equal(calls, 4);
  assert.equal(initial.checkedAtMs, baseTime);
});

test("ordinary assignment and terminal batch reads retain history without a history-page check", async () => {
  let now = baseTime;
  let ended = false;
  const calls: string[] = [];
  const provider = createJobProvider({ now: () => now, fetch: async (input, init) => {
    calls.push(String(input));
    if (init?.method === "POST") return Response.json([{ ...job(), state: 2, timeEnd: 1050, jobStatus: "failed" }]);
    return Response.json(page(ended ? [] : [job()]));
  } });
  await provider([host]);
  const observed = provider.peekHistory!([host]).hosts[0]!;
  assert.equal(observed.jobs[0]!.state, "RUNNING");
  assert.equal(observed.checkedAtMs, null);
  assert.equal(observed.totalJobs, null);
  assert.equal(observed.validUntilMs, null);
  now += 120_000;
  ended = true;
  const current = (await provider([host])).hosts[0]!;
  assert.equal(current.job, null, "Duration still clears ended assignments");
  const history = provider.peekHistory!([host]).hosts[0]!;
  assert.equal(history.jobs.length, 1);
  assert.equal(history.jobs[0]!.state, "COMPLETED");
  assert.equal(history.jobs[0]!.result, "failed");
  assert.equal(history.jobs[0]!.checkedAtMs, now);
  assert.equal(history.checkedAtMs, null);
  assert.equal(calls.length, 3, "history retention performs no extra read");
});

test("invalid, conflicting and duplicate history pages retain previous evidence", async () => {
  const invalid = [
    [], {}, page([], 1), page([job()], 0), page([job()], -1), page([job()], 1.5),
    page([job(), job()]), page([job(address(2))]), page([{ ...job(), state: 9 }]),
    page([{ ...job(), timeStart: 2000 }]), page([{ ...job(), timeEnd: 899 }]),
    page([{ ...job(), timeout: -1 }]), page([{ ...job(), timeStart: "900" }]),
  ];
  for (const malformed of invalid) {
    let now = baseTime;
    let payload: unknown = page([job()]);
    const provider = createJobProvider({ now: () => now, fetch: async () => Response.json(payload) });
    await provider.history!([host]);
    now += 300_000;
    payload = malformed;
    const result = (await provider.history!([host])).hosts[0]!;
    assert(result.error, JSON.stringify(malformed));
    assert.equal(result.checkedAtMs, baseTime);
    assert.equal(result.jobs[0]!.address, job().address);
    assert.equal(result.retained, true);
  }
});

test("history is bounded to ten observed jobs and cache-only reads do not alter assignment deadlines", async () => {
  let now = baseTime;
  let sequence = 0;
  const provider = createJobProvider({ now: () => now, fetch: async (_input, init) => {
    const latest = { ...job(host, address(1000 + sequence)), timeStart: Math.floor(now / 1000) - 1 };
    if (init?.method === "POST") return Response.json([{ ...latest, timeStart: 900, timeEnd: Math.floor(now / 1000) - 1, state: 2 }]);
    sequence++;
    return Response.json(page([{ ...job(host, address(1000 + sequence)), timeStart: Math.floor(now / 1000) - 1 }]));
  } });
  for (let turn = 0; turn < 12; turn++) { await provider([host]); now += 120_000; }
  const before = provider.peek!([host]);
  const retained = provider.peekHistory!([host]).hosts[0]!;
  assert.equal(retained.jobs.length, 10);
  assert.equal(new Set(retained.jobs.map(item => item.address)).size, 10);
  assert.equal(retained.checkedAtMs, null);
  for (let turn = 0; turn < 30; turn++) provider.peekHistory!([host, address(2)]);
  assert.deepEqual(provider.peek!([host]), before);
});

test("history shares work across viewers; cancellation neither fails evidence nor cancels another viewer", async () => {
  let calls = 0;
  let resolve!: (response: Response) => void;
  let upstreamSignal: AbortSignal | undefined;
  const provider = createJobProvider({ now: () => baseTime, fetch: async (_input, init) => {
    calls++;
    upstreamSignal = init!.signal!;
    return new Promise<Response>(done => { resolve = done; });
  } });
  const canceled = new AbortController();
  const first = provider.history!([host], canceled.signal);
  const second = provider.history!([host]);
  await setImmediate();
  canceled.abort();
  await assert.rejects(first, /abort/i);
  assert.equal(upstreamSignal!.aborted, false);
  resolve(Response.json(page([job()])));
  assert.equal((await second).hosts[0]!.error, null);
  assert.equal(calls, 1);
});

test("the last history cancellation releases pending work for immediate recovery without backoff", async () => {
  let calls = 0;
  const provider = createJobProvider({ now: () => baseTime, fetch: async (_input, init) => {
    calls++;
    if (calls > 1) return Response.json(page([job()]));
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }));
  } });
  const controller = new AbortController();
  const first = provider.history!([host], controller.signal);
  await setImmediate();
  controller.abort();
  await assert.rejects(first, /abort/i);
  const recovered = await provider.history!([host]);
  assert.equal(recovered.hosts[0]!.error, null);
  assert.equal(recovered.hosts[0]!.retryAtMs, null);
  assert.equal(calls, 2);
});

test("eligible Duration work precedes queued history work in the same two-request pool", async () => {
  const historyHosts = [address(1), address(2), address(3)];
  const order: string[] = [];
  const release: (() => void)[] = [];
  let active = 0;
  let maximum = 0;
  const provider = createJobProvider({ now: () => baseTime, fetch: async input => {
    const url = new URL(String(input));
    const node = url.searchParams.get("node")!;
    order.push(url.searchParams.has("state") ? "duration" : node);
    active++;
    maximum = Math.max(maximum, active);
    if (order.length <= 2) await new Promise<void>(done => release.push(done));
    active--;
    return Response.json(page([job(node, address(1000 + Number(historyHosts.indexOf(node)) + (url.searchParams.has("state") ? 100 : 0)))]));
  } });
  const histories = provider.history!(historyHosts);
  await setImmediate();
  const current = provider([address(4)]);
  await setImmediate();
  release[0]!();
  await setImmediate();
  assert.equal(order[2], "duration");
  release[1]!();
  await Promise.all([histories, current]);
  assert.equal(maximum, 2);
});

test("200 history hosts share repeated-discovery budgets and preserve first assignment capacity", async () => {
  let now = baseTime;
  const many = Array.from({ length: 200 }, (_, index) => address(index + 1));
  const calls: { at: number; history: boolean }[] = [];
  const provider = createJobProvider({ now: () => now, fetch: async input => {
    const url = new URL(String(input));
    const node = url.searchParams.get("node")!;
    calls.push({ at: now, history: !url.searchParams.has("state") });
    return Response.json(page([job(node, address(10_000 + many.indexOf(node)))]));
  } });
  const first = await provider.history!(many);
  assert.equal(calls.length, 10, "history stops at 75% of the 14/30s discovery allowance");
  assert.equal(first.hosts.filter(record => record.pending).length, 190);
  await provider(many.slice(10, 15));
  assert.equal(calls.length, 14, "four first-assignment requests keep their reserved capacity");
  for (let step = 0; step < 360; step++) {
    now += 30_000;
    await provider.history!(many);
  }
  assert.equal(calls.length, 675, "all discovery, including current reads, counts toward history's 675/day repeat gate");
  for (const call of calls) {
    const recent = calls.filter(candidate => candidate.at > call.at - 3_600_000 && candidate.at <= call.at);
    assert(recent.length <= 252, "history never grants a separate hourly allowance");
  }
  const count = calls.length;
  await provider.history!(many, undefined, undefined, true);
  assert.equal(calls.length, count);
  assert(provider.peekHistory!(many).hosts.some(record => record.pending));
});

test("history Retry-After pauses assignment reads and forced history cannot bypass it", async () => {
  let now = baseTime;
  let calls = 0;
  const provider = createJobProvider({ now: () => now, fetch: async () => {
    calls++;
    return new Response("", { status: 429, headers: { "Retry-After": "600" } });
  } });
  const failed = (await provider.history!([host])).hosts[0]!;
  assert.equal(failed.retryAtMs, baseTime + 600_000);
  now += 60_000;
  await provider.history!([host], undefined, undefined, true);
  const current = await provider([address(2)]);
  assert.equal(current.hosts[0]!.pending, true);
  assert.equal(current.waitReason, "retry-after");
  assert.equal(calls, 1);
});

test("terminal observations arriving during a history page survive its older payload", async () => {
  let now = baseTime;
  let ended = false;
  let resolve!: (response: Response) => void;
  const provider = createJobProvider({ now: () => now, fetch: async (input, init) => {
    if (init?.method === "POST") return Response.json([{ ...job(), state: 2, timeEnd: 1050, jobStatus: "success" }]);
    if (!new URL(String(input)).searchParams.has("state")) return new Promise<Response>(done => { resolve = done; });
    return Response.json(page(ended ? [] : [job()]));
  } });
  await provider([host]);
  now += 120_000;
  const history = provider.history!([host]);
  await setImmediate();
  ended = true;
  await provider([host]);
  const observed = provider.peekHistory!([host]).hosts[0]!.jobs[0]!;
  assert.equal(observed.state, "COMPLETED");
  resolve(Response.json(page([job()])));
  const merged = (await history).hosts[0]!;
  assert.equal(merged.jobs[0]!.state, "COMPLETED");
  assert.equal(merged.jobs[0]!.result, "success");
  assert.equal(merged.jobs[0]!.checkedAtMs, observed.checkedAtMs);
  assert.equal(provider.peek!([host]).hosts[0]!.job, null);
});

test("history rejects a previously established job reused for another host", async () => {
  const provider = createJobProvider({ now: () => baseTime, fetch: async input => {
    const node = new URL(String(input)).searchParams.get("node")!;
    return Response.json(page([job(node)]));
  } });
  await provider.history!([host]);
  const other = (await provider.history!([address(2)])).hosts[0]!;
  assert.match(other.error!, /conflicting Host Addresses/);
  assert.equal(other.jobs.length, 0);
  assert.equal(provider.peekHistory!([host]).hosts[0]!.jobs[0]!.address, job().address);
  assert.equal((await provider([address(2)])).hosts[0]!.job!.address, job().address,
    "historical ownership ambiguity cannot change current-assignment behavior");
  assert.equal(provider.peekHistory!([address(2)]).hosts[0]!.jobs.length, 0,
    "current evidence cannot publish a conflicting historical association");
});

test("expanded history enriches exact job markets with one shared allowlisted list and preserves decimal rates", async () => {
  const market = address(7000);
  const otherMarket = address(7001);
  const members = [host, address(2)];
  const calls: string[] = [];
  const provider = createJobProvider({ now: () => baseTime, fetch: async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.href);
    assert.equal(init?.method, "GET");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    assert.deepEqual(init?.headers, { Accept: "application/json" });
    if (url.pathname === "/markets") {
      assert.equal(url.origin, "https://host-manager.k8s.prd.nosana.com");
      return Response.json([{ address: market, name: "Synthetic historical GPU", usd_reward_per_hour: 0.123456789012345,
        slug: "not-the-gpu-name", metadata: { private: "discard" }, nodes: ["discard"] },
      { address: otherMarket, name: "Synthetic second GPU", usd_reward_per_hour: 0.25 }]);
    }
    const node = url.searchParams.get("node")!;
    return Response.json(page([{ ...job(node, address(1000 + members.indexOf(node))),
      market: node === host ? market : otherMarket, usdRewardPerHour: 0.234567890123456 }]));
  } });
  await provider(members);
  assert.equal(calls.some(call => call.endsWith("/markets")), false, "ordinary assignments never fetch optional market data");
  assert.equal(provider.peekHistory!(members).hosts[0]!.jobs[0]!.marketName, null);
  const result = await provider.history!(members);
  assert.equal(calls.filter(call => call.endsWith("/markets")).length, 1);
  const first = result.hosts[0]!.jobs[0]!;
  assert.equal(first.marketAddress, market);
  assert.equal(first.usdRewardPerHour, 0.234567890123456);
  assert.equal(first.marketName, "Synthetic historical GPU");
  assert.equal(first.marketUsdRewardPerHour, 0.123456789012345);
  assert.equal(first.marketCheckedAtMs, baseTime);
  assert.equal(first.marketValidUntilMs, baseTime + 300_000);
  assert.equal(result.hosts[1]!.jobs[0]!.marketName, "Synthetic second GPU");
  assert.equal(/private|discard|slug/.test(JSON.stringify(result)), false);
  const count = calls.length;
  provider.peekHistory!(members);
  await provider.history!(members);
  assert.equal(calls.length, count, "cached expansions and Online peeks spend no extra allowance");
  first.marketName = "tampered";
  assert.equal(provider.peekHistory!(members).hosts[0]!.jobs[0]!.marketName, "Synthetic historical GPU");
});

test("failed optional markets preserve a successful page and retry on cached expansion without rereading that page", async () => {
  let now = baseTime;
  let failed = true;
  let pages = 0;
  let catalogs = 0;
  const market = address(7000);
  const provider = createJobProvider({ now: () => now, fetch: async input => {
    if (new URL(String(input)).pathname === "/markets") {
      catalogs++;
      return failed ? new Response("", { status: 503 })
        : Response.json([{ address: market, name: "Recovered GPU", usd_reward_per_hour: 0.4 }]);
    }
    pages++;
    return Response.json(page([{ ...job(), market, usdRewardPerHour: 0.3 }]));
  } });
  const first = (await provider.history!([host])).hosts[0]!;
  assert.equal(first.error, null);
  assert.equal(first.checkedAtMs, baseTime);
  assert.equal(first.jobs[0]!.marketName, null);
  now += 59_999;
  await provider.history!([host]);
  assert.equal(catalogs, 1);
  failed = false;
  now++;
  const recovered = (await provider.history!([host])).hosts[0]!;
  assert.equal(pages, 1, "market recovery is independent of five-minute history-page cache");
  assert.equal(catalogs, 2);
  assert.equal(recovered.checkedAtMs, baseTime);
  assert.equal(recovered.jobs[0]!.checkedAtMs, baseTime);
  assert.equal(recovered.jobs[0]!.marketCheckedAtMs, now);
  assert.equal(recovered.jobs[0]!.marketName, "Recovered GPU");
  now = baseTime + 360_000;
  failed = true;
  const retained = (await provider.history!([host])).hosts[0]!;
  assert.equal(retained.error, null);
  assert.equal(retained.checkedAtMs, now);
  assert.equal(retained.jobs[0]!.marketCheckedAtMs, baseTime + 60_000);
  assert.equal(retained.jobs[0]!.marketValidUntilMs, now);
  assert.equal(retained.jobs[0]!.marketName, "Recovered GPU", "expired metadata keeps its original check, never a fresh replacement");
});

test("malformed market lists and absent or invalid rates stay unknown without affecting job timing", async () => {
  const market = address(7000);
  const valid = { address: market, name: "Synthetic GPU", usd_reward_per_hour: 0.3 };
  for (const payload of [{ markets: [valid] }, [valid, valid], [{ ...valid, address: "bad" }],
    Array.from({ length: 2049 }, () => valid), [], [{ ...valid, address: address(7001) }],
    [{ ...valid, name: "bad\nname", usd_reward_per_hour: 0 }],
    [{ ...valid, name: null, usd_reward_per_hour: "0.3" }]]) {
    const provider = createJobProvider({ now: () => baseTime, fetch: async input =>
      new URL(String(input)).pathname === "/markets" ? Response.json(payload)
        : Response.json(page([{ ...job(), market, usdRewardPerHour: 0.2 }])) });
    const row = (await provider.history!([host])).hosts[0]!;
    assert.equal(row.error, null);
    assert.equal(row.jobs[0]!.timeStart, 900);
    assert.equal(row.jobs[0]!.usdRewardPerHour, 0.2);
    assert.equal(row.jobs[0]!.marketName, null);
    assert.equal(row.jobs[0]!.marketUsdRewardPerHour, null);
  }
});

test("market enrichment consumes history's existing allowance and Retry-After pauses all job work", async () => {
  const market = address(7000);
  const many = Array.from({ length: 20 }, (_, index) => address(index + 1));
  let calls = 0;
  let catalogs = 0;
  const provider = createJobProvider({ now: () => baseTime, fetch: async input => {
    calls++;
    const url = new URL(String(input));
    if (url.pathname === "/markets") {
      catalogs++;
      return Response.json([{ address: market, name: "Synthetic GPU", usd_reward_per_hour: 0.3 }]);
    }
    const node = url.searchParams.get("node")!;
    return Response.json(page([{ ...job(node, address(1000 + many.indexOf(node))), market }]));
  } });
  await provider.history!(many);
  assert.equal(calls, 10, "market list and pages together stop at the existing repeated-discovery cap");
  assert.equal(catalogs, 1);
  await provider(many.slice(10, 15));
  assert.equal(calls, 14, "first current-assignment reads retain their reserved capacity");

  calls = 0;
  const paused = createJobProvider({ now: () => baseTime, fetch: async input => {
    calls++;
    return new URL(String(input)).pathname === "/markets"
      ? new Response("", { status: 429, headers: { "Retry-After": "600" } })
      : Response.json(page([{ ...job(), market }]));
  } });
  const row = (await paused.history!([host])).hosts[0]!;
  assert.equal(row.error, null);
  const current = await paused([host]);
  assert.equal(current.waitReason, "retry-after");
  assert.equal(current.waitUntilMs, baseTime + 600_000);
  assert.equal(calls, 2);
});

test("market read cancellation preserves page evidence and shared consumers without creating backoff", async () => {
  const market = address(7000);
  let catalogCalls = 0;
  let release!: (response: Response) => void;
  let marketSignal: AbortSignal | undefined;
  const provider = createJobProvider({ now: () => baseTime, fetch: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/markets") {
      catalogCalls++;
      marketSignal = init!.signal!;
      return new Promise<Response>((resolve, reject) => {
        release = resolve;
        marketSignal!.addEventListener("abort", () => reject(marketSignal!.reason), { once: true });
      });
    }
    const node = url.searchParams.get("node")!;
    return Response.json(page([{ ...job(node, node === host ? address(1000) : address(1001)), market }]));
  } });
  const canceled = new AbortController();
  const first = provider.history!([host], canceled.signal);
  const second = provider.history!([address(2)]);
  await setImmediate();
  canceled.abort();
  await assert.rejects(first, /abort/i);
  assert.equal(marketSignal!.aborted, false);
  assert.equal(provider.peekHistory!([host]).hosts[0]!.error, null);
  release(Response.json([{ address: market, name: "Synthetic GPU", usd_reward_per_hour: 0.3 }]));
  await second;
  assert.equal(catalogCalls, 1);
  await provider.history!([host]);
  assert.equal(catalogCalls, 1);
  assert.equal(provider.peekHistory!([host]).hosts[0]!.jobs[0]!.marketName, "Synthetic GPU");
});

test("last market consumer cancellation can immediately recover its cached page without a retry penalty", async () => {
  const market = address(7000);
  let pages = 0;
  let catalogs = 0;
  const provider = createJobProvider({ now: () => baseTime, fetch: async (input, init) => {
    if (new URL(String(input)).pathname !== "/markets") {
      pages++;
      return Response.json(page([{ ...job(), market }]));
    }
    if (++catalogs > 1) return Response.json([{ address: market, name: "Recovered GPU", usd_reward_per_hour: 0.3 }]);
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }));
  } });
  const controller = new AbortController();
  const read = provider.history!([host], controller.signal);
  await setImmediate();
  controller.abort();
  await assert.rejects(read, /abort/i);
  const recovered = (await provider.history!([host])).hosts[0]!;
  assert.equal(pages, 1);
  assert.equal(catalogs, 2);
  assert.equal(recovered.error, null);
  assert.equal(recovered.jobs[0]!.marketName, "Recovered GPU");
  assert.equal(recovered.checkedAtMs, baseTime);
});

test("oversized market response is canceled and cannot discard the validated history page", async () => {
  const market = address(7000);
  let canceled = false;
  const provider = createJobProvider({ now: () => baseTime, fetch: async input => {
    if (new URL(String(input)).pathname !== "/markets") return Response.json(page([{ ...job(), market }]));
    return new Response(new ReadableStream<Uint8Array>({ cancel() { canceled = true; } }), {
      headers: { "Content-Length": String(2 * 1024 * 1024 + 1), "Content-Type": "application/json" },
    });
  } });
  const row = (await provider.history!([host])).hosts[0]!;
  assert.equal(canceled, true);
  assert.equal(row.error, null);
  assert.equal(row.jobs.length, 1);
  assert.equal(row.jobs[0]!.marketName, null);
});
