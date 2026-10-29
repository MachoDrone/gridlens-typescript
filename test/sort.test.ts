// Copyright (c) 2026 MachoDrone. MIT license; see LICENSE.
import assert from "node:assert/strict";
import test from "node:test";
import { COLUMN_TYPES, DEFAULT_SORT, nextFleetSort, parseSortPreference, sortFleetRows } from "../src/fleet/sort.ts";
import type { FleetSort, SortableFleetRow, SortColumn } from "../src/fleet/sort.ts";

interface TestRow extends SortableFleetRow {
  readonly id: string;
}

function row(id: string, values: TestRow["values"] = {}, overrides: Partial<TestRow> = {}): TestRow {
  return { id, pc: "sample-pc", gpuIndex: null, containerName: "sample-container", values, ...overrides };
}

function sortedIDs(rows: readonly TestRow[], column: SortColumn, direction: FleetSort["direction"] = "asc"): string[] {
  return sortFleetRows(rows, { column, direction }).map(({ id }) => id);
}

test("column types omit Monitor HB and Host, lead with Staked NOS and keep activity columns together", () => {
  assert.deepEqual(Object.entries(COLUMN_TYPES), [
    ["stakedNos", "num"], ["status", "string"], ["pc", "string"], ["ip", "string"],
    ["hostAddress", "string"], ["sol", "num"], ["api", "string"], ["state", "string"],
    ["queued", "string"], ["duration", "num"],
    ["nodeRuntime", "num"], ["dailyUptime", "num"], ["latestJob", "string"],
    ["ram", "num"], ["disk", "num"], ["dl", "num"], ["ul", "num"],
    ["ping", "num"], ["rewards", "num"], ["nos", "num"],
    ["market", "string"], ["gpuID", "num"], ["currentNode", "string"], ["cuda", "string"],
    ["nvidia", "string"], ["cpu", "string"], ["system", "string"], ["country", "string"],
  ]);
});

test("every numeric column sorts finite values numerically and retains a measured zero", () => {
  for (const [column, kind] of Object.entries(COLUMN_TYPES)) {
    if (kind !== "num") continue;
    const rows = [row("ten", { [column]: 10 }), row("zero", { [column]: 0 }), row("two", { [column]: 2 })];
    assert.deepEqual(sortedIDs(rows, column as SortColumn), ["zero", "two", "ten"], column);
    assert.deepEqual(sortedIDs(rows, column as SortColumn, "desc"), ["ten", "two", "zero"], column);
  }
});

test("numeric missing, null, blank, non-finite and unparsed values remain unknown last in both directions", () => {
  const rows = [
    row("missing"), row("null", { sol: null }), row("blank", { sol: "  " }),
    row("nan", { sol: NaN }), row("infinity", { sol: Infinity }), row("negative-infinity", { sol: -Infinity }),
    row("numeric-string", { sol: "5" }), row("units", { sol: "10 SOL" }),
    row("zero", { sol: 0 }), row("ten", { sol: 10 }),
  ];
  const unknown = ["missing", "null", "blank", "nan", "infinity", "negative-infinity", "numeric-string", "units"];
  assert.deepEqual(sortedIDs(rows, "sol"), ["zero", "ten", ...unknown]);
  assert.deepEqual(sortedIDs(rows, "sol", "desc"), ["ten", "zero", ...unknown]);
});

test("duration uses supplied seconds and never parses a formatted label or treats missing duration as zero", () => {
  const rows = [
    row("missing"), row("formatted", { duration: "12m 30s" }),
    row("string-zero", { duration: "0" }), row("zero", { duration: 0 }),
    row("short", { duration: 59 }), row("long", { duration: 750 }),
  ];
  assert.deepEqual(sortedIDs(rows, "duration"), ["zero", "short", "long", "missing", "formatted", "string-zero"]);
  assert.deepEqual(sortedIDs(rows, "duration", "desc"), ["long", "short", "zero", "missing", "formatted", "string-zero"]);
});

test("numeric sorting preserves negative, fractional and extreme finite values", () => {
  const rows = [
    row("max", { ping: Number.MAX_VALUE }), row("fraction", { ping: 0.25 }),
    row("negative", { ping: -Number.MAX_VALUE }), row("zero", { ping: 0 }),
  ];
  assert.deepEqual(sortedIDs(rows, "ping"), ["negative", "zero", "fraction", "max"]);
  assert.deepEqual(sortedIDs(rows, "ping", "desc"), ["max", "fraction", "zero", "negative"]);
});

