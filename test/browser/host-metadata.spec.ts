import { expectFleetDocumentFlow, openPreviewTools } from "./helpers.ts";
import { emptyStaking } from "../fixtures/staking.ts";
import { emptyNos } from "../fixtures/nos.ts";
import { emptySol } from "../fixtures/sol.ts";
import { emptyQueue } from "../fixtures/queue.ts";
import { emptyJobs } from "../fixtures/jobs.ts";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPreviewServer } from "../../scripts/preview-server.ts";
import type { HostMetadataRecord, HostMetadataSnapshot, HostMetadataValues } from "../../src/fleet/host-metadata.ts";
import { SYNTHETIC_HOST_ADDRESSES } from "../fixtures/host-addresses.ts";

// Every identity and observation here is artificial. Providers are injected;
// neither the browser nor the preview server contacts real hosts or Nosana.
const FETCHED_AT = Date.UTC(2026, 0, 1, 12);
const addresses = SYNTHETIC_HOST_ADDRESSES;
const baseValues: HostMetadataValues = {
  status: "PREMIUM", marketAddress: addresses[7]!, marketLabel: "nvidia-demo-4090",
  ram: 63.7, disk: 732.25, cpu: "13th Gen Intel(R) Core(TM) i9-13900K",
  cuda: "12.8", nvidia: "580.126.09", currentNode: "1.2.3", system: "6.11.0-29-generic",
};
const selectedColumns = new Set([
  "hostAddress", "status", "market", "ram", "disk", "cpu", "cuda", "nvidia", "currentNode", "system",
]);
let origin = "";
const servers: Server[] = [];
const directories: string[] = [];
const externalRequests: string[] = [];
const browserErrors: string[] = [];
const metadataRequests: string[] = [];

function record(index: number, values: Partial<HostMetadataValues> | null = {}): HostMetadataRecord {
  return {
    address: addresses[index]!, values: values === null ? null : { ...baseValues, ...values },
    fetchedAtMs: values === null ? null : FETCHED_AT,
    retained: false, error: null, marketError: null,
  };
}

function completeSnapshot(): HostMetadataSnapshot {
  return { hosts: [
    record(0),
    record(1, {
      status: "COMMUNITY", marketLabel: "nvidia-demo-3060", ram: 63.6, disk: 64.2,
      cpu: "AMD Ryzen 9 5900X 12-Core Processor", nvidia: "580.90.07",
      currentNode: "1.2.3-rc.1", system: "6.11.0-9-generic",
    }),
    record(2, { status: "REJECTED", marketLabel: "amber-demo-4090", ram: 0, disk: 0 }),
    record(3, { status: "ONBOARDED", ram: null, disk: null }),
    record(4, null), record(5, null), record(6, null), record(7, null),
  ] };
}

async function start(provider: (input: readonly string[]) => Promise<HostMetadataSnapshot>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-metadata-browser-"));
  directories.push(directory);
  const hostsFile = join(directory, "hosts.json");
  await writeFile(hostsFile, JSON.stringify(addresses));
  const server = await startPreviewServer({ now: () => FETCHED_AT, stakingProvider: emptyStaking, nosProvider: emptyNos, solProvider: emptySol, queueProvider: emptyQueue, jobProvider: emptyJobs,
    hostsFile, port: 0, metadataProvider: provider,
    nodeInfoProvider: async input => ({ hosts: input.map(address => ({
      address, values: null, fetchedAtMs: null, validUntilMs: null,
      retained: false, error: null,
    })) }),
  });
  servers.push(server);
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("Missing isolated preview port");
  origin = `http://127.0.0.1:${bound.port}`;
  return origin;
}

function cell(page: Page, key: string, index = 0) {
  return page.locator(`#fleet-rows [data-host="${addresses[index]}"] td[data-col="${key}"]`);
}

async function hostOrder(page: Page): Promise<string[]> {
  return page.locator("#fleet-rows [data-host]").evaluateAll(rows => rows.map(row => row.getAttribute("data-host") ?? ""));
}

test.beforeEach(async ({ context, page }) => {
  origin = "";
  externalRequests.length = 0;
  browserErrors.length = 0;
  metadataRequests.length = 0;
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) {
      externalRequests.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/preview/metadata.json") metadataRequests.push(request.url());
  });
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") browserErrors.push(message.text()); });
});

test.afterEach(async ({ page }) => {
  // End browser polling before closing its isolated provider server.
  await page.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  expect(externalRequests, "Metadata fixtures must never contact external services").toEqual([]);
  expect(browserErrors, "No browser runtime or loading errors").toEqual([]);
});

