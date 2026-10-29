// Setup sends bounded, transient credentials to the owner without browser storage,
// a host shell, or a Docker bridge.
interface SetupComputer { id: string; host: string; port: number; name: string; fingerprint: string }
interface ManagedComputer { id: string; name: string; host: string; port: number; hostCount: number; username: string | null;
  hasSavedCredential: boolean; status: "approved" | "paused" | "revoked" | "not-approved" }
interface SetupReport { status: "running" | "complete" | "failed"; total: number; completed: number;
  results: { pcId: string; name: string; status: "success" | "attention" | "failed"; hosts: number; message: string }[] }
interface SetupView { revision: number; phase: string; computers: SetupComputer[]; selected: string[]; trusted: string[]; automaticIp: boolean;
  fullMonitoring: boolean; exclusions: string[]; savedHosts: number; inspectedPcs: number; monitoringStatus: string;
  scan?: { range: string; port: number; total: number; completed: number; found: number; status: "running" | "complete" | "cancelled" | "failed" };
  network?: { backendName: string; backendAddress: string; suggestedRange?: string; verifiedAtMs: number; releaseTag?: string }; terminalConnected?: boolean;
  managed?: ManagedComputer[]; report?: SetupReport }
const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const privateNetwork = document.querySelector<HTMLMetaElement>('meta[name="gridlens-private-network"]')?.content === "1";
const terminalSetup = document.querySelector<HTMLMetaElement>('meta[name="gridlens-setup-mode"]')?.content === "terminal";
const browserSetup = document.querySelector<HTMLMetaElement>('meta[name="gridlens-setup-mode"]')?.content === "browser";
let current: SetupView | undefined;
let selected = new Set<string>();
let filtering = "";
let lastSignature = "";
let signingIn = false;
let refreshing = false;
let connected = false;
let signInRevision = 0;
let actionPending = false;
let actionRevision = 0;
let rangeTouched = false;
let portTouched = false;
let searchInitialized = false;
let searchExpanded = false;
let managerSignature = "";
let reportSignature = "";
let reportWasRunning = false;
let signInExpanded = false;
let credentialRevision = 0;
const restoreSelected = new Set<string>();
const message = (text: string, kind = "pending") => { const node = el("message"); node.textContent = text; node.className = kind; };
class RequestError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(status === 401 || status === 403 ? privateNetwork ? "Private-network access is disabled. Contact the backend operator."
      : "Access is unavailable. Open a new sign-in link from GridLens setup." : "The backend could not complete this request. Retry when it is available.");
    this.status = status;
  }
}
class CredentialFileError extends Error {}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`/api/shared/${path}`, { credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal,
      ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    if (!response.ok) throw new RequestError(response.status);
    const text = await response.text(); if (text.length > 2 * 1024 * 1024) throw new Error("Setup response was too large.");
    return JSON.parse(text) as T;
  } finally { clearTimeout(timer); }
}
function text(tag: string, value: string, className = ""): HTMLElement {
  const node = document.createElement(tag); node.textContent = value; node.className = className; return node;
}
function button(label: string, action: () => void, primary = false): HTMLButtonElement {
  const node = document.createElement("button"); node.type = "button"; node.textContent = label;
  if (primary) node.className = "primary"; node.addEventListener("click", action); return node;
}
async function act(action: string, fields: Record<string, unknown> = {}): Promise<void> {
  if (terminalSetup) return;
  if (actionPending || !current) return;
  actionPending = true; actionRevision++; renderSearch(current);
  try {
    const next = await api<SetupView>("setup-action", { action, revision: current.revision, ...fields }); render(next);
    message(action === "scan" ? "Network search started on the backend computer." : action === "cancel-scan" ? "Network search cancelled." : "Setup choice saved.", action === "scan" ? "pending" : "success");
  } catch (error) {
    message(error instanceof RequestError && error.status === 400 && action === "scan"
      ? "Check the private IP or IPv4 /23–/32 network and SSH port (1–65535), then search again."
      : error instanceof RequestError && error.status === 409 ? "Setup changed in another window. Showing the latest state; try again."
        : error instanceof Error ? error.message : "Setup failed.", "failure");
    if (error instanceof RequestError && error.status === 409) { actionPending = false; await refresh(); }
  } finally { actionPending = false; if (current) { renderSearch(current); if (browserSetup) renderManagerControls(current); } }
}
function renderSearch(view: SetupView): void {
  if (terminalSetup) { el("network-search").hidden = true; return; }
  const updateText = (id: string, value: string) => { const node = el(id); if (node.textContent !== value) node.textContent = value; };
  const visible = browserSetup ? searchExpanded || !(view.managed?.length) || view.phase === "scanning"
    : ["scan", "scanning", "select", "done"].includes(view.phase), searching = view.phase === "scanning";
  el("network-search").hidden = !visible;
  const range = el<HTMLInputElement>("network-range"), port = el<HTMLInputElement>("ssh-port");
  if (!rangeTouched && (!searchInitialized || !range.value)) range.value = view.scan?.range ?? view.network?.suggestedRange ?? "";
  if (!portTouched && !searchInitialized) port.value = String(view.scan?.port ?? 22);
  searchInitialized = true;
  const configuring = browserSetup && (view.report?.status === "running" || view.phase === "inspecting");
  range.disabled = searching || actionPending || configuring; port.disabled = searching || actionPending || configuring;
  el<HTMLButtonElement>("search-network").disabled = searching || actionPending || configuring;
  const cancel = el<HTMLButtonElement>("cancel-search"); cancel.hidden = !searching; cancel.disabled = actionPending;
  updateText("search-location", view.network
    ? `Search runs on ${view.network.backendName} (${view.network.backendAddress}), over that computer's existing network or VPN—not on this browser or phone.`
    : "Search runs on the backend computer over its existing network or VPN—not on this browser or phone.");
  updateText("network-suggestion", view.network?.suggestedRange
    ? `Suggested network: ${view.network.suggestedRange}, from the backend computer's settings checked ${new Date(view.network.verifiedAtMs).toLocaleString()}. You can choose another private range.`
    : "No network suggestion has been verified. Enter the private address or network you want this backend to search.");
  const scan = view.scan, progress = el<HTMLProgressElement>("scan-progress"), status = el("scan-status");
  progress.hidden = !searching;
  if (scan) {
    progress.max = Math.max(1, scan.total); progress.value = Math.min(scan.completed, progress.max);
    const counts = `${scan.completed} of ${scan.total} addresses checked · ${scan.found} computers found`;
    updateText("scan-status", searching ? counts : scan.status === "failed" ? "Search could not finish. Check the range and connection, then search again."
      : scan.status === "cancelled" ? `Search cancelled · ${counts}` : scan.found === 0
        ? "Search complete. No SSH computers found. Check the network or SSH port, then search again."
        : `Search complete · ${scan.found} computers found. ${browserSetup ? "Select the PCs below, then choose Add Selected PCs." : "Select computers below, then choose Selection complete."}`);
    status.className = scan.status === "failed" ? "failure" : searching || scan.status === "cancelled" || scan.found === 0 ? "pending" : "success";
  } else { updateText("scan-status", searching ? "Searching for SSH computers…" : ""); status.className = "pending"; progress.removeAttribute("value"); }
  const searchExclusions = view.phase === "done" || configuring ? [] : view.exclusions;
  const exclusions = el("scan-exclusions"), signature = JSON.stringify(searchExclusions);
  if (exclusions.dataset.signature !== signature) {
    exclusions.dataset.signature = signature; exclusions.replaceChildren();
    if (searchExclusions.length) {
      const details = document.createElement("details"); details.append(text("summary", `Search details · ${searchExclusions.length} exclusions or incomplete checks`));
      for (const value of searchExclusions) details.append(text("p", value, "pending")); exclusions.append(details);
    }
  }
}
el("network-range").addEventListener("input", () => { rangeTouched = true; });
el("ssh-port").addEventListener("input", () => { portTouched = true; });
el("network-search-form").addEventListener("submit", event => {
  event.preventDefault(); void act("scan", { range: el<HTMLInputElement>("network-range").value.trim(), port: Number(el<HTMLInputElement>("ssh-port").value) });
});
el("cancel-search").addEventListener("click", () => { void act("cancel-scan"); });
function renderTerminalSetup(view: SetupView): void {
  current = view; el("network-search").hidden = true; el("login").hidden = true; el("setup").hidden = false;
  const signature = JSON.stringify({ phase: view.phase, savedHosts: view.savedHosts, inspectedPcs: view.inspectedPcs,
    monitoringStatus: view.monitoringStatus, exclusions: view.exclusions, network: view.network });
  if (signature === lastSignature) return;
  lastSignature = signature;
  const done = view.phase === "done", step = el("step"), backend = view.network?.backendName ?? "the backend computer";
  el("step-title").textContent = done ? "Fleet ready" : "Finish setup in the terminal";
  el("step-description").textContent = done ? `${view.savedHosts} hosts saved · ${view.inspectedPcs} computers inspected`
    : `Complete setup in one terminal on ${backend}. Open Fleet after the terminal says setup is complete.`;
  step.replaceChildren();
  if (done) {
    step.append(text("p", view.monitoringStatus, "success"));
    if (view.exclusions.length) {
      const details = document.createElement("details"); details.append(text("summary", `Inspection details · ${view.exclusions.length} exclusions or incomplete checks`));
      for (const exclusion of view.exclusions) details.append(text("p", exclusion, "pending"));
      step.append(details);
    }
  }
  step.append(text("p", done ? `To add or change computers, run setup again on ${backend}.`
    : "The terminal handles search, computer selection, sign-in and monitoring choices together. This page shows the result."));
  const tag = view.network?.releaseTag;
  if (tag && /^modern-v\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(tag)) {
    const command = text("p", ""); command.append(text("code", `bash <(curl -fsSL https://github.com/MachoDrone/gridlens-typescript/releases/download/${tag}/modern-start.sh) --vpn-web`));
    step.append(command);
  } else step.append(text("p", "Run the latest GridLens installer on the backend computer with --vpn-web.", "muted"));
  const link = document.createElement("a"); link.href = "/"; link.textContent = "Open Fleet"; step.append(link);
}
interface ComputerRow extends SetupComputer { managed?: ManagedComputer }
function computerRows(view: SetupView): ComputerRow[] {
  const rows = new Map<string, ComputerRow>(view.computers.map(computer => [computer.id, { ...computer }]));
  for (const managed of view.managed ?? []) {
    const previous = rows.get(managed.id);
    rows.set(managed.id, { id: managed.id, name: managed.name, host: managed.host, port: managed.port,
      fingerprint: previous?.fingerprint ?? "", managed });
  }
  return [...rows.values()].sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
}
function selectedRows(view: SetupView): ComputerRow[] { return computerRows(view).filter(row => selected.has(row.id)); }
function configuring(view: SetupView): boolean { return view.report?.status === "running" || view.phase === "inspecting"; }
function clearComputerPassword(): void {
  credentialRevision++;
  const password = el<HTMLInputElement>("pc-password"); password.value = ""; password.type = "password";
  el("show-pc-password").textContent = "Show"; el("show-pc-password").setAttribute("aria-pressed", "false");
  const file = el<HTMLInputElement>("pc-key-file"); file.value = ""; file.setCustomValidity("");
  el<HTMLInputElement>("pc-key-passphrase").value = "";
  el<HTMLInputElement>("pc-key-sudo-password").value = "";
}
function renderManagerControls(view: SetupView): void {
  const rows = selectedRows(view), busy = actionPending || configuring(view) || view.phase === "scanning";
  el<HTMLButtonElement>("configure-computers").disabled = busy || rows.length === 0;
  for (const input of el("pc-manager").querySelectorAll<HTMLInputElement>("input[type=checkbox]")) input.disabled = busy;
  for (const button of el("pc-manager").querySelectorAll<HTMLButtonElement>("button")) button.disabled = busy;
  el<HTMLButtonElement>("add-computers").disabled = busy || rows.length === 0;
  for (const input of el("pc-configure-form").querySelectorAll<HTMLInputElement>("input")) input.disabled = busy;
  el<HTMLSelectElement>("pc-auth-method").disabled = busy;
  el<HTMLButtonElement>("show-pc-password").disabled = busy;
  el("pc-signin").hidden = rows.length === 0 || !signInExpanded;
  const missing = rows.some(row => !row.managed?.hasSavedCredential), password = el<HTMLInputElement>("pc-password");
  const keyMode = el<HTMLSelectElement>("pc-auth-method").value === "key", file = el<HTMLInputElement>("pc-key-file"), passphrase = el<HTMLInputElement>("pc-key-passphrase"), sudo = el<HTMLInputElement>("pc-key-sudo-password");
  el("pc-password-fields").hidden = keyMode; el("pc-key-fields").hidden = !keyMode;
  el<HTMLInputElement>("pc-username").required = missing || (keyMode ? !!file.files?.length : password.value.length > 0);
  password.required = !keyMode && missing;
  file.required = keyMode && (missing || passphrase.value.length > 0 || sudo.value.length > 0);
  el("pc-signin-help").textContent = rows.length === 0 ? "Choose computers from the list above."
    : missing ? `Enter the account used on the selected computers and ${keyMode ? "choose its SSH private key" : "its password"}. This sign-in will be used for your selection.`
      : keyMode ? "Leave the key file and passphrase empty to use each computer’s saved sign-in, or choose a key to update the selection."
        : "Leave the password blank to use each computer’s saved sign-in, or enter a new password to update the selection.";
  el("pc-signin").setAttribute("aria-busy", String(configuring(view)));
}
function selectForUpdate(id: string): void {
  if (!current) return;
  selected = new Set([id]); restoreSelected.clear(); clearComputerPassword();
  signInExpanded = true;
  const row = computerRows(current).find(row => row.id === id);
  el<HTMLInputElement>("pc-username").value = row?.managed?.username ?? el<HTMLInputElement>("pc-username").value;
  if (row?.managed?.status === "revoked") el<HTMLInputElement>("show-removed").checked = true;
  managerSignature = ""; renderManager(current);
  el("pc-signin").scrollIntoView({ block: "nearest", behavior: "smooth" });
  el<HTMLInputElement>(el<HTMLSelectElement>("pc-auth-method").value === "key" ? "pc-key-file" : "pc-password").focus();
}
function paintComputerList(view: SetupView): void {
  const rows = computerRows(view), filter = el<HTMLInputElement>("pc-filter").value.trim().toLowerCase();
  const shown = rows.filter(row => (row.managed?.status !== "revoked" || el<HTMLInputElement>("show-removed").checked)
    && `${row.name} ${row.host}`.toLowerCase().includes(filter));
  el("pc-selection-count").textContent = `${selected.size} selected · ${shown.length} matching computers`;
  const list = el("pc-list"); list.replaceChildren();
  if (!shown.length) list.append(text("p", rows.length ? "No computers match this filter." : "Search your network above to find PCs, then select them here.", "pending"));
  for (const row of shown) {
    const item = document.createElement("div"); item.className = "computer-row"; item.dataset.pcId = row.id;
    const label = document.createElement("label"), checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = selected.has(row.id);
    const copy = text("span", "", "computer-copy"); copy.append(text("strong", row.name));
    if (row.name !== row.host) copy.append(text("span", `${row.host}:${row.port}`, "small muted"));
    const managed = row.managed, state = managed?.status;
    const labelText = !managed ? "New computer" : state === "revoked" ? "Removed · monitoring stopped" : state === "paused" ? "Monitoring paused"
      : `${managed.hostCount} ${managed.hostCount === 1 ? "host" : "hosts"} saved · ${state === "approved" ? "Monitoring enabled" : "Monitoring not enabled"}`;
    copy.append(text("span", labelText, state === "approved" ? "small success" : "small pending"));
    checkbox.addEventListener("change", () => {
      signInExpanded = false; clearComputerPassword();
      if (checkbox.checked) selected.add(row.id); else { selected.delete(row.id); restoreSelected.delete(row.id); }
      if (selected.size === 1 && !el<HTMLInputElement>("pc-username").value && managed?.username) el<HTMLInputElement>("pc-username").value = managed.username;
      el("pc-selection-count").textContent = `${selected.size} selected · ${shown.length} matching computers`;
      renderSelectionDetails(view); renderManagerControls(view);
    });
    label.append(checkbox, copy); item.append(label);
    if (managed) {
      const actions = text("div", "", "actions");
      actions.append(button(state === "revoked" ? "Re-add computer" : "Update sign-in", () => selectForUpdate(row.id)));
      if (state !== "revoked") actions.append(button("Remove", () => {
        if (item.querySelector(".remove-confirmation")) return;
        const confirm = text("div", "", "remove-confirmation"); confirm.setAttribute("role", "group"); confirm.setAttribute("aria-label", `Remove ${row.name}`);
        confirm.append(text("p", `Remove ${row.name} from the fleet? Its monitoring will stop and its saved sign-in will be forgotten.`));
        const buttons = text("div", "", "actions"), remove = button("Remove computer", () => { void removeComputer(row.id); }); remove.className = "danger";
        buttons.append(remove, button("Keep computer", () => confirm.remove())); confirm.append(buttons); item.append(confirm); remove.focus();
      }));
      item.append(actions);
    }
    list.append(item);
  }
}
function renderSelectionDetails(view: SetupView): void {
  const rows = selectedRows(view), restores = el("pc-restore-options"), identities = el("pc-identities");
  restores.replaceChildren(); identities.replaceChildren();
  for (const row of rows) {
    if (["paused", "revoked"].includes(row.managed?.status ?? "")) {
      const label = document.createElement("label"), input = document.createElement("input"); input.type = "checkbox"; input.checked = restoreSelected.has(row.id);
      input.addEventListener("change", () => { if (input.checked) restoreSelected.add(row.id); else restoreSelected.delete(row.id); });
      label.append(input, text("span", `Re-enable monitoring for ${row.name}`)); restores.append(label);
    }
    if (row.fingerprint) { const line = text("p", `${row.name}: `, "small"); line.append(text("code", row.fingerprint)); identities.append(line); }
  }
}
function renderReport(view: SetupView): void {
  const report = view.report; el("pc-report").hidden = !report;
  if (!report) return;
  const signature = JSON.stringify({ report, savedHosts: view.savedHosts }); if (signature === reportSignature) return; reportSignature = signature;
  const running = report.status === "running", attention = report.results.filter(row => row.status !== "success").length;
  if (reportWasRunning && !running) message(attention || report.status === "failed" ? "Setup finished. Review the computers that need attention below." : "Setup complete. Your fleet is ready to view.", attention || report.status === "failed" ? "pending" : "success");
  reportWasRunning = running;
  el("pc-report-title").textContent = running ? "Setting up computers…" : "Setup results";
  const summary = el("pc-report-summary"); summary.textContent = `${report.completed} of ${report.total} computers checked · ${view.savedHosts} hosts in the fleet${attention ? ` · ${attention} need attention` : ""}`;
  summary.className = running ? "pending" : report.status === "failed" ? "failure" : attention ? "pending" : "success";
  el("open-fleet-result").hidden = running || view.savedHosts === 0;
  el("pc-report-next").textContent = running ? "GridLens is setting up the selected computers. Results will appear here."
    : view.savedHosts > 0 ? attention || report.status === "failed" ? "Review the items that need attention. Open Fleet to see the hosts already saved."
      : "Next: Open Fleet to see your hosts and live monitoring."
      : attention || report.status === "failed" ? "No hosts were saved. Update the sign-in above and retry the PCs that failed."
        : "Your fleet is empty. Find PCs on the network above to add them.";
  const progress = el<HTMLProgressElement>("pc-report-progress"); progress.hidden = !running; progress.max = Math.max(1, report.total); progress.value = report.completed;
  const list = el("pc-report-results"); list.replaceChildren();
  for (const result of report.results) {
    const row = text("div", "", "report-row"), kind = result.status === "success" ? "success" : result.status === "failed" ? "failure" : "pending";
    row.append(text("strong", result.name), text("p", `${result.status === "success" ? "Ready" : result.status === "failed" ? "Failed" : "Needs attention"} · ${result.hosts} hosts`, kind), text("p", result.message));
    if (!running && result.status !== "success") row.append(button("Update sign-in and retry", () => selectForUpdate(result.pcId)));
    list.append(row);
  }
  if (!running) clearComputerPassword();
}
function renderManager(view: SetupView): void {
  current = view; el("login").hidden = true; el("setup").hidden = true; el("monitoring").hidden = true; el("pc-manager").hidden = false;
  const rows = computerRows(view), ids = new Set(rows.map(row => row.id));
  for (const id of selected) if (!ids.has(id)) { selected.delete(id); restoreSelected.delete(id); }
  const managed = (view.managed ?? []).filter(row => row.status !== "revoked");
  el("show-removed-label").hidden = !(view.managed ?? []).some(row => row.status === "revoked");
  el("pc-manager-summary").textContent = `${managed.length} ${managed.length === 1 ? "computer" : "computers"} in the fleet · ${view.savedHosts} hosts saved. Select computers to add or update their sign-in.`;
  renderSearch(view);
  const signature = JSON.stringify({ rows, selected: [...selected] });
  if (managerSignature !== signature) { managerSignature = signature; paintComputerList(view); renderSelectionDetails(view); }
  renderManagerControls(view); renderReport(view);
}
async function removeComputer(pcId: string): Promise<void> {
  if (!current || actionPending || configuring(current)) return;
  actionPending = true; actionRevision++; renderManagerControls(current);
  try {
    const view = await api<SetupView>("setup-remove", { revision: current.revision, pcId });
    selected.delete(pcId); restoreSelected.delete(pcId); managerSignature = ""; renderManager(view); message("Computer removed from the fleet.", "success");
  } catch (error) { message(error instanceof RequestError && error.status === 409 ? "The computer list changed. Refresh the page and try again." : "The computer could not be removed. Try again.", "failure"); }
  finally { actionPending = false; if (current) { renderSearch(current); renderManagerControls(current); } }
}
el("show-network-search").addEventListener("click", () => {
  if (!current) return; searchExpanded = true; renderSearch(current); el("network-search").scrollIntoView({ block: "start", behavior: "smooth" }); el<HTMLInputElement>("network-range").focus();
});
el("add-computers").addEventListener("click", () => {
  if (!current || !selected.size || actionPending || configuring(current)) return;
  signInExpanded = true; renderManagerControls(current);
  el("pc-signin").scrollIntoView({ block: "start", behavior: "smooth" });
  el<HTMLInputElement>("pc-username").focus();
});
el("pc-filter").addEventListener("input", () => { if (current) { paintComputerList(current); renderManagerControls(current); } });
el("show-removed").addEventListener("change", () => { if (current) { paintComputerList(current); renderManagerControls(current); } });
el("select-matching").addEventListener("click", () => {
  if (!current) return; const filter = el<HTMLInputElement>("pc-filter").value.trim().toLowerCase();
  signInExpanded = false; clearComputerPassword();
  for (const row of computerRows(current)) if ((row.managed?.status !== "revoked" || el<HTMLInputElement>("show-removed").checked)
    && `${row.name} ${row.host}`.toLowerCase().includes(filter)) selected.add(row.id);
  managerSignature = ""; renderManager(current);
});
el("clear-selection").addEventListener("click", () => { selected.clear(); restoreSelected.clear(); signInExpanded = false; clearComputerPassword(); managerSignature = ""; if (current) renderManager(current); });
el("pc-password").addEventListener("input", () => { if (current) renderManagerControls(current); });
el("pc-auth-method").addEventListener("change", () => { clearComputerPassword(); if (current) renderManagerControls(current); });
el("pc-key-file").addEventListener("change", () => {
  credentialRevision++;
  const input = el<HTMLInputElement>("pc-key-file"), file = input.files?.[0];
  input.setCustomValidity(file && file.size > 64 * 1024 ? "Choose an SSH private key file no larger than 64 KB." : "");
  if (file && file.size > 64 * 1024) message("Choose an SSH private key file no larger than 64 KB.", "failure");
  if (current) renderManagerControls(current);
});
for (const id of ["pc-key-passphrase", "pc-key-sudo-password"]) el(id).addEventListener("input", () => { if (current) renderManagerControls(current); });
el("show-pc-password").addEventListener("click", () => {
  const input = el<HTMLInputElement>("pc-password"), show = input.type === "password"; input.type = show ? "text" : "password";
  el("show-pc-password").textContent = show ? "Hide" : "Show"; el("show-pc-password").setAttribute("aria-pressed", String(show));
});
el("pc-configure-form").addEventListener("submit", event => {
  event.preventDefault();
  if (!current || actionPending || configuring(current) || !selected.size) return;
  const username = el<HTMLInputElement>("pc-username").value.trim(), keyMode = el<HTMLSelectElement>("pc-auth-method").value === "key";
  const password = keyMode ? "" : el<HTMLInputElement>("pc-password").value, file = keyMode ? el<HTMLInputElement>("pc-key-file").files?.[0] : undefined;
  const passphrase = keyMode ? el<HTMLInputElement>("pc-key-passphrase").value : "";
  const sudoPassword = keyMode ? el<HTMLInputElement>("pc-key-sudo-password").value : "";
  const body: Record<string, unknown> = { revision: current.revision, selected: [...selected], ...(username ? { username } : {}), ...(password ? { password } : {}),
    fullMonitoring: el<HTMLInputElement>("pc-full-monitoring").checked, restorePcIds: [...restoreSelected].filter(id => selected.has(id)) };
  const submission = credentialRevision;
  actionPending = true; actionRevision++; renderManagerControls(current);
  void (async () => {
    if (file) {
      if (file.size > 64 * 1024) throw new CredentialFileError("Choose an SSH private key file no larger than 64 KB.");
      const privateKey = await file.text();
      if (submission !== credentialRevision) throw new Error("Sign-in changed");
      if (new TextEncoder().encode(privateKey).byteLength > 64 * 1024) throw new CredentialFileError("Choose an SSH private key file no larger than 64 KB.");
      // This is only a file-choice guard. The owner validates the actual private
      // key and passphrase before making any setup changes.
      if (!/^\s*-----BEGIN (?:(?:OPENSSH|RSA|EC|DSA|ENCRYPTED) )?PRIVATE KEY-----/.test(privateKey))
        throw new CredentialFileError("Choose an SSH private key file, not a .pub public key or wallet file.");
      body.privateKey = privateKey; if (passphrase) body.passphrase = passphrase; if (sudoPassword) body.sudoPassword = sudoPassword;
    } else if (passphrase || sudoPassword) throw new Error("Choose the key file for this sign-in");
    return api<SetupView>("setup-configure", body);
  })().then(view => {
    clearComputerPassword();
    selected.clear(); restoreSelected.clear(); signInExpanded = false; managerSignature = ""; renderManager(view);
    message("Setup started. GridLens will check the selected computers and show the results here.", "pending");
    el("pc-report").scrollIntoView({ block: "nearest", behavior: "smooth" });
  }).catch(error => {
    clearComputerPassword();
    message(error instanceof CredentialFileError ? error.message
      : error instanceof RequestError && error.status === 400 ? "Check the selected computers, username and password or SSH key/passphrase. New computers need a sign-in."
      : error instanceof RequestError && error.status === 409 ? "The computer list changed or setup is already running. Refresh the page and try again."
        : "Setup could not start. Check access and try again.", "failure");
  }).finally(() => { delete body.password; delete body.privateKey; delete body.passphrase; delete body.sudoPassword; actionPending = false; if (current) { renderSearch(current); renderManagerControls(current); } });
});