test("every string column uses natural numeric ordering without case distinctions", () => {
  for (const [column, kind] of Object.entries(COLUMN_TYPES)) {
    if (kind !== "string") continue;
    const rows = [row("ten", { [column]: "node10" }), row("two", { [column]: "NODE2" }), row("one", { [column]: "node1" })];
    assert.deepEqual(sortedIDs(rows, column as SortColumn), ["one", "two", "ten"], column);
    assert.deepEqual(sortedIDs(rows, column as SortColumn, "desc"), ["ten", "two", "one"], column);
  }
});

test("string missing, null, whitespace and wrong-type values stay last, including descending", () => {
  const rows = [
    row("missing"), row("null", { status: null }), row("empty", { status: "" }),
    row("blank", { status: "\t\n " }), row("number", { status: 0 }),
    row("nan", { status: NaN }), row("beta", { status: "beta" }), row("alpha", { status: "alpha" }),
  ];
  const unknown = ["missing", "null", "empty", "blank", "number", "nan"];
  assert.deepEqual(sortedIDs(rows, "status"), ["alpha", "beta", ...unknown]);
  assert.deepEqual(sortedIDs(rows, "status", "desc"), ["beta", "alpha", ...unknown]);
});

test("IP addresses compare naturally by their numeric components", () => {
  const rows = [
    row("ten", { ip: "192.0.2.10" }), row("two", { ip: "192.0.2.2" }),
    row("other", { ip: "198.51.100.1" }), row("missing"),
  ];
  assert.deepEqual(sortedIDs(rows, "ip"), ["two", "ten", "other", "missing"]);
  assert.deepEqual(sortedIDs(rows, "ip", "desc"), ["other", "ten", "two", "missing"]);
});

test("API reachability and reported State have independent sort keys", () => {
  const rows = [
    row("queued", { state: "QUEUED", api: "Online" }),
    row("running", { state: "RUNNING_JOB", api: "Offline" }),
    row("provider-unknown", { state: null, api: "Online" }),
  ];
  assert.deepEqual(sortedIDs(rows, "state", "desc"), ["running", "queued", "provider-unknown"]);
  assert.deepEqual(sortedIDs(rows, "api"), ["running", "queued", "provider-unknown"]);
  assert.deepEqual(sortedIDs(rows, "api", "desc"), ["queued", "provider-unknown", "running"]);
});

test("saved sorts for removed Host and Monitor HB columns fall back to PC order", () => {
  for (const column of ["hostSignal", "heartbeat"])
    assert.deepEqual(parseSortPreference(JSON.stringify({ column, direction: "desc" })), DEFAULT_SORT);
});

test("ties use PC, physical GPU index and container name ascending for either direction", () => {
  const rows = [
    row("pc10", { sol: 3 }, { pc: "pc10", gpuIndex: 0 }),
    row("unknown-gpu", { sol: 3 }, { pc: "PC2", gpuIndex: null, containerName: "host1" }),
    row("gpu2-name10", { sol: 3 }, { pc: "pc2", gpuIndex: 2, containerName: "host10" }),
    row("gpu2-name2", { sol: 3 }, { pc: "PC2", gpuIndex: 2, containerName: "HOST2" }),
    row("gpu0", { sol: 3 }, { pc: "pc2", gpuIndex: 0 }),
  ];
  const expected = ["gpu0", "gpu2-name2", "gpu2-name10", "unknown-gpu", "pc10"];
  assert.deepEqual(sortedIDs(rows, "sol"), expected);
  assert.deepEqual(sortedIDs(rows, "sol", "desc"), expected);
});

test("all-unknown primary values still use stable ascending identity ties", () => {
  const rows = [
    row("pc10", {}, { pc: "pc10" }), row("pc2-host10", { rewards: NaN }, { pc: "pc2", containerName: "host10" }),
    row("pc2-host2", { rewards: null }, { pc: "pc2", containerName: "host2" }),
  ];
  for (const direction of ["asc", "desc"] as const) {
    assert.deepEqual(sortedIDs(rows, "rewards", direction), ["pc2-host2", "pc2-host10", "pc10"]);
  }
});

test("unknown GPU indices follow all finite indices and then compare container names", () => {
  const rows = [
    row("nan", {}, { gpuIndex: NaN, containerName: "host10" }),
    row("infinity", {}, { gpuIndex: Infinity, containerName: "host2" }),
    row("null", {}, { gpuIndex: null, containerName: "host1" }),
    row("ten", {}, { gpuIndex: 10 }), row("zero", {}, { gpuIndex: 0 }),
  ];
  assert.deepEqual(sortedIDs(rows, "rewards", "desc"), ["zero", "ten", "null", "infinity", "nan"]);
});

