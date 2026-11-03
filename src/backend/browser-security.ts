import { createHash, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import type { PrivateState } from "./access.ts";
import { parseBrowserSecurityOrigin, parseBrowserSecurityStatus } from "../contracts/browser-security.ts";
import type { BrowserSecurityPublication, BrowserSecurityStatus } from "../contracts/browser-security.ts";

const key = "browser-security.v1";
const maximumCertificateBytes = 32 * 1024;
const digest = (certificate: X509Certificate): string => createHash("sha256").update(certificate.raw).digest("hex");
const dates = (certificate: X509Certificate): { from: number; to: number } => {
  const from = Date.parse(certificate.validFrom), to = Date.parse(certificate.validTo);
  if (!Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(to) || to <= from) throw new Error("Invalid public certificate validity.");
  return { from, to };
};
export function parsePublicBrowserCertificates(value: unknown): X509Certificate[] {
  if (typeof value !== "string" || Buffer.byteLength(value) > maximumCertificateBytes) throw new Error("Invalid public certificate.");
  const pattern = /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g;
  const blocks = [...value.matchAll(pattern)].map(match => match[0]);
  if (!blocks.length || blocks.length > 8 || value.replace(pattern, "").trim()) throw new Error("Only public certificate PEM is accepted.");
  const parsed = blocks.map(block => new X509Certificate(block));
  if (new Set(parsed.map(digest)).size !== parsed.length) throw new Error("Duplicate public certificate.");
  parsed.forEach(dates);
  return parsed;
}
const signedBy = (certificate: X509Certificate, issuer: X509Certificate): boolean => issuer.ca && certificate.checkIssued(issuer) && certificate.verify(issuer.publicKey);

/** This validates public material only. The terminal proves its saved installation binding. */
export function validateBrowserSecurityPublication(value: unknown): BrowserSecurityPublication {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid public browser security publication.");
  const input = value as Record<string, unknown>, keys = ["version", "instance", "httpsOrigin", "httpOrigin", "certificatePem", "serverCertificatePem", "serverCertificateSha256"];
  if (Object.keys(input).length !== keys.length || Object.keys(input).some(field => !keys.includes(field)) || input.version !== 1
    || typeof input.instance !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(input.instance)
    || typeof input.serverCertificateSha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.serverCertificateSha256)) throw new Error("Invalid public browser security publication.");
  const httpsOrigin = parseBrowserSecurityOrigin(input.httpsOrigin, "https:"), address = new URL(httpsOrigin).hostname.replace(/^\[|\]$/g, "");
  const httpOrigin = input.httpOrigin === null ? null : parseBrowserSecurityOrigin(input.httpOrigin, "http:");
  if (!isIP(address) || httpOrigin !== null && (new URL(httpOrigin).hostname !== new URL(httpsOrigin).hostname || new URL(httpOrigin).port === new URL(httpsOrigin).port))
    throw new Error("Invalid saved browser security endpoints.");
  const chain = parsePublicBrowserCertificates(input.certificatePem), leafs = parsePublicBrowserCertificates(input.serverCertificatePem), leaf = leafs[0]!;
  if (leafs.length !== 1 || leaf.ca || leaf.checkIP(address) === undefined || digest(leaf) !== input.serverCertificateSha256)
    throw new Error("The saved public server identity does not match.");
  if (chain[0]!.ca) {
    if (!signedBy(leaf, chain[0]!)) throw new Error("The public CA does not issue the saved server certificate.");
  } else if (!chain[0]!.raw.equals(leaf.raw)) throw new Error("The provided certificate does not match the saved server certificate.");
  for (let index = 0; index + 1 < chain.length; index++) if (!signedBy(chain[index]!, chain[index + 1]!)) throw new Error("Invalid public certificate chain.");
  const last = chain.at(-1)!;
  if (last.subject === last.issuer && !last.verify(last.publicKey) || chain[0]!.ca && (last.subject !== last.issuer || !last.ca))
    throw new Error("Invalid public certificate authority.");
  return { version: 1, instance: input.instance, httpsOrigin, httpOrigin,
    certificatePem: chain.map(cert => cert.toString().trim()).join("\n") + "\n", serverCertificatePem: leaf.toString().trim() + "\n",
    serverCertificateSha256: input.serverCertificateSha256 };
}

export interface BrowserSecurityRead { status: BrowserSecurityStatus; certificatePem: string | null }
export function createBrowserSecurity(state: PrivateState, serverId: string, now = Date.now) {
  return {
    viewerTrust(): string {
      return validateBrowserSecurityPublication(state.get<unknown>(key)).certificatePem;
    },
    publish(value: unknown): BrowserSecurityRead {
      const record = validateBrowserSecurityPublication(value);
      state.set(key, record);
      return this.read();
    },
    read(): BrowserSecurityRead {
      const value = state.get<unknown>(key);
      if (value === undefined) return { status: { version: 1, available: false, serverId }, certificatePem: null };
      const record = validateBrowserSecurityPublication(value), chain = parsePublicBrowserCertificates(record.certificatePem), cert = chain[0]!, leaf = parsePublicBrowserCertificates(record.serverCertificatePem)[0]!;
      const certificateDates = dates(cert), leafDates = dates(leaf), validity = [...chain, leaf].map(dates), at = now();
      const status = parseBrowserSecurityStatus({ version: 1, available: true, serverId, instance: record.instance,
        httpsOrigin: record.httpsOrigin, httpOrigin: record.httpOrigin, trustMode: cert.ca ? "private-ca" : "provided-certificate",
        certificateSha256: digest(cert), certificateValidFromMs: certificateDates.from, certificateValidToMs: certificateDates.to,
        serverCertificateSha256: record.serverCertificateSha256, serverCertificateValidFromMs: leafDates.from, serverCertificateValidToMs: leafDates.to,
        status: validity.some(range => at >= range.to) ? "expired" : validity.some(range => at < range.from) ? "not-yet-valid" : "ready",
        certificateDownloadPath: cert.ca ? "/secure-setup/ca.crt" : null });
      return { status, certificatePem: cert.ca ? record.certificatePem : null };
    },
  };
}
