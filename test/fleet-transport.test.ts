import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createFleetTransport, fleetReadError, FleetTransportError } from "../src/preview/fleet-transport.ts";
import { fleetResourceURL, readFleetConfig } from "../src/preview/fleet-config.ts";
import { SYNTHETIC_HOST_ADDRESSES as addresses } from "./fixtures/host-addresses.ts";
import type { HostMetadataSnapshot } from "../src/fleet/host-metadata.ts";
import { createEvidenceClock } from "../src/preview/evidence-clock.ts";

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

test("validated roster, finite and streamed server times arrive before source processing without changing observations", async () => {
  const events: string[] = [];
  const responses = [
    Response.json({ addresses: hosts, error: null, serverTimeMs: 2_000 }),
    Response.json({ ...snapshot, serverTimeMs: 3_000 }),
    new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encode({ hosts: snapshot.hosts.slice(0, 1), serverTimeMs: 4_000, complete: false }));
      controller.enqueue(encode({ ...snapshot, serverTimeMs: 5_000, complete: true }));
      controller.close();
    } }), { headers: { "Content-Type": "application/x-ndjson" } }),
  ];
  const transport = createFleetTransport({ fetch: async () => responses.shift()!, onServerTime: time => events.push(`time:${time}`) });
  assert.deepEqual(await transport.roster("/preview/hosts.json"), { addresses: hosts, error: null });
  for (let index = 0; index < 2; index++) {
    const result = await transport.read("metadata", "/preview/metadata.json", {
      addresses: hosts, onSnapshot: (_value, complete) => events.push(`snapshot:${complete}`),
    });
    assert.deepEqual(result.hosts, snapshot.hosts);
  }
  assert.deepEqual(events, ["time:2000", "time:3000", "snapshot:true", "time:4000", "snapshot:false", "time:5000", "snapshot:true"]);
});

test("missing server times preserve compatibility while malformed metadata rejects without calibration", async () => {
  const times: number[] = [];
  for (const value of [undefined, null, "1000", -1, 1.5, 8_640_000_000_000_001]) {
    for (const roster of [false, true]) {
      const payload = roster ? { addresses: hosts, error: null } : snapshot;
      const transport = createFleetTransport({ onServerTime: time => times.push(time),
        fetch: async () => Response.json({ ...payload, ...(value === undefined ? {} : { serverTimeMs: value }) }),
      });
      const pending = roster ? transport.roster("/preview/hosts.json")
        : transport.read("metadata", "/preview/metadata.json", { addresses: hosts });
      if (value === undefined) await pending;
      else await assert.rejects(pending, /invalid server time/);
    }
  }
  assert.deepEqual(times, []);
});

test("rejected, failed and unauthorized data or roster responses never calibrate the clock", async () => {
  const times: number[] = [];
  const responses = [
    Response.json({ ...snapshot, hosts: [snapshot.hosts[0], snapshot.hosts[0]], serverTimeMs: 2_000 }),
    Response.json({ ...snapshot, failed: true, serverTimeMs: 2_000 }),
    Response.json({ ...snapshot, serverTimeMs: 2_000 }, { status: 403 }),
  ];
  for (const response of responses) {
    const transport = createFleetTransport({ fetch: async () => response, onServerTime: time => times.push(time) });
    await assert.rejects(transport.read("metadata", "/preview/metadata.json", { addresses: hosts }));
  }
  for (const [status, error, addresses] of [[200, "Input unavailable", hosts], [503, "Input unavailable", hosts],
    [403, null, hosts], [200, null, [hosts[0], hosts[0]]]] as const) {
    const transport = createFleetTransport({ onServerTime: time => times.push(time),
      fetch: async () => Response.json({ addresses, error, serverTimeMs: 2_000 }, { status }) });
    const pending = transport.roster("/preview/hosts.json");
    if (status === 403 || error === null) await assert.rejects(pending);
    else assert.equal((await pending).error, error);
  }
  assert.deepEqual(times, []);
});

test("canceled roster/data responses and superseded reads cannot publish late clock samples", async () => {
  for (const kind of ["roster", "data", "superseded"] as const) {
    const controller = new AbortController();
    let active = true;
    let release!: (response: Response) => void;
    const times: number[] = [];
    const transport = createFleetTransport({ onServerTime: time => times.push(time),
      fetch: async () => new Promise<Response>(resolve => { release = resolve; }),
    });
    const pending = kind === "roster" ? transport.roster("/preview/hosts.json", controller.signal)
      : transport.read("metadata", "/preview/metadata.json", {
        addresses: hosts, signal: controller.signal, current: () => active,
      });
    const rejected = assert.rejects(pending, { name: "AbortError" });
    if (kind === "superseded") active = false;
    else controller.abort();
    release(Response.json({ ...(kind === "roster" ? { addresses: hosts, error: null } : snapshot), serverTimeMs: 2_000 }));
    await rejected;
    assert.deepEqual(times, []);
  }
});

test("a malformed or failed watch frame cannot replace its earlier accepted server reference", async () => {
  for (const failure of [{ serverTimeMs: "9000" }, { serverTimeMs: 9_000, failed: true },
    { serverTimeMs: 9_000, hosts: [snapshot.hosts[0], snapshot.hosts[0]] }]) {
    const times: number[] = [];
    const transport = createFleetTransport({ onServerTime: time => times.push(time), fetch: async () => new Response(
      new ReadableStream({ start(controller) {
        controller.enqueue(encode({ ...snapshot, complete: false, watching: true, serverTimeMs: 2_000 }));
        controller.enqueue(encode({ ...snapshot, complete: true, ...failure }));
        controller.close();
      } }), { headers: { "Content-Type": "application/x-ndjson" } }),
    });
    await assert.rejects(transport.read("metadata", "/preview/metadata.json", { addresses: hosts }));
    assert.deepEqual(times, [2_000]);
  }
});

