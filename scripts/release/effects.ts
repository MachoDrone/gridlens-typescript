import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildModernReleaseArtifacts } from "../build-modern-release.ts";
import type { ReleaseBuildResult } from "../build-modern-release.ts";
import { coordinatorInputs, COMPONENT_DESCRIPTOR, COMPONENT_SIGNATURE, loadCoordinatorComponent } from "../release-coordinator.ts";
import { planVerification, runVerification, validateVerificationReceipt } from "../verification.ts";
import type { VerificationReceipt } from "../verification.ts";
import { runAcceptances, additionalReleaseAcceptances } from "./acceptance.ts";
import { verifyCurrentBuild, verifyDownloadedAssets, verifyPublicComponent } from "./artifacts.ts";
import { promoteChannel } from "./channel.ts";
import { cleanupAcceptanceResources } from "./cleanup.ts";
import { atomicJson, ordinaryFile, readJson } from "./files.ts";
import { assetMatches, createGitHub, verifyRemoteInventory } from "./github.ts";
import type { GitHub, RemoteRelease } from "./github.ts";
import type { ReleaseContext, ReleaseEffects } from "./engine.ts";
import type { Asset } from "./model.ts";
import { digest, identity } from "./model.ts";
import { cleanupPublicFixtures, publicInstallerAcceptance } from "./public-installer.ts";
import { assertDockerDestination, publishSource, validateSource } from "./source.ts";

