import assert from "node:assert/strict";
import test from "node:test";
import { formatHardwareDisplay, nextHardwareMode, normalizeHardwareMode } from "../src/fleet/hardware-display.ts";
import type { HardwareColumn, HardwareDisplayMode } from "../src/fleet/hardware-display.ts";

const columns: readonly HardwareColumn[] = ["nvidia", "cpu", "system"];
const modes: readonly HardwareDisplayMode[] = ["compact", "expanded"];

test("hardware modes default to compact and toggle between the reference modes", () => {
  assert.equal(normalizeHardwareMode(null), "compact");
  assert.equal(nextHardwareMode("compact"), "expanded");
  assert.equal(nextHardwareMode("expanded"), "compact");
  for (const mode of modes) {
    assert.equal(normalizeHardwareMode(mode), mode);
    assert.equal(nextHardwareMode(nextHardwareMode(mode)), mode);
  }
});

test("only the exact expanded preference enables full hardware display", () => {
  for (const value of [undefined, null, "", "EXPANDED", " expanded ", "full", "__proto__", "constructor", false, 1, {}, ["expanded"]]) {
    assert.equal(normalizeHardwareMode(value), "compact", String(value));
  }
});

test("NVIDIA compact shows the major component while retaining the precise reported driver", () => {
  for (const value of ["570.124.06", "570.124.6", "570.010.01", "570.9007199254740993.0", "570"]) {
    assert.deepEqual(formatHardwareDisplay("nvidia", value, "compact"), { text: "570", fullValue: value });
    assert.deepEqual(formatHardwareDisplay("nvidia", value, "expanded"), { text: value, fullValue: value });
  }
});

test("System compact removes only the hyphen suffix without guessing an OS name", () => {
  for (const [value, expected] of [["6.8.0-51-generic", "6.8.0"], ["6.11.0-1009-cloud", "6.11.0"], ["6.10.3", "6.10.3"]] as const) {
    assert.deepEqual(formatHardwareDisplay("system", value, "compact"), { text: expected, fullValue: value });
    assert.equal(formatHardwareDisplay("system", value, "expanded").text, value);
  }
});

test("CPU compact prioritizes the first ordinal over vendor or first token", () => {
  for (const [value, expected] of [
    ["13th Gen Intel(R) Core(TM) i9-13900K", "13th"],
    ["Intel sample 12th generation processor", "12th"],
    ["AMD sample 3rd generation processor", "3rd"],
    ["ARM sample 21st generation", "21st"],
    ["Apple sample 22ND generation", "22ND"],
    ["Intel sample 4th generation, 5th series", "4th"],
  ] as const) {
    assert.deepEqual(formatHardwareDisplay("cpu", value, "compact"), { text: expected, fullValue: value });
  }
});

test("CPU compact selects a recognized whole-word vendor when no ordinal is present", () => {
  for (const [value, expected] of [
    ["AMD Ryzen 9 7950X 16-Core Processor", "AMD"],
    ["Genuine Intel(R) Xeon(R) CPU", "Intel"],
    ["Sample ARM processor", "ARM"],
    ["Apple M3", "Apple"],
    ["Sample amd Processor", "amd"],
  ] as const) {
    assert.equal(formatHardwareDisplay("cpu", value, "compact").text, expected);
    assert.equal(formatHardwareDisplay("cpu", value, "expanded").text, value);
  }
});

test("CPU fallback uses the first whitespace token without partial ordinal or vendor matches", () => {
  for (const value of ["Qualcomm Snapdragon X Elite", "Generic\tProcessor", "Unknown\nProcessor", "IntelInside CPU", "A13th Processor", "42thread Processor"]) {
    assert.equal(formatHardwareDisplay("cpu", value, "compact").text, value.split(/\s+/)[0]);
    assert.equal(formatHardwareDisplay("cpu", value, "expanded").text, value);
  }
});

test("missing and blank hardware values remain unknown in either display mode", () => {
  for (const column of columns) {
    for (const mode of modes) {
      for (const value of [null, "", " \t\n"]) {
        assert.deepEqual(formatHardwareDisplay(column, value, mode), { text: "—", fullValue: null });
      }
    }
  }
});

test("display trims outer whitespace and preserves malformed values when abbreviation would be blank", () => {
  assert.deepEqual(formatHardwareDisplay("nvidia", "  570.124.06 \n", "expanded"), { text: "570.124.06", fullValue: "570.124.06" });
  assert.deepEqual(formatHardwareDisplay("cpu", " \tAMD Ryzen \n", "compact"), { text: "AMD", fullValue: "AMD Ryzen" });
  for (const [column, value] of [["nvidia", ".124.06"], ["system", "-generic"]] as const) {
    assert.deepEqual(formatHardwareDisplay(column, value, "compact"), { text: value, fullValue: value });
  }
});

test("colliding compact values preserve separate complete identities for sorting and details", () => {
  for (const [column, first, second] of [
    ["nvidia", "570.9.0", "570.10.0"],
    ["cpu", "AMD Ryzen 5 7600", "AMD Ryzen 9 7950X"],
    ["system", "6.8.0-9-generic", "6.8.0-10-generic"],
  ] as const) {
    const one = formatHardwareDisplay(column, first, "compact");
    const two = formatHardwareDisplay(column, second, "compact");
    assert.equal(one.text, two.text);
    assert.notEqual(one.fullValue, two.fullValue);
    assert.equal(one.fullValue, formatHardwareDisplay(column, first, "expanded").fullValue);
    assert.equal(two.fullValue, formatHardwareDisplay(column, second, "expanded").fullValue);
  }
});

test("hardware display returns plain text without interpreting markup or Unicode", () => {
  for (const column of columns) {
    for (const value of ["<b>sample</b>", "&sample;", "处理器 🧪", "0", "false"]) {
      assert.deepEqual(formatHardwareDisplay(column, value, "expanded"), { text: value, fullValue: value });
    }
  }
  assert.equal(formatHardwareDisplay("cpu", "处理器 🧪", "compact").text, "处理器");
});
