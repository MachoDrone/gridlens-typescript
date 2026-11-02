import { parseBrowserSecurityConnectCode, parseBrowserSecurityStatus } from "../contracts/browser-security.ts";
import type { BrowserSecurityStatus } from "../contracts/browser-security.ts";
import { BROWSER_NAMES, DEVICE_NAMES, SECURE_BROWSERS, SECURE_DEVICES, browsersFor, normalizeSecureDevice, secureGuide, suggestSecureDevice } from "./secure-guides.ts";
import type { SecureBrowser, SecureDevice } from "./secure-guides.ts";

type AvailableStatus = Extract<BrowserSecurityStatus, { available: true }>;
type Stage = "trust" | "device" | "download" | "guide" | "resume" | "pair" | "ready" | "repair";
interface ExpectedIdentity { serverId: string; instance: string; certificateSha256: string; serverCertificateSha256: string }
interface Progress { version: 1; expected: ExpectedIdentity; device: SecureDevice; browser: SecureBrowser; stage: "device" | "download" | "guide"; guideIndex: number }
const STORAGE_KEY = "gridlens.secure-setup.progress.v1";
const RETURN_KEY = "gridlens.secure-setup.return.v1";
let returnWallet = false;
try { returnWallet = sessionStorage.getItem(RETURN_KEY) === "wallet"; } catch { /* Optional public navigation preference. */ }
const resumeFragment = () => returnWallet ? "#resume=1&return=wallet" : "#resume=1";
const STATUS_PATH = "/secure-setup/status.json";
const stages: Stage[] = ["trust", "device", "download", "guide", "resume", "pair", "ready", "repair"];
const element = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const deviceSelect = element<HTMLSelectElement>("device"), browserSelect = element<HTMLSelectElement>("browser");
const suggested = suggestSecureDevice(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
let device = suggested.device, browser = suggested.browser;
let status: AvailableStatus | undefined, expected: ExpectedIdentity | undefined;
let stage: Stage = "trust", guideIndex = 0, busy = false, request: AbortController | undefined;
let pageHidden = false, invalidContinuation = false, resumePending = false;
let certificateURL: string | undefined, certificateURLTimer: ReturnType<typeof setTimeout> | undefined;
let connectionCode: string | undefined;
let restartHttpOrigin: string | undefined;
let resumeRequested = false;
const HTTPS = location.protocol === "https:";
const hash = /^[a-f0-9]{64}$/;
const safeId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);
const isDevice = (value: unknown): value is SecureDevice => typeof value === "string" && (SECURE_DEVICES as readonly string[]).includes(value);
const isBrowser = (value: unknown): value is SecureBrowser => typeof value === "string" && (SECURE_BROWSERS as readonly string[]).includes(value);
function identity(value: unknown): value is ExpectedIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as ExpectedIdentity;
  return Object.keys(item).length === 4 && safeId(item.serverId) && typeof item.instance === "string"
    && /^[a-z][a-z0-9-]{0,31}$/.test(item.instance) && typeof item.certificateSha256 === "string" && hash.test(item.certificateSha256)
    && typeof item.serverCertificateSha256 === "string" && hash.test(item.serverCertificateSha256);
}
function identityOf(value: AvailableStatus): ExpectedIdentity {
  return { serverId: value.serverId, instance: value.instance, certificateSha256: value.certificateSha256,
    serverCertificateSha256: value.serverCertificateSha256 };
}
function matches(a: ExpectedIdentity, b: ExpectedIdentity): boolean {
  return a.serverId === b.serverId && a.instance === b.instance && a.certificateSha256 === b.certificateSha256
    && a.serverCertificateSha256 === b.serverCertificateSha256;
}
function readProgress(): Progress | undefined {
  try {
    const text = sessionStorage.getItem(STORAGE_KEY); if (!text || text.length > 2048) return;
    const item = JSON.parse(text) as Omit<Progress, "device" | "stage"> & { device: unknown; stage: unknown };
    const selectedDevice = normalizeSecureDevice(item.device);
    if (item.version !== 1 || !identity(item.expected) || !selectedDevice || !isBrowser(item.browser)
      || !browsersFor(selectedDevice).includes(item.browser) || typeof item.stage !== "string" || !["device", "download", "guide", "open"].includes(item.stage)
      || !Number.isInteger(item.guideIndex) || item.guideIndex < 0 || item.guideIndex > 8) return;
    return { version: 1, expected: item.expected, device: selectedDevice, browser: item.browser,
      stage: item.stage === "open" ? "guide" : item.stage as Progress["stage"], guideIndex: item.stage === "open" ? 8 : item.guideIndex };
  } catch { return; }
}
function forgetProgress(): void {
  try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* Storage is optional; no access state is stored here. */ }
}
const restored = readProgress();
if (restored) { expected = restored.expected; device = restored.device; browser = restored.browser; guideIndex = restored.guideIndex; }
if (location.hash) {
  let fragment = location.hash;
  // Clear the one-use connection secret before parsing it, fetching data or rendering.
  try { history.replaceState(null, "", location.pathname + location.search); }
  catch { invalidContinuation = true; }
  const navigation = new URLSearchParams(fragment.slice(1));
  if (navigation.getAll("return").length === 1 && navigation.get("return") === "wallet") {
    returnWallet = true; navigation.delete("return"); fragment = navigation.size ? `#${navigation.toString()}` : "";
    try { sessionStorage.setItem(RETURN_KEY, "wallet"); } catch { /* Navigation still works in this page. */ }
  }
  if (!invalidContinuation && fragment === "" && returnWallet) { /* Explicit Wallet return; no credential or trust assertion. */ }
  else if (!invalidContinuation && !HTTPS && fragment === "#resume=1") resumeRequested = true;
  else try {
    const input = new URLSearchParams(fragment.slice(1));
    const names = ["server", "instance", "certificate", "leaf", "device", "browser"];
    const code = input.get("connect");
    if (invalidContinuation || !HTTPS || fragment.length > 1500 || [...input.keys()].length !== names.length + (code === null ? 0 : 1)
      || names.some(name => !input.has(name)) || [...input.keys()].some(name => !names.includes(name) && name !== "connect")
      || code !== null && !/^[A-Za-z0-9_-]{43}$/.test(code)) throw new Error("Invalid continuation.");
    const value = { serverId: input.get("server"), instance: input.get("instance"), certificateSha256: input.get("certificate"), serverCertificateSha256: input.get("leaf") };
    const selectedDevice = normalizeSecureDevice(input.get("device")), selectedBrowser = input.get("browser");
    if (!identity(value) || !selectedDevice || !isBrowser(selectedBrowser) || !browsersFor(selectedDevice).includes(selectedBrowser)) throw new Error("Invalid continuation.");
    expected = value; device = selectedDevice; browser = selectedBrowser; guideIndex = 0; connectionCode = code ?? undefined;
  } catch { invalidContinuation = true; forgetProgress(); expected = undefined; connectionCode = undefined; }
}
function saveProgress(): void {
  if (!expected) return;
  // Public identity/instructions only. Never save a trust result, session, password or pairing code.
  const savedStage = ["device", "download", "guide"].includes(stage) ? stage as Progress["stage"] : "device";
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, expected, device, browser, stage: savedStage, guideIndex } satisfies Progress)); }
  catch { /* The current page continues without persisted progress. */ }
}
function text(id: string, value: string): void { const node = element(id); if (node.textContent !== value) node.textContent = value; }
function message(value: string, error = false): void {
  text("wizard-message", value); element("wizard-message").className = error ? "error" : "muted";
  element("wizard-message").hidden = value === "";
}
function controls(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("button")) button.disabled = busy;
  deviceSelect.disabled = busy; browserSelect.disabled = busy;
  element<HTMLButtonElement>("trust-continue").disabled = busy || !element<HTMLInputElement>("trust-network").checked;
  renderProfileLinks();
}
function show(next: Stage, focus = true): void {
  stage = next;
  for (const name of stages) element(`${name}-panel`).hidden = name !== next;
  if (next === "guide") renderGuide();
  if (next === "device") { renderSelectors(); element<HTMLDetailsElement>("device-choice").open = false; }
  controls(); if (next !== "repair") saveProgress();
  if (focus) element(`${next === "ready" ? "ready" : next}-title`).focus({ preventScroll: false });
}
function repair(value: string, restart = true): void {
  connectionCode = undefined;
  message("Secure setup is not complete.", true); text("repair-message", value);
  element("repair-http").hidden = !HTTPS || !restartHttpOrigin;
  if (HTTPS && restartHttpOrigin) element<HTMLAnchorElement>("repair-http").href = `${restartHttpOrigin}/secure-setup${resumeFragment()}`;
  element("restart-setup").hidden = !restart; show("repair");
}
function options(select: HTMLSelectElement, values: readonly string[], names: Record<string, string>, selected: string): void {
  select.replaceChildren(...values.map(value => { const option = document.createElement("option"); option.value = value; option.textContent = names[value]!; return option; }));
  select.value = selected;
}
function usesSafariInstructions(): boolean {
  return browser === "safari" && (suggested.device !== "ios" || suggested.browser === "safari");
}
function safariSetupURL(): string { return status ? `${status.httpOrigin ?? status.httpsOrigin}/secure-setup${returnWallet ? "#return=wallet" : ""}` : ""; }
function downloadAdvice(): string {
  if (device === "android") return browser === "firefox"
    ? "If Firefox asks, confirm or save only the GridLens certificate you requested. Find the completed file in Downloads."
    : "If prompted for this requested GridLens certificate, your browser may offer Download anyway or another download confirmation. Find the completed file in the browser’s Downloads.";
  if (browser === "safari") return "If Safari asks permission, allow the download only for the GridLens certificate you requested. Then find the file in Downloads.";
  if (browser === "firefox") return "If Firefox asks, confirm or save only the GridLens certificate you requested. Find the completed file in Firefox Downloads.";
  return "Your browser may ask you to Keep the GridLens certificate you requested. If the popup closes, open the browser menu → Downloads.";
}
function renderSelectors(): void {
  options(deviceSelect, SECURE_DEVICES, DEVICE_NAMES, device);
  if (!browsersFor(device).includes(browser)) browser = browsersFor(device)[0]!;
  options(browserSelect, browsersFor(device), BROWSER_NAMES, browser);
  text("device-summary", `${DEVICE_NAMES[device]} · ${BROWSER_NAMES[browser]}`);
  const provided = status?.trustMode === "provided-certificate";
  element("provided-help").hidden = !provided; element("already-trusted").hidden = provided;
  const apple = device === "ios" && !provided;
  const safari = usesSafariInstructions();
  element("download-approval-notice").hidden = provided || apple;
  element("apple-profile-notice").hidden = !apple;
  element("apple-safari-help").hidden = !apple || safari;
  element("device-continue").hidden = apple;
  element("apple-profile-download").hidden = !apple || !safari;
  element<HTMLInputElement>("apple-setup-url").value = safariSetupURL();
  text("apple-copy-status", "");
  text("device-continue", provided ? "Open GridLens" : "Download certificate");
  renderDownloads(); renderProfileLinks();
}
function filename(): string {
  const extension = device === "ios" ? "mobileconfig" : "crt";
  return status ? `gridlens-${status.instance}-${status.certificateSha256.slice(0, 8)}-ca.${extension}` : `gridlens-ca.${extension}`;
}
function cleanupInstruction(): string {
  return device === "ios"
    ? "You may delete the downloaded GridLens .mobileconfig files, including duplicates. Keep the installed GridLens profile and its certificate trust in Settings; removing that profile removes the certificate. You can download the file again from Secure."
    : "You may delete the downloaded GridLens .crt files, including duplicates. You can download the file again from Secure. Keep the installed certificate in your device or browser settings.";
}
function renderDownloads(): void {
  const apple = device === "ios", privateCA = status?.trustMode === "private-ca";
  element("download-file-instruction").hidden = apple;
  element("ordinary-download-help").hidden = apple;
  element("apple-download-help").hidden = !apple;
  element("download-again").hidden = apple;
  element("apple-profile-again").hidden = !apple;
  text("download-title", apple ? "Download the certificate profile" : "Save the certificate");
  text("download-next", apple ? "Profile downloaded — Next" : "File saved — Next");
  text("download-name", filename()); text("apple-profile-name", `${filename()}${status ? ` · Profile: GridLens ${status.instance} CA (${status.certificateSha256.slice(0, 8)})` : ""}`);
  text("download-approval-notice", downloadAdvice()); text("ordinary-download-approval", downloadAdvice());
  element("chromium-download-incomplete").hidden = apple || device === "android" || !["chrome", "edge"].includes(browser);
  element("ready-download").hidden = !privateCA || apple;
  element("ready-apple-download").hidden = !privateCA || !apple || !usesSafariInstructions();
  element("ready-apple-safari-help").hidden = !privateCA || !apple || usesSafariInstructions();
  element<HTMLInputElement>("ready-apple-setup-url").value = safariSetupURL();
  element("ready-certificate-help").hidden = !privateCA;
  text("ready-certificate-help", cleanupInstruction());
}
function profileURL(): string | undefined {
  if (!status || !expected || device !== "ios" || status.trustMode !== "private-ca" || status.status !== "ready"
    || !matches(expected, identityOf(status)) || location.origin !== (HTTPS ? status.httpsOrigin : status.httpOrigin)) return;
  return new URL(`/secure-setup/apple-ca/${expected.certificateSha256}.mobileconfig`, location.origin).href;
}
function renderProfileLinks(): void {
  const url = !busy && !pageHidden ? profileURL() : undefined;
  for (const id of ["apple-profile-download", "apple-profile-again", "ready-apple-download"]) {
    const link = element<HTMLAnchorElement>(id);
    if (url) { link.href = url; link.removeAttribute("aria-disabled"); link.removeAttribute("tabindex"); }
    else { link.removeAttribute("href"); link.setAttribute("aria-disabled", "true"); link.tabIndex = -1; }
  }
}
function profileClick(event: MouseEvent, fromReady: boolean): void {
  const link = event.currentTarget as HTMLAnchorElement, url = profileURL();
  const active = fromReady ? stage === "ready" : stage === "device" || stage === "download";
  if (busy || pageHidden || !active || !url || link.href !== url || link.hidden) { event.preventDefault(); return; }
  // Preserve only public guide progress before Safari hands the real response to Settings.
  // The fingerprint-bound server route rejects rotation; no Blob or access code is involved.
  if (fromReady) { saveProgress(); message("Profile download requested. Installing it again is unnecessary if this device already trusts GridLens."); }
  else { message(""); show("download"); }
}
function renderGuide(): void {
  const steps = secureGuide(device, browser, filename()); guideIndex = Math.min(guideIndex, steps.length - 1);
  const step = steps[guideIndex]!;
  text("guide-step", `${DEVICE_NAMES[device]} · ${BROWSER_NAMES[browser]} · Step ${guideIndex + 1} of ${steps.length}`);
  text("guide-title", step.title); text("guide-instruction", step.instruction);
  text("guide-next", guideIndex === steps.length - 1 ? "I’ve imported it — Open GridLens" : "Next");
  element("guide-final-note").hidden = guideIndex !== steps.length - 1;
  text("guide-final-note", `If the next page shows a certificate warning, return here. Do not bypass it. After Fleet opens securely, ${cleanupInstruction().replace(/^You/, "you")}`);
  element("android-screen-help").hidden = device !== "android";
  element<HTMLDetailsElement>("android-screen-help").open = false;
  element("guide-help").hidden = !step.help; element<HTMLDetailsElement>("guide-help").open = false;
  text("guide-help-text", step.help ?? "");
}
function httpsURL(code?: string): string {
  if (!status || !expected) throw new Error("Missing setup.");
  const url = new URL("/secure-setup", status.httpsOrigin);
  url.hash = new URLSearchParams({ server: expected.serverId, instance: expected.instance,
    certificate: expected.certificateSha256, leaf: expected.serverCertificateSha256, device, browser,
    ...(returnWallet ? { return: "wallet" } : {}),
    ...(code === undefined ? {} : { connect: code }) }).toString();
  return url.href;
}
function renderStatus(): void {
  if (!status) return;
  element("installation-details").hidden = false;
  text("installation-name", `GridLens · ${status.instance}`); text("https-address", status.httpsOrigin);
  text("certificate-label", status.trustMode === "private-ca" ? "Public CA SHA-256" : "Supplied certificate SHA-256");
  text("certificate-fingerprint", status.certificateSha256); text("leaf-fingerprint", status.serverCertificateSha256);
  text("certificate-expiry", new Date(status.serverCertificateValidToMs).toISOString().replace("T", " ").replace(".000Z", " UTC"));
  renderDownloads(); renderProfileLinks();
  // Returning to HTTP is explicit and only uses the installer's saved endpoint.
  element<HTMLAnchorElement>("return-fleet").href = HTTPS ? "/" : `${status.httpOrigin}/`;
}
class RequestError extends Error {
  readonly status: number;
  constructor(status: number) { super("Request unavailable."); this.status = status; }
}
async function json(path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
  const response = await fetch(path, { signal, credentials: "same-origin", cache: "no-store", redirect: "error",
    ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  if (!response.ok) { await response.body?.cancel(); throw new RequestError(response.status); }
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") { await response.body?.cancel(); throw new Error("Invalid response."); }
  const reader = response.body?.getReader(); if (!reader) throw new Error("Missing response.");
  let total = 0, result = ""; const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for (;;) { const part = await reader.read(); if (part.done) break;
      total += part.value.byteLength; if (total > 32768) throw new Error("Response too large."); result += decoder.decode(part.value, { stream: true }); }
    return JSON.parse(result + decoder.decode());
  } finally { await reader.cancel().catch(() => {}); }
}
async function checkedStatus(signal: AbortSignal): Promise<boolean> {
  const value = parseBrowserSecurityStatus(await json(STATUS_PATH, signal));
  if (!value.available) { status = undefined; element("installation-details").hidden = true;
    repair("Guided HTTPS setup is not prepared on this installation. Keep using your existing Fleet address. Its operator can prepare the saved HTTPS endpoint and public certificate.", false); return false; }
  if (location.origin !== (HTTPS ? value.httpsOrigin : value.httpOrigin)) {
    forgetProgress(); repair("This page does not match the installation’s saved address. Open the address supplied by GridLens setup; do not use a guessed port or forwarded link.", false); return false;
  }
  restartHttpOrigin = value.httpOrigin ?? undefined;
  if (expected && !matches(expected, identityOf(value))) {
    forgetProgress(); status = undefined; element("installation-details").hidden = true;
    repair("The installation or certificate changed. No trust or browser access has been granted. Check the saved setup with its operator, then start again to review the current identity."); return false;
  }
  status = value; expected ??= identityOf(value); renderStatus();
  if (value.status !== "ready") {
    repair(value.status === "expired"
      ? "The saved public or server certificate has expired. Ask the GridLens operator to repair its certificate while preserving this installation. Do not bypass the browser warning."
      : "The saved certificate is not valid yet. Check the GridLens computer’s date and certificate setup. Do not bypass the browser warning.", false); return false;
  }
  return true;
}
async function run(work: (signal: AbortSignal) => Promise<void>): Promise<void> {
  if (busy || pageHidden) return;
  busy = true; controls();
  const controller = new AbortController(); request = controller;
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try { await work(controller.signal); }
  catch {
    if (!pageHidden) repair("The saved secure setup could not be checked. Check your network and retry. If the HTTPS endpoint or certificate changed, ask its operator to repair the saved setup; never bypass a certificate warning.");
  } finally {
    clearTimeout(timeout); if (request === controller) request = undefined; busy = false; controls();
    if (resumePending && !pageHidden) { resumePending = false; void load(); }
  }
}
async function load(): Promise<void> {
  await run(async signal => {
    if (!await checkedStatus(signal)) return;
    if (invalidContinuation) { repair("This setup link is invalid. It has not granted trust or access. Return to the original HTTP guide for a fresh connection link, or start again from this installation’s own GridLens page."); return; }
    if (HTTPS) { saveProgress(); await completeAccess(signal, connectionCode !== undefined || returnWallet); return; }
    if (resumeRequested) { message(""); show("resume"); return; }
    message("");
    // Only public instructions are restored; HTTPS verification never restores as complete.
    const progress = device === "ios" ? readProgress() : restored;
    const resume = progress && expected && matches(progress.expected, expected) ? progress.stage : "trust";
    show(status?.trustMode === "provided-certificate" && resume === "guide" ? "device" : resume, false);
  });
}
async function download(fromReady = false): Promise<void> {
  if (device === "ios") return;
  await run(async signal => {
    if (!await checkedStatus(signal) || !status) return;
    if (status.trustMode !== "private-ca" || status.certificateDownloadPath !== "/secure-setup/ca.crt") { show("device"); return; }
    const etag = `"${status.certificateSha256}"`;
    const response = await fetch("/secure-setup/ca.crt", { signal, credentials: "same-origin", cache: "no-store", redirect: "error", headers: { "If-Match": etag } });
    if (response.status === 412 || response.ok && response.headers.get("etag") !== etag) {
      await response.body?.cancel(); forgetProgress();
      repair("The certificate changed after the setup check. No file was saved. Check with the GridLens operator, then start again to review the current certificate."); return;
    }
    if (response.status !== 200 || response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/x-x509-ca-cert") {
      await response.body?.cancel(); throw new Error("Certificate download failed.");
    }
    const reader = response.body?.getReader(); if (!reader) throw new Error("Missing certificate.");
    let total = 0, pem = ""; const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      for (;;) { const part = await reader.read(); if (part.done) break;
        total += part.value.byteLength; if (total > 32768) throw new Error("Certificate too large."); pem += decoder.decode(part.value, { stream: true }); }
      pem += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); }
    if (!/^(?:\s*-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*){1,8}$/.test(pem)) throw new Error("Invalid public certificate.");
    if (signal.aborted || pageHidden) return;
    // The server validates certificate contents and binds this response to the checked identity.
    // These checks reject unexpected downloads; HTTP bootstrap still relies on the trusted LAN.
    revokeCertificateURL(); certificateURL = URL.createObjectURL(new Blob([pem], { type: "application/x-x509-ca-cert" }));
    const link = document.createElement("a"); link.href = certificateURL; link.download = filename();
    document.body.append(link); link.click(); link.remove();
    certificateURLTimer = setTimeout(revokeCertificateURL, 60_000);
    if (fromReady) {
      show("ready");
      message(`Certificate download requested. ${downloadAdvice()}`);
    } else { message(""); show("download"); }
  });
}
function revokeCertificateURL(): void {
  if (certificateURLTimer) clearTimeout(certificateURLTimer); certificateURLTimer = undefined;
  if (certificateURL) URL.revokeObjectURL(certificateURL); certificateURL = undefined;
}
async function existingAccess(signal: AbortSignal): Promise<boolean> {
  try {
    const value = await json("/api/shared/status", signal);
    if (!value || typeof value !== "object") throw new Error("Invalid access response.");
    const access = value as { version?: unknown; serverId?: unknown; role?: unknown };
    if (access.version !== 1 || access.serverId !== status?.serverId || !["operator", "viewer"].includes(String(access.role))) throw new Error("Invalid access identity.");
    return true;
  } catch (error) { if (error instanceof RequestError && [401, 403].includes(error.status)) return false; throw error; }
}
function connected(openFleet: boolean): void {
  connectionCode = undefined;
  if (openFleet) {
    try { sessionStorage.removeItem(RETURN_KEY); } catch { /* No credential is stored here. */ }
    message(returnWallet ? "Opening Wallet…" : "Opening Fleet…"); location.replace(returnWallet ? "/wallet" : "/");
  }
  else { message(""); show("ready"); }
}
function pairing(messageText: string): void {
  connectionCode = undefined;
  const fromHttp = !!status?.httpOrigin;
  text("pair-reason", messageText); element("pair-http").hidden = !fromHttp; element("pair-terminal").hidden = fromHttp;
  element("restart-http").hidden = !fromHttp; element("connect-browser").hidden = fromHttp;
  element("recheck-session").hidden = fromHttp;
  if (status?.httpOrigin) element<HTMLAnchorElement>("restart-http").href = `${status.httpOrigin}/secure-setup${resumeFragment()}`;
  message(""); show("pair");
}
async function completeAccess(signal: AbortSignal, openFleet: boolean): Promise<void> {
    if (!HTTPS || !window.isSecureContext) { repair("This browser does not report a secure connection. Return to the certificate steps and fix trust before continuing.", false); return; }
    if (await existingAccess(signal)) { connected(openFleet); return; }
    if (!connectionCode) {
      pairing("This browser needs a fresh connection link. Certificate trust and fleet access are separate."); return;
    }
    const code = connectionCode; connectionCode = undefined;
    try {
      const result = await json("/secure-setup/connect", signal, { version: 1, code });
      if (!result || typeof result !== "object" || Object.keys(result).length !== 2
        || (result as { version?: unknown }).version !== 1 || (result as { connected?: unknown }).connected !== true) throw new Error("Invalid connection response.");
    } catch (error) {
      if (signal.aborted) throw error;
      // A lost reply can still have installed the cookie. Check that session before offering a new link.
      if (!(error instanceof RequestError) && await existingAccess(signal)) { connected(openFleet); return; }
      pairing("This connection link could not be used. It may have expired, been used already, or lost its original access. Return to the original HTTP guide for a fresh link."); return;
    }
    if (await existingAccess(signal)) connected(openFleet);
    else pairing("The connection was not confirmed. Return to the guide and choose Open GridLens again.");
}
element("trust-network").addEventListener("change", controls);
element("trust-continue").addEventListener("click", () => { if (!busy && element<HTMLInputElement>("trust-network").checked) { message(""); show("device"); } });
deviceSelect.addEventListener("change", () => { if (!isDevice(deviceSelect.value)) return; device = deviceSelect.value; guideIndex = 0; renderSelectors(); saveProgress(); });
browserSelect.addEventListener("change", () => { if (!isBrowser(browserSelect.value) || !browsersFor(device).includes(browserSelect.value)) return; browser = browserSelect.value; guideIndex = 0; renderSelectors(); saveProgress(); });
element("device-continue").addEventListener("click", () => { if (status?.trustMode === "provided-certificate") void openGridLens(); else void download(); });
element("already-trusted").addEventListener("click", () => { void openGridLens(); });
element("download-again").addEventListener("click", () => { void download(); });
element("ready-download").addEventListener("click", () => { void download(true); });
element("apple-profile-download").addEventListener("click", event => profileClick(event, false));
element("apple-profile-again").addEventListener("click", event => profileClick(event, false));
element("ready-apple-download").addEventListener("click", event => profileClick(event, true));
function copySetupAddress(inputId: string, statusId: string): void {
  if (busy || pageHidden) return;
  const input = element<HTMLInputElement>(inputId); input.focus(); input.select();
  if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(input.value)
    .then(() => text(statusId, "Setup address copied. Paste it into Safari."))
    .catch(() => text(statusId, "The address is selected. Use your device’s Copy action, then paste it into Safari."));
  else text(statusId, "The address is selected. Use your device’s Copy action, then paste it into Safari.");
}
element("copy-apple-setup").addEventListener("click", () => copySetupAddress("apple-setup-url", "apple-copy-status"));
element("copy-ready-apple-setup").addEventListener("click", () => copySetupAddress("ready-apple-setup-url", "ready-apple-copy-status"));
element("download-back").addEventListener("click", () => show("device"));
element("download-next").addEventListener("click", () => { guideIndex = 0; message(""); show("guide"); });
element("guide-next").addEventListener("click", () => { if (guideIndex + 1 < secureGuide(device, browser, filename()).length) { guideIndex++; show("guide"); } else void openGridLens(); });
element("guide-back").addEventListener("click", () => { if (guideIndex > 0) { guideIndex--; show("guide"); } else show("download"); });
element("change-device").addEventListener("click", () => { show("device"); element<HTMLDetailsElement>("device-choice").open = true; deviceSelect.focus(); });
element("resume-open").addEventListener("click", () => { void openGridLens(); });
element("resume-guide").addEventListener("click", () => { resumeRequested = false; message(""); show("trust"); });
async function openGridLens(): Promise<void> {
  await run(async signal => {
    if (!await checkedStatus(signal) || !status) return;
    saveProgress();
    if (HTTPS) { await completeAccess(signal, connectionCode !== undefined || returnWallet); return; }
    if (status.canConnectBrowser !== true) { repair("This HTTP installation cannot connect a browser to HTTPS yet. Ask its operator to enable guided browser access, then retry. Existing Fleet access is unchanged.", false); return; }
    try {
      const handoff = parseBrowserSecurityConnectCode(await json("/secure-setup/connect-code", signal, {}));
      // The backend owns the five-minute expiry; device-clock skew cannot extend that authority.
      if (!signal.aborted && !pageHidden) location.assign(httpsURL(handoff.code));
    } catch {
      if (!pageHidden) repair("A secure browser connection link could not be created. Check your existing HTTP Fleet access and try again; no HTTPS access has been granted.");
    }
  });
}
element("recheck-session").addEventListener("click", () => { void load(); });
element("retry-setup").addEventListener("click", () => { void load(); });
element("restart-setup").addEventListener("click", () => {
  if (busy) return; forgetProgress(); expected = undefined; invalidContinuation = false; connectionCode = undefined; resumeRequested = false; guideIndex = 0;
  element<HTMLInputElement>("trust-network").checked = false;
  void run(async signal => { if (!await checkedStatus(signal)) return; if (HTTPS) await completeAccess(signal, false); else { message(""); show("trust"); } });
});
window.addEventListener("pagehide", () => {
  pageHidden = true; connectionCode = undefined; request?.abort(); revokeCertificateURL();
  for (const name of stages) element(`${name}-panel`).hidden = true;
});
window.addEventListener("pageshow", event => {
  pageHidden = false;
  if (event.persisted) {
    message("Checking the saved setup again…");
    if (busy) { resumePending = true; request?.abort(); } else void load();
  }
});
renderSelectors(); controls(); void load();