test("selected Nosana fields follow compact reference formatting without inventing the deferred fields", async ({ page }, info) => {
  const historyRequests: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname === "/preview/job-history.json") historyRequests.push(request.url()); });
  const supplied: string[][] = [];
  await page.goto(await start(async input => { supplied.push([...input]); return completeSnapshot(); }));
  await openPreviewTools(page);
  await expect(cell(page, "status")).toHaveText("P");
  await expect(cell(page, "status", 1)).toHaveText("C");
  await expect(cell(page, "status", 2)).toHaveText("R");
  await expect(cell(page, "status", 3)).toHaveText("C");
  await expect(cell(page, "status").getByRole("button")).toHaveCSS("color", "rgb(74, 222, 128)");
  await expect(cell(page, "status", 1).getByRole("button")).toHaveCSS("color", "rgb(234, 179, 8)");
  await expect(cell(page, "status", 3).getByRole("button")).toHaveCSS("color", "rgb(234, 179, 8)");
  await expect(cell(page, "status", 2).getByRole("button")).toHaveCSS("color", "rgb(239, 68, 68)");
  for (const [key, expected] of Object.entries({
    ram: "64", disk: "732.25", market: "nvidia-demo-4090", cuda: "12.8",
    nvidia: "580", cpu: "13th", system: "6.11.0", currentNode: "1.2.3",
  })) {
    await expect(cell(page, key)).toHaveText(expected);
    await expect(cell(page, key).locator("span.metadata-value")).toHaveCount(1);
    await expect(cell(page, key).getByRole("button")).toHaveCount(0);
    await expect(cell(page, key)).not.toHaveAttribute("title");
  }
  await expect(cell(page, "currentNode", 1)).toHaveText("1.2.3-rc.1");
  await expect(cell(page, "currentNode", 1).locator(".metadata-value")).toHaveCSS("color", "rgb(236, 72, 153)");
  await expect(cell(page, "ram", 2)).toHaveText("0");
  await expect(cell(page, "disk", 2)).toHaveText("0");
  await expect(cell(page, "ram", 3)).toHaveText("—");
  await expect(cell(page, "status", 4)).toHaveText("—");
  await expect(page.locator("#inventory-summary")).toContainText(/Reported Nosana metadata/i);
  await expect(page.locator("#column-headings th[data-col]")).toHaveCount(28);
  await expect(page.locator("#fleet-rows [data-host]")).toHaveCount(8);
  for (const row of await page.locator("#fleet-rows [data-host]").all()) {
    for (const column of await row.locator("td[data-col]").all()) {
      const key = await column.getAttribute("data-col") ?? "";
      if (key === "api" || key === "duration") await expect(column).toHaveText("Populating..");
      else if (key === "state") {
        await expect(column.locator(".state-unknown .state-dots")).toBeVisible();
        await expect(column).toHaveAttribute("data-state", "unknown");
        await expect(column).toHaveAttribute("data-state-current", "false");
        await expect(column.getByRole("button")).toHaveAccessibleName(/unknown/);
      }
      else if (key === "latestJob") {
        await expect(column.locator(".job-summary-link")).toHaveText("—");
        await expect(column.locator(".job-summary-link")).not.toHaveAttribute("href");
        await expect(column.locator(".job-summary-state")).toHaveText("Unknown");
        await expect(column.locator(".jobs-expand")).toHaveAttribute("aria-expanded", "false");
      }
      else if (!selectedColumns.has(key)) await expect(column).toHaveText("—");
    }
    expect(await row.evaluate(element => element.getBoundingClientRect().height)).toBe(34);
  }
  expect(supplied).toEqual([addresses]);
  expect(historyRequests, "Metadata must not trigger collapsed job-history reads").toEqual([]);
  await expect(cell(page, "hostAddress").getByRole("link")).toHaveAttribute("href", `https://explore.nosana.com/hosts/${addresses[0]}`);
  await expectFleetDocumentFlow(page);
  const lastRow = await page.locator("#fleet-rows tr").last().boundingBox();
  const controls = await page.getByLabel("Scenario", { exact: true }).boundingBox();
  expect(controls?.y).toBeGreaterThan((lastRow?.y ?? 0) + (lastRow?.height ?? 0));
  await page.screenshot({ path: info.outputPath("reported-metadata-compact.png"), fullPage: true });
});

