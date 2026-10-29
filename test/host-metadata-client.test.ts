import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createHostMetadataProvider } from "../scripts/host-metadata.ts";

const addresses = Array.from({ length: 8 }, (_, index) => `${"1".repeat(31)}${index + 2}`);
const host = addresses[0]!;
const market = `${"1".repeat(31)}A`;
const origin = "https://host-manager.k8s.prd.nosana.com";
const payload = (address = host, country = "US") => ({ nodeAddress: address, status: "PREMIUM", marketAddress: market,
  metrics: { ram_gb: 31.4, network: { country } } });
const response = (value: unknown): Response => Response.json(value);

test("all eight hosts load selected metadata using anonymous fixed URLs and one shared market lookup", async () => {
  const calls: string[] = [];
  const provider = createHostMetadataProvider({ now: () => 1234, fetch: async (input, init) => {
    const url = String(input);
    calls.push(url);
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit");
    assert.deepEqual(init?.headers, { Accept: "application/json" });
    assert(init?.signal instanceof AbortSignal);
    const address = url.split("/")[4];
    return url.includes("/markets/")
      ? response({ address: market, slug: "ember-demo", name: "Ember Demo NVIDIA", nodes: ["not copied"] })
      : response(payload(address));
  } });
  const result = await provider(addresses);
  assert.deepEqual(result.hosts.map(row => row.address), addresses);
  assert(result.hosts.every(row => row.values?.status === "PREMIUM" && row.values.marketLabel === "ember-demo"));
  assert(result.hosts.every(row => row.values?.country === "US"), "country reuses each existing metrics response");
  assert(result.hosts.every(row => row.fetchedAtMs === 1234 && !row.retained && !row.error && !row.marketError));
  assert.equal(calls.length, 9);
  assert.equal(calls.filter(url => url === `${origin}/markets/${market}`).length, 1);
  assert.deepEqual(new Set(calls.filter(url => url.includes("/nodes/"))), new Set(addresses.map(address => `${origin}/nodes/${address}/metrics`)));
  assert(!JSON.stringify(result).includes("not copied"));
});

test("metadata is demand-driven and success cache does not refetch or expose mutable cache references", async () => {
  let now = 0;
  let calls = 0;
  const provider = createHostMetadataProvider({ now: () => now, fetch: async input => {
    calls++;
    return String(input).includes("/markets/") ? response({ address: market, slug: "demo" }) : response(payload());
  } });
  assert.equal(calls, 0);
  const first = await provider([host]);
  first.hosts[0]!.values!.status = "caller changed";
  first.hosts[0]!.values!.country = "caller changed";
  now = 299_999;
  const cached = (await provider([host])).hosts[0]!;
  assert.equal(cached.values!.status, "PREMIUM");
  assert.equal(cached.values!.country, "US");
  assert.equal(cached.fetchedAtMs, 0);
  assert.equal(calls, 2);
  now = 300_000;
  assert.equal((await provider([host])).hosts[0]!.fetchedAtMs, now);
  assert.equal(calls, 3);
  now = 3_600_000;
  await provider([host]);
  assert.equal(calls, 5);
});

test("overlapping requests deduplicate hosts and markets and limit all HTTP calls to two", async () => {
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const provider = createHostMetadataProvider({ fetch: async input => {
    active++;
    calls++;
    maximum = Math.max(maximum, active);
    await setImmediate();
    active--;
    const url = String(input);
    return url.includes("/markets/") ? response({ address: market, name: "Demo" }) : response(payload(url.split("/")[4]));
  } });
  const [one, two] = await Promise.all([provider(addresses), provider([...addresses].reverse())]);
  assert.equal(maximum, 2);
  assert.equal(calls, 9);
  assert.deepEqual(one.hosts.map(row => row.address), addresses);
  assert.deepEqual(two.hosts.map(row => row.address), [...addresses].reverse());
});

