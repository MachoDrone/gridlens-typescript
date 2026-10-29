import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCountry, normalizeCountryMode } from "../src/fleet/country-display.ts";
import { sortFleetRows } from "../src/fleet/sort.ts";
import { sampleCountry } from "../src/preview/fixtures.ts";

test("country codes expand without shortening free-form reports or inventing missing geography", () => {
  assert.deepEqual(formatCountry(" us ", "compact"), { text: "US", fullName: "United States" });
  assert.deepEqual(formatCountry("nl", "full"), { text: "Netherlands", fullName: "Netherlands" });
  for (const value of ["Netherlands", "Example country report", "ZZ", "QQ", "USA", "001"]) {
    for (const mode of ["compact", "full"] as const) {
      assert.deepEqual(formatCountry(value, mode), { text: value, fullName: value });
    }
  }
  for (const value of [null, undefined, "", "  "]) {
    assert.deepEqual(formatCountry(value, "compact"), { text: "—", fullName: null });
  }
});

test("country sorting uses full names in both modes and keeps unknowns last in both directions", () => {
  for (const mode of ["compact", "full"] as const) {
    const countries = ["CH", null, "SE", "DE", undefined];
    const rows = countries.map((country, index) => ({ country, pc: "", gpuIndex: null, containerName: String(index),
      values: { country: formatCountry(country, mode).fullName } }));
    assert.deepEqual(sortFleetRows(rows, { column: "country", direction: "asc" }).map(row => row.country),
      ["DE", "SE", "CH", null, undefined]);
    assert.deepEqual(sortFleetRows(rows, { column: "country", direction: "desc" }).map(row => row.country),
      ["CH", "SE", "DE", null, undefined]);
  }
});

test("country defaults to compact and synthetic country examples never map arbitrary host identities", () => {
  assert.equal(normalizeCountryMode("full"), "full");
  for (const value of [null, undefined, "compact", "expanded", "FULL", {}, true]) {
    assert.equal(normalizeCountryMode(value), "compact");
  }
  assert.equal(sampleCountry("sample-host-1-1"), "US");
  assert.equal(sampleCountry("sample-host-1-3"), "US");
  assert.equal(sampleCountry("sample-host-3-1"), null);
  assert.equal(sampleCountry("sample-host-5-1"), "Canada");
  assert.equal(sampleCountry("1".repeat(32)), null);
});
