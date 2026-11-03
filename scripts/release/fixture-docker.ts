import { checked, runCommand, shellWords } from "./commands.ts";
import type { CommandRunner } from "./commands.ts";
import type { FixtureProfile } from "./model.ts";

export interface Fixture { instance: string; webPort: number; httpsPort: number }
export interface InspectedContainer {
  Id: string; Name: string; Image: string;
  Config: { Labels: Record<string, string> };
  State: { Running: boolean };
  HostConfig: { ReadonlyRootfs: boolean; NetworkMode: string };
  Mounts: { Type: string; Name?: string; Destination: string; RW: boolean }[];
}
export function validateFixture(fixture: Fixture): void {
  if (!/^fixture-(?:rel-[a-f0-9]{12}-(?:new|up)|[a-f0-9]{12})$/.test(fixture.instance) || fixture.instance.length > 32
    || ![fixture.webPort, fixture.httpsPort].every(port => Number.isInteger(port) && port >= 1024 && port <= 65535) || fixture.httpsPort === fixture.webPort
    || [fixture.webPort, fixture.httpsPort].some(port => port === 8789 || port === 8790)) throw new Error("Invalid isolated release fixture identity.");
}
export function fixturePrefix(fixture: Fixture): string { validateFixture(fixture); return `gridlens-modern-${fixture.instance}-`; }
export function assertOwned(value: unknown, fixture: Fixture, kind: "container" | "volume" | "network"): asserts value is InspectedContainer {
  const item = value as { Config?: { Labels?: Record<string, string> }; Labels?: Record<string, string>; Name?: string };
  const labels = kind === "container" ? item?.Config?.Labels : item?.Labels;
  if (labels?.["io.gridlens.product"] !== "shared-backend" || labels["io.gridlens.instance"] !== fixture.instance
    || typeof item.Name !== "string" || !item.Name.replace(/^\//, "").startsWith(fixturePrefix(fixture))) throw new Error("Refusing to use or remove a resource outside this exact release fixture.");
}
export function fixtureDocker(profile: FixtureProfile, runner: CommandRunner = runCommand) {
  const ssh = async (args: string[], input?: string, timeoutMs = 120_000): Promise<string> => checked("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", profile.sshTarget, shellWords(args)],
    { timeoutMs, ...(input === undefined ? {} : { input }), maximumBytes: 4 * 1024 ** 2 }, runner);
  const docker = (args: string[], input?: string, timeoutMs?: number): Promise<string> => ssh(["docker", ...args], input, timeoutMs);
  async function inspect(fixture: Fixture, role: string): Promise<InspectedContainer> {
    if (!["owner", "gateway", "vpn-web", "updater"].includes(role)) throw new Error("Unknown fixture role.");
    const values: unknown[] = JSON.parse(await docker(["container", "inspect", fixturePrefix(fixture) + role]));
    if (values.length !== 1) throw new Error("Fixture container identity is ambiguous.");
    assertOwned(values[0], fixture, "container");
    return values[0];
  }
  return {
    docker, ssh, inspect,
    async exec(fixture: Fixture, role: string, args: string[], input?: string): Promise<string> {
      const container = await inspect(fixture, role);
      return docker(["exec", ...(input === undefined ? [] : ["-i"]), container.Id, ...args], input);
    },
    async absent(fixture: Fixture): Promise<void> {
      for (const kind of ["container", "volume", "network"]) {
        const values = await docker([kind, "ls", kind === "container" ? "-aq" : "-q", "--filter", `label=io.gridlens.instance=${fixture.instance}`]);
        if (values.trim()) throw new Error("Release fixture identity already has resources; use a fresh fixture generation.");
      }
    },
    async portsAvailable(fixtures: Fixture[], additionalPorts: readonly number[] = []): Promise<void> {
      const listeners = await ssh(["ss", "-H", "-ltn"]), published = await docker(["ps", "--format", "{{.Ports}}"]);
      const ports = [...fixtures.flatMap(fixture => [fixture.webPort, fixture.httpsPort]), ...additionalPorts];
      if (ports.some(port => !Number.isInteger(port) || port < 1024 || port > 65535)) throw new Error("Invalid fixture port preflight.");
      for (const line of listeners.split("\n")) {
        const port = Number(line.trim().split(/\s+/)[3]?.match(/:(\d+)$/)?.[1]);
        if (ports.includes(port)) throw new Error("A release fixture port is already in use.");
      }
      for (const match of published.matchAll(/:(\d+)(?:-(\d+))?->/g)) if (ports.some(port => port >= Number(match[1]) && port <= Number(match[2] ?? match[1]))) throw new Error("Docker already publishes a release fixture port.");
    },
    async imagePresent(ids: string[]): Promise<boolean> {
      for (const image of ids) {
        if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Invalid fixture release image ID.");
        const result = await runner("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", profile.sshTarget, shellWords(["docker", "image", "inspect", "--format", "{{.Id}}", image])], { timeoutMs: 30_000 });
        if (result.exitCode === 0) {
          if (!ids.includes(result.stdout.trim())) throw new Error("Preloaded release image identity differs from its signature.");
          return true;
        }
        if (!/No such (image|object)/i.test(result.stderr)) throw new Error("Cannot establish whether the fixture release image is absent.");
      }
      return false;
    },
    async cleanup(fixtures: Fixture[]): Promise<{ cleanupVerified: true; removed: string[]; releaseImagesRetained: true }> {
      for (const fixture of fixtures) {
        validateFixture(fixture);
        const ids = (await docker(["container", "ls", "-aq", "--filter", `label=io.gridlens.instance=${fixture.instance}`])).split(/\s+/).filter(Boolean);
        const containers: InspectedContainer[] = [];
        for (const id of ids) {
          const [value] = JSON.parse(await docker(["container", "inspect", id])) as unknown[];
          assertOwned(value, fixture, "container"); containers.push(value);
        }
        containers.sort((a, b) => Number(!a.Name.endsWith("-updater")) - Number(!b.Name.endsWith("-updater")));
        for (const value of containers) {
          if (value.State.Running) await docker(["stop", "--time", value.Name.endsWith("-owner") ? "90" : "15", value.Id], undefined, 120_000);
          await docker(["container", "rm", value.Id]);
        }
        for (const kind of ["volume", "network"] as const) {
          const names = (await docker([kind, "ls", "--filter", `label=io.gridlens.instance=${fixture.instance}`, "--format", "{{.Name}}"])).split(/\s+/).filter(Boolean);
          for (const name of names) { const [value] = JSON.parse(await docker([kind, "inspect", name])) as unknown[]; assertOwned(value, fixture, kind); await docker([kind, "rm", name]); }
        }
        for (const kind of ["container", "volume", "network"]) if ((await docker([kind, "ls", kind === "container" ? "-aq" : "-q", "--filter", `label=io.gridlens.instance=${fixture.instance}`])).trim()) throw new Error("Owned fixture resources remain after cleanup.");
      }
      return { cleanupVerified: true, removed: fixtures.map(fixture => fixture.instance), releaseImagesRetained: true };
    }
  };
}
export type FixtureDocker = ReturnType<typeof fixtureDocker>;
