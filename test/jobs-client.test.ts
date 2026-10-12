import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createJobProvider } from "../scripts/jobs.ts";
import type { JobSnapshot } from "../src/fleet/jobs.ts";
import type { NodeInfoSnapshot } from "../src/fleet/node-info.ts";

// Public fixture identifiers from small integers, padded to exactly 32 bytes.
function address(value: number): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let encoded = "";
  let n = value;
  while (n) { encoded = alphabet[n % 58]! + encoded; n = Math.floor(n / 58); }
  const bytes = value === 0 ? 0 : Math.ceil(Math.log2(value + 1) / 8);
  return "1".repeat(32 - bytes) + encoded;
}
const hosts = Array.from({ length: 8 }, (_, i) => address(i + 1));
const host = hosts[0]!;
const jobAddress = address(1000);
const baseTime = 1_000_000;
const job = (node = host, id = jobAddress) => ({ address: id, node, state: 1, timeStart: 900, timeEnd: 0, timeout: 600 });
const lookup = (value: unknown) => ({ jobs: [value], totalJobs: 1 });
const nodeFrom = (input: Parameters<typeof fetch>[0]): string => new URL(String(input)).searchParams.get("node")!;
function deferredResponse(): { promise: Promise<Response>; resolve: (value: Response) => void } {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}

test("assignment uses the fixed anonymous documented read and exposes only selected timing", async () => {
  const calls: string[] = [];
  const provider = createJobProvider({ now: () => baseTime, fetch: async (input, init) => {
    calls.push(String(input));
    assert.equal(String(input), `https://blockchain-indexer.k8s.prd.nos.ci/jobs/?node=${host}&state=RUNNING&limit=2`);
    assert.equal(init?.method, "GET");
    assert.deepEqual(init?.headers, { Accept: "application/json" });
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    assert(init?.signal instanceof AbortSignal);
    return Response.json(lookup({ ...job(), jobDefinition: { secret: "do not retain" }, payer: "unrelated" }));
  } });
  assert.equal(calls.length, 0);
  assert.deepEqual((await provider([host])).hosts[0], {
    address: host, job: { ...job(), state: "RUNNING" }, checkedAtMs: baseTime,
    validUntilMs: baseTime + 180_000, failedAtMs: null, retained: false, pending: false,
    retryAtMs: null, error: null,
  });
});

test("assignment validates actual jobs/totalJobs shape and exact unambiguous host identity", async () => {
  for (const payload of [
    [job()], {}, { jobs: [job()], totalJobs: "1" }, { jobs: [], totalJobs: 1 },
    { jobs: [job()], totalJobs: 0 }, { jobs: [job(), job(host, address(1001))], totalJobs: 2 },
    { jobs: [job()], totalJobs: 100 }, lookup(job(hosts[1])), lookup({ ...job(), address: "invalid" }),
    lookup({ ...job(), state: 99 }), lookup({ ...job(), state: "FUTURE_STATE" }),
    lookup({ ...job(), state: 2 }), lookup({ ...job(), timeEnd: 999 }),
  ]) {
    let calls = 0;
    let now = baseTime;
    const provider = createJobProvider({ now: () => now, fetch: async () => { calls++; return Response.json(payload); } });
    const first = (await provider([host])).hosts[0]!;
    assert(first.error, JSON.stringify(payload));
    assert.equal(first.job, null);
    now += 59_999;
    await provider([host]);
    assert.equal(calls, 1);
    now++;
    await provider([host]);
    assert.equal(calls, 2);
  }
});

test("empty assignments have a 60-second lookup floor and no fabricated duration", async () => {
  let now = baseTime;
  let calls = 0;
  const provider = createJobProvider({ now: () => now, fetch: async () => { calls++; return Response.json({ jobs: [], totalJobs: 0 }); } });
  const first = (await provider([host])).hosts[0]!;
  assert.equal(first.job, null);
  assert.equal(first.error, null);
  now += 59_999;
  await provider([host]);
  assert.equal(calls, 1);
  now++;
  await provider([host]);
  assert.equal(calls, 2);
});

test("known assignments use read-only POST batches after 120 seconds and apply timeout extensions", async () => {
  let now = baseTime;
  let calls = 0;
  const provider = createJobProvider({ now: () => now, fetch: async (input, init) => {
    calls++;
    if (init?.method === "GET") return Response.json(lookup(job()));
    assert.equal(String(input), "https://blockchain-indexer.k8s.prd.nos.ci/jobs/batch");
    assert.deepEqual(JSON.parse(String(init?.body)), { addresses: [jobAddress] });
    assert.deepEqual(init?.headers, { Accept: "application/json", "Content-Type": "application/json" });
    return Response.json([{ ...job(), timeout: 1200 }]);
  } });
  const first = (await provider([host])).hosts[0]!;
  first.job!.timeout = 99;
  first.validUntilMs = 0;
  now += 119_999;
  const cached = (await provider([host])).hosts[0]!;
  assert.equal(cached.job?.timeout, 600);
  assert.equal(cached.validUntilMs, baseTime + 180_000);
  assert.equal(calls, 1);
  now++;
  const updated = (await provider([host])).hosts[0]!;
  assert.equal(updated.job?.timeout, 1200);
  assert.equal(updated.checkedAtMs, now);
  assert.equal(updated.validUntilMs, now + 180_000);
  assert.equal(calls, 2);
});

test("missing/invalid timing stays unknown instead of becoming zero", async () => {
  const provider = createJobProvider({ now: () => baseTime,
    fetch: async () => Response.json(lookup({ ...job(), timeStart: "900", timeout: -5 })) });
  const record = (await provider([host])).hosts[0]!;
  assert.equal(record.job, null);
  assert.equal(record.checkedAtMs, null);
  assert.match(record.error!, /run start/);
  const missingEnd = createJobProvider({ fetch: async () => Response.json(lookup({ ...job(), timeEnd: undefined })) });
  assert((await missingEnd([host])).hosts[0]!.error);
});

test("an advancing clock cannot manufacture a job request budget pause", async () => {
  let now = baseTime;
  let calls = 0;
  const provider = createJobProvider({ now: () => now++, fetch: async () => {
    calls++;
    return Response.json(lookup(job()));
  } });
  const record = (await provider([host])).hosts[0]!;
  assert.equal(calls, 1);
  assert.equal(record.pending, false);
  assert.equal(record.error, null);
  assert.equal(record.job?.address, jobAddress);
});

test("overlapping browser work shares host requests with at most two upstream calls", async () => {
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const provider = createJobProvider({ now: () => baseTime, fetch: async input => {
    active++;
    maximum = Math.max(maximum, active);
    calls++;
    await setImmediate();
    active--;
    const node = nodeFrom(input);
    return Response.json(lookup(job(node, address(1000 + hosts.indexOf(node)))));
  } });
  const [one, two] = await Promise.all([provider(hosts), provider([...hosts].reverse())]);
  assert.equal(calls, 8);
  assert.equal(maximum, 2);
  assert.deepEqual(one.hosts.map(row => row.address), hosts);
  assert.deepEqual(two.hosts.map(row => row.address), [...hosts].reverse());
});

