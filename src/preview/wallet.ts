import { parseTreasuryConfiguration, parseTreasuryOperation, parseTreasuryPlan, parseTreasuryPreflightFailure, parseTreasuryStatus, parseTreasuryUnlock, treasuryPreflightStatus } from "../contracts/treasury.ts";
import type { TreasuryConfiguration, TreasuryOperation, TreasuryPlan, TreasuryPreflightFailure, TreasuryUnlock } from "../contracts/treasury.ts";
import { claimUnresolved, parseClaimsOperation, parseClaimsPlan, parseClaimsStatus } from "../contracts/treasury-claims.ts";
import type { TreasuryClaimOperation, TreasuryClaimPlan, TreasuryClaimsStatus } from "../contracts/treasury-claims.ts";

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
let expiresAtMs = 0, lastInteractionAtMs = 0, busy = false, generation = 0, authorizationUncertain = false, reviewInvalidated = false;
let controller = new AbortController();
let pollTimer: ReturnType<typeof setTimeout> | undefined, reviewTimer: ReturnType<typeof setTimeout> | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const operations = new Map<string, TreasuryOperation>();
let claimsStatus: TreasuryClaimsStatus | undefined, claimReview: TreasuryClaimPlan | undefined;
let claimReviewInvalidated = false, uncertainClaimSource: string | undefined;
let uncertainClaimPayout: string | undefined;
let claimReviewTimer: ReturnType<typeof setTimeout> | undefined, claimPollTimer: ReturnType<typeof setTimeout> | undefined;
let claimReadPending = false;
let claimMutationRevision = 0;
const claimOperations = new Map<string, TreasuryClaimOperation>();
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
  review = undefined; reviewInvalidated = false; clearTimeout(reviewTimer); element("wallet-review").hidden = true;
  element("transfer-review").replaceChildren(); text("review-expiry", "");
}
function cancelClaimReview(): void {
  claimReview = undefined; claimReviewInvalidated = false; clearTimeout(claimReviewTimer);
  element("claim-review").hidden = true; element("claim-review-details").replaceChildren(); text("claim-review-expiry", "");
}
function claimsBlocked(): boolean {
  return !claimsStatus?.supported || claimsStatus.state !== "ready" || claimsStatus.unresolvedOperationId !== null || uncertainClaimSource !== undefined
    || [...claimOperations.values()].some(operation => claimUnresolved(operation.phase));
}
function controls(): void {
  for (const form of document.querySelectorAll<HTMLFormElement>("form")) {
    for (const control of form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input, select, button")) control.disabled = busy;
  }
  const consumed = authorizationUncertain || configuration?.pilotConsumed === true;
  element("pilot-finished").hidden = !consumed;
  element<HTMLButtonElement>("prepare-transfer").disabled = busy || consumed || !configuration?.hosts.length;
  element<HTMLSelectElement>("wallet-source").disabled = busy || consumed || !configuration?.hosts.length;
  element<HTMLButtonElement>("confirm-transfer").disabled = busy || !review || reviewInvalidated || review.expiresAtMs <= Date.now() || consumed;
  element<HTMLButtonElement>("cancel-transfer").disabled = busy;
  element<HTMLButtonElement>("refresh-activity").disabled = busy;
  const selectedClaimSource = element<HTMLSelectElement>("claim-source").value;
  const eligible = claimsStatus?.eligibleHosts.some(host => host.address === selectedClaimSource)
    && !claimsStatus.attemptedHosts.includes(selectedClaimSource);
  element<HTMLSelectElement>("claim-source").disabled = busy || claimsBlocked() || claimReview !== undefined;
  element<HTMLButtonElement>("prepare-claim").disabled = busy || claimsBlocked() || claimReview !== undefined || !eligible;
  element<HTMLButtonElement>("confirm-claim").disabled = busy || claimsBlocked() || !claimReview || claimReviewInvalidated
    || claimReview.expiresAtMs <= Date.now() || !eligible;
  element<HTMLButtonElement>("cancel-claim").disabled = busy;
  element<HTMLButtonElement>("refresh-claims").disabled = busy || claimReadPending;
}
class WalletHttpError extends Error {
  readonly status: number;
  readonly preflight: TreasuryPreflightFailure | undefined;
  constructor(status: number, preflight?: TreasuryPreflightFailure) { super("Wallet request failed."); this.status = status; this.preflight = preflight; }
}
class WalletSuperseded extends Error {}
async function json(path: string, body?: Record<string, unknown>, token = unlockToken): Promise<unknown> {
  if (!SECURE) throw new Error("HTTPS required.");
  const expectedGeneration = generation;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new DOMException("Wallet request timed out.", "TimeoutError")), path === "/prepare" || path === "/claims/prepare" ? 55_000 : 20_000);
  try {
    const response = await fetch(`${API}${path}`, {
    method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
    headers: { Accept: "application/json", ...(token ? { "X-GridLens-Wallet": token } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify({ version: 1, ...body }) }),
      signal: AbortSignal.any([controller.signal, timeout.signal]),
    });
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      await response.body?.cancel();
      throw response.ok ? new Error("Invalid Wallet response.") : new WalletHttpError(response.status);
    }
    const reader = response.body?.getReader();
    if (!reader) throw response.ok ? new Error("Missing Wallet response.") : new WalletHttpError(response.status);
    let size = 0, data = ""; const decoder = new TextDecoder("utf-8", { fatal: true });
    let value: unknown;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > (response.ok ? 1024 * 1024 : 8192)) { await reader.cancel(); throw new Error("Wallet response too large."); }
        data += decoder.decode(value, { stream: true });
      }
      value = JSON.parse(data + decoder.decode());
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (!response.ok) throw new WalletHttpError(response.status);
      throw error;
    }
    if (expectedGeneration !== generation || controller.signal.aborted) throw new Error("Wallet locked.");
    if (!response.ok) {
      let preflight: TreasuryPreflightFailure | undefined;
      if (["/prepare", "/confirm", "/claims/prepare", "/claims/confirm"].includes(path)) {
        try {
          const failure = parseTreasuryPreflightFailure(value);
          if (response.status === treasuryPreflightStatus(failure.code)) preflight = failure;
        } catch { /* An unknown or extended error envelope supplies no authority or prose. */ }
      }
      throw new WalletHttpError(response.status, preflight);
    }
    return value;
  } catch (error) {
    if (expectedGeneration !== generation) throw new WalletSuperseded();
    throw error;
  } finally { clearTimeout(timer); }
}
function publicError(error: unknown, action: "transfer" | "claim" = "transfer"): string {
  if (error instanceof WalletHttpError) {
    if (error.preflight) {
      const failure = error.preflight;
      const retry = failure.retryAtMs !== undefined && failure.retryAtMs > Date.now()
        ? ` Try again after ${new Date(failure.retryAtMs).toLocaleString()}.` : " Try again later.";
      const reason = {
        "budget-wait": `GridLens is waiting for enough shared blockchain request capacity.${retry}`,
        "provider-unavailable": `The balance provider could not complete this check.${retry}`,
        "insufficient-nos": "This host does not have 1 NOS available to send. Choose another host or review again after its balance changes.",
        "insufficient-sol-reserve": "This host needs enough SOL to pay the costs and retain its 0.05 SOL reserve. Review again after its balance changes.",
        "cost-limit": "The cost is above the amount you reviewed or the 0.005 SOL limit. Prepare a new review.",
        "account-invalid": "The source or receiving token account could not be validated for this NOS transfer. Check the receiving wallet and selected host.",
        "source-changed": "The selected host's identity or access changed. Check it in Hosts, then prepare a new review.",
        "review-expired": "This review can no longer be used. Prepare a new review before sending.",
        "preflight-unavailable": "GridLens could not finish checking this transfer. Prepare a new review later.",
        "no-claimable-rewards": "No claimable uptime rewards are currently reported for this host. Refresh claim availability after monitoring updates.",
        "rewards-unavailable": "Current rewards could not be verified. Wait for monitoring to update, then review again.",
      }[failure.code];
      const claimReason = failure.code === "insufficient-nos" ? "No claimable uptime rewards are currently reported for this host."
        : failure.code === "preflight-unavailable" ? "GridLens could not finish checking this rewards claim. Prepare a new review later."
          : failure.code === "review-expired" ? "This claim review can no longer be used. Prepare a new review before claiming." : reason;
      return action === "claim" ? `${claimReason} No claim was authorized.` : `${reason} No transfer was authorized.`;
    }
    if (error.status === 429) return "Too many attempts. Wait a moment before trying again.";
    if (error.status === 401 || error.status === 403) return "Wallet access was denied or expired. Check your owner password and browser connection.";
    if (error.status === 409) return action === "claim" ? "Claim availability changed. Refresh claim activity before trying again."
      : "Wallet changed or this operation is unavailable. Refresh Wallet and check recent activity.";
    if (error.status === 400) return action === "claim" ? "Check the selected host and prepare a new claim review." : "Check the wallet address and password, then try again.";
    return "Wallet could not complete this request. Try again later.";
  }
  return "Wallet could not complete this request. Check your connection and try again.";
}
function lock(reason: string, send = true): void {
  const oldToken = unlockToken;
  unlockToken = undefined; configuration = undefined; expiresAtMs = 0; generation++;
  controller.abort(); controller = new AbortController(); clearTimeout(pollTimer); clearTimeout(idleTimer);
  clearTimeout(claimPollTimer); cancelClaimReview(); claimOperations.clear(); claimsStatus = undefined; uncertainClaimSource = undefined; uncertainClaimPayout = undefined; claimReadPending = false;
  element("claim-operations").replaceChildren(); element<HTMLSelectElement>("claim-source").replaceChildren(); text("claim-source-address", "");
  text("claims-status", "Checking claim availability…"); element("claim-history-coverage").hidden = true;
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
  const expectedGeneration = generation;
  try { await refreshOperations(); } catch (error) { if (expectedGeneration === generation && unlockToken) message(publicError(error), "failure"); }
  if (expectedGeneration !== generation) return;
  try { await refreshClaims(); } catch (error) { claimsReadFailed(error); }
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
function renderClaimSources(): void {
  const select = element<HTMLSelectElement>("claim-source"), previous = select.value;
  select.replaceChildren();
  const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = "Choose one host"; select.append(placeholder);
  const eligible = new Map(claimsStatus?.eligibleHosts.map(host => [host.address, host.label]) ?? []);
  const attempted = new Set(claimsStatus?.attemptedHosts ?? []);
  for (const host of configuration?.hosts ?? []) {
    const option = document.createElement("option"); option.value = host.address;
    option.disabled = attempted.has(host.address) || !eligible.has(host.address);
    const label = eligible.get(host.address) ?? host.label;
    option.textContent = `${label === host.address ? host.address : `${label} · ${host.address}`}${attempted.has(host.address)
      ? " — claim already attempted" : !eligible.has(host.address) ? " — no verified claimable rewards" : ""}`;
    select.append(option);
  }
  if (eligible.has(previous) && !attempted.has(previous)) select.value = previous;
  text("claim-source-address", select.value);
}
function renderClaimStatus(): void {
  const target = element("claims-status"); target.className = "muted";
  if (uncertainClaimSource) { target.textContent = "A claim needs verification. Check its activity before any further claim; do not claim it again."; target.className = "pending"; }
  else if (!claimsStatus) target.textContent = "Claim availability could not be checked. Refresh claim activity before continuing.";
  else if (claimsStatus.state === "recovery-required") {
    target.textContent = "Rewards claims need recovery on the installation PC. Existing claim activity is retained."; target.className = "pending";
  } else if ([...claimOperations.values()].some(operation => operation.phase === "needs-verification")) {
    target.textContent = "A claim needs verification. Check its activity before any further claim; do not claim it again."; target.className = "pending";
  } else if (claimsBlocked()) { target.textContent = "A claim is still being verified. Other claims will be available after its result is established."; target.className = "pending"; }
  else if (!claimsStatus.eligibleHosts.length && configuration?.hosts.length
    && configuration.hosts.every(host => claimsStatus!.attemptedHosts.includes(host.address)))
    target.textContent = "Each current host has already had its claim attempt in this test. Its claim activity remains below.";
  else if (!claimsStatus.eligibleHosts.length) target.textContent = "No hosts currently have verified rewards available for this test. Refresh after monitoring updates.";
  else target.textContent = "Choose a host and review its full available rewards before claiming.";
}
function claimLabel(operation: TreasuryClaimOperation): string {
  if (operation.phase === "confirmed") return `Claim verified · ${decimal(operation.paidAmountBaseUnits!, 6)} NOS received by host`;
  return { authorized: "Claim authorized", "dispatch-started": "Claim request started", verifying: "Verifying claim receipt",
    "needs-verification": "Claim needs verification", failed: "Claim failed", cancelled: "Claim cancelled" }[operation.phase];
}
function renderClaimOperations(total = claimOperations.size): void {
  const target = element("claim-operations"); target.replaceChildren();
  element("claim-activity-empty").hidden = claimOperations.size !== 0;
  element("claim-history-coverage").hidden = total <= claimOperations.size;
  text("claim-history-coverage", `Showing ${claimOperations.size} recent claims of ${total} recorded.`);
  for (const operation of [...claimOperations.values()].sort((a, b) => b.startedAtMs - a.startedAtMs)) {
    const article = document.createElement("article"); article.className = "operation";
    const heading = document.createElement("h3"); heading.textContent = claimLabel(operation);
    heading.className = operation.phase === "confirmed" ? "success" : operation.phase === "failed" ? "failure" : "pending"; article.append(heading);
    for (const [label, value] of [["Host wallet", operation.payoutOwner], ["Host NOS account", operation.payoutTokenAddress]]) {
      const line = document.createElement("p"); line.className = "address small"; line.textContent = `${label}: ${value}`; article.append(line);
    }
    const reading = document.createElement("p"); reading.className = "muted small";
    reading.textContent = `Last reported before this claim: ${decimal(operation.lastReportedAmountBaseUnits, 6)} NOS. Updated ${new Date(operation.updatedAtMs).toLocaleString()}.`; article.append(reading);
    if (operation.phase === "confirmed") {
      const paid = document.createElement("p"); paid.textContent = `Verified payment: ${decimal(operation.paidAmountBaseUnits!, 6)} NOS into this host's wallet.`; article.append(paid);
    } else if (operation.phase === "needs-verification") {
      const warning = document.createElement("p"); warning.textContent = "The payment has not been verified. No new claim will be sent for this host."; article.append(warning);
    }
    if (operation.signature) {
      const link = document.createElement("a"); link.href = `https://explorer.solana.com/tx/${operation.signature}`;
      link.target = "_blank"; link.rel = "noopener noreferrer"; link.className = "small";
      link.textContent = `View ${operation.phase === "confirmed" ? "verified " : ""}claim transaction ${operation.signature}`; article.append(link);
    }
    target.append(article);
  }
}
function parseClaimOperations(value: unknown): { operations: TreasuryClaimOperation[]; total: number } {
  if (!value || typeof value !== "object" || Object.keys(value).some(key => !["version", "operations", "total"].includes(key))
    || (value as { version?: unknown }).version !== 1 || !Array.isArray((value as { operations?: unknown }).operations)) throw new Error("Invalid claim activity.");
  const input = value as { operations: unknown[]; total?: unknown };
  if (input.operations.length > 100 || !Number.isSafeInteger(input.total) || Number(input.total) < input.operations.length || Number(input.total) > 10_000) throw new Error("Invalid claim activity count.");
  const values = input.operations.map(parseClaimsOperation);
  if (new Set(values.map(operation => operation.id)).size !== values.length) throw new Error("Duplicate claim activity.");
  return { operations: values, total: Number(input.total) };
}
function claimsReadFailed(error: unknown): void {
  if (!unlockToken || error instanceof WalletSuperseded) return;
  if (error instanceof WalletHttpError && [401, 403].includes(error.status)) { lock(publicError(error, "claim")); return; }
  claimsStatus = undefined; renderClaimStatus(); controls();
}
async function refreshClaims(): Promise<void> {
  if (!unlockToken || claimReadPending) return;
  const expectedGeneration = generation, expectedRevision = claimMutationRevision;
  claimReadPending = true; controls();
  try {
    const status = parseClaimsStatus(await json("/claims/status"));
    if (status.eligibleHosts.some(host => !configuration?.hosts.some(row => row.address === host.address))) throw new Error("Claim host selection changed.");
    const history = parseClaimOperations(await json("/claims/operations"));
    // A global pending operation can belong to another authorized scope. Its
    // opaque ID blocks new claims without fetching another scope's details.
    if (expectedGeneration !== generation || expectedRevision !== claimMutationRevision) return;
    if (history.operations.some(operation => !status.attemptedHosts.includes(operation.sourceAddress))) throw new Error("Claim activity is changing. Refresh it again.");
    if (uncertainClaimSource && history.operations.some(operation => operation.sourceAddress === uncertainClaimSource
      && (operation.payoutOwner !== uncertainClaimSource || operation.payoutTokenAddress !== uncertainClaimPayout))) throw new Error("Claim receipt destination changed.");
    claimsStatus = status;
    claimOperations.clear(); for (const operation of history.operations) claimOperations.set(operation.id, operation);
    if (uncertainClaimSource && history.operations.some(operation => operation.sourceAddress === uncertainClaimSource)) { uncertainClaimSource = undefined; uncertainClaimPayout = undefined; }
    if (claimReview && (status.attemptedHosts.includes(claimReview.quote.sourceAddress) || status.unresolvedOperationId !== null)) cancelClaimReview();
    renderClaimSources(); renderClaimStatus(); renderClaimOperations(history.total);
  } finally {
    if (expectedGeneration === generation) { claimReadPending = false; controls(); scheduleClaimPoll(); }
  }
}
function scheduleClaimPoll(): void {
  clearTimeout(claimPollTimer);
  if (!unlockToken || document.hidden) return;
  const pending = uncertainClaimSource !== undefined || [...claimOperations.values()].some(operation => ["authorized", "dispatch-started", "verifying"].includes(operation.phase))
    || claimsStatus?.unresolvedOperationId != null && claimOperations.get(claimsStatus.unresolvedOperationId)?.phase !== "needs-verification";
  if (pending) claimPollTimer = setTimeout(() => {
    if (busy) { scheduleClaimPoll(); return; }
    void refreshClaims().catch(claimsReadFailed);
  }, 3000);
}
function claimReviewFact(label: string, value: string, address = false): void {
  const row = document.createElement("div"), name = document.createElement("dt"), detail = document.createElement("dd");
  name.textContent = label; detail.textContent = value; if (address) detail.className = "address";
  row.append(name, detail); element("claim-review-details").append(row);
}
function renderClaimReview(plan: TreasuryClaimPlan): void {
  const quote = plan.quote; element("claim-review-details").replaceChildren();
  claimReviewFact("Claim", "All available host-uptime rewards");
  claimReviewFact("Last reported claimable rewards", `${decimal(quote.lastReportedAmountBaseUnits, 6)} NOS`);
  claimReviewFact("Rewards checked", new Date(quote.checkedAtMs).toLocaleString());
  claimReviewFact("Host receiving the claim", quote.payoutOwner, true);
  claimReviewFact("Host NOS token account", quote.payoutTokenAddress, true);
  text("claim-review-expiry", `Review expires ${new Date(plan.expiresAtMs).toLocaleTimeString()}.`);
  element("claim-review").hidden = false; element("claim-review-heading").focus();
  clearTimeout(claimReviewTimer); claimReviewTimer = setTimeout(() => {
    if (claimReview !== plan) return;
    cancelClaimReview(); message("This claim review can no longer be used. Prepare a new review before claiming.", "pending"); controls();
  }, Math.max(0, plan.expiresAtMs - Date.now()) + 1);
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
async function act(work: () => Promise<void>, action: "transfer" | "claim" = "transfer"): Promise<void> {
  if (busy) return;
  const startedGeneration = generation; busy = true; controls(); message("");
  try { await work(); }
  catch (error) {
    if (startedGeneration !== generation) return;
    if (unlockToken && error instanceof WalletHttpError && [401, 403].includes(error.status)) lock(publicError(error, action));
    else message(publicError(error, action), "failure");
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
  const destinationAddress = element<HTMLInputElement>("change-destination").value.trim(); cancelReview(); cancelClaimReview();
  void act(async () => {
    try { await json("/configuration", { currentPassword, destinationAddress, ...(newPassword ? { newPassword } : {}) }); lock("Wallet updated. Enter your password to open it again.", false); }
    finally { passwordsClear(); }
  });
});
element<HTMLSelectElement>("wallet-source").addEventListener("change", () => { cancelReview(); text("source-address", element<HTMLSelectElement>("wallet-source").value); controls(); });
element<HTMLSelectElement>("claim-source").addEventListener("change", () => {
  cancelClaimReview(); text("claim-source-address", element<HTMLSelectElement>("claim-source").value); controls();
});
element("wallet-claim-prepare-form").addEventListener("submit", event => {
  event.preventDefault(); const sourceAddress = element<HTMLSelectElement>("claim-source").value;
  if (claimsBlocked() || claimReview || !claimsStatus?.eligibleHosts.some(host => host.address === sourceAddress)
    || claimsStatus.attemptedHosts.includes(sourceAddress)) return;
  cancelReview(); cancelClaimReview();
  void act(async () => {
    message("Checking this host's claimable rewards…", "pending");
    const plan = parseClaimsPlan(await json("/claims/prepare", { sourceAddress }));
    if (plan.quote.sourceAddress !== sourceAddress || plan.quote.payoutOwner !== sourceAddress || plan.expiresAtMs <= Date.now()
      || plan.quote.checkedAtMs > Date.now() + 15_000) throw new Error("Claim recipient or reading changed.");
    renewAfterAction(); claimReview = plan; renderClaimReview(plan);
    message("Review the full claim and this host's receiving account before confirming.");
  }, "claim");
});
element("confirm-claim").addEventListener("click", () => {
  const plan = claimReview;
  if (!plan || claimReviewInvalidated || plan.expiresAtMs <= Date.now() || claimsBlocked() || busy
    || !claimsStatus?.eligibleHosts.some(host => host.address === plan.quote.sourceAddress)) return;
  const startedGeneration = generation, idempotencyKey = crypto.randomUUID(); claimMutationRevision++;
  void act(async () => {
    try {
      const value = await json("/claims/confirm", { planId: plan.planId, reviewDigest: plan.reviewDigest, idempotencyKey });
      if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1) throw new Error("Invalid claim response.");
      const operation = parseClaimsOperation((value as { operation?: unknown }).operation);
      if (operation.sourceAddress !== plan.quote.sourceAddress || operation.payoutOwner !== plan.quote.payoutOwner
        || operation.payoutTokenAddress !== plan.quote.payoutTokenAddress) throw new Error("Claim recipient changed.");
      renewAfterAction(); cancelClaimReview(); uncertainClaimSource = undefined; uncertainClaimPayout = undefined;
      claimOperations.set(operation.id, operation);
      if (claimsStatus) claimsStatus = { ...claimsStatus,
        attemptedHosts: [...new Set([...claimsStatus.attemptedHosts, operation.sourceAddress])],
        eligibleHosts: claimsStatus.eligibleHosts.filter(host => host.address !== operation.sourceAddress),
        unresolvedOperationId: claimUnresolved(operation.phase) ? operation.id : null };
      renderClaimSources(); renderClaimStatus(); renderClaimOperations(); scheduleClaimPoll();
      message(operation.phase === "confirmed" ? `Claim verified: ${decimal(operation.paidAmountBaseUnits!, 6)} NOS reached this host's wallet.`
        : operation.phase === "needs-verification" ? "This claim needs verification. Check its activity before any further claim."
          : "Claim authorized. Its receipt will be shown in Rewards claim activity.", operation.phase === "confirmed" ? "success" : "pending");
      void refreshClaims().catch(claimsReadFailed);
    } catch (error) {
      if (startedGeneration !== generation || !unlockToken) return;
      if (error instanceof WalletHttpError && error.preflight) {
        if (error.preflight.code === "review-expired") claimReviewInvalidated = true;
        message(publicError(error, "claim"), "pending");
      } else if (error instanceof WalletHttpError && [401, 403].includes(error.status)) lock(publicError(error, "claim"));
      else {
        uncertainClaimSource = plan.quote.sourceAddress; uncertainClaimPayout = plan.quote.payoutTokenAddress;
        cancelClaimReview(); renderClaimStatus(); scheduleClaimPoll();
        message("The claim result needs verification. Refresh claim activity before taking further action; do not claim again.", "pending");
      }
    }
  }, "claim");
});
element("cancel-claim").addEventListener("click", () => { cancelClaimReview(); controls(); message("Claim review cancelled. No claim was requested."); });
element("refresh-claims").addEventListener("click", () => { void act(async () => {
  try { await refreshClaims(); message("Claim activity refreshed."); }
  catch (error) { claimsReadFailed(error); if (unlockToken && !(error instanceof WalletSuperseded)) message(publicError(error, "claim"), "failure"); }
}, "claim"); });
element("wallet-prepare-form").addEventListener("submit", event => {
  event.preventDefault(); const sourceAddress = element<HTMLSelectElement>("wallet-source").value;
  if (!configuration || configuration.pilotConsumed || authorizationUncertain || !configuration.hosts.some(host => host.address === sourceAddress)) return;
  cancelReview(); cancelClaimReview();
  void act(async () => {
    message("Checking balances and costs…", "pending");
    const plan = parseTreasuryPlan(await json("/prepare", { sourceAddress }));
    if (plan.quote.sourceAddress !== sourceAddress || plan.quote.destinationAddress !== configuration?.destinationAddress || plan.expiresAtMs <= Date.now()) throw new Error("Wallet review changed.");
    renewAfterAction(); review = plan; renderReview(plan); message("Review the receiving address and costs before sending.");
  });
});
element("confirm-transfer").addEventListener("click", () => {
  const plan = review;
  if (!plan || reviewInvalidated || plan.expiresAtMs <= Date.now() || !configuration || configuration.pilotConsumed || authorizationUncertain || busy) return;
  const idempotencyKey = crypto.randomUUID(), startedGeneration = generation;
  void act(async () => {
    try {
      const response = await json("/confirm", { planId: plan.planId, reviewDigest: plan.reviewDigest, idempotencyKey });
      if (!response || typeof response !== "object" || (response as { version?: unknown }).version !== 1) throw new Error("Invalid confirmation response.");
      const operation = parseTreasuryOperation((response as { operation?: unknown }).operation);
      if (operation.sourceAddress !== plan.quote.sourceAddress || operation.destinationAddress !== plan.quote.destinationAddress) throw new Error("Transfer identity changed.");
      renewAfterAction();
      operations.set(operation.id, operation); configuration = { ...configuration!, pilotConsumed: true }; authorizationUncertain = false;
      cancelReview();
      renderOperations(); schedulePoll(); message(operation.phase === "confirmed" ? "Confirmed: exactly 1 NOS reached the receiving wallet." : "Transfer authorized. Follow its result in Recent activity.", operation.phase === "confirmed" ? "success" : "pending");
    } catch (error) {
      if (startedGeneration !== generation || !unlockToken) return;
      if (error instanceof WalletHttpError && error.preflight) {
        authorizationUncertain = false;
        if (error.preflight.code === "review-expired") reviewInvalidated = true;
        message(publicError(error), "pending");
      } else if (error instanceof WalletHttpError && [401, 403].includes(error.status)) lock(publicError(error));
      else {
        authorizationUncertain = true; cancelReview();
        message("The transfer result is not yet known. Refresh activity before taking any further action; do not send again.", "pending");
      }
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
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { clearTimeout(pollTimer); clearTimeout(claimPollTimer); }
  else { scheduleIdle(); schedulePoll(); scheduleClaimPoll(); }
});
window.addEventListener("pagehide", () => { setupTicket = undefined; lock("Wallet locked."); });
window.addEventListener("pageshow", event => { if (event.persisted) { setupTicket = undefined; lock("Wallet locked. Enter your password to continue."); void startup(); } });
void startup();
