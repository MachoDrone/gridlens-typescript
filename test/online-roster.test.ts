import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { createOnlineRosterController } from "../src/preview/online-roster.ts";
import type { OnlineHostsSnapshot } from "../src/contracts/online-hosts.ts";
import { SYNTHETIC_HOST_ADDRESSES as hosts } from "./fixtures/host-addresses.ts";

function snapshot(revision = "a", addresses = hosts.slice(0, 2)): OnlineHostsSnapshot {
  return { addresses, error: null, online: { revision, checkedAtMs: Date.now(),
    nextRefreshAtMs: Date.now() + 60_000, retained: false, discoveryError: null } };
}

test("visible discovery follows source deadlines, identifies membership changes and stops when paused", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  let value = snapshot();
  let reads = 0;
  const changes: boolean[] = [];
  const controller = createOnlineRosterController({ now: Date.now, visible: () => true,
    read: async () => { reads++; return value; }, apply: (_result, changed) => changes.push(changed),
    failed: message => assert.fail(message) });
  t.after(() => controller.pause());
  await controller.resume();
  await controller.resume();
  assert.equal(reads, 1);
  t.mock.timers.tick(59_999);
  assert.equal(reads, 1);
  value = { ...value, online: { ...value.online, checkedAtMs: Date.now() + 1, nextRefreshAtMs: Date.now() + 60_001 } };
  t.mock.timers.tick(1);
  await setImmediate();
  assert.equal(reads, 2);
  assert.deepEqual(changes, [true, false]);
  value = snapshot("b", hosts.slice(1, 3));
  await controller.refresh();
  assert.deepEqual(changes, [true, false, true]);
  controller.pause();
  t.mock.timers.tick(600_000);
  assert.equal(reads, 3);
});

test("visibility cancels ownership and an old response cannot replace the resumed roster", async t => {
  let visible = false;
  let oldSignal: AbortSignal | undefined;
  let release!: (snapshot: OnlineHostsSnapshot) => void;
  let reads = 0;
  const revisions: (string | null)[] = [];
  const controller = createOnlineRosterController({ now: Date.now, visible: () => visible,
    read: async signal => {
      if (++reads === 1) { oldSignal = signal; return new Promise(resolve => { release = resolve; }); }
      return snapshot("new");
    }, apply: result => revisions.push(result.online.revision), failed: message => assert.fail(message) });
  t.after(() => controller.pause());
  await controller.resume();
  assert.equal(reads, 0);
  visible = true;
  const first = controller.resume();
  await controller.refresh(); // A second caller joins existing page ownership.
  assert.equal(reads, 1);
  visible = false;
  controller.pause();
  assert.equal(oldSignal?.aborted, true);
  visible = true;
  await controller.resume();
  release(snapshot("old"));
  await first;
  assert.deepEqual(revisions, ["new"]);
});

test("initial errors and retained failures follow their retry deadline without replacing membership", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  let value: OnlineHostsSnapshot = { addresses: [], error: "Unavailable", online: {
    revision: null, checkedAtMs: null, nextRefreshAtMs: Date.now() + 300_000, retained: false, discoveryError: "Unavailable",
  } };
  let reads = 0;
  const applied: OnlineHostsSnapshot[] = [];
  const failures: string[] = [];
  const controller = createOnlineRosterController({ now: Date.now, visible: () => true,
    read: async () => { reads++; return value; }, apply: result => applied.push(result), failed: message => failures.push(message) });
  t.after(() => controller.pause());
  await controller.resume();
  assert.equal(applied.length, 0);
  assert.equal(failures.length, 1);
  t.mock.timers.tick(299_999);
  assert.equal(reads, 1);
  value = snapshot();
  t.mock.timers.tick(1);
  await setImmediate();
  assert.equal(applied.length, 1);
  const checked = value.online.checkedAtMs;
  value = { ...value, online: { ...value.online, retained: true, discoveryError: "Rate limited",
    nextRefreshAtMs: Date.now() + 900_000 } };
  await controller.refresh();
  assert.equal(applied.at(-1)?.online.checkedAtMs, checked);
  assert.equal(applied.at(-1)?.online.retained, true);
  assert.equal(failures.length, 1);
});

test("unchanged revisions cannot smuggle changed membership and network errors retry without losing the prior roster", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  let value = snapshot();
  let failing = false;
  let reads = 0;
  const applied: OnlineHostsSnapshot[] = [];
  const errors: string[] = [];
  const controller = createOnlineRosterController({ now: Date.now, visible: () => true,
    read: async () => { reads++; if (failing) throw new Error("sensitive transport diagnostic"); return value; },
    apply: result => applied.push(result), failed: message => errors.push(message) });
  t.after(() => controller.pause());
  await controller.resume();
  value = snapshot("a", hosts.slice(1, 3));
  await controller.refresh();
  assert.equal(applied.length, 1);
  failing = true;
  await controller.refresh();
  assert.equal(applied.length, 1);
  assert(errors.every(message => !message.includes("sensitive")));
  const before = reads;
  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(reads, before + 1);
});