test("progress delivers fast rows and cached rows while another viewer keeps a slow shared read alive", async () => {
  const slow = deferredResponse();
  let slowSignal: AbortSignal | undefined;
  let calls = 0;
  const provider = createJobProvider({ now: () => baseTime, fetch: async (input, init) => {
    calls++;
    if (nodeFrom(input) === hosts[1]) { slowSignal = init!.signal!; return slow.promise; }
    return Response.json(lookup(job()));
  } });
  const leaving = new AbortController();
  const firstUpdates: JobSnapshot[] = [];
  const secondUpdates: JobSnapshot[] = [];
  const one = provider(hosts.slice(0, 2), leaving.signal, update => firstUpdates.push(update));
  const two = provider(hosts.slice(0, 2), undefined, update => secondUpdates.push(update));
  await setImmediate();
  assert.equal(calls, 2);
  assert(firstUpdates.some(update => update.hosts[0]?.job?.address === jobAddress));
  assert(secondUpdates.some(update => update.hosts[0]?.job?.address === jobAddress));
  const rejection = assert.rejects(one, { name: "AbortError" });
  leaving.abort();
  await rejection;
  const priorUpdates = firstUpdates.length;
  assert.equal(slowSignal?.aborted, false);
  slow.resolve(Response.json(lookup(job(hosts[1], address(1001)))));
  const result = await two;
  assert.equal(result.hosts[1]?.job?.address, address(1001));
  assert.equal(firstUpdates.length, priorUpdates);
  assert(secondUpdates.some(update => update.hosts[0]?.job?.address === address(1001)));
  const cached: JobSnapshot[] = [];
  await provider(hosts.slice(0, 2), undefined, update => cached.push(update));
  assert.equal(calls, 2);
  assert.equal(cached.length, 1);
  assert.deepEqual(cached[0]?.hosts, result.hosts);
});

test("progress ends with the last canceled consumer and immediate resume ignores obsolete responses", async () => {
  const replies: ReturnType<typeof deferredResponse>[] = [];
  const signals: AbortSignal[] = [];
  const provider = createJobProvider({ now: () => baseTime, fetch: async (_input, init) => {
    signals.push(init!.signal!);
    const reply = deferredResponse();
    replies.push(reply);
    return reply.promise;
  } });
  const leaving = new AbortController();
  const oldUpdates: JobSnapshot[] = [];
  const old = provider([host], leaving.signal, update => oldUpdates.push(update));
  await setImmediate();
  const rejected = assert.rejects(old, { name: "AbortError" });
  leaving.abort();
  await rejected;
  assert.equal(signals[0]?.aborted, true);
  const newUpdates: JobSnapshot[] = [];
  const resumed = provider([host], undefined, update => newUpdates.push(update));
  await setImmediate();
  assert.equal(replies.length, 2);
  replies[1]!.resolve(Response.json(lookup(job())));
  assert.equal((await resumed).hosts[0]?.error, null);
  replies[0]!.resolve(new Response("", { status: 429, headers: { "Retry-After": "600" } }));
  await setImmediate();
  assert.equal(oldUpdates.length, 0);
  assert(newUpdates.some(update => update.hosts[0]?.job?.address === jobAddress));
  assert.equal((await provider([host])).nextRefreshAtMs, baseTime + 120_000);
});

test("batch progress delivers a current clock before a sibling replacement lookup completes", async () => {
  let now = baseTime;
  const replacement = deferredResponse();
  let discoverReplacement = false;
  const provider = createJobProvider({ now: () => now, fetch: async (input, init) => {
    if (init?.method === "POST") return Response.json([job(), { ...job(hosts[1], address(1001)), timeEnd: 1000 }]);
    const node = nodeFrom(input);
    if (discoverReplacement && node === hosts[1]) return replacement.promise;
    return Response.json(lookup(job(node, node === host ? jobAddress : address(1001))));
  } });
  await provider(hosts.slice(0, 2));
  now += 120_000;
  discoverReplacement = true;
  const updates: JobSnapshot[] = [];
  const read = provider(hosts.slice(0, 2), undefined, update => updates.push(update));
  await setImmediate();
  assert(updates.some(update => update.hosts.some(row => row.address === host && row.checkedAtMs === now)));
  replacement.resolve(Response.json(lookup(job(hosts[1], address(1002)))));
  assert.equal((await read).hosts[1]?.job?.address, address(1002));
});

test("progress callbacks cannot mutate cached jobs or turn a successful read into failed evidence", async () => {
  const provider = createJobProvider({ now: () => baseTime, fetch: async () => Response.json(lookup(job())) });
  const result = await provider([host], undefined, update => {
    update.hosts[0]!.job!.timeout = 1;
    throw new Error("viewer write failed");
  });
  assert.equal(result.hosts[0]?.job?.timeout, 600);
  assert.equal(result.hosts[0]?.error, null);
});

test("failed batches preserve exact identity/check/deadline and the first failure time until recovery", async () => {
  let now = baseTime;
  let fail = false;
  let calls = 0;
  const provider = createJobProvider({ now: () => now, fetch: async (_input, init) => {
    calls++;
    if (fail) throw new Error("do not expose raw transport diagnostics");
    return Response.json(init?.method === "GET" ? lookup(job()) : [job()]);
  } });
  await provider([host]);
  fail = true;
  now += 120_000;
  const failed = (await provider([host])).hosts[0]!;
  assert.equal(failed.failedAtMs, now);
  assert.equal(failed.checkedAtMs, baseTime);
  assert.equal(failed.validUntilMs, baseTime + 180_000);
  assert.equal(failed.retained, true);
  assert(!failed.error?.includes("raw transport"));
  now += 59_999;
  await provider([host]);
  assert.equal(calls, 2);
  now++;
  assert.equal((await provider([host])).hosts[0]!.failedAtMs, failed.failedAtMs);
  now += 120_000;
  fail = false;
  const recovered = (await provider([host])).hosts[0]!;
  assert.equal(recovered.failedAtMs, null);
  assert.equal(recovered.retained, false);
  assert.equal(recovered.checkedAtMs, now);
});

test("ended, disappeared or moved assignments discover replacements with the replacement clock identity", async () => {
  for (const batch of [[{ ...job(), state: 2, timeEnd: 1000 }], [], [job(hosts[1])]]) {
    let now = baseTime;
    let lookups = 0;
    const next = job(host, address(1001));
    next.timeStart = 1050;
    const provider = createJobProvider({ now: () => now, fetch: async (_input, init) => {
      if (init?.method === "POST") return Response.json(batch);
      return Response.json(lookup(lookups++ ? next : job()));
    } });
    await provider([host]);
    now += 120_000;
    const record = (await provider([host])).hosts[0]!;
    assert.equal(record.job?.address, next.address);
    assert.equal(record.job?.timeStart, 1050);
    assert.equal(record.retained, false);
    assert.equal(lookups, 2);
  }
});

