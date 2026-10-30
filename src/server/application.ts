import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSER_ASSETS } from "./browser-assets.ts";
import { FLEET_RESOURCES, isFleetRoster, isFleetSnapshot } from "../contracts/fleet.ts";
import type { FleetContext, FleetResource, FleetSnapshots } from "../contracts/fleet.ts";
import type { FleetSource } from "./snapshot-source.ts";
import { normalizeFleetSnapshot } from "./snapshot-store.ts";
import { selectJobHistoryHosts } from "./job-history-selection.ts";
import type { UpdateBuild } from "../contracts/updates.ts";

/** The platform verifies its own sessions and returns only their authorized roster.
 * GridLens deliberately defines no login, token format, or trusted proxy header. */
export interface FleetIntegration {
  resolveAccess(request: IncomingMessage, signal?: AbortSignal): Promise<FleetContext | null>;
  source: FleetSource;
  /** Trusted production composition may bind the source to this request's verified credential. */
  sourceForRequest?: (request: IncomingMessage) => FleetSource;
  /** Explicit versioned setup/pairing composition, after the common Host/Origin check. */
  handleRequest?: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;
  close?: () => Promise<void>;
  label?: string;
  /** Explicit fixture mode; the reference lab is never packaged as platform auth. */
  demonstration?: boolean;
  /** Only the installed shared owner supplies the optional verified PC telemetry API. */
  sharedBackend?: boolean;
  /** Only a configured installed updater enables the update controls. */
  updates?: { build: UpdateBuild };
}

export interface FleetServerOptions {
  integration: FleetIntegration;
  directory?: string;
  host?: string;
  port?: number;
  publicOrigin?: string;
  /** Mount under an existing Nosana site without changing browser code. */
  basePath?: string;
  /** Also bounds revocation of an already open feed; injected short values aid tests. */
  accessCheckIntervalMs?: number;
  requestTimeoutMs?: number;
  /** Wire-envelope time only; access checks and source observations keep their own clocks. */
  now?: () => number;
  tls?: { cert: Buffer; key: Buffer };
}

export class FleetConfigurationError extends Error {}
const defaultDirectory = fileURLToPath(new URL("../../dist/", import.meta.url));
const apiPrefix = "/api/fleet/";
const watchResources = new Set<FleetResource>(["metadata", "node-info", "queue"]);
const maximumBodyBytes = 16 * 1024 * 1024;
const maximumFrameBytes = 2 * 1024 * 1024;

function isContext(value: unknown): value is FleetContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const context = value as FleetContext;
  return [context.scopeId, context.rosterRevision].every(part => typeof part === "string"
    && part.length > 0 && part.length <= 256 && !/[\u0000-\u001f\u007f]/.test(part))
    && isFleetRoster(context.addresses);
}

function sameContext(left: FleetContext, right: FleetContext): boolean {
  return left.scopeId === right.scopeId && left.rosterRevision === right.rosterRevision
    && left.addresses.length === right.addresses.length && left.addresses.every((address, index) => address === right.addresses[index]);
}

