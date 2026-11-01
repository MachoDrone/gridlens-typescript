/** Public onboarding metadata. Certificate bytes use the separate fixed download. */
export interface BrowserSecurityPublication {
  version: 1; instance: string; httpsOrigin: string; httpOrigin: string | null;
  certificatePem: string; serverCertificatePem: string; serverCertificateSha256: string;
}
export type BrowserSecurityStatus = { version: 1; available: false; serverId: string; canConnectBrowser?: boolean } | {
  version: 1; available: true; serverId: string; instance: string;
  httpsOrigin: string; httpOrigin: string | null;
  trustMode: "private-ca" | "provided-certificate";
  certificateSha256: string; certificateValidFromMs: number; certificateValidToMs: number;
  serverCertificateSha256: string; serverCertificateValidFromMs: number; serverCertificateValidToMs: number;
  status: "ready" | "expired" | "not-yet-valid";
  certificateDownloadPath: "/secure-setup/ca.crt" | null;
  /** Gateway capability only; it never establishes a granted session. */
  canConnectBrowser?: boolean;
};
export interface BrowserSecurityConnectCode { version: 1; code: string; expiresAtMs: number }

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const fingerprint = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const instant = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export function parseBrowserSecurityConnectCode(value: unknown): BrowserSecurityConnectCode {
  if (!object(value) || Object.keys(value).length !== 3 || Object.keys(value).some(key => !["version", "code", "expiresAtMs"].includes(key))
    || value.version !== 1 || typeof value.code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.code) || !instant(value.expiresAtMs))
    throw new Error("Invalid secure browser connection code.");
  return { version: 1, code: value.code, expiresAtMs: value.expiresAtMs };
}

/** Canonical saved private-IP origin; never infer the companion port. */
export function parseBrowserSecurityOrigin(value: unknown, protocol: "https:" | "http:"): string {
  if (typeof value !== "string" || value.length > 256) throw new Error("Invalid browser security origin.");
  const url = new URL(value), host = url.hostname.replace(/^\[|\]$/g, ""), parts = host.split(".").map(Number);
  const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(host) && parts.every(part => part >= 0 && part <= 255)
    && (parts[0] === 10 || parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31 || parts[0] === 192 && parts[1] === 168 || parts[0] === 127);
  const ipv6 = host.includes(":") && (/^f[cd][a-f0-9]{2}:/i.test(host) || host === "::1");
  if (url.protocol !== protocol || url.origin !== value || url.username || url.password || url.pathname !== "/"
    || url.search || url.hash || !url.port || Number(url.port) < 1024 || Number(url.port) > 65535 || !ipv4 && !ipv6)
    throw new Error("Invalid browser security origin.");
  return value;
}

export function parseBrowserSecurityStatus(value: unknown): BrowserSecurityStatus {
  if (!object(value) || value.version !== 1 || typeof value.available !== "boolean" || typeof value.serverId !== "string"
    || value.serverId.length < 1 || value.serverId.length > 256 || /[\u0000-\u001f\u007f]/.test(value.serverId)
    || value.canConnectBrowser !== undefined && typeof value.canConnectBrowser !== "boolean") throw new Error("Invalid browser security status.");
  const capability = value.canConnectBrowser === undefined ? {} : { canConnectBrowser: value.canConnectBrowser as boolean };
  if (!value.available) {
    if (Object.keys(value).some(key => !["version", "available", "serverId", "canConnectBrowser"].includes(key))) throw new Error("Invalid browser security status.");
    return { version: 1, available: false, serverId: value.serverId, ...capability };
  }
  const keys = ["version", "available", "serverId", "instance", "httpsOrigin", "httpOrigin", "trustMode", "certificateSha256",
    "certificateValidFromMs", "certificateValidToMs", "serverCertificateSha256", "serverCertificateValidFromMs", "serverCertificateValidToMs", "status", "certificateDownloadPath"];
  if (Object.keys(value).length !== keys.length + (value.canConnectBrowser === undefined ? 0 : 1)
    || Object.keys(value).some(key => !keys.includes(key) && key !== "canConnectBrowser")
    || typeof value.instance !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(value.instance)
    || !["private-ca", "provided-certificate"].includes(String(value.trustMode))
    || !fingerprint(value.certificateSha256) || !fingerprint(value.serverCertificateSha256)
    || !instant(value.certificateValidFromMs) || !instant(value.certificateValidToMs) || value.certificateValidToMs <= value.certificateValidFromMs
    || !instant(value.serverCertificateValidFromMs) || !instant(value.serverCertificateValidToMs) || value.serverCertificateValidToMs <= value.serverCertificateValidFromMs
    || !["ready", "expired", "not-yet-valid"].includes(String(value.status))
    || value.certificateDownloadPath !== (value.trustMode === "private-ca" ? "/secure-setup/ca.crt" : null)) throw new Error("Invalid browser security status.");
  const httpsOrigin = parseBrowserSecurityOrigin(value.httpsOrigin, "https:");
  const httpOrigin = value.httpOrigin === null ? null : parseBrowserSecurityOrigin(value.httpOrigin, "http:");
  if (httpOrigin !== null && (new URL(httpOrigin).hostname !== new URL(httpsOrigin).hostname || new URL(httpOrigin).port === new URL(httpsOrigin).port))
    throw new Error("Invalid browser security endpoints.");
  return { version: 1, available: true, serverId: value.serverId, instance: value.instance, httpsOrigin, httpOrigin,
    trustMode: value.trustMode as "private-ca" | "provided-certificate", certificateSha256: value.certificateSha256,
    certificateValidFromMs: value.certificateValidFromMs, certificateValidToMs: value.certificateValidToMs,
    serverCertificateSha256: value.serverCertificateSha256, serverCertificateValidFromMs: value.serverCertificateValidFromMs,
    serverCertificateValidToMs: value.serverCertificateValidToMs, status: value.status as "ready" | "expired" | "not-yet-valid",
    certificateDownloadPath: value.certificateDownloadPath as "/secure-setup/ca.crt" | null, ...capability };
}