test("confirmed completion clears prior timing even when replacement discovery fails", async () => {
  let now = baseTime;
  let lookups = 0;
  const provider = createJobProvider({ now: () => now, fetch: async (_input, init) => {
    if (init?.method === "POST") return Response.json([{ ...job(), timeEnd: 1000 }]);
    if (lookups++) throw new Error("failed replacement");
    return Response.json(lookup(job()));
  } });
  await provider([host]);
  now += 120_000;
  const result = (await provider([host])).hosts[0]!;
  assert.equal(result.job, null);
  assert(result.error);
});

test("a valid empty replacement clears missing/moved assignments; unknown/malformed batch evidence retains timing", async () => {
  for (const replacement of ["empty", "failed"] as const) {
    let now = baseTime;
    let lookups = 0;
    const provider = createJobProvider({ now: () => now, fetch: async (_input, init) => {
      if (init?.method === "POST") return Response.json([]);
      if (lookups++ === 0) return Response.json(lookup(job()));
      return replacement === "empty" ? Response.json({ jobs: [], totalJobs: 0 }) : new Response("", { status: 503 });
    } });
    await provider([host]);
    now += 120_000;
    const result = (await provider([host])).hosts[0]!;
    assert.equal(result.job?.address ?? null, replacement === "empty" ? null : jobAddress);
    assert.equal(result.retained, replacement === "failed");
  }
  for (const invalid of [
    [{ ...job(), state: 99 }], [job(), job()], [job(host, address(1001))], {},
  ]) {
    let now = baseTime;
    const provider = createJobProvider({ now: () => now, fetch: async (_input, init) =>
      Response.json(init?.method === "GET" ? lookup(job()) : invalid) });
    await provider([host]);
    now += 120_000;
    const result = (await provider([host])).hosts[0]!;
    assert.equal(result.job?.address, jobAddress);
    assert.equal(result.retained, true);
    assert(result.error);
  }
});

test("future or backwards end timing cannot clear a running assignment", async () => {
  for (const end of [899, 900_000]) {
    let now = baseTime;
    let lookups = 0;
    const provider = createJobProvider({ now: () => now, fetch: async (_input, init) => {
      if (init?.method === "POST") return Response.json([{ ...job(), timeEnd: end }]);
      if (lookups++) throw new Error("replacement unavailable");
      return Response.json(lookup(job()));
    } });
    await provider([host]);
    now += 120_000;
    const result = (await provider([host])).hosts[0]!;
    assert.equal(result.job?.address, jobAddress);
    assert.equal(result.retained, true);
  }
});

test("one job claimed by distinct hosts is conflicting evidence for both", async () => {
  const provider = createJobProvider({ now: () => baseTime,
    fetch: async input => Response.json(lookup(job(nodeFrom(input)))) });
  const result = await provider(hosts.slice(0, 2));
  assert(result.hosts.every(record => record.error?.includes("conflicting")));
});

test("discovery reserves maintenance capacity within the sliding 30-second ceiling", async () => {
  const many = Array.from({ length: 20 }, (_, i) => address(i + 1));
  let now = baseTime;
  let calls = 0;
  const provider = createJobProvider({ now: () => now, fetch: async () => {
    calls++; return Response.json({ jobs: [], totalJobs: 0 });
  } });
  const result = await provider(many);
  assert.equal(calls, 14);
  assert.equal(result.nextRefreshAtMs, baseTime + 30_000);
  assert.equal(result.waitReason, "discovery-budget");
  assert.equal(result.waitUntilMs, baseTime + 30_000);
  assert.equal(result.hosts.filter(record => record.pending).length, 6);
  assert(result.hosts.slice(14).every(record => record.retryAtMs === baseTime + 30_000 && record.failedAtMs === null));
  now += 29_999;
  await provider(many);
  assert.equal(calls, 14);
  now++;
  const resumed = await provider(many);
  assert.equal(calls, 20);
  assert(resumed.hosts.every(record => !record.pending));
});

test("discovery hourly and daily suballowances are sliding limits independent of host identities", async () => {
  let now = baseTime;
  let calls = 0;
  const provider = createJobProvider({ now: () => now, fetch: async () => {
    calls++; return Response.json({ jobs: [], totalJobs: 0 });
  } });
  let nextHost = 1;
  for (let hour = 0; hour < 3; hour++) {
    const hourStart = baseTime + hour * 3_600_000;
    for (let block = 0; block < 24; block++) {
      now = hourStart + block * 30_000;
      await provider(Array.from({ length: 14 }, () => address(nextHost++)));
    }
    assert.equal(calls, Math.min(900, (hour + 1) * 336));
    now += 30_000;
    const blocked = (await provider([address(nextHost++)])).hosts[0]!;
    assert.equal(blocked.pending, true);
    assert.equal(blocked.retryAtMs, hour === 2 ? baseTime + 86_400_000 : hourStart + 3_600_000);
    assert.equal((await provider([blocked.address])).nextRefreshAtMs, blocked.retryAtMs);
    assert.equal(calls, Math.min(900, (hour + 1) * 336));
  }
  now = baseTime + 86_400_000;
  await provider([address(nextHost++)]);
  assert.equal(calls, 901);
});

test("86 and 201 cold hosts progress each budget window before repeating empty or failed rows", async () => {
  for (const count of [86, 201]) {
    const many = Array.from({ length: count }, (_, i) => address(i + 1));
    let now = baseTime;
    const calls: string[] = [];
    const provider = createJobProvider({ now: () => now, fetch: async input => {
      const node = nodeFrom(input);
      calls.push(node);
      // Early rows remain empty or fail. Neither may consume the next cold row's turn.
      return many.indexOf(node) % 2 === 0 ? Response.json({ jobs: [], totalJobs: 0 })
        : new Response("", { status: 503 });
    } });
    for (let offset = 0; offset < count; offset += 14) {
      const snapshot = await provider(many);
      const discovered = Math.min(offset + 14, count);
      assert.deepEqual(calls.slice(0, discovered), many.slice(0, discovered));
      assert.equal(new Set(calls.slice(0, discovered)).size, discovered);
      const neverRead = snapshot.hosts.filter(row => row.checkedAtMs === null && row.failedAtMs === null);
      assert.equal(neverRead.length, count - discovered);
      assert(neverRead.every(row => row.pending && row.retryAtMs === now + 30_000));
      assert(calls.length <= offset + 14, "discovery preserves two dispatches per short budget window");
      now += 30_000;
    }
    assert.equal(new Set(calls).size, count);
  }
});

