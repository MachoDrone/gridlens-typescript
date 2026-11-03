import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** git diff alone omits new untracked files. Check both parts without staging or
 * otherwise mutating the candidate. After a commit the same gate still applies. */
export function checkVerificationDiff(root: string, base: string): number {
  if (!/^[a-f0-9]{40}$/.test(base)) throw new Error("Expected immutable base commit.");
  const tracked = spawnSync("git", ["diff", "--check", base, "--"], { cwd: root, stdio: "inherit" });
  if (tracked.status !== 0 || tracked.error) return 1;
  const names = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" });
  if (names.status !== 0 || names.error) return 1;
  for (const path of names.stdout.split("\0").filter(Boolean)) {
    const result = spawnSync("git", ["diff", "--no-index", "--check", "--", "/dev/null", path], { cwd: root, stdio: "inherit" });
    // --no-index implies --exit-code: 1 means differing contents; whitespace
    // errors add bit 2. A new nonempty file therefore succeeds with status 1.
    if (result.error || result.status !== 0 && result.status !== 1) return 1;
  }
  return 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = checkVerificationDiff(process.cwd(), process.argv[2] ?? ""); }
  catch { console.error("Candidate whitespace verification failed."); process.exitCode = 1; }
}
