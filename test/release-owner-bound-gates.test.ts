import assert from "node:assert/strict";
import test from "node:test";
import { additionalReleaseAcceptances, validateAcceptanceReport } from "../scripts/release/acceptance.ts";
import { selectVerificationTests } from "../scripts/verification-groups.ts";

test("protected runtime requires guardian/updater recovery proof even with no source changes", () => {
  assert.deepEqual(selectVerificationTests([], [], true).requiredAcceptances, []);
  assert.deepEqual(additionalReleaseAcceptances({ enableWallet: true, treasuryProtocol: 1 }), []);
  assert.deepEqual(additionalReleaseAcceptances({ enableWallet: false }), []);
  for (const config of [{ enableWallet: true }, { enableWallet: true, treasuryProtocol: 2 as const }]) {
    const required = additionalReleaseAcceptances(config);
    for (const proof of ["docker-owner-bound", "docker-updater", "docker-shared", "docker-claim-units", "docker-claims-shutdown", "public-installer"]) assert.ok(required.includes(proof as never));
  }
});
test("owner-bound receipt must bind candidate and actual independent-owner/replay/history proof", () => {
  const image = `sha256:${"a".repeat(64)}`;
  const report = { passed: true, cleanupErrors: [], candidateImageId: image, network: "none", liveApiRequests: 0, existingWalletKeyAccess: false,
    ownerTransferValidated: true, foreignOwnerRejected: true, replayRejected: true, historyPreserved: true, claimAckRecovered: true };
  validateAcceptanceReport("docker-owner-bound", report, [image]);
  for (const field of ["ownerTransferValidated", "foreignOwnerRejected", "replayRejected", "historyPreserved", "claimAckRecovered"]) {
    assert.throws(() => validateAcceptanceReport("docker-owner-bound", { ...report, [field]: false }, [image]));
  }
  assert.throws(() => validateAcceptanceReport("docker-owner-bound", report, [`sha256:${"b".repeat(64)}`]));
  assert.throws(() => validateAcceptanceReport("docker-owner-bound", { ...report, existingWalletKeyAccess: true }, [image]));
});
