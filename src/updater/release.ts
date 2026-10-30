import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdir, lstat, open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { parseUpdateBuild } from "../contracts/updates.ts";
import type { UpdateCandidate } from "../contracts/updates.ts";
import { parseRelease, releaseURL, verifyRelease } from "../installer/release.ts";
import type { ModernRelease } from "../installer/release.ts";

export const WORKER_PROTOCOL = 1;
export const CHANNEL_FORMAT = "gridlens-modern-channel-v1";
export type UpdatePlatform = "linux-x64" | "linux-arm64";
export interface VerifiedCandidate extends UpdateCandidate {
  releaseTag: string; release: ModernRelease; workerProtocol: 1;
}
export interface UpdateChannel {
  format: typeof CHANNEL_FORMAT; channel: "development"; platform: UpdatePlatform;
  version: string; sequence: number; buildId: string; releaseTag: string; manifestSha256: string; workerProtocol: 1;
}
export class UpdateError extends Error {
  readonly retryAtMs: number | undefined;
  constructor(message: string, retryAtMs?: number) { super(message); this.name = "UpdateError"; this.retryAtMs = retryAtMs; }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function channelURL(platform: UpdatePlatform): URL {
  if (platform !== "linux-x64" && platform !== "linux-arm64") throw new UpdateError("This platform cannot use this update channel.");
  return new URL(`https://github.com/MachoDrone/gridlens-typescript/releases/download/modern-development/modern-channel-${platform}.json`);
}
export function parseChannel(value: unknown): UpdateChannel {
  if (!object(value) || value.format !== CHANNEL_FORMAT || value.channel !== "development"
    || !["linux-x64", "linux-arm64"].includes(String(value.platform)) || value.workerProtocol !== WORKER_PROTOCOL
    || typeof value.manifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.manifestSha256)) throw new UpdateError("The signed update channel is unsupported or invalid.");
  let build;
  try { build = parseUpdateBuild(value); } catch { throw new UpdateError("The signed update channel has an invalid build identity."); }
  if (value.releaseTag !== `modern-v${build.version}` || build.buildId !== `${build.sequence}:${build.version}`) throw new UpdateError("The signed update channel has inconsistent release identities.");
  return { format: CHANNEL_FORMAT, channel: "development", platform: value.platform as UpdatePlatform, ...build,
    releaseTag: value.releaseTag, manifestSha256: value.manifestSha256, workerProtocol: 1 };
}
export function verifyChannel(bytes: Uint8Array, signature: Uint8Array, publicKey: string): UpdateChannel {
  try {
    if (bytes.byteLength > 16_384 || signature.byteLength !== 64) throw new Error();
    const key = createPublicKey(publicKey);
    if (key.asymmetricKeyType !== "ed25519" || !verify(null, bytes, key, signature)) throw new Error();
    return parseChannel(JSON.parse(Buffer.from(bytes).toString("utf8")));
  } catch (error) { if (error instanceof UpdateError) throw error; throw new UpdateError("Update channel signature verification failed."); }
}
export function parseVerifiedCandidate(value: unknown): VerifiedCandidate {
  if (!object(value)) throw new UpdateError("Saved update identity is invalid.");
  const build = parseUpdateBuild(value), release = parseRelease(value.release);
  if (typeof value.id !== "string" || !/^[a-f0-9]{64}$/.test(value.id) || value.sizeBytes !== release.runtime.bytes
    || value.releaseTag !== `modern-v${build.version}` || value.workerProtocol !== 1 || build.buildId !== `${build.sequence}:${build.version}`
    || release.version !== build.version || release.sequence !== build.sequence) throw new UpdateError("Saved update identity is inconsistent.");
  return { ...build, id: value.id, sizeBytes: release.runtime.bytes, releaseTag: value.releaseTag, release, workerProtocol: 1 };
}
const approvedDownloadHost = (url: URL): boolean => url.protocol === "https:" && !url.username && !url.password && !url.port
  && ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"].includes(url.hostname);
