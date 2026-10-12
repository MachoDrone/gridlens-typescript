import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { NODE_STATES } from "../src/fleet/node-info.ts";
import type { NodeInfoRecord } from "../src/fleet/node-info.ts";
import { nextApiExpiryDelay, projectNodeApi } from "../src/fleet/node-api.ts";
import { createNodeInfoProvider } from "../scripts/node-info.ts";
import { createHostMetadataProvider } from "../scripts/host-metadata.ts";
import { createNodeActivityProvider, createReconciledNodeInfoProvider } from "../scripts/node-activity.ts";
import { normalizeHostMetadata } from "../src/fleet/host-metadata.ts";
import { projectNodeState } from "../src/fleet/node-state.ts";

const address = "1".repeat(31) + "2";
const other = "1".repeat(31) + "3";
const now = Date.UTC(2026, 9, 7, 12);

test("an on-time 503 confirmation preserves bold Offline only within its original completion allowance", () => {
  const previous = { status: "offline" as const, checkedAtMs: now, firstFailedAtMs: now - 1000,
    httpStatus: 503, nextCheckAtMs: now + 120_000 };
  const pending: NodeInfoRecord = { address, values: null, fetchedAtMs: null, validUntilMs: null,
    error: "HTTP 503", retained: false, apiCheck: { status: "other", checkedAtMs: now + 120_000,
      confirmationPending: true, failureKind: "http", httpStatus: 503, lastConfirmed: previous } };
  const view = projectNodeApi(pending, now + 121_000);
  assert.equal(view.status, "Offline");
  assert.equal(view.current, true);
  assert.equal(view.checkedAtMs, now);
  assert.equal(view.expiresAtMs, now + 128_000);
  assert.equal(projectNodeApi(pending, now + 128_000).current, false);
  const { httpStatus: _httpStatus, ...inconclusive } = pending.apiCheck!;
  const networkFailure = { ...pending, apiCheck: { ...inconclusive, failureKind: "network" as const } };
  assert.equal(projectNodeApi(networkFailure, now + 121_000).current, false);
  assert.equal(projectNodeApi(pending, now + 121_000, "Preview disconnected").current, false);
});

function record(): NodeInfoRecord {
  return { address, values: { state: "OTHER", dl: null, ul: null, ping: null, networkUnavailableReason: null },
    fetchedAtMs: now, validUntilMs: now + 30_000, retained: false, error: null,
    apiCheck: { status: "online", checkedAtMs: now } };
}

test("API Online follows the validated response independently of every raw State and its reconciliation", () => {
  for (const state of [...NODE_STATES, "FUTURE_STATE", null]) {
    const value = record();
    value.values!.state = state;
    value.activity = { state: null, source: "nosana-indexer", checkedAtMs: null, validUntilMs: null,
      error: "Independent activity evidence is unavailable." };
    assert.equal(projectNodeApi(value, now + 1000).status, "Online");
    assert.equal(projectNodeApi(value, now + 1000).current, true);
    assert.equal(projectNodeApi(value, now + 1000).checkedAtMs, now);
    assert.equal(projectNodeApi(value, now + 1000).expiresAtMs, now + 30_000);
  }
});

test("membership refreshes cannot extend API Online beyond the raw response's original deadline", () => {
  const value = record();
  value.activity = { state: "RUNNING_JOB", source: "nosana-indexer", checkedAtMs: now + 25_000,
    validUntilMs: now + 55_000, error: null };
  assert.equal(projectNodeApi(value, now + 29_999).status, "Online");
  assert.equal(projectNodeApi(value, now + 30_000).status, "Online");
  assert.equal(projectNodeApi(value, now + 30_000).current, false);
  assert.equal(projectNodeApi(value, now + 30_000).checkedAtMs, now);
  assert.equal(nextApiExpiryDelay([value], now + 30_000, now + 30_000), null);
  assert.match(projectNodeApi(value, now + 30_000).description, /expired/);
});

