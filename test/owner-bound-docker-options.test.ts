import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Script } from "node:vm";
import { fixtureGuardianArguments, ownerBoundDockerOptions, runOwnerBoundDocker } from "../scripts/test-owner-bound-docker.ts";
import { ownerBoundSourceFixture, ownerBoundGuardianFixture, ownerBoundClaimFixture } from "./fixtures/owner-bound-docker.ts";
import type { DockerRunner } from "../src/installer/docker.ts";

const instance = "fixture-123456abcdef", container = `gridlens-modern-${instance}-guardian`, volume = `gridlens-modern-${instance}-guardian-state`, image = "sha256:" + "a".repeat(64);
test("owner-bound acceptance accepts only explicit bounded fixture options", () => {
  assert.deepEqual(ownerBoundDockerOptions(["--image", image, "--instance", instance, "--report", "/tmp/generated.json"]), { image, instance, report: "/tmp/generated.json" });
  for (const args of [[], ["--image"], ["--image", "--privileged"], ["--image", image, "--image", image], ["--image", image, "--instance", "default"],
    ["--image", image, "--docker-host", "unreviewed"], ["--image", "bad;command"], ["--image", image, "--instance", "fixture-123"]]) assert.throws(() => ownerBoundDockerOptions(args));
});
test("only fixed guardian exec and explicit fixture inspection names can reach Docker", () => {
  assert.deepEqual(fixtureGuardianArguments("/usr/bin/docker exec -i gridlens-financial-guardian node /app/scripts/source-guardian.ts dispatch", container, volume, image),
    ["exec", "-i", container, "node", "/app/scripts/source-guardian.ts", "dispatch"]);
  assert.deepEqual(fixtureGuardianArguments(`/usr/bin/docker 'container' 'inspect' '${container}'`, container, volume, image), ["container", "inspect", container]);
  assert.deepEqual(fixtureGuardianArguments(`/usr/bin/docker 'volume' 'inspect' '${volume}'`, container, volume, image), ["volume", "inspect", volume]);
  assert.deepEqual(fixtureGuardianArguments(`/usr/bin/docker 'image' 'inspect' '${image}'`, container, volume, image), ["image", "inspect", image]);
  for (const command of ["/usr/bin/docker exec gridlens-financial-guardian node -e 'arbitrary'", "/usr/bin/docker stop unrelated", "/usr/bin/docker volume inspect unrelated",
    "/usr/bin/docker exec gridlens-financial-guardian node /app/scripts/source-guardian.ts provision", "/usr/bin/docker exec gridlens-financial-guardian node /app/scripts/source-guardian.ts status;id",
    "/usr/bin/docker 'container' 'inspect' '$(id)'", "/usr/bin/docker exec -i another-guardian node /app/scripts/source-guardian.ts dispatch"])
    assert.throws(() => fixtureGuardianArguments(command, container, volume, image));
  assert.throws(() => fixtureGuardianArguments("/usr/bin/docker exec gridlens-financial-guardian node /app/scripts/source-guardian.ts status", "gridlens-financial-guardian", volume, image));
});
test("invalid report destinations stop before Docker, generated authority creation or output writes", async () => {
  let calls = 0; const runner: DockerRunner = { run() { calls++; throw Error("Docker must not run"); } };
  await assert.rejects(runOwnerBoundDocker({ image, report: resolve("generated-private-evidence.json") }, runner), /outside/);
  assert.equal(calls, 0); assert.equal(existsSync(resolve("generated-private-evidence.json")), false);
  const root = mkdtempSync(join(tmpdir(), "gridlens-owner-bound-options-"));
  try {
    const report = join(root, "existing.json"); writeFileSync(report, "generated previous evidence");
    await assert.rejects(runOwnerBoundDocker({ image, report }, runner), /prior acceptance/);
    symlinkSync(resolve("."), join(root, "checkout-link"));
    await assert.rejects(runOwnerBoundDocker({ image, report: join(root, "checkout-link/forbidden.json") }, runner), /outside/);
    assert.equal(calls, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("all container fixture closures serialize as self-contained JavaScript without executing host paths", () => {
  for (const runtime of [ownerBoundSourceFixture, ownerBoundGuardianFixture, ownerBoundClaimFixture]) new Script(`(${runtime.toString()})`);
});
