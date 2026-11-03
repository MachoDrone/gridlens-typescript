import { checked } from "../src/installer/docker.ts";
import type { DockerRunner } from "../src/installer/docker.ts";
import type { SourceInput } from "./release-context.ts";
import { sourceInputFingerprint } from "./release-context.ts";
import { publicKeyFingerprint } from "./release-coordinator.ts";
import type { TreasuryProtocol } from "../src/installer/financial-security.ts";

export interface BakedFile { path: string; bytes: number; sha256: string }
export interface BakedImageProof {
  version: 1; imageId: string; sourceFingerprint: string;
  build: { version: string; sequence: number; buildId: string };
  node: "24.14.1"; platform: "linux-x64" | "linux-arm64"; publicKeySha256: string;
  capabilities: { updaterProtocol: 1; browserSecurityProtocol: 1; treasuryProtocol: TreasuryProtocol; financialSecurityProtocol: 1; guardianProtocol: 1 };
  bakedFiles: BakedFile[];
}
export interface BakedImageExpectation {
  imageId: string; version: string; sequence: number; platform: "linux-x64" | "linux-arm64";
  publicKey: string; treasuryProtocol: TreasuryProtocol; inputs: readonly SourceInput[];
  labels: Readonly<Record<string, string>>;
}
export function bakedSourceFiles(inputs: readonly SourceInput[]): BakedFile[] {
  const result: BakedFile[] = [];
  for (const input of inputs) {
    let path: string | undefined;
    if (input.name.startsWith("src/") || input.name.startsWith("scripts/")) {
      if (!/^(?:src|scripts)\/[A-Za-z0-9._/-]+$/.test(input.name)) throw new Error("Unsupported baked source path.");
      path = `/app/${input.name}`;
    } else if (["package.json", "package-lock.json", "LICENSE"].includes(input.name)) path = `/app/${input.name}`;
    else if (["docker/DOCKER-CLI-LICENSE", "docker/DOCKER-CLI-NOTICE"].includes(input.name)) path = `/usr/local/share/licenses/docker-cli/${input.name.slice(7)}`;
    if (path) {
      if (path.split("/").some(part => part === "." || part === "..") || !Number.isSafeInteger(input.bytes) || input.bytes < 0 || input.bytes > 32 * 1024 ** 2
        || !/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error("Invalid baked source identity.");
      result.push({ path, bytes: input.bytes, sha256: input.sha256 });
    }
  }
  if (!result.length || new Set(result.map(file => file.path)).size !== result.length) throw new Error("Baked source inventory is empty or duplicated.");
  return result.sort((left, right) => left.path.localeCompare(right.path));
}
/** Fixed code reads only public release files and hashes supplied over stdin.
 * It never receives a host mount, credential path or reusable authorization. */
export const BAKED_IMAGE_PROBE = `
const fs = require('node:fs'), crypto = require('node:crypto');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
try {
  const input = fs.readFileSync(0); if (input.length > 1048576) throw Error();
  const expected = JSON.parse(input);
  if (process.getuid() !== 1000 || process.versions.node !== '24.14.1' || process.platform + '-' + process.arch !== expected.platform) throw Error();
  const read = (path, max) => { const st = fs.lstatSync(path); if (!st.isFile() || st.isSymbolicLink() || st.size > max) throw Error(); return fs.readFileSync(path); };
  const build = JSON.parse(read('/app/build.json', 16384));
  if (JSON.stringify(build) !== JSON.stringify(expected.build)) throw Error();
  const pem = read('/app/update-public-key.pem', 8192).toString('utf8').trim();
  if (pem.includes('PRIVATE') || !/^-----BEGIN PUBLIC KEY-----\\r?\\n(?:[A-Za-z0-9+/=]+\\r?\\n)+-----END PUBLIC KEY-----$/.test(pem)) throw Error();
  const key = crypto.createPublicKey(pem); if (key.asymmetricKeyType !== 'ed25519') throw Error();
  const publicKeySha256 = hash(key.export({ type: 'spki', format: 'der' })); if (publicKeySha256 !== expected.publicKeySha256) throw Error();
  if (!Array.isArray(expected.bakedFiles) || expected.bakedFiles.length > 10000) throw Error();
  const bakedFiles = expected.bakedFiles.map(file => {
    if (typeof file.path !== 'string' || file.path.split('/').some(part => part === '.' || part === '..') ||
      !(/^(?:\\/app\\/(?:src|scripts)\\/[A-Za-z0-9._/-]+|\\/app\\/(?:package.json|package-lock.json|LICENSE)|\\/usr\\/local\\/share\\/licenses\\/docker-cli\\/(?:DOCKER-CLI-LICENSE|DOCKER-CLI-NOTICE))$/.test(file.path))) throw Error();
    const bytes = read(file.path, 33554432), sha256 = hash(bytes);
    if (bytes.length !== file.bytes || sha256 !== file.sha256) throw Error();
    return { path: file.path, bytes: bytes.length, sha256 };
  });
  process.stdout.write(JSON.stringify({ build, node: process.versions.node, platform: process.platform + '-' + process.arch, publicKeySha256, bakedFiles }));
} catch { process.stderr.write('Baked image verification failed.\\n'); process.exitCode = 1; }
`;
export function expectedBakedImageProof(expected: BakedImageExpectation): BakedImageProof {
  if (!/^sha256:[a-f0-9]{64}$/.test(expected.imageId) || !Number.isSafeInteger(expected.sequence) || expected.sequence < 1
    || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(expected.version) || !["linux-x64", "linux-arm64"].includes(expected.platform)
    || ![0, 1, 2].includes(expected.treasuryProtocol) || expected.labels["io.gridlens.product"] !== "shared-backend"
    || expected.labels["io.gridlens.version"] !== expected.version || expected.labels["io.gridlens.updater-protocol"] !== "1"
    || expected.labels["io.gridlens.browser-security-protocol"] !== "1" || expected.labels["io.gridlens.treasury-protocol"] !== String(expected.treasuryProtocol)
    || expected.labels["io.gridlens.financial-security-protocol"] !== "1" || expected.labels["io.gridlens.guardian-protocol"] !== "1")
    throw new Error("Baked image metadata differs from the requested release.");
  return { version: 1, imageId: expected.imageId, sourceFingerprint: sourceInputFingerprint(expected.inputs),
    build: { version: expected.version, sequence: expected.sequence, buildId: `${expected.sequence}:${expected.version}` },
    node: "24.14.1", platform: expected.platform, publicKeySha256: publicKeyFingerprint(expected.publicKey),
    capabilities: { updaterProtocol: 1, browserSecurityProtocol: 1, treasuryProtocol: expected.treasuryProtocol, financialSecurityProtocol: 1, guardianProtocol: 1 }, bakedFiles: bakedSourceFiles(expected.inputs) };
}
export function probeBakedImage(runner: DockerRunner, expected: BakedImageExpectation): BakedImageProof {
  const proof = expectedBakedImageProof(expected);
  const input = { build: proof.build, platform: proof.platform, publicKeySha256: proof.publicKeySha256, bakedFiles: proof.bakedFiles };
  const bytes = JSON.stringify(input);
  if (Buffer.byteLength(bytes) > 1024 ** 2) throw new Error("Baked source inventory exceeds its probe limit.");
  const output = checked(runner, ["run", "--rm", "--interactive", "--read-only", "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true", "--pids-limit", "64", "--memory", "256m", "--cpus", "1",
    "--label", "io.gridlens.product=release-probe", "--label", `io.gridlens.release-sequence=${expected.sequence}`,
    "--entrypoint", "/usr/local/bin/node", expected.imageId, "--input-type=commonjs", "-e", BAKED_IMAGE_PROBE], bytes);
  let observed: unknown;
  try { observed = JSON.parse(output); } catch { throw new Error("Baked image probe returned invalid evidence."); }
  if (JSON.stringify(observed) !== JSON.stringify({ build: proof.build, node: proof.node, platform: proof.platform,
    publicKeySha256: proof.publicKeySha256, bakedFiles: proof.bakedFiles })) throw new Error("Baked image probe did not match the expected source, build and public identity.");
  return proof;
}