test("API Offline expires from the failed attempt time while retaining its historical reason and successful State dates", () => {
  const value = record();
  value.retained = true;
  value.error = "Nosana Node Info request failed (HTTP 503).";
  value.apiCheck = { status: "offline", checkedAtMs: now + 15_000 };
  const before = structuredClone(value);
  const fresh = projectNodeApi(value, now + 44_999);
  assert.equal(fresh.status, "Offline");
  assert.equal(fresh.expiresAtMs, now + 45_000);
  for (const clock of [now + 45_000, now + 900_000]) {
    const expired = projectNodeApi(value, clock);
    assert.equal(expired.status, "Offline");
    assert.equal(expired.current, false);
    assert.equal(expired.checkedAtMs, now + 15_000);
    assert(expired.description.includes(new Date(now + 15_000).toISOString()));
    assert.match(expired.description, /503/);
    assert.match(expired.description, /expired|last/i);
  }
  assert.deepEqual(value, before);
});

test("missing evidence and invalid/future API assessments are Unknown and cannot create history", () => {
  assert.equal(projectNodeApi(undefined, now).status, "Unknown");
  assert.equal(projectNodeApi({ ...record(), apiCheck: { status: "other", checkedAtMs: now },
    error: "The lookup is pending." }, now).status, "Unknown");
  for (const checkedAtMs of [now + 1, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER]) {
    assert.equal(projectNodeApi({ ...record(), apiCheck: { status: "online", checkedAtMs } }, now).status, "Unknown");
  }
});

test("preview transport failure retains confirmed labels as stale but does not invent history", () => {
  for (const status of ["online", "offline"] as const) {
    const result = projectNodeApi({ ...record(), apiCheck: { status, checkedAtMs: now } }, now, "Preview stream disconnected.");
    assert.equal(result.status, status === "online" ? "Online" : "Offline");
    assert.equal(result.current, false);
    assert.equal(result.checkedAtMs, now);
    assert.match(result.description, /preview|connection/i);
  }
  const unknown = projectNodeApi({ ...record(), apiCheck: { status: "other", checkedAtMs: now } }, now, "Preview stream disconnected.");
  assert.equal(unknown.status, "Unknown");
  assert.equal(unknown.current, false);
  assert.equal(unknown.checkedAtMs, null);
});

test("legacy successful readings retain Online when stale or failed; absent evidence stays Unknown", () => {
  const value = record();
  delete value.apiCheck;
  assert.equal(projectNodeApi(value, now + 1000).status, "Online");
  assert.equal(projectNodeApi(value, now + 1000).current, true);
  for (const reading of [value, { ...value, retained: true }, { ...value, retained: true, error: "Per-host API failed." }]) {
    const result = projectNodeApi(reading, now + 30_000);
    assert.equal(result.status, "Online");
    assert.equal(result.current, false);
    assert.equal(result.checkedAtMs, now);
  }
  assert.equal(projectNodeApi({ ...value, values: null }, now).status, "Unknown");
});

test("API expiry schedules independently when State proof is absent or has already expired", () => {
  const value = record();
  value.activity = { state: null, source: "nosana-indexer", checkedAtMs: null, validUntilMs: null, error: "No proof." };
  assert.equal(nextApiExpiryDelay([value], now, now), 30_001);
  assert.equal(nextApiExpiryDelay([value], now + 29_999, now + 30_001), 1);
  assert.equal(nextApiExpiryDelay([value], now + 30_000, now + 30_000), null);
  const failed: NodeInfoRecord = { ...value, values: null, fetchedAtMs: null, validUntilMs: null,
    retained: false, error: "Node API timed out", apiCheck: { status: "offline", checkedAtMs: now + 15_000 } };
  assert.equal(nextApiExpiryDelay([failed], now + 20_000, now + 20_000), 25_001);
  assert.equal(nextApiExpiryDelay([failed], now + 44_999, now + 45_001), 1);
  assert.equal(nextApiExpiryDelay([failed], now + 45_000, now + 45_000), null);
  assert.equal(nextApiExpiryDelay([value, failed], now + 20_000, now + 20_000), 10_001);
  assert.equal(nextApiExpiryDelay([value, failed], now + 31_000, now + 31_000), 14_001);
  const { apiCheck: _check, ...unknownFailure } = failed;
  assert.equal(nextApiExpiryDelay([unknownFailure], now + 20_000, now + 20_000), null);
});

