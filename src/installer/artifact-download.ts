import { createHash } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { InstallerError, releaseURL } from "./release.ts";
import type { ReleaseArtifact } from "./release.ts";

const allowed = (url: URL): boolean => url.protocol === "https:" && !url.username && !url.password
  && (!url.port || url.port === "443")
  && ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"].includes(url.hostname);
/** Stream a signed archive to an owned temporary directory. Memory is bounded by
 * the current response chunk; Docker only receives a complete verified file. */
export async function downloadArtifactToFile(base: string, artifact: ReleaseArtifact, directory: string, {
  fetcher = fetch, signal = AbortSignal.timeout(300_000),
}: { fetcher?: typeof fetch; signal?: AbortSignal } = {}): Promise<string> {
  let url = releaseURL(base, artifact.name);
  if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || artifact.bytes > 1024 ** 3 || !/^[a-f0-9]{64}$/.test(artifact.sha256))
    throw new InstallerError("The signed archive metadata is invalid.");
  let response: Response | undefined;
  for (let redirects = 0; redirects < 6; redirects++) {
    signal.throwIfAborted();
    if (!allowed(url)) throw new InstallerError("The release archive redirected outside the supported GitHub service.");
    const candidate = await fetcher(url, { signal, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(candidate.status)) {
      const location = candidate.headers.get("location"); await candidate.body?.cancel().catch(() => {});
      if (!location || location.length > 8192) throw new InstallerError("The release archive returned an invalid redirect.");
      url = new URL(location, url); continue;
    }
    if (!candidate.ok || !candidate.body) { await candidate.body?.cancel().catch(() => {}); throw new InstallerError(`The release archive download failed (HTTP ${candidate.status}).`); }
    response = candidate; break;
  }
  if (!response?.body) throw new InstallerError("The release archive redirected too many times.");
  const path = join(directory, artifact.name);
  const handle = await open(path, "wx", 0o600).catch(async error => { await response!.body?.cancel().catch(() => {}); throw error; });
  let complete = false;
  try {
    const hash = createHash("sha256"); let bytes = 0;
    for await (const chunk of response.body) {
      signal.throwIfAborted(); bytes += chunk.byteLength;
      if (bytes > artifact.bytes) throw new InstallerError("The release archive exceeded its signed size.");
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
        if (bytesWritten < 1) throw new InstallerError("The release archive could not be written completely.");
        offset += bytesWritten;
      }
    }
    if (bytes !== artifact.bytes || hash.digest("hex") !== artifact.sha256) throw new InstallerError("The release archive failed its signed size or checksum check.");
    await handle.sync(); complete = true; return path;
  } finally {
    try { await handle.close(); } catch (error) { if (complete) throw error; }
    if (!complete) await unlink(path).catch(() => {});
  }
}
