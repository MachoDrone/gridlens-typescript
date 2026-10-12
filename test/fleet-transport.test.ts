import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createFleetTransport, fleetReadError, FleetTransportError } from "../src/preview/fleet-transport.ts";
import { fleetResourceURL, readFleetConfig } from "../src/preview/fleet-config.ts";
import { SYNTHETIC_HOST_ADDRESSES as addresses } from "./fixtures/host-addresses.ts";
import type { HostMetadataSnapshot } from "../src/fleet/host-metadata.ts";

const hosts = addresses.slice(0, 2);
const snapshot: HostMetadataSnapshot = { hosts: hosts.map(address => ({ address, values: null,
  fetchedAtMs: 1_000, retained: false, error: null, marketError: null })) };
const encode = (value: unknown): Uint8Array<ArrayBuffer> => new TextEncoder().encode(JSON.stringify(value) + "\n");
const meta = (values: Record<string, string>) => ({ querySelector: (query: string) => {
  const key = query.match(/name="([^"]+)"/)?.[1];
  return key && key in values ? { content: values[key] } : null;
} }) as unknown as Pick<Document, "querySelector">;

test("trusted Fleet configuration supports a same-origin prefix without URL query overrides", () => {
  const defaults = readFleetConfig(meta({}));
  assert.equal(fleetResourceURL(defaults, "jobs", "real200"), "/preview/jobs.json?scenario=real200");
  const hosted = readFleetConfig(meta({ "gridlens-api-base": "/api/fleet/", "gridlens-source-mode": "snapshot",
    "gridlens-source-label": "Local snapshot rehearsal" }));
  assert.equal(fleetResourceURL(hosted, "connection"), "/api/fleet/connection.json");
  assert.equal(fleetResourceURL(hosted, "jobs", "real200"), "/api/fleet/jobs.json");
  assert.equal(hosted.sourceLabel, "Local snapshot rehearsal");
  for (const path of ["https://example.invalid/api", "//example.invalid/api", "/a/../b", "/api?token=x", "/api#x", "/%2fapi", "/a\\b"]) {
    assert.throws(() => readFleetConfig(meta({ "gridlens-api-base": path })), /same-origin/);
  }
});

test("finite JSON and progressive snapshots share exact identity validation and original source times", async () => {
  for (const stream of [false, true]) {
    const frames: HostMetadataSnapshot[] = [];
    const transport = createFleetTransport({ fetch: async (url, init) => {
      assert.equal(url, "/api/fleet/metadata.json");
      assert.equal(init?.credentials, "same-origin");
      assert.equal(init?.redirect, "error");
      return stream ? new Response(new ReadableStream({ start(controller) {
        controller.enqueue(encode({ hosts: snapshot.hosts.slice(0, 1), complete: false }));
        controller.enqueue(encode({ ...snapshot, complete: true })); controller.close();
      } }), { headers: { "Content-Type": "application/x-ndjson" } }) : Response.json(snapshot);
    } });
    assert.deepEqual((await transport.read("metadata", "/api/fleet/metadata.json", {
      addresses: hosts, onSnapshot: value => frames.push(value),
    })).hosts, snapshot.hosts);
    assert.equal(frames.length, stream ? 2 : 1);
    assert(frames.every(frame => frame.hosts.every(record => record.fetchedAtMs === 1_000)));
  }
});

test("complete JSON and NDJSON EOF release readers without cancellation or an aborted fetch signal", async () => {
  for (const streaming of [false, true]) {
    let cancellations = 0;
    let signal: AbortSignal | undefined;
    const response = streaming ? new Response(encode({ ...snapshot, complete: true }), {
      headers: { "Content-Type": "application/x-ndjson" },
    }) : Response.json(snapshot);
    const body = response.body!;
    const originalReader = body.getReader.bind(body);
    Object.defineProperty(body, "getReader", { value: () => {
      const reader = originalReader();
      const cancel = reader.cancel.bind(reader);
      reader.cancel = reason => { cancellations++; return cancel(reason); };
      return reader;
    } });
    const transport = createFleetTransport({ fetch: async (_url, init) => {
      signal = init?.signal ?? undefined;
      return response;
    } });
    await transport.read("metadata", "/api/fleet/metadata.json", { addresses: hosts });
    assert.equal(cancellations, 0);
    assert.equal(signal?.aborted, false);
    assert.equal(body.locked, false);
  }
});

