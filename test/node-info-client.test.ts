import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createNodeInfoProvider } from "../scripts/node-info.ts";
import { createHostMetadataProvider } from "../scripts/host-metadata.ts";

const addresses = Array.from({ length: 8 }, (_, index) => `${"1".repeat(31)}${index + 2}`);
const host = addresses[0]!;
const payload = (node = host) => ({
  node, state: "RUNNING_JOB", info: { network: { download_mbps: 831.42, upload_mbps: 245.9, ping_ms: 12.7 } },
});
const addressFrom = (input: Parameters<typeof fetch>[0]): string => String(input).split("//")[1]!.split(".")[0]!;

test("eight hosts use anonymous fixed Node Info URLs and retain only selected fields", async () => {
  const calls: string[] = [];
  const provider = createNodeInfoProvider({ now: () => 1234, fetch: async (input, init) => {
    calls.push(String(input));
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.credentials, "omit");
    assert.deepEqual(init?.headers, { Accept: "application/json" });
    assert(init?.signal instanceof AbortSignal);
    return Response.json({ ...payload(addressFrom(input)), resources: { images: ["not copied"] }, uptime: 999 });
  } });
  assert.equal(calls.length, 0);
  const result = await provider(addresses);
  assert.deepEqual(result.hosts.map(row => row.address), addresses);
  assert(result.hosts.every(row => row.values?.state === "RUNNING_JOB" && row.values.dl === 831.42));
  assert(result.hosts.every(row => row.fetchedAtMs === 1234 && row.validUntilMs === 31_234 && !row.retained && !row.error));
  assert.deepEqual(new Set(calls), new Set(addresses.map(address => `https://${address}.node.k8s.prd.nos.ci/node/info`)));
  assert(!JSON.stringify(result).includes("not copied"));
  assert(!JSON.stringify(result).includes("uptime"));
});

test("success cache lasts 15 seconds and callers cannot mutate cached values or deadlines", async () => {
  let now = 0;
  let calls = 0;
  const provider = createNodeInfoProvider({ now: () => now, fetch: async () => { calls++; return Response.json(payload()); } });
  const first = (await provider([host])).hosts[0]!;
  first.values!.state = "caller changed";
  first.validUntilMs = 999_999;
  now = 14_999;
  const cached = (await provider([host])).hosts[0]!;
  assert.equal(cached.values?.state, "RUNNING_JOB");
  assert.equal(cached.validUntilMs, 30_000);
  assert.equal(calls, 1);
  now = 15_000;
  const refreshed = (await provider([host])).hosts[0]!;
  assert.equal(calls, 2);
  assert.equal(refreshed.fetchedAtMs, now);
  assert.equal(refreshed.validUntilMs, 45_000);
});

test("fetch and validity timestamps start after complete body reads", async () => {
  let now = 1000;
  const provider = createNodeInfoProvider({ now: () => now, fetch: async () => new Response(new ReadableStream({
    start(controller) {
      now = 4000;
      controller.enqueue(new TextEncoder().encode(JSON.stringify(payload())));
      controller.close();
    },
  })) });
  const result = (await provider([host])).hosts[0]!;
  assert.equal(result.fetchedAtMs, 4000);
  assert.equal(result.validUntilMs, 34_000);
});

test("overlapping requests deduplicate hosts and limit total Node Info HTTP calls to four", async () => {
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const provider = createNodeInfoProvider({ fetch: async input => {
    active++;
    calls++;
    maximum = Math.max(maximum, active);
    await setImmediate();
    active--;
    return Response.json(payload(addressFrom(input)));
  } });
  const [one, two] = await Promise.all([provider(addresses), provider([...addresses].reverse())]);
  assert.equal(maximum, 4);
  assert.equal(calls, 8);
  assert.deepEqual(one.hosts.map(row => row.address), addresses);
  assert.deepEqual(two.hosts.map(row => row.address), [...addresses].reverse());
});

