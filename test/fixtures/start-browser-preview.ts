import { emptyStaking } from "./staking.ts";
import { emptyNos } from "./nos.ts";
import { emptySol } from "./sol.ts";
import { emptyQueue } from "./queue.ts";
import { emptyJobs } from "./jobs.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPreviewServer } from "../../scripts/preview-server.ts";
import { SYNTHETIC_HOST_ADDRESSES } from "./host-addresses.ts";

// Only the test harness prepares files. The application always receives an
// already supplied file, independent of the developer's actual host list.
const directory = mkdtempSync(join(tmpdir(), "gridlens-browser-hosts-"));
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
const hostsFile = join(directory, "hosts.json");
writeFileSync(hostsFile, JSON.stringify(SYNTHETIC_HOST_ADDRESSES));
const real200HostsFile = join(directory, "real200.json");
writeFileSync(real200HostsFile, "[]\n");
process.env.GRIDLENS_HOSTS_FILE = hostsFile;

const server = await startPreviewServer({ stakingProvider: emptyStaking, nosProvider: emptyNos, solProvider: emptySol, queueProvider: emptyQueue, jobProvider: emptyJobs,
  onlineProvider: {
    peek: () => ({ addresses: [], error: null, online: { revision: "isolated-empty", checkedAtMs: Date.now(),
      nextRefreshAtMs: Date.now() + 60_000, retained: false, discoveryError: null } }),
    read: async () => ({ addresses: [], error: null, online: { revision: "isolated-empty", checkedAtMs: Date.now(),
      nextRefreshAtMs: Date.now() + 60_000, retained: false, discoveryError: null } }),
  },
  port: 4174, real200HostsFile,
  // Keep the general layout/sample suites offline. Metadata behavior has its
  // own injected fixture server; this harness must never reach Nosana.
  metadataProvider: async addresses => ({ hosts: addresses.map(address => ({
    address, values: null, fetchedAtMs: null, retained: false,
    error: null, marketError: null,
  })) }),
  nodeInfoProvider: async addresses => ({ hosts: addresses.map(address => ({
    address, values: null, fetchedAtMs: null, validUntilMs: null,
    retained: false, error: null,
  })) }),
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
}
