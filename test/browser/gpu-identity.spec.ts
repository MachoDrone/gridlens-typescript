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
    await expect(cell(page, index).locator("button.gpu-id-action")).toHaveCount(1);
    await expect(cell(page, index)).toHaveAttribute("aria-label", /read successfully/);
  }
  await expect(cell(page, 3)).toHaveAttribute("data-gpu-state", "unknown");
  await cell(page, 0).getByRole("button").click();
  await expect(page.locator("#info-body .info-summary .info-tone-positive")).toHaveText("GPU ID 10 read successfully.");
  await expect(page.locator("#info-body .info-source")).not.toHaveAttribute("open");
  await expect(page.locator("#info-body .info-source-body")).toBeHidden();
  await page.locator("#close-info").click();
  await expect(cell(page, 0).getByRole("button")).toBeFocused();
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
  await expect(cell(page, 0)).toHaveAttribute("aria-label", /could not be read/);
  await cell(page, 0).getByRole("button").click();
  await expect(page.locator("#info-body .info-summary .info-tone-warning")).toBeVisible();
  await page.locator("#info-body .info-source > summary").click();
  await expect(page.locator("#info-body .info-source-body")).toContainText(new Date(measuredAt).toISOString());
  await expect(page.locator("#info-body .info-source-body")).not.toContainText("fell off the bus");
  await page.locator("#close-info").click();
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
  await page.goto("/"); await expect(cell(page, 0)).toHaveAttribute("data-gpu-warning", "false");
  await expect(cell(page, 0)).toHaveAttribute("data-gpu-state", "current");
  await expect(cell(page, 1)).toHaveAttribute("data-gpu-warning", "false");
  await expect(page.locator("#gpu-pc-warnings")).toHaveText("PC ⚠ 1");
  await cell(page, 0).getByRole("button").click();
  await expect(page.locator("#info-body .info-summary")).toHaveText("GPU ID 10 read successfully.");
  await expect(page.locator("#info-body .info-source-body")).toBeHidden();
  await page.locator("#info-body .info-source > summary").click();
  await expect(page.locator("#info-body .info-source-body")).toContainText("GPU fell off the bus on Generated GPU PC");
  await expect(page.locator("#info-body .info-source-body")).toContainText(new Date(at).toISOString());
  await page.locator("#close-info").click();
  await page.locator("#gpu-pc-warnings").click();
  await expect(page.locator("#info-body .info-summary")).toContainText("not assigned to a host row");
  await expect(page.locator("#info-body .info-facts")).toContainText("Driver event (Xid 31)");
  await page.locator("#close-info").click();
  await expect(page.locator("#gpu-pc-warnings")).toBeFocused();
  await expect(cell(page, 0, "pc")).toHaveAttribute("title", "Computer: Generated GPU PC");
  expect(mode.posts).toBe(0); expect(mode.errors).toEqual([]);
});

test("GPU mappings expire locally and failed reads retain original source dates", async ({ page }) => {
  const mode = await fixture(page); await page.goto("/"); await expect(cell(page, 2)).toHaveAttribute("data-gpu-state", "current");
  const at = mode.data.pcGpuDevices![0]!.gpu.observedAtMs;
  await page.clock.fastForward(GPU_FRESH_MS + 2000);
  await expect(cell(page, 2)).toHaveAttribute("data-gpu-state", "retained");
  await expect(cell(page, 2).locator(".gpu-id-retained")).toHaveText("0, 11");
  await expect(cell(page, 2)).toHaveAttribute("aria-label", /out of date/);
  mode.failed = true; await page.clock.fastForward(31_000);
  await expect(cell(page, 2)).toHaveAttribute("data-gpu-state", "retained");
  await expect(cell(page, 2)).toHaveAttribute("aria-label", /data is unavailable/);
  await cell(page, 2).getByRole("button").click();
  await page.locator("#info-body .info-source > summary").click();
  await expect(page.locator("#info-body .info-source-body")).toContainText(new Date(at).toISOString());
  await page.locator("#close-info").click();
  mode.failed = false; mode.data.pcGpuDevices = []; await page.clock.fastForward(31_000);
  await expect(cell(page, 2)).toHaveText("—"); await expect(cell(page, 2)).toHaveAttribute("data-gpu-state", "unknown");
  expect(mode.posts).toBe(0); expect(mode.errors).toEqual([]);
});

