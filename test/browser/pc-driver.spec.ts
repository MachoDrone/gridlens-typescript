import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { SYNTHETIC_HOST_ADDRESSES } from "../fixtures/host-addresses.ts";
import type { SharedObservations } from "../../src/contracts/shared.ts";
import type { HostMetadataRecord } from "../../src/fleet/host-metadata.ts";

const addresses = SYNTHETIC_HOST_ADDRESSES.slice(0, 4), pcId = "a".repeat(64), fingerprint = "SHA256:" + "A".repeat(43);
const cell = (page: Page, index: number, key: string) => page.locator(`#fleet-rows tr[data-host="${addresses[index]}"] td[data-col="${key}"]`);
async function fixture(page: Page, stale = false) {
  const at = Date.now(), observed = at - (stale ? 7 * 60_000 : 1000);
  const context = { scopeId: "generated-driver-fleet", rosterRevision: "one", addresses };
  const metadata: HostMetadataRecord[] = addresses.map((address, index) => ({ address, fetchedAtMs: at - 1000, retained: index === 1, error: index === 1 ? "Generated prior metadata failure" : null, marketError: null,
    values: { status: "PREMIUM", marketAddress: null, marketLabel: null, ram: 64, disk: 100, cpu: "Generated CPU",
      cuda: index === 3 ? "12.6" : "missing", nvidia: index === 3 ? "570.88.42" : "missing", currentNode: "1.0.0-fixture", system: "generated" } }));
  const data: SharedObservations = { version: 1, serverId: "generated-server", scopeId: context.scopeId, rosterRevision: context.rosterRevision,
    associations: addresses.map((address, index) => ({ address, binding: { pcId, runtime: "docker", wrapperId: null, nodeContainerId: (index + 1).toString(16).padStart(64, "0") },
      name: "Generated PC", sshFingerprint: fingerprint, verifiedAtMs: at - 10_000, privateIp: null, gpuUuids: [] })), observations: [], networks: [],
    drivers: [{ pcId, sshFingerprint: fingerprint, approvalAtMs: at - 10 * 60_000, receivedAtMs: observed,
      driver: { schema: 1, source: "pc-nvidia-smi-version", observedAtMs: observed, status: "ok", driverVersion: "580.72.13", cudaDriverVersion: "12.8" } }] };
  const mode = { data, metadata, failed: false, malformed: false, reads: 0, posts: 0 };
  await page.clock.install();
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== "http://127.0.0.1:4174") throw Error("Unexpected external request in driver fixture");
    if (request.method() !== "GET") mode.posts++;
    if (request.resourceType() === "document") {
      const response = await route.fetch(), body = (await response.text()).replace("</head>", '<meta name="gridlens-shared-backend" content="1"><meta name="gridlens-api-base" content="/api/fleet"><meta name="gridlens-source-mode" content="snapshot"></head>');
      await route.fulfill({ response, body }); return;
    }
    if (url.pathname === "/api/shared/status") { await route.fulfill({ json: { version: 1, serverId: data.serverId, context, role: "viewer" } }); return; }
    if (url.pathname === "/api/shared/observations") {
      mode.reads++;
      if (mode.failed) { await route.fulfill({ status: 503, json: {} }); return; }
      await route.fulfill({ json: mode.malformed ? { ...data, drivers: data.drivers!.map(row => ({ ...row, sshFingerprint: "SHA256:" + "B".repeat(43) })) } : data }); return;
    }
    if (url.pathname.startsWith("/api/fleet/")) {
      if (url.pathname.endsWith("/hosts.json")) { await route.fulfill({ json: { addresses, error: null } }); return; }
      if (url.pathname.endsWith("/connection.json")) { await route.fulfill({ json: { status: "ok" } }); return; }
      if (url.pathname.endsWith("/metadata.json")) { await route.fulfill({ json: { hosts: metadata } }); return; }
      await route.fulfill({ json: { hosts: [] } }); return;
    }
    if (url.pathname.startsWith("/api/shared/")) { await route.fulfill({ status: 404, json: {} }); return; }
    await route.continue();
  });
  return mode;
}
for (const width of [1440, 390]) test(`verified PC versions fill three missing hosts while valid upstream and GPU meaning remain intact at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 }); const mode = await fixture(page); await page.goto("/");
  for (let index = 0; index < 3; index++) {
    await expect(cell(page, index, "cuda")).toHaveText("12.8"); await expect(cell(page, index, "nvidia")).toHaveText("580");
    await expect(cell(page, index, "nvidia")).toHaveAttribute("data-metadata-source", "pc-nvidia-smi-version");
    await expect(cell(page, index, "nvidia")).toHaveAttribute("data-metadata-state", "reported");
    await expect(cell(page, index, "nvidia").locator(".metadata-value")).toHaveAttribute("aria-label", /580\.72\.13.*Generated PC.*NVIDIA-SMI.*does not establish GPU health/);
    await expect(cell(page, index, "pc")).toHaveAttribute("title", /PC NVIDIA driver 580\.72\.13; driver-supported CUDA 12\.8.*NVIDIA-SMI/);
    await expect(cell(page, index, "nvidia").locator("button")).toHaveCount(0);
  }
  await expect(cell(page, 3, "cuda")).toHaveText("12.6"); await expect(cell(page, 3, "nvidia")).toHaveText("570");
  await expect(cell(page, 3, "nvidia")).toHaveAttribute("data-metadata-source", "nosana");
  await page.locator("#nvidia-display-toggle").click();
  await expect(cell(page, 0, "nvidia")).toHaveText("580.72.13"); await expect(cell(page, 3, "nvidia")).toHaveText("570.88.42");
  expect(mode.posts).toBe(0);
});
test("driver failure and expired evidence retain exact source time without becoming current", async ({ page }) => {
  const mode = await fixture(page, true); await page.goto("/");
  const sourceTime = new Date(mode.data.drivers![0]!.driver.observedAtMs).toISOString();
  await expect(cell(page, 0, "cuda")).toHaveText("12.8");
  await expect(cell(page, 0, "cuda")).toHaveAttribute("data-metadata-state", "retained");
  await expect(cell(page, 0, "cuda").locator(".metadata-value")).toHaveAttribute("aria-label", new RegExp(sourceTime.replaceAll(".", "\\.")));
  mode.data.drivers![0]!.lastGoodDriver = { ...mode.data.drivers![0]!.driver };
  mode.data.drivers![0]!.driver = { ...mode.data.drivers![0]!.driver, observedAtMs: Date.now(), status: "query-failed", driverVersion: null, cudaDriverVersion: null };
  await page.clock.fastForward(31_000);
  await expect.poll(() => mode.reads).toBeGreaterThan(1);
  await expect(cell(page, 0, "nvidia")).toHaveText("580"); await expect(cell(page, 0, "nvidia")).toHaveAttribute("data-metadata-state", "retained");
  await expect(cell(page, 0, "pc")).toHaveAttribute("title", new RegExp(sourceTime.replaceAll(".", "\\.")));
  expect(mode.posts).toBe(0);
});
test("revoked driver visibility removes fallback, while malformed identity cannot replace valid retained values", async ({ page }) => {
  const mode = await fixture(page); await page.goto("/"); await expect(cell(page, 0, "cuda")).toHaveText("12.8");
  mode.malformed = true; await page.clock.fastForward(31_000);
  await expect(cell(page, 0, "cuda")).toHaveAttribute("data-metadata-state", "retained");
  mode.malformed = false; mode.data.drivers = []; await page.clock.fastForward(31_000);
  await expect(cell(page, 0, "cuda")).toHaveText("—"); await expect(cell(page, 0, "nvidia")).toHaveText("—");
  await expect(cell(page, 3, "nvidia")).toHaveText("570"); expect(mode.posts).toBe(0);
});
test("a PC fallback expires locally even when repeated shared responses contain unchanged readings", async ({ page }) => {
  const mode = await fixture(page); await page.goto("/");
  await expect(cell(page, 0, "nvidia")).toHaveAttribute("data-metadata-state", "reported");
  const at = mode.data.drivers![0]!.driver.observedAtMs;
  await page.clock.fastForward(6 * 60_000 + 2000);
  await expect(cell(page, 0, "nvidia")).toHaveAttribute("data-metadata-state", "retained");
  await expect(cell(page, 0, "nvidia")).toHaveText("580");
  await expect(cell(page, 0, "pc")).toHaveAttribute("title", new RegExp(new Date(at).toISOString().replaceAll(".", "\\.")));
  expect(mode.data.drivers![0]!.driver.observedAtMs).toBe(at); expect(mode.posts).toBe(0);
});
