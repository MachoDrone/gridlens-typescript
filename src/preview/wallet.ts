import { parseTreasuryConfiguration, parseTreasuryOperation, parseTreasuryPlan, parseTreasuryStatus, parseTreasuryUnlock } from "../contracts/treasury.ts";
import type { TreasuryConfiguration, TreasuryOperation, TreasuryPlan, TreasuryUnlock } from "../contracts/treasury.ts";

const element = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const text = (id: string, value: string): void => { element(id).textContent = value; };
const API = "/api/shared/treasury";
const SECURE = location.protocol === "https:" && window.isSecureContext;
const IDLE_MS = 300_000;
// Consume the terminal ticket before any requests. It never enters storage,
// referrers, a navigation URL or the browser's ordinary access session.
const fragment = new URLSearchParams(location.hash.slice(1));
let setupTicket: string | undefined = fragment.size === 1 && /^[A-Za-z0-9_-]{43}$/.test(fragment.get("ticket") ?? "")
  ? fragment.get("ticket")! : undefined;
const hadTicket = location.hash.length > 0;
if (location.hash) history.replaceState(null, "", location.pathname);
let unlockToken: string | undefined, configuration: TreasuryConfiguration | undefined, review: TreasuryPlan | undefined;
let expiresAtMs = 0, lastInteractionAtMs = 0, busy = false, generation = 0, authorizationUncertain = false;
let controller = new AbortController();
let pollTimer: ReturnType<typeof setTimeout> | undefined, reviewTimer: ReturnType<typeof setTimeout> | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const operations = new Map<string, TreasuryOperation>();
const views = ["wallet-secure", "wallet-unavailable", "wallet-owner-required", "wallet-recovery", "wallet-setup", "wallet-locked", "wallet-unlocked"];

