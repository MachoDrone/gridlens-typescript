import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { SharedObservations } from "../../src/contracts/shared.ts";
import { GPU_FRESH_MS } from "../../src/fleet/pc-gpu-devices.ts";
import { SYNTHETIC_HOST_ADDRESSES } from "../fixtures/host-addresses.ts";

const addresses = SYNTHETIC_HOST_ADDRESSES.slice(0, 4), pcId = "a".repeat(64), fingerprint = "SHA256:" + "A".repeat(43);
const uuids = ["00000001", "00000002", "00000003", "00000004"].map(value => `GPU-${value}-bbbb-cccc-dddd-eeeeeeeeeeee`);
const bootId = "e".repeat(32);
const cell = (page: Page, index: number, key = "gpuID") => page.locator(`#fleet-rows > tr[data-host="${addresses[index]}"] > td[data-col="${key}"]`);
async function fixture(page: Page) {
  const at = Date.now(), observed = at - 1000;
  const context = { scopeId: "generated-gpu-fleet", rosterRevision: "one", addresses };
  const associations = addresses.map((address, index) => ({ address,
    binding: { pcId, runtime: "docker" as const, wrapperId: null, nodeContainerId: (index + 1).toString(16).padStart(64, "0") },
    name: "Generated GPU PC", sshFingerprint: fingerprint, verifiedAtMs: at - 20_000, privateIp: null,
    gpuUuids: index === 0 ? [uuids[0]!] : index === 1 ? [uuids[1]!] : index === 2 ? [uuids[2]!, uuids[3]!] : [] }));
  const data: SharedObservations = { version: 1, serverId: "generated-server", scopeId: context.scopeId, rosterRevision: context.rosterRevision,
    associations, observations: [], networks: [], pcGpuDevices: [{ pcId, sshFingerprint: fingerprint, approvalAtMs: at - 60_000, receivedAtMs: observed,
      gpu: { schema: 1, source: "pc-nvidia-smi", observedAtMs: observed, bootId, status: "ok",
        devices: [10, 2, 0, 11].map((index, position) => ({ uuid: uuids[position]!, index, pciBusId: `0000:${(position + 1).toString(16).padStart(2, "0")}:00.0`, observedAtMs: observed, status: "responds" })),
        allocations: associations.slice(0, 3).map(association => ({ address: association.address, binding: association.binding,
          observedAtMs: observed, status: "ok", gpuUuids: association.gpuUuids })),
        journal: { status: "ok", events: [] } } }],
    drivers: [{ pcId, sshFingerprint: fingerprint, approvalAtMs: at - 60_000, receivedAtMs: observed,
      driver: { schema: 1, source: "pc-nvidia-smi-version", observedAtMs: observed, status: "ok", driverVersion: "580.72.13", cudaDriverVersion: "12.8" } }] };
  const mode = { data, failed: false, reads: 0, posts: 0, errors: [] as string[] };
  await page.clock.install({ time: at });
  page.on("pageerror", error => mode.errors.push(error.message));
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== "http://127.0.0.1:4174") throw Error("Unexpected external request in generated GPU fixture");
    if (request.method() !== "GET") mode.posts++;
    if (request.resourceType() === "document") {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace("</head>", '<meta name="gridlens-shared-backend" content="1"><meta name="gridlens-api-base" content="/api/fleet"><meta name="gridlens-source-mode" content="snapshot"></head>') }); return;
    }
    if (url.pathname === "/api/shared/status") { await route.fulfill({ json: { version: 1, serverId: data.serverId, context, role: "viewer" } }); return; }
    if (url.pathname === "/api/shared/observations") { mode.reads++; await route.fulfill({ status: mode.failed ? 503 : 200, json: mode.failed ? {} : data }); return; }
    if (url.pathname.startsWith("/api/fleet/")) {
      if (url.pathname.endsWith("/hosts.json")) { await route.fulfill({ json: { addresses, error: null } }); return; }
      if (url.pathname.endsWith("/connection.json")) { await route.fulfill({ json: { status: "ok" } }); return; }
      await route.fulfill({ json: { hosts: [] } }); return;
    }
    if (url.pathname.startsWith("/api/shared/")) { await route.fulfill({ status: 404, json: {} }); return; }
    await route.continue();
  });
  return mode;
}

