import { BROWSER_ASSETS } from "../src/server/browser-assets.ts";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostAddressFilePath, loadHostAddressFile, real200HostAddressFilePath } from "./host-address-file.ts";
import type { HostAddressInput } from "./host-address-file.ts";
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
import { JOB_REFRESH_INTERVAL_MS } from "../src/fleet/jobs.ts";
import type { QueueSnapshot } from "../src/fleet/queue.ts";
import type { SolSnapshot } from "../src/fleet/sol.ts";
import { NOS_MINT, NOS_REFRESH_INTERVAL_MS } from "../src/fleet/nos.ts";
import type { NosSnapshot } from "../src/fleet/nos.ts";
import { blankStakingRecord, STAKING_REFRESH_INTERVAL_MS } from "../src/fleet/staking.ts";
import type { StakingSnapshot } from "../src/fleet/staking.ts";
import { createOnlineHostsProvider } from "./online-hosts.ts";
import type { OnlineHostsProvider } from "./online-hosts.ts";
import type { OnlineHostsSnapshot } from "../src/contracts/online-hosts.ts";
import { createOnlineRetention } from "./online-retention.ts";
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
  { directory = defaultDirectory, port = 4173, hostsFile, real200HostsFile, onHostsInputError, metadataProvider, nodeInfoProvider, jobProvider, queueProvider, solProvider, nosProvider, stakingProvider, onlineProvider, now = Date.now }: {
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
    onlineProvider?: OnlineHostsProvider;
    /** Wire-envelope/cache-read time only; never renews evidence or active provider scheduling. */
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
  let onlineHosts = onlineProvider;
  let onlineInput: OnlineHostsSnapshot | undefined;
  const onlineConsumers = new Map<AbortController, { revision: string; close: () => void }>();
  const pendingOnlineInput = (): OnlineHostsSnapshot => ({
    addresses: [], error: "Online GPU Hosts have not been loaded. Refresh the host list to start discovery.",
    online: { revision: null, checkedAtMs: null, nextRefreshAtMs: now(), retained: false, discoveryError: null },
  });
  const peekOnline = (): OnlineHostsSnapshot => onlineInput ?? pendingOnlineInput();
  function retireOnlineReads(revision: string | null): void {
    for (const [controller, consumer] of onlineConsumers) {
      if (consumer.revision === revision) continue;
      onlineConsumers.delete(controller);
      controller.abort();
      consumer.close();
    }
  }
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
  const onlineRetention = createOnlineRetention({
    pinned: [...suppliedInput.addresses, ...real200Input.addresses], now,
    caches: () => [provider?.retention, nodeProvider?.retention, jobsProvider?.retention, queuesProvider?.retention,
      balancesProvider?.retention, tokensProvider?.retention, stakesProvider?.retention,
      marketQueueProvider.retention, scheduling.retention],
  });
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
      (scenarios.length > 1 || scenarios.length === 1 && !["supplied", "real200", "online-gpu-hosts"].includes(scenarios[0]!))) {
      const body = JSON.stringify({ addresses: [], hosts: [], error: "Unknown preview scenario. Choose supplied, real200 or online-gpu-hosts." });
      response.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }
    const scenario = scenarios[0] === "online-gpu-hosts" ? "online-gpu-hosts" : scenarios[0] === "real200" ? "real200" : "supplied";
    const online = scenario === "online-gpu-hosts";
    const revisions = parameters.getAll("revision");
    if (online && (path === "/preview/hosts.json" || Object.hasOwn(routes, path)) &&
        (revisions.length > 1 || revisions.length === 1 &&
          (path === "/preview/hosts.json" || !/^[A-Za-z0-9_-]{1,128}$/.test(revisions[0]!)))) {
      const body = JSON.stringify({ addresses: [], hosts: [], error: "Invalid Online GPU Hosts revision selection." });
      response.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }
    const input = online ? peekOnline() : inputs[scenario];
    if (path === "/preview/hosts.json") {
      const sendInput = (value: HostAddressInput | OnlineHostsSnapshot): void => {
        if (response.destroyed || response.writableEnded) return;
        const inputBody = Buffer.from(JSON.stringify({ ...value, ...(!value.error ? { serverTimeMs: now() } : {}) }));
        response.writeHead(value.error ? 503 : 200, {
          "Content-Type": "application/json; charset=utf-8", "Content-Length": inputBody.byteLength,
        });
        response.end(request.method === "HEAD" ? undefined : inputBody);
      };
      if (!online || request.method === "HEAD") { sendInput(input); return; }
      const consumer = new AbortController();
      const disconnect = (): void => { consumer.abort(); };
      response.once("close", disconnect);
      onlineHosts ??= createOnlineHostsProvider({ admit: addresses => onlineRetention.accept(addresses) });
      void Promise.resolve().then(() => onlineHosts!.read(consumer.signal)).then(snapshot => {
        if (consumer.signal.aborted) return;
        // Injected providers use the same bounded admission as the real source.
        if (snapshot.online.revision !== null && !onlineRetention.accept(snapshot.addresses)) {
          const previous = peekOnline();
          const message = "Online GPU Hosts discovery reached the retained-host capacity. Previously discovered hosts are retained.";
          onlineInput = { ...previous, error: previous.online.revision === null ? message : null,
            online: { ...previous.online, retained: previous.online.revision !== null, discoveryError: message,
              nextRefreshAtMs: Math.max(now() + 60_000, snapshot.online.nextRefreshAtMs) } };
          sendInput(onlineInput);
          return;
        }
        onlineInput = { ...snapshot, addresses: [...snapshot.addresses], online: { ...snapshot.online } };
        retireOnlineReads(snapshot.online.revision);
        sendInput(snapshot);
      }, () => {
        if (consumer.signal.aborted) return;
        const snapshot = peekOnline();
        const message = "Online GPU Hosts discovery could not be completed. Previously discovered hosts are retained.";
        onlineInput = { ...snapshot, error: snapshot.online.revision === null ? message : null,
          online: { ...snapshot.online, retained: snapshot.online.revision !== null, discoveryError: message,
            nextRefreshAtMs: Math.max(now() + 60_000, snapshot.online.nextRefreshAtMs) } };
        sendInput(onlineInput);
      }).finally(() => response.off("close", disconnect));
      return;
    }
    const route = Object.hasOwn(routes, path) ? routes[path] : undefined;
    if (route) {
      const onlineRevision = online ? (input as OnlineHostsSnapshot).online.revision : null;
      const revisionConflict = (): void => {
        if (response.destroyed || response.writableEnded) return;
        if (response.headersSent) { response.end(); return; }
        const body = JSON.stringify({ hosts: [], error: "Online GPU Hosts changed. Refresh the host list before reading values." });
        response.writeHead(409, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
        response.end(request.method === "HEAD" ? undefined : body);
      };
      if (online && (onlineRevision === null || revisions.length !== 1 || revisions[0] !== onlineRevision)) {
        revisionConflict(); return;
      }
      // HEAD, invalid and empty input never dispatch upstream work. Query input
      // cannot add addresses; every read captures one server-owned roster revision.
      if (request.method === "HEAD") {
        response.writeHead(input.error ? 503 : 200, { "Content-Type": "application/json; charset=utf-8" });
        response.end();
        return;
      }
      const send = (status: number, snapshot: Snapshot): void => {
        if (response.destroyed || response.writableEnded) return;
        const body = Buffer.from(JSON.stringify({ ...snapshot, ...(online ? { onlineRevision } : {}), serverTimeMs: now() }));
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
      if (onlineRevision !== null) onlineConsumers.set(consumer, { revision: onlineRevision, close: revisionConflict });
      const addresses = [...input.addresses];
      const releaseRetention = online ? onlineRetention.hold(addresses) : () => {};
      const progressive = path !== "/preview/nos.json" && path !== "/preview/staking.json" &&
        request.headers.accept?.split(",").some(value => value.trim().split(";", 1)[0] === "application/x-ndjson");
      // Watch consumers remain distinct from finite JSON callers, while the
      // providers underneath share their caches, pending reads and request limits.
      const watch = progressive ? route.watch?.() : undefined;
      const read: Read = online && path === "/preview/jobs.json" ? async addresses => ({
        // Network-wide job enrichment cannot spend the fixed fleets' shared
        // assignment/maintenance allowance. Reuse observations without joining
        // pending work or constructing an otherwise unused job provider.
        ...(jobsProvider?.peek?.(addresses) ?? { hosts: addresses.map(address => ({
          address, job: null, checkedAtMs: null, validUntilMs: null, failedAtMs: null,
          retained: false, pending: false, retryAtMs: null, error: null,
        })), waitReason: null, waitUntilMs: null }),
        nextRefreshAtMs: now() + JOB_REFRESH_INTERVAL_MS,
      }) : watch ?? route.read;
      const stream = (snapshot: Snapshot, complete: boolean, failed = false): void => {
        if (consumer.signal.aborted || response.destroyed || response.writableEnded) return;
        if (!response.headersSent) {
          response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "X-Accel-Buffering": "no" });
        }
        // Backpressure must not retain unbounded snapshots for a stalled viewer.
        if (response.writableLength > (online ? 8 : 2) * 1024 * 1024) {
          consumer.abort(); response.destroy(); return;
        }
        response.write(JSON.stringify({ ...snapshot, complete, ...(watch ? { watching: true } : {}), ...(failed ? { failed: true } : {}),
          ...(online ? { onlineRevision } : {}), serverTimeMs: now() }) + "\n");
        if (complete) response.end();
      };
      void sharedRoutes(`${scenario}:${onlineRevision ?? ""}:${path}${watch ? ":watch" : ""}`,
        (signal, emit) => read(addresses, signal, emit), consumer.signal,
        progressive ? snapshot => stream(snapshot, false) : undefined,
      ).then(
        snapshot => { if (!consumer.signal.aborted) { if (progressive) stream(snapshot, true); else send(200, snapshot); } },
        () => {
          if (!consumer.signal.aborted) {
            if (progressive) stream(route.failure(addresses), true, true);
            else send(502, route.failure(addresses));
          }
        },
      ).finally(() => { response.off("close", disconnect); onlineConsumers.delete(consumer); releaseRetention(); });
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
