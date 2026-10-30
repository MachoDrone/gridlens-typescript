import { DockerCommandError, PRODUCT, PRODUCT_LABEL } from "./docker.ts";
import type { DockerRunner } from "./docker.ts";
import { InstallerError } from "./release.ts";
import type { ModernRelease } from "./release.ts";

/** Both choices come from the verified signed release, never a mutable tag. */
export function isReleaseImageId(release: ModernRelease, value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value)
    && (value === release.imageId || value === release.configImageId);
}

/** Docker's containerd store addresses manifests; its classic store addresses
 * configs. Return the daemon's exact immutable ID for this signed image. */
export function findReleaseImage(runner: DockerRunner, release: ModernRelease): string | undefined {
  const ids = [...new Set([release.imageId, ...(release.configImageId ? [release.configImageId] : [])])];
  for (const id of ids) {
    if (!isReleaseImageId(release, id)) throw new InstallerError("The signed release has an invalid image identity.");
    const args = ["image", "inspect", id], result = runner.run(args);
    if (result.status !== 0) {
      if (/\bNo such (?:image|object)\b/i.test(result.stderr)) continue;
      throw new DockerCommandError(args, "exit", result);
    }
    let images: { Id?: unknown; Os?: unknown; Architecture?: unknown; Config?: { Labels?: Record<string, unknown> } }[];
    try { images = JSON.parse(result.stdout); } catch { throw new InstallerError("Docker returned invalid image identity metadata."); }
    const image = images?.[0];
    if (!Array.isArray(images) || images.length !== 1 || image?.Id !== id
      || image.Os !== "linux" || image.Architecture !== (release.platform === "linux-x64" ? "amd64" : "arm64")
      || image.Config?.Labels?.[PRODUCT_LABEL] !== PRODUCT || image.Config.Labels["io.gridlens.version"] !== release.version)
      throw new InstallerError("The loaded image does not match the signed release identity, platform and version.");
    return id;
  }
  return undefined;
}

export function requireReleaseImage(runner: DockerRunner, release: ModernRelease): string {
  const id = findReleaseImage(runner, release);
  if (!id) throw new InstallerError("The verified release image is missing from Docker after loading its archive.");
  return id;
}

/** Internal runtime adapter only. Keep the original signed release in journals. */
export function runtimeRelease(release: ModernRelease, imageId: string): ModernRelease {
  if (!isReleaseImageId(release, imageId)) throw new InstallerError("The selected runtime image is outside the signed release.");
  return { ...release, imageId };
}
