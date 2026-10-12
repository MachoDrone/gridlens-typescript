import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createNodeInfoProvider } from "../scripts/node-info.ts";
import type { NodeInfoRecord } from "../src/fleet/node-info.ts";

const base = Date.UTC(2026, 9, 8, 9);
const address = "1".repeat(31) + "2";

test("repeated network, redirect and gateway failures remain unknown rather than claiming a node outage", async () => {
  for (const response of [
    () => { throw new TypeError("private network diagnostics", { cause: { code: "EAI_AGAIN" } }); },
    () => new Response("", { status: 302, headers: { Location: "https://private.invalid/secret" } }),
    ...[500, 502, 504].map(status => () => new Response("", { status })),
  ]) {
    let now = base;
    const provider = createNodeInfoProvider({ now: () => now, fetch: async (_input, init) => {
      assert.equal(init?.redirect, "manual", "redirect responses must be observed without following them");
      return response();
    } });
    for (let attempt = 0; attempt < 4; attempt++) {
      const result = (await provider([address])).hosts[0]!;
      assert.equal(result.apiCheck?.status, "other");
      assert.equal(result.apiCheck?.firstFailedAtMs, undefined);
      assert(!JSON.stringify(result).includes("private"));
      assert(!JSON.stringify(result).includes("secret"));
      now = provider.nextRefreshAt!([address])!;
    }
  }
});

test("a ten-hour-old HTTP 503 cannot establish a fresh Offline result with one new error", async () => {
  let now = base;
  let calls = 0;
  const provider = createNodeInfoProvider({ now: () => now, fetch: async () => { calls++; return new Response("", { status: 503 }); } });
  assert.equal((await provider([address])).hosts[0]?.apiCheck?.firstFailedAtMs, base);
  now += 10 * 60 * 60_000;
  const freshFirst = (await provider([address])).hosts[0]!;
  assert.equal(freshFirst.apiCheck?.status, "other");
  assert.equal(freshFirst.apiCheck?.confirmationPending, true);
  assert.equal(freshFirst.apiCheck?.firstFailedAtMs, now);
  now += 1000;
  const confirmed = (await provider([address])).hosts[0]!;
  assert.equal(confirmed.apiCheck?.status, "offline");
  assert.equal(confirmed.apiCheck?.firstFailedAtMs, now - 1000);
  assert.equal(confirmed.apiCheck?.checkedAtMs, now);
  now = provider.nextRefreshAt!([address])!;
  const expiredPair = (await provider([address])).hosts[0]!;
  assert.equal(expiredPair.apiCheck?.status, "other");
  assert.equal(expiredPair.apiCheck?.firstFailedAtMs, now);
  assert.equal(calls, 4);
});

test("an ambiguous actual failure interrupts the HTTP 503 confirmation pair", async () => {
  for (const middle of [
    () => { throw new Error("sensitive socket text", { cause: { code: "ECONNRESET" } }); },
    () => new Response("", { status: 500 }),
    () => new Response("", { status: 502 }),
    () => new Response("", { status: 504 }),
  ]) {
    let now = base;
    let calls = 0;
    const provider = createNodeInfoProvider({ now: () => now, fetch: async () => ++calls === 2 ? middle() : new Response("", { status: 503 }) });
    await provider([address]);
    now += 1000;
    assert.equal((await provider([address])).hosts[0]?.apiCheck?.status, "other");
    now = provider.nextRefreshAt!([address])!;
    const newFirst = (await provider([address])).hosts[0]!;
    assert.equal(newFirst.apiCheck?.status, "other");
    assert.equal(newFirst.apiCheck?.firstFailedAtMs, now);
    assert.equal(newFirst.apiCheck?.confirmationPending, true);
  }
});

