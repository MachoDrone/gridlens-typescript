import { networkInterfaces } from "node:os";
import type { NetworkInterfaceInfo } from "node:os";
import { createServer, isIP } from "node:net";
import { InstallerError } from "./release.ts";
import { checked } from "./docker.ts";
import type { DockerRunner } from "./docker.ts";
import { cliSection, cliText } from "./cli-format.ts";

export interface PrivateEndpoint {
  address: string;
  interfaceName: string;
  family: "IPv4" | "IPv6";
  kind: "lan" | "vpn" | "private";
}
export interface PrivateEndpoints {
  choices: PrivateEndpoint[];
  recommendedIndex: number | null;
  exclusions: { interfaceName: string; reason: "container-interface" | "loopback" | "link-local" | "outside-private-range" }[];
}
export interface SelectionPrompts { color?: boolean; ask(prompt: string): Promise<string>; print(text: string): void }
export type PortProbeResult = "available" | "busy" | "unavailable";
export type PortProbe = (address: string, port: number) => Promise<PortProbeResult>;
export interface NetworkExclusions { blockedInterfaces: readonly string[]; blockedAddresses: readonly string[] }
const containerInterface = /^(?:docker\d*|podman\d*|cni(?:-podman)?\d*|veth[\w.-]*|br-[a-f0-9]{6,}|lxcbr\d*|lxdbr\d*|incusbr\d*|virbr\d*|vnet\d*|flannel(?:\.[\w.-]*)?|cali[\w.-]*|kube-ipvs\d*)$/i;
const lanInterface = /^(?:eth\d+|en[\w.-]*|wlan\d+|wl[\w.-]*|em\d+)$/i;
const vpnInterface = /^(?:wg|tun|tap|utun|tailscale|zt|vpn)[\w.-]*$/i;