test("invalid, duplicate and empty input cannot initiate a network request", async () => {
  let calls = 0;
  const provider = createNodeInfoProvider({ fetch: async () => { calls++; throw new Error("not allowed"); } });
  assert.deepEqual(await provider([]), { hosts: [] });
  await assert.rejects(provider([host, "https://elsewhere.test"]), /validated/);
  await assert.rejects(provider([host, host]), /unique/);
  assert.equal(calls, 0);
});

test("first failed refresh retains values and original times while a bounded confirmation recovers", async () => {
  let now = 10_000;
  let fail = false;
  let calls = 0;
  const provider = createNodeInfoProvider({ now: () => now, fetch: async () => {
    calls++;
    return fail ? new Response("upstream diagnostic", { status: 503 }) : Response.json(payload());
  } });
  const first = (await provider([host])).hosts[0]!;
  now += 15_000;
  fail = true;
  const retained = (await provider([host])).hosts[0]!;
  assert.deepEqual(retained.values, first.values);
  assert.equal(retained.fetchedAtMs, 10_000);
  assert.equal(retained.validUntilMs, 40_000);
  assert.equal(retained.retained, true);
  assert.match(retained.error!, /HTTP 503/);
  assert.equal(retained.apiCheck?.status, "other");
  assert.equal(retained.apiCheck?.confirmationPending, true);
  now += 999;
  await provider([host]);
  assert.equal(calls, 2);
  now++;
  fail = false;
  const recovered = (await provider([host])).hosts[0]!;
  assert.equal(recovered.retained, false);
  assert.equal(recovered.error, null);
  assert.equal(recovered.fetchedAtMs, now);
  assert.equal(recovered.validUntilMs, now + 30_000);
});

test("repeated Node Info failures back off exponentially to 15 minutes and success resets the delay", async () => {
  let now = 1000;
  let failing = true;
  let calls = 0;
  const provider = createNodeInfoProvider({ now: () => now, fetch: async () => {
    calls++;
    return failing ? new Response("", { status: 503 }) : Response.json(payload());
  } });
  for (const delay of [1_000, 120_000, 1_000, 480_000, 1_000, 900_000]) {
    const before = calls;
    assert.equal((await provider([host])).hosts[0]?.values, null);
    assert.equal(calls, before + 1);
    assert.equal(provider.nextRefreshAt?.([host]), now + delay);
    now += delay - 1;
    await provider([host]);
    assert.equal(calls, before + 1);
    now++;
  }
  failing = false;
  assert.equal((await provider([host])).hosts[0]?.error, null);
  now += 15_000;
  failing = true;
  await provider([host]);
  assert.equal(provider.nextRefreshAt?.([host]), now + 1_000);
});

test("Retry-After on an unavailable Node Info endpoint overrides its exponential deadline", async () => {
  let now = 1000;
  let calls = 0;
  const provider = createNodeInfoProvider({ now: () => now, fetch: async () => {
    calls++;
    return new Response("", { status: 503, headers: { "Retry-After": "1200" } });
  } });
  await provider([host]);
  assert.equal(provider.nextRefreshAt?.([host]), 1_201_000);
  now = 1_200_999;
  await provider([host]);
  assert.equal(calls, 1);
  now++;
  await provider([host]);
  assert.equal(calls, 2);
  assert.equal(provider.nextRefreshAt?.([host]), now + 1_200_000);
});

test("identity mismatches never establish or replace a host's values", async () => {
  let now = 0;
  let wrong = false;
  const provider = createNodeInfoProvider({ now: () => now, fetch: async () => Response.json(payload(wrong ? addresses[1] : host)) });
  await provider([host]);
  now = 15_000;
  wrong = true;
  const result = (await provider([host])).hosts[0]!;
  assert.equal(result.fetchedAtMs, 0);
  assert.equal(result.validUntilMs, 30_000);
  assert.equal(result.retained, true);
  assert.match(result.error!, /did not match/);
  const first = (await createNodeInfoProvider({ fetch: async () => Response.json(payload(addresses[1])) })([host])).hosts[0]!;
  assert.equal(first.values, null);
  assert.equal(first.fetchedAtMs, null);
  assert.equal(first.validUntilMs, null);
  assert.equal(first.retained, false);
});