test("fair cold discovery preserves known-job batches and shares work across reordered viewers", async () => {
  const many = Array.from({ length: 201 }, (_, i) => address(i + 1));
  let now = baseTime;
  const discoveries: string[] = [];
  let dispatches = 0;
  const provider = createJobProvider({ now: () => now, fetch: async (input, init) => {
    dispatches++;
    await setImmediate();
    if (init?.method === "POST") {
      const requested = (JSON.parse(String(init.body)) as { addresses: string[] }).addresses;
      assert(requested.length <= 100);
      return Response.json(requested.map(id => {
        const index = many.findIndex((_node, i) => address(10_000 + i) === id);
        assert(index >= 0);
        return job(many[index], id);
      }).reverse());
    }
    const node = nodeFrom(input);
    discoveries.push(node);
    return Response.json(lookup(job(node, address(10_000 + many.indexOf(node)))));
  } });
  for (let window = 0; discoveries.length < many.length; window++) {
    assert(window <= 15, "201 cold hosts should populate within 16 budget windows");
    const before = dispatches;
    const [one, two] = await Promise.all([provider(many), provider([...many].reverse())]);
    assert.equal(new Set(discoveries).size, discoveries.length, "known jobs never need redundant host discovery");
    assert(dispatches - before <= 16);
    assert.deepEqual(one.hosts.map(row => row.address), many);
    assert.deepEqual(two.hosts.map(row => row.address), [...many].reverse());
    assert(one.hosts.every(row => !row.job || row.validUntilMs! > now));
    now += 30_000;
  }
  assert.deepEqual(discoveries, many);
});

test("known jobs batch in groups of at most 100 and match shuffled responses by identity", async () => {
  const many = Array.from({ length: 205 }, (_, i) => address(i + 1));
  const assignments = new Map(many.map((node, i) => [address(10_000 + i), job(node, address(10_000 + i))]));
  let now = baseTime;
  const batches: number[] = [];
  const provider = createJobProvider({ now: () => now, fetch: async (input, init) => {
    if (init?.method === "GET") {
      const node = nodeFrom(input);
      return Response.json(lookup(job(node, address(10_000 + many.indexOf(node)))));
    }
    const requested = (JSON.parse(String(init?.body)) as { addresses: string[] }).addresses;
    batches.push(requested.length);
    return Response.json(requested.map(id => assignments.get(id)!).reverse());
  } });
  // Discovery requires one query per host. Respect the public adapter's real local budget.
  for (let window = 0; window < 16; window++) {
    await provider(many);
    now += 30_000;
  }
  now += 120_000;
  batches.length = 0;
  const result = await provider(many);
  assert.deepEqual(batches, [100, 100, 5]);
  assert(result.hosts.every((record, i) => record.job?.address === address(10_000 + i) && !record.error));
});

test("unresolved hosts cannot starve the efficient refresh of known jobs", async () => {
  let now = baseTime;
  const dispatched: string[] = [];
  const provider = createJobProvider({ now: () => now, fetch: async (input, init) => {
    dispatched.push(init?.method ?? "GET");
    if (init?.method === "POST") return Response.json([job()]);
    return Response.json(nodeFrom(input) === host ? lookup(job()) : { jobs: [], totalJobs: 0 });
  } });
  await provider([host]);
  now += 120_000;
  dispatched.length = 0;
  const result = await provider([...Array.from({ length: 32 }, (_, i) => address(i + 2)), host]);
  assert.equal(dispatched[0], "GET", "first attempts precede already due maintenance");
  assert.equal(dispatched.at(-1), "POST", "fixed discovery cap leaves maintenance capacity");
  assert.equal(dispatched.length, 15);
  assert.equal(result.hosts.at(-1)?.checkedAtMs, now);
  assert.equal(result.hosts.at(-1)?.pending, false);
  assert(result.hosts.slice(0, -1).some(record => record.pending));
});

test("discovery reservation preserves known-clock refresh and invalid starts still retain previous timing", async () => {
  let now = baseTime;
  let malformed = false;
  const provider = createJobProvider({ now: () => now, fetch: async (input, init) => {
    if (init?.method === "POST") return Response.json([{ ...job(), timeStart: malformed ? null : 900 }]);
    return Response.json(nodeFrom(input) === host ? lookup(job()) : { jobs: [], totalJobs: 0 });
  } });
  await provider([host]);
  now += 120_000;
  await provider(Array.from({ length: 16 }, (_, i) => address(i + 2)));
  const delayed = (await provider([host])).hosts[0]!;
  assert.equal(delayed.pending, false);
  assert.equal(delayed.failedAtMs, null);
  assert.equal(delayed.retained, false);
  assert.equal(delayed.error, null);
  assert.equal(delayed.checkedAtMs, now);
  malformed = true;
  now += 120_000;
  const invalid = (await provider([host])).hosts[0]!;
  assert.equal(invalid.job?.timeStart, 900);
  assert.equal(invalid.retained, true);
  assert.equal(invalid.failedAtMs, now);
  assert.equal(invalid.checkedAtMs, baseTime + 120_000);
});

test("Retry-After pauses both assignment and batch reads without unattended retries", async () => {
  for (const retry of ["180", new Date(baseTime + 180_000).toUTCString()]) {
    let now = baseTime;
    let calls = 0;
    const provider = createJobProvider({ now: () => now, fetch: async (_input, init) => {
      calls++;
      if (calls === 1) return Response.json(lookup(job()));
      if (calls === 2) return new Response("", { status: 429, headers: { "Retry-After": retry } });
      return Response.json(init?.method === "GET" ? { jobs: [], totalJobs: 0 } : [job()]);
    } });
    await provider([host]);
    // Date retry is absolute; numeric retry starts when rejection is received.
    now += 120_000;
    const failed = (await provider([host])).hosts[0]!;
    const until = retry === "180" ? now + 180_000 : baseTime + 180_000;
    assert.equal(failed.retryAtMs, until);
    const waiting = (await provider([hosts[1]!])).hosts[0]!;
    assert.equal(waiting.pending, true);
    assert.equal(waiting.retryAtMs, until);
    assert.equal(calls, 2);
    now = until - 1;
    await provider(hosts.slice(0, 2));
    assert.equal(calls, 2);
    now++;
    await provider(hosts.slice(0, 2));
    assert.equal(calls, 4);
  }
});

test("shared next-refresh deadlines include cached empty results and pauses imposed by another host", async () => {
  let now = baseTime;
  const provider = createJobProvider({ now: () => now, fetch: async input => {
    if (nodeFrom(input) === host) return Response.json(lookup(job()));
    if (nodeFrom(input) === hosts[1]) return Response.json({ jobs: [], totalJobs: 0 });
    return new Response("", { status: 429, headers: { "Retry-After": "600" } });
  } });
  assert.equal((await provider([host])).nextRefreshAtMs, now + 120_000);
  assert.equal((await provider([hosts[1]!])).nextRefreshAtMs, now + 60_000);
  now += 10_000;
  await provider([hosts[2]!]);
  const cached = await provider(hosts.slice(0, 2));
  assert(cached.hosts.every(row => row.retryAtMs === null && !row.error));
  assert.equal(cached.nextRefreshAtMs, now + 600_000);
});

test("response size, malformed JSON and timeout failures stay bounded and sanitized", async () => {
  const cases: typeof fetch[] = [
    async () => new Response("{}", { headers: { "Content-Length": String(2 * 1024 * 1024 + 1) } }),
    async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
    async () => new Response("not JSON"),
    async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("internal abort detail")), { once: true });
    }),
  ];
  for (const fetch of cases) {
    const provider = createJobProvider({ now: () => baseTime, fetch, timeoutMs: 5 });
    const record = (await provider([host])).hosts[0]!;
    assert(record.error);
    assert(!record.error.includes("internal"));
    assert.equal(record.retryAtMs, baseTime + 60_000);
  }
});

