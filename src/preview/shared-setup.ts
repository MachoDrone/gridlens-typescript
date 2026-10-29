// This separate setup entry point has no privileged browser bridge or secret inputs.
interface SetupComputer { id: string; host: string; port: number; name: string; fingerprint: string }
interface SetupView { revision: number; phase: string; computers: SetupComputer[]; selected: string[]; trusted: string[]; automaticIp: boolean;
  fullMonitoring: boolean; exclusions: string[]; savedHosts: number; inspectedPcs: number; monitoringStatus: string }
const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const privateNetwork = document.querySelector<HTMLMetaElement>('meta[name="gridlens-private-network"]')?.content === "1";
let current: SetupView | undefined;
let selected = new Set<string>();
let filtering = "";
let lastSignature = "";
let signingIn = false;
let refreshing = false;
let connected = false;
let signInRevision = 0;
const message = (text: string, kind = "pending") => { const node = el("message"); node.textContent = text; node.className = kind; };
class RequestError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(status === 401 || status === 403 ? privateNetwork ? "Private-network access is disabled. Contact the backend operator."
      : "Access is unavailable. Open a new sign-in link from GridLens setup." : "The backend could not complete this request. Retry when it is available.");
    this.status = status;
  }
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`/api/shared/${path}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal,
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
  try { const next = await api<SetupView>("setup-action", { action, revision: current?.revision, ...fields }); render(next); message("Setup choice saved.", "success"); }
  catch (error) { message(error instanceof Error ? error.message : "Setup failed.", "failure"); }
}
function render(view: SetupView): void {
  if (JSON.stringify(view) === lastSignature) return;
  const sameSelection = current?.phase === "select" && view.phase === "select";
  current = view; lastSignature = JSON.stringify(view);
  if (!sameSelection) selected = new Set(view.selected);
  el("login").hidden = true; el("setup").hidden = false;
  const step = el("step"); step.replaceChildren();
  const title = el("step-title"), description = el("step-description");
  if (view.phase === "scan" || view.phase === "scanning") {
    title.textContent = "Search from the backend computer";
    description.textContent = "The terminal scans the private network you choose, from the backend computer over its existing network or VPN. GridLens does not change VPN settings or guess a reachable network.";
    step.append(text("p", view.phase === "scanning" ? "Searching for SSH services…" : "In the setup terminal, enter a private IP or network to start the scan.", "pending"));
  } else if (view.phase === "select") {
    title.textContent = "Choose computers once"; description.textContent = "Filter by part of an IP address or name. Your selections remain selected when the filter changes.";
    const label = text("label", "Find a computer", "field"); const input = document.createElement("input"); input.type = "search";
    input.value = filtering; input.placeholder = "Name or partial IP"; label.append(input); step.append(label);
    const count = text("p", "", "count"); count.setAttribute("aria-live", "polite"); step.append(count);
    const list = text("div", "", "results"); step.append(list);
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
    step.append(text("p", "Waiting for terminal sign-in…", "pending"));
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
  if (signingIn || refreshing) return;
  refreshing = true;
  const revision = signInRevision;
  try {
    const status = await api<{ role: string; serverId: string }>("status");
    if (revision !== signInRevision) return;
    connected = true; el("login").hidden = true;
    if (status.role === "operator") {
      const view = await api<SetupView>("setup");
      if (revision !== signInRevision) return;
      render(view); if (!privateNetwork && el("devices").hidden) await devices(); if (el("monitoring").hidden) await monitoring();
    }
    else { el("setup").hidden = true; message("Shared cache connected. Open Fleet to view authorized readings.", "success"); }
  } catch (error) {
    if (revision !== signInRevision) return;
    if (error instanceof RequestError && [401, 403].includes(error.status)) connected = false;
    el("login").hidden = privateNetwork;
    for (const id of ["setup", "devices", "monitoring"]) el(id).hidden = true;
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
