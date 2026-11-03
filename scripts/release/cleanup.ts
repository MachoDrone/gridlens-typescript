import { checked, runCommand } from "./commands.ts";
import type { CommandRunner } from "./commands.ts";
import type { ReleaseContext } from "./engine.ts";

/** Recovery after an interrupted acceptance script. Only identities journaled
 * before dispatch and carrying both exact ownership labels are considered. */
export async function cleanupAcceptanceResources(context: ReleaseContext, runner: CommandRunner = runCommand): Promise<void> {
  const docker = (args: string[]): Promise<string> => checked("docker", args, { timeoutMs: 120_000 }, runner);
  for (const operation of context.journal.mutations.filter(item => item.kind === "isolated-docker-acceptance")) {
    const { instance, kind: acceptance, images } = operation.identity as { instance: string; kind: string; images?: string[] };
    if (!/^fixture-[a-f0-9]{12}$/.test(instance)) throw new Error("Invalid journaled acceptance resource identity.");
    const filters = ["--filter", `label=io.gridlens.instance=${instance}`], prefix = `gridlens-modern-${instance}`;
    for (const kind of ["container", "volume", "network", "image"] as const) {
      let ids = [...new Set((await docker([kind, "ls", kind === "container" ? "-aq" : "-q", ...filters])).split(/\s+/).filter(Boolean))];
      if (kind === "container") {
        const names = new Map<string, string>();
        for (const id of ids) {
          const name = await docker(["container", "inspect", "--format", "{{.Name}}", id]); names.set(id, name);
        }
        const rank = (id: string): number => names.get(id)?.endsWith("-updater-replacement") ? 0 : names.get(id)?.endsWith("-updater") ? 1 : 2;
        ids = ids.sort((a, b) => rank(a) - rank(b));
      }
      for (const id of ids) {
        const [value] = JSON.parse(await docker([kind, "inspect", id])) as { Id: string; Name?: string; Config?: { Labels?: Record<string, string> }; Labels?: Record<string, string>; RepoTags?: string[]; State?: { Running: boolean } }[];
        const labels = kind === "container" || kind === "image" ? value?.Config?.Labels : value?.Labels;
        const product = labels?.["io.gridlens.product"];
        if (product !== "shared-backend" && !(acceptance === "docker-owner-bound" && product === "financial-guardian")
          || labels?.["io.gridlens.instance"] !== instance) throw new Error("Interrupted fixture cleanup refused mismatched ownership.");
        if (kind === "image") {
          if (!value!.RepoTags?.length || value!.RepoTags.some(tag => !new RegExp(`^${prefix}:[1-9][0-9]*$`).test(tag))) throw new Error("Fixture image acquired another tag; cleanup stopped.");
          if ((await docker(["ps", "-aq", "--filter", `ancestor=${value!.Id}`])).trim()) throw new Error("A fixture image is still in use; cleanup stopped.");
          for (const tag of value!.RepoTags) await docker(["image", "rm", tag]);
        } else {
          if (!value?.Name?.replace(/^\//, "").startsWith(prefix + "-")) throw new Error("Interrupted cleanup refused an unrelated resource name.");
          if (kind === "container" && value.State?.Running) await docker(["stop", "--time", value.Name.endsWith("-owner") || product === "financial-guardian" ? "90" : "15", value.Id]);
          await docker([kind, "rm", kind === "container" ? value.Id : value.Name]);
        }
      }
      if ((await docker([kind, "ls", kind === "container" ? "-aq" : "-q", ...filters])).trim()) throw new Error("Interrupted fixture cleanup left owned resources.");
    }
    if (acceptance === "docker-owner-bound") {
      const alias = `nosana/nosana-node:${instance}`;
      const inspected = await runner("docker", ["image", "inspect", alias], { timeoutMs: 30_000 });
      if (inspected.exitCode === 0) {
        const rows = JSON.parse(inspected.stdout) as { Id: string; RepoTags?: string[] }[];
        const image = rows[0];
        if (rows.length !== 1 || !image || !images?.includes(image.Id) || !image.RepoTags?.includes(alias) || image.RepoTags.length < 2)
          throw new Error("Fixture source alias no longer matches its retained candidate image.");
        await docker(["image", "rm", alias]); // Only the generated alias; retain the candidate and every other tag.
      } else if (!/No such (image|object)/i.test(inspected.stderr)) throw new Error("Fixture source alias identity is unavailable; cleanup stopped.");
    }
  }
}
