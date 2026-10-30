import { readFileSync, lstatSync } from "node:fs";
import { parseUpdateBuild } from "../contracts/updates.ts";
import type { UpdateBuild } from "../contracts/updates.ts";

/** Immutable metadata baked into the signed runtime image, not supplied by HTTP. */
export function readInstalledBuild(path = "/app/build.json", required = false): UpdateBuild | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 1024) throw new Error("Invalid installed build metadata.");
    return parseUpdateBuild(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (!required && error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error("Installed build metadata could not be verified.");
  }
}
