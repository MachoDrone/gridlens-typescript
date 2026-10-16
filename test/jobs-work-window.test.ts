import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { createJobProvider } from "../scripts/jobs.ts";
import type { JobProvider } from "../scripts/jobs.ts";
import { createSchedulingEvidence } from "../scripts/scheduling-priority.ts";
import type { JobSnapshot } from "../src/fleet/jobs.ts";
import { createFleetTransport } from "../src/preview/fleet-transport.ts";

const baseTime = 1_000_000;
function address(value: number): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let encoded = "";
  for (let n = value; n; n = Math.floor(n / 58)) encoded = alphabet[n % 58]! + encoded;
  return "1".repeat(32 - Math.ceil(Math.log2(value + 1) / 8)) + encoded;
}
const roster = (size: number, offset = 0): string[] => Array.from({ length: size }, (_, index) => address(offset + index + 1));
const job = (node: string, index: number) => ({ address: address(10_000 + index), node,
  state: 1, timeStart: 900, timeEnd: 0, timeout: 600 });

async function advance(t: TestContext, milliseconds: number): Promise<void> {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 1_000) {
    t.mock.timers.tick(Math.min(1_000, milliseconds - elapsed));
    await setImmediate();
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function progressiveFetch(provider: JobProvider, addresses: readonly string[]): typeof fetch {
  return async (_input, init) => {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    init?.signal?.addEventListener("abort", abort, { once: true });
    return new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        const emit = (snapshot: JobSnapshot, complete: boolean): void => {
          if (!controller.signal.aborted) stream.enqueue(new TextEncoder().encode(JSON.stringify({ ...snapshot, complete }) + "\n"));
        };
        void provider(addresses, controller.signal, snapshot => emit(snapshot, false)).then(snapshot => {
          if (!controller.signal.aborted) { emit(snapshot, true); stream.close(); }
        }, error => { if (!controller.signal.aborted) stream.error(error); }).finally(() => {
          init?.signal?.removeEventListener("abort", abort);
        });
      },
      cancel() { controller.abort(); },
    }), { headers: { "Content-Type": "application/x-ndjson" } });
  };
}

test("200 slow successful hosts finish bounded finite streams without the browser's 120-second timeout", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: baseTime });
  const hosts = roster(200);
  const jobs = hosts.map(job);
  const byHost = new Map(jobs.map(value => [value.node, value]));
  const byJob = new Map(jobs.map(value => [value.address, value]));
  const firstAttempts: string[] = [];
  const dispatches: { at: number; discovery: boolean }[] = [];
  const provider = createJobProvider({ elapsedNow: Date.now, fetch: async (input, init) => {
    const discovery = init?.method !== "POST";
    dispatches.push({ at: Date.now(), discovery });
    await delay(7_000, init!.signal!);
    if (!discovery) {
      const requested = (JSON.parse(String(init!.body)) as { addresses: string[] }).addresses;
      return Response.json(requested.map(id => byJob.get(id)!));
    }
    const host = new URL(String(input)).searchParams.get("node")!;
    firstAttempts.push(host);
    return Response.json({ jobs: [byHost.get(host)!], totalJobs: 1 });
  } });
  const transport = createFleetTransport({ now: Date.now, fetch: progressiveFetch(provider, hosts) });
  const durations: number[] = [];
  while (firstAttempts.length < hosts.length) {
    const began = Date.now();
    let complete = false;
    const pending = transport.read("jobs", "/preview/jobs.json", { addresses: hosts,
      onSnapshot: (_snapshot, final) => { complete = final; } });
    await setImmediate();
    for (let step = 0; !complete && step < 70; step++) await advance(t, 1_000);
    assert(complete, "each slow work window finishes before the unchanged finite transport deadline");
    const snapshot = await pending;
    durations.push(Date.now() - began);
    assert.deepEqual(snapshot.hosts.map(record => record.address), hosts, "every final snapshot covers the complete roster");
    const unattempted = snapshot.hosts.filter(record => record.checkedAtMs === null);
    assert(unattempted.every(record => record.pending && record.error === null && record.failedAtMs === null));
    if (unattempted.length) {
      assert(snapshot.nextRefreshAtMs! <= Date.now(), "continuation remains eligible without fabricated backoff");
      await advance(t, 1_000);
    }
  }
  assert.deepEqual(firstAttempts, hosts, "yielded work retains first-attempt fairness across windows");
  assert.equal(durations.length, 12);
  assert(durations.every(duration => duration <= 68_000));
  for (const [count, window, discovery] of [[16, 30_000, false], [400, 3_600_000, false],
    [2400, 86_400_000, false], [14, 30_000, true], [336, 3_600_000, true], [900, 86_400_000, true]] as const) {
    const times = dispatches.filter(entry => !discovery || entry.discovery).map(entry => entry.at);
    for (let right = 0, left = 0; right < times.length; right++) {
      while (times[left]! <= times[right]! - window) left++;
      assert(right - left + 1 <= count);
    }
  }
});

