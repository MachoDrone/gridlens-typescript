import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createNodeActivityProvider, createReconciledNodeInfoProvider } from "../scripts/node-activity.ts";
import type { NodeActivityRequest } from "../scripts/node-activity.ts";
import { normalizeHostMetadata } from "../src/fleet/host-metadata.ts";
import type { HostMetadataRecord } from "../src/fleet/host-metadata.ts";
import { NODE_STATES } from "../src/fleet/node-info.ts";
import type { NodeInfoRecord } from "../src/fleet/node-info.ts";

const addresses = Array.from({ length: 8 }, (_, index) => `${"1".repeat(31)}${index + 2}`);
const [host, other] = addresses as [string, string, ...string[]];
const markets = ["A", "B", "C"].map(suffix => `${"1".repeat(31)}${suffix}`);
const market = markets[0]!;
const outsider = `${"1".repeat(31)}Z`;
const requests = addresses.map((address, index) => ({ address, marketAddress: markets[index % 3]! }));
const isRunning = (input: Parameters<typeof fetch>[0]): boolean => new URL(String(input)).pathname === "/jobs/running-nodes";
const getMarket = (input: Parameters<typeof fetch>[0]): string => {
  const url = new URL(String(input));
  return (url.searchParams.get("market") ?? url.searchParams.get("marketAddress"))!;
};
const queued = (address: string, marketAddress = market) => ({ nodeAddress: address, marketAddress, state: "QUEUED" });
const node = (address = host, state = "OTHER"): NodeInfoRecord => ({
  address, values: { state, dl: 123.4, ul: 56.7, ping: 8.9, networkUnavailableReason: null },
  fetchedAtMs: 1000, validUntilMs: 31_000, retained: false, error: null,
});
const metadata = (address = host, marketAddress = market): HostMetadataRecord => ({
  address, values: normalizeHostMetadata(address, { nodeAddress: address, marketAddress }),
  fetchedAtMs: 500, retained: false, error: null, marketError: null,
});

test("eight supplied addresses across three markets batch into six anonymous fixed-origin calls", async () => {
  const calls: string[] = [];
  const provider = createNodeActivityProvider({ now: () => 1000, fetch: async (input, init) => {
    calls.push(String(input));
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit");
    assert.deepEqual(init?.headers, { Accept: "application/json" });
    assert(init?.signal instanceof AbortSignal);
    const assigned = requests.filter(request => request.marketAddress === getMarket(input)).map(request => request.address);
    return Response.json(isRunning(input) ? [...assigned, outsider] : []);
  } });
  assert.equal(calls.length, 0);
  const original = structuredClone(requests);
  const result = await provider(requests);
  assert.equal(calls.length, 6);
  assert.equal(new Set(calls).size, 6);
  assert.deepEqual(requests, original);
  assert.deepEqual(new Set(result.keys()), new Set(addresses));
  assert(!result.has(outsider));
  for (const evidence of result.values()) assert.deepEqual(evidence, {
    state: "RUNNING_JOB", source: "nosana-indexer", checkedAtMs: 1000, validUntilMs: 31_000, error: null,
  });
  assert(calls.every(url => url.startsWith("https://blockchain-indexer.k8s.prd.nos.ci/jobs/running-nodes?market=")
    || url.startsWith("https://host-manager.k8s.prd.nosana.com/nodes/queued-nodes?marketAddress=")));
});

test("running and queued positive membership are distinct; absence and conflict are unknown", async () => {
  const provider = createNodeActivityProvider({ now: () => 1000, fetch: async input => Response.json(isRunning(input)
    ? [host, addresses[2]] : [queued(other), queued(addresses[2]!)]) });
  const result = await provider(addresses.slice(0, 4).map(address => ({ address, marketAddress: market })));
  assert.equal(result.get(host)?.state, "RUNNING_JOB");
  assert.equal(result.get(other)?.state, "QUEUED");
  assert.equal(result.get(addresses[2]!)?.state, null);
  assert.match(result.get(addresses[2]!)!.error!, /both running and queued/);
  assert.equal(result.get(addresses[3]!)?.state, null);
  assert.match(result.get(addresses[3]!)!.error!, /did not establish/);
});

test("membership matches full addresses, not shared prefixes or another market", async () => {
  const provider = createNodeActivityProvider({ fetch: async input => Response.json(isRunning(input) ? [other] : []) });
  const result = await provider([{ address: host, marketAddress: market }]);
  assert.equal(result.size, 1);
  assert.equal(result.get(host)?.state, null);
  const wrongMarket = createNodeActivityProvider({ fetch: async input => Response.json(isRunning(input)
    ? [host] : [queued(other, markets[1])]) });
  assert.equal((await wrongMarket([{ address: host, marketAddress: market }])).get(host)?.state, null);
});

