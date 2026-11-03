import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModernRelease } from "../../src/installer/release.ts";
import type { ViewerInvite } from "../../src/contracts/viewer.ts";
import type { FixtureProfile } from "./model.ts";
import { identity } from "./model.ts";
import type { Fixture, FixtureDocker } from "./fixture-docker.ts";
import type { ViewerFixture } from "./fixture-viewer.ts";
import { verifyViewerFixture, viewerFixtureRunner, viewerPairCounts } from "./fixture-viewer.ts";
import { shellQuote } from "./commands.ts";

export type ViewerPublicLauncher = (profile: FixtureProfile, fixture: ViewerFixture, tag: string, invitePath: string, logPath: string) => Promise<void>;
export function invitationDirectory(fixture: ViewerFixture, path: string): string {
  if (!/^fixture-view-[a-f0-9]{12}$/.test(fixture.instance) || !new RegExp(`^/tmp/gridlens-${fixture.instance}-[A-Za-z0-9]{6}$`).test(path))
    throw new Error("Invalid owned viewer invitation directory.");
  return path;
}
export async function removeViewerInvitation(docker: FixtureDocker, fixture: ViewerFixture, directory: string): Promise<void> {
  const path = invitationDirectory(fixture, directory), file = `${path}/invite.json`;
  await docker.ssh(["/bin/sh", "-c", `if [ -e ${shellQuote(file)} ]; then [ -f ${shellQuote(file)} ] && [ ! -L ${shellQuote(file)} ] && rm -- ${shellQuote(file)} || exit 1; fi; if [ -d ${shellQuote(path)} ]; then rmdir -- ${shellQuote(path)}; fi`]);
}
/** Actual anonymous versioned launcher, including its ordinary file handoff.
 * Only the one-use viewer invite is written to a private temporary file. */
export async function publicViewerAcceptance(options: {
  profile: FixtureProfile; viewer: ViewerFixture; owner: Fixture; docker: FixtureDocker; release: ModernRelease; directory: string;
  invite: () => Promise<ViewerInvite>; launch: ViewerPublicLauncher; beforeMutation?: () => void; onInvitationDirectory: (path: string | undefined) => void;
}) {
  const { profile, viewer, owner, docker, release, directory } = options, runner = viewerFixtureRunner(profile);
  const before = await viewerPairCounts(docker, owner);
  const invite = await options.invite();
  let remoteDirectory: string | undefined, failure: unknown;
  let result: { passed: true; publicCommand: true; resumeWithoutRedemption: true; viewer: Awaited<ReturnType<typeof verifyViewerFixture>>; commandExitCodes: [0, 0]; logPaths: string[] } | undefined;
  try {
    options.beforeMutation?.();
    remoteDirectory = invitationDirectory(viewer, await docker.ssh(["mktemp", "-d", `/tmp/gridlens-${viewer.instance}-XXXXXX`]));
    options.onInvitationDirectory(remoteDirectory);
    const path = `${remoteDirectory}/invite.json`, write = (value: ViewerInvite) => docker.ssh(["/bin/sh", "-c", `umask 077; cat > ${shellQuote(path)}`], JSON.stringify(value));
    await write(invite);
    const joinLog = join(directory, "viewer-public-join.log"), resumeLog = join(directory, "viewer-public-resume.log"), tag = `modern-v${release.version}`;
    options.beforeMutation?.(); await options.launch(profile, viewer, tag, path, joinLog);
    const images = [release.imageId, ...(release.configImageId ? [release.configImageId] : [])];
    const proof = await verifyViewerFixture(runner, profile, viewer, { images, serverId: invite.serverId });
    const paired = await viewerPairCounts(docker, owner);
    if (paired.devices !== before.devices + 1 || paired.attempts !== before.attempts + 1) throw new Error("Public viewer join did not consume exactly one viewer pairing.");
    await write({ ...invite, expiresAtMs: 1 });
    options.beforeMutation?.(); await options.launch(profile, viewer, tag, path, resumeLog);
    if (identity(await viewerPairCounts(docker, owner)) !== identity(paired)) throw new Error("Public viewer rerun redeemed another invitation.");
    const retained = await verifyViewerFixture(runner, profile, viewer, { images, serverId: invite.serverId });
    if (retained.containerId !== proof.containerId || retained.configurationHash !== proof.configurationHash) throw new Error("Public viewer rerun replaced its credential or container.");
    for (const log of [joinLog, resumeLog]) {
      const text = readFileSync(log, "utf8");
      if (text.includes(invite.code) || text.includes("__Host-gridlens") || text.includes('"token"')) throw new Error("Public viewer command exposed private authentication material.");
    }
    result = { passed: true, publicCommand: true, resumeWithoutRedemption: true, viewer: proof, commandExitCodes: [0, 0], logPaths: [joinLog, resumeLog] };
  } catch (error) { failure = error; }
  finally {
    if (remoteDirectory) {
      try { await removeViewerInvitation(docker, viewer, remoteDirectory); options.onInvitationDirectory(undefined); }
      catch (error) { failure ??= error; }
    }
  }
  if (failure) throw failure;
  if (!result) throw new Error("Public viewer proof is incomplete.");
  return result;
}
