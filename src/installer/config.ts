import { isIP } from "node:net";
import { InstallerError } from "./release.ts";
export interface InstalledImage { imageId: string; version: string; sequence: number; stateVolume: string }
export interface InstallationConfig {
  schema: 1;
  instance: string;
  bindAddress: string;
  port: number;
  origin: string;
  certificateSha256: string;
  phase: "prepared" | "applying" | "ready";
  active: InstalledImage;
  previous?: InstalledImage;
}
export function privateAddress(text: string): boolean {
  if (isIP(text) === 4) {
    const p = text.split(".").map(Number);
    return p[0] === 10 || p[0] === 172 && p[1]! >= 16 && p[1]! <= 31 || p[0] === 192 && p[1] === 168 || p[0] === 127;
  }
  return isIP(text) === 6 && (/^f[cd][a-f0-9]{2}:/i.test(text) || text === "::1");
}
export function originFor(address: string, port: number): string {
  if (!privateAddress(address) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new InstallerError("Choose an assigned private IPv4/ULA address and a port from 1024 through 65535.");
  return `https://${isIP(address) === 6 ? `[${address}]` : address}:${port}`;
}
export function validateInstallation(value: unknown): InstallationConfig {
  if (!value || typeof value !== "object") throw new InstallerError("The saved installation configuration is invalid.");
  const c = value as InstallationConfig;
  if (c.schema !== 1 || !/^[a-z][a-z0-9-]{0,31}$/.test(c.instance)
    || c.origin !== originFor(c.bindAddress, c.port) || !/^[a-f0-9]{64}$/.test(c.certificateSha256)
    || !["prepared", "applying", "ready"].includes(c.phase)) throw new InstallerError("The saved installation configuration is unsupported or invalid.");
  for (const image of [c.active, ...(c.previous ? [c.previous] : [])]) {
    if (!image || !/^sha256:[a-f0-9]{64}$/.test(image.imageId) || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(image.version)
      || !Number.isSafeInteger(image.sequence) || image.sequence < 1 || !/^gridlens-modern-[a-z0-9-]+-state-[a-z0-9-]+$/.test(image.stateVolume)) {
      throw new InstallerError("The saved image/state pair is invalid.");
    }
  }
  return c;
}
