import { spawnSync } from "node:child_process";
import { localDockerRunner, checked } from "../../src/installer/docker.ts";
import type { DockerRunner } from "../../src/installer/docker.ts";
import { readViewerInstallation } from "../../src/installer/viewer-install.ts";
import type { FixtureProfile } from "./model.ts";
import type { Fixture, FixtureDocker } from "./fixture-docker.ts";
import { fixtureRequest } from "./fixture-http.ts";
import { shellWords } from "./commands.ts";

export interface ViewerFixture { instance: string; port: number; invitationDirectory?: string }
export function viewerFixtureNames(fixture: ViewerFixture) {
  if (!/^fixture-view-[a-f0-9]{12}$/.test(fixture.instance) || !Number.isInteger(fixture.port) || fixture.port < 1024 || fixture.port > 65535
    || [8789, 8790].includes(fixture.port)) throw new Error("Use an isolated viewer fixture identity and port.");
  const prefix = `gridlens-viewer-${fixture.instance}`;
  return { container: `${prefix}-gateway`, volume: `${prefix}-config`, network: `${prefix}-network` };
}
/** The actual production inspector/installer uses Docker on the declared fixture
 * PC, without assuming the maintainer's local Docker context selects that PC. */
export function viewerFixtureRunner(profile: FixtureProfile): DockerRunner {
  return localDockerRunner({ allowSudo: false, execute: (command, args, options) => {
    if (command !== "docker") throw new Error("Viewer fixture accepts only the fixed Docker executable.");
    return spawnSync("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", profile.sshTarget, shellWords(["docker", ...args])], { ...options, env: process.env });
  } });
}
export function assertViewerFixtureAbsent(runner: DockerRunner, fixture: ViewerFixture): void {
  const names = viewerFixtureNames(fixture);
  for (const [kind, name] of [["container", names.container], ["volume", names.volume], ["network", names.network]]) {
    const result = runner.run([kind!, "inspect", name!]);
    if (result.status === 0 || !/No such (?:container|volume|network|object)|not found/i.test(result.stderr)) throw new Error("Viewer fixture resource absence could not be verified.");
  }
}
export async function verifyViewerFixture(runner: DockerRunner, profile: FixtureProfile, fixture: ViewerFixture, expected: { images: string[]; serverId: string }) {
  const names = viewerFixtureNames(fixture), installed = readViewerInstallation(runner, fixture.instance);
  if (!installed?.ready || installed.origin !== `http://${profile.address}:${fixture.port}` || !expected.images.includes(installed.imageId)) throw new Error("Viewer is not the expected ready signed runtime.");
  const status = await fixtureRequest(installed.origin + "/api/shared/status"), value = status.body as { role?: string; viewerOnly?: boolean; serverId?: string; context?: { addresses?: unknown[] } };
  if (status.status !== 200 || value.role !== "viewer" || value.viewerOnly !== true || value.serverId !== expected.serverId || value.context?.addresses?.length !== 0)
    throw new Error("Viewer did not read the expected empty owner fleet with viewer authority.");
  const hosts = await fixtureRequest(installed.origin + "/api/fleet/hosts.json"), observations = await fixtureRequest(installed.origin + "/api/shared/observations");
  if (hosts.status !== 200 || (hosts.body as { addresses?: unknown[] }).addresses?.length !== 0 || observations.status !== 200) throw new Error("Viewer snapshot data could not be read.");
  const denied = ["/setup", "/wallet", "/api/shared/setup", "/api/shared/treasury/status", "/api/shared/updates/start", "/api/shared/viewer/read"];
  for (const path of denied) {
    const response = await fixtureRequest(installed.origin + path, path.endsWith("/start") || path.endsWith("/read") ? { body: { version: 1 } } : {});
    if (response.status !== 403) throw new Error("Viewer exposed an administrative or financial route.");
  }
  const [container] = JSON.parse(checked(runner, ["container", "inspect", names.container])) as { Id: string; Mounts: { Type: string; Name: string; Destination: string; RW: boolean }[] }[];
  if (!container || container.Mounts.length !== 1 || container.Mounts[0]?.Name !== names.volume || container.Mounts[0]?.Destination !== "/viewer" || container.Mounts[0]?.RW !== false)
    throw new Error("Viewer has private authority mounts.");
  return { passed: true, origin: installed.origin, imageId: installed.imageId, containerId: container.Id, configurationHash: installed.configurationHash,
    role: "viewer", ownerServerId: expected.serverId, snapshotReads: true, administrativeRoutesDenied: denied, privateMountsAbsent: true, onlyReadOnlyViewerVolume: true };
}
export async function viewerPairCounts(docker: FixtureDocker, owner: Fixture): Promise<{ devices: number; attempts: number }> {
  const source = "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/ledger/ledger.sqlite',{readOnly:true});try{const row=db.prepare(\"SELECT json_array_length(value,'$.devices') AS devices,json_array_length(value,'$.attempts') AS attempts FROM private_state WHERE key='access.v1'\").get();if(!row)throw Error('Missing fixture access ledger');process.stdout.write(JSON.stringify(row));}finally{db.close();}";
  const result = JSON.parse(await docker.exec(owner, "owner", ["node", "-e", source])) as { devices: number; attempts: number };
  if (!Number.isSafeInteger(result.devices) || !Number.isSafeInteger(result.attempts)) throw new Error("Fixture pairing counts are invalid."); return result;
}
export function cleanupViewerFixture(runner: DockerRunner, fixture: ViewerFixture): void {
  const names = viewerFixtureNames(fixture), roles = { container: "viewer", volume: "viewer-config", network: "viewer-network" };
  for (const kind of ["container", "volume", "network"] as const) {
    const name = names[kind], result = runner.run([kind, "inspect", name]);
    if (result.status !== 0) { if (/No such (?:container|volume|network|object)|not found/i.test(result.stderr)) continue; throw new Error("Viewer cleanup ownership is unconfirmed."); }
    const values = JSON.parse(result.stdout), row = values?.[0], labels = kind === "container" ? row?.Config?.Labels : row?.Labels;
    if (!Array.isArray(values) || values.length !== 1 || labels?.["io.gridlens.product"] !== "viewer-gateway" || labels["io.gridlens.viewer-instance"] !== fixture.instance
      || labels["io.gridlens.role"] !== roles[kind] || String(row.Name).replace(/^\//, "") !== name) throw new Error("Viewer cleanup refused unrelated resources.");
    if (kind === "container") { if (row.State?.Running) checked(runner, ["stop", "--time", "15", row.Id]); checked(runner, ["container", "rm", row.Id]); }
    else checked(runner, [kind, "rm", name]);
  }
  for (const kind of ["container", "volume", "network"]) {
    const remaining = checked(runner, [kind, "ls", kind === "container" ? "-aq" : "-q", "--filter", `label=io.gridlens.viewer-instance=${fixture.instance}`]);
    if (remaining) throw new Error("Owned viewer fixture resources remain after cleanup.");
  }
}