test("invalid/duplicate inputs and empty lists never dispatch", async () => {
  let calls = 0;
  const provider = createJobProvider({ fetch: async () => { calls++; throw new Error("forbidden"); } });
  assert.deepEqual(await provider([]), { hosts: [], nextRefreshAtMs: null, waitReason: null, waitUntilMs: null });
  await assert.rejects(provider(["invalid"]), /validated/);
  await assert.rejects(provider([host, host]), /unique/);
  assert.equal(calls, 0);
});

test("successful State transitions request fresh assignments independently and honor failure/empty floors", async () => {
  let now = baseTime;
  let lookups = 0;
  const state = (value: string, retained = false): NodeInfoSnapshot => ({ hosts: [{
    address: host, values: { state: value, dl: null, ul: null, ping: null, networkUnavailableReason: null },
    fetchedAtMs: now, validUntilMs: now + 30_000, retained, error: null,
  }] });
  const provider = createJobProvider({ now: () => now, fetch: async (_input, init) => {
    assert.equal(init?.method, "GET");
    lookups++;
    return Response.json(lookups === 1 ? { jobs: [], totalJobs: 0 } : lookup(job()));
  } });
  await provider([host]);
  provider.observeStates!(state("QUEUED"));
  now += 20_000;
  provider.observeStates!(state("RUNNING_JOB", true));
  await provider([host]);
  assert.equal(lookups, 1);
  provider.observeStates!(state("RUNNING_JOB"));
  const hinted = (await provider([host])).hosts[0]!;
  assert.equal(hinted.pending, true);
  assert.equal(hinted.retryAtMs, baseTime + 60_000);
  assert.equal(hinted.failedAtMs, null);
  now += 39_999;
  await provider([host]);
  assert.equal(lookups, 1);
  now++;
  await provider([host]);
  assert.equal(lookups, 2);
  provider.observeStates!(state("QUEUED"));
  now += 60_000;
  provider.observeStates!(state("RUNNING_JOB"));
  await provider([host]);
  assert.equal(lookups, 3);
});

test("the first fresh running State revisits cached empty or failed assignments without repeating the hint", async () => {
  for (const empty of [true, false]) {
    let now = baseTime;
    let calls = 0;
    let running = false;
    const provider = createJobProvider({ now: () => now, fetch: async () => {
      calls++;
      return running ? Response.json(lookup(job())) : empty ? Response.json({ jobs: [], totalJobs: 0 })
        : new Response("", { status: 503 });
    } });
    for (const delay of [60_000, 120_000, 240_000, 480_000]) {
      assert.equal((await provider([host])).nextRefreshAtMs, now + delay);
      now += delay;
    }
    const beforeHint = await provider([host]);
    assert.equal(beforeHint.nextRefreshAtMs, now + 900_000);
    const lastLookupAt = now;
    const state = (retained = false): NodeInfoSnapshot => ({ hosts: [{ address: host,
      values: { state: "RUNNING_JOB", dl: null, ul: null, ping: null, networkUnavailableReason: null },
      fetchedAtMs: now, validUntilMs: now + 30_000, retained, error: null }] });
    now += 20_000;
    provider.observeStates!(state(true));
    assert.equal((await provider([host])).nextRefreshAtMs, beforeHint.nextRefreshAtMs,
      "retained State cannot invalidate an assignment lookup");
    provider.observeStates!(state());
    const hinted = await provider([host]);
    assert.equal(hinted.hosts[0]?.pending, true);
    assert.equal(hinted.hosts[0]?.job, null, "a State hint never invents timing");
    assert.equal(hinted.nextRefreshAtMs, lastLookupAt + 60_000);
    assert.equal(calls, 5, "the follow-up preview read honors the existing lookup floor");
    now = lastLookupAt + 60_000;
    const stillMissing = await provider([host]);
    assert.equal(stillMissing.hosts[0]?.job, null);
    assert.equal(calls, 6);
    now += 20_000;
    provider.observeStates!(state());
    const unchangedMissing = await provider([host]);
    assert.equal(unchangedMissing.hosts[0]?.pending, false);
    assert.equal(unchangedMissing.nextRefreshAtMs, stillMissing.nextRefreshAtMs);
    assert.equal(calls, 6, "repeated RUNNING_JOB snapshots must not reset empty or failed discovery");
    now = stillMissing.nextRefreshAtMs!;
    running = true;
    const recovered = await provider([host]);
    assert.equal(recovered.hosts[0]?.job?.address, jobAddress);
    assert.equal(calls, 7);
    now += 60_000;
    provider.observeStates!(state());
    const unchanged = await provider([host]);
    assert.equal(unchanged.hosts[0]?.pending, false);
    assert.equal(unchanged.nextRefreshAtMs, recovered.nextRefreshAtMs);
    assert.equal(calls, 7, "repeated RUNNING_JOB snapshots must not become repeated discovery hints");
  }
});

test("a first running State leaves verified timing on its known-job maintenance schedule", async () => {
  let now = baseTime;
  const methods: string[] = [];
  const provider = createJobProvider({ now: () => now, fetch: async (_input, init) => {
    methods.push(init!.method!);
    return Response.json(init?.method === "POST" ? [job()] : lookup(job()));
  } });
  await provider([host]);
  now += 60_000;
  provider.observeStates!({ hosts: [{ address: host,
    values: { state: "RUNNING_JOB", dl: null, ul: null, ping: null, networkUnavailableReason: null },
    fetchedAtMs: now, validUntilMs: now + 30_000, retained: false, error: null }] });
  const cached = await provider([host]);
  assert.equal(cached.hosts[0]?.pending, false);
  assert.equal(cached.nextRefreshAtMs, baseTime + 120_000);
  assert.deepEqual(methods, ["GET"]);
  now += 60_000;
  await provider([host]);
  assert.deepEqual(methods, ["GET", "POST"]);
});

test("first running State hints and follow-up reads cannot bypass Retry-After or discovery budgets", async () => {
  for (const pause of ["retry-after", "discovery-budget"] as const) {
    let now = baseTime;
    let calls = 0;
    let running = false;
    const provider = createJobProvider({ now: () => now, fetch: async input => {
      calls++;
      const node = nodeFrom(input);
      if (node === host) return Response.json(running ? lookup(job()) : { jobs: [], totalJobs: 0 });
      return pause === "retry-after" ? new Response("", { status: 429, headers: { "Retry-After": "600" } })
        : Response.json({ jobs: [], totalJobs: 0 });
    } });
    await provider([host]);
    now += 60_000;
    await provider(Array.from({ length: pause === "retry-after" ? 1 : 14 }, (_, index) => address(index + 100)));
    const callsBeforeHint = calls;
    const retryAt = now + (pause === "retry-after" ? 600_000 : 30_000);
    provider.observeStates!({ hosts: [{ address: host,
      values: { state: "RUNNING_JOB", dl: null, ul: null, ping: null, networkUnavailableReason: null },
      fetchedAtMs: now, validUntilMs: now + 30_000, retained: false, error: null }] });
    running = true;
    const waiting = await provider([host]);
    assert.equal(waiting.hosts[0]?.pending, true);
    assert.equal(waiting.waitReason, pause);
    assert.equal(waiting.nextRefreshAtMs, retryAt);
    assert.equal(calls, callsBeforeHint);
    now = retryAt - 1;
    await provider([host]);
    assert.equal(calls, callsBeforeHint);
    now++;
    assert.equal((await provider([host])).hosts[0]?.job?.address, jobAddress);
    assert.equal(calls, callsBeforeHint + 1);
  }
});