test("raw provider preserves prior-success time during confirmation and timestamps the second actual failure", async () => {
  let clock = now;
  let fail = false;
  let calls = 0;
  const provider = createNodeInfoProvider({ now: () => clock, fetch: async () => {
    calls++;
    return fail ? new Response("", { status: 503 }) : Response.json({ node: address, state: "OTHER" });
  } });
  const first = (await provider([address])).hosts[0]!;
  assert.equal(first.apiCheck?.status, "online");
  assert.equal(first.apiCheck?.checkedAtMs, now);
  assert.deepEqual(first.apiCheck?.lastConfirmed, { status: "online", checkedAtMs: now });
  first.apiCheck!.status = "other";
  assert.equal((await provider([address])).hosts[0]?.apiCheck?.status, "online");
  clock += 15_000;
  fail = true;
  const pending = (await provider([address])).hosts[0]!;
  assert.equal(pending.apiCheck?.status, "other");
  assert.equal(pending.apiCheck?.checkedAtMs, clock);
  assert.equal(pending.apiCheck?.confirmationPending, true);
  assert.equal(pending.apiCheck?.lastOnlineAtMs, now);
  assert.equal(pending.fetchedAtMs, now);
  assert.equal(projectNodeApi(pending, clock).status, "Online");
  clock += 500;
  assert.deepEqual((await provider([address])).hosts[0]?.apiCheck, pending.apiCheck);
  assert.equal(calls, 2);
  clock += 500;
  const failed = (await provider([address])).hosts[0]!;
  assert.equal(failed.apiCheck?.status, "offline");
  assert.equal(failed.apiCheck?.checkedAtMs, clock);
  assert.equal(failed.apiCheck?.firstFailedAtMs, now + 15_000);
  assert.equal(failed.apiCheck?.httpStatus, 503);
  assert.equal(failed.fetchedAtMs, now);
  clock += 30_000;
  assert.deepEqual((await provider([address])).hosts[0]?.apiCheck, failed.apiCheck);
  assert.equal(calls, 3);
  assert.equal(projectNodeApi(failed, clock).status, "Offline");
  assert.equal(projectNodeApi(failed, clock).current, true);
  assert.equal(typeof failed.apiCheck?.nextCheckAtMs, "number");
  assert.equal(failed.apiCheck?.lastConfirmed?.nextCheckAtMs, failed.apiCheck?.nextCheckAtMs);
  assert.equal(projectNodeApi(failed, failed.apiCheck!.nextCheckAtMs! + 8_000).current, false);
  assert.equal(projectNodeApi(failed, clock).checkedAtMs, failed.apiCheck?.checkedAtMs);
});

test("typed provider outcomes distinguish HTTP server failure from rate limits, access denial and invalid responses", async () => {
  for (const [response, status] of [
    [() => new Response("", { status: 503 }), "confirmation"],
    [() => new Response("", { status: 429 }), "other"],
    [() => new Response("", { status: 401 }), "other"],
    [() => new Response("", { status: 403 }), "other"],
    [() => new Response("", { status: 404 }), "other"],
    [() => new Response("not JSON"), "other"],
    [() => Response.json({ node: other, state: "QUEUED" }), "other"],
    [() => new Response("{}", { headers: { "Content-Length": "262145" } }), "other"],
  ] as const) {
    const provider = createNodeInfoProvider({ now: () => now, fetch: async () => response() });
    const check = (await provider([address])).hosts[0]?.apiCheck;
    if (status === "confirmation") {
      assert.equal(check?.status, "other");
      assert.equal(check?.checkedAtMs, now);
      assert.equal(check?.confirmationPending, true);
      assert.equal(check?.lastOnlineAtMs, undefined);
    } else {
      assert.equal(check?.status, status);
      assert.equal(check?.checkedAtMs, now);
    }
  }
});