function render(view: SetupView): void {
  if (browserSetup) { renderManager(view); return; }
  if (terminalSetup) { renderTerminalSetup(view); return; }
  const sameSelection = current?.phase === "select" && view.phase === "select";
  current = view; renderSearch(view);
  // Polls may advance the revision or terminal heartbeat while a person types.
  // Rebuild a step only when its visible content changes, preserving input/focus.
  const signature = JSON.stringify({ phase: view.phase, computers: view.computers, selected: view.selected, trusted: view.trusted,
    automaticIp: view.automaticIp, fullMonitoring: view.fullMonitoring, exclusions: view.exclusions, savedHosts: view.savedHosts,
    inspectedPcs: view.inspectedPcs, monitoringStatus: view.monitoringStatus, terminalConnected: view.phase === "credentials" ? view.terminalConnected : undefined,
    reconnect: view.phase === "credentials" ? view.network?.releaseTag : undefined });
  if (signature === lastSignature) return;
  lastSignature = signature;
  if (!sameSelection) selected = new Set(view.selected);
  el("login").hidden = true; el("setup").hidden = false;
  const step = el("step"); step.replaceChildren();
  const title = el("step-title"), description = el("step-description");
  if (view.phase === "scan" || view.phase === "scanning") {
    title.textContent = "Search from the backend computer";
    description.textContent = "Choose the private network above and select Search network. GridLens finds computers offering SSH; finding a computer does not yet verify a Nosana host.";
    step.append(text("p", view.phase === "scanning" ? "Search is running. Results will appear here when it finishes." : "Choose computers from the results, then confirm their SSH identities once.", "pending"));
  } else if (view.phase === "select") {
    title.textContent = "Choose computers once"; description.textContent = "Filter by part of an IP address or name. Your selections remain selected when the filter changes.";
    const label = text("label", "Find a computer", "field"); const input = document.createElement("input"); input.type = "search";
    input.value = filtering; input.placeholder = "Name or partial IP"; label.append(input); step.append(label);
    const count = text("p", "", "count"); count.setAttribute("aria-live", "polite"); step.append(count);
    const list = text("div", "", "results"); step.append(list);
    if (!view.computers.length) step.append(text("p", "No computers to select. Change the network or SSH port above and search again.", "pending"));
    const complete = button("Selection complete", () => { void act("select", { selected: [...selected] }); }, true);
    const repaintCount = () => { const matches = view.computers.filter(matchesFilter).length; count.textContent = `${selected.size} selected · ${matches} matching computers`; complete.disabled = selected.size === 0; };
    const matchesFilter = (computer: SetupComputer) => `${computer.name} ${computer.host}`.toLowerCase().includes(filtering.trim().toLowerCase());
    const paint = () => {
      list.replaceChildren();
      for (const computer of view.computers.filter(matchesFilter)) {
        const label = document.createElement("label"), checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = selected.has(computer.id);
        checkbox.addEventListener("change", () => { if (checkbox.checked) selected.add(computer.id); else selected.delete(computer.id); repaintCount(); });
        const copy = document.createElement("span"); copy.append(text("strong", computer.name, "result-name"), text("span", `${computer.host}:${computer.port} · ${view.trusted.includes(computer.id) ? "Saved SSH identity matches" : "New SSH identity"}`, "small muted"));
        label.append(checkbox, copy); list.append(label);
      } repaintCount();
    };
    input.addEventListener("input", () => { filtering = input.value; paint(); }); paint();
    const actions = text("div", "", "actions"); actions.append(button("Select matching computers", () => { for (const row of view.computers.filter(matchesFilter)) selected.add(row.id); paint(); }), complete); step.append(actions);
  } else if (view.phase === "identities") {
    title.textContent = "Review new SSH identities"; description.textContent = "These are the computers already selected. Confirm their SSH fingerprints against a trusted record. Matching saved identities do not need another review.";
    for (const computer of view.computers.filter(row => view.selected.includes(row.id) && !view.trusted.includes(row.id))) {
      const row = text("p", `${computer.name} · ${computer.host}\n`); row.append(text("code", computer.fingerprint)); step.append(row);
    }
    step.append(button("Confirm these new identities", () => { void act("trust"); }, true));
  } else if (view.phase === "credentials") {
    title.textContent = "Sign in using the terminal"; description.textContent = "Return to the setup terminal to choose your SSH key or computer password. Key files, passphrases, passwords and sudo input stay out of this browser.";
    step.append(text("p", view.terminalConnected ? "The setup terminal is connected and ready for computer sign-in. Enter the requested details there."
      : `The setup terminal is not connected. On ${view.network?.backendName ?? "the backend computer"}, run the updated GridLens installer with --vpn-web and keep that terminal open. It will guide computer sign-in.`, "pending"));
    if (!view.terminalConnected && view.network?.releaseTag && /^modern-v\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(view.network.releaseTag)) {
      const command = text("p", ""); command.append(text("code", `bash <(curl -fsSL https://github.com/MachoDrone/gridlens-typescript/releases/download/${view.network.releaseTag}/modern-start.sh) --vpn-web`));
      step.append(command);
    }
  } else if (view.phase === "review") {
    title.textContent = "Inspect selected computers"; description.textContent = "Every verified Nosana host found on the chosen computers will be saved automatically. Incomplete checks stay visible in the results.";
    const full = document.createElement("input"); full.type = "checkbox";
    const label = document.createElement("label"); label.append(full, text("span", "Separately approve exact rewards reads and GPU monitoring for verified node bindings.")); step.append(label);
    step.append(text("p", "Rewards approval permits the fixed read inside each approved node. It does not authorize claims or transfers. GPU recorder reuse requires ownership and binding verification.", "small muted"));
    const actions = text("div", "", "actions"); actions.append(button("Inspect + automatic IP", () => { void act("inspect", { automaticIp: true, fullMonitoring: full.checked }); }, true),
      button("Inspect only", () => { void act("inspect", { automaticIp: false, fullMonitoring: full.checked }); })); step.append(actions);
  } else if (view.phase === "inspecting") {
    title.textContent = "Inspecting computers"; description.textContent = "The terminal owner is verifying exact node identities and computer associations. The existing workloads keep running.";
    step.append(text("p", "Keep the setup terminal open until it reports completion.", "pending"));
  } else {
    title.textContent = "Fleet saved"; description.textContent = `${view.savedHosts} hosts saved · ${view.inspectedPcs} computers inspected`;
    step.append(text("p", view.monitoringStatus, "success"));
    const details = document.createElement("details"); details.append(text("summary", `View inspection details · ${view.exclusions.length} exclusions or incomplete checks`));
    for (const exclusion of view.exclusions) details.append(text("p", exclusion, "pending")); step.append(details);
    const link = document.createElement("a"); link.href = "/"; link.textContent = "View fleet"; step.append(link);
  }
}
async function devices(): Promise<void> {
  const result = await api<{ devices: { deviceId: string; name: string; role: string; revokedAtMs: number | null }[] }>("devices");
  el("devices").hidden = false; const list = el("device-list"); list.replaceChildren();
  for (const device of result.devices) {
    const row = text("p", `${device.name} · ${device.role} · ${device.revokedAtMs ? "Revoked" : "Authorized"} `);
    if (!device.revokedAtMs) row.append(button("Revoke", () => { void api("revoke", { deviceId: device.deviceId }).then(devices).catch(() => message("Revocation could not be confirmed.", "failure")); })); list.append(row);
  }
}
async function monitoring(): Promise<void> {
  const result = await api<{ pcs: { pcId: string; name: string; status: string; automaticIp: boolean; rewards: boolean; gpu: boolean; nodeCount: number }[] }>("monitoring");
  el("monitoring").hidden = false; const list = el("monitoring-list"); list.replaceChildren();
  for (const pc of result.pcs) {
    const row = document.createElement("section"); row.append(text("p", `${pc.name} · ${pc.status} · ${pc.nodeCount} approved node bindings`, pc.status === "approved" ? "success" : "pending"),
      text("p", `Automatic IP ${pc.automaticIp ? "approved" : "not approved"} · Rewards ${pc.rewards ? "approved" : "not approved"} · GPU ${pc.gpu ? "approved" : "not approved"}`, "small muted"));
    const actions = text("div", "", "actions");
    for (const [action, label] of [["pause", "Pause monitoring"], ["revoke", "Revoke monitoring"], ["forget", "Forget credentials"]] as const) {
      actions.append(button(label, () => { void api("monitoring-action", { pcId: pc.pcId, action }).then(() => { message(`${pc.name}: ${label.toLowerCase()} saved.`, "success"); return monitoring(); })
        .catch(() => message("Monitoring change could not be confirmed.", "failure")); }));
    }
    row.append(actions); list.append(row);
  }
}
async function signIn(code: string): Promise<void> {
  if (privateNetwork) return;
  if (signingIn) return;
  signingIn = true; connected = false; signInRevision++;
  const submit = el<HTMLFormElement>("login-form").querySelector<HTMLButtonElement>("button[type=submit]")!;
  submit.disabled = true; el<HTMLInputElement>("code").value = "";
  message("Signing in…", "pending");
  try {
    await api("login", { version: 1, code, deviceName: el<HTMLInputElement>("device-name").value });
    signingIn = false; connected = true; message("Browser connected.", "success");
    await refresh();
  } catch (error) {
    el("login").hidden = false;
    message(error instanceof RequestError && [400, 401, 403, 409].includes(error.status)
      ? "This sign-in link or code has expired, was already used, or is not valid. Run GridLens setup again and open its new sign-in link."
      : "Sign-in could not be completed. Check your connection, then open a new sign-in link from GridLens setup.", "failure");
  } finally { signingIn = false; submit.disabled = false; }
}
el("login-form").addEventListener("submit", event => {
  event.preventDefault(); void signIn(el<HTMLInputElement>("code").value.trim());
});
el("new-code").addEventListener("click", () => { void api<{ code: string; expiresAtMs: number }>("pair-code", {})
  .then(value => {
    if (typeof value.code !== "string" || !/^[A-Za-z0-9_-]{12}$/.test(value.code) || !Number.isSafeInteger(value.expiresAtMs) || value.expiresAtMs <= Date.now()) throw new Error("Invalid connection link.");
    const link = document.createElement("a"); link.href = `${location.origin}/connect#code=${value.code}`;
    link.textContent = "Open GridLens on the other device";
    el("pair-code").replaceChildren(link, text("span", ` · Keep this link private. It works once and expires at ${new Date(value.expiresAtMs).toLocaleTimeString()}.`));
  })
  .catch(() => message("Connection code could not be created.", "failure")); });
