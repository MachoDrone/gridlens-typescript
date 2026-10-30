import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadArtifactToFile } from "../src/installer/artifact-download.ts";
const base = "https://github.com/MachoDrone/gridlens-typescript/releases/download/modern-v0.1.0-fixture/";
const content = Buffer.from("generated archive fixture");
const artifact = { name: "gridlens-runtime-fixture.tar", bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") };
const fake = (fn: (url: string, options?: RequestInit) => Response | Promise<Response>): typeof fetch => async (url, options) => fn(String(url), options);
function directory(t: import("node:test").TestContext): string { const path = mkdtempSync(join(tmpdir(), "gridlens-download-")); t.after(() => rmSync(path, { recursive: true, force: true })); return path; }
test("terminal archive is streamed into its verified file with bounded redirect policy", async t => {
  const dir = directory(t); let requests = 0, pulls = 0;
  const fetcher = fake((url, options) => {
    assert.equal(options?.redirect, "manual"); requests++;
    if (requests === 1) return new Response(null, { status: 302, headers: { Location: "https://release-assets.githubusercontent.com/fixture" } });
    assert.equal(url, "https://release-assets.githubusercontent.com/fixture");
    return new Response(new ReadableStream<Uint8Array>({ pull(controller) { if (pulls === content.length) controller.close(); else controller.enqueue(content.subarray(pulls, ++pulls)); } }));
  });
  const path = await downloadArtifactToFile(base, artifact, dir, { fetcher });
  assert.deepEqual(readFileSync(path), content); assert.equal(pulls, content.length); assert.equal(requests, 2);
});
test("truncated oversized corrupt and aborted archives leave no loadable partial file", async t => {
  for (const body of [content.subarray(1), Buffer.concat([content, Buffer.from("extra")]), Buffer.alloc(content.length)]) {
    const dir = directory(t); await assert.rejects(downloadArtifactToFile(base, artifact, dir, { fetcher: fake(() => new Response(body)) })); assert.deepEqual(readdirSync(dir), []);
  }
  const dir = directory(t), controller = new AbortController();
  await assert.rejects(downloadArtifactToFile(base, artifact, dir, { signal: controller.signal, fetcher: fake(() => new Response(new ReadableStream({ pull(stream) { stream.enqueue(content.subarray(0, 1)); controller.abort(); } }))) }));
  assert.deepEqual(readdirSync(dir), []);
});
test("external redirect and an existing file are rejected without replacement", async t => {
  const dir = directory(t); let requests = 0;
  await assert.rejects(downloadArtifactToFile(base, artifact, dir, { fetcher: fake(() => { requests++; return new Response(null, { status: 302, headers: { Location: "https://untrusted.invalid/archive" } }); }) }), /outside/);
  assert.equal(requests, 1); assert.deepEqual(readdirSync(dir), []);
  writeFileSync(join(dir, artifact.name), "existing");
  await assert.rejects(downloadArtifactToFile(base, artifact, dir, { fetcher: fake(() => new Response(content)) }));
  assert.equal(readFileSync(join(dir, artifact.name), "utf8"), "existing");
});
test("redirect to a nonstandard HTTPS port is rejected after cancelling its body", async t => {
  const dir = directory(t); let requests = 0, cancelled = false;
  await assert.rejects(downloadArtifactToFile(base, artifact, dir, { fetcher: fake(() => {
    requests++; return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 302,
      headers: { Location: "https://github.com:8443/fixture" } });
  }) }), /outside/);
  assert.equal(requests, 1); assert.equal(cancelled, true); assert.deepEqual(readdirSync(dir), []);
});