test("both sources must succeed before any positive activity can be established", async () => {
  for (const failingRunning of [false, true]) {
    const provider = createNodeActivityProvider({ fetch: async input => isRunning(input) === failingRunning
      ? new Response("private diagnostic", { status: 503 })
      : Response.json(isRunning(input) ? [host] : [queued(host)]) });
    const result = (await provider([{ address: host, marketAddress: market }])).get(host)!;
    assert.equal(result.state, null);
    assert.equal(result.checkedAtMs, null);
    assert.equal(result.validUntilMs, null);
    assert.match(result.error!, /HTTP 503/);
    assert(!result.error!.includes("private"));
  }
});

test("complete membership lists are validated before trusting an earlier valid entry", async () => {
  const cases = [
    { running: [host, "invalid"], queue: [] },
    { running: [host, host], queue: [] },
    { running: { nodes: [host] }, queue: [] },
    { running: [host], queue: [queued(other), { ...queued(host), state: "RUNNING_JOB" }] },
    { running: [host], queue: [queued(other), queued(host, markets[1])] },
    { running: [host], queue: [queued(other), queued("bad")] },
    { running: [host], queue: [queued(other), queued(other)] },
    { running: [host], queue: [queued(other), null] },
  ];
  for (const value of cases) {
    const provider = createNodeActivityProvider({ fetch: async input => Response.json(isRunning(input) ? value.running : value.queue) });
    const result = (await provider([{ address: host, marketAddress: market }])).get(host)!;
    assert.equal(result.state, null);
    assert.equal(result.checkedAtMs, null);
    assert(result.error);
  }
});

test("success cache lasts 15 seconds and callers cannot mutate future evidence", async () => {
  let now = 1000;
  let calls = 0;
  const provider = createNodeActivityProvider({ now: () => now, fetch: async input => {
    calls++;
    return Response.json(isRunning(input) ? [host] : []);
  } });
  const request = [{ address: host, marketAddress: market }];
  const first = (await provider(request)).get(host)!;
  first.state = "QUEUED";
  first.validUntilMs = 999_999;
  now = 15_999;
  const cached = (await provider(request)).get(host)!;
  assert.equal(calls, 2);
  assert.equal(cached.state, "RUNNING_JOB");
  assert.equal(cached.checkedAtMs, 1000);
  assert.equal(cached.validUntilMs, 31_000);
  now = 16_000;
  assert.equal((await provider(request)).get(host)?.checkedAtMs, now);
  assert.equal(calls, 4);
});

test("overlapping requests share market reads and never exceed two upstream calls", async () => {
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const provider = createNodeActivityProvider({ fetch: async input => {
    calls++;
    active++;
    maximum = Math.max(maximum, active);
    await setImmediate();
    active--;
    return Response.json(isRunning(input) ? addresses : []);
  } });
  const [one, two] = await Promise.all([provider(requests), provider([...requests].reverse())]);
  assert.equal(calls, 6);
  assert.equal(maximum, 2);
  assert.equal(one.size, 8);
  assert.equal(two.size, 8);
});

test("a failed refresh discards previous positives and backs off before recovering", async () => {
  let now = 1000;
  let fail = false;
  let calls = 0;
  const provider = createNodeActivityProvider({ now: () => now, fetch: async input => {
    calls++;
    return fail ? new Response("failed", { status: 503 }) : Response.json(isRunning(input) ? [host] : []);
  } });
  const request = [{ address: host, marketAddress: market }];
  assert.equal((await provider(request)).get(host)?.state, "RUNNING_JOB");
  now = 16_000;
  fail = true;
  const failed = (await provider(request)).get(host)!;
  assert.equal(failed.state, null);
  assert.equal(failed.checkedAtMs, null);
  assert.equal(failed.validUntilMs, null);
  now = 75_999;
  assert.deepEqual((await provider(request)).get(host), failed);
  assert.equal(calls, 4);
  now++;
  fail = false;
  const recovered = (await provider(request)).get(host)!;
  assert.equal(calls, 6);
  assert.equal(recovered.state, "RUNNING_JOB");
  assert.equal(recovered.checkedAtMs, now);
});

