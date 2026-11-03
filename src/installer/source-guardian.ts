import { GUARDIAN_CONTAINER, GUARDIAN_VOLUME, parseGuardianEnrollment, parseGuardianStatus, serializeGuardianEnrollment } from "../backend/source-guardian.ts";
import { GUARDIAN_MAX_REPLY_BYTES } from "../backend/guardian-limits.ts";
import type { GuardianEnrollment, GuardianStatus } from "../backend/source-guardian.ts";
import { shellQuote } from "../backend/ssh.ts";
import type { SshResult, SshRun } from "../backend/ssh.ts";
import { verifyGuardianArchive, verifyGuardianReleaseIdentity } from "./guardian-release.ts";
import type { GuardianRelease, GuardianReleaseIdentity } from "./guardian-release.ts";
import type { ModernRelease } from "./release.ts";
import { FINANCIAL_SECURITY_PROTOCOL_LABEL, GUARDIAN_PROTOCOL_LABEL } from "./financial-security.ts";

const PRODUCT = "financial-guardian", PRODUCT_LABEL = "io.gridlens.product";
const OWNER_LABEL = "io.gridlens.guardian-owner", PC_LABEL = "io.gridlens.guardian-pc";
const SOCKET = "/var/run/docker.sock", SCRIPT = "/app/scripts/source-guardian.ts";
export const GUARDIAN_STOP_GRACE_SECONDS = 90;
const restricted = ["--read-only", "--network", "none", "--user", "0:0", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "128", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m"];
const mount = (name: string, target: string): string[] => ["--mount", `type=volume,src=${name},dst=${target}`];
const command = (args: readonly string[]): string => `/usr/bin/docker ${args.map(shellQuote).join(" ")}`;
const labels = (enrollment: GuardianEnrollment): string[] => ["--label", `${PRODUCT_LABEL}=${PRODUCT}`, "--label", `${GUARDIAN_PROTOCOL_LABEL}=1`,
  "--label", `${OWNER_LABEL}=${enrollment.authorityId}`, "--label", `${PC_LABEL}=${enrollment.pcId}`];
type RecordValue = Record<string, unknown>;
export interface GuardianResourceNames { containerName: string; volumeName: string }
const productionNames: GuardianResourceNames = { containerName: GUARDIAN_CONTAINER, volumeName: GUARDIAN_VOLUME };
function resourceNames(fixture?: GuardianResourceNames): GuardianResourceNames {
  if (!fixture) return productionNames;
  const prefix = /^(gridlens-modern-fixture-[a-f0-9]{12})-guardian$/.exec(fixture.containerName)?.[1];
  if (!prefix || fixture.volumeName !== `${prefix}-guardian-state` || Object.keys(fixture).sort().join("|") !== "containerName|volumeName")
    throw new Error("Guardian inspection overrides require one exact isolated fixture namespace.");
  return fixture;
}
function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid guardian resource metadata."); return value as RecordValue;
}
function one(text: string): RecordValue { const value: unknown = JSON.parse(text); if (!Array.isArray(value) || value.length !== 1) throw new Error("Ambiguous guardian resource identity."); return object(value[0]); }
type ExpectedOwner = Pick<GuardianEnrollment, "authorityId" | "pcId">;
function owned(value: RecordValue, kind: "container" | "volume", enrollment: ExpectedOwner, names = productionNames): void {
  const actual = object(kind === "container" ? object(value.Config).Labels : value.Labels);
  if (actual[PRODUCT_LABEL] !== PRODUCT || actual[GUARDIAN_PROTOCOL_LABEL] !== "1" || actual[OWNER_LABEL] !== enrollment.authorityId || actual[PC_LABEL] !== enrollment.pcId
    || String(value.Name).replace(/^\//, "") !== (kind === "container" ? names.containerName : names.volumeName)) throw new Error("The source guardian belongs to another owner/PC or has changed identity; it was retained.");
}
function validTmpfs(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).join("|") !== "/tmp") return false;
  const text = (value as Record<string, unknown>)["/tmp"]; if (typeof text !== "string") return false;
  const parts = text.split(","), size = parts.find(value => value.startsWith("size="))?.slice(5);
  return parts.length === 4 && ["rw", "noexec", "nosuid"].every(option => parts.includes(option)) && ["16m", "16384k", "16777216"].includes(size ?? "");
}
function guardianImage(value: RecordValue, imageId: string, release: ModernRelease): RecordValue {
  const config = object(value.Config), imageLabels = object(config.Labels);
  if (value.Id !== imageId || value.Os !== "linux" || value.Architecture !== (release.platform === "linux-x64" ? "amd64" : "arm64")
    || imageLabels[PRODUCT_LABEL] !== "shared-backend" || imageLabels["io.gridlens.version"] !== release.version
    || imageLabels[GUARDIAN_PROTOCOL_LABEL] !== "1" || imageLabels[FINANCIAL_SECURITY_PROTOCOL_LABEL] !== "1"
    || !["1", "2"].includes(String(imageLabels["io.gridlens.treasury-protocol"]))) throw new Error("Source image is not the verified guardian-capable release.");
  return config;
}
function validateRuntime(value: RecordValue, imageId: string, imageConfig: RecordValue, enrollment: ExpectedOwner, names = productionNames): void {
  owned(value, "container", enrollment, names);
  const config = object(value.Config), host = object(value.HostConfig), mounts = value.Mounts;
  const expected = [
    { Type: "volume", Name: names.volumeName, Destination: "/guardian", RW: true },
    { Type: "bind", Source: SOCKET, Destination: SOCKET, RW: true }
  ];
  if (value.Image !== imageId || config.User !== "0:0" || JSON.stringify(config.Cmd) !== JSON.stringify(["node", SCRIPT, "serve"])
    || config.StopTimeout !== GUARDIAN_STOP_GRACE_SECONDS || config.StopSignal !== "SIGTERM"
    || JSON.stringify(config.Entrypoint ?? null) !== JSON.stringify(imageConfig.Entrypoint ?? null)
    || JSON.stringify(config.Env ?? []) !== JSON.stringify(imageConfig.Env ?? [])
    || host.ReadonlyRootfs !== true || host.Privileged !== false || host.NetworkMode !== "none" || host.PidMode === "host" || host.IpcMode === "host"
    || !Array.isArray(host.CapDrop) || !host.CapDrop.includes("ALL") || Array.isArray(host.CapAdd) && host.CapAdd.length > 0
    || !Array.isArray(host.SecurityOpt) || !host.SecurityOpt.some(value => String(value).startsWith("no-new-privileges"))
    || host.PidsLimit !== 128 || !validTmpfs(host.Tmpfs) || object(host.RestartPolicy).Name !== "unless-stopped"
    || Array.isArray(host.DeviceRequests) && host.DeviceRequests.length > 0 || Array.isArray(host.Devices) && host.Devices.length > 0
    || Object.keys(host.PortBindings ?? {}).length || !Array.isArray(mounts) || mounts.length !== 2
    || expected.some(want => !mounts.some(got => Object.entries(want).every(([key, entry]) => object(got)[key] === entry))))
    throw new Error("The existing source guardian has changed isolation, image, mounts or command; it was not replaced.");
}
/** Mandatory pre-exec attestation. Signed metadata is small; no archive reads,
 * source-key access, container exec or Docker mutation occur here. */
