import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createJobProvider } from "../scripts/jobs.ts";

function address(value: number): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let encoded = "";
  for (let n = value; n; n = Math.floor(n / 58)) encoded = alphabet[n % 58]! + encoded;
  return "1".repeat(32 - Math.ceil(Math.log2(value + 1) / 8)) + encoded;
}
const baseTime = 1_000_000;
const hostFrom = (input: Parameters<typeof fetch>[0]): string => new URL(String(input)).searchParams.get("node")!;
const job = (node: string, id: string) => ({ address: id, node, state: 1, timeStart: 900, timeEnd: 0, timeout: 600 });
const lookup = (value: unknown) => ({ jobs: [value], totalJobs: 1 });
function deferred(): { promise: Promise<Response>; resolve: (value: Response) => void } {
  let resolve!: (value: Response) => void;
  return { promise: new Promise(done => { resolve = done; }), resolve };
}

for (const size of [99, 100, 101, 200, 201, 300, 301, 500, 1_000]) {
  test(`${size} arbitrary hosts finish their initial attempts across real budget windows`, async () => {
    const roster = Array.from({ length: size }, (_, i) => address(i + 1));
    let now = baseTime;
    const attempted: string[] = [];
    const dispatches: number[] = [];
    const provider = createJobProvider({ now: () => now, fetch: async input => {
      const host = hostFrom(input);
      attempted.push(host);
      dispatches.push(now);
      // An actual failure is an attempt too; it cannot pin the first-pass lane.
      return roster.indexOf(host) % 3 === 0 ? new Response("", { status: 503 })
        : Response.json({ jobs: [], totalJobs: 0 });
    } });
    let turns = 0;
    while (new Set(attempted).size < size) {
      const snapshot = await provider(roster);
      const firstPass = Math.min(attempted.length, size);
      assert.deepEqual(attempted.slice(0, firstPass), roster.slice(0, firstPass));
      assert.equal(dispatches[0], baseTime, "large rosters cannot manufacture zero initial admission");
      if (new Set(attempted).size === size) break;
      const retryAt = snapshot.nextRefreshAtMs!;
      assert(retryAt > now, "budget deferral reports a future authoritative deadline");
      assert(snapshot.hosts.filter(row => row.checkedAtMs === null && row.failedAtMs === null)
        .every(row => row.pending && row.retryAtMs! >= retryAt));
      now = retryAt;
      assert(++turns < 100, "first population must progress through finite quota rollovers");
    }
    assert.equal(new Set(attempted.slice(0, size)).size, size);
    const completionMs = now - baseTime;
    const expectedMs = size <= 336 ? Math.floor((size - 1) / 14) * 30_000
      : size <= 672 ? 3_600_000 + Math.floor((size - 337) / 14) * 30_000
      : 86_400_000 + Math.floor((size - 901) / 14) * 30_000;
    assert.equal(completionMs, expectedMs);
    for (const [count, window] of [[14, 30_000], [336, 3_600_000], [900, 86_400_000]]) {
      for (let right = 0, left = 0; right < dispatches.length; right++) {
        while (dispatches[left]! <= dispatches[right]! - window!) left++;
        assert(right - left + 1 <= count!);
      }
    }
  });
}

test("new viewers' initial reads preempt maintenance queued by an existing viewer", async () => {
  const roster = Array.from({ length: 205 }, (_, i) => address(i + 1));
  const joining = [address(500), address(501)];
  const all = [...roster, ...joining];
  const jobs = all.map((host, i) => job(host, address(10_000 + i)));
  let now = baseTime;
  let hold = false;
  const held: { response: ReturnType<typeof deferred>; payload: typeof jobs }[] = [];
  const sequence: string[] = [];
  const provider = createJobProvider({ now: () => now, fetch: async (input, init) => {
    if (init?.method === "POST") {
      const requested = (JSON.parse(String(init.body)) as { addresses: string[] }).addresses;
      assert(requested.length <= 100);
      const payload = jobs.filter(value => requested.includes(value.address));
      sequence.push("batch");
      if (hold && held.length < 2) {
        const response = deferred();
        held.push({ response, payload });
        return response.promise;
      }
      return Response.json(payload);
    }
    const host = hostFrom(input);
    sequence.push(host);
    return Response.json(lookup(jobs.find(value => value.node === host)!));
  } });
  for (let turn = 0; turn < 15; turn++, now += 30_000) await provider(roster);
  now += 120_000;
  hold = true;
  sequence.length = 0;
  const existing = provider(roster);
  await setImmediate();
  assert.equal(held.length, 2);
  const newViewer = provider(joining);
  await setImmediate();
  held[0]!.response.resolve(Response.json(held[0]!.payload));
  await setImmediate();
  assert.deepEqual(sequence.slice(0, 4), ["batch", "batch", ...joining]);
  held[1]!.response.resolve(Response.json(held[1]!.payload));
  const [existingResult, newResult] = await Promise.all([existing, newViewer]);
  assert(existingResult.hosts.every(row => row.checkedAtMs === now));
  assert(newResult.hosts.every(row => row.job && row.checkedAtMs === now));
  assert.equal(sequence.at(-1), "batch");
});