test("429 pauses only its own membership service and honors Retry-After", async () => {
  for (const blockedRunning of [false, true]) {
    let now = 1000;
    const calls = { running: 0, queued: 0 };
    let limited = true;
    const provider = createNodeActivityProvider({ now: () => now, fetch: async input => {
      const running = isRunning(input);
      calls[running ? "running" : "queued"]++;
      if (limited && running === blockedRunning) return new Response("", { status: 429, headers: { "Retry-After": "120" } });
      return Response.json(running ? [host] : []);
    } });
    await provider([{ address: host, marketAddress: market }]);
    await provider([{ address: host, marketAddress: markets[1]! }]);
    assert.equal(calls[blockedRunning ? "running" : "queued"], 1);
    assert.equal(calls[blockedRunning ? "queued" : "running"], 2);
    now = 120_999;
    await provider([{ address: host, marketAddress: market }]);
    assert.equal(calls[blockedRunning ? "running" : "queued"], 1);
    now++;
    limited = false;
    assert.equal((await provider([{ address: host, marketAddress: markets[1]! }])).get(host)?.state, "RUNNING_JOB");
    assert.equal(calls[blockedRunning ? "running" : "queued"], 2);
  }
});

test("HTTP-date Retry-After and default minimum backoff are enforced", async () => {
  for (const [retry, wait] of [["Tue, 06 Oct 2026 12:03:00 GMT", 180_000], ["invalid", 60_000], ["0", 60_000]] as const) {
    let now = Date.parse("2026-10-06T12:00:00Z");
    let runningCalls = 0;
    const provider = createNodeActivityProvider({ now: () => now, fetch: async input => {
      if (!isRunning(input)) return Response.json([]);
      runningCalls++;
      return new Response("", { status: 429, headers: { "Retry-After": retry } });
    } });
    await provider([{ address: host, marketAddress: market }]);
    now += wait - 1;
    await provider([{ address: host, marketAddress: markets[1]! }]);
    assert.equal(runningCalls, 1);
    now++;
    await provider([{ address: host, marketAddress: market }]);
    assert.equal(runningCalls, 2);
  }
});

test("invalid and duplicate request identities cannot start HTTP calls", async () => {
  let calls = 0;
  const provider = createNodeActivityProvider({ fetch: async () => { calls++; throw new Error("not allowed"); } });
  assert.equal((await provider([])).size, 0);
  for (const invalid of [
    [{ address: "https://elsewhere.test", marketAddress: market }],
    [{ address: host, marketAddress: "https://elsewhere.test" }],
    [{ address: host, marketAddress: market }, { address: host, marketAddress: markets[1]! }],
  ]) await assert.rejects(provider(invalid), /validated/);
  assert.equal(calls, 0);
});

test("malformed JSON, response size limits and arbitrary diagnostics become bounded errors", async () => {
  const responses = [
    () => new Response("not json with sensitive diagnostics"),
    () => new Response("[]", { headers: { "content-length": "262145" } }),
    () => new Response(" ".repeat(262145)),
    () => { throw new Error("sensitive fetch details"); },
  ];
  for (const response of responses) {
    const provider = createNodeActivityProvider({ fetch: async input => isRunning(input) ? response() : Response.json([]) });
    const result = (await provider([{ address: host, marketAddress: market }])).get(host)!;
    assert.equal(result.state, null);
    assert(result.error && result.error.length < 120);
    assert(!result.error.includes("sensitive"));
  }
});

test("request deadline aborts headers and streaming bodies without leaking diagnostics", async () => {
  for (const streamBody of [false, true]) {
    let aborted = false;
    const provider = createNodeActivityProvider({ timeoutMs: 5, fetch: async (input, init) => {
      if (!isRunning(input)) return Response.json([]);
      if (!streamBody) return new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("sensitive detail")); });
      });
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode("["));
        init!.signal!.addEventListener("abort", () => { aborted = true; controller.error(new Error("sensitive detail")); });
      } }));
    } });
    const result = (await provider([{ address: host, marketAddress: market }])).get(host)!;
    assert.equal(aborted, true);
    assert.equal(result.state, null);
    assert.match(result.error!, /timed out/);
    assert(!result.error!.includes("sensitive"));
  }
});

test("reconciliation preserves raw OTHER, network values and their original times", async () => {
  const original = node();
  const saved = structuredClone(original);
  const activityCalls: NodeActivityRequest[][] = [];
  const provider = createReconciledNodeInfoProvider({
    now: () => 2000, nodeInfoProvider: async () => ({ hosts: [original] }),
    metadataProvider: async input => { assert.deepEqual(input, [host]); return { hosts: [metadata()] }; },
    activityProvider: async input => {
      activityCalls.push([...input]);
      return new Map([[host, { state: "RUNNING_JOB", source: "nosana-indexer", checkedAtMs: 2000, validUntilMs: 32_000, error: null }]]);
    },
  });
  const result = (await provider([host])).hosts[0]!;
  assert.deepEqual(result.values, original.values);
  assert.equal(result.fetchedAtMs, 1000);
  assert.equal(result.validUntilMs, 31_000);
  assert.equal(result.activity?.state, "RUNNING_JOB");
  assert.equal(result.activity?.checkedAtMs, 2000);
  assert.deepEqual(activityCalls, [[{ address: host, marketAddress: market }]]);
  assert.deepEqual(original, saved);
  result.values!.dl = 0;
  assert.equal(original.values?.dl, 123.4);
});

