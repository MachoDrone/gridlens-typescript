import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createMarketQueueProvider } from "../scripts/market-queue.ts";
import { createNodeActivityProvider } from "../scripts/node-activity.ts";

const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const address = (index: number): string => "1".repeat(30) + alphabet[Math.floor(index / 58)] + alphabet[index % 58];
const markets = Array.from({ length: 110 }, (_, index) => address(index + 300));
const host = address(2);
const base = 1_000_000;

test("shared queue slots dispatch late first markets before routine repeats, then fresh transitions and oldest eligibility", async () => {
  let time = base;
  const order: string[] = [];
  const releases: (() => void)[] = [];
  const [routine, transition, blockerA, blockerB, cold] = markets as [string, string, string, string, string];
  let hold = false;
  const provider = createMarketQueueProvider({ now: () => time,
    activityPriority: market => market === transition ? 0 : 2, fetch: async input => {
      const market = new URL(String(input)).pathname.split("/").at(-1)!;
      order.push(market);
      if (hold && (market === blockerA || market === blockerB)) await new Promise<void>(resolve => releases.push(resolve));
      return Response.json({ address: market, queueType: 255, nodesInQueue: 0, jobsInQueue: 0, queue: [], updatedAt: 0 });
    } });
  await Promise.all([provider(routine), provider(transition)]);
  time += 15_000;
  order.length = 0;
  hold = true;
  const blockers = [provider(blockerA), provider(blockerB)];
  await setImmediate();
  const repeated = [provider(routine), provider(transition)];
  const newcomer = provider(cold);
  await setImmediate();
  releases.forEach(release => release());
  await Promise.all([...blockers, ...repeated, newcomer]);
  assert.deepEqual(order, [blockerA, blockerB, cold, transition, routine]);

  // A ten-second freshness margin overrides the same transition preference.
  time += 20_000;
  order.length = 0;
  await Promise.all([provider(routine), provider(transition)]);
  assert.deepEqual(order, [routine, transition]);
});

test("101 distinct watched queues complete their entire initial pass before repeating expired earlier markets", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: base });
  const order: string[] = [];
  const provider = createMarketQueueProvider({ fetch: async (input, init) => {
    const market = new URL(String(input)).pathname.split("/").at(-1)!;
    order.push(market);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 800);
      init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
    });
    return Response.json({ address: market, queueType: 255, nodesInQueue: 0, jobsInQueue: 0, queue: [], updatedAt: 0 });
  } });
  const controller = new AbortController();
  const read = provider.watch!(markets.slice(0, 101), controller.signal, () => {});
  const canceled = assert.rejects(read, { name: "AbortError" });
  try {
    for (let step = 0; step < 53; step++) { await setImmediate(); t.mock.timers.tick(800); }
    await setImmediate();
    assert.deepEqual(order.slice(0, 101), markets.slice(0, 101));
    assert(order.length > 101, "eligible maintenance resumes after initial pass");
  } finally { controller.abort(); await canceled; }
});

test("running-membership requests share first-market priority across independent callers", async () => {
  let time = base;
  const order: string[] = [];
  const releases: (() => void)[] = [];
  let hold = false;
  const [old, blockerA, blockerB, cold] = markets as [string, string, string, string];
  const provider = createNodeActivityProvider({ now: () => time,
    marketQueueProvider: async market => ({ marketAddress: market, queueType: 255, queue: [],
      checkedAtMs: time, validUntilMs: time + 30_000, sourceUpdatedAtMs: 0, retained: false, error: null }),
    fetch: async input => {
      const market = new URL(String(input)).searchParams.get("market")!;
      order.push(market);
      if (hold && (market === blockerA || market === blockerB)) await new Promise<void>(resolve => releases.push(resolve));
      return Response.json([host]);
    } });
  const read = (marketAddress: string) => provider([{ address: host, marketAddress }]);
  await read(old);
  time += 15_000;
  order.length = 0;
  hold = true;
  const active = [read(blockerA), read(blockerB)];
  await setImmediate();
  const repeat = read(old);
  const newcomer = read(cold);
  await setImmediate();
  releases.forEach(release => release());
  await Promise.all([...active, repeat, newcomer]);
  assert.deepEqual(order, [blockerA, blockerB, cold, old]);
});

for (const kind of ["queue", "activity"] as const) {
  test(`${kind} retries an initial failed market under sustained overdue successful demand`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: base });
    const selected = markets.slice(0, 101);
    const failedMarket = selected[0]!;
    const attempts = new Map<string, number>();
    const failedStarts: number[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const market = kind === "queue" ? url.pathname.split("/").at(-1)! : url.searchParams.get("market")!;
      const attempt = (attempts.get(market) ?? 0) + 1;
      attempts.set(market, attempt);
      if (market === failedMarket) failedStarts.push(Date.now());
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 800);
        init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
      });
      if (market === failedMarket && attempt === 1) return new Response("", { status: 503 });
      return kind === "queue" ? Response.json({ address: market, queueType: 255,
        nodesInQueue: 0, jobsInQueue: 0, queue: [], updatedAt: 0 }) : Response.json([host]);
    };
    const controller = new AbortController();
    const read = kind === "queue"
      ? createMarketQueueProvider({ fetch: fetcher }).watch!(selected, controller.signal, () => {})
      : createNodeActivityProvider({ fetch: fetcher,
        marketQueueProvider: async market => ({ marketAddress: market, queueType: 255, queue: [],
          checkedAtMs: Date.now(), validUntilMs: Date.now() + 30_000, sourceUpdatedAtMs: 0,
          retained: false, error: null }),
      }).watch!(selected.map((marketAddress, index) => ({ address: address(index + 600), marketAddress })),
        controller.signal, () => {});
    const canceled = assert.rejects(read, { name: "AbortError" });
    try {
      await setImmediate();
      for (let elapsed = 0; elapsed < 180_000; elapsed += 800) {
        t.mock.timers.tick(800);
        await setImmediate();
      }
      assert([...attempts].filter(([market]) => market !== failedMarket).every(([, count]) => count >= 4),
        "the successful cohort deliberately remains continuously overdue");
      assert(failedStarts.length >= 2, "an initial failure must eventually recover despite overdue positive evidence");
      assert(failedStarts[1]! >= base + 60_800, "priority must not shorten the original failure backoff");
    } finally { controller.abort(); await canceled; }
  });
}