test("expired queued maintenance finishes despite newer viewers' first-attempt work", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: baseTime });
  const known = address(1);
  let slow = false;
  let batches = 0;
  const provider = createJobProvider({ elapsedNow: Date.now, fetch: async (input, init) => {
    if (init?.method === "POST") { batches++; return Response.json([job(known, 0)]); }
    if (slow) await delay(7_000, init!.signal!);
    const host = new URL(String(input)).searchParams.get("node")!;
    return Response.json({ jobs: [job(host, host === known ? 0 : roster(1_000).indexOf(host) + 1)], totalJobs: 1 });
  } });
  await provider([known]);
  await advance(t, 120_000);
  slow = true;
  const consumers: AbortController[] = [];
  const pending: Promise<unknown>[] = [];
  const join = (offset: number): void => {
    const consumer = new AbortController();
    consumers.push(consumer);
    pending.push(provider(roster(200, offset), consumer.signal).catch(() => {}));
  };
  join(100);
  await setImmediate();
  let result: JobSnapshot | undefined;
  const maintenance = provider([known]).then(value => { result = value; });
  await advance(t, 20_000);
  join(300);
  await advance(t, 20_000);
  join(500);
  await advance(t, 23_000);
  assert(result, "expired maintenance leaves the limiter ahead of newer eligible discovery");
  assert.equal(batches, 0, "yielding queued maintenance does not start a request");
  assert.equal(result.hosts[0]!.checkedAtMs, baseTime);
  assert.equal(result.hosts[0]!.pending, true);
  assert.equal(result.hosts[0]!.failedAtMs, null);
  assert.equal(result.hosts[0]!.error, null);
  for (const consumer of consumers) consumer.abort();
  await Promise.all([...pending, maintenance]);
});

test("a joining viewer shares the original window and survives the original viewer's cancellation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: baseTime });
  const hosts = roster(40);
  const calls: string[] = [];
  const provider = createJobProvider({ elapsedNow: Date.now, fetch: async (input, init) => {
    const host = new URL(String(input)).searchParams.get("node")!;
    calls.push(host);
    await delay(7_000, init!.signal!);
    return Response.json({ jobs: [job(host, hosts.indexOf(host))], totalJobs: 1 });
  } });
  const leaving = new AbortController();
  const original = provider(hosts, leaving.signal);
  const canceled = assert.rejects(original, { name: "AbortError" });
  await setImmediate();
  await advance(t, 55_000);
  let result: JobSnapshot | undefined;
  const joined = provider([...hosts].reverse()).then(value => { result = value; });
  await setImmediate();
  leaving.abort();
  await canceled;
  await advance(t, 8_000);
  assert(result, "joining a shared operation does not renew its elapsed work window");
  assert.deepEqual(result.hosts.map(record => record.address), [...hosts].reverse());
  assert.equal(calls.length, 18);
  assert.equal(new Set(calls).size, calls.length);
  assert(result.hosts.every(record => record.error === null && record.failedAtMs === null));
  await joined;
});