test("first transport errors and timeouts await confirmation while an undispatched rate-limit deferral is Other", async () => {
  const disconnected = createNodeInfoProvider({ now: () => now, fetch: async () => { throw new Error("untrusted transport text"); } });
  const failed = (await disconnected([address])).hosts[0]!;
  assert.equal(failed.apiCheck?.status, "other");
  assert.equal(failed.apiCheck?.confirmationPending, true);
  assert(!failed.error?.includes("untrusted"));
  const timeout = createNodeInfoProvider({ now: () => now, timeoutMs: 5, fetch: async (_input, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }) });
  const timedOut = (await timeout([address])).hosts[0]?.apiCheck;
  assert.equal(timedOut?.status, "other");
  assert.equal(timedOut?.confirmationPending, true);
  let calls = 0;
  const limited = createNodeInfoProvider({ now: () => now, fetch: async () => { calls++; return new Response("", { status: 429 }); } });
  await limited([address]);
  assert.equal((await limited([other])).hosts[0]?.apiCheck?.status, "other");
  assert.equal(calls, 1);
});

test("API Online publishes immediately while OTHER waits for metadata, preserving earlier State and error fields", async () => {
  const market = "1".repeat(31) + "A";
  for (const previousFailure of [false, true]) {
    let clock = now;
    let next = record();
    next.values!.state = previousFailure ? "OTHER" : "RUNNING_JOB";
    if (previousFailure) {
      next.retained = true;
      next.error = "Previous Node Info timed out.";
      next.apiCheck = { status: "offline", checkedAtMs: now };
      next.activity = { state: "RUNNING_JOB", source: "nosana-indexer", checkedAtMs: now,
        validUntilMs: now + 30_000, error: null };
    }
    let release!: () => void;
    const metadataGate = new Promise<void>(resolve => { release = resolve; });
    const provider = createReconciledNodeInfoProvider({ now: () => clock,
      nodeInfoProvider: async () => ({ hosts: [structuredClone(next)] }),
      metadataProvider: async () => {
        await metadataGate;
        return { hosts: [{ address, values: normalizeHostMetadata(address, { nodeAddress: address, marketAddress: market }),
          fetchedAtMs: clock, retained: false, error: null, marketError: null }] };
      },
      activityProvider: async () => new Map([[address, { state: "RUNNING_JOB", source: "nosana-indexer",
        checkedAtMs: clock, validUntilMs: clock + 30_000, error: null }]]),
    });
    const previous = (await provider([address])).hosts[0]!;
    clock += 15_000;
    next = { ...record(), fetchedAtMs: clock, validUntilMs: clock + 30_000,
      apiCheck: { status: "online", checkedAtMs: clock } };
    const updates: NodeInfoRecord[] = [];
    const pending = provider([address], undefined, update => updates.push(...update.hosts));
    await setImmediate();
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0], { ...previous, apiCheck: next.apiCheck });
    assert.equal(projectNodeApi(updates[0], clock).status, "Online");
    assert.deepEqual(projectNodeState(updates[0], clock), projectNodeState(previous, clock));
    release();
    const final = (await pending).hosts[0]!;
    assert.equal(final.fetchedAtMs, clock);
    assert.equal(final.activity?.state, "RUNNING_JOB");
    assert.equal(final.error, null);
    assert.equal(final.retained, false);
    assert.equal(projectNodeApi(final, clock).status, "Online");
  }
});

