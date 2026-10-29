import { readFileSync } from "node:fs";
import { homedir, hostname, networkInterfaces, userInfo } from "node:os";
import { join } from "node:path";
import { isIP } from "node:net";
import { privateAddress } from "./config.ts";
import { InstallerError } from "./release.ts";
import type { TerminalPrompts } from "./terminal.ts";

export interface TerminalSetupView {
  revision: number; phase: string; savedHosts?: number; inspectedPcs?: number;
  computers?: { id: string; host: string; name: string; fingerprint: string }[];
  selected?: string[]; trusted?: string[]; exclusions?: string[];
  scan?: { range: string; port: number; total: number; completed: number; found: number; status: string };
  network?: { backendName: string; backendAddress: string; suggestedRange?: string };
}
export type SetupControl = (body: Record<string, unknown>) => unknown;

/** Only the chosen address's actual host interface can supply a network hint. */
export function verifiedSetupNetwork(address: string, version: string, interfaces = networkInterfaces(), name = hostname(), at = Date.now()) {
  const entries = Object.entries(interfaces).flatMap(([interfaceName, values]) => (values ?? []).map(value => ({ interfaceName, ...value })));
  const assigned = entries.find(value => value.address === address && !value.internal
    && !/^(?:docker\d*|podman\d*|veth|br-[a-f0-9]{6,}|cni|flannel|virbr|vnet)/i.test(value.interfaceName));
  if (!assigned || !privateAddress(address) || !/^[A-Za-z0-9_.-]{1,128}$/.test(name)
    || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(version)) return undefined;
  let suggestedRange = address;
  if (isIP(address) === 4 && assigned.cidr?.startsWith(address + "/")) {
    const bits = Number(assigned.cidr.split("/")[1]);
    if (Number.isInteger(bits) && bits >= 23 && bits <= 32) {
      const value = address.split(".").reduce((n, part) => n * 256 + Number(part), 0), size = 2 ** (32 - bits);
      const start = Math.floor(value / size) * size;
      suggestedRange = [24, 16, 8, 0].map(shift => (start >>> shift) & 255).join(".") + "/" + bits;
    }
  }
  return { backendName: name, backendAddress: address, suggestedRange, verifiedAtMs: at, releaseTag: `modern-v${version}` };
}

async function yesNo(terminal: TerminalPrompts, prompt: string, defaultYes: boolean): Promise<boolean> {
  for (;;) {
    const answer = (await terminal.ask(prompt)).trim().toLowerCase();
    if (!answer) return defaultYes;
    if (["yes", "y"].includes(answer)) return true;
    if (["no", "n"].includes(answer)) return false;
    terminal.print("Enter yes or no, or press Enter for the shown default.");
  }
}
export async function enterComputerCredentials(terminal: TerminalPrompts, control: SetupControl, revision: number,
  defaultUsername = userInfo().username): Promise<void> {
  const fallback = /^[A-Za-z0-9_.-]{1,64}$/.test(defaultUsername) ? defaultUsername : "";
  let username: string;
  for (;;) {
    username = (await terminal.ask(`Computer username${fallback ? ` [${fallback}]` : ""}: `)).trim() || fallback;
    if (/^[A-Za-z0-9_.-]{1,64}$/.test(username)) break;
    terminal.print("Enter the computer account name.");
  }
  let kind: string;
  for (;;) {
    kind = (await terminal.ask("Sign in with a computer password or SSH key? [password]: ")).trim().toLowerCase() || "password";
    if (["password", "key"].includes(kind)) break;
    terminal.print("Enter password or key, or press Enter for password.");
  }
  const credentials: Record<string, string> = {};
  if (kind === "key") {
    const path = await terminal.ask("SSH private-key file path: ");
    try { credentials.privateKey = readFileSync(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path, "utf8"); }
    catch { throw new InstallerError("That SSH key file could not be read. Rerun setup and choose the correct file."); }
    if (credentials.privateKey.length > 64 * 1024) throw new InstallerError("The SSH key file exceeds the supported size.");
    credentials.passphrase = await terminal.secret("SSH key passphrase (Enter if none): ");
  } else credentials.password = await terminal.secret("Computer password: ");
  if (await yesNo(terminal, "Use sudo for Docker inspection on the selected computers? [no]: ", false))
    credentials.sudoPassword = await terminal.secret("Computer sudo password (Enter only for passwordless sudo): ");
  const remember = await yesNo(terminal, "Remember encrypted credentials for approved monitoring? [yes]: ", true);
  control({ operation: "setup-auth", scopeId: "default", revision, username, ...credentials, remember });
}

export interface TerminalSetupResult { completed: boolean; view: TerminalSetupView }
const quit = (value: string): boolean => /^(?:q|quit)$/i.test(value.trim());

