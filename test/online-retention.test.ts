import assert from "node:assert/strict";
import { test } from "node:test";
import { createOnlineRetention, ONLINE_RETIRED_HOST_LIMIT, ONLINE_RETIRED_RETENTION_MS } from "../scripts/online-retention.ts";
import type { RetentionScope } from "../scripts/online-retention.ts";

const hour = ONLINE_RETIRED_RETENTION_MS;

test("Online retention pins fixed/current/read hosts and rejects admission without dropping protected state", () => {
  let now = 100_000;
  let scope: RetentionScope | undefined;
  const retention = createOnlineRetention({ pinned: ["fixed", "real200"], maximumRetiredHosts: 1, now: () => now,
    caches: () => [{ prune: value => { scope = value; } }] });
  assert(retention.accept(["fixed", "a", "b"]));
  const releaseA = retention.hold(["a"]);
  const secondReleaseA = retention.hold(["a"]);
  assert(retention.accept(["b"]));
  now += hour;
  assert.equal(retention.accept(["c"]), false, "an old revision still owns a");
  releaseA();
  releaseA(); // Releases are idempotent, including cancellation cleanup.
  assert.equal(retention.accept(["c"]), false, "the second consumer still owns a");
  secondReleaseA();
  assert(retention.accept(["c"]));
  retention.prune();
  assert.deepEqual([...scope!.hosts].sort(), ["b", "c", "fixed", "real200"]);
  assert.equal(retention.size, 2);
  assert.throws(() => retention.hold(["unadmitted"]), /admitted/);
});

test("retirement lasts one hour and rejoining restarts retirement only when leaving again", () => {
  let now = 1_000;
  const retention = createOnlineRetention({ pinned: [], maximumRetiredHosts: 1, now: () => now, caches: () => [] });
  assert(retention.accept(["a", "b"]));
  assert(retention.accept(["b"]));
  now += hour - 1;
  assert.equal(retention.accept(["c"]), false);
  assert(retention.accept(["a", "b"]));
  now += hour;
  retention.prune();
  assert.equal(retention.size, 2, "current membership cannot be evicted");
  assert(retention.accept(["b"]));
  now += hour - 1;
  assert.equal(retention.accept(["c"]), false);
  now++;
  assert(retention.accept(["c"]));
  assert.equal(retention.size, 2);
  assert.equal(retention.retiredSize, 1);
});

test("host and dependent market retry deadlines extend retirement without shortening either", () => {
  let now = 0;
  let scope: RetentionScope | undefined;
  const retention = createOnlineRetention({ pinned: [], maximumRetiredHosts: 1, now: () => now,
    caches: () => [{ retryAt: address => address === "a" ? 2 * hour : 0,
      markets: hosts => hosts.has("a") ? ["market"] : [],
      marketRetryAt: market => market === "market" ? 3 * hour : 0,
      prune: value => { scope = value; } }] });
  assert(retention.accept(["a", "b"]));
  assert(retention.accept(["b"]));
  for (now of [hour, 2 * hour, 3 * hour - 1]) {
    assert.equal(retention.accept(["c"]), false);
    assert(scope!.hosts.has("a"));
    assert(scope!.markets.has("market"));
  }
  now++;
  assert(retention.accept(["c"]));
  retention.prune();
  assert(!scope!.hosts.has("a"));
  assert(!scope!.markets.has("market"));
});

test("a current host's refreshing shared market cannot pin a departed host past its own deadline", () => {
  let now = 0;
  let scope: RetentionScope | undefined;
  const retention = createOnlineRetention({ pinned: [], maximumRetiredHosts: 1, now: () => now,
    caches: () => [{ retryAt: () => 0,
      markets: hosts => hosts.has("a") || hosts.has("b") ? ["shared-market"] : [],
      marketRetryAt: () => now + 15_000,
      prune: value => { scope = value; } }] });
  assert(retention.accept(["a", "b"]));
  assert(retention.accept(["b"]));
  now = hour;
  retention.prune();
  assert.equal(retention.retiredSize, 0);
  assert(!scope!.hosts.has("a"));
  assert(scope!.hosts.has("b"));
  assert(scope!.markets.has("shared-market"), "current b still protects the renewed market cache");
  assert(retention.accept(["c"]), "freed departed capacity allows the next membership revision");
});

test("the 5000 departed-only bound remains enforced across substantial churn and pinned rosters", () => {
  let now = 1_000;
  let largest = 0;
  const fixed = Array.from({ length: 201 }, (_, index) => `fixed-${index}`);
  const retention = createOnlineRetention({ pinned: fixed, now: () => now,
    caches: () => [{ prune: scope => { largest = Math.max(largest, scope.hosts.size); } }] });
  for (let generation = 0; generation <= 50; generation++) {
    assert(retention.accept([...fixed, ...Array.from({ length: 100 }, (_, index) => `${generation}-${index}`)]));
  }
  assert.equal(retention.retiredSize, ONLINE_RETIRED_HOST_LIMIT);
  assert.equal(retention.accept(["extra"]), false);
  assert.equal(retention.size, ONLINE_RETIRED_HOST_LIMIT + 100);
  now += hour;
  assert(retention.accept(["extra"]));
  assert.equal(retention.size, 101, "the prior current generation begins retirement now");
  assert(largest <= ONLINE_RETIRED_HOST_LIMIT + 100 + fixed.length);
});

test("6000 current hosts are admitted independently while excessive retirement fails atomically", () => {
  const hosts = Array.from({ length: 6_000 }, (_, index) => `host-${index}`);
  const retention = createOnlineRetention({ pinned: [], caches: () => [] });
  assert(retention.accept(hosts));
  assert.equal(retention.size, 6_000);
  assert.equal(retention.retiredSize, 0);
  assert.equal(retention.accept([]), false, "6000 departed hosts cannot fit the 5000 departed limit");
  assert.equal(retention.retiredSize, 0, "failed admission cannot retire part of the current roster");
  assert(retention.accept(hosts.slice(5_000)));
  assert.equal(retention.retiredSize, 5_000);
  assert.equal(retention.accept(hosts.slice(5_001)), false);
});

test("lazy cache hooks are discovered when pruning without replacing their provider", () => {
  let now = 0;
  let reads = 0;
  let enabled = false;
  const retention = createOnlineRetention({ pinned: ["fixed"], now: () => now,
    caches: () => enabled ? [{ retryAt: () => 2 * hour, prune: () => { reads++; } }] : [] });
  assert(retention.accept(["a"]));
  assert(retention.accept([]));
  enabled = true;
  now = hour;
  retention.prune();
  assert.equal(retention.size, 1);
  assert.equal(reads, 1);
  now = 2 * hour;
  retention.prune();
  assert.equal(retention.size, 0);
});
