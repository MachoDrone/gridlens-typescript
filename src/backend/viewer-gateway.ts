import type { IncomingMessage } from "node:http";
import { startFleetServer } from "../server/application.ts";
import type { FleetIntegration, FleetServerOptions } from "../server/application.ts";
import type { FleetContext, FleetResource, FleetSnapshots } from "../contracts/fleet.ts";
import type { FleetSource } from "../server/snapshot-source.ts";
import { normalizeFleetSnapshot } from "../server/snapshot-store.ts";
import { selectJobHistoryHosts } from "../server/job-history-selection.ts";
import { parseSharedObservations } from "../contracts/shared.ts";
import { parseNodeGpu } from "../fleet/pc-observations.ts";
import { privateAddress } from "../installer/config.ts";
import { readJson, sendJson, SharedHttpError } from "./ipc.ts";
import { createViewerClient, ViewerClientError } from "./viewer-client.ts";
import type { ViewerClient, ViewerClientConfiguration } from "./viewer-client.ts";

/** Same static Fleet UI, bound solely to the owner's narrowly scoped viewer API. */
export function createViewerIntegration(client: ViewerClient): FleetIntegration {
  const makeSource = (request?: IncomingMessage): FleetSource => ({
    async read<K extends FleetResource>(resource: K, context: FleetContext, signal: AbortSignal): Promise<FleetSnapshots[K]> {
      if (resource === "job-history" && request) {
        const query = new URL(request.url ?? "/", "http://viewer.invalid").searchParams;
        const selected = selectJobHistoryHosts(query, context.addresses);
        await client.read({ operation: "history-request", addresses: selected.addresses, rosterRevision: context.rosterRevision, refresh: query.get("refresh") === "1" }, signal);
      }
      const value = await client.read({ operation: "snapshot", resource, scopeId: context.scopeId, rosterRevision: context.rosterRevision }, signal);
      return normalizeFleetSnapshot(resource, value, context.addresses);
    },
  });
  const integration = {
    viewerOnly: true, sharedBackend: true, label: "Owner snapshots · read-only viewer",
    source: makeSource(), sourceForRequest: makeSource,
    async resolveAccess(_request: IncomingMessage, signal?: AbortSignal): Promise<FleetContext | null> {
      try { return await client.resolve(signal); }
      catch (error) { if (error instanceof ViewerClientError && [401, 403, 409].includes(error.status)) return null; throw error; }
    },
    async handleRequest(request: IncomingMessage, response: Parameters<NonNullable<FleetIntegration["handleRequest"]>>[1]): Promise<boolean> {
      const url = new URL(request.url ?? "/", "http://viewer.invalid"), path = url.pathname;
      const denied = path === "/wallet" || path.startsWith("/wallet/") || path.startsWith("/treasury") || path.startsWith("/setup")
        || path.startsWith("/secure-setup") || path.startsWith("/connect") || path.startsWith("/admin")
        || path.startsWith("/api/shared/") && !["/api/shared/status", "/api/shared/observations", "/api/shared/gpu-history"].includes(path);
      if (denied) { sendJson(response, 403, { error: "This installation is a read-only viewer." }); return true; }
      if (!path.startsWith("/api/shared/")) return false;
      const controller = new AbortController(), closed = () => controller.abort(); response.once("close", closed);
      try {
        if (url.search) throw new SharedHttpError(400);
        if (path === "/api/shared/status" && request.method === "GET") sendJson(response, 200, await client.status(controller.signal));
        else if (path === "/api/shared/observations" && request.method === "GET") {
          const context = await client.resolve(controller.signal);
          const value = await client.read({ operation: "observations" }, controller.signal);
          sendJson(response, 200, parseSharedObservations(value, client.serverId, context));
        } else if (path === "/api/shared/gpu-history" && request.method === "POST") {
          if (!request.headers.origin) throw new SharedHttpError(403);
          const body = await readJson(request, 4096), context = await client.resolve(controller.signal);
          if (Object.keys(body).sort().join("|") !== ["address", "fromAtMs", "toAtMs"].sort().join("|") || typeof body.address !== "string" || !context.addresses.includes(body.address)) throw new SharedHttpError(400);
          const result = await client.read<Record<string, unknown>>({ operation: "gpu-history", ...body }, controller.signal);
          if (!result || result.version !== 1 || result.serverId !== client.serverId || result.scopeId !== context.scopeId
            || result.rosterRevision !== context.rosterRevision || result.address !== body.address) throw new ViewerClientError();
          sendJson(response, 200, { version: 1, serverId: client.serverId, scopeId: context.scopeId, rosterRevision: context.rosterRevision,
            address: body.address, gpu: result.gpu === null ? null : parseNodeGpu(result.gpu, body.address) });
        } else throw new SharedHttpError(405);
      } catch (error) { if (!response.destroyed && !response.writableEnded) sendJson(response, error instanceof SharedHttpError || error instanceof ViewerClientError ? error.status : 502, { error: "Owner viewer data is unavailable." }); }
      finally { response.off("close", closed); }
      return true;
    },
    async close() { client.close(); },
  };
  return integration;
}
export async function startViewerGateway(options: { configuration: ViewerClientConfiguration; publicOrigin: string; directory: string; host?: string; port?: number }) {
  const url = new URL(options.publicOrigin), hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || url.origin !== options.publicOrigin || !privateAddress(hostname) || !url.port
    || Number(url.port) < 1024 || Number(url.port) > 65535) throw new Error("Viewer UI requires its assigned private HTTP origin.");
  const client = createViewerClient(options.configuration);
  try {
    await client.status(); // Refuse operator credentials before opening a viewer listener.
    const integration = createViewerIntegration(client);
    const server = await startFleetServer({ integration, directory: options.directory, publicOrigin: options.publicOrigin,
      host: options.host ?? "0.0.0.0", port: options.port ?? 8080, accessCheckIntervalMs: 1000 } satisfies FleetServerOptions);
    return { server, integration };
  } catch (error) { client.close(); throw error; }
}