test("overdue known jobs rotate by original evidence above available short-window capacity", async () => {
  const roster = Array.from({ length: 301 }, (_, i) => address(i + 1));
  const jobs = roster.map((host, i) => job(host, address(10_000 + i)));
  let now = baseTime;
  const batches: string[][] = [];
  const provider = createJobProvider({ now: () => now, fetch: async (input, init) => {
    if (init?.method === "POST") {
      const requested = (JSON.parse(String(init.body)) as { addresses: string[] }).addresses;
      assert(requested.length <= 100);
      batches.push(requested);
      return Response.json(jobs.filter(value => requested.includes(value.address)));
    }
    const known = jobs.find(value => value.node === hostFrom(input));
    return Response.json(known ? lookup(known) : { jobs: [], totalJobs: 0 });
  } });
  for (let turn = 0; turn < 22; turn++, now += 30_000) await provider(roster);
  now += 120_000;
  await provider(Array.from({ length: 14 }, (_, i) => address(1_000 + i)));
  batches.length = 0;
  const limited = await provider([...roster].reverse());
  assert.equal(batches.length, 2);
  assert.equal(limited.hosts.filter(row => row.checkedAtMs === now).length, 200);
  const overdue = limited.hosts.filter(row => row.checkedAtMs! < now).map(row => row.job!.address);
  assert.equal(overdue.length, 101);
  now += 30_000;
  batches.length = 0;
  await provider(roster);
  assert.deepEqual(new Set(batches[0]), new Set(overdue.slice().sort((one, two) => {
    const a = limited.hosts.find(row => row.job?.address === one)!;
    const b = limited.hosts.find(row => row.job?.address === two)!;
    return a.checkedAtMs! - b.checkedAtMs! || roster.indexOf(a.address) - roster.indexOf(b.address);
  }).slice(0, 100)));
  assert(overdue.every(id => batches.flat().includes(id)), "unrefreshed clocks take the next turns");
});

test("eligible repeated discovery respects failed evidence and aging ahead of activity hints", async () => {
  for (const nearExpiry of [false, true]) {
    const old = [address(1), address(2)];
    const transitioning = address(3);
    const earlyJob = address(4);
    const blocking = [address(5), address(6)];
    let now = baseTime;
    const held: ReturnType<typeof deferred>[] = [];
    const calls: string[] = [];
    const provider = createJobProvider({ now: () => now,
      activityPriority: host => host === transitioning ? 0 : host === earlyJob ? 1 : 2,
      fetch: async input => {
        const host = hostFrom(input);
        calls.push(host);
        if (blocking.includes(host)) {
          const response = deferred();
          held.push(response);
          return response.promise;
        }
        if (host === old[1]) return new Response("", { status: 503 });
        return Response.json({ jobs: [], totalJobs: 0 });
      } });
    await provider(old);
    now += 30_000;
    await provider([transitioning, earlyJob]);
    now = baseTime + (nearExpiry ? 170_000 : 90_000);
    calls.length = 0;
    const occupied = provider(blocking);
    await setImmediate();
    const refresh = provider([...old, earlyJob, transitioning]);
    await setImmediate();
    held[0]!.resolve(Response.json({ jobs: [], totalJobs: 0 }));
    await setImmediate();
    assert.deepEqual(calls.slice(2), nearExpiry ? [...old, transitioning, earlyJob]
      : [old[1], transitioning, earlyJob, old[0]]);
    held[1]!.resolve(Response.json({ jobs: [], totalJobs: 0 }));
    await Promise.all([occupied, refresh]);
  }
});

test("fresh due maintenance favors activity transitions while overdue batches use oldest evidence", async () => {
  for (const nearExpiry of [false, true]) {
    const roster = Array.from({ length: 205 }, (_, i) => address(i + 1));
    const jobs = roster.map((host, i) => job(host, address(10_000 + i)));
    let now = baseTime;
    let hints = false;
    const batches: string[][] = [];
    const provider = createJobProvider({ now: () => now,
      activityPriority: host => hints && host === roster.at(-1) ? 0 : 2,
      fetch: async (input, init) => {
        if (init?.method === "POST") {
          const requested = (JSON.parse(String(init.body)) as { addresses: string[] }).addresses;
          batches.push(requested);
          return Response.json(jobs.filter(value => requested.includes(value.address)));
        }
        return Response.json(lookup(jobs.find(value => value.node === hostFrom(input))!));
      } });
    for (let turn = 0; turn < 15; turn++, now += 30_000) await provider(roster);
    now += 120_000;
    const aligned = await provider(roster);
    assert(aligned.hosts.every(row => row.checkedAtMs === now));
    now += nearExpiry ? 170_000 : 120_000;
    hints = true;
    batches.length = 0;
    await provider([...roster].reverse());
    assert.equal(batches[0]![0], nearExpiry ? jobs[0]!.address : jobs.at(-1)!.address);
    assert.equal(batches[0]!.includes(jobs.at(-1)!.address), !nearExpiry);
  }
});
