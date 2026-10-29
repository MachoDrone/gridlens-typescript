import assert from "node:assert/strict";
import test from "node:test";
import { browserConnectionText, privateBrowserConnectionText } from "../src/installer/browser-connection.ts";

const now = 1_800_000_000_000;
const code = "Abc123_-XYZ9";
const raw = JSON.stringify({ version: 1, code, expiresAtMs: now + 300_000, serverId: "not-for-human-output" });
test("private-network browser entry is a permanent ordinary address without pairing data", () => {
  const text = privateBrowserConnectionText("http://192.168.42.10:2342");
  assert.equal(text.split("\n")[0], "OPEN GRIDLENS: http://192.168.42.10:2342/");
  assert.doesNotMatch(text, /#|\?|code|minute|expire|sign.in/i);
  for (const origin of ["http://8.8.8.8:2342", "http://192.168.42.10:2342/path", "http://user@192.168.42.10:2342", "https://192.168.42.10:2342"])
    assert.throws(() => privateBrowserConnectionText(origin));
});
test("browser handoff uses the exact saved endpoint and keeps the code in a fragment", () => {
  for (const origin of ["http://192.168.42.10:2342", "https://192.168.42.10:2341", "http://[fd42::10]:2342"]) {
    const result = browserConnectionText(origin, raw, true, now);
    const url = new URL(result.split("\n")[0]!.slice("OPEN GRIDLENS: ".length));
    assert.equal(url.origin, origin); assert.equal(url.pathname, "/connect");
    assert.equal(url.hash, `#code=${code}`); assert.equal(url.search, "");
    assert.ok(!result.includes("serverId") && !result.includes("not-for-human-output"));
  }
});
test("old browser builds receive a labeled code instead of JSON or an unsupported automatic link", () => {
  const result = browserConnectionText("https://192.168.42.10:2341", raw, false, now);
  assert.ok(result.includes(`Connection code: ${code}`)); assert.ok(!result.includes("#code="));
});
test("invalid origins and expired or malformed codes never reach terminal output", () => {
  for (const origin of ["https://8.8.8.8:2341", "http://0.0.0.0:2342", "http://user@192.168.42.10:2342", "http://192.168.42.10:2342/path", "http://192.168.42.10:2342?code=secret"])
    assert.throws(() => browserConnectionText(origin, raw, true, now));
  for (const input of ["null", "{}", "not json", JSON.stringify({ version: 1, code, expiresAtMs: now }), JSON.stringify({ version: 1, code: "bad\ncode", expiresAtMs: now + 30_000 })])
    assert.throws(() => browserConnectionText("http://192.168.42.10:2342", input, true, now));
});