test("invalid, duplicate and empty supplied addresses cause no network calls", async () => {
  let calls = 0;
  const provider = createHostMetadataProvider({ fetch: async () => { calls++; throw new Error("not allowed"); } });
  assert.deepEqual(await provider([]), { hosts: [] });
  await assert.rejects(provider([host, "https://elsewhere.test"]), /validated/);
  await assert.rejects(provider([host, host]), /unique/);
  assert.equal(calls, 0);
});

test("later metadata failure retains selected values and original fetch time until a successful retry", async () => {
  let now = 10_000;
  let fail = false;
  let calls = 0;
  let country = "US";
  const provider = createHostMetadataProvider({ now: () => now, fetch: async input => {
    calls++;
    if (fail) return new Response("private upstream diagnostic", { status: 503 });
    return String(input).includes("/markets/") ? response({ address: market, slug: "demo" }) : response(payload(host, country));
  } });
  const first = (await provider([host])).hosts[0]!;
  now += 300_000;
  fail = true;
  const retained = (await provider([host])).hosts[0]!;
  assert.deepEqual(retained.values, first.values);
  assert.equal(retained.values?.country, "US");
  assert.equal(retained.fetchedAtMs, 10_000);
  assert.equal(retained.retained, true);
  assert.match(retained.error!, /HTTP 503/);
  now += 59_999;
  await provider([host]);
  assert.equal(calls, 3);
  now++;
  fail = false;
  country = "CA";
  const recovered = (await provider([host])).hosts[0]!;
  assert.equal(recovered.retained, false);
  assert.equal(recovered.error, null);
  assert.equal(recovered.fetchedAtMs, now);
  assert.equal(recovered.values?.country, "CA");
  assert.equal(calls, 4, "country recovery adds no separate location request");
});

test("first failure is unknown and identity mismatch never overwrites another host", async () => {
  const provider = createHostMetadataProvider({ now: () => 1000, fetch: async () => response(payload(addresses[1])) });
  const result = (await provider([host])).hosts[0]!;
  assert.equal(result.values, null);
  assert.equal(result.fetchedAtMs, null);
  assert.equal(result.retained, false);
  assert.match(result.error!, /did not match/);
});

test("failed market lookup preserves host fields and independently retries after backoff", async () => {
  let now = 0;
  let marketFails = true;
  let calls = 0;
  const provider = createHostMetadataProvider({ now: () => now, fetch: async input => {
    calls++;
    if (String(input).includes("/markets/")) return marketFails ? new Response("", { status: 503 }) : response({ address: market, slug: "demo" });
    return response(payload());
  } });
  const first = (await provider([host])).hosts[0]!;
  assert.equal(first.values?.status, "PREMIUM");
  assert.equal(first.values?.marketLabel, null);
  assert.equal(first.error, null);
  assert.match(first.marketError!, /HTTP 503/);
  now = 59_999;
  await provider([host]);
  assert.equal(calls, 2);
  now = 60_000;
  marketFails = false;
  const recovered = (await provider([host])).hosts[0]!;
  assert.equal(recovered.values?.marketLabel, "demo");
  assert.equal(recovered.marketError, null);
  assert.equal(recovered.fetchedAtMs, 0);
  assert.equal(calls, 3);
});

test("market identity mismatch supplies no misleading label or unselected payload", async () => {
  const provider = createHostMetadataProvider({ fetch: async input => String(input).includes("/markets/")
    ? response({ address: host, slug: "wrong label" }) : response(payload()) });
  const result = (await provider([host])).hosts[0]!;
  assert.equal(result.values?.marketLabel, null);
  assert.match(result.marketError!, /did not match/);
  assert.equal(result.error, null);
});

