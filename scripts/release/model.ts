import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { isAbsolute, resolve } from "node:path";

export const REPOSITORY = "MachoDrone/gridlens-typescript";
export const BRANCHES = ["main", "review/fleet-duration-freshness"] as const;
export const PUBLIC_KEY_SHA256 = "0434575c0180293c1f9186e6d219451ddff7ccf688e72ed513702d524fefc711";
export const STAGES = ["checks", "build", "bundle", "acceptance", "source", "draft", "assets", "public", "downloads", "installer", "channel"] as const;
export type Stage = typeof STAGES[number];
export interface FixtureProfile {
  sshTarget: string;
  address: string;
  webPorts: [number, number];
  requireColdDownload: boolean;
}
export interface ReleaseConfig {
  sourceDirectory: string;
  sourceCommit: string;
  version: string;
  sequence: number;
  platform: "linux-x64" | "linux-arm64";
  repository: typeof REPOSITORY;
  publicKeyPath: string;
  signingKeyPath: string;
  notesPath: string;
  previousTag: string;
  enableWallet: boolean;
  verification: { base: string; full: boolean };
  build: { cold: boolean; coordinatorComponent?: string };
  fixture: FixtureProfile;
}
export interface ReleasePlan {
  format: "gridlens-release-plan-v1";
  config: ReleaseConfig;
  sourceTree: string;
  sourceFingerprint: string;
  notesSha256: string;
  publicKeySha256: string;
  toolchain: { node: string; npm: string };
  docker: { endpointFingerprint: string; daemonId: string };
  planHash: string;
}
export interface Asset { name: string; path: string; bytes: number; sha256: string }
export interface Candidate {
  assets: Asset[];
  bundleDirectory: string;
  manifestSha256: string;
  candidateHash: string;
  buildResultPath: string;
}
export interface StageResult {
  status: "running" | "complete" | "failed";
  attempt: number;
  startedAt: string;
  completedAt?: string;
  elapsedMs?: number;
  evidence?: unknown;
  error?: string;
}
export interface Mutation {
  key: string;
  kind: string;
  identity: unknown;
  status: "intent" | "observed";
  intentAt: string;
  observedAt?: string;
  result?: unknown;
}
export interface ReleaseJournal {
  format: "gridlens-release-journal-v1";
  runId: string;
  plan: ReleasePlan;
  status: "preparing" | "prepared" | "publishing" | "complete" | "blocked" | "aborted" | "superseded";
  publicationAuthorized: boolean;
  createdAt: string;
  updatedAt: string;
  stages: Partial<Record<Stage, StageResult>>;
  mutations: Mutation[];
  events: { at: string; kind: string; detail: string }[];
  candidate?: Candidate;
  failure?: { stage: Stage; message: string; at: string };
  cleanupFailure?: string;
}
export const digest = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("Release identity cannot contain undefined values.");
  return text;
}
export const identity = (value: unknown): string => digest(canonical(value));
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a release object.");
  return value as Record<string, unknown>;
}
export const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const commit = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
function exact(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).sort().join("|") !== keys.sort().join("|")) throw new Error("Unexpected release configuration fields.");
}
function path(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0") || value.length > 4096) throw new Error("Release paths must be explicit absolute paths.");
  return resolve(value);
}
export function parseConfig(input: unknown): ReleaseConfig {
  const value = object(input);
  exact(value, ["sourceDirectory", "sourceCommit", "version", "sequence", "platform", "repository", "publicKeyPath", "signingKeyPath", "notesPath", "previousTag", "enableWallet", "verification", "build", "fixture"]);
  if (!commit(value.sourceCommit) || typeof value.version !== "string" || !/^\d+\.\d+\.\d+-dev\.\d+$/.test(value.version)
    || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 || !["linux-x64", "linux-arm64"].includes(String(value.platform))
    || value.repository !== REPOSITORY || typeof value.enableWallet !== "boolean" || typeof value.previousTag !== "string"
    || !/^modern-v\d+\.\d+\.\d+-dev\.\d+$/.test(value.previousTag) || value.previousTag === `modern-v${value.version}`) throw new Error("Invalid development release configuration.");
  const verification = object(value.verification), build = object(value.build), fixture = object(value.fixture);
  exact(verification, ["base", "full"]);
  exact(build, ["cold", ...(Object.hasOwn(build, "coordinatorComponent") ? ["coordinatorComponent"] : [])]);
  exact(fixture, ["sshTarget", "address", "webPorts", "requireColdDownload"]);
  if (!commit(verification.base) || typeof verification.full !== "boolean" || typeof build.cold !== "boolean"
    || typeof fixture.sshTarget !== "string" || !/^[a-z_][a-z0-9_-]{0,31}@[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(fixture.sshTarget)
    || typeof fixture.address !== "string" || isIP(fixture.address) !== 4
    || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(fixture.address)
    || typeof fixture.requireColdDownload !== "boolean" || !Array.isArray(fixture.webPorts) || fixture.webPorts.length !== 2
    || fixture.webPorts.some(port => !Number.isInteger(port) || port < 1024 || port > 65534 || port === 8789 || port === 8790)
    || Math.abs(Number(fixture.webPorts[0]) - Number(fixture.webPorts[1])) < 2) throw new Error("Invalid verification or isolated fixture profile.");
  return { sourceDirectory: path(value.sourceDirectory), sourceCommit: value.sourceCommit, version: value.version, sequence: Number(value.sequence),
    platform: value.platform as ReleaseConfig["platform"], repository: REPOSITORY, publicKeyPath: path(value.publicKeyPath), signingKeyPath: path(value.signingKeyPath),
    notesPath: path(value.notesPath), previousTag: value.previousTag, enableWallet: value.enableWallet,
    verification: { base: verification.base, full: verification.full }, build: { cold: build.cold, ...(build.coordinatorComponent === undefined ? {} : { coordinatorComponent: path(build.coordinatorComponent) }) },
    fixture: { sshTarget: fixture.sshTarget, address: fixture.address, webPorts: [Number(fixture.webPorts[0]), Number(fixture.webPorts[1])], requireColdDownload: fixture.requireColdDownload } };
}
export function parsePlan(input: unknown): ReleasePlan {
  const value = object(input);
  exact(value, ["format", "config", "sourceTree", "sourceFingerprint", "notesSha256", "publicKeySha256", "toolchain", "docker", "planHash"]);
  const config = parseConfig(value.config), toolchain = object(value.toolchain), docker = object(value.docker);
  exact(toolchain, ["node", "npm"]);
  exact(docker, ["endpointFingerprint", "daemonId"]);
  if (value.format !== "gridlens-release-plan-v1" || !commit(value.sourceTree) || !hash(value.sourceFingerprint) || !hash(value.notesSha256)
    || value.publicKeySha256 !== PUBLIC_KEY_SHA256 || toolchain.node !== "24.14.1" || toolchain.npm !== "11.11.0" || !hash(value.planHash)
    || !hash(docker.endpointFingerprint) || typeof docker.daemonId !== "string" || !/^[A-Za-z0-9:._-]{8,160}$/.test(docker.daemonId)) throw new Error("Invalid release plan identity.");
  const { planHash: recorded, ...definition } = value;
  definition.config = config;
  if (identity(definition) !== recorded) throw new Error("Release plan changed after creation.");
  return { ...definition, planHash: recorded } as unknown as ReleasePlan;
}