function message(value: string, kind: "" | "failure" | "success" | "pending" = ""): void {
  const target = element("wallet-message"); target.textContent = value; target.className = kind;
}
function show(id: string): void { for (const view of views) element(view).hidden = view !== id; }
function passwordsClear(): void {
  for (const input of document.querySelectorAll<HTMLInputElement>('input[type="password"], input[data-revealed="true"]')) {
    input.value = ""; input.type = "password"; delete input.dataset.revealed;
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-password]")) {
    button.textContent = "Show"; button.setAttribute("aria-pressed", "false");
  }
}
function cancelReview(): void {
  review = undefined; clearTimeout(reviewTimer); element("wallet-review").hidden = true;
  element("transfer-review").replaceChildren(); text("review-expiry", "");
}
function controls(): void {
  for (const form of document.querySelectorAll<HTMLFormElement>("form")) {
    for (const control of form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input, select, button")) control.disabled = busy;
  }
  const consumed = authorizationUncertain || configuration?.pilotConsumed === true;
  element("pilot-finished").hidden = !consumed;
  element<HTMLButtonElement>("prepare-transfer").disabled = busy || consumed || !configuration?.hosts.length;
  element<HTMLSelectElement>("wallet-source").disabled = busy || consumed || !configuration?.hosts.length;
  element<HTMLButtonElement>("confirm-transfer").disabled = busy || !review || review.expiresAtMs <= Date.now() || consumed;
  element<HTMLButtonElement>("cancel-transfer").disabled = busy;
  element<HTMLButtonElement>("refresh-activity").disabled = busy;
}
class WalletHttpError extends Error {
  readonly status: number;
  constructor(status: number) { super("Wallet request failed."); this.status = status; }
}
async function json(path: string, body?: Record<string, unknown>, token = unlockToken): Promise<unknown> {
  if (!SECURE) throw new Error("HTTPS required.");
  const expectedGeneration = generation;
  const timeout = AbortSignal.timeout(20_000);
  const response = await fetch(`${API}${path}`, {
    method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
    headers: { Accept: "application/json", ...(token ? { "X-GridLens-Wallet": token } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify({ version: 1, ...body }) }),
    signal: AbortSignal.any([controller.signal, timeout]),
  });
  if (!response.ok) { await response.body?.cancel(); throw new WalletHttpError(response.status); }
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new Error("Invalid Wallet response.");
  const reader = response.body?.getReader(); if (!reader) throw new Error("Missing Wallet response.");
  let size = 0, data = ""; const decoder = new TextDecoder("utf-8", { fatal: true });
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > 1024 * 1024) { await reader.cancel(); throw new Error("Wallet response too large."); }
    data += decoder.decode(value, { stream: true });
  }
  if (expectedGeneration !== generation || controller.signal.aborted) throw new Error("Wallet locked.");
  return JSON.parse(data + decoder.decode());
}
function publicError(error: unknown): string {
  if (error instanceof WalletHttpError) {
    if (error.status === 429) return "Too many attempts. Wait a moment before trying again.";
    if (error.status === 401 || error.status === 403) return "Wallet access was denied or expired. Check your owner password and browser connection.";
    if (error.status === 409) return "Wallet changed or this operation is unavailable. Refresh Wallet and check recent activity.";
    if (error.status === 400) return "Check the wallet address and password, then try again.";
  }
  return "Wallet could not complete this request. Check your connection and try again.";
}
function lock(reason: string, send = true): void {
  const oldToken = unlockToken;
  unlockToken = undefined; configuration = undefined; expiresAtMs = 0; generation++;
  controller.abort(); controller = new AbortController(); clearTimeout(pollTimer); clearTimeout(idleTimer);
  cancelReview(); operations.clear(); passwordsClear(); authorizationUncertain = false; busy = false;
  element("wallet-operations").replaceChildren(); element<HTMLSelectElement>("wallet-source").replaceChildren();
  element<HTMLInputElement>("change-destination").value = ""; text("receiving-address", ""); text("source-address", "");
  element<HTMLDetailsElement>("wallet-settings").open = false; element("wallet-lock").hidden = true;
  show("wallet-locked"); message(reason); controls();
  if (send && oldToken && SECURE) {
    void fetch(`${API}/lock`, { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", keepalive: true,
      headers: { "Content-Type": "application/json", "X-GridLens-Wallet": oldToken }, body: JSON.stringify({ version: 1 }) }).catch(() => {});
  }
}
function scheduleIdle(): void {
  clearTimeout(idleTimer);
  if (!unlockToken) return;
  const remaining = Math.min(expiresAtMs, lastInteractionAtMs + IDLE_MS) - Date.now();
  if (remaining <= 0) { lock("Wallet locked. Enter your password to continue."); return; }
  idleTimer = setTimeout(scheduleIdle, remaining + 1);
}
function renewAfterAction(): void { expiresAtMs = Date.now() + IDLE_MS; scheduleIdle(); }
function userInteraction(event: Event): void {
  if (!event.isTrusted || !unlockToken) return;
  lastInteractionAtMs = Date.now(); scheduleIdle();
}
function decimal(value: string, places: number): string {
  const padded = value.padStart(places + 1, "0"), fraction = padded.slice(-places).replace(/0+$/, "");
  return padded.slice(0, -places) + (fraction ? `.${fraction}` : "");
}
function displayConfiguration(next: TreasuryConfiguration): void {
  configuration = next; text("receiving-address", next.destinationAddress);
  element<HTMLInputElement>("change-destination").value = next.destinationAddress;
  const select = element<HTMLSelectElement>("wallet-source"), previous = select.value;
  select.replaceChildren();
  const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = next.hosts.length ? "Choose one host" : "No eligible hosts"; select.append(placeholder);
  for (const host of next.hosts) {
    const option = document.createElement("option"); option.value = host.address;
    option.textContent = host.label === host.address ? host.address : `${host.label} · ${host.address}`; select.append(option);
  }
  if (next.hosts.some(host => host.address === previous)) select.value = previous;
  text("source-address", select.value); controls();
}
async function unlocked(value: TreasuryUnlock): Promise<void> {
  if (value.expiresAtMs <= Date.now()) throw new Error("Expired Wallet session.");
  setupTicket = undefined; unlockToken = value.unlockToken; expiresAtMs = value.expiresAtMs; lastInteractionAtMs = Date.now();
  passwordsClear(); element<HTMLInputElement>("setup-destination").value = "";
  displayConfiguration(value.configuration); element("wallet-lock").hidden = false; show("wallet-unlocked");
  message("Wallet unlocked.", "success"); scheduleIdle();
  try { await refreshOperations(); } catch (error) { if (unlockToken) message(publicError(error), "failure"); }
}
function operationLabel(operation: TreasuryOperation): string {
  return ({ authorized: "Transfer authorized", signed: "Transfer signed", "submission-started": "Checking transfer result",
    confirmed: "Confirmed · 1 NOS received", failed: "Transfer failed", uncertain: "Result not yet verified", cancelled: "Transfer cancelled" })[operation.phase];
}
function renderOperations(): void {
  const target = element("wallet-operations"); target.replaceChildren();
  element("activity-empty").hidden = operations.size !== 0;
  for (const operation of [...operations.values()].sort((a, b) => b.startedAtMs - a.startedAtMs)) {
    const article = document.createElement("article"); article.className = "operation";
    const heading = document.createElement("h3"); heading.textContent = operationLabel(operation);
    heading.className = operation.phase === "confirmed" ? "success" : operation.phase === "failed" ? "failure" : "pending";
    article.append(heading);
    for (const [label, value] of [["From", operation.sourceAddress], ["To", operation.destinationAddress]]) {
      const line = document.createElement("p"); line.className = "address small"; line.textContent = `${label}: ${value}`; article.append(line);
    }
    const when = document.createElement("p"); when.className = "muted small"; when.textContent = `Last checked ${new Date(operation.updatedAtMs).toLocaleString()}`; article.append(when);
    if (operation.signature) {
      const signature = document.createElement("a"); signature.href = `https://explorer.solana.com/tx/${operation.signature}`;
      signature.rel = "noopener noreferrer"; signature.target = "_blank"; signature.textContent = `View transaction ${operation.signature}`;
      signature.className = "small"; article.append(signature);
    }
    if (operation.phase === "uncertain" || operation.phase === "submission-started") {
      const note = document.createElement("p"); note.textContent = "Check this transaction's result before any further transfer. GridLens will not automatically create another transfer."; article.append(note);
    }
    target.append(article);
  }
}
function parseOperations(value: unknown): TreasuryOperation[] {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1
    || !Array.isArray((value as { operations?: unknown }).operations)) throw new Error("Invalid Wallet history.");
  const list = (value as { operations: unknown[] }).operations;
  if (list.length > 1000) throw new Error("Wallet history exceeds its bound.");
  const parsed = list.map(parseTreasuryOperation);
  if (new Set(parsed.map(operation => operation.id)).size !== parsed.length) throw new Error("Invalid Wallet history.");
  return parsed;
}
function schedulePoll(): void {
  clearTimeout(pollTimer);
  if (!unlockToken || document.hidden) return;
  if ([...operations.values()].some(operation => ["authorized", "signed", "submission-started", "uncertain"].includes(operation.phase))) {
    pollTimer = setTimeout(() => { void refreshOperations().catch(error => {
      if (!unlockToken) return;
      if (error instanceof WalletHttpError && [401, 403].includes(error.status)) { lock("Wallet locked. Enter your password to inspect activity."); return; }
      message("Activity is unavailable. Refresh it before taking further action.", "pending");
    }); }, 3000);
  }
}
async function refreshOperations(): Promise<void> {
  if (!unlockToken) return;
  const values = parseOperations(await json("/operations"));
  operations.clear(); for (const operation of values) operations.set(operation.id, operation);
  if (values.length && configuration) { configuration = { ...configuration, pilotConsumed: true }; authorizationUncertain = false; cancelReview(); }
  renderOperations(); controls(); schedulePoll();
}
async function act(work: () => Promise<void>): Promise<void> {
  if (busy) return;
  const startedGeneration = generation; busy = true; controls(); message("");
  try { await work(); }
  catch (error) {
    if (startedGeneration !== generation) return;
    if (unlockToken && error instanceof WalletHttpError && [401, 403].includes(error.status)) lock(publicError(error));
    else message(publicError(error), "failure");
  } finally { if (startedGeneration === generation) { busy = false; controls(); } }
}
async function startup(): Promise<void> {
  if (!SECURE) { setupTicket = undefined; show("wallet-secure"); message("Complete Secure setup before opening Wallet."); return; }
  await act(async () => {
    const status = parseTreasuryStatus(await json("/status", undefined, undefined));
    if (status.state === "recovery-required") { show("wallet-recovery"); message("Wallet is locked for recovery.", "pending"); return; }
    if (!status.supported) { show("wallet-unavailable"); message("Wallet is not enabled for this installation."); return; }
    if (status.state === "setup-required") {
      show(setupTicket ? "wallet-setup" : "wallet-owner-required");
      message(!setupTicket && hadTicket ? "This setup link is invalid or has expired. Request a new Wallet setup link from the installation PC." : ""); return;
    }
    setupTicket = undefined; show("wallet-locked"); message("");
  });
  if (!views.some(id => !element(id).hidden)) {
    show("wallet-unavailable"); text("unavailable-copy", "Connect this browser through Secure setup, then open Wallet again. If you were setting up the owner, request a new one-use Wallet setup link afterward.");
    const link = document.createElement("a"); link.href = "/secure-setup#return=wallet"; link.textContent = "Complete Secure setup"; link.className = "button";
    element("wallet-unavailable").append(link); setupTicket = undefined;
  }
}
function addReviewFact(label: string, value: string, address = false): void {
  const row = document.createElement("div"), name = document.createElement("dt"), detail = document.createElement("dd");
  name.textContent = label; detail.textContent = value; if (address) detail.className = "address";
  row.append(name, detail); element("transfer-review").append(row);
}
function renderReview(plan: TreasuryPlan): void {
  const quote = plan.quote; element("transfer-review").replaceChildren();
  addReviewFact("Source host", quote.sourceAddress, true); addReviewFact("Receiving wallet", quote.destinationAddress, true);
  addReviewFact("Amount received", "1 NOS");
  addReviewFact("Source NOS available", `${decimal(quote.sourceNosBaseUnits, 6)} NOS`);
  addReviewFact("Source SOL available", `${decimal(quote.sourceSolLamports, 9)} SOL`);
  addReviewFact("Network fee", `${decimal(quote.feeLamports, 9)} SOL`);
  addReviewFact("Receiving token account", quote.createDestinationAta ? "Create the wallet's NOS token account" : "Use the wallet's existing NOS token account");
  addReviewFact("Receiving token account cost", `${decimal(quote.rentLamports, 9)} SOL`);
  addReviewFact("Maximum permitted total cost", `${decimal(quote.maxCostLamports, 9)} SOL`);
  addReviewFact("Minimum SOL retained by source", `${decimal(quote.reserveLamports, 9)} SOL`);
  text("review-expiry", `Review expires ${new Date(plan.expiresAtMs).toLocaleTimeString()}.`);
  element("wallet-review").hidden = false; element("review-heading").focus();
  clearTimeout(reviewTimer); reviewTimer = setTimeout(() => {
    if (review !== plan) return;
    cancelReview(); message("This review expired. Prepare a fresh review before sending.", "pending"); controls();
  }, Math.max(0, plan.expiresAtMs - Date.now()) + 1);
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-password]")) button.addEventListener("click", () => {
  const input = element<HTMLInputElement>(button.dataset.password!); const reveal = input.type === "password";
  input.type = reveal ? "text" : "password"; input.dataset.revealed = String(reveal);
  button.textContent = reveal ? "Hide" : "Show"; button.setAttribute("aria-pressed", String(reveal));
});
element("wallet-setup-form").addEventListener("submit", event => {
  event.preventDefault(); if (!setupTicket) return;
  const password = element<HTMLInputElement>("setup-password").value;
  if (password !== element<HTMLInputElement>("setup-password-confirm").value) { message("The passwords do not match.", "failure"); return; }
  const destinationAddress = element<HTMLInputElement>("setup-destination").value.trim(), ticket = setupTicket;
  void act(async () => { try { await unlocked(parseTreasuryUnlock(await json("/setup", { ticket, password, destinationAddress }, undefined))); } finally { passwordsClear(); } });
});
element("wallet-unlock-form").addEventListener("submit", event => {
  event.preventDefault(); const password = element<HTMLInputElement>("unlock-password").value;
  void act(async () => { try { await unlocked(parseTreasuryUnlock(await json("/unlock", { password }, undefined))); } finally { passwordsClear(); } });
});
element("wallet-configuration-form").addEventListener("submit", event => {
  event.preventDefault(); const currentPassword = element<HTMLInputElement>("change-current-password").value;
  const newPassword = element<HTMLInputElement>("change-new-password").value;
  if (newPassword !== element<HTMLInputElement>("change-confirm-password").value) { message("The new passwords do not match.", "failure"); return; }
  const destinationAddress = element<HTMLInputElement>("change-destination").value.trim(); cancelReview();
  void act(async () => {
    try { await json("/configuration", { currentPassword, destinationAddress, ...(newPassword ? { newPassword } : {}) }); lock("Wallet updated. Enter your password to open it again.", false); }
    finally { passwordsClear(); }
  });
});
element<HTMLSelectElement>("wallet-source").addEventListener("change", () => { cancelReview(); text("source-address", element<HTMLSelectElement>("wallet-source").value); controls(); });
element("wallet-prepare-form").addEventListener("submit", event => {
  event.preventDefault(); const sourceAddress = element<HTMLSelectElement>("wallet-source").value;
  if (!configuration || configuration.pilotConsumed || authorizationUncertain || !configuration.hosts.some(host => host.address === sourceAddress)) return;
  cancelReview();
  void act(async () => {
    const plan = parseTreasuryPlan(await json("/prepare", { sourceAddress }));
    if (plan.quote.sourceAddress !== sourceAddress || plan.quote.destinationAddress !== configuration?.destinationAddress || plan.expiresAtMs <= Date.now()) throw new Error("Wallet review changed.");
    renewAfterAction(); review = plan; renderReview(plan); message("Review the receiving address and costs before sending.");
  });
});
element("confirm-transfer").addEventListener("click", () => {
  const plan = review;
  if (!plan || plan.expiresAtMs <= Date.now() || !configuration || configuration.pilotConsumed || authorizationUncertain || busy) return;
  const idempotencyKey = crypto.randomUUID(); cancelReview();
  void act(async () => {
    authorizationUncertain = true; controls();
    try {
      const response = await json("/confirm", { planId: plan.planId, reviewDigest: plan.reviewDigest, idempotencyKey });
      if (!response || typeof response !== "object" || (response as { version?: unknown }).version !== 1) throw new Error("Invalid confirmation response.");
      const operation = parseTreasuryOperation((response as { operation?: unknown }).operation);
      if (operation.sourceAddress !== plan.quote.sourceAddress || operation.destinationAddress !== plan.quote.destinationAddress) throw new Error("Transfer identity changed.");
      renewAfterAction();
      operations.set(operation.id, operation); configuration = { ...configuration!, pilotConsumed: true }; authorizationUncertain = false;
      renderOperations(); schedulePoll(); message(operation.phase === "confirmed" ? "Confirmed: exactly 1 NOS reached the receiving wallet." : "Transfer authorized. Follow its result in Recent activity.", operation.phase === "confirmed" ? "success" : "pending");
    } catch {
      if (unlockToken) message("The transfer result is not yet known. Refresh activity before taking any further action; do not send again.", "pending");
    }
  });
});
element("cancel-transfer").addEventListener("click", () => { cancelReview(); controls(); message("Review cancelled. No transfer was requested."); });
element("refresh-activity").addEventListener("click", () => { void act(async () => {
  displayConfiguration(parseTreasuryConfiguration(await json("/configuration"))); await refreshOperations(); message("Activity refreshed.");
}); });
element("wallet-lock").addEventListener("click", () => lock("Wallet locked."));
element("wallet-recheck").addEventListener("click", () => { show("wallet-unavailable"); void startup(); });
for (const type of ["pointerdown", "keydown", "input"]) document.addEventListener(type, userInteraction, { passive: true });
document.addEventListener("visibilitychange", () => { if (document.hidden) clearTimeout(pollTimer); else { scheduleIdle(); schedulePoll(); } });
window.addEventListener("pagehide", () => { setupTicket = undefined; lock("Wallet locked."); });
window.addEventListener("pageshow", event => { if (event.persisted) { setupTicket = undefined; lock("Wallet locked. Enter your password to continue."); void startup(); } });
void startup();