export async function inspectSourceGuardian(run: SshRun, expected: ExpectedOwner, identity: GuardianReleaseIdentity,
  fixture?: GuardianResourceNames): Promise<{ imageId: string }> {
  const names = resourceNames(fixture);
  if (!/^[a-f0-9]{64}$/.test(expected.authorityId) || !/^[a-f0-9]{64}$/.test(expected.pcId)) throw new Error("Invalid guardian owner identity.");
  const release = verifyGuardianReleaseIdentity(identity);
  const read = async (args: string[]): Promise<RecordValue> => {
    const result = await run(command(args), { maximum: 512 * 1024, timeoutMs: 4000 });
    if (result.code !== 0) throw new Error("Guardian ownership and runtime could not be verified before dispatch."); return one(result.stdout);
  };
  const container = await read(["container", "inspect", names.containerName]); owned(container, "container", expected, names);
  const volume = await read(["volume", "inspect", names.volumeName]); owned(volume, "volume", expected, names);
  const imageId = container.Image;
  if (typeof imageId !== "string" || ![release.imageId, release.configImageId].includes(imageId)) throw new Error("Guardian runtime differs from its retained signed release.");
  const config = guardianImage(await read(["image", "inspect", imageId]), imageId, release);
  validateRuntime(container, imageId, config, expected, names); return { imageId };
}
function enrolled(status: GuardianStatus, enrollment: GuardianEnrollment): GuardianStatus {
  if (status.authorityId !== enrollment.authorityId || status.publicKeyDer !== enrollment.publicKeyDer || status.pcId !== enrollment.pcId
    || status.destinationAddress !== enrollment.destinationAddress || status.policyEpoch < enrollment.policyEpoch
    || enrollment.transferConsumed && !status.transferConsumed || enrollment.claimedSources.some(address => !status.claimedSources.includes(address))
    || status.sources.length !== enrollment.sources.length || enrollment.sources.some(source => !status.sources.some(saved => saved.address === source.address && saved.containerId === source.binding.nodeContainerId)))
    throw new Error("The retained source guardian pin, policy, source bindings or spent history differs; owner-signed reconciliation is required.");
  return status;
}
export interface GuardianProvisionOptions { release: GuardianRelease; enrollment: GuardianEnrollment }
/** Called only with the owner's already approved, identity-pinned administrative
 * SSH runner. All commands, paths and resource names are fixed by this module. */