export function assertLocalDockerForSelection(runner: DockerRunner, environment: NodeJS.ProcessEnv = process.env): void {
  let endpoint: unknown;
  try {
    // Docker's named context takes precedence over DOCKER_HOST. Inspect only its
    // endpoint metadata, never TLS files, SSH keys or the complete configuration.
    endpoint = environment.DOCKER_CONTEXT || !environment.DOCKER_HOST
      ? JSON.parse(checked(runner, ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"] ))
      : environment.DOCKER_HOST;
  } catch { throw new InstallerError("The local Docker endpoint could not be verified. Check the selected Docker context before choosing this PC's address."); }
  if (typeof endpoint !== "string" || !endpoint.startsWith("unix:")) throw new InstallerError("Private-address selection must run on the backend PC with its local Docker daemon. Open a terminal on that PC; this terminal cannot discover a remote Docker host's addresses.");
}

/** Eligible dashboard addresses are actual local RFC1918 IPv4 or IPv6 ULA
 * assignments. Interface presence does not prove remote VPN reachability. */
export function isPrivateDashboardAddress(value: string): boolean {
  if (isIP(value) === 4) {
    const [first, second] = value.split(".").map(Number);
    return first === 10 || first === 172 && second! >= 16 && second! <= 31 || first === 192 && second === 168;
  }
  return isIP(value) === 6 && /^f[cd][a-f0-9]{2}:/i.test(value);
}
/** Read only bridge metadata from the selected local Docker daemon. A bridge
 * called br0 is excluded only when Docker actually identifies it as owned. */
export function dockerNetworkExclusions(runner: DockerRunner): NetworkExclusions {
  const interfaces = new Set<string>(), addresses = new Set<string>();
  try {
    const ids = checked(runner, ["network", "ls", "--filter", "driver=bridge", "--format", "{{.ID}}"])
      .split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    if (ids.length > 4096 || ids.some(id => !/^[a-f0-9]{12,64}$/.test(id)) || new Set(ids).size !== ids.length) throw new Error();
    for (let offset = 0; offset < ids.length; offset += 64) {
      const requested = ids.slice(offset, offset + 64);
      const values: unknown = JSON.parse(checked(runner, ["network", "inspect", ...requested]));
      if (!Array.isArray(values) || values.length !== requested.length || new Set(values.map(value => value?.Id)).size !== values.length) throw new Error();
      for (const value of values) {
        const row = value as { Id?: unknown; Driver?: unknown; Options?: Record<string, unknown> | null; IPAM?: { Config?: { Gateway?: unknown }[] } };
        if (!row || typeof row.Id !== "string" || !/^[a-f0-9]{64}$/.test(row.Id) || !requested.some(id => (row.Id as string).startsWith(id)) || row.Driver !== "bridge") throw new Error();
        const explicit = row.Options?.["com.docker.network.bridge.name"];
        if (explicit !== undefined && (typeof explicit !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(explicit))) throw new Error();
        interfaces.add(typeof explicit === "string" ? explicit : `br-${row.Id.slice(0, 12)}`);
        if (row.IPAM?.Config !== undefined && !Array.isArray(row.IPAM.Config)) throw new Error();
        for (const item of row.IPAM?.Config ?? []) {
          if (item.Gateway !== undefined && item.Gateway !== "" && (typeof item.Gateway !== "string" || isIP(item.Gateway) === 0)) throw new Error();
          if (typeof item.Gateway === "string" && item.Gateway) addresses.add(item.Gateway.toLowerCase());
        }
      }
    }
    return { blockedInterfaces: [...interfaces], blockedAddresses: [...addresses] };
  } catch { throw new InstallerError("Docker bridge addresses could not be verified. Retry setup after checking Docker access; no dashboard address was selected."); }
}
export function discoverPrivateEndpoints(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(), exclusionsByOwner: NetworkExclusions = { blockedInterfaces: [], blockedAddresses: [] }): PrivateEndpoints {
  const choices: PrivateEndpoint[] = [], exclusions: PrivateEndpoints["exclusions"] = [], seen = new Set<string>();
  for (const [name, records] of Object.entries(interfaces).sort(([a], [b]) => a.localeCompare(b))) {
    const interfaceName = name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 64);
    for (const record of records ?? []) {
      let reason: PrivateEndpoints["exclusions"][number]["reason"] | undefined;
      if (containerInterface.test(name) || exclusionsByOwner.blockedInterfaces.includes(name) || exclusionsByOwner.blockedAddresses.includes(record.address.toLowerCase())) reason = "container-interface";
      else if (record.internal || isIP(record.address) === 4 && record.address.startsWith("127.") || record.address === "::1") reason = "loopback";
      else if (/^169\.254\.|^fe[89ab][a-f0-9]:/i.test(record.address)) reason = "link-local";
      else if (!isPrivateDashboardAddress(record.address)) reason = "outside-private-range";
      if (reason) { if (!exclusions.some(row => row.interfaceName === interfaceName && row.reason === reason)) exclusions.push({ interfaceName, reason }); continue; }
      const family = isIP(record.address) === 4 ? "IPv4" : "IPv6";
      const address = record.address.toLowerCase(), key = `${family}:${address}`;
      if (seen.has(key)) continue; seen.add(key);
      choices.push({ address, interfaceName, family, kind: vpnInterface.test(name) ? "vpn" : lanInterface.test(name) ? "lan" : "private" });
    }
  }
  choices.sort((a, b) => (a.kind === "lan" ? 0 : a.kind === "vpn" ? 1 : 2) - (b.kind === "lan" ? 0 : b.kind === "vpn" ? 1 : 2)
    || (a.family === "IPv4" ? 0 : 1) - (b.family === "IPv4" ? 0 : 1) || a.interfaceName.localeCompare(b.interfaceName) || a.address.localeCompare(b.address, undefined, { numeric: true }));
  // Prefer one unambiguous conventional LAN/Wi-Fi IPv4 assignment. A sole ULA
  // LAN assignment can be recommended when no private LAN IPv4 exists. VPN
  // transport addresses remain explicit choices, never automatic fallbacks.
  const lanV4 = choices.flatMap((choice, index) => choice.kind === "lan" && choice.family === "IPv4" ? [index] : []);
  const lanV6 = choices.flatMap((choice, index) => choice.kind === "lan" && choice.family === "IPv6" ? [index] : []);
  const lanInterfaces = new Set(choices.filter(choice => choice.kind === "lan").map(choice => choice.interfaceName));
  const recommendedIndex = lanInterfaces.size !== 1 ? null : lanV4.length === 1 ? lanV4[0]! : lanV4.length === 0 && lanV6.length === 1 ? lanV6[0]! : null;
  return { choices, recommendedIndex, exclusions };
}

export async function choosePrivateEndpoint(terminal: SelectionPrompts, available = discoverPrivateEndpoints()): Promise<PrivateEndpoint> {
  cliSection(terminal, "Dashboard address");
  terminal.print("Choose the address your PC or phone can reach on your existing LAN or VPN.");
  terminal.print("");
  if (!available.choices.length) throw new InstallerError("No eligible private address is assigned on this PC. Connect this PC to your existing private network or VPN, then run setup again. Public-only installation is not supported yet; GridLens will not invent an address or change networking.");
  for (const [index, choice] of available.choices.entries()) {
    terminal.print(cliText(terminal, index === available.recommendedIndex ? "success" : "action",
      `${index + 1}) ${choice.address}${choice.kind === "vpn" ? " · VPN" : ""}${index === available.recommendedIndex ? " — recommended" : ""}`));
    terminal.print("");
  }
  const hint = available.recommendedIndex === null ? "Choose address number: " : `Choose address number [${available.recommendedIndex + 1}, recommended]: `;
  for (;;) {
    const answer = (await terminal.ask(cliText(terminal, "action", hint))).trim();
    const number = answer === "" && available.recommendedIndex !== null ? available.recommendedIndex + 1 : /^\d+$/.test(answer) ? Number(answer) : 0;
    const selected = available.choices[number - 1];
    if (Number.isSafeInteger(number) && selected) return selected;
    terminal.print(cliText(terminal, "pending", `Enter a number from 1 to ${available.choices.length}${available.recommendedIndex === null ? ". No address was selected automatically." : ", or press Enter for the recommended address."}`));
  }
}

/** A temporary exclusive listener checks this exact local address/port. The
 * listener closes before returning and cannot reserve the port until Docker runs. */
export const probeBindPort: PortProbe = (address, port) => new Promise(resolve => {
  if (isIP(address) === 0 || !Number.isInteger(port) || port < 1024 || port > 65535) { resolve("unavailable"); return; }
  const server = createServer(socket => socket.destroy());
  let settled = false;
  const finish = (result: PortProbeResult): void => {
    if (settled) return; settled = true; clearTimeout(timer);
    if (server.listening) server.close(() => resolve(result));
    else { server.close(() => {}); resolve(result); }
  };
  const timer = setTimeout(() => finish("unavailable"), 1500);
  server.once("error", (error: NodeJS.ErrnoException) => finish(error.code === "EADDRINUSE" ? "busy" : "unavailable"));
  server.once("listening", () => { if (settled) server.close(() => {}); else finish("available"); });
  try { server.listen({ host: address, port, exclusive: true, ...(isIP(address) === 6 ? { ipv6Only: true } : {}) }); }
  catch { finish("unavailable"); }
});

export async function recommendPort(address: string, { preferred = 8789, alternatives = 10, probe = probeBindPort }: {
  preferred?: number; alternatives?: number; probe?: PortProbe;
} = {}): Promise<number | null> {
  if (isIP(address) === 0 || !Number.isInteger(preferred) || preferred < 1024 || preferred > 65535
    || !Number.isInteger(alternatives) || alternatives < 0 || alternatives > 32) throw new InstallerError("Invalid local port selection.");
  for (let port = preferred; port <= Math.min(65535, preferred + alternatives); port++) {
    const result = await probe(address, port);
    if (result === "available") return port;
    if (result === "unavailable") throw new InstallerError("The selected address cannot be bound on this PC. Check that it is still assigned to this PC's private network or VPN, then retry setup.");
  }
  return null;
}
export async function chooseDashboardPort(terminal: SelectionPrompts, address: string, { preferred = 8789, probe = probeBindPort, label = "Dashboard HTTPS port" }: {
  preferred?: number; probe?: PortProbe; label?: string;
} = {}): Promise<number> {
  let recommended = await recommendPort(address, { preferred, probe });
  terminal.print("");
  if (recommended === null) terminal.print(cliText(terminal, "pending", `No free port was found from ${preferred} through ${Math.min(65535, preferred + 10)}. Choose another unused port.`));
  for (;;) {
    const answer = (await terminal.ask(cliText(terminal, "action", recommended === null ? `${label}: ` : `${label} [${recommended}, recommended]: `))).trim();
    const port = answer === "" ? recommended : /^\d+$/.test(answer) ? Number(answer) : null;
    if (port === null || !Number.isInteger(port) || port < 1024 || port > 65535) { terminal.print(cliText(terminal, "pending", "Enter a port number from 1024 through 65535.")); continue; }
    const result = await probe(address, port);
    if (result === "available") return port;
    if (result === "unavailable") throw new InstallerError("The selected address cannot be bound on this PC. Check its private network or VPN connection before retrying setup.");
    terminal.print(cliText(terminal, "pending", `Port ${port} is already in use on ${address}. Choose another port; the existing service will be left running.`));
    recommended = await recommendPort(address, { preferred, probe });
  }
}

/** The operator chooses the browser's actual HTTP port. HTTPS gets a separate
 * available companion port without another normal-install question. */
export async function choosePrivateWebPorts(terminal: SelectionPrompts, address: string, {
  requestedWebPort, preferred = 8789, probe = probeBindPort,
}: { requestedWebPort?: number; preferred?: number; probe?: PortProbe } = {}): Promise<{ webPort: number; httpsPort: number }> {
  let webPort: number;
  if (requestedWebPort === undefined) webPort = await chooseDashboardPort(terminal, address, { preferred, probe, label: "Web dashboard port" });
  else {
    if (!Number.isInteger(requestedWebPort) || requestedWebPort < 1024 || requestedWebPort > 65535) throw new InstallerError("Use --web-port with a port from 1024 through 65535.");
    const status = await probe(address, requestedWebPort);
    if (status !== "available") throw new InstallerError(status === "busy" ? "The requested web dashboard port is already in use. Choose another --web-port."
      : "The selected private address cannot be used on this PC. Check its network connection.");
    webPort = requestedWebPort;
  }
  const direction = webPort <= 65524 ? 1 : -1;
  for (let offset = 1; offset <= 11; offset++) {
    const port = webPort + direction * offset;
    if (port < 1024 || port > 65535) continue;
    const status = await probe(address, port);
    if (status === "available") return { webPort, httpsPort: port };
    if (status === "unavailable") throw new InstallerError("The selected private address cannot be used on this PC. Check its network connection.");
  }
  throw new InstallerError("No free companion port is available near the selected web port. Choose another web dashboard port and rerun installation.");
}