async function refresh(): Promise<void> {
  if (signingIn || refreshing || actionPending) return;
  refreshing = true;
  const revision = signInRevision, action = actionRevision;
  try {
    const status = await api<{ role: string; serverId: string }>("status");
    if (revision !== signInRevision || action !== actionRevision) return;
    connected = true; el("login").hidden = true;
    if (status.role === "operator") {
      const view = await api<SetupView>("setup");
      if (revision !== signInRevision || action !== actionRevision) return;
      render(view); if (!privateNetwork && el("devices").hidden) await devices(); if (!browserSetup && el("monitoring").hidden) await monitoring();
    }
    else { for (const id of ["setup", "network-search", "pc-manager", "pc-signin", "pc-report"]) el(id).hidden = true; message("Shared cache connected. Open Fleet to view authorized readings.", "success"); }
  } catch (error) {
    if (revision !== signInRevision || action !== actionRevision) return;
    if (error instanceof RequestError && [401, 403].includes(error.status)) connected = false;
    el("login").hidden = privateNetwork;
    for (const id of ["setup", "network-search", "devices", "monitoring", "pc-manager", "pc-signin", "pc-report"]) el(id).hidden = true;
    clearComputerPassword();
    lastSignature = "";
    message(error instanceof RequestError && [401, 403].includes(error.status)
      ? privateNetwork ? "Private-network access is disabled. Contact the backend operator." : "Open the sign-in link shown by GridLens setup, or enter its connection code below."
      : "Backend unavailable. Check your existing network or VPN connection and try again.", "pending");
  } finally { refreshing = false; }
}
// Fragments never enter HTTP requests. Remove the one-use secret from browser
// history before submitting it, and never store or retry it automatically.
function start(): void {
  if (privateNetwork) {
    el("login").hidden = true; el("devices").hidden = true;
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    message("Connected through your private network.", "success"); void refresh(); return;
  }
  const fragment = location.hash;
  if (!fragment) { void refresh(); return; }
  const code = /^#code=([A-Za-z0-9_-]{12})$/.exec(fragment)?.[1];
  try { history.replaceState(null, "", location.pathname + location.search); }
  catch { message("The sign-in link could not be cleared safely. Open the dashboard address and enter a new connection code.", "failure"); return; }
  if (location.pathname === "/connect" && code) { void signIn(code); return; }
  message("This sign-in link is not valid. Run GridLens setup again and open its new sign-in link.", "failure");
}
start();
setInterval(() => { if (connected && !document.hidden) void refresh(); }, 3000);
export {};