test("GPU-only runtime rediscovery maps empty saved UUIDs and retains an unassigned known-UUID fault at PC level", async ({ page }) => {
  const mode = await fixture(page), record = mode.data.pcGpuDevices![0]!, at = record.gpu.observedAtMs;
  for (const association of mode.data.associations) association.gpuUuids = [];
  record.gpu.status = "partial";
  record.gpu.allocations[0] = { ...record.gpu.allocations[0]!, status: "unavailable", gpuUuids: [] };
  record.gpu.allocations[1]!.observedBinding = { pcId, runtime: "podman", wrapperId: "c".repeat(64), nodeContainerId: "d".repeat(64) };
  record.gpu.journal.events = [{ bootId, pciBusId: "0000:01:00", xid: 79, atMs: at - 5000, gpuUuid: uuids[0]! }];
  const originalAssociations = structuredClone(mode.data.associations);
  await page.goto("/");
  await expect(cell(page, 0).locator(".gpu-id-current")).toHaveText("—");
  await expect(cell(page, 0)).toHaveAttribute("data-gpu-state", "unknown");
  await expect(cell(page, 1).locator(".gpu-id-current")).toHaveText("2");
  await expect(cell(page, 1)).toHaveAttribute("data-gpu-state", "current");
  await expect(cell(page, 1)).toHaveAttribute("data-gpu-warning", "false");
  await expect(cell(page, 0)).toHaveAttribute("data-gpu-warning", "true");
  await expect(page.locator("#gpu-pc-warnings")).toHaveText("PC ⚠ 1");
  await page.locator("#gpu-pc-warnings").click();
  await expect(page.locator("#info-body .info-facts")).toContainText("A GPU on Generated GPU PC fell off the bus");
  await expect(page.locator("#info-body .info-summary")).toContainText("not assigned to a host row");
  await page.locator("#close-info").click();
  await cell(page, 1).getByRole("button").click();
  await expect(page.locator("#info-body .info-summary")).toHaveText("GPU ID 2 read successfully.");
  await page.locator("#info-body .info-source > summary").click();
  await expect(page.locator("#info-body .info-source-body")).toContainText("source approval is unchanged");
  await page.locator("#close-info").click();
  expect(mode.data.associations).toEqual(originalAssociations);
  expect(mode.posts).toBe(0); expect(mode.errors).toEqual([]);
});

test.describe("readable GPU warnings on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test("two readable IDs stay clear while one unavailable ID and one PC warning have separate explanations", async ({ page }, testInfo) => {
    const mode = await fixture(page), record = mode.data.pcGpuDevices![0]!;
    mode.data.associations = mode.data.associations.slice(0, 3);
    for (const association of mode.data.associations) association.gpuUuids = [];
    record.gpu.status = "partial";
    record.gpu.devices = record.gpu.devices.slice(0, 2).map((device, index) => ({ ...device, index }));
    record.gpu.allocations[2] = { ...record.gpu.allocations[2]!, status: "unavailable", gpuUuids: [] };
    const at = record.gpu.observedAtMs - 86_400_000;
    record.gpu.journal.events = [
      { bootId, pciBusId: "0000:01:00", xid: 154, atMs: at, gpuUuid: uuids[0]! },
      { bootId, pciBusId: "0000:02:00", xid: 154, atMs: at, gpuUuid: uuids[1]! },
      { bootId, pciBusId: "0000:06:00", xid: 79, atMs: at, gpuUuid: uuids[2]! },
    ];
    await page.goto("/");
    await expect(cell(page, 0)).toHaveText("0"); await expect(cell(page, 1)).toHaveText("1");
    for (const index of [0, 1]) await expect(cell(page, index)).toHaveAttribute("data-gpu-warning", "false");
    await expect(page.locator(".gpu-id-warning:visible")).toHaveCount(1);
    await expect(page.locator("#gpu-pc-warnings")).toHaveText("PC ⚠ 1");
    await cell(page, 2).getByRole("button").tap();
    await expect(page.locator("#info-body .info-summary .info-tone-warning")).toHaveText("GPU ID unavailable.");
    await page.locator("#close-info").tap();
    await page.locator("#gpu-pc-warnings").tap();
    await expect(page.locator("#info-body .info-facts .info-tone-warning")).toContainText("A GPU on Generated GPU PC fell off the bus");
    await expect(page.locator("#info-body .info-facts .info-tone-muted")).toContainText("recorded");
    await expect(page.locator("#info-body .info-source-body")).toBeHidden();
    expect(await page.locator("#info-body .info-summary, #info-body .info-facts").allTextContents()).not.toEqual(expect.arrayContaining([expect.stringMatching(/GPU-[a-f0-9]|boot [a-f0-9]{32}/)]));
    await page.screenshot({ path: testInfo.outputPath("readable-pc-gpu-warning.png") });
    await page.locator("#close-info").tap();
    await expect(page.locator("#gpu-pc-warnings")).toBeFocused();
    const controls = await page.locator('#column-headings th[data-col="gpuID"] button').evaluateAll(buttons => buttons.map(button => {
      const r = button.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    }));
    expect(controls.every(r => r.width >= 24 && r.height >= 24)).toBe(true);
    expect(Math.min(controls[0]!.bottom, controls[1]!.bottom) - Math.max(controls[0]!.y, controls[1]!.y)).toBeLessThanOrEqual(0);
    const focused = await page.locator("#gpu-pc-warnings").elementHandle();
    await page.clock.fastForward(31_000);
    expect(await focused!.evaluate(node => node.isConnected)).toBe(true);
    await expect(page.locator("#gpu-pc-warnings")).toBeFocused();
    expect(mode.posts).toBe(0); expect(mode.errors).toEqual([]);
  });
});