async function chooseComputers(terminal: TerminalPrompts, view: TerminalSetupView): Promise<string[] | undefined> {
  const computers = view.computers ?? [], selected = new Set(view.selected ?? []);
  let filter = "";
  for (;;) {
    const shown = computers.map((computer, index) => ({ computer, number: index + 1 }))
      .filter(({ computer }) => `${computer.host} ${computer.name}`.toLowerCase().includes(filter.toLowerCase()));
    terminal.print(`\n${selected.size} selected · ${shown.length} matching computers`);
    for (const { computer, number } of shown.slice(0, 25))
      terminal.print(`${number}. [${selected.has(computer.id) ? "x" : " "}] ${computer.name === computer.host ? computer.host : `${computer.name} · ${computer.host}`}`);
    if (shown.length > 25) terminal.print("Showing the first 25 matches. Use /name or /IP to narrow the list.");
    const answer = (await terminal.ask(`Computers [${selected.size ? "done" : "all"}] — numbers toggle, /text filters, all, none, done or q: `)).trim();
    if (quit(answer)) return undefined;
    if (answer.startsWith("/")) { filter = answer.slice(1).trim(); continue; }
    if (answer.toLowerCase() === "none") { selected.clear(); continue; }
    if (answer.toLowerCase() === "all" || !answer && !selected.size) {
      for (const { computer } of shown) selected.add(computer.id);
    } else if (answer && answer.toLowerCase() !== "done") {
      const numbers: number[] = []; let valid = true;
      for (const part of answer.split(",")) {
        const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part.trim());
        if (!match) { valid = false; break; }
        const from = Number(match[1]), to = Number(match[2] ?? match[1]);
        if (from < 1 || to < from || to > computers.length) { valid = false; break; }
        for (let number = from; number <= to; number++) numbers.push(number);
      }
      if (!valid || !numbers.length) { terminal.print("Enter listed numbers such as 1,3-5, or press Enter to use the default."); continue; }
      for (const number of new Set(numbers)) { const id = computers[number - 1]!.id; if (selected.has(id)) selected.delete(id); else selected.add(id); }
      continue;
    }
    if (!selected.size) { terminal.print("Choose at least one computer, or type q to stop."); continue; }
    terminal.print(`Selected: ${computers.filter(row => selected.has(row.id)).map(row => row.name).join(", ")}`);
    if (await yesNo(terminal, `Selection complete — use these ${selected.size} computers? [yes]: `, true)) return [...selected];
  }
}

