import { createHash } from "node:crypto";
import { parsePublicBrowserCertificates } from "./browser-security.ts";

export interface AppleCertificateProfileInput { instance: string; certificatePem: string; certificateSha256: string }
export class AppleCertificateProfileError extends Error {
  readonly kind: "invalid" | "unsupported";
  constructor(kind: "invalid" | "unsupported") {
    super(kind === "unsupported" ? "Apple certificate setup requires a self-signed root CA." : "The public Apple certificate profile could not be verified.");
    this.kind = kind;
  }
}
const xml = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const string = (key: string, value: string): string => `    <key>${xml(key)}</key><string>${xml(value)}</string>`;
/** RFC 4122 name-based UUIDs identify repeated copies; this is not a signature. */
function uuid(kind: "profile" | "root", fingerprint: string): string {
  const namespace = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
  const bytes = createHash("sha1").update(namespace).update(`urn:gridlens:browser-security:${kind}:${fingerprint}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Apple com.apple.security.root is a DER-certificate-only PKCS1 alias.
 * Emit exactly the fingerprinted first CA, never extra authorities from a chain.
 * No signing, trust-store change, enrollment or network operation occurs here.
 * Source: apple/device-management release/mdm/profiles/com.apple.security.root.yaml
 */
export function createAppleCertificateProfile(input: AppleCertificateProfileInput, now = Date.now()): Buffer {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 3
    || Object.keys(input).some(key => !["instance", "certificatePem", "certificateSha256"].includes(key))
    || typeof input.instance !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(input.instance)
    || typeof input.certificateSha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.certificateSha256)
    || !Number.isSafeInteger(now) || now < 0) throw new AppleCertificateProfileError("invalid");
  let certificate: ReturnType<typeof parsePublicBrowserCertificates>[number];
  try { certificate = parsePublicBrowserCertificates(input.certificatePem)[0]!; }
  catch { throw new AppleCertificateProfileError("invalid"); }
  if (createHash("sha256").update(certificate.raw).digest("hex") !== input.certificateSha256
    || now < Date.parse(certificate.validFrom) || now >= Date.parse(certificate.validTo)) throw new AppleCertificateProfileError("invalid");
  if (!certificate.ca || certificate.subject !== certificate.issuer || !certificate.checkIssued(certificate) || !certificate.verify(certificate.publicKey))
    throw new AppleCertificateProfileError("unsupported");
  const identifier = `io.gridlens.browser-security.ca.${input.certificateSha256}`;
  const name = `GridLens ${input.instance}`, suffix = input.certificateSha256.slice(0, 8);
  const data = certificate.raw.toString("base64").match(/.{1,64}/g)!.join("\n");
  const body = Buffer.from([
    '<?xml version="1.0" encoding="UTF-8"?>', '<plist version="1.0">', '<dict>',
    '  <key>PayloadContent</key>', '  <array>', '  <dict>',
    string("PayloadCertificateFileName", `gridlens-${input.instance}-${input.certificateSha256.slice(0, 8)}-ca.cer`),
    '    <key>PayloadContent</key>', `    <data>\n${data}\n    </data>`,
    string("PayloadDescription", "Public root certificate for this GridLens installation."),
    string("PayloadDisplayName", `${name} root certificate (${suffix})`), string("PayloadIdentifier", `${identifier}.root`),
    string("PayloadType", "com.apple.security.root"), string("PayloadUUID", uuid("root", input.certificateSha256)),
    '    <key>PayloadVersion</key><integer>1</integer>', '  </dict>', '  </array>',
    string("PayloadDescription", "Unsigned profile containing one public GridLens root certificate. Install only if you trust this GridLens computer."),
    string("PayloadDisplayName", `${name} CA (${suffix})`), string("PayloadIdentifier", identifier), string("PayloadOrganization", "GridLens"),
    string("PayloadType", "Configuration"), string("PayloadUUID", uuid("profile", input.certificateSha256)),
    '    <key>PayloadVersion</key><integer>1</integer>', '</dict>', '</plist>', '',
  ].join("\n"), "utf8");
  // Removal restrictions are deliberately omitted: Apple's default is removable.
  if (body.length > 64 * 1024) throw new AppleCertificateProfileError("invalid");
  return body;
}
