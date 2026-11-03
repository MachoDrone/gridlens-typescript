import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { verifyRelease } from "../../src/installer/release.ts";
import { verifyRuntimeArchive } from "../release-runtime.ts";
import type { ReleaseBuildResult } from "../build-modern-release.ts";
import type { VerificationReceipt } from "../verification.ts";
import { checked, runCommand } from "./commands.ts";
import type { CommandRunner } from "./commands.ts";
import { atomicJson, ordinaryFile, readJson } from "./files.ts";
import { digest, hash, object } from "./model.ts";
import type { ReleaseContext } from "./engine.ts";
import type { GitHub } from "./github.ts";
import { fixtureDocker } from "./fixture-docker.ts";

export const DOCKER_ACCEPTANCES = ["docker-shared", "docker-updater", "docker-claims-shutdown", "docker-claim-units"] as const;
export type DockerAcceptance = typeof DOCKER_ACCEPTANCES[number];
export interface AcceptanceReceipt {
  format: "gridlens-release-acceptance-v1";
  sourceCommit: string;
  sourceFingerprint: string;
  acceptance: DockerAcceptance | "updater-docker-cold-gzip";
  passed: true;
  cleanupVerified: true;
  evidenceSha256: string;
  reportPath: string;
}
export function validateAcceptanceReport(kind: DockerAcceptance, value: unknown, images: string[], previousImages?: string[]): void {
  const report = object(value);
  if (!Array.isArray(report.cleanupErrors) || report.cleanupErrors.length || (kind === "docker-shared" ? report.result !== "passed" : report.passed !== true)) throw new Error("Docker acceptance did not finish successfully with verified cleanup.");
  const candidateImage = kind === "docker-updater" ? report.baseImageId : kind === "docker-shared" ? report.firstImageId : kind === "docker-claims-shutdown" ? report.imageId : report.candidateImageId;
  if (typeof candidateImage !== "string" || !images.includes(candidateImage)) throw new Error("Docker acceptance did not exercise this candidate image.");
  if (kind === "docker-updater") {
    const previous = object(report.previousSource), archives = report.fixtureArchives;
    if (report.archiveCompression !== "gzip" || !Array.isArray(report.coldTargetImages) || report.coldTargetImages.length !== 2
      || new Set(report.coldTargetImages).size !== 2 || report.coldTargetImages.some(id => typeof id !== "string" || !/^sha256:[a-f0-9]{64}$/.test(id))
      || !Array.isArray(archives) || archives.length !== 2 || archives.some(item => {
        const row = object(item); return row.compression !== "gzip" || !Number.isSafeInteger(row.bytes) || !Number.isSafeInteger(row.expandedBytes)
          || Number(row.bytes) < 1 || Number(row.bytes) >= Number(row.expandedBytes) || Number(row.expandedBytes) > 1024 ** 3 || !hash(row.sha256);
      }) || !previousImages?.includes(String(previous.imageId)) || !report.update || !report.rollback) throw new Error("Cold gzip updater/rollback proof is incomplete or does not bind the previous signed release.");
  }
  if (kind === "docker-claims-shutdown" && (report.network !== "none" || report.liveApiRequests !== 0 || report.existingWalletKeyAccess !== false
    || report.stopGraceSeconds !== 90 || report.singleSyntheticDispatch !== true || report.acknowledgmentRetainedAndReconciled !== true
    || Number(report.delayedStopMilliseconds) <= 30_000 || Number(report.delayedStopMilliseconds) >= 90_000 || Number(report.idleStopMilliseconds) >= 10_000)) throw new Error("Claim shutdown proof is incomplete.");
  if (kind === "docker-claim-units" && (report.network !== "none" || report.liveApiRequests !== 0 || report.sourceWalletKeyReads !== 0 || report.signingOperations !== 0
    || !previousImages?.includes(String(report.oldImageId)) || !Array.isArray(report.stages) || report.stages.length < 4)) throw new Error("Legacy claim-unit proof is incomplete.");
  if (kind === "docker-shared" && (!report.afterRestart || !report.afterUpgrade || !report.afterRollback || !report.initialImageBindings)) throw new Error("Shared runtime preservation proof is incomplete.");
}
export function readAcceptanceReceipt(path: string, context: ReleaseContext, verification: VerificationReceipt, images: string[], previousImages?: string[]): AcceptanceReceipt {
  const receipt = readJson(path) as AcceptanceReceipt;
  const kind = receipt.acceptance === "updater-docker-cold-gzip" ? "docker-updater" : receipt.acceptance;
  if (receipt.format !== "gridlens-release-acceptance-v1" || receipt.sourceCommit !== context.journal.plan.config.sourceCommit
    || receipt.sourceFingerprint !== verification.plan.sourceFingerprint || !DOCKER_ACCEPTANCES.includes(kind as DockerAcceptance)
    || receipt.passed !== true || receipt.cleanupVerified !== true || !hash(receipt.evidenceSha256) || typeof receipt.reportPath !== "string") throw new Error("External acceptance identity differs from this verified source.");
  const bytes = ordinaryFile(receipt.reportPath, 16 * 1024 ** 2);
  if (digest(bytes) !== receipt.evidenceSha256) throw new Error("Acceptance report bytes changed.");
  validateAcceptanceReport(kind as DockerAcceptance, JSON.parse(bytes.toString("utf8")), images, previousImages);
  return { ...receipt, acceptance: kind };
}
async function signedPrevious(context: ReleaseContext, github: GitHub, tag: string, runner: CommandRunner): Promise<{ images: string[]; reference: string }> {
  const directory = join(context.directory, "previous", tag); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const manifestPath = join(directory, "modern-release.json"), signaturePath = join(directory, "modern-release.sig");
  for (const name of ["modern-release.json", "modern-release.sig"]) if (!existsSync(join(directory, name))) await github.download(tag, name, join(directory, name));
  const release = verifyRelease(ordinaryFile(manifestPath, 16384), ordinaryFile(signaturePath, 64), ordinaryFile(context.journal.plan.config.publicKeyPath, 8192).toString("utf8"));
  if (`modern-v${release.version}` !== tag || release.platform !== context.journal.plan.config.platform || release.sequence >= context.journal.plan.config.sequence) throw new Error("Previous release archive identity is invalid.");
  const images = [release.imageId, ...(release.configImageId ? [release.configImageId] : [])];
  const reference = `gridlens-modern-build:${release.version}-${release.sequence}`;
  async function inspect(): Promise<boolean> {
    const result = await runner("docker", ["image", "inspect", "--format", "{{.Id}}", reference], { timeoutMs: 30_000 });
    if (result.exitCode === 0) { if (!images.includes(result.stdout.trim())) throw new Error("Previous release image tag differs from its signed identity."); return true; }
    if (!/No such (image|object)/i.test(result.stderr)) throw new Error("Previous image identity is unknown; no absence was assumed.");
    return false;
  }
  if (!await inspect()) {
    const path = join(directory, release.runtime.name);
    if (!existsSync(path)) await github.download(tag, release.runtime.name, path, release.runtime);
    verifyRuntimeArchive(ordinaryFile(path, 1024 ** 3), { imageId: release.imageId, version: release.version, platform: release.platform, imageTag: reference });
    await context.mutate(`acceptance:load:${release.imageId}`, "load-verified-previous-image", { imageId: release.imageId, sha256: release.runtime.sha256 }, async () => await inspect() ? { present: true } : undefined,
      async () => { await checked("docker", ["load", "--input", path], { timeoutMs: 300_000 }, runner); });
  }
  return { images, reference };
}
export async function runAcceptances(context: ReleaseContext, verification: VerificationReceipt, build: ReleaseBuildResult, github: GitHub,
  imported: string[] = [], runner: CommandRunner = runCommand): Promise<AcceptanceReceipt[]> {
  const required = verification.missingAcceptances.filter(kind => kind !== "public-installer");
  for (const kind of required) if (!DOCKER_ACCEPTANCES.includes(kind as DockerAcceptance)) throw new Error("No maintained adapter exists for a required acceptance check.");
  const directory = join(context.directory, "acceptance"); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const images = [build.release.imageId, ...(build.release.configImageId ? [build.release.configImageId] : [])];
  const receipts: AcceptanceReceipt[] = [];
  for (const requiredKind of required) {
    const kind = requiredKind as DockerAcceptance;
    const previous = kind === "docker-updater" || kind === "docker-claim-units"
      ? await signedPrevious(context, github, kind === "docker-claim-units" ? "modern-v0.1.0-dev.20" : context.journal.plan.config.previousTag, runner) : undefined;
    const saved = join(directory, `${kind}.json`);
    const candidates = [...(existsSync(saved) ? [saved] : []), ...imported.filter(path => {
      const value = readJson(path) as AcceptanceReceipt; return value.acceptance === kind || kind === "docker-updater" && value.acceptance === "updater-docker-cold-gzip";
    })];
    if (candidates.length) {
      const receipt = readAcceptanceReceipt(candidates[0]!, context, verification, images, previous?.images); atomicJson(saved, receipt); receipts.push(receipt); continue;
    }
    const instance = `fixture-${randomBytes(6).toString("hex")}`, reportPath = join(directory, `${kind}-${instance}.report.json`), logPath = join(directory, `${kind}-${instance}.log`);
    const imageReference = `gridlens-modern-build:${build.release.version}-${build.release.sequence}`, profile = context.journal.plan.config.fixture;
    const actualImageId = await checked("docker", ["image", "inspect", "--format", "{{.Id}}", imageReference], { timeoutMs: 30_000 }, runner);
    if (!images.includes(actualImageId)) throw new Error("Candidate Docker tag changed before acceptance dispatch.");
    if (kind === "docker-updater" || kind === "docker-shared") await fixtureDocker(profile, runner).portsAvailable([
      { instance: `fixture-rel-${instance.slice(8)}-new`, webPort: profile.webPorts[0], httpsPort: profile.webPorts[0] + 1 }
    ]);
    let args: string[];
    if (kind === "docker-updater") args = ["scripts/test-updater-docker.ts", "--instance", instance, "--base-image", imageReference, "--previous-image", previous!.reference,
      "--address", profile.address, "--web-port", String(profile.webPorts[0]), "--https-port", String(profile.webPorts[0] + 1), "--archive-compression", "gzip", "--report", reportPath];
    else if (kind === "docker-shared") args = ["scripts/test-shared-docker.ts", "--instance", instance, "--prebuilt-image", actualImageId, "--prebuilt-version", build.release.version, "--address", profile.address, "--port", String(profile.webPorts[0]), "--report", reportPath];
    else if (kind === "docker-claims-shutdown") args = ["scripts/test-claims-shutdown-docker.ts", "--instance", instance, "--image", actualImageId, "--report", reportPath];
    else args = ["scripts/test-claim-units-docker.ts", "--instance", instance, "--old-image", previous!.reference, "--image", actualImageId, "--report", reportPath];
    context.journal.mutations.push({ key: `acceptance:${instance}`, kind: "isolated-docker-acceptance", identity: { instance, kind, reportPath, images }, status: "intent", intentAt: new Date().toISOString() }); context.save();
    context.assertActive();
    await checked(process.execPath, args, { cwd: context.journal.plan.config.sourceDirectory, timeoutMs: 30 * 60_000, maximumBytes: 16 * 1024 ** 2, logPath }, runner);
    const bytes = ordinaryFile(reportPath, 16 * 1024 ** 2);
    validateAcceptanceReport(kind, JSON.parse(bytes.toString("utf8")), images, previous?.images);
    const receipt: AcceptanceReceipt = { format: "gridlens-release-acceptance-v1", sourceCommit: context.journal.plan.config.sourceCommit,
      sourceFingerprint: verification.plan.sourceFingerprint, acceptance: kind, passed: true, cleanupVerified: true, evidenceSha256: digest(bytes), reportPath };
    atomicJson(saved, receipt); receipts.push(receipt);
    const mutation = context.journal.mutations.find(row => row.key === `acceptance:${instance}`)!; mutation.status = "observed"; mutation.observedAt = new Date().toISOString(); mutation.result = receipt; context.save();
  }
  return receipts;
}