export async function provisionSourceGuardian(run: SshRun, options: GuardianProvisionOptions, authorize: () => void): Promise<GuardianStatus> {
  const serializedEnrollment = serializeGuardianEnrollment(options.enrollment);
  const enrollment = parseGuardianEnrollment(JSON.parse(serializedEnrollment)), release = options.release.release;
  let imageConfig: RecordValue | undefined;
  authorize();
  const execute = async (args: string[], input?: string | Uint8Array, timeoutMs = 30_000): Promise<SshResult> => run(command(args), {
    ...(input === undefined ? {} : { input }), maximum: args.at(-1) === "status" ? GUARDIAN_MAX_REPLY_BYTES : 512 * 1024, timeoutMs });
  const read = async (args: string[]): Promise<string> => { const result = await execute(args); if (result.code !== 0) throw new Error("Approved source Docker inspection failed; no absence was assumed."); return result.stdout.trim(); };
  const inspectImage = async (): Promise<string | undefined> => {
    const listed = (await read(["image", "ls", "--no-trunc", "--format", "{{.ID}}"])).split(/\s+/).filter(Boolean).map(id => id.startsWith("sha256:") ? id : `sha256:${id}`);
    if (listed.some(id => !/^sha256:[a-f0-9]{64}$/.test(id))) throw new Error("Invalid source image inventory.");
    const selected = [release.imageId, release.configImageId].find(id => id && listed.includes(id)); if (!selected) return undefined;
    const image = one(await read(["image", "inspect", selected])), config = guardianImage(image, selected, release);
    imageConfig = config;
    return selected;
  };
  const verifiedBytes = verifyGuardianArchive(options.release);
  const volumes = (await read(["volume", "ls", "--format", "{{.Name}}"])).split(/\s+/).filter(Boolean);
  const names = (await read(["container", "ls", "--all", "--format", "{{.Names}}"])).split(/\s+/).filter(Boolean);
  const hadVolume = volumes.includes(GUARDIAN_VOLUME), hadContainer = names.includes(GUARDIAN_CONTAINER);
  if (hadContainer && !hadVolume) throw new Error("Guardian state volume is missing; a fresh financial identity was not created.");
  if (hadVolume) owned(one(await read(["volume", "inspect", GUARDIAN_VOLUME])), "volume", enrollment);
  const priorContainer = hadContainer ? one(await read(["container", "inspect", GUARDIAN_CONTAINER])) : undefined;
  if (priorContainer) {
    owned(priorContainer, "container", enrollment);
    if (![release.imageId, release.configImageId].includes(String(priorContainer.Image))) throw new Error("The retained guardian uses a different release; no source container was replaced.");
  }
  let imageId = await inspectImage();
  if (!imageId) {
    authorize();
    let failed = false;
    try { failed = (await execute(["load"], verifiedBytes, 300_000)).code !== 0; } catch { failed = true; }
    imageId = await inspectImage(); // Adopt an accepted load after a lost response; never blindly resend.
    if (!imageId) throw new Error(failed ? "Guardian image delivery is unconfirmed; inspect source state before retrying." : "Loaded guardian image did not match its signed identity.");
  }
  if (priorContainer) validateRuntime(priorContainer, imageId, imageConfig!, enrollment);
  const offlineStatus = async (): Promise<GuardianStatus> => {
    const result = await execute(["run", "--rm", ...restricted, ...labels(enrollment), ...mount(GUARDIAN_VOLUME, "/guardian"), imageId!, "node", SCRIPT, "status"]);
    if (result.code !== 0) throw new Error("Existing guardian pin/journal is missing or corrupt; it was not reinitialized.");
    return enrolled(parseGuardianStatus(JSON.parse(result.stdout)), enrollment);
  };
  if (!hadVolume) {
    authorize();
    const created = await execute(["volume", "create", ...labels(enrollment), GUARDIAN_VOLUME]);
    if (created.code !== 0) throw new Error("Guardian state volume creation was not confirmed.");
    owned(one(await read(["volume", "inspect", GUARDIAN_VOLUME])), "volume", enrollment);
    authorize();
    // Only this fresh-volume branch can invoke provision. Unknown outcomes are
    // reconciled by read-only status, never by executing provision a second time.
    try { await execute(["run", "--rm", "--interactive", ...restricted, ...labels(enrollment), ...mount(GUARDIAN_VOLUME, "/guardian"), imageId, "node", SCRIPT, "provision"], serializedEnrollment); }
    catch { /* The subsequent status read determines whether initialization completed. */ }
    await offlineStatus();
  } else if (!hadContainer) await offlineStatus();
  if (!hadContainer) {
    authorize();
    const created = await execute(["run", "--detach", "--restart", "unless-stopped", "--name", GUARDIAN_CONTAINER, "--stop-timeout", String(GUARDIAN_STOP_GRACE_SECONDS), "--stop-signal", "SIGTERM",
      ...restricted, ...labels(enrollment), ...mount(GUARDIAN_VOLUME, "/guardian"), "--mount", `type=bind,src=${SOCKET},dst=${SOCKET}`, imageId, "node", SCRIPT, "serve"]);
    if (created.code !== 0) throw new Error("Guardian container start is unconfirmed; saved owner state was retained.");
  }
  const container = one(await read(["container", "inspect", GUARDIAN_CONTAINER])); validateRuntime(container, imageId, imageConfig!, enrollment);
  if (object(container.State).Running !== true) { authorize(); if ((await execute(["start", GUARDIAN_CONTAINER])).code !== 0) throw new Error("Owned guardian could not be started."); }
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await execute(["exec", GUARDIAN_CONTAINER, "node", SCRIPT, "status"]);
    if (result.code === 0) return enrolled(parseGuardianStatus(JSON.parse(result.stdout)), enrollment);
    if (attempt < 9) await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("Guardian status did not become ready; owner state was retained.");
}