test("failure diagnostics retain only allowlisted transport codes and actual request phases/statuses", async () => {
  const network = createNodeInfoProvider({ now: () => base, fetch: async () => {
    throw new Error("private proxy credentials", { cause: { code: "EAI_AGAIN", address: "sensitive-host" } });
  } });
  const failed = (await network([address])).hosts[0]!;
  assert.equal(failed.apiCheck?.failureKind, "network");
  assert.equal(failed.apiCheck?.phase, "request");
  assert.equal(failed.apiCheck?.errorCode, "EAI_AGAIN");
  assert.equal(failed.apiCheck?.httpStatus, undefined);
  assert(!JSON.stringify(failed).includes("private"));
  assert(!JSON.stringify(failed).includes("sensitive"));
  const unlisted = createNodeInfoProvider({ now: () => base, fetch: async () => {
    throw new Error("private", { cause: { code: "SECRET_TOKEN_VALUE" } });
  } });
  const hidden = (await unlisted([address])).hosts[0]!;
  assert.equal(hidden.apiCheck?.errorCode, undefined);
  assert(!JSON.stringify(hidden).includes("SECRET"));

  for (const [response, phase, status] of [
    [() => new Response(null, { status: 204 }), "headers", 204],
    [() => new Response("{}", { status: 206, headers: { "Content-Length": "262145" } }), "headers", 206],
    [() => Response.json({ node: "wrong" }, { status: 201 }), "validation", 201],
    [() => new Response("not-json"), "validation", 200],
  ] as const) {
    const provider = createNodeInfoProvider({ now: () => base, fetch: async () => response() });
    const record = (await provider([address])).hosts[0]!;
    assert.equal(record.apiCheck?.failureKind, "invalid-response");
    assert.equal(record.apiCheck?.phase, phase);
    assert.equal(record.apiCheck?.httpStatus, status);
  }
});

test("timeouts after HTTP 200 headers remain Other and identify the incomplete body phase", async () => {
  let now = base;
  const provider = createNodeInfoProvider({ now: () => now, timeoutMs: 5, fetch: async (_input, init) => new Response(
    new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
      init!.signal!.addEventListener("abort", () => controller.error(new Error("private body detail")), { once: true });
    } }), { status: 200 },
  ) });
  for (let attempt = 0; attempt < 2; attempt++) {
    const record = (await provider([address])).hosts[0]!;
    assert.equal(record.apiCheck?.status, "other");
    assert.equal(record.apiCheck?.failureKind, "timeout");
    assert.equal(record.apiCheck?.phase, "body");
    assert.equal(record.apiCheck?.httpStatus, 200);
    assert(!JSON.stringify(record).includes("private"));
    now = provider.nextRefreshAt!([address])!;
  }
});

test("a large cold HTTP 503 cohort completes fresh pairs instead of endlessly recycling expired first errors", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: base });
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const addresses = Array.from({ length: 64 }, (_, index) => {
    const value = index + 256;
    return `${"1".repeat(30)}${alphabet[Math.floor(value / 58)]}${alphabet[value % 58]}`;
  });
  const records = new Map<string, NodeInfoRecord>();
  const confirmed = new Set<string>();
  let active = 0;
  let retryActive = 0;
  let maximum = 0;
  let maximumRetry = 0;
  const provider = createNodeInfoProvider({ fetch: async (input, init) => {
    const address = String(input).split("//")[1]!.split(".")[0]!;
    const retry = Boolean(records.get(address)?.error);
    maximum = Math.max(maximum, ++active);
    if (retry) maximumRetry = Math.max(maximumRetry, ++retryActive);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 100);
        init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
      });
      return new Response("", { status: 503 });
    } finally { active--; if (retry) retryActive--; }
  } });
  const controller = new AbortController();
  const pending = provider.watch!(addresses, controller.signal, update => {
    for (const record of update.hosts) {
      records.set(record.address, record);
      if (record.apiCheck?.status === "offline") {
        assert(record.apiCheck.firstFailedAtMs !== undefined);
        assert(record.apiCheck.checkedAtMs < record.apiCheck.firstFailedAtMs + 30_000);
        confirmed.add(record.address);
      }
    }
  }).catch(() => {});
  for (let elapsed = 0; elapsed < 900_000; elapsed += 100) { t.mock.timers.tick(100); await setImmediate(); }
  assert.equal(confirmed.size, 64);
  assert.equal(maximum, 4);
  assert.equal(maximumRetry, 1);
  controller.abort();
  await pending;
});
