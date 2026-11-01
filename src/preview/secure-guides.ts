export const SECURE_DEVICES = ["windows", "macos", "linux", "android", "ios"] as const;
export type SecureDevice = typeof SECURE_DEVICES[number];
export const SECURE_BROWSERS = ["chrome", "edge", "firefox", "safari", "samsung"] as const;
export type SecureBrowser = typeof SECURE_BROWSERS[number];
export const DEVICE_NAMES: Record<SecureDevice, string> = { windows: "Windows", macos: "macOS", linux: "Linux", android: "Android", ios: "iPhone / iPad" };
export const BROWSER_NAMES: Record<SecureBrowser, string> = {
  chrome: "Chrome / Chromium", edge: "Microsoft Edge", firefox: "Firefox", safari: "Safari", samsung: "Samsung Internet",
};
/** The old Samsung device choice was public presentation state, never an access grant. */
export function normalizeSecureDevice(value: unknown): SecureDevice | undefined {
  if (value === "samsung") return "android";
  return typeof value === "string" && (SECURE_DEVICES as readonly string[]).includes(value) ? value as SecureDevice : undefined;
}
export function browsersFor(device: SecureDevice): readonly SecureBrowser[] {
  if (device === "macos" || device === "ios") return ["safari", "chrome", "edge", "firefox"];
  if (device === "android") return ["chrome", "samsung", "edge", "firefox"];
  return ["chrome", "edge", "firefox"];
}
export function suggestSecureDevice(userAgent: string, platform = "", maxTouchPoints = 0): { device: SecureDevice; browser: SecureBrowser } {
  // iPhone/iPad agents also contain "Mac OS X". Desktop-mode iPad is only a
  // suggestion based on touch/platform hints; the user can always change it.
  const device: SecureDevice = /iPhone|iPad|iPod/i.test(userAgent) ? "ios" : /Android/i.test(userAgent) ? "android"
    : /Windows/i.test(userAgent) ? "windows" : platform === "MacIntel" && Number.isFinite(maxTouchPoints) && maxTouchPoints > 1 ? "ios"
      : /Macintosh|Mac OS X/i.test(userAgent) ? "macos" : "linux";
  const detected: SecureBrowser = /SamsungBrowser/i.test(userAgent) ? "samsung" : /Edg(?:e|A|iOS)?\//i.test(userAgent) ? "edge"
    : /Firefox|FxiOS/i.test(userAgent) ? "firefox" : /Chrome|Chromium|CriOS/i.test(userAgent) ? "chrome" : "safari";
  return { device, browser: browsersFor(device).includes(detected) ? detected : browsersFor(device)[0]! };
}
export interface SecureGuideStep { title: string; instruction: string; help?: string }
/** Each step describes a real user action; none establishes certificate trust by itself. */
export function secureGuide(device: SecureDevice, browser: SecureBrowser, filename: string): SecureGuideStep[] {
  const file = `“${filename}”`;
  const firefoxHelp = browser === "firefox" ? device === "android"
    ? "Current Firefox for Android normally uses CAs added to Android. If it still rejects the connection, verify the CA is installed and check the Firefox version and device policy with its administrator or Mozilla support. Do not disable certificate checks or use hidden debug settings."
    : `Current Firefox normally uses operating-system roots, but browser versions and policy differ. If needed, search Firefox Settings for certificates, choose Manage Certificates or View Certificates, then Authorities → Import. Select ${file} and allow this CA to identify websites.` : undefined;
  if (device === "ios") return [
    { title: "Find the downloaded profile", instruction: "This CA trust extends beyond GridLens. Continue only for your own GridLens computer or an administrator you trust. Open Settings → Profile Downloaded, or General → VPN & Device Management, and select the downloaded GridLens CA profile.",
      help: "Use Safari for the profile download and allow it when asked. If a previously downloaded profile expired, download it again. If Safari never reports Profile Downloaded, stop here and report its message; a file in Files alone does not prove it reached Settings. Only one profile can await installation, and an uninstalled download expires after eight minutes." },
    { title: "Review and install the certificate", instruction: "Review the profile: it should contain only the expected GridLens root certificate. Tap Install and follow Settings’ confirmation prompts. Enter your existing device passcode only in Settings if asked.",
      help: "Not Signed can appear because this certificate-only profile is unsigned. Proceed only after reviewing the expected certificate from your own or trusted GridLens computer. If device policy or Stolen Device Protection blocks installation, stop and follow Apple’s guidance or ask the device administrator; this guide does not turn off those protections." },
    { title: "Enable certificate trust", instruction: "After the profile is installed, open Settings → General → About → Certificate Trust Settings. Under Enable full trust for root certificates, turn on the root you just installed—normally GridLens Private Trust—and approve the confirmation only if you accept this trust.",
      help: "The root certificate’s name can differ from the profile title. If it is not listed, complete profile installation first. If several roots have the same name and you cannot identify yours, ask the administrator rather than enabling them all. Device policy may restrict this setting; installing a profile alone does not enable website trust." },
    { title: "Return to your browser", instruction: "Return to this GridLens guide in the browser you want to use. If you switched to Safari to install the profile, return to the original browser, open Secure and choose Already imported? Open GridLens.",
      help: "Trust and browser sign-in are separate. Browsers can have different certificate policies and do not share GridLens sessions automatically. Each browser must pass its own HTTPS and access checks; do not bypass a certificate warning." },
  ];
  if (device === "android") return [
    { title: "Open Android Settings", instruction: "Android may warn “Your data won’t be private”. This trust extends beyond GridLens. Continue only for your own GridLens computer or an administrator you trust. Open Settings and search for “Install a certificate”.",
      help: "Installing the certificate does not automatically share your data. Someone who obtains its secret signing key and can intercept your traffic could impersonate other websites in browsers or apps that trust it. The signing key stays on the GridLens computer." },
    { title: "Choose CA certificate", instruction: "Select CA certificate. If you accept the trust explained above, choose Install anyway on Android’s warning. Choose Don’t install to cancel." },
    { title: "Import the downloaded file", instruction: `Open Downloads and select ${file}. Approve Android’s confirmation only if you trust this GridLens computer. Enter your device PIN only in the Android prompt.`,
      help: firefoxHelp ?? "Android may show a notice that the network can be monitored after you install a user CA. If a device policy blocks installation, contact its administrator; do not bypass the browser warning." },
  ];
  if (device === "windows") return [
    { title: "Open the certificate", instruction: `Open ${file} from Downloads. Choose Install Certificate, then Current User and Next.` },
    { title: "Choose the certificate store", instruction: "Choose Place all certificates in the following store → Browse → Trusted Root Certification Authorities → OK. Select Next, then Finish." },
    { title: "Confirm the import", instruction: "Approve the Windows confirmation only if it matches the GridLens certificate you intended to trust. Then return here.",
      help: firefoxHelp ?? "If your organization blocks certificate installation, contact its administrator. Enter any computer password only in the system prompt." },
  ];
  if (device === "macos") return [
    { title: "Open Keychain Access", instruction: "Use Spotlight to open Keychain Access. Select the login keychain, then File → Import Items." },
    { title: "Import the certificate", instruction: `Select ${file} from Downloads. Keep Destination Keychain set to login and choose Open. Find the imported GridLens certificate and double-click it.` },
    { title: "Approve website trust", instruction: "Expand Trust. Set Secure Sockets Layer (SSL) to Always Trust, then close the window. Approve the macOS prompt only if you trust this GridLens computer.",
      help: firefoxHelp ?? "Enter your Mac password only in the macOS prompt. If a device policy blocks the change, contact its administrator." },
  ];
  if (browser === "firefox") return [
    { title: "Open the certificate manager", instruction: "Open Firefox Settings and search for certificates. Choose Manage Certificates or View Certificates, whichever your version shows.", help: "The certificate controls are under Privacy & Security. If your organization hides or locks them, ask its administrator." },
    { title: "Import into Authorities", instruction: `Select Authorities → Import, then choose ${file} from Downloads.` },
    { title: "Approve website trust", instruction: "Select Trust this CA to identify websites, then confirm the import only if you trust this GridLens computer." },
  ];
  return [
    { title: "Manage certificates", instruction: "Open this browser’s Settings and search for “Manage certificates”. Open that result." },
    { title: "Installed by you", instruction: "In Certificate Manager, select Local certificates, then Installed by you under Custom.", help: "If your browser has an older certificate manager, open the Authorities tab instead." },
    { title: "Import your certificate", instruction: `Under Trusted certificates, click Import. Select ${file} from Downloads, then confirm the import only if you trust this GridLens computer.`,
      help: "In an older Authorities view, choose Import and allow this CA to identify websites. Do not choose Your certificates or a personal/client certificate import." },
  ];
}