test("a first OTHER watcher exposes API reachability before its independent activity lookups finish", async () => {
  const market = "1".repeat(31) + "A";
  let release!: () => void;
  const metadataGate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const provider = createReconciledNodeInfoProvider({ now: () => now,
    nodeInfoProvider: createNodeInfoProvider({ now: () => now, fetch: async () => {
      calls++;
      return Response.json({ node: address, state: "OTHER" });
    } }),
    metadataProvider: createHostMetadataProvider({ now: () => now, fetch: async input => {
      calls++;
      await metadataGate;
      return Response.json(String(input).includes("/markets/") ? { address: market, slug: "demo" }
        : { nodeAddress: address, marketAddress: market });
    } }),
    activityProvider: createNodeActivityProvider({ now: () => now, fetch: async input => {
      calls++;
      return Response.json(String(input).includes("/jobs/running-nodes") ? [address] : []);
    } }),
  });
  const controller = new AbortController();
  const updates: NodeInfoRecord[] = [];
  const pending = provider.watch!([address], controller.signal, update => updates.push(...update.hosts)).catch(() => {});
  await setImmediate();
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.values, null);
  assert.equal(updates[0]?.fetchedAtMs, null);
  assert.equal(updates[0]?.validUntilMs, null);
  assert.equal(projectNodeApi(updates[0], now).status, "Online");
  assert.equal(projectNodeState(updates[0], now).reported, null);
  release();
  await setImmediate();
  assert.equal(updates.at(-1)?.activity?.state, "RUNNING_JOB");
  assert.equal(updates.at(-1)?.values?.state, "OTHER");
  assert.equal(projectNodeApi(updates.at(-1), now).status, "Online");
  assert.equal(calls, 5, "API must reuse the existing reads rather than add a root/health request");
  controller.abort();
  await pending;
});

test("pending confirmation retains Online only inside the original successful check's 30 seconds", () => {
  const pending: NodeInfoRecord = { ...record(), retained: true, error: "Node Info request timed out.",
    apiCheck: { status: "other", checkedAtMs: now + 23_000, confirmationPending: true, lastOnlineAtMs: now } };
  const before = structuredClone(pending);
  for (const at of [now + 23_000, now + 29_999]) {
    const view = projectNodeApi(pending, at);
    assert.equal(view.status, "Online");
    assert.equal(view.expiresAtMs, now + 30_000);
    assert.match(view.description, /confirm/i);
    assert(view.description.includes(new Date(now).toISOString()));
  }
  assert.equal(projectNodeApi(pending, now + 30_000).status, "Online");
  assert.equal(projectNodeApi(pending, now + 30_000).current, false);
  assert.equal(projectNodeApi(pending, now + 60_000).status, "Online");
  assert.equal(projectNodeApi(pending, now + 60_000).checkedAtMs, now);
  assert.equal(nextApiExpiryDelay([pending], now + 23_000, now + 23_000), 7_001);
  assert.equal(nextApiExpiryDelay([pending], now + 30_000, now + 30_000), null);
  assert.deepEqual(pending, before);
});

test("confirmation cannot invent a recent success from missing, future, inconsistent or malformed prior timestamps", () => {
  for (const lastOnlineAtMs of [undefined, now - 30_001, now + 24_000, now + 22_001, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER]) {
    const pending: NodeInfoRecord = { ...record(), retained: true, error: "A request failed.", apiCheck: {
      status: "other", checkedAtMs: now + 22_000, confirmationPending: true,
      ...(lastOnlineAtMs === undefined ? {} : { lastOnlineAtMs }),
    } };
    assert.equal(projectNodeApi(pending, now + 23_000).status, lastOnlineAtMs === now - 30_001 ? "Online" : "Unknown", String(lastOnlineAtMs));
    assert.equal(projectNodeApi(pending, now + 23_000).current, false);
    assert.equal(nextApiExpiryDelay([pending], now + 23_000, now + 23_000), null);
  }
  assert.equal(projectNodeApi({ ...record(), apiCheck: {
    status: "other", checkedAtMs: now + 23_000, confirmationPending: false, lastOnlineAtMs: now,
  } }, now + 23_000).status, "Unknown");
});

