import { BROWSER_ASSETS } from "../src/server/browser-assets.ts";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostAddressFilePath, loadHostAddressFile, real200HostAddressFilePath } from "./host-address-file.ts";
import { createHostMetadataProvider } from "./host-metadata.ts";
import { createSchedulingEvidence } from "./scheduling-priority.ts";
import type { HostMetadataProvider } from "./host-metadata.ts";
import { createNodeInfoProvider } from "./node-info.ts";
import { createNodeActivityProvider, createReconciledNodeInfoProvider } from "./node-activity.ts";
import type { NodeInfoProvider } from "./node-info.ts";
import { createJobProvider } from "./jobs.ts";
import type { JobProvider } from "./jobs.ts";
import { createMarketQueueProvider, createQueueProvider } from "./market-queue.ts";
import type { QueueProvider } from "./market-queue.ts";

import { createSolProvider } from "./sol.ts";
import type { SolProvider } from "./sol.ts";
import { createNosProvider } from "./nos.ts";
import type { NosProvider } from "./nos.ts";
import { createStakingProvider } from "./staking.ts";
import type { StakingProvider } from "./staking.ts";
import { createSolanaRpc } from "./solana-rpc.ts";
import { createSharedProgressRead, mergeHostUpdates } from "./shared-progress.ts";
import type { HostMetadataSnapshot } from "../src/fleet/host-metadata.ts";
import type { NodeInfoSnapshot } from "../src/fleet/node-info.ts";
import type { JobSnapshot } from "../src/fleet/jobs.ts";
import type { QueueSnapshot } from "../src/fleet/queue.ts";
import type { SolSnapshot } from "../src/fleet/sol.ts";
import { NOS_MINT, NOS_REFRESH_INTERVAL_MS } from "../src/fleet/nos.ts";
import type { NosSnapshot } from "../src/fleet/nos.ts";
import { blankStakingRecord, STAKING_REFRESH_INTERVAL_MS } from "../src/fleet/staking.ts";
import type { StakingSnapshot } from "../src/fleet/staking.ts";
type Snapshot = HostMetadataSnapshot | NodeInfoSnapshot | JobSnapshot | QueueSnapshot | SolSnapshot | NosSnapshot | StakingSnapshot;

const defaultDirectory = fileURLToPath(new URL("../dist/", import.meta.url));
const assets = BROWSER_ASSETS;

export function previewPort(arguments_: readonly string[]): number {
  if (arguments_.length === 0) return 4173;
  const value = arguments_[1];
  if (arguments_.length !== 2 || arguments_[0] !== "--port" || !value || !/^\d+$/.test(value)) {
    throw new Error("Usage: node scripts/preview-server.ts [--port 1-65535]");
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Preview port must be an integer from 1 to 65535.");
  }
  return port;
}

