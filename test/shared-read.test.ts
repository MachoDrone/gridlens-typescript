import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createRequestLimiter, createSharedRead } from "../scripts/shared-read.ts";

test("shared reads abort the upstream only when their final consumer leaves", async () => {
  const read = createSharedRead<string, number>();
  const first = new AbortController();
  const second = new AbortController();
  let upstream: AbortSignal | undefined;
  let complete!: (value: number) => void;
  let calls = 0;
  const action = async (signal: AbortSignal): Promise<number> => {
    calls++;
    upstream = signal;
    return new Promise(resolve => { complete = resolve; });
  };
  const one = read("fleet", action, first.signal);
  const two = read("fleet", action, second.signal);
  await setImmediate();
  const rejected = assert.rejects(one, { name: "AbortError" });
  first.abort();
  await rejected;
  assert.equal(upstream?.aborted, false);
  assert.equal(calls, 1);
  complete(42);
  assert.equal(await two, 42);
});

test("immediate rejoin gets new work and an obsolete completion cannot remove it", async () => {
  const read = createSharedRead<string, number>();
  const controller = new AbortController();
  const complete: ((value: number) => void)[] = [];
  const signals: AbortSignal[] = [];
  const action = async (signal: AbortSignal): Promise<number> => {
    signals.push(signal);
    return new Promise(resolve => { complete.push(resolve); });
  };
  const old = read("fleet", action, controller.signal);
  await setImmediate();
  const rejected = assert.rejects(old, { name: "AbortError" });
  controller.abort();
  const current = read("fleet", action);
  await rejected;
  await setImmediate();
  assert.equal(signals[0]?.aborted, true);
  assert.equal(signals.length, 2);
  complete[0]!(1); // Simulate a transport that ignores cancellation.
  await setImmediate();
  const joined = read("fleet", action);
  assert.equal(signals.length, 2);
  complete[1]!(2);
  assert.deepEqual(await Promise.all([current, joined]), [2, 2]);
});

test("canceling queued requests removes them without dispatch or blocking later work", async () => {
  const limited = createRequestLimiter(1);
  let finish!: () => void;
  const active = limited(async () => new Promise<void>(resolve => { finish = resolve; }));
  const controller = new AbortController();
  let canceledCalls = 0;
  const queued = limited(async () => { canceledCalls++; }, controller.signal);
  const rejected = assert.rejects(queued, { name: "AbortError" });
  const next = limited(async () => 7);
  await setImmediate();
  controller.abort();
  await rejected;
  finish();
  assert.equal(await next, 7);
  await active;
  assert.equal(canceledCalls, 0);
});

test("already canceled calls never enter the shared pool or request queue", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const action = async (): Promise<number> => { calls++; return 1; };
  await assert.rejects(createSharedRead<string, number>()("fleet", action, controller.signal), { name: "AbortError" });
  await assert.rejects(createRequestLimiter(2)(action, controller.signal), { name: "AbortError" });
  assert.equal(calls, 0);
});

test("shared dispatch reconsiders late first attempts and aging evidence at each free slot, with stable ties", async () => {
  const limited = createRequestLimiter(1);
  const order: string[] = [];
  let release!: () => void;
  const active = limited(async () => new Promise<void>(resolve => { release = resolve; }));
  let aging = 3;
  const routine = limited(async () => { order.push("aging"); }, undefined, () => [1, aging, 0]);
  const transition = limited(async () => { order.push("transition"); }, undefined, () => [1, 1, 1]);
  const first = limited(async () => { order.push("first"); aging = 0; }, undefined, () => [0, 0, 0]);
  const tied = limited(async () => { order.push("tie"); }, undefined, () => [1, 1, 1]);
  await setImmediate();
  release();
  await Promise.all([active, routine, transition, first, tied]);
  assert.deepEqual(order, ["first", "aging", "transition", "tie"]);
});