test("confirmed Offline expires when its oldest supporting HTTP 503 expires, even with a recent second check", () => {
  const value: NodeInfoRecord = { ...record(), retained: true, error: "Node Info request failed (HTTP 503).", apiCheck: {
    status: "offline", firstFailedAtMs: now, checkedAtMs: now + 29_000, failureKind: "http", httpStatus: 503,
  } };
  const before = structuredClone(value);
  const recent = projectNodeApi(value, now + 29_000);
  assert.equal(recent.status, "Offline");
  assert.equal(recent.expiresAtMs, now + 30_000);
  assert.equal(nextApiExpiryDelay([value], now + 29_000, now + 29_000), 1_001);
  assert.equal(projectNodeApi(value, now + 29_999).status, "Offline");
  const expired = projectNodeApi(value, now + 30_000);
  assert.equal(expired.status, "Offline");
  assert.equal(expired.current, false);
  assert.equal(expired.checkedAtMs, now + 29_000);
  assert.match(expired.description, /503|failed/i);
  assert.deepEqual(value, before);
});

test("an old, malformed or future first failure cannot turn a fresh single failure into Offline", () => {
  for (const firstFailedAtMs of [now - 30_000, now - 600_000, now + 1, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER]) {
    const value: NodeInfoRecord = { ...record(), retained: true, error: "Node API returned HTTP 503", apiCheck: {
      status: "offline", checkedAtMs: now, firstFailedAtMs, failureKind: "http", httpStatus: 503,
    } };
    assert.equal(projectNodeApi(value, now).status, "Unknown", String(firstFailedAtMs));
    assert.equal(nextApiExpiryDelay([value], now, now), null);
  }
});

test("repeated timeout, network and HTTP 500/502/504 failures stay uncertain after their bounded confirmation", async () => {
  for (const kind of ["timeout", "network", 500, 502, 504] as const) {
    let clock = now;
    let calls = 0;
    const provider = createNodeInfoProvider({ now: () => clock, timeoutMs: 5,
      fetch: async (_input, init) => {
        calls++;
        if (kind === "timeout") return new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(new Error("aborted fixture")), { once: true });
        });
        if (kind === "network") throw new Error("fixture network failure");
        return new Response("", { status: kind });
      },
    });
    const first = (await provider([address])).hosts[0]!;
    assert.equal(first.apiCheck?.status, "other", String(kind));
    assert.equal(first.apiCheck?.confirmationPending, true, String(kind));
    clock += 1_000;
    const second = (await provider([address])).hosts[0]!;
    assert.equal(calls, 2, String(kind));
    assert.equal(second.apiCheck?.status, "other", String(kind));
    assert.notEqual(second.apiCheck?.confirmationPending, true, String(kind));
    assert.equal(projectNodeApi(second, clock).status, "Unknown", String(kind));
  }
});

test("inconclusive checks preserve nonrecursive confirmed history and its original source time", () => {
  for (const status of ["online", "offline"] as const) {
    const value: NodeInfoRecord = { ...record(), values: null, fetchedAtMs: null, validUntilMs: null,
      error: "The latest check was inconclusive", apiCheck: { status: "other", checkedAtMs: now + 10_000,
        lastConfirmed: { status, checkedAtMs: now,
          ...(status === "offline" ? { firstFailedAtMs: now - 1_000, httpStatus: 503 } : {}) },
      } };
    const before = structuredClone(value);
    for (const at of [now + 10_000, now + 600_000]) {
      const view = projectNodeApi(value, at);
      assert.equal(view.status, status === "online" ? "Online" : "Offline");
      assert.equal(view.current, false);
      assert.equal(view.checkedAtMs, now);
      assert(view.description.includes(new Date(now).toISOString()));
    }
    assert.deepEqual(value, before);
  }
});

