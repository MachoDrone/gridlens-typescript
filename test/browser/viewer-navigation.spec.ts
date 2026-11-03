import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { emptyFleetSnapshots } from "../../src/server/snapshot-store.ts";
import type { FleetResource } from "../../src/contracts/fleet.ts";

async function fixture(page: Page) {
  const address = "1".repeat(31) + "2", context = { scopeId: "generated-viewer", rosterRevision: "one", addresses: [address] };
  const snapshots = emptyFleetSnapshots(context.addresses), requests: string[] = [];
  const observation = { version: 1, serverId: "generated-owner", scopeId: context.scopeId, rosterRevision: context.rosterRevision,
    associations: [{ address, binding: { pcId: "a".repeat(64), runtime: "docker", wrapperId: null, nodeContainerId: "b".repeat(64) },
      name: "Generated shared PC", sshFingerprint: "SHA256:" + "A".repeat(43), verifiedAtMs: Date.now(), privateIp: null, gpuUuids: [] }], observations: [], networks: [] };
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== "http://127.0.0.1:4174") throw Error("External request in isolated viewer test");
    if (request.resourceType() === "document") {
      const response = await route.fetch(); const body = (await response.text()).replace("</head>", '<meta name="gridlens-shared-backend" content="1"><meta name="gridlens-viewer-only" content="1"><meta name="gridlens-api-base" content="/api/fleet"><meta name="gridlens-source-mode" content="snapshot"><meta name="gridlens-source-label" content="Owner snapshots · read-only viewer"></head>');
      await route.fulfill({ response, body }); return;
    }
    if (url.pathname === "/api/shared/status") { await route.fulfill({ json: { version: 1, serverId: "generated-owner", role: "viewer", context, viewerOnly: true } }); return; }
    if (url.pathname === "/api/shared/observations") { await route.fulfill({ json: observation }); return; }
    if (url.pathname.startsWith("/api/shared/")) { requests.push(url.pathname); await route.fulfill({ status: 403, json: {} }); return; }
    if (url.pathname.startsWith("/api/fleet/")) {
      if (url.pathname.endsWith("/hosts.json")) { await route.fulfill({ json: { addresses: context.addresses, rosterRevision: "one", error: null } }); return; }
      if (url.pathname.endsWith("/connection.json")) { await route.fulfill({ json: { status: "ok" } }); return; }
      const resource = url.pathname.slice("/api/fleet/".length).replace(/\.json$/, "") as FleetResource;
      await route.fulfill({ json: snapshots[resource] ?? { hosts: [] } }); return;
    }
    await route.continue();
  });
  return { address, requests };
}
for (const width of [1440, 390]) test(`viewer Fleet keeps owner navigation hidden after successful telemetry at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 }); await page.addInitScript(() => localStorage.setItem("gridlens.preview.sidebar.v1", "expanded"));
  const mode = await fixture(page); await page.goto("/");
  await expect(page.locator(`#fleet-rows tr[data-host="${mode.address}"] td[data-col="pc"]`)).toHaveText("Generated shared PC");
  for (const id of ["sidebar-hosts", "sidebar-secure", "sidebar-wallet", "sidebar-update"]) await expect(page.locator(`#${id}`)).toBeHidden();
  await page.getByRole("button", { name: "Collapse menu", exact: true }).click();
  for (const id of ["sidebar-hosts", "sidebar-secure", "sidebar-wallet"]) await expect(page.locator(`#${id}`)).toBeHidden();
  await expect.poll(async () => (await page.locator("#sidebar").boundingBox())!.width).toBeLessThanOrEqual(56.1);
  await page.reload(); await expect(page.locator(`#fleet-rows tr[data-host="${mode.address}"] td[data-col="pc"]`)).toHaveText("Generated shared PC");
  for (const id of ["sidebar-hosts", "sidebar-secure", "sidebar-wallet"]) await expect(page.locator(`#${id}`)).toBeHidden();
  expect(mode.requests).toEqual([]);
});
