import { createHash } from "node:crypto";
import { createReadStream, lstatSync, mkdtempSync, openSync, closeSync, fsyncSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verify } from "node:crypto";
import { checked, runCommand } from "./commands.ts";
import type { CommandRunner } from "./commands.ts";
import { digest, REPOSITORY } from "./model.ts";
import type { Asset } from "./model.ts";

export interface RemoteAsset { id: number; name: string; size: number; digest: string; state: "uploaded" }
export interface RemoteRelease { id: number; tag_name: string; target_commitish: string; draft: boolean; prerelease: boolean; body?: string; assets: RemoteAsset[] }
export interface GitHub {
  release(tag: string): Promise<RemoteRelease | undefined>;
  tagCommit(tag: string): Promise<string | undefined>;
  create(tag: string, commit: string, notesPath: string): Promise<void>;
  upload(releaseId: number, asset: Asset, beforeDispatch?: () => void): Promise<RemoteAsset>;
  publish(releaseId: number): Promise<void>;
  removeAsset(assetId: number): Promise<void>;
  download(tag: string, name: string, destination: string, expected?: { bytes: number; sha256: string }): Promise<Asset>;
}
const tagOkay = (tag: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(tag);
const nameOkay = (name: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(name);
const idOkay = (value: number): boolean => Number.isSafeInteger(value) && value > 0;
export function parseRemoteAsset(value: unknown): RemoteAsset {
  const row = value as Partial<RemoteAsset>;
  if (!row || !idOkay(row.id!) || typeof row.name !== "string" || !nameOkay(row.name) || !Number.isSafeInteger(row.size) || row.size! < 1
    || row.state !== "uploaded" || typeof row.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(row.digest)) throw new Error("GitHub asset metadata is incomplete or unexpected.");
  // Download counts and timestamps can legitimately change during verification;
  // only immutable object identity/content participates in concurrency checks.
  return { id: row.id!, name: row.name, size: row.size!, digest: row.digest, state: "uploaded" };
}
export function assetMatches(remote: RemoteAsset, local: Pick<Asset, "name" | "bytes" | "sha256">): boolean {
  return remote.name === local.name && remote.size === local.bytes && remote.digest === `sha256:${local.sha256}` && remote.state === "uploaded";
}
export function verifyRemoteInventory(release: RemoteRelease, assets: readonly Asset[], complete: boolean): void {
  const seen = new Set<string>();
  for (const remote of release.assets) {
    const expected = assets.find(asset => asset.name === remote.name);
    if (seen.has(remote.name) || !expected || !assetMatches(remote, expected)) throw new Error("Immutable release assets differ from this candidate; no asset was replaced.");
    seen.add(remote.name);
  }
  if (complete && seen.size !== assets.length) throw new Error("The immutable release is incomplete.");
}
/** Regular-file input is intentional: gh's stdin path omits Content-Length. */
export async function withVerifiedUploadFile<T>(directory: string, asset: Asset, invoke: (path: string) => Promise<T>): Promise<T> {
  if (!nameOkay(asset.name) || lstatSync(asset.path).isSymbolicLink()) throw new Error("Invalid release upload source.");
  const temporary = mkdtempSync(join(directory, ".upload-")), path = join(temporary, asset.name);
  try {
    const bytes = readFileSync(asset.path);
    if (bytes.length !== asset.bytes || digest(bytes) !== asset.sha256) throw new Error("Release asset changed before upload.");
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    return await invoke(path);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
export async function downloadPublicAsset(url: URL, destination: string, expected?: { bytes: number; sha256: string }, fetcher: typeof fetch = fetch): Promise<Asset> {
  const allowed = (target: URL): boolean => target.protocol === "https:" && !target.username && !target.password && (!target.port || target.port === "443")
    && ["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(target.hostname);
  let current = url;
  const signal = AbortSignal.timeout(30 * 60_000);
  let response: Response | undefined;
  for (let redirects = 0; redirects < 6; redirects++) {
    if (!allowed(current)) throw new Error("Public asset redirected outside the GitHub release service.");
    response = await fetcher(current, { redirect: "manual", signal, headers: { Accept: "application/octet-stream" } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location"); await response.body?.cancel();
      if (!location) throw new Error("Public asset redirect omitted its destination.");
      current = new URL(location, current); continue;
    }
    break;
  }
  if (!response?.ok || !response.body) throw new Error("The anonymous public asset is not available yet.");
  const name = decodeURIComponent(url.pathname.split("/").at(-1)!);
  const nameLimit = name.endsWith(".sig") ? 64 : name.endsWith(".json") ? 16384 : name.endsWith(".sh") ? 64 * 1024
    : name.includes("LICENSE") ? 4 * 1024 ** 2 : name.startsWith("gridlens-coordinator-") ? 256 * 1024 ** 2 : 1024 ** 3;
  const maximum = Math.min(expected?.bytes ?? nameLimit, nameLimit);
  const fd = openSync(destination, "wx", 0o600), hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > maximum) throw new Error("Public asset exceeded its signed size.");
      hash.update(chunk); writeFileSync(fd, chunk);
    }
    const sha256 = hash.digest("hex");
    if (bytes < 1 || expected && (bytes !== expected.bytes || sha256 !== expected.sha256)) throw new Error("Anonymous public asset failed its exact size or digest check.");
    fsyncSync(fd);
    return { name, path: destination, bytes, sha256 };
  } catch (error) { rmSync(destination, { force: true }); throw error; }
  finally { closeSync(fd); }
}
export function createGitHub(directory: string, runner: CommandRunner = runCommand, fetcher: typeof fetch = fetch): GitHub {
  const githubEnvironment = (): NodeJS.ProcessEnv => ({ ...process.env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" });
  async function api(path: string, method = "GET", extra: string[] = [], timeoutMs = 60_000): Promise<unknown> {
    return JSON.parse(await checked("gh", ["api", "--hostname", "github.com", "--method", method, path, ...extra], { timeoutMs, maximumBytes: 4 * 1024 ** 2, env: githubEnvironment() }, runner));
  }
  async function optional(path: string): Promise<unknown | undefined> {
    const result = await runner("gh", ["api", "--hostname", "github.com", path], { timeoutMs: 60_000, maximumBytes: 4 * 1024 ** 2, env: githubEnvironment() });
    if (result.exitCode === 0) return JSON.parse(result.stdout);
    if (result.exitCode === 1 && /\(HTTP 404\)/.test(result.stderr)) return undefined;
    throw new Error("GitHub identity read failed; no absence was assumed.");
  }
  return {
    async release(tag) {
      if (!tagOkay(tag)) throw new Error("Invalid release tag.");
      const value = await optional(`repos/${REPOSITORY}/releases/tags/${tag}`) as Omit<RemoteRelease, "assets"> | undefined;
      if (!value) return undefined;
      if (!idOkay(value.id) || value.tag_name !== tag || typeof value.draft !== "boolean" || typeof value.prerelease !== "boolean") throw new Error("Unexpected GitHub release identity.");
      const assets: RemoteAsset[] = [];
      for (let page = 1; page <= 10; page++) {
        const rows = await api(`repos/${REPOSITORY}/releases/${value.id}/assets?per_page=100&page=${page}`);
        if (!Array.isArray(rows)) throw new Error("Invalid release asset page.");
        assets.push(...rows.map(parseRemoteAsset));
        if (rows.length < 100) return { ...value, assets };
      }
      throw new Error("Release asset count exceeded its bound.");
    },
    async tagCommit(tag) {
      if (!tagOkay(tag)) throw new Error("Invalid release tag.");
      const ref = await optional(`repos/${REPOSITORY}/git/ref/tags/${tag}`) as { object: { type: string; sha: string } } | undefined;
      if (!ref) return undefined;
      let item = ref.object;
      for (let depth = 0; depth < 4 && item.type === "tag"; depth++) item = (await api(`repos/${REPOSITORY}/git/tags/${item.sha}`) as { object: typeof item }).object;
      if (item.type !== "commit" || !/^[a-f0-9]{40}$/.test(item.sha)) throw new Error("Release tag does not resolve to a commit.");
      return item.sha;
    },
    async create(tag, commit, notesPath) {
      if (!tagOkay(tag) || !/^[a-f0-9]{40}$/.test(commit)) throw new Error("Invalid draft release identity.");
      await checked("gh", ["release", "create", tag, "--repo", `github.com/${REPOSITORY}`, "--target", commit, "--draft", "--prerelease", "--latest=false", "--title", tag, "--notes-file", notesPath], { timeoutMs: 60_000, env: githubEnvironment() }, runner);
    },
    async upload(releaseId, asset, beforeDispatch) {
      if (!idOkay(releaseId)) throw new Error("Invalid release ID.");
      return withVerifiedUploadFile(directory, asset, async path => {
        beforeDispatch?.();
        return parseRemoteAsset(await api(`https://uploads.github.com/repos/${REPOSITORY}/releases/${releaseId}/assets?name=${encodeURIComponent(asset.name)}`, "POST",
          ["--header", "Content-Type: application/octet-stream", "--input", path], 30 * 60_000));
      });
    },
    async publish(releaseId) {
      if (!idOkay(releaseId)) throw new Error("Invalid release ID.");
      await api(`repos/${REPOSITORY}/releases/${releaseId}`, "PATCH", ["-F", "draft=false", "-F", "prerelease=true", "-f", "make_latest=false"]);
    },
    async removeAsset(assetId) {
      if (!idOkay(assetId)) throw new Error("Invalid release asset ID.");
      await checked("gh", ["api", "--hostname", "github.com", "--method", "DELETE", `repos/${REPOSITORY}/releases/assets/${assetId}`], { timeoutMs: 60_000, env: githubEnvironment() }, runner);
    },
    async download(tag, name, destination, expected) {
      if (!tagOkay(tag) || !nameOkay(name)) throw new Error("Invalid public release path.");
      return downloadPublicAsset(new URL(`https://github.com/${REPOSITORY}/releases/download/${tag}/${name}`), destination, expected, fetcher);
    }
  };
}
/** Stream signatures only after an exact artifact digest has already been checked. */
export async function verifyFileSignature(path: string, signature: Uint8Array, publicKey: string): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(path)) chunks.push(Buffer.from(chunk));
  if (!verify(null, Buffer.concat(chunks), publicKey, signature)) throw new Error("Public coordinator signature did not verify.");
}
