import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FleetContext } from "../src/contracts/fleet.ts";
import type { FleetIntegration } from "../src/server/application.ts";
import { createMemorySnapshotStore, emptyFleetSnapshots } from "../src/server/snapshot-store.ts";
import { createFileSnapshotStore } from "../src/server/file-snapshot-store.ts";
import { createSnapshotSource } from "../src/server/snapshot-source.ts";

// Synthetic public addresses only. This module is excluded from the hosted
// artifact and must never resolve real users or ingest live observations.
const addresses = Array.from({ length: 8 }, (_, index) => "1".repeat(31) + String(index + 2));
const context: FleetContext = { scopeId: "hosting-lab", rosterRevision: "synthetic-v1", addresses };

async function labStoreDirectory(path: string): Promise<string> {
  const directory = resolve(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const marker = join(directory, ".gridlens-hosting-lab");
  try {
    if (await readFile(marker, "utf8") !== "GridLens isolated hosting lab v1\n") throw new Error("Invalid lab directory marker.");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    if ((await readdir(directory)).length) throw new Error("The hosting lab requires an empty directory or an existing marked lab store.");
    await writeFile(marker, "GridLens isolated hosting lab v1\n", { flag: "wx", mode: 0o600 });
  }
  return directory;
}

/** An explicit loopback-only simulation of a platform adapter; no authentication scheme. */
export async function createIntegration(): Promise<FleetIntegration> {
  const ageText = process.env.GRIDLENS_LAB_AGE_SECONDS ?? "0";
  if (!/^\d+$/.test(ageText) || !Number.isSafeInteger(Number(ageText)) || Number(ageText) > 31_536_000) {
    throw new Error("GRIDLENS_LAB_AGE_SECONDS must be between zero and one year.");
  }
  const store = process.env.GRIDLENS_LAB_STORE
    ? await createFileSnapshotStore(await labStoreDirectory(process.env.GRIDLENS_LAB_STORE)) : createMemorySnapshotStore();
  try {
    const stored = await store.read(context);
    if (stored.revision === 0) {
      const at = Date.now() - Number(ageText) * 1000;
      const market = "1".repeat(31) + "A";
      const snapshots = emptyFleetSnapshots(addresses);
      snapshots.metadata = { hosts: addresses.map(address => ({ address, values: {
        status: "PREMIUM", marketAddress: market, marketLabel: "Synthetic hosting lab",
        ram: null, disk: null, cpu: null, cuda: null, nvidia: null, currentNode: null, system: null,
      }, fetchedAtMs: at, retained: false, error: null, marketError: null })) };
      snapshots["node-info"] = { hosts: addresses.map((address, index) => ({ address,
        values: { state: index < 4 ? "RUNNING_JOB" : "QUEUED", dl: null, ul: null, ping: null, networkUnavailableReason: null },
        fetchedAtMs: at, validUntilMs: at + 30_000, retained: false, error: null,
        apiCheck: { status: "online", checkedAtMs: at, lastConfirmed: { status: "online", checkedAtMs: at } },
      })) };
      snapshots.jobs = { hosts: addresses.map((address, index) => ({ address,
        job: index < 4 ? { address: "1".repeat(31) + "BCDE"[index], node: address, state: "RUNNING",
          timeStart: Math.floor(at / 1000) - 120, timeEnd: 0, timeout: 600 } : null,
        checkedAtMs: at, validUntilMs: at + 180_000, failedAtMs: null, retained: false,
        pending: false, retryAtMs: null, error: null,
      })), nextRefreshAtMs: null };
      snapshots.queue = { hosts: addresses.map((address, index) => ({ address, marketAddress: market,
        position: index < 4 ? null : index - 3, total: 4, checkedAtMs: at, validUntilMs: at + 30_000,
        sourceUpdatedAtMs: at - 1_000, retained: false, error: null,
      })), nextRefreshAtMs: null };
      snapshots.sol = { hosts: addresses.map((address, index) => ({ address, lamports: String((index + 1) * 1_000_000),
        provider: "Synthetic hosting lab", endpoint: "https://example.invalid", contextSlot: 100,
        blockTimeMs: at - 1_000, checkedAtMs: at, validUntilMs: at + 60_000,
        retained: false, error: null, retryAtMs: null,
      })), nextRefreshAtMs: null };
      await store.commit(context, snapshots, 0);
    }
    return {
      label: "Isolated hosting simulation — synthetic readings",
      demonstration: true,
      source: createSnapshotSource(store),
      resolveAccess: async request => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "") ? context : null,
      close: () => store.close(),
    };
  } catch (error) { await store.close(); throw error; }
}