/** All onboarding decisions happen here; the caller prints the dashboard only after completion. */
export async function runTerminalSetup(terminal: TerminalPrompts, control: SetupControl, {
  pause = () => new Promise<void>(resolve => setTimeout(resolve, 1000)), defaultUsername,
}: { pause?: () => Promise<void>; defaultUsername?: string } = {}): Promise<TerminalSetupResult> {
  const read = () => control({ operation: "setup-status", scopeId: "default" }) as TerminalSetupView;
  const heartbeat = () => control({ operation: "setup-terminal", scopeId: "default" });
  const action = (view: TerminalSetupView, name: string, fields: Record<string, unknown> = {}) =>
    control({ operation: "setup-action", scopeId: "default", revision: view.revision, action: name, ...fields }) as TerminalSetupView;
  let view = read(), inspectedHere = false;
  const stopped = (): TerminalSetupResult => { terminal.print("Setup paused. Run the same installer command to continue."); return { completed: false, view }; };
  async function startSearch(): Promise<boolean> {
    terminal.print("\nStep 1 — Find computers. Press Enter to accept the suggested values.");
    if (view.network) terminal.print(`Searching from ${view.network.backendName} (${view.network.backendAddress}).`);
    const suggested = view.scan?.range ?? view.network?.suggestedRange ?? "";
    for (;;) {
      const answer = (await terminal.ask(`Network to search${suggested ? ` [${suggested}]` : ""}: `)).trim();
      if (quit(answer)) return false;
      const range = answer || suggested;
      if (!range) { terminal.print("Enter a private IP or network, for example 192.168.1.0/24."); continue; }
      const portAnswer = (await terminal.ask(`SSH port [${view.scan?.port ?? 22}]: `)).trim();
      if (quit(portAnswer)) return false;
      const port = Number(portAnswer || view.scan?.port || 22);
      if (!Number.isInteger(port) || port < 1 || port > 65535) { terminal.print("Use an SSH port from 1 to 65535."); continue; }
      try { view = action(view, "scan", { range, port }); return true; }
      catch { view = read(); terminal.print("Search could not start. Use a private IP or IPv4 /23–/32 network (up to 512 addresses), and check that another setup is not running."); }
    }
  }
  heartbeat();
  const timer = setInterval(() => { try { heartbeat(); } catch { /* Foreground operations report connection loss. */ } }, 5000);
  terminal.print("GridLens setup — finish these steps here. The dashboard address appears when your fleet is saved.");
  try {
    for (;;) {
      if (view.phase === "done") {
        terminal.print(`\n${view.savedHosts ?? 0} hosts saved · ${view.inspectedPcs ?? 0} computers inspected.`);
        for (const detail of view.exclusions ?? []) terminal.print(`Attention: ${detail}`);
        if (inspectedHere && (view.savedHosts ?? 0) > 0 && !(view.exclusions?.length)) return { completed: true, view };
        const hasHosts = (view.savedHosts ?? 0) > 0;
        const answer = (await terminal.ask(hasHosts && !inspectedHere
          ? "Saved fleet [1]: 1 Finish, 2 Add computers, q Stop: "
          : `Result [1]: 1 ${hasHosts ? "Finish" : "Search again"}, 2 ${hasHosts ? "Try again" : "Stop"}, q Stop: `)).trim() || "1";
        if (quit(answer) || !hasHosts && answer === "2") return stopped();
        if (hasHosts && answer === "1") return { completed: true, view };
        if (answer !== (hasHosts ? "2" : "1")) { terminal.print("Choose 1, 2 or q."); continue; }
        inspectedHere = false; if (!await startSearch()) return stopped();
      } else if (view.phase === "scan" || view.phase === "select" && !view.computers?.length) {
        if (view.scan && ["complete", "failed", "cancelled"].includes(view.scan.status)) {
          terminal.print(view.scan.status === "complete" ? "No computers offering SSH were found." : "Search did not complete.");
          if (!await yesNo(terminal, "Search again? [yes]: ", true)) return stopped();
        }
        if (!await startSearch()) return stopped();
      } else if (view.phase === "scanning") {
        let cancelled = false, lastPercent = -10;
        const cancel = () => { cancelled = true; };
        process.on("SIGINT", cancel);
        terminal.print("Searching… Ctrl+C cancels this search.");
        try {
          while (view.phase === "scanning") {
            if (cancelled) { try { view = action(view, "cancel-scan"); } catch { view = read(); } return stopped(); }
            const scan = view.scan;
            if (scan && Math.floor(100 * scan.completed / Math.max(scan.total, 1)) >= lastPercent + 10) {
              lastPercent = Math.floor(100 * scan.completed / Math.max(scan.total, 1));
              terminal.print(`${scan.completed}/${scan.total} addresses checked · ${scan.found} computers found`);
            }
            await pause(); view = read();
          }
        } finally { process.off("SIGINT", cancel); }
      } else if (view.phase === "select") {
        const selected = await chooseComputers(terminal, view); if (!selected) return stopped();
        view = action(view, "select", { selected });
      } else if (view.phase === "identities") {
        terminal.print("\nStep 2 — Confirm new computer identities. Saved matching identities are already accepted.");
        for (const computer of view.computers ?? []) if (view.selected?.includes(computer.id) && !view.trusted?.includes(computer.id))
          terminal.print(`${computer.name} · ${computer.host}\nSSH fingerprint: ${computer.fingerprint}`);
        if (!await yesNo(terminal, "Trust these new computer identities? [no]: ", false)) return stopped();
        view = action(view, "trust");
      } else if (view.phase === "credentials") {
        terminal.print("\nStep 3 — Sign in to the selected computers.");
        await enterComputerCredentials(terminal, control, view.revision, defaultUsername); view = read();
      } else if (view.phase === "review") {
        terminal.print("\nStep 4 — Choose monitoring.\n1. Inspect + automatic IP (recommended)\n2. Inspect only");
        const choice = (await terminal.ask("Monitoring [1]: ")).trim() || "1";
        if (quit(choice)) return stopped();
        if (!["1", "2"].includes(choice)) { terminal.print("Choose 1 or 2."); continue; }
        terminal.print("Full monitoring also reads node rewards and GPU statistics. It does not claim or transfer funds.");
        const fullMonitoring = await yesNo(terminal, "Enable full rewards and GPU monitoring? [no]: ", false);
        view = action(view, "inspect", { automaticIp: choice === "1", fullMonitoring });
      } else if (view.phase === "inspecting") {
        terminal.print("Inspecting and saving verified hosts…");
        view = control({ operation: "setup-inspect", scopeId: "default" }) as TerminalSetupView; inspectedHere = true;
      } else throw new InstallerError("The saved setup step is unsupported. Saved data was retained.");
    }
  } finally {
    clearInterval(timer);
    try { control({ operation: "setup-terminal", scopeId: "default", connected: false }); } catch { /* Preserve the original error. */ }
  }
}