test("finite header and body stalls expire even when the fetcher or producer ignores abort", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100_000 });
  for (const headers of [false, true]) {
    let signal: AbortSignal | undefined;
    const transport = createFleetTransport({ finiteTimeoutMs: 200, fetch: async (_url, init) => {
      signal = init?.signal ?? undefined;
      return headers ? new Response(new ReadableStream(), { headers: { "Content-Type": "application/json" } })
        : new Promise<Response>(() => {});
    } });
    const pending = transport.read("metadata", "/api/fleet/metadata.json", { addresses: hosts });
    const rejected = assert.rejects(pending, /timed out/);
    await setImmediate();
    t.mock.timers.tick(200);
    await rejected;
    assert.equal(signal?.aborted, true);
  }
});

test("watch feeds use a renewable idle allowance and never renew observation timestamps", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100_000 });
  let producer!: ReadableStreamDefaultController<Uint8Array>;
  const received: HostMetadataSnapshot[] = [];
  const transport = createFleetTransport({ finiteTimeoutMs: 100, watchIdleTimeoutMs: 1_000,
    fetch: async () => new Response(new ReadableStream({ start(controller) { producer = controller;
      controller.enqueue(encode({ ...snapshot, complete: false, watching: true }));
    } }), { headers: { "Content-Type": "application/x-ndjson" } }),
  });
  const pending = transport.read("metadata", "/api/fleet/metadata.json", { addresses: hosts, onSnapshot: value => received.push(value) });
  const rejected = assert.rejects(pending, /timed out/);
  await setImmediate();
  t.mock.timers.tick(900);
  producer.enqueue(encode({ ...snapshot, complete: false, watching: true }));
  await setImmediate();
  assert.equal(received.length, 2);
  t.mock.timers.tick(999);
  await setImmediate();
  assert(received.every(value => value.hosts[0]!.fetchedAtMs === 1_000));
  t.mock.timers.tick(1);
  await rejected;
});

test("hiding a partial stream cancels immediately and no late callback can overwrite resumed work", async () => {
  let producer!: ReadableStreamDefaultController<Uint8Array>;
  const controller = new AbortController();
  const updates: unknown[] = [];
  const transport = createFleetTransport({ fetch: async () => new Response(new ReadableStream({ start(value) {
    producer = value; value.enqueue(encode({ ...snapshot, complete: false }));
  } }), { headers: { "Content-Type": "application/x-ndjson" } }) });
  const pending = transport.read("metadata", "/api/fleet/metadata.json", { addresses: hosts,
    signal: controller.signal, onSnapshot: value => updates.push(value) });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await setImmediate();
  controller.abort();
  await rejected;
  assert.equal(updates.length, 1);
  assert.throws(() => producer.enqueue(encode({ ...snapshot, complete: true })), /closed/);
});

test("invalid identities, incomplete streams, oversized JSON and invalid UTF-8 cannot become complete snapshots", async () => {
  const cases = [
    Response.json({ ...snapshot, hosts: [snapshot.hosts[0], snapshot.hosts[0]] }),
    new Response(encode({ hosts: snapshot.hosts.slice(0, 1), complete: false }), { headers: { "Content-Type": "application/x-ndjson" } }),
    new Response(new Uint8Array([0xff]), { headers: { "Content-Type": "application/json" } }),
    new Response(" ".repeat(2_049), { headers: { "Content-Type": "application/json" } }),
  ];
  for (const response of cases) {
    const transport = createFleetTransport({ responseByteLimit: 2_048, fetch: async () => response });
    await assert.rejects(transport.read("metadata", "/api/fleet/metadata.json", { addresses: hosts }));
  }
});

test("rosters reject duplicates and access failures produce bounded session text", async () => {
  const transport = createFleetTransport({ fetch: async () => Response.json({ addresses: [hosts[0], hosts[0]], error: null }) });
  await assert.rejects(transport.roster("/api/fleet/hosts.json"), /roster is invalid/);
  const denied = createFleetTransport({ fetch: async () => new Response("private server diagnostic", { status: 403 }) });
  await assert.rejects(denied.roster("/api/fleet/hosts.json"), error => {
    assert(error instanceof FleetTransportError);
    assert.match(fleetReadError(error, "Fallback"), /not authorized/);
    assert(!error.message.includes("private"));
    return true;
  });
  await assert.rejects(transport.roster("//example.invalid/hosts.json"), /same-origin/);
});
