import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyRelease } from "../../src/installer/release.ts";
import type { ModernRelease } from "../../src/installer/release.ts";
import { fixtureDocker } from "./fixture-docker.ts";
import type { Fixture, FixtureDocker } from "./fixture-docker.ts";
import { fixtureOwner } from "./fixture-http.ts";
import { assertPreserved, snapshotFixture } from "./fixture-snapshot.ts";
import { atomicJson, ordinaryFile, readJson } from "./files.ts";
import { digest, identity, REPOSITORY } from "./model.ts";
import type { ReleasePlan, Candidate, FixtureProfile } from "./model.ts";
import type { GitHub } from "./github.ts";
import { shellWords } from "./commands.ts";

interface FixtureGeneration { format: "gridlens-public-fixture-v1"; planHash: string; candidateHash: string; generation: string; fixtures: Fixture[] }
export interface InstallerReceipt {
  format: "gridlens-public-installer-acceptance-v1";
  passed: true;
  sourceCommit: string;
  planHash: string;
  candidateHash: string;
  version: string;
  sequence: number;
  manifestSha256: string;
  mode: "actual-public-GitHub";
  cleanupVerified: true;
  configuredOwnerPreserved: boolean;
  runtimeImageInitiallyPresent: boolean;
  coldRuntimeDownload: boolean;
  financialPrepareOrConfirmRequests: 0;
  claimsRequested: 0;
  hostCollectionRequests: 0;
  stages: { stage: string; tag: string; exitCode: 0 }[];
  evidence: { path: string; sha256: string }[];
}
function addressPrompt(output: string): { clean: string; offset: number } | undefined {
  const clean = stripVTControlCharacters(output).replaceAll("\r", "");
  const prompt = /Choose address number(?: \[[^\]\n]+\])?: $/.exec(clean);
  return prompt ? { clean, offset: prompt.index } : undefined;
}
function declaredAddressAnswer(clean: string, address: string): string {
  const choices = [...clean.matchAll(/^\s*(\d+)\) ([0-9.]+)(?:\s|$)/gm)].filter(match => match[2] === address);
  if (choices.length !== 1) throw new Error("Declared fixture address is not an unambiguous public installer choice.");
  return choices[0]![1] + "\n";
}
export function addressAnswer(output: string, address: string): string | undefined {
  const prompt = addressPrompt(output);
  return prompt ? declaredAddressAnswer(prompt.clean, address) : undefined;
}
/** SSH output can split the prompt from its trailing cursor-control bytes.
 * Re-reading the same normalized occurrence must never supply another answer. */
