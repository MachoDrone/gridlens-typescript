import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createIntegration } from "../scripts/local-integration.ts";
import type { IncomingMessage } from "node:http";

test("the explicit local hosting rehearsal persists only synthetic snapshots and restart never refreshes their dates", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-hosting-lab-"));
  const previousStore = process.env.GRIDLENS_LAB_STORE;
  const previousAge = process.env.GRIDLENS_LAB_AGE_SECONDS;
  process.env.GRIDLENS_LAB_STORE = directory;
  process.env.GRIDLENS_LAB_AGE_SECONDS = "259200";
  t.after(async () => {
    if (previousStore === undefined) delete process.env.GRIDLENS_LAB_STORE; else process.env.GRIDLENS_LAB_STORE = previousStore;
    if (previousAge === undefined) delete process.env.GRIDLENS_LAB_AGE_SECONDS; else process.env.GRIDLENS_LAB_AGE_SECONDS = previousAge;
    await rm(directory, { recursive: true, force: true });
  });
  const request = { socket: { remoteAddress: "127.0.0.1" } } as IncomingMessage;
  const first = await createIntegration();
  const context = await first.resolveAccess(request);
  assert(context);
  assert.match(first.label!, /synthetic/);
  assert.equal(first.demonstration, true);
  const original = await first.source.read("jobs", context, new AbortController().signal);
  assert(original.hosts[0]!.checkedAtMs! < Date.now() - 2 * 86_400_000);
  assert.equal(await first.resolveAccess({ socket: { remoteAddress: "192.0.2.1" } } as IncomingMessage), null);
  await first.close?.();
  delete process.env.GRIDLENS_LAB_AGE_SECONDS;
  const second = await createIntegration();
  const restored = await second.source.read("jobs", context, new AbortController().signal);
  assert.deepEqual(restored.hosts, original.hosts);
  assert.match(await readFile(join(directory, ".gridlens-hosting-lab"), "utf8"), /isolated hosting lab/);
  await second.close?.();
});

test("the hosting rehearsal refuses to add synthetic readings to an unmarked existing directory", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-hosting-unmarked-"));
  const previous = process.env.GRIDLENS_LAB_STORE;
  process.env.GRIDLENS_LAB_STORE = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.GRIDLENS_LAB_STORE; else process.env.GRIDLENS_LAB_STORE = previous;
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(join(directory, "existing.txt"), "preserved");
  await assert.rejects(createIntegration(), /empty directory/);
  assert.equal(await readFile(join(directory, "existing.txt"), "utf8"), "preserved");
});