test("a roster canceled during its body cannot calibrate from partial response data", async () => {
  const abort = new AbortController();
  let producer!: ReadableStreamDefaultController<Uint8Array>;
  const times: number[] = [];
  const transport = createFleetTransport({ onServerTime: time => times.push(time), fetch: async () => new Response(
    new ReadableStream({ start(controller) {
      producer = controller;
      controller.enqueue(new TextEncoder().encode('{"serverTimeMs":2000,'));
    } }), { headers: { "Content-Type": "application/json" } }),
  });
  const pending = transport.roster("/preview/hosts.json", abort.signal);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await setImmediate();
  abort.abort();
  await rejected;
  assert.deepEqual(times, []);
  assert.throws(() => producer.enqueue(encode({ addresses: hosts, error: null })), /closed/);
});

test("clock transit samples include headers and complete finite bodies for roster and data reads", async () => {
  for (const roster of [false, true]) {
    let elapsed = 100;
    let producer!: ReadableStreamDefaultController<Uint8Array>;
    const times: [number, number][] = [];
    const payload = { ...(roster ? { addresses: hosts, error: null } : snapshot), serverTimeMs: 2_000 };
    const bytes = encode(payload);
    const transport = createFleetTransport({ now: () => elapsed, onServerTime: (time, transit) => times.push([time, transit]),
      fetch: async () => {
        elapsed = 400;
        return new Response(new ReadableStream({ start(controller) {
          producer = controller;
          controller.enqueue(bytes.slice(0, 10));
        } }), { headers: { "Content-Type": "application/json" } });
      },
    });
    const pending = roster ? transport.roster("/preview/hosts.json")
      : transport.read("metadata", "/preview/metadata.json", { addresses: hosts });
    await setImmediate();
    assert.deepEqual(times, [], "partial bodies cannot supply calibration");
    elapsed = 900;
    producer.enqueue(bytes.slice(10));
    producer.close();
    await pending;
    assert.deepEqual(times, [[2_000, 800]]);
  }
});

test("buffered stream frames measure from this request's dispatch rather than resetting at prior progress", async () => {
  let elapsed = 100;
  let producer!: ReadableStreamDefaultController<Uint8Array>;
  const times: [number, number][] = [];
  const transport = createFleetTransport({ now: () => elapsed, onServerTime: (time, transit) => times.push([time, transit]),
    fetch: async () => {
      elapsed = 200;
      return new Response(new ReadableStream({ start(controller) {
        producer = controller;
        controller.enqueue(encode({ ...snapshot, complete: false, watching: true, serverTimeMs: 2_000 }));
      } }), { headers: { "Content-Type": "application/x-ndjson" } });
    },
  });
  const pending = transport.read("metadata", "/preview/metadata.json", { addresses: hosts });
  await setImmediate();
  assert.deepEqual(times, [[2_000, 100]]);
  elapsed = 15_000;
  const buffered = [
    { ...snapshot, complete: false, watching: true, serverTimeMs: 3_000 },
    { ...snapshot, complete: true, serverTimeMs: 4_000 },
  ].map(value => JSON.stringify(value) + "\n").join("");
  producer.enqueue(new TextEncoder().encode(buffered));
  producer.close();
  await pending;
  assert.deepEqual(times, [[2_000, 100], [3_000, 14_900], [4_000, 14_900]]);
});

test("concurrent responses use their own request starts despite finishing out of order", async () => {
  let elapsed = 100;
  const release: ((response: Response) => void)[] = [];
  const times: [number, number][] = [];
  const transport = createFleetTransport({ now: () => elapsed, onServerTime: (time, transit) => times.push([time, transit]),
    fetch: async () => new Promise<Response>(resolve => { release.push(resolve); }),
  });
  const first = transport.read("metadata", "/preview/metadata.json", { addresses: hosts });
  elapsed = 150;
  const second = transport.read("metadata", "/preview/metadata.json", { addresses: hosts });
  elapsed = 200;
  release[1]!(Response.json({ ...snapshot, serverTimeMs: 3_000 }));
  await second;
  elapsed = 500;
  release[0]!(Response.json({ ...snapshot, serverTimeMs: 2_000 }));
  await first;
  assert.deepEqual(times, [[3_000, 50], [2_000, 400]]);
});

test("slow initial transport calibration exposes conservative freshness without adding transit to the epoch estimate", async () => {
  let elapsed = 0;
  const clock = createEvidenceClock({ monotonicNow: () => elapsed });
  const transport = createFleetTransport({ now: () => elapsed,
    onServerTime: (time, transit) => { clock.accept(time, transit); },
    fetch: async () => {
      elapsed = 35_000;
      return Response.json({ addresses: hosts, error: null, serverTimeMs: 100_000 });
    },
  });
  await transport.roster("/preview/hosts.json");
  assert.equal(clock.now(), 100_000);
  assert.equal(clock.freshnessNow(), 135_000);
});

test("invalid elapsed transport intervals reject before calibration or publication", async () => {
  for (const invalid of [5, NaN, Infinity]) {
    let elapsed = 10;
    const samples: number[] = [];
    let publications = 0;
    const transport = createFleetTransport({ now: () => elapsed, onServerTime: time => samples.push(time),
      fetch: async () => { elapsed = invalid; return Response.json({ ...snapshot, serverTimeMs: 2_000 }); },
    });
    await assert.rejects(transport.read("metadata", "/preview/metadata.json", { addresses: hosts,
      onSnapshot: () => { publications++; } }), /invalid elapsed timing/);
    assert.deepEqual(samples, []);
    assert.equal(publications, 0);
  }
});
