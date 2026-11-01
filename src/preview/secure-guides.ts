export const SECURE_DEVICES = ["windows", "macos", "linux", "android"] as const;
export type SecureDevice = typeof SECURE_DEVICES[number];
export const SECURE_BROWSERS = ["chrome", "edge", "firefox", "safari", "samsung"] as const;
export type SecureBrowser = typeof SECURE_BROWSERS[number];
export const DEVICE_NAMES: Record<SecureDevice, string> = { windows: "Windows", macos: "macOS", linux: "Linux", android: "Android" };
export const BROWSER_NAMES: Record<SecureBrowser, string> = {
  chrome: "Chrome / Chromium", edge: "Microsoft Edge", firefox: "Firefox", safari: "Safari", samsung: "Samsung Internet",
};
/** The old Samsung device choice was public presentation state, never an access grant. */
export function normalizeSecureDevice(value: unknown): SecureDevice | undefined {
  if (value === "samsung") return "android";
  return typeof value === "string" && (SECURE_DEVICES as readonly string[]).includes(value) ? value as SecureDevice : undefined;
}
export function browsersFor(device: SecureDevice): readonly SecureBrowser[] {
  if (device === "macos") return ["safari", "chrome", "edge", "firefox"];
  if (device === "android") return ["chrome", "samsung", "edge", "firefox"];
  return ["chrome", "edge", "firefox"];
}
export function suggestSecureDevice(userAgent: string): { device: SecureDevice; browser: SecureBrowser } {
  const device: SecureDevice = /Android/i.test(userAgent) ? "android"
    : /Windows/i.test(userAgent) ? "windows" : /Macintosh|Mac OS X/i.test(userAgent) ? "macos" : "linux";
  const detected: SecureBrowser = /SamsungBrowser/i.test(userAgent) ? "samsung" : /Edg(?:e|A|iOS)?\//i.test(userAgent) ? "edge"
    : /Firefox|FxiOS/i.test(userAgent) ? "firefox" : /Chrome|Chromium|CriOS/i.test(userAgent) ? "chrome" : "safari";
  return { device, browser: browsersFor(device).includes(detected) ? detected : browsersFor(device)[0]! };
}
export interface SecureGuideStep { title: string; instruction: string; help?: string }
/** Each step describes a real user action; none establishes certificate trust by itself. */
export function secureGuide(device: SecureDevice, browser: SecureBrowser, filename: string): SecureGuideStep[] {
  const file = `“${filename}”`;
  const firefoxHelp = browser === "firefox" ? device === "android"
    ? "Current Firefox normally uses roots added to Android. If it still rejects the certificate, check its ordinary certificate settings and device policy. Do not disable certificate checks."
    : `If Firefox still rejects the certificate, open Firefox Settings → View Certificates → Authorities → Import. Select ${file} and allow this CA to identify websites.` : undefined;
  if (device === "android") return [
    { title: "Open Android Settings", instruction: "Open Settings and search for “Install a certificate”. Open the certificate installation result." },
    { title: "Choose CA certificate", instruction: "Select CA certificate. Android may ask you to confirm before selecting a file." },
    { title: "Import the downloaded file", instruction: `Open Downloads and select ${file}. Approve Android’s confirmation only if you trust this GridLens computer. Enter your device PIN only in the Android prompt.`,
      help: firefoxHelp ?? "Android may show a notice that the network can be monitored after you install a user CA. If a device policy blocks installation, contact its administrator; do not bypass the browser warning." },
  ];
  if (device === "windows") return [
    { title: "Open the certificate", instruction: `Open ${file} from Downloads. Choose Install Certificate, then Current User.` },
    { title: "Choose the certificate store", instruction: "Choose Place all certificates in the following store → Browse → Trusted Root Certification Authorities. Select Next, then Finish." },
    { title: "Confirm the import", instruction: "Approve the Windows confirmation only if it matches the GridLens certificate you intended to trust. Then return here.",
      help: firefoxHelp ?? "If your organization blocks certificate installation, contact its administrator. Enter any computer password only in the system prompt." },
  ];
  if (device === "macos") return [
    { title: "Open Keychain Access", instruction: "Use Spotlight to open Keychain Access. Select the login keychain, then File → Import Items." },
    { title: "Import the certificate", instruction: `Select ${file} from Downloads. Find the imported GridLens certificate and open its information window.` },
    { title: "Approve website trust", instruction: "Expand Trust. Set Secure Sockets Layer (SSL) to Always Trust, then close the window. Approve the macOS prompt only if you trust this GridLens computer.",
      help: firefoxHelp ?? "Enter your Mac password only in the macOS prompt. If a device policy blocks the change, contact its administrator." },
  ];
  if (browser === "firefox") return [
    { title: "View Certificates", instruction: "Open Firefox Settings and search for “certificates”. Select View Certificates.", help: "Some versions place Certificates under Privacy & Security → Advanced settings." },
    { title: "Import into Authorities", instruction: `Select Authorities → Import, then choose ${file} from Downloads.` },
    { title: "Approve website trust", instruction: "Select Trust this CA to identify websites, then confirm the import only if you trust this GridLens computer." },
  ];
  return [
    { title: "Manage certificates", instruction: browser === "edge"
      ? "Open Microsoft Edge Settings and search for “Manage certificates”. Open that result."
      : "Open Chrome Settings and search for “Manage certificates”. Open that result." },
    { title: "Installed by you", instruction: "In Certificate Manager, select Local certificates, then Installed by you under Custom.", help: "If your browser has an older certificate manager, open the Authorities tab instead." },
    { title: "Import your certificate", instruction: `Under Trusted certificates, click Import. Select ${file} from Downloads, then confirm the import only if you trust this GridLens computer.`,
      help: "In an older Authorities view, choose Import and allow this CA to identify websites. Do not choose Your certificates or a personal/client certificate import." },
  ];
}
