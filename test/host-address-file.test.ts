import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { hostAddressFilePath, loadHostAddressFile, real200HostAddressFilePath } from "../scripts/host-address-file.ts";

function fixturePath(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "gridlens-host-address-file-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "hosts.json");
}

test("host input path uses explicit selection, environment, then the external home default", () => {
  const environment = { GRIDLENS_HOSTS_FILE: "/isolated/environment-hosts.json" };
  assert.equal(hostAddressFilePath({ hostsFile: "relative-hosts.json", environment }), resolve("relative-hosts.json"));
  assert.equal(hostAddressFilePath({ environment }), environment.GRIDLENS_HOSTS_FILE);
  assert.equal(hostAddressFilePath({ environment: {}, homeDirectory: "/isolated/home" }),
    "/isolated/home/.local/share/gridlens-typescript/hosts.json");
});

test("Real200 has its own fixed external path, independent of the supplied host file", () => {
  const environment = { GRIDLENS_HOSTS_FILE: "/isolated/supplied.json", GRIDLENS_REAL200_HOSTS_FILE: "/isolated/real200.json" };
  assert.equal(real200HostAddressFilePath({ hostsFile: "fixture-real200.json", environment }), resolve("fixture-real200.json"));
  assert.equal(real200HostAddressFilePath({ environment }), environment.GRIDLENS_REAL200_HOSTS_FILE);
  assert.equal(real200HostAddressFilePath({ environment: { GRIDLENS_HOSTS_FILE: "/isolated/supplied.json" }, homeDirectory: "/isolated/home" }),
    "/isolated/home/.local/share/gridlens-typescript/real200.json");
});

test("loader accepts unique 32-byte base58 addresses without reordering or normalization", (t) => {
  const path = fixturePath(t);
  const addresses = ["1".repeat(31) + "9", "1".repeat(32), "2".repeat(44)];
  writeFileSync(path, JSON.stringify(addresses));
  assert.deepEqual(loadHostAddressFile(path), { addresses, error: null });
  writeFileSync(path, "[]\n");
  assert.deepEqual(loadHostAddressFile(path), { addresses: [], error: null });
});

test("invalid input fails as a whole with useful diagnostics and unchanged source bytes", (t) => {
  const path = fixturePath(t);
  const address = "1".repeat(31) + "2";
  const cases: readonly [string, RegExp][] = [
    ["not JSON", /Invalid JSON/],
    [JSON.stringify({ addresses: [address] }), /JSON array/],
    [JSON.stringify(null), /JSON array/],
    [JSON.stringify([address, address]), /Entry 2 repeats/],
    ...[42, null, {}, [], "", ` ${address}`, `${address}\n`, "0".repeat(32), "O".repeat(32),
      "I".repeat(32), "l".repeat(32), "1".repeat(31), "1".repeat(33), "2".repeat(32),
      "z".repeat(44), "2".repeat(88)].map((value): [string, RegExp] => [
        JSON.stringify([address, value]), /Entry 2 must be a base58 public address decoding to 32 bytes/,
      ]),
  ];
  for (const [contents, diagnostic] of cases) {
    writeFileSync(path, contents);
    const result = loadHostAddressFile(path);
    assert.deepEqual(result.addresses, []);
    assert.match(result.error ?? "", diagnostic);
    assert.equal(readFileSync(path, "utf8"), contents);
  }
});

test("missing input is never created and diagnostics do not print file contents", (t) => {
  const path = fixturePath(t);
  assert.match(loadHostAddressFile(path).error ?? "", /Input is missing \(ENOENT\)/);
  assert.equal(existsSync(path), false);
  writeFileSync(path, "SENSITIVE INVALID FILE CONTENTS");
  assert.doesNotMatch(loadHostAddressFile(path).error ?? "", /SENSITIVE INVALID FILE CONTENTS/);
});
