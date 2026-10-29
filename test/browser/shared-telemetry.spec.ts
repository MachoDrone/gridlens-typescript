import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSharedState } from "../../src/backend/sqlite-state.ts";
import { createSharedService } from "../../src/backend/service.ts";
import { readJson, sendJson } from "../../src/backend/ipc.ts";
import { startFleetServer, closeFleetServer } from "../../src/server/application.ts";
import { createSnapshotSource } from "../../src/server/snapshot-source.ts";
import { emptyFleetSnapshots } from "../../src/server/snapshot-store.ts";
import type { FleetIntegration } from "../../src/server/application.ts";

test("installed browser renders verified PC/reward/network cache and requests GPU history only on expansion", async ({ page, context }) => {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-browser-shared-")), state = openSharedState(directory);
  const service = createSharedService(state), address = "1".repeat(31) + "2", job = "1".repeat(31) + "3";
  const fleet = service.access.setFleet("synthetic", [address]), now = Date.now(), checked = now - 90_000;
  const binding = { pcId: "a".repeat(64), runtime: "docker" as const, wrapperId: null, nodeContainerId: "b".repeat(64) };
  const uuid = "GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  service.observations.associate(fleet, [{ address, binding, name: "Synthetic verified PC", sshFingerprint: "SHA256:" + "A".repeat(43), verifiedAtMs: checked,
    privateIp: "192.168.42.99", gpuUuids: [uuid] }]);
  service.observations.ingest(fleet, { address, binding, rewards: { schema: 1, address, observedAtMs: checked, status: "ok", amount: "12.345678" },
    gpu: { schema: 2, address, observedAtMs: checked, status: "ok", gpuUuids: [uuid], intervalSeconds: 15, fromAtMs: checked - 15_000, toAtMs: checked,
      truncated: false, clockTrusted: true, samples: [[checked - 15_000, 0, 15, 1, null, null, null, null]] } });
  service.observations.network(fleet, { pcId: binding.pcId, network: { schema: 1, observedAtMs: checked, status: "ok", source: "pc-egress-ipify",
    publicIp: "8.8.8.8", publicObservedAtMs: checked, privateIp: "192.168.42.42", privateObservedAtMs: checked } });
  const snapshots = emptyFleetSnapshots([address]);
  snapshots["job-history"] = { hosts: [{ address, jobs: [{ address: job, node: address, state: "COMPLETED", timeStart: Math.floor((checked - 30_000) / 1000),
    timeEnd: Math.floor(checked / 1000), timeout: 600, result: "success", checkedAtMs: checked }], totalJobs: 1, checkedAtMs: checked,
    validUntilMs: checked + 300_000, retained: false, pending: false, retryAtMs: null, error: null }], nextRefreshAtMs: null };
  await state.snapshots.commit(fleet, snapshots, 0);
  const token = service.access.pair(service.access.createCode("synthetic", "viewer").code, "Synthetic browser").token;
  let detailRequests = 0;
  const integration: FleetIntegration = { sharedBackend: true, label: "Shared cache · synthetic browser acceptance", source: createSnapshotSource(state.snapshots),
    resolveAccess: async () => fleet, async handleRequest(request, response) {
      const path = request.url?.split("?")[0];
      if (!path?.startsWith("/api/shared/")) return false;
      const operation = path.slice("/api/shared/".length);
      if (operation === "gpu-history") { detailRequests++; sendJson(response, 200, await service.read({ ...await readJson(request), operation, token })); }
      else sendJson(response, 200, await service.read({ operation, token }));
      return true;
    } };
  const server = await startFleetServer({ integration, port: 0 }), port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`, errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  try {
    await page.goto(origin);
    const row = page.locator(`#fleet-rows tr[data-host="${address}"]`);
    await expect(row.locator('[data-col="pc"]')).toHaveText("Synthetic verified PC");
    await expect(row.locator('[data-col="rewards"]')).toHaveText("12");
    await page.getByRole("button", { name: "Toggle IP display", exact: true }).click();
    await expect(row.locator('[data-col="ip"]')).toContainText("192.168.42.42");
    await expect(row.locator('[data-col="ip"]')).not.toContainText("192.168.42.99");
    expect(detailRequests).toBe(0);
    await row.getByRole("button", { name: `Show recent jobs for ${address}` }).click();
    await expect.poll(() => detailRequests).toBe(1);
    const details = page.locator(".job-history-source"); await details.locator("summary").click();
    await expect(details).toContainText("Thermal slowdown"); await expect(details).toContainText("does not establish");
    expect(errors).toEqual([]);
  } finally { await page.close(); await closeFleetServer(server, integration); await state.close(); await rm(directory, { recursive: true }); }
});