function retryDeadline(headers: Headers, now: number): number | undefined {
  const after = headers.get("retry-after");
  let deadline = after && /^\d+$/.test(after) ? now + Number(after) * 1000 : after ? Date.parse(after) : NaN;
  const reset = headers.get("x-ratelimit-reset");
  if (headers.get("x-ratelimit-remaining") === "0" && reset && /^\d+$/.test(reset)) deadline = Math.max(Number.isFinite(deadline) ? deadline : 0, Number(reset) * 1000);
  return Number.isSafeInteger(deadline) && deadline > now ? deadline : undefined;
}
async function responseFor(url: URL, fetcher: typeof fetch, signal: AbortSignal, now: () => number): Promise<Response> {
  let next = url;
  for (let count = 0; count < 6; count++) {
    if (!approvedDownloadHost(next)) throw new UpdateError("The update download destination is not allowed.");
    const response = await fetcher(next, { redirect: "manual", signal, headers: { Accept: "application/octet-stream", "User-Agent": "GridLens-Updater/1" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel(); const location = response.headers.get("location");
      if (!location) throw new UpdateError("The update download returned an invalid redirect.");
      next = new URL(location, next); continue;
    }
    if (!response.ok || !response.body) {
      const retryAt = retryDeadline(response.headers, now()); await response.body?.cancel();
      throw new UpdateError(response.status === 429 || retryAt !== undefined ? "Release checks are waiting for the download service."
        : "The update download service could not supply the release.", retryAt);
    }
    return response;
  }
  throw new UpdateError("The update download redirected too many times.");
}
async function boundedDownload(url: URL, maximum: number, fetcher: typeof fetch, signal: AbortSignal, now: () => number): Promise<Buffer> {
  const response = await responseFor(url, fetcher, signal, now);
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of response.body!) {
    signal.throwIfAborted(); length += chunk.byteLength;
    if (length > maximum) throw new UpdateError("The update metadata exceeded its size limit.");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export async function discoverUpdate({ platform, publicKey, signal, fetch: fetcher = globalThis.fetch, now = Date.now }: {
  platform: UpdatePlatform; publicKey: string; signal?: AbortSignal; fetch?: typeof fetch; now?: () => number;
}): Promise<VerifiedCandidate> {
  const abort = AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]);
  try {
    const url = channelURL(platform);
    const channel = verifyChannel(await boundedDownload(url, 16_384, fetcher, abort, now),
      await boundedDownload(new URL(url.href.replace(/\.json$/, ".sig")), 64, fetcher, abort, now), publicKey);
    if (channel.platform !== platform) throw new UpdateError("The signed update is for a different platform.");
    const base = `https://github.com/MachoDrone/gridlens-typescript/releases/download/${channel.releaseTag}/`;
    const bytes = await boundedDownload(releaseURL(base, "modern-release.json"), 16_384, fetcher, abort, now);
    if (createHash("sha256").update(bytes).digest("hex") !== channel.manifestSha256) throw new UpdateError("The update manifest does not match its signed channel.");
    let release: ModernRelease;
    try { release = verifyRelease(bytes, await boundedDownload(releaseURL(base, "modern-release.sig"), 64, fetcher, abort, now), publicKey); }
    catch { throw new UpdateError("Release signature verification failed."); }
    if (release.platform !== platform || release.version !== channel.version || release.sequence !== channel.sequence) throw new UpdateError("The update manifest has inconsistent release identities.");
    return { version: release.version, sequence: release.sequence, buildId: channel.buildId, id: channel.manifestSha256,
      sizeBytes: release.runtime.bytes, releaseTag: channel.releaseTag, release, workerProtocol: 1 };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof UpdateError) throw error;
    throw new UpdateError("The release check could not finish. Retry when the connection is available.");
  }
}
async function matchesArtifact(path: string, candidate: VerifiedCandidate): Promise<boolean> {
  try {
    const st = await lstat(path); if (!st.isFile()) throw new UpdateError("The staged download path is not an ordinary file.");
    if (st.size !== candidate.sizeBytes) return false;
    const file = await open(path, "r");
    try { const hash = createHash("sha256"); for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk); return hash.digest("hex") === candidate.release.runtime.sha256; }
    finally { await file.close(); }
  } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
}
/** Only verified release metadata supplies filenames/limits; no browser path is accepted. */
export async function downloadUpdate(candidate: VerifiedCandidate, directory: string, { signal, fetch: fetcher = globalThis.fetch,
  now = Date.now, onProgress = () => {} }: { signal?: AbortSignal; fetch?: typeof fetch; now?: () => number; onProgress?: (bytes: number) => void } = {}): Promise<string> {
  candidate = parseVerifiedCandidate(candidate);
  const root = join(directory, "downloads"); await mkdir(root, { recursive: true, mode: 0o700 });
  if (!(await lstat(root)).isDirectory()) throw new UpdateError("The update staging directory is invalid.");
  const path = join(root, `${candidate.id}.tar`), partial = `${path}.partial`;
  if (await matchesArtifact(path, candidate)) { onProgress(candidate.sizeBytes); return path; }
  // This exact private staging filename belongs to this single updater owner.
  await unlink(partial).catch(error => { if (error.code !== "ENOENT") throw error; });
  const file = await open(partial, "wx", 0o600), abort = AbortSignal.any([AbortSignal.timeout(15 * 60_000), ...(signal ? [signal] : [])]);
  let complete = false;
  try {
    const base = `https://github.com/MachoDrone/gridlens-typescript/releases/download/${candidate.releaseTag}/`;
    const response = await responseFor(releaseURL(base, candidate.release.runtime.name), fetcher, abort, now);
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== candidate.sizeBytes)) {
      await response.body?.cancel(); throw new UpdateError("The update download has an unexpected size.");
    }
    const hash = createHash("sha256"); let bytes = 0;
    for await (const part of response.body!) {
      abort.throwIfAborted(); bytes += part.byteLength;
      if (bytes > candidate.sizeBytes) throw new UpdateError("The update download exceeded its signed size.");
      hash.update(part); await file.writeFile(part); onProgress(bytes);
    }
    if (bytes !== candidate.sizeBytes || hash.digest("hex") !== candidate.release.runtime.sha256) throw new UpdateError("The update download failed its signed checksum or size check.");
    await file.sync(); await file.close(); await rename(partial, path);
    const parent = await open(root, "r"); try { await parent.sync(); } finally { await parent.close(); }
    complete = true; return path;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof UpdateError) throw error;
    throw new UpdateError("The release download could not finish. The installed version was retained.");
  } finally { if (!complete) { await file.close().catch(() => {}); await unlink(partial).catch(() => {}); } }
}

/** Retain at most two verified archives; only exact updater-generated ordinary
 * filenames are eligible. Other directory contents are never removed. */
export async function pruneUpdateDownloads(directory: string, preferredIds: readonly string[]): Promise<void> {
  const root = join(directory, "downloads");
  let names: string[];
  try { if (!(await lstat(root)).isDirectory()) throw new UpdateError("The update staging directory is invalid."); names = await readdir(root); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
  const files = [];
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.tar(?:\.partial)?$/.test(name)) continue;
    const path = join(root, name), stat = await lstat(path);
    if (!stat.isFile()) continue;
    if (name.endsWith(".partial")) { await unlink(path); continue; }
    files.push({ path, id: name.slice(0, 64), time: stat.mtimeMs });
  }
  files.sort((left, right) => {
    const l = preferredIds.indexOf(left.id), r = preferredIds.indexOf(right.id);
    return (l < 0 ? Number.MAX_SAFE_INTEGER : l) - (r < 0 ? Number.MAX_SAFE_INTEGER : r) || right.time - left.time || left.id.localeCompare(right.id);
  });
  for (const file of files.slice(2)) await unlink(file.path);
}