/** Developer-only preview. Port zero is allowed for isolated tests. */
export async function startPreviewServer(
  { directory = defaultDirectory, port = 4173, hostsFile, real200HostsFile, onHostsInputError, metadataProvider, nodeInfoProvider, jobProvider, queueProvider, solProvider, nosProvider, stakingProvider, now = Date.now }: {
    directory?: string;
    port?: number;
    hostsFile?: string;
    real200HostsFile?: string;
    onHostsInputError?: (message: string) => void;
    metadataProvider?: HostMetadataProvider;
    nodeInfoProvider?: NodeInfoProvider;
    jobProvider?: JobProvider;
    queueProvider?: QueueProvider;
    solProvider?: SolProvider;
    nosProvider?: NosProvider;
    stakingProvider?: StakingProvider;
    /** Wire-envelope time only; never renews provider evidence or scheduling. */
    now?: () => number;
  } = {},
): Promise<Server> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Preview port must be an integer from 0 to 65535.");
  }
  const loaded = new Map<string, { body: Buffer; contentType: string }>();
  try {
    for (const [route, [filename, contentType]] of Object.entries(assets)) {
      loaded.set(route, { body: readFileSync(resolve(directory, filename)), contentType });
    }
  } catch (cause) {
    throw new Error("Preview build is missing or unreadable. Run npm run build first.", { cause });
  }
  const suppliedInput = loadHostAddressFile(hostAddressFilePath(hostsFile === undefined ? {} : { hostsFile }));
  if (suppliedInput.error) onHostsInputError?.(suppliedInput.error);
  // A custom primary input is an isolated developer/test configuration. It must
  // not accidentally import a different roster from the developer's home.
  const real200Input = real200HostsFile !== undefined || process.env.GRIDLENS_REAL200_HOSTS_FILE !== undefined ||
    hostsFile === undefined && process.env.GRIDLENS_HOSTS_FILE === undefined ?
    loadHostAddressFile(real200HostAddressFilePath(real200HostsFile === undefined ? {} : { hostsFile: real200HostsFile })) :
    { addresses: [], error: "Real200 Host Address input is not configured. Supply GRIDLENS_REAL200_HOSTS_FILE and restart the preview." };
  const inputs = { supplied: suppliedInput, real200: real200Input };
  let provider = metadataProvider;
  let nodeProvider = nodeInfoProvider;
  let jobsProvider = jobProvider;
  let queuesProvider = queueProvider;
  let balancesProvider = solProvider;
  let tokensProvider = nosProvider;
  let stakesProvider = stakingProvider;
  const scheduling = createSchedulingEvidence();
  // All balance/staking adapters share health, chain checks and request limits.
  // Construction starts no reads; injected test providers never use this engine.
  const rpc = createSolanaRpc();
  // Both direct browser reads and dependency reads count as consumers. Hiding
  // one tab must not abort metadata still required by another route or viewer.
  const sharedMetadata = createSharedProgressRead<string, HostMetadataSnapshot>(mergeHostUpdates);
  const readMetadata: HostMetadataProvider = (addresses, signal, onUpdate) => {
    provider ??= createHostMetadataProvider();
    return sharedMetadata(JSON.stringify(addresses), (workSignal, emit) => provider!(addresses, workSignal, update => {
      scheduling.observeMetadata(update); emit(update);
    }).then(snapshot => { scheduling.observeMetadata(snapshot); return snapshot; }), signal, onUpdate);
  };
  readMetadata.readMetadata = (addresses, signal, onUpdate) => {
    provider ??= createHostMetadataProvider();
    // Compatibility providers have a single stage. Keep their direct and
    // dependent viewers on the exact same shared operation and cancellation.
    if (!provider.readMetadata) return readMetadata(addresses, signal, onUpdate);
    return sharedMetadata(`metrics:${JSON.stringify(addresses)}`, (workSignal, emit) =>
      (provider!.readMetadata ?? provider!)(addresses, workSignal, update => {
        scheduling.observeMetadata(update); emit(update);
      }).then(snapshot => { scheduling.observeMetadata(snapshot); return snapshot; }), signal, onUpdate);
  };
  if (metadataProvider === undefined || metadataProvider.watch !== undefined) {
    readMetadata.watch = (addresses, signal, onUpdate) => {
      provider ??= createHostMetadataProvider();
      return provider.watch!(addresses, signal, update => { scheduling.observeMetadata(update); onUpdate(update); });
    };
  }
  const marketQueueProvider = createMarketQueueProvider({ activityPriority: scheduling.marketPriority });
  const sharedRoutes = createSharedProgressRead<string, Snapshot>(mergeHostUpdates);
  type Read = (addresses: readonly string[], signal: AbortSignal, onUpdate: (update: Snapshot) => void) => Promise<Snapshot>;
  const getNodeProvider = (): NodeInfoProvider => nodeProvider ??= createReconciledNodeInfoProvider({
    nodeInfoProvider: createNodeInfoProvider({ activityPriority: scheduling.activityPriority }), metadataProvider: readMetadata,
    activityProvider: createNodeActivityProvider({ marketQueueProvider, activityPriority: scheduling.marketPriority }),
  });
  const getQueueProvider = (): QueueProvider => queuesProvider ??= createQueueProvider({ metadataProvider: readMetadata, marketQueueProvider });
  const observeState = (update: NodeInfoSnapshot): void => {
    scheduling.observeStates(update);
    jobsProvider ??= createJobProvider({ activityPriority: scheduling.activityPriority });
    jobsProvider.observeStates?.(update);
  };
  const routes: Record<string, {
    read: Read;
    watch?: () => Read | undefined;
    empty?: Snapshot;
    failure: (addresses: readonly string[]) => Snapshot;
  }> = {
    "/preview/metadata.json": {
      read: (addresses, signal, onUpdate) => readMetadata(addresses, signal, onUpdate),
      watch: () => readMetadata.watch
        ? (addresses, signal, onUpdate) => readMetadata.watch!(addresses, signal, onUpdate) : undefined,
      failure: addresses => ({ hosts: addresses.map(address => ({
        address, values: null, fetchedAtMs: null, retained: false,
        error: "The preview could not load Nosana metadata.", marketError: null,
      })) }),
    },
    "/preview/node-info.json": {
      read: async (addresses, signal, onUpdate) => {
        const snapshot = await getNodeProvider()(addresses, signal, update => {
          observeState(update); onUpdate(update);
        });
        signal.throwIfAborted();
        observeState(snapshot);
        return snapshot;
      },
      watch: () => {
        const selected = getNodeProvider();
        return selected.watch ? (addresses, signal, onUpdate) => selected.watch!(addresses, signal, update => {
          observeState(update); onUpdate(update);
        }) : undefined;
      },
      failure: addresses => {
        const checkedAtMs = Date.now();
        return { hosts: addresses.map(address => ({
          address, values: null, fetchedAtMs: null, validUntilMs: null, retained: false,
          error: "The preview could not load Nosana Node Info.",
          apiCheck: { status: "other" as const, checkedAtMs },
        })) };
      },
    },
    "/preview/jobs.json": {
      read: async (addresses, signal, onUpdate) => {
        jobsProvider ??= createJobProvider({ activityPriority: scheduling.activityPriority });
        const snapshot = await jobsProvider(addresses, signal, update => {
          scheduling.observeJobs(update); onUpdate(update);
        });
        signal.throwIfAborted();
        scheduling.observeJobs(snapshot);
        return snapshot;
      },
      failure: addresses => ({ hosts: addresses.map(address => ({
        address, job: null, checkedAtMs: null, validUntilMs: null, failedAtMs: null,
        retained: false, pending: false, retryAtMs: null,
        error: "The preview could not load Nosana job timing.",
      })) }),
    },
    "/preview/queue.json": {
      read: (addresses, signal, onUpdate) => getQueueProvider()(addresses, signal, onUpdate),
      watch: () => {
        const selected = getQueueProvider();
        return selected.watch ? (addresses, signal, onUpdate) => selected.watch!(addresses, signal, onUpdate) : undefined;
      },
      failure: addresses => ({ hosts: addresses.map(address => ({
        address, marketAddress: null, position: null, total: null, checkedAtMs: null,
        validUntilMs: null, sourceUpdatedAtMs: null, retained: false,
        error: "The preview could not load Nosana queue positions.",
      })) }),
    },
    "/preview/sol.json": {
      read: (addresses, signal, onUpdate) => {
        balancesProvider ??= createSolProvider({ rpc });
        return balancesProvider(addresses, signal, onUpdate);
      },
      empty: { hosts: [], nextRefreshAtMs: null },
      failure: addresses => ({ hosts: addresses.map(address => ({
        address, lamports: null, provider: null, endpoint: null, contextSlot: null,
        blockTimeMs: null, checkedAtMs: null, validUntilMs: null, retained: false,
        retryAtMs: Date.now() + 30_000, error: "The preview could not load SOL balances.",
      })), nextRefreshAtMs: Date.now() + 30_000 }),
    },
    "/preview/nos.json": {
      read: (addresses, signal) => {
        tokensProvider ??= createNosProvider({ rpc });
        return tokensProvider(addresses, signal);
      },
      empty: { hosts: [], nextRefreshAtMs: null },
      failure: (addresses): NosSnapshot => {
        const retryAtMs = Date.now() + NOS_REFRESH_INTERVAL_MS;
        return { hosts: addresses.map(address => ({
          address, tokenAccount: null, mint: NOS_MINT, amount: null, decimals: 6,
          accountState: null, provider: null, endpoint: null, contextSlot: null,
          blockTimeMs: null, checkedAtMs: null, validUntilMs: null, retained: false,
          retryAtMs, error: "The preview could not load NOS balances.",
        })), nextRefreshAtMs: retryAtMs };
      },
    },
    "/preview/staking.json": {
      read: (addresses, signal) => {
        stakesProvider ??= createStakingProvider({ rpc, metadataProvider: readMetadata });
        return stakesProvider(addresses, signal);
      },
      empty: { hosts: [], nextRefreshAtMs: null },
      failure: (addresses): StakingSnapshot => {
        const retryAtMs = Date.now() + STAKING_REFRESH_INTERVAL_MS;
        return { hosts: addresses.map(address => {
          const record = blankStakingRecord(address);
          const error = "The preview could not load staking readings.";
          return { ...record, stake: { ...record.stake, retryAtMs, error },
            requirement: { ...record.requirement, retryAtMs, error }, marketError: error };
        }), nextRefreshAtMs: retryAtMs };
      },
    },
  };
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
      response.end("Method not allowed\n");
      return;
    }
    // Match the original path, without decoding or normalizing traversal segments.
    const path = (request.url ?? "").split("?", 1)[0] ?? "";
    if (path === "/preview/connection.json") {
      // Viewer connectivity is independent of roster validity and provider work.
      const body = JSON.stringify({ status: "ok" });
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
      });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }
    const parameters = new URLSearchParams((request.url ?? "").split("?").slice(1).join("?"));
    const scenarios = parameters.getAll("scenario");
    if ((path === "/preview/hosts.json" || Object.hasOwn(routes, path)) &&
      (scenarios.length > 1 || scenarios.length === 1 && !["supplied", "real200"].includes(scenarios[0]!))) {
      const body = JSON.stringify({ addresses: [], hosts: [], error: "Unknown preview scenario. Choose supplied or real200." });
      response.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }
    const scenario = scenarios[0] === "real200" ? "real200" : "supplied";
    const input = inputs[scenario];
    if (path === "/preview/hosts.json") {
      const inputBody = Buffer.from(JSON.stringify({ ...input, ...(!input.error ? { serverTimeMs: now() } : {}) }));
      response.writeHead(input.error ? 503 : 200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": inputBody.byteLength,
      });
      response.end(request.method === "HEAD" ? undefined : inputBody);
      return;
    }
    const route = Object.hasOwn(routes, path) ? routes[path] : undefined;
    if (route) {
      // HEAD, invalid and empty input never dispatch upstream work. Query input
      // cannot add addresses; every provider receives the immutable startup list.
      if (request.method === "HEAD") {
        response.writeHead(input.error ? 503 : 200, { "Content-Type": "application/json; charset=utf-8" });
        response.end();
        return;
      }
      const send = (status: number, snapshot: Snapshot): void => {
        if (response.destroyed || response.writableEnded) return;
        const body = Buffer.from(JSON.stringify({ ...snapshot, serverTimeMs: now() }));
        response.writeHead(status, {
          "Content-Type": "application/json; charset=utf-8", "Content-Length": body.byteLength,
        });
        response.end(body);
      };
      if (input.error || input.addresses.length === 0) {
        send(input.error ? 503 : 200, route.empty ?? { hosts: [] });
        return;
      }
      const consumer = new AbortController();
      const disconnect = (): void => { consumer.abort(); };
      response.once("close", disconnect);
      const progressive = path !== "/preview/nos.json" && path !== "/preview/staking.json" &&
        request.headers.accept?.split(",").some(value => value.trim().split(";", 1)[0] === "application/x-ndjson");
      // Watch consumers remain distinct from finite JSON callers, while the
      // providers underneath share their caches, pending reads and request limits.
      const watch = progressive ? route.watch?.() : undefined;
      const stream = (snapshot: Snapshot, complete: boolean, failed = false): void => {
        if (consumer.signal.aborted || response.destroyed || response.writableEnded) return;
        if (!response.headersSent) {
          response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "X-Accel-Buffering": "no" });
        }
        // Backpressure must not retain unbounded snapshots for a stalled viewer.
        if (response.writableLength > 2 * 1024 * 1024) {
          consumer.abort(); response.destroy(); return;
        }
        response.write(JSON.stringify({ ...snapshot, complete, ...(watch ? { watching: true } : {}), ...(failed ? { failed: true } : {}), serverTimeMs: now() }) + "\n");
        if (complete) response.end();
      };
      void sharedRoutes(`${scenario}:${path}${watch ? ":watch" : ""}`,
        (signal, emit) => (watch ?? route.read)(input.addresses, signal, emit), consumer.signal,
        progressive ? snapshot => stream(snapshot, false) : undefined,
      ).then(
        snapshot => progressive ? stream(snapshot, true) : send(200, snapshot),
        () => {
          if (!consumer.signal.aborted) {
            if (progressive) stream(route.failure(input.addresses), true, true);
            else send(502, route.failure(input.addresses));
          }
        },
      ).finally(() => { response.off("close", disconnect); });
      return;
    }
    const asset = loaded.get(path);
    if (!asset) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(request.method === "HEAD" ? undefined : "Not found\n");
      return;
    }
    response.writeHead(200, {
      "Content-Type": asset.contentType,
      "Content-Length": asset.body.byteLength,
    });
    response.end(request.method === "HEAD" ? undefined : asset.body);
  });
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      accept();
    });
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const port = previewPort(process.argv.slice(2));
    await startPreviewServer({ port, onHostsInputError: (message) => console.error(message) });
    console.log(`Fleet preview: http://127.0.0.1:${port}/ (Ctrl+C to stop)`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
