import { readFileSync } from "node:fs";
import { homedir, hostname, networkInterfaces, userInfo } from "node:os";
import { join } from "node:path";
import { isIP } from "node:net";
import { privateAddress } from "./config.ts";
import { InstallerError } from "./release.ts";
import type { TerminalPrompts } from "./terminal.ts";

export interface TerminalSetupView { revision: number; phase: string; savedHosts?: number; inspectedPcs?: number }
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

/** Browser controls discovery/selection/approval. Only this terminal supplies secrets. */
export async function followBrowserSetup(terminal: TerminalPrompts, control: SetupControl, {
  pause = () => new Promise<void>(resolve => setTimeout(resolve, 2000)), defaultUsername,
}: { pause?: () => Promise<void>; defaultUsername?: string } = {}): Promise<void> {
  const heartbeat = () => control({ operation: "setup-terminal", scopeId: "default" }) as TerminalSetupView;
  let view = heartbeat();
  if (view.phase === "done") { control({ operation: "setup-terminal", scopeId: "default", connected: false }); return; }
  terminal.print("Keep this terminal open. In the browser, choose Search network, select computers and confirm their identities. Computer sign-in will appear here.");
  const timer = setInterval(() => { try { heartbeat(); } catch { /* The next foreground operation reports loss. */ } }, 5000);
  let previous = "";
  try {
    for (;;) {
      view = heartbeat();
      if (view.phase === "done") {
        terminal.print(`Fleet saved: ${view.savedHosts ?? 0} hosts on ${view.inspectedPcs ?? 0} inspected computers. Return to the browser to view the results.`);
        return;
      }
      if (view.phase !== previous) {
        previous = view.phase;
        if (view.phase === "review") terminal.print("Sign-in received. In the browser, choose Inspect + automatic IP or Inspect only. Full rewards/GPU monitoring has its own approval.");
        if (["scan", "select", "identities"].includes(view.phase)) terminal.print("Waiting for your browser setup choices…");
      }
      if (view.phase === "credentials") {
        terminal.print("Sign in to the selected computers. Passwords and key files stay in this terminal.");
        await enterComputerCredentials(terminal, control, view.revision, defaultUsername);
      } else if (view.phase === "inspecting") {
        terminal.print("Inspecting the approved computers. Existing workloads keep running.");
        control({ operation: "setup-inspect", scopeId: "default" });
      } else await pause();
    }
  } finally {
    clearInterval(timer);
    try { control({ operation: "setup-terminal", scopeId: "default", connected: false }); } catch { /* Preserve the original error. */ }
  }
}