test("explicit states, failed reads, unknown raw state and expired Node Info never trigger reconciliation", async () => {
  const records = [
    ...NODE_STATES.filter(state => state !== "OTHER").map(state => node(host, state)),
    node(host, "NEW_UNKNOWN_STATE"),
    { ...node(), retained: true }, { ...node(), error: "failed" },
    { ...node(), validUntilMs: 1999 }, { ...node(), validUntilMs: null },
    { ...node(), values: null },
  ];
  for (const original of records) {
    const provider = createReconciledNodeInfoProvider({
      now: () => 2000, nodeInfoProvider: async () => ({ hosts: [original] }),
      metadataProvider: async () => { assert.fail("unneeded metadata lookup"); },
      activityProvider: async () => { assert.fail("unneeded activity lookup"); },
    });
    assert.deepEqual((await provider([host])).hosts, [original]);
    assert.equal(original.activity, undefined);
  }
});

test("eight-host reconciliation assesses only OTHER without waiting for unrelated host metadata", async () => {
  let metadataCalls = 0;
  let activityCalls = 0;
  const records = addresses.map((address, index) => node(address, index === 1 ? "QUEUED" : "OTHER"));
  const provider = createReconciledNodeInfoProvider({
    now: () => 2000, nodeInfoProvider: async () => ({ hosts: records }),
    metadataProvider: async input => {
      metadataCalls++;
      assert.equal(input.length, 1);
      assert.notEqual(input[0], other);
      return { hosts: requests.map(request => metadata(request.address, request.marketAddress)) };
    },
    activityProvider: async input => {
      activityCalls++;
      assert.equal(input.length, 1);
      assert(!input.some(request => request.address === other));
      return new Map(input.map(request => [request.address,
        { state: "RUNNING_JOB", source: "nosana-indexer", checkedAtMs: 2000, validUntilMs: 32_000, error: null }]));
    },
  });
  const result = await provider(addresses);
  assert.equal(metadataCalls, 7);
  assert.equal(activityCalls, 7);
  assert.deepEqual(result.hosts.map(record => record.address), addresses);
  assert.equal(result.hosts[1]?.activity, undefined);
  assert.equal(result.hosts[1]?.values?.state, "QUEUED");
  assert.equal(result.hosts.filter(record => record.activity?.state === "RUNNING_JOB").length, 7);
  assert(records.every(record => record.activity === undefined));
});

test("unusable market metadata cannot authorize an activity request", async () => {
  const missingMarket = metadata();
  missingMarket.values!.marketAddress = null;
  for (const hosts of [[], [metadata(other)], [metadata(), metadata()], [missingMarket],
    [{ ...metadata(), retained: true }], [{ ...metadata(), error: "failed" }]]) {
    const provider = createReconciledNodeInfoProvider({
      now: () => 2000, nodeInfoProvider: async () => ({ hosts: [node()] }),
      metadataProvider: async () => ({ hosts }),
      activityProvider: async () => { assert.fail("invalid market should not cause activity requests"); },
    });
    const result = (await provider([host])).hosts[0]!;
    assert.equal(result.values?.state, "OTHER");
    assert.equal(result.activity?.state, null);
    assert.match(result.activity!.error!, /market assignment/);
  }
});

test("lookup failures and missing identity evidence are bounded unknowns", async () => {
  for (const mode of ["metadata", "activity", "missing"] as const) {
    const provider = createReconciledNodeInfoProvider({
      now: () => 2000, nodeInfoProvider: async () => ({ hosts: [node()] }),
      metadataProvider: async () => {
        if (mode === "metadata") throw new Error("sensitive metadata diagnostic");
        return { hosts: [metadata()] };
      },
      activityProvider: async () => {
        if (mode === "activity") throw new Error("sensitive activity diagnostic");
        return new Map();
      },
    });
    const result = (await provider([host])).hosts[0]!;
    assert.equal(result.activity?.state, null);
    assert.equal(result.activity?.checkedAtMs, null);
    assert.equal(result.activity?.validUntilMs, null);
    assert(result.activity!.error);
    assert(!result.activity!.error!.includes("sensitive"));
    assert.equal(result.error, null);
    assert.equal(result.values?.dl, 123.4);
  }
});