test("fully equal identities preserve input order without using an unrelated row ID", () => {
  const rows = [row("z", { market: "Sample2" }), row("a", { market: "sample2" }), row("m", { market: "SAMPLE2" })];
  assert.deepEqual(sortedIDs(rows, "market"), ["z", "a", "m"]);
  assert.deepEqual(sortedIDs(rows, "market", "desc"), ["z", "a", "m"]);
  assert.deepEqual(sortedIDs(rows, "rewards", "desc"), ["z", "a", "m"]);
});

test("sorting an immutable input returns a new array and the original row objects", () => {
  const ten = Object.freeze(row("ten", Object.freeze({ sol: 10 })));
  const zero = Object.freeze(row("zero", Object.freeze({ sol: 0 })));
  const rows = Object.freeze([ten, zero]);
  const sorted = sortFleetRows(rows, { column: "sol", direction: "asc" });
  assert.notEqual(sorted, rows);
  assert.equal(sorted[0], zero);
  assert.equal(sorted[1], ten);
  assert.deepEqual(rows, [ten, zero]);
  assert.deepEqual(sortFleetRows([], DEFAULT_SORT), []);
});

test("active columns toggle direction and newly selected columns start ascending", () => {
  assert.deepEqual(DEFAULT_SORT, { column: "pc", direction: "asc" });
  assert.deepEqual(nextFleetSort(DEFAULT_SORT, "pc"), { column: "pc", direction: "desc" });
  assert.deepEqual(nextFleetSort({ column: "pc", direction: "desc" }, "pc"), DEFAULT_SORT);
  assert.deepEqual(nextFleetSort({ column: "pc", direction: "desc" }, "sol"), { column: "sol", direction: "asc" });
  assert.deepEqual(nextFleetSort({ column: "sol", direction: "asc" }, "sol"), { column: "sol", direction: "desc" });
  assert.deepEqual(nextFleetSort({ column: "sol", direction: "asc" }, "pc"), DEFAULT_SORT);
  assert.deepEqual(DEFAULT_SORT, { column: "pc", direction: "asc" });
});

test("valid preferences round-trip every known column and direction", () => {
  for (const column of Object.keys(COLUMN_TYPES)) {
    for (const direction of ["asc", "desc"]) {
      const preference = { column, direction };
      assert.deepEqual(parseSortPreference(JSON.stringify(preference)), preference);
    }
  }
});

test("absent, malformed, wrong-type and prototype-like preferences fall back safely", () => {
  for (const raw of [
    null, "", "not json", "null", "false", "42", '"pc"', "[]", "{}",
    '{"column":"pc"}', '{"direction":"asc"}', '{"column":0,"direction":"asc"}',
    '{"column":"pc","direction":false}', '{"column":"pc","direction":"DESC"}',
    '{"column":"missing","direction":"asc"}', '{"column":"constructor","direction":"asc"}',
    '{"column":"__proto__","direction":"desc"}', '{"column":"hasOwnProperty","direction":"asc"}',
    '{"column":"toString","direction":"desc"}', '{"__proto__":{"column":"pc","direction":"asc"}}',
  ]) {
    assert.deepEqual(parseSortPreference(raw), DEFAULT_SORT, String(raw));
  }
});

test("a JSON hasOwnProperty field cannot alter preference validation", () => {
  assert.deepEqual(parseSortPreference('{"column":"duration","direction":"desc","hasOwnProperty":false}'), {
    column: "duration", direction: "desc",
  });
  assert.deepEqual(parseSortPreference('{"column":"constructor","direction":"asc","hasOwnProperty":true}'), DEFAULT_SORT);
});


test("NOS sorts exact base units beyond Number precision and keeps unknown last in both directions", () => {
  const rows = [
    row("unknown", {}, { nosAmount: null }),
    row("bigger", {}, { nosAmount: "9007199254740993" }),
    row("invalid", {}, { nosAmount: "bad" }),
    row("smaller", {}, { nosAmount: "9007199254740992" }),
    row("half", {}, { nosAmount: "500000" }),
    row("below-half", {}, { nosAmount: "499999" }),
    row("zero", {}, { nosAmount: "0" }),
  ];
  assert.deepEqual(sortedIDs(rows, "nos"), ["zero", "below-half", "half", "smaller", "bigger", "unknown", "invalid"]);
  assert.deepEqual(sortedIDs(rows, "nos", "desc"), ["bigger", "smaller", "half", "below-half", "zero", "unknown", "invalid"]);
});
