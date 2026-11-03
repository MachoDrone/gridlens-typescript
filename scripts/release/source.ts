import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publicKeyFingerprint } from "../release-coordinator.ts";
import { releaseSourceInputs, sourceInputFingerprint } from "../release-context.ts";
import { checked, runCommand } from "./commands.ts";
import type { CommandRunner } from "./commands.ts";
import { ordinaryFile } from "./files.ts";
import { BRANCHES, digest, identity, parseConfig, PUBLIC_KEY_SHA256, REPOSITORY } from "./model.ts";
import type { ReleasePlan } from "./model.ts";
import type { ReleaseContext } from "./engine.ts";

export async function dockerIdentity(runner: CommandRunner = runCommand): Promise<ReleasePlan["docker"]> {
  const context = await checked("docker", ["context", "show"], { timeoutMs: 30_000, maximumBytes: 8192 }, runner);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(context)) throw new Error("Docker context identity is invalid.");
  const endpoint = await checked("docker", ["context", "inspect", context, "--format", "{{json .Endpoints.docker}}"], { timeoutMs: 30_000, maximumBytes: 16384 }, runner);
  const daemonId = await checked("docker", ["info", "--format", "{{.ID}}"], { timeoutMs: 60_000, maximumBytes: 8192 }, runner);
  if (!/^[A-Za-z0-9:._-]{8,160}$/.test(daemonId)) throw new Error("Docker daemon identity could not be verified.");
  const environment = Object.fromEntries(["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "PATH"].map(name => [name, process.env[name] ?? null]));
  return { endpointFingerprint: identity({ context, endpoint, environment }), daemonId };
}
export async function assertDockerDestination(expected: ReleasePlan["docker"], runner: CommandRunner = runCommand): Promise<void> {
  if (identity(await dockerIdentity(runner)) !== identity(expected)) throw new Error("Docker destination or verified daemon identity changed; no build, acceptance or recovery mutation was dispatched.");
}

export async function createPlan(input: unknown, runner: CommandRunner = runCommand): Promise<ReleasePlan> {
  const config = parseConfig(input), cwd = config.sourceDirectory;
  const git = (args: string[]): Promise<string> => checked("git", args, { cwd }, runner);
  if (await git(["rev-parse", "HEAD"]) !== config.sourceCommit || await git(["status", "--porcelain", "--untracked-files=normal"])) throw new Error("Release source must be the exact clean committed candidate.");
  const sourceTree = await git(["rev-parse", "HEAD^{tree}"]);
  const npm = await checked("npm", ["--version"], { cwd }, runner);
  if (process.versions.node !== "24.14.1" || npm !== "11.11.0" || `${process.platform}-${process.arch}` !== config.platform) throw new Error("Use the pinned release toolchain on the target platform.");
  const publicKey = ordinaryFile(config.publicKeyPath, 8192).toString("utf8"), publicKeySha256 = publicKeyFingerprint(publicKey);
  if (publicKeySha256 !== PUBLIC_KEY_SHA256) throw new Error("Release trust anchor differs from the established public identity.");
  const signingRelative = relative(cwd, config.signingKeyPath);
  if (!signingRelative.startsWith("../") && !signingRelative.startsWith("/")) throw new Error("Release signing key must remain outside the source and Docker context.");
  const definition = { format: "gridlens-release-plan-v1" as const, config, sourceTree,
    sourceFingerprint: sourceInputFingerprint(releaseSourceInputs(cwd)), notesSha256: digest(ordinaryFile(config.notesPath, 64 * 1024)), publicKeySha256,
    toolchain: { node: process.versions.node, npm }, docker: await dockerIdentity(runner) };
  return { ...definition, planHash: identity(definition) };
}
export async function validateSource(plan: ReleasePlan, runner: CommandRunner = runCommand): Promise<void> {
  const current = await createPlan(plan.config, runner);
  if (current.planHash !== plan.planHash) throw new Error("Release source, notes, toolchain or trust identity changed; create a new reviewed plan.");
  const ownProject = resolve(fileURLToPath(new URL("../../", import.meta.url)));
  if (ownProject !== resolve(plan.config.sourceDirectory)) throw new Error("Run the maintained publisher from the exact planned source checkout.");
  const origin = await checked("git", ["remote", "get-url", "origin"], { cwd: plan.config.sourceDirectory }, runner);
  if (![`${"https://github.com/"}${REPOSITORY}.git`, `https://github.com/${REPOSITORY}`, `git@github.com:${REPOSITORY}.git`, `ssh://git@github.com/${REPOSITORY}.git`].includes(origin)) throw new Error("Source origin is not the approved repository.");
}
export async function publishSource(context: ReleaseContext, runner: CommandRunner = runCommand,
  validate: typeof validateSource = validateSource): Promise<unknown> {
  const { config } = context.journal.plan, cwd = config.sourceDirectory;
  async function refs(): Promise<Record<string, string>> {
    const output = await checked("git", ["ls-remote", "origin", ...BRANCHES.map(branch => `refs/heads/${branch}`)], { cwd }, runner);
    const result: Record<string, string> = {};
    for (const line of output.split("\n").filter(Boolean)) {
      const [sha, name] = line.split(/\s+/);
      if (!sha || !/^[a-f0-9]{40}$/.test(sha) || !name || !BRANCHES.some(branch => name === `refs/heads/${branch}`) || result[name]) throw new Error("Unexpected publication branch response.");
      result[name] = sha;
    }
    if (Object.keys(result).length !== BRANCHES.length) throw new Error("A required publication branch is missing.");
    return result;
  }
  return context.mutate("source:atomic-push", "atomic-source-push", { repository: REPOSITORY, branches: BRANCHES, commit: config.sourceCommit }, async () => {
    const current = await refs();
    return Object.values(current).every(sha => sha === config.sourceCommit) ? current : undefined;
  }, async () => {
    await validate(context.journal.plan, runner);
    await checked("git", ["fetch", "--no-tags", "origin", ...BRANCHES], { cwd }, runner);
    const current = await refs();
    for (const sha of Object.values(current)) {
      const ancestor = await runner("git", ["merge-base", "--is-ancestor", sha, config.sourceCommit], { cwd });
      if (ancestor.exitCode !== 0) throw new Error("Concurrent source work cannot be advanced without rewriting history; publication stopped.");
    }
    context.assertActive();
    await checked("git", ["push", "--atomic", "origin", ...BRANCHES.map(branch => `${config.sourceCommit}:refs/heads/${branch}`)], { cwd, timeoutMs: 120_000 }, runner);
  });
}