test("hinted rediscovery retains validated timing through invalid same-job and replacement starts", async () => {
  for (const start of [null, baseTime]) {
    let now = baseTime;
    let lookups = 0;
    let replacement = false;
    let validStart = false;
    const state = (value: string): NodeInfoSnapshot => ({ hosts: [{
      address: host, values: { state: value, dl: null, ul: null, ping: null, networkUnavailableReason: null },
      fetchedAtMs: now, validUntilMs: now + 30_000, retained: false, error: null,
    }] });
    const provider = createJobProvider({ now: () => now, fetch: async (_input, init) => {
      assert.equal(init?.method, "GET");
      return Response.json(lookup(lookups++ === 0 ? job() : {
        ...job(host, replacement ? address(1001) : jobAddress), timeStart: validStart ? now / 1000 - 10 : start,
      }));
    } });
    await provider([host]);
    provider.observeStates!(state("QUEUED"));
    now += 60_000;
    provider.observeStates!(state("RUNNING_JOB"));
    const failed = (await provider([host])).hosts[0]!;
    assert.equal(failed.job?.address, jobAddress);
    assert.equal(failed.job?.timeStart, 900);
    assert.equal(failed.retained, true);
    assert.equal(failed.failedAtMs, now);
    assert.equal(failed.checkedAtMs, baseTime);
    now += 60_000;
    assert.equal((await provider([host])).hosts[0]!.failedAtMs, failed.failedAtMs);
    now += 120_000;
    replacement = true;
    const invalidReplacement = (await provider([host])).hosts[0]!;
    assert.equal(invalidReplacement.job?.address, jobAddress);
    assert.equal(invalidReplacement.job?.timeStart, 900);
    assert.equal(invalidReplacement.checkedAtMs, baseTime);
    assert.equal(invalidReplacement.retained, true);
    now += 480_000;
    validStart = true;
    const replaced = (await provider([host])).hosts[0]!;
    assert.equal(replaced.job?.address, address(1001));
    assert.equal(replaced.job?.timeStart, now / 1000 - 10);
    assert.equal(replaced.retained, false);
    assert.equal(replaced.failedAtMs, null);
  }
});

function assertRollingLimits(dispatches: readonly number[]): void {
  for (const [window, maximum] of [[30_000, 16], [3_600_000, 400], [86_400_000, 2400]]) {
    let first = 0;
    for (let index = 0; index < dispatches.length; index++) {
      while (dispatches[first]! <= dispatches[index]! - window!) first++;
      assert(index - first + 1 <= maximum!, `exceeded ${maximum} requests in ${window}ms`);
    }
  }
}

test("86 and 200 hosts keep known clocks current for 48 hours despite empty and failing discovery", async () => {
  for (const [count, running] of [[86, 52], [200, 180]] as const) {
    const many = Array.from({ length: count }, (_, i) => address(i + 1));
    const assignments = new Map(many.slice(0, running).map((node, i) => [node, job(node, address(20_000 + i))]));
    const byID = new Map([...assignments.values()].map(value => [value.address, value]));
    let now = baseTime;
    const dispatches: number[] = [];
    const maintenance: number[] = [];
    const discoveries: number[] = [];
    let observedDiscoveryPause = false;
    let previous: JobSnapshot | undefined;
    const provider = createJobProvider({ now: () => now, fetch: async (input, init) => {
      dispatches.push(now);
      if (init?.method === "POST") {
        maintenance.push(now);
        const requested = (JSON.parse(String(init.body)) as { addresses: string[] }).addresses;
        assert(requested.length <= 100);
        return Response.json(requested.map(id => byID.get(id)!));
      }
      discoveries.push(now);
      const node = nodeFrom(input);
      const assigned = assignments.get(node);
      return assigned ? Response.json(lookup(assigned)) : many.indexOf(node) % 2
        ? Response.json({ jobs: [], totalJobs: 0 }) : new Response("", { status: 503 });
    } });
    // Faster browser reads and a reversed second viewer must not accelerate upstream maintenance.
    for (now = baseTime; now < baseTime + 2 * 86_400_000; now += 30_000) {
      assert(previous?.hosts.every(row => !row.job || now - row.checkedAtMs! <= 150_000 && row.validUntilMs! > now) ?? true,
        "clocks must retain freshness before the next request, with room for the eight-second timeout");
      const [one, two] = await Promise.all([provider(many), provider([...many].reverse())]);
      previous = one;
      assert.deepEqual(two.hosts, [...one.hosts].reverse());
      const known = one.hosts.filter(row => row.job);
      assert(known.every(row => !row.error && !row.retained && row.validUntilMs! > now),
        `known clocks expired at ${now - baseTime}ms for ${count} hosts`);
      if (now > baseTime + 900_000) assert.equal(known.length, running);
      if (one.waitReason === "discovery-budget") {
        observedDiscoveryPause = true;
        assert(one.waitUntilMs! > now);
        assert(one.nextRefreshAtMs! <= now + 120_000, "discovery cannot postpone maintenance eligibility");
      }
    }
    assert(observedDiscoveryPause);
    assertRollingLimits(dispatches);
    assert(discoveries.filter(at => at < baseTime + 86_400_000).length <= 900);
    assert(maintenance.filter(at => at >= baseTime + 86_400_000).length <= Math.ceil(running / 100) * 720);
  }
});