test("market label survives a later failed lookup with its own error and no fallback to an old assignment", async () => {
  let now = 0;
  let marketFails = false;
  let assignment = market;
  const provider = createHostMetadataProvider({ now: () => now, fetch: async input => {
    if (String(input).includes("/markets/")) return marketFails
      ? new Response("", { status: 503 }) : response({ address: market, slug: "demo" });
    return response({ ...payload(), marketAddress: assignment });
  } });
  await provider([host]);
  now = 3_600_000;
  marketFails = true;
  const retained = (await provider([host])).hosts[0]!;
  assert.equal(retained.values?.marketLabel, "demo");
  assert.match(retained.marketError!, /HTTP 503/);
  assert.equal(retained.error, null);
  now += 300_000;
  assignment = `${"1".repeat(31)}B`;
  const changed = (await provider([host])).hosts[0]!;
  assert.equal(changed.values?.marketAddress, assignment);
  assert.equal(changed.values?.marketLabel, null);
  assert.match(changed.marketError!, /HTTP 503/);
});

test("429 Retry-After pauses the whole service including queued and newly supplied host requests", async () => {
  let now = 1000;
  let calls = 0;
  let limited = true;
  const provider = createHostMetadataProvider({ now: () => now, fetch: async input => {
    calls++;
    if (limited) return new Response("", { status: 429, headers: { "Retry-After": "120" } });
    return response({ nodeAddress: String(input).split("/")[4], status: "ONBOARDED" });
  } });
  const first = await provider(addresses.slice(0, 6));
  assert.equal(calls, 2);
  assert(first.hosts.every(row => row.values === null && row.error));
  now = 120_999;
  await provider(addresses);
  assert.equal(calls, 2);
  now = 121_000;
  limited = false;
  await provider(addresses.slice(0, 6));
  assert.equal(calls, 8);
});

test("429 HTTP-date Retry-After and a market 429 also pause node requests", async () => {
  let now = Date.parse("2026-10-06T12:00:00Z");
  let calls = 0;
  const provider = createHostMetadataProvider({ now: () => now, fetch: async input => {
    calls++;
    return String(input).includes("/markets/")
      ? new Response("", { status: 429, headers: { "Retry-After": "Tue, 06 Oct 2026 12:03:00 GMT" } })
      : response(payload());
  } });
  const result = (await provider([host])).hosts[0]!;
  assert.equal(result.error, null);
  assert.match(result.marketError!, /HTTP 429/);
  now += 179_999;
  await provider([addresses[1]!]);
  assert.equal(calls, 2);
});

test("HTTP error bodies, transport diagnostics and malformed JSON are not exposed", async () => {
  for (const fetcher of [
    async () => new Response("sensitive diagnostic", { status: 401 }),
    async () => { throw new Error("sensitive diagnostic"); },
    async () => new Response("sensitive diagnostic", { status: 200 }),
    async () => new Response("", { status: 302, headers: { Location: "https://elsewhere.test/" } }),
  ]) {
    const result = await createHostMetadataProvider({ fetch: fetcher })([host]);
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
    const result = await createHostMetadataProvider({ fetch: async () => oversized })([host]);
    assert.match(result.hosts[0]!.error!, /size limit/);
  }
});

test("requests time out and abort without changing unknown values", async () => {
  let aborted = false;
  const provider = createHostMetadataProvider({ timeoutMs: 5, fetch: async (_input, init) => {
    return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => {
      aborted = true;
      reject(new Error("aborted transport"));
    }));
  } });
  const result = (await provider([host])).hosts[0]!;
  assert.equal(aborted, true);
  assert.equal(result.values, null);
  assert.match(result.error!, /timed out/);
});

test("the timeout also covers response-body reads after HTTP headers arrive", async () => {
  let aborted = false;
  const provider = createHostMetadataProvider({ now: () => 1000, timeoutMs: 5, fetch: async (_input, init) => {
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
      init!.signal!.addEventListener("abort", () => {
        aborted = true;
        controller.error(new Error("body aborted"));
      });
    } });
    return new Response(body);
  } });
  const result = (await provider([host])).hosts[0]!;
  assert.equal(aborted, true);
  assert.equal(result.values, null);
  assert.match(result.error!, /timed out/);
});