test("future or invalid latest outcomes never create history, but separate valid history can remain stale", () => {
  const value: NodeInfoRecord = { ...record(), apiCheck: { status: "offline", checkedAtMs: now + 1 } };
  assert.equal(projectNodeApi(value, now).status, "Unknown");
  assert.equal(projectNodeApi(value, now).checkedAtMs, null);
  value.apiCheck!.lastConfirmed = { status: "online", checkedAtMs: now - 1_000 };
  assert.equal(projectNodeApi(value, now).status, "Online");
  assert.equal(projectNodeApi(value, now).current, false);
  assert.equal(projectNodeApi(value, now).checkedAtMs, now - 1_000);
  value.apiCheck!.lastConfirmed = { status: "online", checkedAtMs: now + 1 };
  assert.equal(projectNodeApi(value, now).status, "Unknown");
});

test("Offline stays current until its frozen scheduled retry plus eight seconds without renewing its check time", () => {
  const value: NodeInfoRecord = { ...record(), error: "HTTP 503", apiCheck: {
    status: "offline", checkedAtMs: now, firstFailedAtMs: now - 1_000, httpStatus: 503,
    nextCheckAtMs: now + 120_000,
  } };
  const before = structuredClone(value);
  for (const at of [now, now + 31_000, now + 120_000, now + 127_999]) {
    const result = projectNodeApi(value, at);
    assert.equal(result.status, "Offline");
    assert.equal(result.current, true);
    assert.equal(result.checkedAtMs, now);
    assert.equal(result.expiresAtMs, now + 128_000);
  }
  assert.equal(nextApiExpiryDelay([value], now + 31_000, now + 31_000), 97_001);
  for (const at of [now + 128_000, now + 600_000]) {
    const result = projectNodeApi(value, at);
    assert.equal(result.status, "Offline");
    assert.equal(result.current, false);
    assert.equal(result.checkedAtMs, now);
    assert.equal(nextApiExpiryDelay([value], at, at), null);
  }
  assert.deepEqual(value, before);
  const online = { ...record(), apiCheck: { status: "online" as const, checkedAtMs: now, nextCheckAtMs: now + 120_000 } };
  assert.equal(projectNodeApi(online, now + 30_000).current, false, "An Offline retry schedule must not extend Online");
});

test("invalid and excessive retry schedules cannot keep an old Offline current", () => {
  const value: NodeInfoRecord = { ...record(), apiCheck: { status: "offline", checkedAtMs: now, httpStatus: 503 } };
  for (const nextCheckAtMs of [-1, now - 1, now, now + 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, now + 900_001]) {
    const snapshot = { ...value, apiCheck: { ...value.apiCheck!, nextCheckAtMs } };
    assert.equal(projectNodeApi(snapshot, now + 31_000).status, "Offline");
    assert.equal(projectNodeApi(snapshot, now + 31_000).current, false, String(nextCheckAtMs));
    assert.equal(projectNodeApi(snapshot, now + 31_000).checkedAtMs, now);
  }
  const bounded = { ...value, apiCheck: { ...value.apiCheck!, nextCheckAtMs: now + 900_000 } };
  assert.equal(projectNodeApi(bounded, now + 907_999).current, true);
  assert.equal(projectNodeApi(bounded, now + 908_000).current, false);
});

test("a future retry deadline cannot reactivate inconclusive or disconnected retained history", () => {
  const confirmed = { status: "offline" as const, checkedAtMs: now, firstFailedAtMs: now - 1_000,
    httpStatus: 503, nextCheckAtMs: now + 120_000 };
  const retained: NodeInfoRecord = { ...record(), values: null, fetchedAtMs: null, validUntilMs: null,
    error: "A newer check was inconclusive", apiCheck: { status: "other", checkedAtMs: now + 10_000, lastConfirmed: confirmed } };
  const result = projectNodeApi(retained, now + 31_000);
  assert.equal(result.status, "Offline");
  assert.equal(result.current, false);
  assert.equal(result.checkedAtMs, now);
  assert.equal(nextApiExpiryDelay([retained], now + 31_000, now + 31_000), null);
  const disconnected = projectNodeApi({ ...record(), apiCheck: confirmed }, now + 31_000, "Preview unavailable");
  assert.equal(disconnected.status, "Offline");
  assert.equal(disconnected.current, false);
  assert.equal(disconnected.checkedAtMs, now);
});
