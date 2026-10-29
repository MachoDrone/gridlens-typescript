import assert from "node:assert/strict";
import test from "node:test";
import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import { checked, DockerCommandError, dockerCommandTimeoutMs, localDockerRunner } from "../src/installer/docker.ts";

function processResult(status = 0, stdout = "", stderr = "", code?: string): SpawnSyncReturns<string> {
  return { status, stdout, stderr, signal: null, pid: 1, output: [null, stdout, stderr],
    ...(code ? { error: Object.assign(new Error("Generated process error; raw args must not be retained"), { code }) } : {}) };
}

test("uncached builds have a bounded thirty-minute allowance while ordinary operations keep their existing limits", () => {
  const commands: { command: string; args: readonly string[]; options: SpawnSyncOptionsWithStringEncoding }[] = [];
  const runner = localDockerRunner({ environment: {}, execute(command, args, options) {
    commands.push({ command, args, options }); return processResult(0, "success");
  } });
  for (const args of [["build", "--no-cache", "."], ["image", "build", "."], ["buildx", "build", "."],
    ["image", "inspect", "fixture"], ["exec", "fixture", "node", "scripts/shared-control.ts", "setup-inspect"],
    ["exec", "fixture", "node", "scripts/shared-control.ts", "scan"]]) checked(runner, args);
  assert.deepEqual(commands.map(call => call.options.timeout), [1_800_000, 1_800_000, 1_800_000, 300_000, 600_000, 600_000]);
  assert(commands.every(call => call.command === "docker" && call.options.shell === false && call.options.maxBuffer === 16 * 1024 * 1024));
  assert.equal(dockerCommandTimeoutMs(["exec", "fixture", "build"]), 300_000, "A command argument cannot accidentally select the build allowance");
});

test("Docker build failures retain bounded compiler and daemon reasons without retry or cleanup masking the primary error", () => {
  let calls = 0;
  const runner = localDockerRunner({ environment: {}, execute() {
    calls++; return processResult(1, "Generated compile step\nsrc/example.ts(7,9): error TS2322: Type mismatch.", "The command returned a non-zero code: 1");
  } });
  assert.throws(() => checked(runner, ["build", "--no-cache", "."]), error => {
    assert(error instanceof DockerCommandError); assert.equal(error.operation, "build"); assert.equal(error.kind, "exit"); assert.equal(error.exitCode, 1);
    assert.match(error.message, /TS2322: Type mismatch/); assert.match(error.message, /non-zero code: 1/); return true;
  });
  assert.equal(calls, 1, "The process wrapper returns the original failure before caller-owned recovery or cleanup");
});

test("timeout, missing executable and output limit have distinct bounded diagnostics", () => {
  for (const [code, kind, phrase] of [["ETIMEDOUT", "timeout", "1800 seconds"], ["ENOENT", "unavailable", "could not start"], ["ENOBUFS", "output-limit", "process-output limit"]] as const) {
    const runner = localDockerRunner({ environment: {}, execute: () => processResult(1, "Last build stage: compile browser", "Generated process interruption", code) });
    assert.throws(() => checked(runner, ["build", "--no-cache", "."]), error => {
      assert(error instanceof DockerCommandError); assert.equal(error.kind, kind); assert(error.message.includes(phrase));
      assert.match(error.message, /Last build stage: compile browser/); assert(!error.message.includes("raw args")); return true;
    });
  }
});

test("bounded errors redact stdin credentials, PEM keys, authorization and signed URLs before truncation", () => {
  const key = "-----BEGIN PRIVATE KEY-----\nGENERATED_PRIVATE_KEY_BODY\n-----END PRIVATE KEY-----";
  const input = JSON.stringify({ username: "fixture", password: "generated-password", passphrase: "generated-passphrase", certificate: { privateKey: key } });
  const stderr = ["x".repeat(10_000), key, "generated-password", "generated-passphrase", '"token":"generated-token"',
    "Authorization: Bearer generated-bearer", "https://user:password@example.invalid/file?token=generated-query", "\u001b[31mFinal cause: read-only file system\u001b[0m"].join("\n");
  assert.throws(() => checked({ run: () => ({ status: 1, stdout: "", stderr }) }, ["run", "--env", "SECRET=generated-argument", "fixture"], input), error => {
    assert(error instanceof DockerCommandError); assert(error.message.length < 4500);
    assert.match(error.message, /Final cause: read-only file system/); assert.match(error.message, /earlier output omitted/);
    for (const secret of ["GENERATED_PRIVATE_KEY_BODY", "generated-password", "generated-passphrase", "generated-token", "generated-bearer", "generated-query", "generated-argument"]) assert(!error.message.includes(secret), secret);
    assert(!error.message.includes("\u001b")); return true;
  });
});

test("remote Docker permission errors never invoke local sudo or erase the remote cause", () => {
  for (const environment of [{ DOCKER_HOST: "ssh://generated-host" }, { DOCKER_CONTEXT: "generated-remote" }]) {
    const commands: string[] = [];
    const runner = localDockerRunner({ environment, execute(command) {
      commands.push(command); return processResult(1, "", "permission denied while trying to connect to the Docker socket");
    } });
    assert.throws(() => checked(runner, ["version"]), error => error instanceof DockerCommandError && /permission denied/.test(error.message));
    assert.deepEqual(commands, ["docker"]);
  }
});

test("local sudo retry preserves stdin isolation and the same explicit build timeout and environment", () => {
  const calls: { command: string; args: readonly string[]; options: SpawnSyncOptionsWithStringEncoding }[] = [];
  const runner = localDockerRunner({ environment: { PATH: "/generated/tools" }, execute(command, args, options) {
    calls.push({ command, args, options });
    return calls.length === 1 ? processResult(1, "", "permission denied while trying to connect to the Docker socket") : processResult(0, "ok");
  } });
  checked(runner, ["build", "--no-cache", "."], "generated-stdin");
  assert.deepEqual(calls.map(call => call.command), ["docker", "sudo", "sudo"]);
  assert.deepEqual(calls[1]!.args, ["-v"]); assert.equal(calls[1]!.options.stdio, "inherit");
  assert.equal(calls[1]!.options.input, undefined, "sudo consumes only its own controlling-terminal prompt");
  assert.equal(calls[2]!.options.input, "generated-stdin"); assert.equal(calls[2]!.options.timeout, 1_800_000);
  assert.deepEqual(calls[2]!.options.env, { PATH: "/generated/tools", DOCKER_CLI_HINTS: "false" });
  assert(!calls.some(call => call.args.includes("generated-stdin")));
});

test("external process termination preserves its signal rather than manufacturing an exit code or timeout", () => {
  const runner = localDockerRunner({ environment: {}, execute: () => ({ ...processResult(0, "Original stage output", ""), status: null, signal: "SIGTERM" }) });
  assert.throws(() => checked(runner, ["build", "."]), error => {
    assert(error instanceof DockerCommandError); assert.equal(error.kind, "signal"); assert.equal(error.processCode, "SIGTERM"); assert.equal(error.exitCode, null);
    assert.match(error.message, /terminated by SIGTERM/); assert.match(error.message, /Original stage output/); return true;
  });
});