test("staggered 200-plus-8 rosters stay current beyond a day; removed rows are never collected", async () => {
  const many = Array.from({ length: 218 }, (_, i) => address(i + 1));
  const assignments = new Map(many.map((node, i) => [node, job(node, address(30_000 + i))]));
  const byID = new Map([...assignments.values()].map(value => [value.address, value]));
  let now = baseTime;
  const dispatches: number[] = [];
  const requestedNodes: string[] = [];
  const provider = createJobProvider({ now: () => now, fetch: async (input, init) => {
    dispatches.push(now);
    if (init?.method === "POST") {
      const requested = (JSON.parse(String(init.body)) as { addresses: string[] }).addresses;
      requestedNodes.push(...requested.map(id => byID.get(id)!.node));
      return Response.json(requested.map(id => byID.get(id)!));
    }
    const node = nodeFrom(input);
    requestedNodes.push(node);
    return Response.json(lookup(assignments.get(node)!));
  } });
  const primary = many.slice(0, 200);
  const secondary = many.slice(200, 208);
  let lastPrimary: JobSnapshot | undefined;
  let lastSecondary: JobSnapshot | undefined;
  for (now = baseTime; now < baseTime + 26 * 3_600_000; now += 30_000) {
    for (const previous of [lastPrimary, lastSecondary]) {
      assert(previous?.hosts.every(row => !row.job || now - row.checkedAtMs! <= 150_000 && row.validUntilMs! > now) ?? true);
    }
    const current = await provider(primary);
    lastPrimary = current;
    // The separate small roster has a different cadence and never joins the primary request.
    if ((now - baseTime) % 60_000 === 30_000) lastSecondary = await provider(secondary);
    for (const snapshot of [current, lastSecondary]) {
      assert(snapshot?.hosts.every(row => !row.job || !row.error && row.validUntilMs! > now) ?? true);
    }
    if (now > baseTime + 900_000) {
      assert.equal(current.hosts.filter(row => row.job).length, 200);
      assert.equal(lastSecondary?.hosts.filter(row => row.job).length, 8);
    }
  }
  const removed = new Set(primary.slice(180));
  const reduced = primary.slice(0, 180);
  for (let step = 0; step < 12; step++, now += 30_000) {
    requestedNodes.length = 0;
    const [one, two] = await Promise.all([provider(reduced), provider(secondary)]);
    assert([...one.hosts, ...two.hosts].every(row => row.job && !row.error && row.validUntilMs! > now));
    assert(requestedNodes.every(node => !removed.has(node)), "removed hosts must not piggyback maintenance");
  }
  assertRollingLimits(dispatches);
});

test("switching rosters after hours of repeated discovery still populates first-time hosts", async () => {
  for (const [count, running, joiningCount] of [[86, 52, 8], [200, 180, 8], [86, 52, 200]] as const) {
    const primary = Array.from({ length: count }, (_, i) => address(i + 1));
    const joining = Array.from({ length: joiningCount }, (_, i) => address(count + i + 1));
    const assignments = new Map([...primary.slice(0, running), ...joining]
      .map((node, i) => [node, job(node, address(50_000 + i))]));
    const byID = new Map([...assignments.values()].map(value => [value.address, value]));
    let now = baseTime;
    let discoveries = 0;
    const dispatches: number[] = [];
    const requestedNodes: string[] = [];
    const provider = createJobProvider({ now: () => now, fetch: async (input, init) => {
      dispatches.push(now);
      if (init?.method === "POST") {
        const requested = (JSON.parse(String(init.body)) as { addresses: string[] }).addresses;
        requestedNodes.push(...requested.map(id => byID.get(id)!.node));
        return Response.json(requested.map(id => byID.get(id)!));
      }
      discoveries++;
      const node = nodeFrom(input);
      requestedNodes.push(node);
      return assignments.has(node) ? Response.json(lookup(assignments.get(node)!))
        : primary.indexOf(node) % 2 ? Response.json({ jobs: [], totalJobs: 0 }) : new Response("", { status: 503 });
    } });
    for (; now < baseTime + 8 * 3_600_000; now += 30_000) {
      const current = await provider(primary);
      assert(current.hosts.every(row => !row.job || !row.error && row.validUntilMs! > now));
    }
    assert(discoveries >= 600, "exercise sustained discovery pressure before switching");
    const switchedAt = now;
    requestedNodes.length = 0;
    let current = await provider(joining);
    while (current.hosts.some(row => !row.job)) {
      const next = current.nextRefreshAtMs!;
      assert(next > now && next <= now + 180_000,
        `first lookups must not inherit an hours-long repeat/admission pause (${count} -> ${joiningCount})`);
      now = next;
      assert(now <= switchedAt + 15 * 60_000, "new roster must populate within bounded cold discovery windows");
      current = await provider(joining);
    }
    assert(current.hosts.every(row => !row.error && !row.retained && row.validUntilMs! > now));
    assert(requestedNodes.every(node => joining.includes(node)), "switching must not collect the old roster");
    assert(discoveries <= 900, "first-look reservation is inside the unchanged daily discovery allowance");
    for (let cycle = 0; cycle < 30; cycle++) {
      now = current.nextRefreshAtMs!;
      assert(current.hosts.every(row => row.validUntilMs! > now));
      current = await provider(joining);
      assert(current.hosts.every(row => row.job && !row.error && row.validUntilMs! > now));
    }
    assertRollingLimits(dispatches);
  }
});

test("new viewers use protected first-attempt capacity after heavy discovery", async () => {
  const many = Array.from({ length: 208 }, (_, i) => address(i + 1));
  const primary = many.slice(0, 200);
  const joining = many.slice(200);
  const assignments = new Map(many.filter((_node, i) => i < 180 || i >= 200)
    .map(node => [node, job(node, address(40_000 + many.indexOf(node)))]));
  const byID = new Map([...assignments.values()].map(value => [value.address, value]));
  let now = baseTime;
  let discoveries = 0;
  let joinedReads = 0;
  const dispatches: number[] = [];
  const provider = createJobProvider({ now: () => now, fetch: async (input, init) => {
    dispatches.push(now);
    if (init?.method === "POST") {
      const requested = (JSON.parse(String(init.body)) as { addresses: string[] }).addresses;
      return Response.json(requested.map(id => byID.get(id)!));
    }
    discoveries++;
    const node = nodeFrom(input);
    if (joining.includes(node)) joinedReads++;
    return Response.json(assignments.has(node) ? lookup(assignments.get(node)!) : { jobs: [], totalJobs: 0 });
  } });
  for (; discoveries < 650; now += 30_000) {
    assert(now < baseTime + 86_400_000);
    const current = await provider(primary);
    assert(current.hosts.every(row => !row.job || row.validUntilMs! > now));
  }
  const admitted = await provider(joining);
  assert.equal(joinedReads, 8, "unseen hosts retain first-attempt capacity after repeated discovery");
  assert(admitted.hosts.every(row => !row.pending && row.job !== null));
  for (let step = 0; step < 120; step++, now += 30_000) {
    const current = await provider(primary);
    assert.equal(current.hosts.filter(row => row.job).length, 180);
    assert(current.hosts.every(row => !row.job || !row.error && row.validUntilMs! > now));
  }
  assertRollingLimits(dispatches);
});

test("adaptive empty and failure backoff resets on success; verified State hints honor shared floors", async () => {
  for (const empty of [true, false]) {
    let now = baseTime;
    let running = false;
    let calls = 0;
    const provider = createJobProvider({ now: () => now, fetch: async () => {
      calls++;
      return running ? Response.json(lookup(job())) : empty ? Response.json({ jobs: [], totalJobs: 0 })
        : new Response("", { status: 503 });
    } });
    for (const delay of [60_000, 120_000, 240_000, 480_000, 900_000, 900_000]) {
      const record = await provider([host]);
      assert.equal(record.nextRefreshAtMs, now + delay);
      now += delay;
    }
    const state = (value: string): NodeInfoSnapshot => ({ hosts: [{ address: host,
      values: { state: value, dl: null, ul: null, ping: null, networkUnavailableReason: null },
      fetchedAtMs: now, validUntilMs: now + 30_000, retained: false, error: null }] });
    await provider([host]);
    provider.observeStates!(state("QUEUED"));
    now += 20_000;
    provider.observeStates!(state("RUNNING_JOB"));
    running = true;
    const before = calls;
    assert.equal((await provider([host])).nextRefreshAtMs, now + 40_000);
    assert.equal(calls, before);
    now += 40_000;
    const recovered = await provider([host]);
    assert.equal(recovered.hosts[0]?.job?.address, jobAddress);
    assert.equal(recovered.nextRefreshAtMs, now + 120_000);
  }
});

