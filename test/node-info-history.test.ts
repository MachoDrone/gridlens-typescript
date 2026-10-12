import assert from "node:assert/strict";
import { test } from "node:test";
import { createNodeInfoProvider } from "../scripts/node-info.ts";
import type { NodeInfoRecord } from "../src/fleet/node-info.ts";

const host = "1".repeat(31) + "2";
const other = "1".repeat(31) + "3";
const base = Date.UTC(2026, 9, 8, 12);

test("a confirmed Offline result survives an inconclusive check and viewer rejoin before a success replaces it", async () => {
  let now = base;
  let phase: "offline" | "inconclusive" | "online" = "offline";
  let requests = 0;
  const provider = createNodeInfoProvider({ now: () => now, fetch: async () => {
    requests++;
    if (phase === "offline") return new Response("", { status: 503 });
    if (phase === "inconclusive") return new Response("", { status: 504 });
    return Response.json({ node: host, state: "OTHER" });
  } });
  const first = (await provider([host])).hosts[0]!;
  assert.equal(first.apiCheck?.lastConfirmed, undefined);
  now += 1000;
  const confirmed = (await provider([host])).hosts[0]!;
  const history = { status: "offline" as const, checkedAtMs: now, firstFailedAtMs: base, httpStatus: 503, nextCheckAtMs: now + 120_000 };
  assert.deepEqual(confirmed.apiCheck?.lastConfirmed, history);
  assert.equal(confirmed.apiCheck?.status, "offline");
  assert.equal(confirmed.apiCheck?.nextCheckAtMs, history.nextCheckAtMs);
  assert.equal(provider.nextRefreshAt!([host]), history.nextCheckAtMs);
  assert.equal(confirmed.fetchedAtMs, null);

  // Both finite snapshots and later subscriber replay must own their copies.
  Object.assign(confirmed.apiCheck!.lastConfirmed!, { status: "online", checkedAtMs: now + 999_999 });
  assert.deepEqual((await provider([host])).hosts[0]?.apiCheck?.lastConfirmed, history);

  now = provider.nextRefreshAt!([host])!;
  phase = "inconclusive";
  const uncertain = (await provider([host])).hosts[0]!;
  assert.equal(uncertain.apiCheck?.status, "other");
  assert.equal(uncertain.apiCheck?.checkedAtMs, now);
  assert.equal(uncertain.apiCheck?.nextCheckAtMs, undefined);
  assert.deepEqual(uncertain.apiCheck?.lastConfirmed, history);
  assert.equal(uncertain.fetchedAtMs, null);
  const beforeJoinRequests = requests;
  const controller = new AbortController();
  const updates: NodeInfoRecord[] = [];
  const joined = provider.watch!([host], controller.signal, update => updates.push(...update.hosts)).catch(() => {});
  assert.deepEqual(updates[0]?.apiCheck?.lastConfirmed, history);
  updates[0]!.apiCheck!.lastConfirmed!.checkedAtMs = now;
  assert.deepEqual((await provider([host])).hosts[0]?.apiCheck?.lastConfirmed, history);
  assert.equal(requests, beforeJoinRequests, "rejoining may not recheck or refresh historical timestamps");
  controller.abort();
  await joined;

  now = provider.nextRefreshAt!([host])!;
  phase = "online";
  const recovered = (await provider([host])).hosts[0]!;
  assert.equal(recovered.values?.state, "OTHER");
  assert.equal(recovered.apiCheck?.status, "online");
  assert.equal(recovered.apiCheck?.nextCheckAtMs, undefined);
  assert.deepEqual(recovered.apiCheck?.lastConfirmed, { status: "online", checkedAtMs: now });
  assert.equal(recovered.fetchedAtMs, now);
  assert.deepEqual(Object.keys(recovered.apiCheck!.lastConfirmed!).sort(), ["checkedAtMs", "status"]);
});

test("a shared provider deferral preserves the confirmed result and every original outcome timestamp", async () => {
  let now = base;
  let requests = 0;
  const provider = createNodeInfoProvider({ now: () => now, fetch: async input => {
    requests++;
    return String(input).includes(other)
      ? new Response("", { status: 429, headers: { "Retry-After": "600" } })
      : new Response("", { status: 503 });
  } });
  await provider([host]);
  now += 1000;
  const original = (await provider([host])).hosts[0]!;
  await provider([other]);
  now += 120_000;
  assert.deepEqual((await provider([host])).hosts[0], original);
  assert(provider.nextRefreshAt!([host])! > original.apiCheck!.nextCheckAtMs!,
    "a later shared pause can defer requests without rewriting an older result's plan");
  assert.equal(requests, 3);
});

test("a confirmed Offline plan records its actual Retry-After deadline and cached reads cannot roll it forward", async () => {
  let now = base;
  let requests = 0;
  const provider = createNodeInfoProvider({ now: () => now, fetch: async () => {
    requests++;
    return new Response("", { status: 503, ...(requests === 2 ? { headers: { "Retry-After": "600" } } : {}) });
  } });
  await provider([host]);
  now += 1000;
  const original = (await provider([host])).hosts[0]!;
  const planned = now + 600_000;
  assert.equal(original.apiCheck?.nextCheckAtMs, planned);
  assert.equal(original.apiCheck?.lastConfirmed?.nextCheckAtMs, planned);
  assert.equal(provider.nextRefreshAt!([host]), planned);
  now += 300_000;
  const cached = (await provider([host])).hosts[0]!;
  assert.deepEqual(cached, original);
  assert.equal(requests, 2);
  cached.apiCheck!.lastConfirmed!.nextCheckAtMs = now + 900_000;
  assert.equal((await provider([host])).hosts[0]?.apiCheck?.lastConfirmed?.nextCheckAtMs, planned);
  assert.equal(requests, 2);
});

test("inconclusive raw OTHER cannot invent confirmed API history", async () => {
  const invalid = createNodeInfoProvider({ now: () => base, fetch: async () => Response.json({ node: other, state: "OTHER" }) });
  const record = (await invalid([host])).hosts[0]!;
  assert.equal(record.apiCheck?.status, "other");
  assert.equal(record.apiCheck?.lastConfirmed, undefined);
  assert.equal(record.values, null);
});