for (const width of [1440, 390]) test(`GPU ID renders measured physical mappings and sorts numeric multi-device identities at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 }); const mode = await fixture(page); await page.goto("/");
  for (const [index, text] of [[0, "10"], [1, "2"], [2, "0, 11"]] as const) {
    await expect(cell(page, index)).toHaveText(text);
    await expect(cell(page, index)).toHaveAttribute("data-gpu-state", "current");
    await expect(cell(page, index)).toHaveAttribute("data-gpu-warning", "false");
    await expect(cell(page, index)).not.toHaveAttribute("title");
    await expect(cell(page, index).locator("button, a")).toHaveCount(0);
    await expect(cell(page, index)).toHaveAttribute("aria-label", /device response does not establish GPU health/);
  }
  await expect(cell(page, 3)).toHaveAttribute("data-gpu-state", "unknown");
  await page.getByRole("button", { name: "Sort by GPU ID", exact: true }).click();
  expect(await page.locator('#fleet-rows > tr[data-host]').evaluateAll(rows => rows.map(row => row.getAttribute("data-host"))))
    .toEqual([addresses[2], addresses[1], addresses[0], addresses[3]]);
  await page.getByRole("button", { name: "Sort by GPU ID", exact: true }).click();
  expect(await page.locator('#fleet-rows > tr[data-host]').evaluateAll(rows => rows.map(row => row.getAttribute("data-host"))))
    .toEqual([addresses[0], addresses[1], addresses[2], addresses[3]]);
  await expect(cell(page, 0, "nvidia")).toHaveText("580");
  expect(mode.posts).toBe(0); expect(mode.errors).toEqual([]);
});

test("device query failures retain measured indices and never invent Xid or change job State", async ({ page }) => {
  const mode = await fixture(page); await page.goto("/"); await expect(cell(page, 0)).toHaveText("10");
  const record = mode.data.pcGpuDevices![0]!, measuredAt = record.gpu.observedAtMs;
  const originalState = await cell(page, 0, "state").getAttribute("data-state");
  record.lastGood = structuredClone(record.gpu);
  record.gpu.observedAtMs = measuredAt + 2000; record.gpu.status = "partial";
  record.gpu.devices[0] = { uuid: uuids[0]!, index: null, pciBusId: null, status: "query-failed", observedAtMs: measuredAt + 2000 };
  await page.clock.fastForward(31_000);
  await expect(cell(page, 0)).toHaveAttribute("data-gpu-state", "retained");
  await expect(cell(page, 0).locator(".gpu-id-retained")).toHaveText("10");
  await expect(cell(page, 0)).toHaveAttribute("data-gpu-warning", "true");
  await expect(cell(page, 0)).toHaveAttribute("aria-label", /query failed/);
  expect(await cell(page, 0).getAttribute("aria-label")).toContain(new Date(measuredAt).toISOString());
  expect(await cell(page, 0).getAttribute("aria-label")).not.toMatch(/(?:Recorded|PC-level) Xid \d/);
  expect(await cell(page, 0, "state").getAttribute("data-state")).toBe(originalState);
  await expect(cell(page, 1)).toHaveAttribute("data-gpu-state", "current");
  await expect(cell(page, 1)).toHaveAttribute("data-gpu-warning", "false");
  await expect(cell(page, 0, "nvidia")).toHaveText("580");
  expect(mode.posts).toBe(0); expect(mode.errors).toEqual([]);
});

test("matched historical Xid stays with its UUID while unmatched evidence remains explicitly PC-level", async ({ page }) => {
  const mode = await fixture(page), record = mode.data.pcGpuDevices![0]!, at = record.gpu.observedAtMs - 5000;
  record.gpu.journal.events = [
    { bootId, pciBusId: "0000:01:00", xid: 79, atMs: at, gpuUuid: uuids[0]! },
    { bootId, pciBusId: "0000:ff:00", xid: 31, atMs: at - 1000, gpuUuid: null },
  ];
  await page.goto("/"); await expect(cell(page, 0)).toHaveAttribute("data-gpu-warning", "true");
  await expect(cell(page, 0)).toHaveAttribute("data-gpu-state", "current");
  await expect(cell(page, 0)).toHaveAttribute("aria-label", new RegExp(`Recorded Xid 79 for ${uuids[0]}`));
  await expect(cell(page, 1)).not.toHaveAttribute("aria-label", /Recorded Xid 79/);
  for (const index of [0, 1]) {
    await expect(cell(page, index)).toHaveAttribute("aria-label", /PC-level Xid 31.*not assigned to this host/);
    expect(await cell(page, index).getAttribute("aria-label")).toContain(new Date(at - 1000).toISOString());
  }
  await expect(cell(page, 0, "pc")).toHaveAttribute("title", /PC-level Xid 31/);
  expect(mode.posts).toBe(0); expect(mode.errors).toEqual([]);
});

test("GPU mappings expire locally and failed reads retain original source dates", async ({ page }) => {
  const mode = await fixture(page); await page.goto("/"); await expect(cell(page, 2)).toHaveAttribute("data-gpu-state", "current");
  const at = mode.data.pcGpuDevices![0]!.gpu.observedAtMs;
  await page.clock.fastForward(GPU_FRESH_MS + 2000);
  await expect(cell(page, 2)).toHaveAttribute("data-gpu-state", "retained");
  await expect(cell(page, 2).locator(".gpu-id-retained")).toHaveText("0, 11");
  expect(await cell(page, 2).getAttribute("aria-label")).toContain(new Date(at).toISOString());
  mode.failed = true; await page.clock.fastForward(31_000);
  await expect(cell(page, 2)).toHaveAttribute("data-gpu-state", "retained");
  expect(await cell(page, 2).getAttribute("aria-label")).toContain(new Date(at).toISOString());
  mode.failed = false; mode.data.pcGpuDevices = []; await page.clock.fastForward(31_000);
  await expect(cell(page, 2)).toHaveText("—"); await expect(cell(page, 2)).toHaveAttribute("data-gpu-state", "unknown");
  expect(mode.posts).toBe(0); expect(mode.errors).toEqual([]);
});