export function createAddressPromptResponder(address: string): (output: string) => string | undefined {
  let answeredOffset: number | undefined;
  return output => {
    const prompt = addressPrompt(output);
    if (!prompt || prompt.offset === answeredOffset) return undefined;
    if (answeredOffset !== undefined) throw new Error("Public installer repeated its address prompt; no second answer was supplied.");
    const answer = declaredAddressAnswer(prompt.clean, address);
    answeredOffset = prompt.offset;
    return answer;
  };
}
export type PublicLauncher = (profile: FixtureProfile, fixture: Fixture, tag: string, action: "setup" | "upgrade", logPath: string) => Promise<void>;
export const runPublicLauncher: PublicLauncher = (profile, fixture, tag, action, logPath) => new Promise((resolve, reject) => {
  const url = `https://github.com/${REPOSITORY}/releases/download/${tag}/modern-start.sh`;
  const args = ["--instance", fixture.instance, ...(action === "upgrade" ? ["--upgrade"] : ["--vpn-web", "--web-port", String(fixture.webPort)])];
  const command = `set -o pipefail; ${shellWords(["curl", "--proto", "=https", "--proto-redir", "=https", "--tlsv1.2", "--fail", "--location", "--max-time", "300", url])} | ${shellWords(["bash", "-s", "--", ...args])}`;
  const env = ["env", ...["ALL_PROXY", "all_proxy", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "CURL_CA_BUNDLE", "NODE_USE_ENV_PROXY"].flatMap(name => ["-u", name]), "NO_COLOR=1", "bash", "-c", command];
  const child = spawn("ssh", ["-tt", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", profile.sshTarget, shellWords(env)], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "", failure: Error | undefined;
  const answerPrompt = createAddressPromptResponder(profile.address);
  const stop = (error: Error): void => { failure ??= error; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 2000).unref(); };
  const timeout = setTimeout(() => stop(new Error("Public installer exceeded its bounded fixture deadline.")), 15 * 60_000);
  const append = (chunk: Buffer): void => {
    output += chunk.toString("utf8");
    if (Buffer.byteLength(output) > 16 * 1024 ** 2) { stop(new Error("Public installer output exceeded its bound.")); return; }
    if (/password:|passphrase|\[sudo\]/i.test(output.slice(-512))) { stop(new Error("Fixture installer requested unexpected credentials; no answer was supplied.")); return; }
    try {
      const answer = answerPrompt(output);
      if (answer) child.stdin.write(answer);
    } catch (error) { stop(error instanceof Error ? error : new Error("Unexpected public installer prompt.")); }
  };
  child.stdout.on("data", append); child.stderr.on("data", append); child.stdin.on("error", () => {});
  child.on("error", error => { failure = error; });
  child.on("close", code => {
    clearTimeout(timeout); writeFileSync(logPath, output, { flag: "wx", mode: 0o600 });
    if (failure) reject(failure); else if (code !== 0) reject(new Error(`Actual public installer exited ${code ?? "unknown"}; inspect the private fixture log.`)); else resolve();
  });
});
function validateReceipt(value: unknown, plan: ReleasePlan, candidate: Candidate): InstallerReceipt {
  const receipt = value as InstallerReceipt;
  if (receipt?.format !== "gridlens-public-installer-acceptance-v1" || receipt.passed !== true || receipt.cleanupVerified !== true
    || receipt.mode !== "actual-public-GitHub" || receipt.sourceCommit !== plan.config.sourceCommit || receipt.planHash !== plan.planHash
    || receipt.candidateHash !== candidate.candidateHash || receipt.version !== plan.config.version || receipt.sequence !== plan.config.sequence
    || receipt.manifestSha256 !== candidate.manifestSha256 || receipt.financialPrepareOrConfirmRequests !== 0 || receipt.claimsRequested !== 0
    || receipt.hostCollectionRequests !== 0 || plan.config.enableWallet && !receipt.configuredOwnerPreserved
    || plan.config.fixture.requireColdDownload && !receipt.coldRuntimeDownload || !Array.isArray(receipt.evidence) || receipt.evidence.length < 8
    || receipt.stages?.map(stage => stage.stage).join("|") !== "fresh|seed|upgrade|retain-setup|retain-upgrade" || receipt.stages.some(stage => stage.exitCode !== 0)) throw new Error("Public installer receipt does not bind the completed candidate workflow.");
  for (const item of receipt.evidence) if (identityFile(item.path) !== item.sha256) throw new Error("Public installer evidence changed after verification.");
  return receipt;
}
const identityFile = (path: string): string => {
  // File bytes, not a display summary, bind fixture evidence to the receipt.
  return digest(ordinaryFile(path, 16 * 1024 ** 2));
};
export async function cleanupPublicFixtures(directory: string, plan: ReleasePlan, docker = fixtureDocker(plan.config.fixture)): Promise<unknown> {
  const path = join(directory, "fixtures.json");
  if (!existsSync(path)) return { cleanupVerified: true, removed: [] };
  const generation = readJson(path) as FixtureGeneration;
  if (generation.format !== "gridlens-public-fixture-v1" || generation.planHash !== plan.planHash || generation.fixtures.length !== 2) throw new Error("Fixture cleanup manifest does not belong to this release plan.");
  const result = await docker.cleanup(generation.fixtures);
  atomicJson(join(directory, `cleanup-${generation.generation}.json`), result);
  return result;
}
export async function publicInstallerAcceptance(plan: ReleasePlan, candidate: Candidate, directory: string, github: GitHub,
  dependencies: { docker?: FixtureDocker; launcher?: PublicLauncher; snapshot?: typeof snapshotFixture; owner?: typeof fixtureOwner; beforeMutation?: () => void } = {}): Promise<InstallerReceipt> {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const docker = dependencies.docker ?? fixtureDocker(plan.config.fixture), launcher = dependencies.launcher ?? runPublicLauncher;
  const snapshot = dependencies.snapshot ?? snapshotFixture, createOwner = dependencies.owner ?? fixtureOwner;
  const reportPath = join(directory, "report.json");
  if (existsSync(reportPath)) return validateReceipt(readJson(reportPath), plan, candidate);
  if (existsSync(join(directory, "fixtures.json"))) await cleanupPublicFixtures(directory, plan, docker);
  const generation = randomBytes(6).toString("hex");
  const fixtures = plan.config.fixture.webPorts.map((port, index): Fixture => ({ instance: `fixture-rel-${generation}-${index === 0 ? "new" : "up"}`, webPort: port, httpsPort: port + 1 }));
  const work = join(directory, generation); mkdirSync(work, { mode: 0o700 });
  await docker.portsAvailable(fixtures);
  for (const fixture of fixtures) await docker.absent(fixture);
  const metadata: FixtureGeneration = { format: "gridlens-public-fixture-v1", planHash: plan.planHash, candidateHash: candidate.candidateHash, generation, fixtures };
  atomicJson(join(directory, "fixtures.json"), metadata); // Intent before invoking any public installer.
  const publicKey = ordinaryFile(plan.config.publicKeyPath, 8192).toString("utf8");
  const current = verifyRelease(ordinaryFile(join(candidate.bundleDirectory, "modern-release.json"), 16384), ordinaryFile(join(candidate.bundleDirectory, "modern-release.sig"), 64), publicKey);
  const oldManifest = join(work, "previous-release.json"), oldSignature = join(work, "previous-release.sig");
  await github.download(plan.config.previousTag, "modern-release.json", oldManifest);
  await github.download(plan.config.previousTag, "modern-release.sig", oldSignature);
  const previous = verifyRelease(ordinaryFile(oldManifest, 16384), ordinaryFile(oldSignature, 64), publicKey);
  if (`modern-v${previous.version}` !== plan.config.previousTag || previous.sequence >= current.sequence || previous.platform !== current.platform) throw new Error("Previous installer release identity is invalid.");
  const present = await docker.imagePresent([current.imageId, ...(current.configImageId ? [current.configImageId] : [])]);
  if (present && plan.config.fixture.requireColdDownload) throw new Error("Candidate image is already present on the fixture daemon. Cold download was required; no shared image was removed.");
  const stages: InstallerReceipt["stages"] = [], evidencePaths: string[] = [oldManifest, oldSignature];
  let owner: Awaited<ReturnType<typeof fixtureOwner>> | undefined, failure: unknown;
  async function stage(name: string, fixture: Fixture, release: ModernRelease, action: "setup" | "upgrade") {
    const log = join(work, `${name}.log`), tag = `modern-v${release.version}`;
    dependencies.beforeMutation?.();
    await launcher(plan.config.fixture, fixture, tag, action, log);
    stages.push({ stage: name, tag, exitCode: 0 }); evidencePaths.push(log);
    const value = await snapshot(plan.config.fixture, fixture, docker, name.startsWith("retain") ? current : release);
    const path = join(work, `${name}.json`); atomicJson(path, value); evidencePaths.push(path); return value;
  }
  try {
    const fresh = await stage("fresh", fixtures[0]!, current, "setup");
    if (fresh.audit.walletOwnerConfigured) throw new Error("Fresh fixture unexpectedly has an owner.");
    await stage("seed", fixtures[1]!, previous, "setup");
    if (plan.config.enableWallet) { dependencies.beforeMutation?.(); owner = await createOwner(plan.config.fixture, fixtures[1]!, docker); }
    const seeded = await snapshot(plan.config.fixture, fixtures[1]!, docker, previous);
    const seedPath = join(work, "seed-configured.json"); atomicJson(seedPath, seeded); evidencePaths.push(seedPath);
    const upgraded = await stage("upgrade", fixtures[1]!, current, "upgrade");
    assertPreserved(seeded, upgraded);
    if (owner) { const path = join(work, "owner-upgrade.json"); atomicJson(path, await owner.check(true)); evidencePaths.push(path); }
    for (const action of ["setup", "upgrade"] as const) {
      const retained = await stage(`retain-${action}`, fixtures[1]!, previous, action);
      if (identity(retained) !== identity(upgraded)) throw new Error("Older public installer changed the newer fixture installation.");
      if (owner) { const path = join(work, `owner-retain-${action}.json`); atomicJson(path, await owner.check(false)); evidencePaths.push(path); }
    }
  } catch (error) { failure = error; }
  finally {
    owner?.close();
    try { const path = join(work, "cleanup.json"); atomicJson(path, await docker.cleanup(fixtures)); evidencePaths.push(path); }
    catch (error) { atomicJson(join(work, "cleanup-failure.json"), { message: error instanceof Error ? error.message : "Fixture cleanup failed." }); failure ??= error; }
  }
  if (failure) throw failure;
  const report: InstallerReceipt = { format: "gridlens-public-installer-acceptance-v1", passed: true, sourceCommit: plan.config.sourceCommit, planHash: plan.planHash,
    candidateHash: candidate.candidateHash, version: current.version, sequence: current.sequence, manifestSha256: candidate.manifestSha256,
    mode: "actual-public-GitHub", cleanupVerified: true, configuredOwnerPreserved: Boolean(owner), runtimeImageInitiallyPresent: present, coldRuntimeDownload: !present,
    financialPrepareOrConfirmRequests: 0, claimsRequested: 0, hostCollectionRequests: 0, stages, evidence: evidencePaths.map(path => ({ path, sha256: identityFile(path) })) };
  validateReceipt(report, plan, candidate); atomicJson(reportPath, report); return report;
}