test("global hourly and daily ceilings still stop excessive independent maintenance cohorts", async () => {
  const many = Array.from({ length: 16 }, (_, i) => address(i + 1));
  const assignments = many.map((node, i) => job(node, address(50_000 + i)));
  let now = baseTime;
  const dispatches: number[] = [];
  const provider = createJobProvider({ now: () => now, fetch: async (input, init) => {
    dispatches.push(now);
    if (init?.method === "POST") {
      const requested = (JSON.parse(String(init.body)) as { addresses: string[] }).addresses;
      return Response.json(assignments.filter(value => requested.includes(value.address)));
    }
    return Response.json(lookup(assignments.find(value => value.node === nodeFrom(input))!));
  } });
  await provider(many);
  now += 30_000;
  await provider(many);
  // Sixteen separate singleton views cannot share batch requests. This intentionally
  // exceeds the supported maintenance capacity and must stop at the global ceiling.
  let sawHourlyPause = false;
  for (now = baseTime + 120_000; now < baseTime + 7 * 3_600_000; now += 120_000) {
    for (const node of many) {
      const snapshot = await provider([node]);
      if (snapshot.waitReason === "local-budget" && snapshot.waitUntilMs! < baseTime + 86_400_000) sawHourlyPause = true;
      if (snapshot.waitReason === "local-budget" && snapshot.hosts[0]?.pending) {
        assert.equal(snapshot.hosts[0].retryAtMs, snapshot.nextRefreshAtMs,
          "known-job maintenance must report its own retry, not a stricter discovery deadline");
      }
    }
  }
  assert(sawHourlyPause);
  assert.equal(dispatches.length, 2400);
  const exhausted = await provider([many[0]!]);
  assert.equal(exhausted.waitReason, "local-budget");
  assert.equal(exhausted.waitUntilMs, baseTime + 86_400_000);
  assert.equal(exhausted.nextRefreshAtMs, exhausted.waitUntilMs);
  assert.equal(exhausted.hosts[0]?.pending, true);
  assert(exhausted.hosts[0]!.validUntilMs! < now);
  now = baseTime + 86_400_000;
  const recovered = await provider([many[0]!]);
  assert.equal(dispatches.length, 2401);
  assert.equal(recovered.hosts[0]?.checkedAtMs, now);
  assert.equal(recovered.waitReason, null);
  assertRollingLimits(dispatches);
});

test("a State hint cannot remove a known job from reserved maintenance while discovery is exhausted", async () => {
  for (const outcome of ["running", "ended", "missing", "moved"] as const) {
    let now = baseTime;
    let discoveryCalls = 0;
    let hostLookups = 0;
    let replacement = false;
    let batchOutcome: typeof outcome = "running";
    const provider = createJobProvider({ now: () => now, fetch: async (input, init) => {
      if (init?.method === "POST") {
        if (batchOutcome === "missing") return Response.json([]);
        if (batchOutcome === "ended") return Response.json([{ ...job(), state: 2, timeEnd: 1000 }]);
        if (batchOutcome === "moved") return Response.json([job(hosts[1])]);
        return Response.json([job()]);
      }
      discoveryCalls++;
      if (nodeFrom(input) === host) {
        hostLookups++;
        return Response.json(lookup(job(host, replacement ? address(60_000) : jobAddress)));
      }
      return Response.json({ jobs: [], totalJobs: 0 });
    } });
    await provider([host]);
    // The existing identity survives a long hidden interval; use the next day for
    // isolated discovery pressure so cold-start lookup does not split a quota window.
    const budgetStart = baseTime + 86_400_000;
    let nextHost = 100;
    for (let hour = 0; hour < 3 && discoveryCalls < 901; hour++) {
      for (let block = 0; block < 24 && discoveryCalls < 901; block++) {
        now = budgetStart + hour * 3_600_000 + block * 30_000;
        await provider(Array.from({ length: Math.min(14, 901 - discoveryCalls) }, () => address(nextHost++)));
      }
    }
    assert.equal(discoveryCalls, 901);
    // Restore the existing clock using its reserved batch allowance, then observe a
    // fresh State transition while host-assignment discovery has no remaining quota.
    await provider([host]);
    const state = (value: string): NodeInfoSnapshot => ({ hosts: [{ address: host,
      values: { state: value, dl: null, ul: null, ping: null, networkUnavailableReason: null },
      fetchedAtMs: now, validUntilMs: now + 30_000, retained: false, error: null }] });
    provider.observeStates!(state("QUEUED"));
    provider.observeStates!(state("RUNNING_JOB"));
    const hinted = await provider([host]);
    assert.equal(hinted.waitReason, "discovery-budget");
    assert.equal(hinted.hosts[0]?.pending, true);
    const lookupDeadline = hinted.hosts[0]!.retryAtMs!;
    let previous = hinted;
    for (let cycle = 0; cycle < 12; cycle++) {
      now += 120_000;
      assert(now - previous.hosts[0]!.checkedAtMs! <= 150_000 && previous.hosts[0]!.validUntilMs! > now);
      const current = await provider([host]);
      previous = current;
      assert.equal(current.hosts[0]?.job?.address, jobAddress);
      assert.equal(current.hosts[0]?.checkedAtMs, now);
      assert.equal(current.hosts[0]?.retained, false);
      assert.equal(current.hosts[0]?.error, null);
      assert.equal(current.hosts[0]?.pending, true, "known-job validation must preserve the assignment hint");
      assert.equal(current.hosts[0]?.retryAtMs, lookupDeadline);
      assert.equal(current.nextRefreshAtMs, now + 120_000);
      assert.equal(discoveryCalls, 901);
    }
    batchOutcome = outcome;
    now += 120_000;
    const observed = (await provider([host])).hosts[0]!;
    if (outcome === "ended") {
      assert.equal(observed.job, null);
      assert.equal(observed.pending, true);
    } else if (outcome === "missing" || outcome === "moved") {
      assert.equal(observed.job?.address, jobAddress);
      assert.equal(observed.retained, true);
      assert(observed.error);
      assert.equal(observed.failedAtMs, now);
      assert(observed.checkedAtMs! < now);
    } else {
      replacement = true;
      now = lookupDeadline;
      const replaced = (await provider([host])).hosts[0]!;
      assert.equal(replaced.job?.address, address(60_000));
      assert.equal(replaced.pending, false);
      assert.equal(hostLookups, 2, "the pending hint must still cause discovery when its allowance returns");
    }
  }
});