test("429 pauses queued and new Node Info requests across hosts until Retry-After", async () => {
  let now = 1000;
  let calls = 0;
  let limited = true;
  const provider = createNodeInfoProvider({ now: () => now, fetch: async input => {
    calls++;
    return limited ? new Response("", { status: 429, headers: { "Retry-After": "120" } }) : Response.json(payload(addressFrom(input)));
  } });
  const first = await provider(addresses.slice(0, 6));
  assert.equal(calls, 4);
  assert(first.hosts.every(row => row.values === null && row.error));
  now = 120_999;
  await provider(addresses);
  assert.equal(calls, 4);
  now = 121_000;
  limited = false;
  const recovered = await provider(addresses.slice(0, 6));
  assert.equal(calls, 10);
  assert(recovered.hosts.every(row => row.error === null && !row.retained));
});

test("HTTP-date Retry-After is honored and invalid Retry-After keeps the minimum backoff", async () => {
  for (const [retry, wait] of [["Tue, 06 Oct 2026 12:03:00 GMT", 180_000], ["bad", 60_000], ["0", 60_000]] as const) {
    let now = Date.parse("2026-10-06T12:00:00Z");
    let calls = 0;
    const provider = createNodeInfoProvider({ now: () => now, fetch: async () => {
      calls++;
      return new Response("", { status: 429, headers: { "Retry-After": retry } });
    } });
    await provider([host]);
    now += wait - 1;
    await provider([addresses[1]!]);
    assert.equal(calls, 1);
    now++;
    await provider([host]);
    assert.equal(calls, 2);
  }
});

test("Node Info rate limiting does not pause the independent Host Manager metadata adapter", async () => {
  const nodeInfo = createNodeInfoProvider({ fetch: async () => new Response("", { status: 429 }) });
  await nodeInfo([host]);
  let metadataCalls = 0;
  const metadata = createHostMetadataProvider({ fetch: async () => {
    metadataCalls++;
    return Response.json({ nodeAddress: host, status: "PREMIUM" });
  } });
  assert.equal((await metadata([host])).hosts[0]!.values?.status, "PREMIUM");
  assert.equal(metadataCalls, 1);
});

test("HTTP errors, redirects, malformed JSON and transport diagnostics are bounded", async () => {
  for (const fetcher of [
    async () => new Response("sensitive diagnostic", { status: 401 }),
    async () => { throw new Error("sensitive diagnostic"); },
    async () => new Response("sensitive diagnostic", { status: 200 }),
    async () => new Response("", { status: 302, headers: { Location: "https://elsewhere.test/" } }),
  ]) {
    const result = await createNodeInfoProvider({ fetch: fetcher })([host]);
    assert.equal(result.hosts[0]!.values, null);
    assert(result.hosts[0]!.error);
    assert(!JSON.stringify(result).includes("sensitive diagnostic"));
    assert(!JSON.stringify(result).includes("elsewhere.test"));
  }
});

test("declared and streamed response sizes are capped before processing", async () => {
  for (const oversized of [
    new Response("{}", { headers: { "Content-Length": String(256 * 1024 + 1) } }),
    new Response(" ".repeat(256 * 1024 + 1)),
  ]) {
    const result = await createNodeInfoProvider({ fetch: async () => oversized })([host]);
    assert.match(result.hosts[0]!.error!, /size limit/);
  }
});

test("timeouts abort both pending HTTP requests and body reads after headers", async () => {
  for (const headersArrived of [false, true]) {
    let aborted = false;
    const provider = createNodeInfoProvider({ timeoutMs: 5, fetch: async (_input, init) => {
      if (!headersArrived) return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("sensitive abort diagnostic"));
      }));
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
        init!.signal!.addEventListener("abort", () => {
          aborted = true;
          controller.error(new Error("sensitive body diagnostic"));
        });
      } }));
    } });
    const result = (await provider([host])).hosts[0]!;
    assert.equal(aborted, true);
    assert.equal(result.values, null);
    assert.match(result.error!, /timed out/);
    assert(!result.error!.includes("sensitive"));
  }
});