function buildResult(context: ReleaseContext): ReleaseBuildResult {
  const path = context.journal.candidate?.buildResultPath ?? join(context.directory, "build-result.json");
  return readJson(path) as ReleaseBuildResult;
}
async function checkedCandidate(context: ReleaseContext) {
  const candidate = context.journal.candidate;
  if (!candidate) throw new Error("Release candidate has not been verified.");
  const current = await verifyCurrentBuild(buildResult(context), context.journal.plan, candidate.buildResultPath);
  if (current.candidateHash !== candidate.candidateHash) throw new Error("Release candidate changed.");
  return current;
}
function componentCache(context: ReleaseContext, fingerprint: string): string {
  return join(dirname(context.directory), "coordinator-components", context.journal.plan.config.platform, context.journal.plan.publicKeySha256, fingerprint);
}
async function expectedRelease(context: ReleaseContext, github: GitHub): Promise<RemoteRelease | undefined> {
  const { config } = context.journal.plan, release = await github.release(`modern-v${config.version}`);
  const tagCommit = await github.tagCommit(`modern-v${config.version}`);
  if (tagCommit && tagCommit !== config.sourceCommit) throw new Error("Release tag belongs to another source commit.");
  if (release && (!release.prerelease || release.target_commitish !== config.sourceCommit && tagCommit !== config.sourceCommit)) throw new Error("Release metadata does not bind this development candidate.");
  if (release && release.body !== ordinaryFile(config.notesPath, 64 * 1024).toString("utf8")) throw new Error("Release notes differ from the reviewed candidate.");
  return release;
}
export function productionEffects(directory: string, importedAcceptances: string[] = []): ReleaseEffects {
  const github = createGitHub(directory);
  return {
    async validate(context) {
      await validateSource(context.journal.plan);
      if (await github.tagCommit(context.journal.plan.config.previousTag) !== context.journal.plan.config.verification.base)
        throw new Error("Verification base must equal the source commit of the declared previous immutable release.");
      await expectedRelease(context, github); // Reject an occupied version before builds or source publication.
    },
    stages: {
      async checks(context, previous) {
        const path = join(directory, "verification-receipt.json");
        if (previous && existsSync(path)) {
          const receipt = readJson(path) as VerificationReceipt;
          const valid = await validateVerificationReceipt(receipt, { root: context.journal.plan.config.sourceDirectory,
            requiredAcceptances: additionalReleaseAcceptances(context.journal.plan.config) });
          if (!valid.checksPassed) throw new Error("Previous verification evidence no longer covers this candidate.");
          return { receiptPath: path, reused: true, missingAcceptances: valid.missingAcceptances };
        }
        const config = context.journal.plan.config;
        const plan = await planVerification({ root: config.sourceDirectory, base: config.verification.base, full: config.verification.full, stateDir: join(dirname(directory), "verification-cache") });
        const receipt = await runVerification(plan);
        atomicJson(path, receipt);
        const valid = await validateVerificationReceipt(receipt, { root: config.sourceDirectory, requiredAcceptances: additionalReleaseAcceptances(config) });
        if (!valid.checksPassed) throw new Error("Required verification checks did not pass.");
        return { receiptPath: path, reused: false, missingAcceptances: valid.missingAcceptances };
      },
      async build(context) {
        await assertDockerDestination(context.journal.plan.docker);
        const resultPath = join(directory, "build-result.json");
        if (existsSync(resultPath)) {
          const result = readJson(resultPath) as ReleaseBuildResult;
          context.journal.candidate = await verifyCurrentBuild(result, context.journal.plan, resultPath); context.save();
          return { resultPath, reused: true };
        }
        const config = context.journal.plan.config, publicKey = ordinaryFile(config.publicKeyPath, 8192).toString("utf8");
        const fingerprint = (await coordinatorInputs(config.sourceDirectory, publicKey)).fingerprint;
        const cached = componentCache(context, fingerprint);
        const component = config.build.coordinatorComponent ?? (existsSync(join(cached, COMPONENT_DESCRIPTOR)) ? cached : undefined);
        const output = join(directory, `bundle-${context.journal.stages.build!.attempt}`);
        const result = await buildModernReleaseArtifacts({ output, version: config.version, sequence: config.sequence, tag: `modern-v${config.version}`,
          signingKey: config.signingKeyPath, publicKey: config.publicKeyPath, enableWallet: config.enableWallet, cold: config.build.cold,
          ...(config.treasuryProtocol === undefined ? {} : { treasuryProtocol: config.treasuryProtocol }),
          ...(component ? { coordinatorComponent: component } : {}) });
        const candidate = await verifyCurrentBuild(result, context.journal.plan, resultPath);
        atomicJson(resultPath, result); context.journal.candidate = candidate; context.save();
        return { resultPath, reused: false, coordinator: result.coordinator.mode, runtimeBytes: result.runtime.bytes, expandedBytes: result.runtime.expandedBytes };
      },
      async bundle(context) {
        const candidate = await checkedCandidate(context), result = buildResult(context);
        if (result.coordinator.mode === "reused") await verifyPublicComponent(github, result, join(directory, "reused-public-component"), ordinaryFile(context.journal.plan.config.publicKeyPath, 8192).toString("utf8"));
        return { candidateHash: candidate.candidateHash, manifestSha256: candidate.manifestSha256, assets: candidate.assets.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })) };
      },
      async acceptance(context) {
        await assertDockerDestination(context.journal.plan.docker);
        await cleanupAcceptanceResources(context);
        const receipt = readJson(join(directory, "verification-receipt.json")) as VerificationReceipt;
        const valid = await validateVerificationReceipt(receipt, { root: context.journal.plan.config.sourceDirectory });
        if (!valid.checksPassed) throw new Error("Verification no longer covers acceptance inputs.");
        return runAcceptances(context, receipt, buildResult(context), github, importedAcceptances);
      },
      source: context => publishSource(context),
      async draft(context) {
        const candidate = await checkedCandidate(context), config = context.journal.plan.config;
        return context.mutate("release:create", "create-draft-release", { tag: `modern-v${config.version}`, sourceCommit: config.sourceCommit, candidateHash: candidate.candidateHash }, async () => {
          const release = await expectedRelease(context, github);
          if (!release) return undefined;
          verifyRemoteInventory(release, candidate.assets, !release.draft);
          return { releaseId: release.id, tag: release.tag_name };
        }, async () => { await validateSource(context.journal.plan); context.assertActive(); await github.create(`modern-v${config.version}`, config.sourceCommit, config.notesPath); });
      },
      async assets(context) {
        const candidate = await checkedCandidate(context);
        const release = await expectedRelease(context, github);
        if (!release) throw new Error("Draft release is missing.");
        verifyRemoteInventory(release, candidate.assets, !release.draft);
        for (const asset of candidate.assets) {
          await context.mutate(`release:asset:${asset.name}`, "upload-release-asset", { releaseId: release.id, name: asset.name, sha256: asset.sha256, bytes: asset.bytes }, async () => {
            const current = await expectedRelease(context, github);
            if (!current || current.id !== release.id) throw new Error("Release ID changed while uploading.");
            verifyRemoteInventory(current, candidate.assets, !current.draft);
            const found = current.assets.find(item => item.name === asset.name);
            return found && assetMatches(found, asset) ? found : undefined;
          }, async () => {
            const current = await expectedRelease(context, github);
            if (!current?.draft || current.id !== release.id || current.assets.some(item => item.name === asset.name)) throw new Error("Release changed before asset upload; resume will reconcile it.");
            context.assertActive();
            await github.upload(release.id, asset, context.assertActive);
          });
        }
        const current = await expectedRelease(context, github); if (!current) throw new Error("Release disappeared after upload.");
        verifyRemoteInventory(current, candidate.assets, true);
        return { releaseId: current.id, assets: current.assets };
      },
      async public(context) {
        const candidate = await checkedCandidate(context), release = await expectedRelease(context, github);
        if (!release) throw new Error("Release is missing before publication.");
        const result = await context.mutate("release:publish", "publish-development-prerelease", { releaseId: release.id, candidateHash: candidate.candidateHash }, async () => {
          const current = await expectedRelease(context, github);
          if (!current || current.id !== release.id) throw new Error("Release ID changed before publication.");
          verifyRemoteInventory(current, candidate.assets, true);
          if (!current.draft) {
            if (await github.tagCommit(current.tag_name) !== context.journal.plan.config.sourceCommit) throw new Error("Published tag has not been verified against the source commit.");
            return { releaseId: current.id, public: true };
          }
          return undefined;
        }, async () => { await validateSource(context.journal.plan); context.assertActive(); await github.publish(release.id); });
        return result;
      },
      async downloads(context) {
        const candidate = await checkedCandidate(context), config = context.journal.plan.config, publicDirectory = join(directory, "public-downloads");
        mkdirSync(publicDirectory, { recursive: true, mode: 0o700 });
        const downloaded: Asset[] = [];
        for (const asset of candidate.assets) {
          const path = join(publicDirectory, asset.name);
          if (!existsSync(path)) await github.download(`modern-v${config.version}`, asset.name, path, asset);
          const bytes = ordinaryFile(path, 1024 ** 3); downloaded.push({ name: asset.name, path, bytes: bytes.length, sha256: digest(bytes) });
        }
        verifyDownloadedAssets(downloaded, candidate.assets);
        const result = buildResult(context), publicKey = ordinaryFile(config.publicKeyPath, 8192).toString("utf8");
        await verifyPublicComponent(github, result, join(directory, "published-component"), publicKey);
        const cache = componentCache(context, result.coordinator.descriptor.inputFingerprint);
        const expectation = { inputFingerprint: result.coordinator.descriptor.inputFingerprint, platform: config.platform };
        mkdirSync(dirname(cache), { recursive: true, mode: 0o700 });
        if (existsSync(cache)) loadCoordinatorComponent(cache, publicKey, expectation);
        else {
          const temporary = mkdtempSync(join(dirname(cache), ".component-"));
          try {
            for (const name of [COMPONENT_DESCRIPTOR, COMPONENT_SIGNATURE, result.coordinator.descriptor.name, result.coordinator.descriptor.signature])
              copyFileSync(join(directory, "published-component", name), join(temporary, name));
            loadCoordinatorComponent(temporary, publicKey, expectation);
            try { renameSync(temporary, cache); }
            catch (error) {
              if (!existsSync(cache)) throw error;
              loadCoordinatorComponent(cache, publicKey, expectation); // Concurrent verified component won; retain it.
            }
          } finally { rmSync(temporary, { recursive: true, force: true }); }
        }
        const report = { passed: true, sourceCommit: config.sourceCommit, manifestSha256: candidate.manifestSha256, candidateHash: candidate.candidateHash, assets: downloaded };
        atomicJson(join(directory, "public-downloads.json"), report); return report;
      },
      async installer(context) { return publicInstallerAcceptance(context.journal.plan, await checkedCandidate(context), join(directory, "installer"), github, { beforeMutation: context.assertActive }); },
      async channel(context) {
        await validateSource(context.journal.plan);
        const candidate = await checkedCandidate(context);
        const downloads = readJson(join(directory, "public-downloads.json")) as { candidateHash: string; assets: Asset[] };
        if (downloads.candidateHash !== candidate.candidateHash) throw new Error("Public download proof belongs to another candidate.");
        verifyDownloadedAssets(downloads.assets, candidate.assets);
        const receipt = await publicInstallerAcceptance(context.journal.plan, candidate, join(directory, "installer"), github, { beforeMutation: context.assertActive });
        if (!receipt.cleanupVerified || receipt.manifestSha256 !== candidate.manifestSha256) throw new Error("Public installer acceptance is incomplete.");
        const acceptance = context.journal.stages.acceptance?.evidence;
        if (!Array.isArray(acceptance)) throw new Error("Required Docker acceptance evidence is missing.");
        // Revalidate immutable reports before the mutable channel becomes visible.
        const checked = await runAcceptances(context, readJson(join(directory, "verification-receipt.json")) as VerificationReceipt, buildResult(context), github);
        if (identity(checked) !== identity(acceptance)) throw new Error("Acceptance receipts changed before channel promotion.");
        return promoteChannel(context, github);
      }
    },
    async cleanup(context) {
      await assertDockerDestination(context.journal.plan.docker);
      await cleanupAcceptanceResources(context);
      return cleanupPublicFixtures(join(directory, "installer"), context.journal.plan);
    }
  };
}
