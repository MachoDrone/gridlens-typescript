import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openSharedState } from "../src/backend/sqlite-state.ts";

test("ledger batch commits distinct host-history shards and summary together across reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "gridlens-batch-"));
  let state = openSharedState(root);
  const values = [["gpu/fleet/host-a", { samples: [[100, 0, 1, 0, null, null, null, null]] }],
    ["gpu/fleet/host-b", { samples: [[200, 0, 1, 1, 3, null, null, null]] }],
    ["observations/fleet", { hosts: ["host-a", "host-b"], revision: 2 }]] as const;
  try {
    state.batch(values);
    for (const [key, value] of values) assert.deepEqual(state.get(key), value);
    await state.close(); state = openSharedState(root);
    for (const [key, value] of values) assert.deepEqual(state.get(key), value);
    state.batch([]);
  } finally { await state.close(); await rm(root, { recursive: true, force: true }); }
});

test("ledger batch rejects snapshot keys, duplicates and invalid values before writing any shard", async () => {
  const root = await mkdtemp(join(tmpdir(), "gridlens-batch-invalid-"));
  const state = openSharedState(root);
  try {
    state.set("summary", { revision: 1 });
    assert.throws(() => state.batch([["summary", { revision: 2 }], ["snapshots", []]]), /non-snapshot/);
    assert.throws(() => state.batch([["summary", { revision: 2 }], ["summary", { revision: 3 }]]), /unique/);
    assert.throws(() => state.batch([["summary", { revision: 2 }], ["history", undefined]]), /bound/);
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
    assert.throws(() => state.batch([["summary", { revision: 2 }], ["history", cyclic]]), /circular/i);
    assert.deepEqual(state.get("summary"), { revision: 1 });
    assert.equal(state.get("history"), undefined);
    state.batch([["summary", { revision: 4 }]]);
    assert.deepEqual(state.get("summary"), { revision: 4 }, "input-validation failures do not poison a healthy owner");
  } finally { await state.close(); await rm(root, { recursive: true, force: true }); }
});

test("mid-batch SQLite failure rolls all shards back and poisons ledger reads and active snapshot access", async () => {
  const root = await mkdtemp(join(tmpdir(), "gridlens-batch-failure-"));
  let state = openSharedState(root);
  const context = { scopeId: "synthetic", rosterRevision: "one", addresses: ["11111111111111111111111111111112"] };
  const old = [["history/a", { revision: 1 }], ["history/b", { revision: 1 }], ["summary", { revision: 1 }]] as const;
  try {
    state.batch(old); await state.snapshots.read(context);
    const subscription = state.snapshots.subscribe(context, new AbortController().signal, () => {});
    const closed = assert.rejects(subscription, /closed/);
    const fault = new DatabaseSync(join(root, "ledger.sqlite"));
    fault.exec("CREATE TRIGGER isolated_batch_failure BEFORE INSERT ON private_state WHEN NEW.key = 'history/b' BEGIN SELECT RAISE(ABORT, 'isolated batch persistence failure'); END;");
    fault.close();
    assert.throws(() => state.batch([["history/a", { revision: 2 }], ["history/b", { revision: 2 }], ["summary", { revision: 2 }]]), /isolated batch persistence failure/);
    assert.throws(() => state.get("summary"), /recovery/);
    assert.throws(() => state.set("any", true), /recovery/);
    assert.throws(() => state.batch([]), /recovery/);
    await assert.rejects(state.snapshots.read(context), /recovery/);
    await closed;
    await state.close();
    const clear = new DatabaseSync(join(root, "ledger.sqlite")); clear.exec("DROP TRIGGER isolated_batch_failure"); clear.close();
    state = openSharedState(root);
    for (const [key, value] of old) assert.deepEqual(state.get(key), value);
    state.batch([["summary", { revision: 3 }]]); assert.deepEqual(state.get("summary"), { revision: 3 });
  } finally { await state.close(); await rm(root, { recursive: true, force: true }); }
});
