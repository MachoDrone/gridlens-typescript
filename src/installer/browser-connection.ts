import { privateAddress } from "./config.ts";
import { InstallerError } from "./release.ts";

/** A fragment carries the one-use code to the browser, never to HTTP request logs. */
export function browserConnectionText(origin: string, raw: string, automatic = true, now = Date.now()): string {
  let url: URL, value: { version?: unknown; code?: unknown; expiresAtMs?: unknown };
  try { url = new URL(origin); value = JSON.parse(raw); }
  catch { throw new InstallerError("The browser sign-in link could not be prepared. Rerun setup for a fresh link."); }
  if (!["https:", "http:"].includes(url.protocol) || url.origin !== origin || url.username || url.password
    || !privateAddress(url.hostname.replace(/^\[|\]$/g, "")) || value?.version !== 1
    || typeof value.code !== "string" || !/^[A-Za-z0-9_-]{12}$/.test(value.code)
    || typeof value.expiresAtMs !== "number" || !Number.isSafeInteger(value.expiresAtMs) || value.expiresAtMs <= now)
    throw new InstallerError("The browser sign-in details are invalid or expired. Rerun setup for a fresh link.");
  url.pathname = "/connect";
  if (automatic) url.hash = `code=${value.code}`;
  return [`OPEN GRIDLENS: ${url.href}`,
    automatic ? "Open this private link to sign in automatically. It works once and expires in five minutes."
      : `Connection code: ${value.code}\nOpen the link, enter this code, and select Connect.`,
    `Bookmark the dashboard for later: ${origin}/`,
    "Use your existing VPN when away from your home/private network."].join("\n");
}

export function privateBrowserConnectionText(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== "http:" || url.origin !== origin || !privateAddress(url.hostname.replace(/^\[|\]$/g, "")))
    throw new InstallerError("The private browser address is invalid.");
  return `OPEN GRIDLENS: ${origin}/\nBookmark this address on your PC or phone. Use your existing VPN when away.\nAccess is provided by your trusted private network/VPN.`;
}

export async function verifyPrivateWeb(origin: string, privateNetwork = false): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await fetch(`${origin}${privateNetwork ? "/" : "/connect"}`, { redirect: "error", signal: AbortSignal.timeout(1500) });
      await response.body?.cancel();
      if (response.ok) return;
    } catch { /* Newly started gateways may need a moment to listen. */ }
    if (attempt < 19) await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new InstallerError("The private web page is not reachable yet. Saved data is unchanged; rerun the same setup command.");
}