test("full values drive sorting and accessible labels while independent compact toggles preserve observations", async ({ page }) => {
  await page.goto(await start(async () => completeSnapshot()));
  await openPreviewTools(page);
  await expect(cell(page, "ram")).toHaveText("64");
  await page.getByRole("button", { name: "Sort by RAM", exact: true }).click();
  expect(await hostOrder(page)).toEqual([addresses[2], addresses[1], addresses[0], ...addresses.slice(3)]);
  await page.getByRole("button", { name: "Sort by RAM", exact: true }).click();
  expect(await hostOrder(page)).toEqual([addresses[0], addresses[1], addresses[2], ...addresses.slice(3)]);
  await expect(cell(page, "ram").locator("span.metadata-value")).toHaveAttribute("aria-label", /RAM: 63\.7 GB/);
  await cell(page, "ram").locator(".metadata-value").click();
  await expect(page.getByRole("dialog")).toBeHidden();
  for (const [key, label, expanded] of [
    ["nvidia", "NVIDIA", "580.126.09"],
    ["cpu", "CPU", "13th Gen Intel(R) Core(TM) i9-13900K"],
    ["system", "System", "6.11.0-29-generic"],
  ]) {
    await page.getByRole("button", { name: `Toggle ${label} display`, exact: true }).click();
    await expect(cell(page, key!)).toHaveText(expanded!);
  }
  await page.getByRole("button", { name: "Sort by NVIDIA", exact: true }).click();
  expect((await hostOrder(page)).slice(0, 4)).toEqual([addresses[1], addresses[0], addresses[2], addresses[3]]);
  await page.getByRole("button", { name: "Toggle NVIDIA display", exact: true }).click();
  expect((await hostOrder(page)).slice(0, 4)).toEqual([addresses[1], addresses[0], addresses[2], addresses[3]]);
  await page.getByRole("button", { name: "Sort by Market", exact: true }).click();
  const order = await hostOrder(page);
  expect(order.slice(0, 4)).toEqual([addresses[2], addresses[1], addresses[0], addresses[3]]);
  await page.getByRole("button", { name: "Toggle Market display", exact: true }).click();
  await expect(cell(page, "market")).toHaveText("nv");
  expect(await hostOrder(page)).toEqual(order);
  await expect(cell(page, "market").locator("span.metadata-value")).toHaveAttribute("aria-label", /Market: nvidia-demo-4090/);
  await cell(page, "market").locator(".metadata-value").click();
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(metadataRequests).toHaveLength(1);
});

test("ONBOARDED displays and sorts as COMMUNITY while details preserve the supplied classification", async ({ page }) => {
  await page.goto(await start(async () => completeSnapshot()));
  await openPreviewTools(page);
  await expect(cell(page, "status", 3)).toHaveText("C");
  await page.getByRole("button", { name: "Sort by Status", exact: true }).click();
  expect(await hostOrder(page)).toEqual([
    addresses[1], addresses[3], addresses[0], addresses[2], ...addresses.slice(4),
  ]);
  await page.getByRole("button", { name: "Sort by Status", exact: true }).click();
  expect(await hostOrder(page)).toEqual([
    addresses[2], addresses[0], addresses[1], addresses[3], ...addresses.slice(4),
  ]);
  await cell(page, "status", 3).getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText("COMMUNITY");
  await expect(page.getByRole("dialog")).toContainText("ONBOARDED");
});

test("rendering, synthetic scenarios and elapsed time cause no background metadata requests", async ({ page }) => {
  let calls = 0;
  await page.clock.install({ time: FETCHED_AT });
  await page.goto(await start(async () => { calls++; return completeSnapshot(); }));
  await openPreviewTools(page);
  await expect(cell(page, "status")).toHaveText("P");
  for (const label of ["IP", "Duration", "Market", "NVIDIA", "CPU", "System", "Country"]) {
    await page.getByRole("button", { name: `Toggle ${label} display`, exact: true }).click();
  }
  await page.getByRole("button", { name: "Sort by Status", exact: true }).click();
  await page.getByLabel("Scenario", { exact: true }).selectOption("mixed");
  await expect(page.locator("#host-count")).toHaveText("6 hosts");
  await expect(page.locator("#metadata-status")).toBeHidden();
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await page.getByLabel("Scenario", { exact: true }).selectOption("scale");
  await expect(page.locator("#fleet-rows [data-host]")).toHaveCount(200);
  await page.getByLabel("Scenario", { exact: true }).selectOption("supplied");
  await expect(cell(page, "status")).toHaveText("P");
  await page.clock.fastForward(300_000);
  expect(calls).toBe(1);
  expect(metadataRequests).toHaveLength(1);
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect.poll(() => calls).toBe(2);
  expect(metadataRequests).toHaveLength(2);
});