test("replacement discovery inherits a drained batch's window without adding a new lookup backoff", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: baseTime });
  const host = address(1);
  let elapsed = 0;
  let replacement = false;
  const methods: string[] = [];
  const provider = createJobProvider({ elapsedNow: () => elapsed, fetch: async (_input, init) => {
    methods.push(init!.method!);
    if (init?.method !== "POST") return Response.json({ jobs: [job(host, replacement ? 1 : 0)], totalJobs: 1 });
    elapsed = 60_001;
    return Response.json([{ ...job(host, 0), state: 2, timeEnd: 1_100 }]);
  } });
  await provider([host]);
  await advance(t, 120_000);
  const ended = await provider([host]);
  assert.deepEqual(methods, ["GET", "POST"]);
  assert.equal(ended.hosts[0]!.job, null);
  assert.equal(ended.hosts[0]!.pending, true);
  assert.equal(ended.hosts[0]!.failedAtMs, null);
  assert.equal(ended.hosts[0]!.error, null);
  assert.equal(ended.nextRefreshAtMs, Date.now(), "the replacement's first actual lookup remains immediately due");
  replacement = true;
  const resumed = await provider([host]);
  assert.deepEqual(methods, ["GET", "POST", "GET"]);
  assert.equal(resumed.hosts[0]!.job?.address, job(host, 1).address);
});

test("elapsed windows are independent of evidence-clock movement", async () => {
  const hosts = roster(6);
  let now = baseTime;
  let elapsed = 0;
  let calls = 0;
  const provider = createJobProvider({ now: () => now, elapsedNow: () => elapsed, fetch: async input => {
    calls++;
    now += 60_000;
    const host = new URL(String(input)).searchParams.get("node")!;
    return Response.json({ jobs: [job(host, hosts.indexOf(host))], totalJobs: 1 });
  } });
  assert((await provider(hosts)).hosts.every(record => record.job));
  assert.equal(calls, hosts.length, "wall-clock movement cannot consume the monotonic window");
  const second = createJobProvider({ now: () => now, elapsedNow: () => elapsed, fetch: async input => {
    elapsed += 30_000;
    const host = new URL(String(input)).searchParams.get("node")!;
    return Response.json({ jobs: [job(host, hosts.indexOf(host))], totalJobs: 1 });
  } });
  const result = await second(hosts);
  assert.equal(result.hosts.filter(record => record.job).length, 2);
  assert(result.hosts.slice(2).every(record => record.pending && record.checkedAtMs === null && record.failedAtMs === null));
});

test("first discovery uses fresh backend activity at enqueue and again when a slot opens", async () => {
  const hosts = roster(6);
  const now = baseTime;
  const evidence = createSchedulingEvidence(() => now);
  const state = (host: string, expiresAt = now + 30_000): void => evidence.observeStates({ hosts: [{
    address: host, values: { state: "RUNNING_JOB", dl: null, ul: null, ping: null, networkUnavailableReason: null },
    fetchedAtMs: now, validUntilMs: expiresAt, retained: false, error: null,
  }] });
  state(hosts[4]!);
  state(hosts[5]!);
  state(hosts[0]!, now);
  const calls: string[] = [];
  const resolve: (() => void)[] = [];
  const provider = createJobProvider({ now: () => now, activityPriority: evidence.activityPriority,
    fetch: async input => {
      const host = new URL(String(input)).searchParams.get("node")!;
      calls.push(host);
      if (calls.length <= 2) await new Promise<void>(done => { resolve.push(done); });
      return Response.json({ jobs: [job(host, hosts.indexOf(host))], totalJobs: 1 });
    } });
  const pending = provider(hosts);
  await setImmediate();
  assert.deepEqual(calls, hosts.slice(4), "the first two slots already use validated activity priority");
  state(hosts[3]!);
  resolve[0]!();
  await setImmediate();
  assert.deepEqual(calls.slice(2), [hosts[3], hosts[0], hosts[1], hosts[2]], "new proof reprioritizes queued work; expired proof does not");
  resolve[1]!();
  const result = await pending;
  assert.deepEqual(result.hosts.map(record => record.address), hosts);
});
