import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createSharedProgressRead, mergeHostUpdates } from "../scripts/shared-progress.ts";

test("progress is immediate and replayed to joining consumers without another upstream read", async () => {
  type Snapshot = { hosts: { address: string; amount: number }[] };
  const shared = createSharedProgressRead<string, Snapshot>(mergeHostUpdates);
  let publish!: (snapshot: Snapshot) => void;
  let finish!: () => void;
  let signal!: AbortSignal;
  let calls = 0;
  const first = new AbortController();
  const action = async (currentSignal: AbortSignal, emit: typeof publish) => {
    signal = currentSignal; publish = emit; calls++;
    await new Promise<void>(resolve => { finish = resolve; });
    return { hosts: [{ address: "a", amount: 2 }] };
  };
  const seen: Snapshot[] = [];
  const one = shared("scope", action, first.signal, update => seen.push(update));
  await setImmediate();
  publish({ hosts: [{ address: "a", amount: 1 }] });
  publish({ hosts: [{ address: "a", amount: 2 }] });
  assert.equal(seen.length, 2);
  const joined: Snapshot[] = [];
  const two = shared("scope", action, undefined, update => joined.push(update));
  assert.deepEqual(joined, [{ hosts: [{ address: "a", amount: 2 }] }]);
  const canceled = assert.rejects(one, { name: "AbortError" });
  first.abort();
  await canceled;
  assert.equal(signal.aborted, false);
  finish();
  assert.deepEqual(await two, joined[0]);
  assert.equal(calls, 1);
});

test("late progress after final-consumer cancellation cannot replace resumed evidence", async () => {
  type Snapshot = { hosts: { address: string }[] };
  const shared = createSharedProgressRead<string, Snapshot>(mergeHostUpdates);
  const old = new AbortController();
  let publish!: (snapshot: Snapshot) => void;
  let finish!: () => void;
  const updates: Snapshot[] = [];
  const one = shared("scope", async (_signal, emit) => {
    publish = emit;
    await new Promise<void>(resolve => { finish = resolve; });
    return { hosts: [{ address: "old" }] };
  }, old.signal, update => updates.push(update));
  await setImmediate();
  const canceled = assert.rejects(one, { name: "AbortError" });
  old.abort();
  await canceled;
  await shared("scope", async (_signal, emit) => {
    const current = { hosts: [{ address: "new" }] }; emit(current); return current;
  }, undefined, update => updates.push(update));
  publish({ hosts: [{ address: "old" }] });
  finish();
  await setImmediate();
  assert.deepEqual(updates, [{ hosts: [{ address: "new" }] }]);
});
