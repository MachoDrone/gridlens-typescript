import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { framedSudoInput } from "../src/backend/sudo-input.ts";

test("sudo prompt consumption and cached/NOPASSWD paths deliver identical binary payloads", () => {
  const bytes = randomBytes(1024 * 1024), expected = createHash("sha256").update(bytes).digest("hex");
  const password = "generated password with 'quotes' and $literal symbols";
  const frame = framedSudoInput("/usr/bin/sha256sum", bytes, password);
  assert.equal(frame.command.includes(password), false); assert.equal(frame.script.includes(password), false);
  for (const input of [frame.input, frame.input.subarray(frame.input.indexOf(10) + 1)]) {
    const result = spawnSync("/bin/sh", ["-c", frame.script], { input, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.split(/\s/)[0], expected); assert.equal(result.stderr, "");
  }
  const invalid = spawnSync("/bin/sh", ["-c", frame.script], { input: Buffer.from("wrong\nwrong\n"), encoding: "utf8", timeout: 5000 });
  assert.equal(invalid.status, 64); assert.equal(invalid.stdout, "");
});
test("passwordless sudo and empty command input preserve EOF without leaking framing", () => {
  const frame = framedSudoInput("/usr/bin/sha256sum", undefined, ""), expected = createHash("sha256").update("").digest("hex");
  for (const input of [frame.input, frame.input.subarray(1)]) {
    const result = spawnSync("/bin/sh", ["-c", frame.script], { input, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0); assert.equal(result.stdout.split(/\s/)[0], expected);
  }
  assert.throws(() => framedSudoInput("/usr/bin/true", "", "two\nlines"));
});