test("opening directly in a synthetic scenario never requests Nosana metadata", async ({ page }) => {
  let calls = 0;
  await page.goto(`${await start(async () => { calls++; return completeSnapshot(); })}/?scenario=mixed`);
  await openPreviewTools(page);
  await expect(page.locator("#host-count")).toHaveText("6 hosts");
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect(page.locator("#metadata-status")).toBeHidden();
  expect(metadataRequests).toEqual([]);
  expect(calls).toBe(0);
});

test("retained metadata is visibly uncertain and recovers without claiming host activity", async ({ page }) => {
  let calls = 0;
  await page.goto(await start(async () => {
    calls++;
    const snapshot = completeSnapshot();
    if (calls === 2) return { hosts: snapshot.hosts.map(host => ({
      ...host, retained: host.values !== null, error: "Nosana metrics request failed (HTTP 429).",
    })) };
    if (calls >= 3) return { hosts: snapshot.hosts.map(host => ({ ...host, fetchedAtMs: FETCHED_AT + 600_000 })) };
    return snapshot;
  }));
  await openPreviewTools(page);
  await expect(cell(page, "status")).toHaveText("P");
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect(page.locator("#metadata-status")).toContainText(/retained|failed|unavailable/i);
  await expect(cell(page, "status")).toHaveText("P");
  await expect(cell(page, "ram")).toHaveText("64");
  await expect(cell(page, "ram").locator("span.metadata-value")).toHaveClass(/metadata-retained/);
  await expect(cell(page, "ram").locator(".metadata-value")).toHaveCSS("color", "rgb(136, 136, 136)");
  await expect(cell(page, "status").getByRole("button")).toHaveCSS("color", "rgb(136, 136, 136)");
  await cell(page, "status").getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText("PREMIUM");
  await expect(page.getByRole("dialog")).toContainText("429");
  await expect(page.getByRole("dialog")).toContainText(/current host activity is not established/i);
  await expect(page.getByRole("dialog")).toContainText(/retained from the last successful read/i);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect(cell(page, "status").getByRole("button")).toHaveCSS("color", "rgb(74, 222, 128)");
  await expect(cell(page, "ram").locator(".metadata-value")).not.toHaveClass(/metadata-retained/);
  await expect(page.locator("#metadata-status")).not.toContainText("429");
  await cell(page, "status").getByRole("button").click();
  await expect(page.getByRole("dialog")).not.toContainText(/retained from the last successful read/i);
});

test("a missing market label stays unknown as a plain value through display changes", async ({ page }) => {
  await page.goto(await start(async () => ({ hosts: [
    { ...record(0, { marketLabel: null }), marketError: "Market lookup unavailable (HTTP 503)." },
    ...addresses.slice(1).map((_address, index) => record(index + 1, null)),
  ] })));
  await openPreviewTools(page);
  await expect(cell(page, "status")).toHaveText("P");
  await expect(cell(page, "market")).toHaveText("—");
  await page.getByRole("button", { name: "Toggle Market display", exact: true }).click();
  await expect(cell(page, "market")).toHaveText("—");
  await expect(cell(page, "market")).toHaveAttribute("data-metadata-state", "unknown");
  await expect(cell(page, "market").locator("span.metadata-value")).toHaveAttribute("aria-label", /Market: unknown/);
  await expect(cell(page, "market").locator(".metadata-value")).toHaveClass(/metadata-retained/);
  await expect(cell(page, "market").getByRole("button")).toHaveCount(0);
  await expect(cell(page, "market")).not.toHaveAttribute("title");
  await cell(page, "market").locator(".metadata-value").click();
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("a late metadata response cannot replace the selected synthetic scenario", async ({ page }) => {
  let release: ((value: HostMetadataSnapshot) => void) | undefined;
  const pending = new Promise<HostMetadataSnapshot>(resolve => { release = resolve; });
  await page.goto(await start(async () => pending));
  await openPreviewTools(page);
  await expect.poll(() => metadataRequests.length).toBe(1);
  await page.getByLabel("Scenario", { exact: true }).selectOption("mixed");
  // Switching to a sample aborts the browser request. A provider ignoring that
  // cancellation still cannot replace the selected synthetic view.
  release!(completeSnapshot());
  await expect(page.locator("#host-count")).toHaveText("6 hosts");
  await expect(page.locator('#fleet-rows [data-source="supplied"]')).toHaveCount(0);
  await expect(page.locator("#metadata-status")).toBeHidden();
  await expect(page.getByText("Sample data", { exact: true })).toBeVisible();
});
