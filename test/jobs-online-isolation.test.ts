import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createJobProvider } from "../scripts/jobs.ts";
import { JOB_REFRESH_INTERVAL_MS } from "../src/fleet/jobs.ts";
import type { JobSnapshot } from "../src/fleet/jobs.ts";

function address(value: number): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let encoded = "";
  for (let n = value; n; n = Math.floor(n / 58)) encoded = alphabet[n % 58]! + encoded;
  return "1".repeat(32 - Math.ceil(Math.log2(value + 1) / 8)) + encoded;
}
const baseTime = 1_000_000;
const roster = (size: number): string[] => Array.from({ length: size }, (_, index) => address(index + 1));
const hostFrom = (input: Parameters<typeof fetch>[0]): string => new URL(String(input)).searchParams.get("node")!;
const blank = (host: string) => ({ address: host, job: null, checkedAtMs: null, validUntilMs: null,
  failedAtMs: null, retained: false, pending: false, retryAtMs: null, error: null });

test("active network-wide discovery reproduces the fixed-roster starvation that cache reads avoid", async () => {
  let now = baseTime;
  const attempted = new Set<string>();
  const provider = createJobProvider({ now: () => now, fetch: async input => {
    attempted.add(hostFrom(input));
    return Response.json({ jobs: [], totalJobs: 0 });
  } });
  const online = roster(1_052);
  let result: JobSnapshot | undefined;
  for (let turn = 0; attempted.size < 900; turn++) {
    assert(turn < 100);
    result = await provider(online);
    if (attempted.size < 900) now = result.nextRefreshAtMs!;
  }
  const supplied = Array.from({ length: 8 }, (_, index) => address(3_000 + index));
  const exhausted = await provider(supplied);
  assert.equal(attempted.size, 900);
  assert.equal(exhausted.waitReason, "discovery-budget");
  assert.equal(exhausted.nextRefreshAtMs, baseTime + 86_400_000);
  assert(exhausted.hosts.every(record => record.pending && record.checkedAtMs === null && record.job === null));
  assert(supplied.every(host => !attempted.has(host)));
});

for (const size of [8, 200]) {
  test(`48 hours of 1052-host cache reads preserve every ${size}-host fixed-roster dispatch and deadline`, async () => {
    let now = baseTime;
    const fixed = roster(size);
    // Reversal also detects accidental cache insertion changing first-read order.
    const online = roster(1_052).reverse();
    const timings = fixed.map((node, index) => ({ address: address(10_000 + index), node,
      state: 1, timeStart: 900, timeEnd: 0, timeout: 3_600 }));
    const byHost = new Map(timings.map(job => [job.node, job]));
    const byJob = new Map(timings.map(job => [job.address, job]));
    function fixture() {
      const calls: { at: number; method: string; addresses: string[] }[] = [];
      const provider = createJobProvider({ now: () => now, fetch: async (input, init) => {
        if (init?.method === "POST") {
          const addresses = (JSON.parse(String(init.body)) as { addresses: string[] }).addresses;
          calls.push({ at: now, method: "POST", addresses });
          return Response.json(addresses.map(value => byJob.get(value)));
        }
        const host = hostFrom(input);
        calls.push({ at: now, method: "GET", addresses: [host] });
        return Response.json({ jobs: [byHost.get(host)!], totalJobs: 1 });
      } });
      return { provider, calls };
    }
    const baseline = fixture();
    const guarded = fixture();
    for (; now <= baseTime + 48 * 3_600_000; now += JOB_REFRESH_INTERVAL_MS) {
      const before = guarded.calls.length;
      const cached = guarded.provider.peek!(online);
      assert.equal(cached.hosts.length, online.length);
      assert.equal(cached.nextRefreshAtMs, now + JOB_REFRESH_INTERVAL_MS);
      assert.equal(guarded.calls.length, before);
      assert.deepEqual(await guarded.provider(fixed), await baseline.provider(fixed));
      const after = guarded.calls.length;
      guarded.provider.peek!(online);
      assert.equal(guarded.calls.length, after);
    }
    assert.deepEqual(guarded.calls, baseline.calls);
    assert.equal(new Set(guarded.calls.filter(call => call.method === "GET").flatMap(call => call.addresses)).size, size);
  });
}

test("cache reads validate input and return detached observations without renewing overdue evidence", async () => {
  const [host, unknown] = roster(2);
  let now = baseTime;
  let calls = 0;
  let failing = false;
  const provider = createJobProvider({ now: () => now, fetch: async () => {
    calls++;
    return failing ? new Response("", { status: 503 }) : Response.json({ jobs: [{
      address: address(10_000), node: host, state: 1, timeStart: 900, timeEnd: 0, timeout: 600,
    }], totalJobs: 1 });
  } });
  assert.throws(() => provider.peek!(["invalid"]), /validated Host Addresses/);
  assert.throws(() => provider.peek!([host!, host!]), /unique/);
  assert.deepEqual(provider.peek!([]), { hosts: [], nextRefreshAtMs: null, waitReason: null, waitUntilMs: null });
  assert.deepEqual(provider.peek!([unknown!]).hosts, [blank(unknown!)]);
  assert.equal(calls, 0);
  await provider([host!]);
  const original = provider.peek!([host!]);
  const detached = provider.peek!([host!]);
  detached.hosts[0]!.job!.timeStart = 1;
  detached.hosts[0]!.checkedAtMs = 1;
  detached.hosts.push(blank(unknown!));
  assert.deepEqual(provider.peek!([host!]), original);
  now += 240_000;
  assert.deepEqual(provider.peek!([host!]).hosts, original.hosts);
  assert.equal(calls, 1);
  failing = true;
  const failed = await provider([host!]);
  assert(failed.hosts[0]!.error);
  assert.deepEqual(provider.peek!([host!]).hosts, failed.hosts);
  assert.equal(calls, 2);
});

test("future-clock and due cache reads cannot prune or clear shared discovery budget history", async () => {
  let now = baseTime;
  let calls = 0;
  const provider = createJobProvider({ now: () => now, fetch: async () => {
    calls++;
    return Response.json({ jobs: [], totalJobs: 0 });
  } });
  await provider(roster(14));
  const deferred = await provider([address(15)]);
  assert.equal(deferred.waitReason, "discovery-budget");
  for (const at of [baseTime + 30_000, baseTime + 2 * 86_400_000, baseTime - 1]) {
    now = at;
    provider.peek!(roster(1_052));
  }
  now = baseTime;
  assert.deepEqual(await provider([address(15)]), deferred);
  assert.equal(calls, 14);
});

test("a cached Online read does not subscribe to or keep fixed-roster work alive", async () => {
  const host = address(1);
  let upstream: AbortSignal | undefined;
  const provider = createJobProvider({ fetch: async (_input, init) => {
    upstream = init?.signal ?? undefined;
    await new Promise<void>((_resolve, reject) => upstream!.addEventListener("abort", () => reject(upstream!.reason), { once: true }));
    throw new Error("Unreachable after cancellation");
  } });
  const consumer = new AbortController();
  const reading = provider([host], consumer.signal);
  await setImmediate();
  assert(upstream);
  assert.deepEqual(provider.peek!([host]).hosts, [blank(host)]);
  consumer.abort();
  await assert.rejects(reading, { name: "AbortError" });
  assert(upstream.aborted);
});
