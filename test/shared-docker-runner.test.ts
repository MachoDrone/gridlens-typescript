import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { test } from "node:test";
import { acceptanceOptions, interruptGatewayOnce, runDockerAcceptance, withFixtureIngress } from "../scripts/test-shared-docker.ts";
import { dockerFixtureProgram } from "../scripts/shared-docker-fixture.ts";
import { PRODUCT, PRODUCT_LABEL, INSTANCE_LABEL, resourceName } from "../src/installer/docker.ts";
import type { DockerRunner } from "../src/installer/docker.ts";

const instance = "fixture-123456abcdef", image = "sha256:" + "a".repeat(64);
test("Docker acceptance options permit an explicit prebuilt image and loopback port but reject unrelated namespaces", () => {
  const options = acceptanceOptions(["--instance", instance, "--port", "18443", "--prebuilt-image", image, "--prebuilt-version", "0.1.0-candidate"]);
  assert.equal(options.instance, instance); assert.equal(options.port, 18443); assert.equal(options.prebuiltImage, image);
  for (const args of [["--instance", "existing-lab"], ["--port", "80"], ["--port", "18443", "--port", "18444"],
    ["--prebuilt-image", "mutable:latest"], ["--prebuilt-version", "0.1.0"], ["--network", "host"]]) assert.throws(() => acceptanceOptions(args));
});

test("fixture program is serializable and cannot select another instance, operation or state directory", () => {
  const source = dockerFixtureProgram({ instance, operation: "seed" }); new Script(source);
  assert(source.includes('"collector/schedule"')); assert(source.includes("FLEET_RESOURCES.map")); assert(source.includes("7 * 86_400_000"));
  assert(source.includes('openSharedState("/state", { ledgerDirectory: "/ledger" })'));
  assert.throws(() => dockerFixtureProgram({ instance: "operator", operation: "seed" }));
  assert.throws(() => dockerFixtureProgram({ instance, operation: "reset" as "seed" }));
});

test("interruption injection targets one exact fixture gateway creation and preserves other commands", () => {
  const calls: readonly string[][] = [];
  const collected = calls as string[][];
  const runner = interruptGatewayOnce({ run(args) { collected.push([...args]); return { status: 0, stdout: "ok", stderr: "" }; } }, instance);
  runner.run(["run", "--name", "unrelated"]);
  assert.throws(() => runner.run(["run", "--name", resourceName(instance, "gateway")]), /Injected fixture interruption/);
  runner.run(["run", "--name", resourceName(instance, "gateway")]); assert.equal(calls.length, 2);
});

test("real-runner failure reporting preserves its primary error when exact-fixture cleanup also fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-docker-runner-")), report = join(directory, "report.json");
  let networkCreated = false;
  const calls: string[][] = [];
  const runner: DockerRunner = { run(args) {
    calls.push([...args]);
    if (args[0] === "version") return { status: 0, stdout: "fixture-daemon", stderr: "" };
    if (args[0] === "image" && args[1] === "inspect") throw new Error("Primary generated fixture failure");
    if (args[0] === "network" && args[1] === "create") { networkCreated = true; return { status: 0, stdout: "fixture-network", stderr: "" }; }
    if (args[0] === "network" && args[1] === "inspect" && networkCreated) return { status: 0,
      stdout: JSON.stringify([{ Labels: { [PRODUCT_LABEL]: PRODUCT, [INSTANCE_LABEL]: instance } }]), stderr: "" };
    if (args[1] === "inspect") return { status: 1, stdout: "", stderr: `No such ${args[0]}` };
    if (networkCreated && (args[0] === "volume" && args[1] === "ls" || args[0] === "network" && args[1] === "rm")) return { status: 1, stdout: "", stderr: "Generated cleanup failure" };
    return { status: 0, stdout: "", stderr: "" };
  } };
  try {
    await assert.rejects(runDockerAcceptance({ instance, port: 18443, prebuiltImage: image, report }, runner), /Primary generated fixture failure/);
    const result = JSON.parse(await readFile(report, "utf8"));
    assert.equal(result.failure, "Primary generated fixture failure"); assert.equal(result.cleanupErrors.length, 3);
    assert.deepEqual(result.failureDiagnostics, { owner: { present: false }, gateway: { present: false } });
    for (const command of calls.filter(args => args[0] === "stop" || args[0] === "rm" || args[1] === "rm")) assert(command.at(-1)!.startsWith(`gridlens-modern-${instance}-`));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("fixture ingress is attached only to the gateway on create/restart while owner egress stays blocked", () => {
  const internal = resourceName(instance, "network"), ingress = resourceName(instance, "acceptance-ingress");
  const owner = resourceName(instance, "owner"), gateway = resourceName(instance, "gateway");
  const memberships = new Map([[owner, [internal]], [gateway, [internal]]]), connects: string[] = [];
  const runner = withFixtureIngress({ run(args) {
    if (args[0] === "container" && args[1] === "inspect") return { status: 0, stderr: "", stdout: JSON.stringify([{
      Config: { Labels: { [PRODUCT_LABEL]: PRODUCT, [INSTANCE_LABEL]: instance } }, HostConfig: { NetworkMode: internal },
      NetworkSettings: { Networks: Object.fromEntries(memberships.get(args[2]!)!.map(name => [name, {}])) },
    }]) };
    if (args[0] === "network" && args[1] === "connect") { connects.push(args[3]!); memberships.get(args[3]!)!.push(args[2]!); }
    return { status: 0, stdout: "fixture", stderr: "" };
  } }, instance);
  runner.run(["run", "--name", owner]); runner.run(["run", "--name", gateway]); runner.run(["start", gateway]);
  assert.deepEqual(connects, [gateway]); assert.deepEqual(memberships.get(owner), [internal]);
  assert.deepEqual(memberships.get(gateway), [internal, ingress]);
  memberships.get(owner)!.push(ingress);
  assert.throws(() => runner.run(["start", owner]), /exclusively isolated/);
});