function escapeAttribute(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Shared UI and data contracts, with platform access/source adapters supplied explicitly. */
export async function startFleetServer({ integration, directory = defaultDirectory, host = "127.0.0.1", port = 4173,
  publicOrigin, basePath = "", accessCheckIntervalMs = 30_000, requestTimeoutMs = 120_000, now = Date.now, tls }: FleetServerOptions): Promise<Server> {
  if (!integration || typeof integration.resolveAccess !== "function" || typeof integration.source?.read !== "function") {
    throw new FleetConfigurationError("A trusted access resolver and snapshot source are required.");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !host || /[\s/\\]/.test(host)
    || !Number.isSafeInteger(accessCheckIntervalMs) || accessCheckIntervalMs < 1
    || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new FleetConfigurationError("Invalid Fleet listener or request limits.");
  }
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(host);
  if (basePath !== "" && !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(basePath)) {
    throw new FleetConfigurationError("The mount path must be empty or a root-relative path without a trailing slash.");
  }
  if (!loopback && !publicOrigin) throw new FleetConfigurationError("A public origin is required for a non-loopback listener.");
  let expectedOrigin: string | undefined;
  if (publicOrigin) {
    let origin: URL;
    try { origin = new URL(publicOrigin); }
    catch { throw new FleetConfigurationError("The public origin must be an HTTP(S) origin."); }
    if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password
      || origin.pathname !== "/" || origin.search || origin.hash) {
      throw new FleetConfigurationError("The public origin must not include credentials, paths, queries or fragments.");
    }
    expectedOrigin = origin.origin;
  }
  const label = integration.label ?? "Shared backend snapshots";
  if (tls && !expectedOrigin?.startsWith("https://")) throw new FleetConfigurationError("TLS requires the canonical HTTPS origin.");
  if (!label.trim() || label.length > 160 || /[\u0000-\u001f\u007f]/.test(label)) throw new FleetConfigurationError("Invalid source label.");
  const loaded = new Map<string, { body: Buffer; contentType: string }>();
  try {
    for (const [route, [filename, contentType]] of Object.entries(BROWSER_ASSETS)) {
      let body = readFileSync(resolve(directory, filename));
      if (filename === "index.html") {
        const html = body.toString("utf8");
        if (!html.includes("</head>")) throw new Error("Missing document head");
        const configured = html.replace("<title>GridLens Fleet · Local preview</title>", "<title>GridLens Fleet</title>")
          .replace('href="/styles.css"', `href="${basePath}/styles.css"`)
          .replace('src="/preview/main.js"', `src="${basePath}/preview/main.js"`)
          .replace('src="/preview/updates.js"', `src="${basePath}/preview/updates.js"`).replace("</head>", [
          `<meta name="gridlens-api-base" content="${basePath}/api/fleet">`,
          '<meta name="gridlens-source-mode" content="snapshot">',
          ...(integration.sharedBackend ? ['<meta name="gridlens-shared-backend" content="1">'] : []),
          ...(integration.updates ? ['<meta name="gridlens-updates" content="1">',
            `<meta name="gridlens-build-id" content="${escapeAttribute(integration.updates.build.buildId)}">`] : []),
          `<meta name="gridlens-source-label" content="${escapeAttribute(label)}">`, "</head>",
        ].join("\n"));
        body = Buffer.from(integration.demonstration
          ? configured.replace("<main>", '<main><p id="hosting-lab-notice" class="sample-notice" role="note">Isolated hosting simulation — synthetic readings</p>')
          : configured);
      }
      loaded.set(route, { body, contentType });
    }
  } catch { throw new FleetConfigurationError("The Fleet browser build is missing or invalid. Build the application first."); }

  let draining = false;
  const controllers = new Set<AbortController>();
  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader("X-GridLens-Contract", "1");
    const send = (status: number, value: unknown): void => {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) { response.destroy(); return; }
      const body = Buffer.from(JSON.stringify(value));
      if (body.length > maximumBodyBytes) { send(502, { error: "Fleet response exceeded its size limit." }); return; }
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
      response.end(request.method === "HEAD" ? undefined : body);
    };
    const expected = new URL(expectedOrigin!);
    // Proxy headers are deliberately ignored. The ingress must preserve the
    // configured Host, and the supplied platform adapter authenticates access.
    if (request.headers.host?.toLowerCase() !== expected.host.toLowerCase()
      || request.headers.origin !== undefined && request.headers.origin !== expected.origin) {
      send(403, { error: "Unrecognized Fleet origin." }); return;
    }
    if (integration.handleRequest) {
      try { if (await integration.handleRequest(request, response)) return; }
      catch { send(502, { error: "Shared backend is unavailable." }); return; }
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD"); send(405, { error: "Method not allowed." }); return;
    }
    const originalPath = (request.url ?? "").split("?", 1)[0]!;
    if (basePath && originalPath === basePath) {
      response.writeHead(308, { Location: `${basePath}/`, "Content-Length": 0 }); response.end(); return;
    }
    if (basePath && !originalPath.startsWith(`${basePath}/`)) { send(404, { error: "Not found." }); return; }
    const path = originalPath.slice(basePath.length);
    if (path === "/health/live" || path === "/health/ready") {
      send(draining ? 503 : 200, { status: draining ? "draining" : "ready" }); return;
    }
    if (draining) { send(503, { error: "Fleet is shutting down." }); return; }
    if (path === `${apiPrefix}connection.json`) { send(200, { status: "ok" }); return; }
    if (!path.startsWith(apiPrefix)) {
      const asset = loaded.get(path);
      if (!asset) { send(404, { error: "Not found." }); return; }
      response.writeHead(200, { "Content-Type": asset.contentType, "Content-Length": asset.body.length });
      response.end(request.method === "HEAD" ? undefined : asset.body);
      return;
    }
    const resource = path.slice(apiPrefix.length).replace(/\.json$/, "") as FleetResource;
    const rosterRead = path === `${apiPrefix}hosts.json`;
    if (!rosterRead && (!FLEET_RESOURCES.includes(resource) || path !== `${apiPrefix}${resource}.json`)) {
      send(404, { error: "Not found." }); return;
    }
    if (resource !== "job-history" && (request.url ?? "").includes("?")) {
      send(400, { error: "Fleet scope comes from the verified session." }); return;
    }
    const controller = new AbortController();
    controllers.add(controller);
    const disconnected = (): void => { controller.abort(); };
    response.once("close", disconnected);
    let recheck: ReturnType<typeof setInterval> | undefined;
    const timeout = setTimeout(() => { send(504, { error: "Fleet request timed out." }); controller.abort(); }, requestTimeoutMs);
    const cleanup = (): void => {
      clearTimeout(timeout);
      if (recheck) clearInterval(recheck);
      response.off("close", disconnected);
      controllers.delete(controller);
    };
    // Ignore late resolution by an adapter that did not honor cancellation.
    const canceled = new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => {
      if (!response.writableEnded && !response.destroyed) response.destroy();
      reject(controller.signal.reason);
    }, { once: true }));
    void canceled.catch(() => {});
    const work = async (): Promise<void> => {
      const source = integration.sourceForRequest?.(request) ?? integration.source;
      const context = await integration.resolveAccess(request, controller.signal);
      controller.signal.throwIfAborted();
      if (context === null) { send(401, { error: "An authorized Fleet session is required." }); return; }
      if (!isContext(context)) throw new Error("Invalid authorized roster");
      const owned: FleetContext = { scopeId: context.scopeId, rosterRevision: context.rosterRevision,
        addresses: [...context.addresses] };
      if (rosterRead) { send(200, { addresses: owned.addresses, error: null, rosterRevision: owned.rosterRevision, serverTimeMs: now() }); return; }
      let selectedAddresses = owned.addresses;
      if (resource === "job-history") {
        try {
          const parameters = new URLSearchParams((request.url ?? "").split("?").slice(1).join("?"));
          selectedAddresses = selectJobHistoryHosts(parameters, owned.addresses).addresses;
        } catch {
          send(400, { error: "Choose between one and 100 distinct hosts from the current Fleet roster." }); return;
        }
      }
      const selected = new Set(selectedAddresses);
      const selectSnapshot = (snapshot: FleetSnapshots[FleetResource]): FleetSnapshots[FleetResource] =>
        resource === "job-history"
          ? { ...snapshot, hosts: snapshot.hosts.filter(row => selected.has(row.address)) } as FleetSnapshots[FleetResource]
          : snapshot;
      if (request.method === "HEAD") { send(200, {}); return; }
      const stream = request.headers.accept?.split(",").some(value => value.trim().split(";", 1)[0] === "application/x-ndjson") ?? false;
      const watching = stream && watchResources.has(resource) && source.watch !== undefined;
      let authorizedAt = Date.now();
      let checking: Promise<boolean> | undefined;
      const stillAuthorized = (): Promise<boolean> => checking ??= Promise.resolve().then(async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const next = await Promise.race([
          integration.resolveAccess(request, controller.signal),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Access validation timed out")), Math.min(requestTimeoutMs, accessCheckIntervalMs));
          }),
        ]).finally(() => { if (timer) clearTimeout(timer); });
        controller.signal.throwIfAborted();
        const authorized = isContext(next) && sameContext(owned, next);
        if (!authorized) {
          send(401, { error: "Fleet access or roster changed. Reload to revalidate access." });
          controller.abort();
        } else authorizedAt = Date.now();
        return authorized;
      }).finally(() => { checking = undefined; });
      let frames = 0;
      let bytes = 0;
      let accountingAt = Date.now();
      let withheld = false;
      const emit = (snapshot: FleetSnapshots[FleetResource], complete: boolean): void => {
        if (controller.signal.aborted || response.destroyed || response.writableEnded) return;
        if (!isFleetSnapshot(resource, snapshot, selectedAddresses, complete)) throw new Error("Invalid Fleet snapshot");
        // Do not send data while an access recheck is overdue. A valid watch
        // replays its latest snapshot after the recheck below.
        if (Date.now() - authorizedAt >= accessCheckIntervalMs) { withheld = true; return; }
        if (!stream) return;
        withheld = false;
        if (watching && Date.now() - accountingAt >= 60_000) { frames = 0; bytes = 0; accountingAt = Date.now(); }
        const body = JSON.stringify({ ...snapshot, complete, ...(watching ? { watching: true } : {}), serverTimeMs: now() }) + "\n";
        bytes += Buffer.byteLength(body);
        if (++frames > owned.addresses.length * 20 + 20 || Buffer.byteLength(body) > maximumFrameBytes
          || bytes > maximumBodyBytes || response.writableLength > maximumFrameBytes) throw new Error("Fleet stream size limit");
        if (!response.headersSent) response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "X-Accel-Buffering": "no" });
        response.write(body);
        if (complete) response.end();
      };
      let latest: FleetSnapshots[FleetResource] | undefined;
      const historyProgress = new Map<string, string>();
      const progress = (snapshot: FleetSnapshots[FleetResource]): void => {
        if (controller.signal.aborted) return;
        try {
          let update = selectSnapshot(normalizeFleetSnapshot(resource, snapshot, owned.addresses, false));
          if (resource === "job-history") {
            // Unrelated bulk ingestion must not spend a small selection's
            // browser frame allowance or repeatedly replay unchanged records.
            const hosts = update.hosts.filter(row => {
              const signature = JSON.stringify(row);
              if (historyProgress.get(row.address) === signature) return false;
              historyProgress.set(row.address, signature);
              return true;
            });
            if (hosts.length === 0) return;
            update = { ...update, hosts } as FleetSnapshots[FleetResource];
          }
          latest = withheld && latest ? { ...latest, ...update, hosts: [...new Map([...latest.hosts, ...update.hosts]
            .map(record => [record.address, record])).values()] } as FleetSnapshots[FleetResource] : update;
          emit(latest, false);
        }
        catch { controller.abort(); }
      };
      if (watching) {
        clearTimeout(timeout);
        recheck = setInterval(() => {
          void stillAuthorized().then(authorized => { if (authorized && latest) emit(withheld ? latest : { ...latest, hosts: [] }, false); })
            .catch(() => { controller.abort(); });
        }, accessCheckIntervalMs);
        await source.watch!(resource, owned, controller.signal, progress);
        throw new Error("Unexpected end of Fleet watch");
      } else {
        const raw = await source.read(resource, owned, controller.signal, progress);
        controller.signal.throwIfAborted();
        const result = selectSnapshot(normalizeFleetSnapshot(resource, raw, owned.addresses));
        if (!await stillAuthorized()) return;
        if (stream) emit(result, true);
        else send(200, { ...result, serverTimeMs: now() });
      }
    };
    void Promise.race([work(), canceled]).catch(() => {
      if (!controller.signal.aborted) send(502, { error: "Fleet data is unavailable." });
    }).finally(cleanup);
  };
  const onRequest = (request: IncomingMessage, response: ServerResponse): void => {
    void handler(request, response).catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  };
  const server = tls ? createSecureServer({ ...tls, minVersion: "TLSv1.2" }, onRequest) : createServer(onRequest);
  const close = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void): Server => {
    draining = true;
    for (const controller of controllers) controller.abort();
    return close(callback);
  }) as typeof server.close;
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      if (!expectedOrigin && address && typeof address !== "string") {
        expectedOrigin = `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`;
      }
      accept();
    });
  });
  return server;
}

/** Graceful shutdown cancels feeds before waiting for HTTP connections. */
export async function closeFleetServer(server: Server, integration: FleetIntegration): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    const force = setTimeout(() => server.closeAllConnections(), 5_000);
    force.unref();
    server.close(error => { clearTimeout(force); if (error) reject(error); else resolveClose(); });
  });
  await integration.close?.();
}
