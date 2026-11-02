import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimsMarkerPresent, initializeClaimsMarker } from "../src/backend/treasury-claims-marker.ts";

test("claims initialization witness survives restart and fails closed when either retained half disappears", () => {
  const directory = mkdtempSync(join(tmpdir(), "gridlens-claim-marker-")), path = join(directory, "treasury-claims-v1.marker"), keyId = "a".repeat(64);
  try {
    assert.equal(claimsMarkerPresent(directory), false);
    assert.equal(initializeClaimsMarker(directory, "generated-server", keyId, false), true);
    assert.equal(claimsMarkerPresent(directory), true);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const original = readFileSync(path);
    assert.equal(initializeClaimsMarker(directory, "generated-server", keyId, true), false);
    assert.deepEqual(readFileSync(path), original);
    assert.throws(() => initializeClaimsMarker(directory, "generated-server", keyId, false));
    assert.throws(() => initializeClaimsMarker(directory, "changed-server", keyId, true));
    assert.throws(() => initializeClaimsMarker(directory, "generated-server", "b".repeat(64), true));
    assert.deepEqual(readFileSync(path), original);
    unlinkSync(path);
    assert.throws(() => initializeClaimsMarker(directory, "generated-server", keyId, true));
    assert.throws(() => readFileSync(path));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("claims initialization rejects corrupt, public or linked witnesses without overwriting evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "gridlens-claim-marker-")), path = join(directory, "treasury-claims-v1.marker"), keyId = "a".repeat(64);
  try {
    writeFileSync(path, "invalid retained evidence", { mode: 0o600 });
    assert.throws(() => initializeClaimsMarker(directory, "generated-server", keyId, true));
    assert.equal(readFileSync(path, "utf8"), "invalid retained evidence");
    unlinkSync(path);
    initializeClaimsMarker(directory, "generated-server", keyId, false);
    chmodSync(path, 0o644);
    assert.throws(() => initializeClaimsMarker(directory, "generated-server", keyId, true));
    const target = join(directory, "unrelated"); writeFileSync(target, "must stay unchanged", { mode: 0o600 });
    unlinkSync(path); symlinkSync(target, path);
    assert.equal(claimsMarkerPresent(directory), true);
    assert.throws(() => initializeClaimsMarker(directory, "generated-server", keyId, true));
    assert.equal(readFileSync(target, "utf8"), "must stay unchanged");
    unlinkSync(target); assert.equal(claimsMarkerPresent(directory), true, "a broken symlink cannot authorize fresh key generation");
    chmodSync(directory, 0o755);
    assert.throws(() => initializeClaimsMarker(directory, "generated-server", keyId, false));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
