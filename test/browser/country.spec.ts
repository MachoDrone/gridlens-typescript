import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPreviewServer } from "../../scripts/preview-server.ts";
import type { HostMetadataSnapshot, HostMetadataValues } from "../../src/fleet/host-metadata.ts";
import { SYNTHETIC_HOST_ADDRESSES as addresses } from "../fixtures/host-addresses.ts";
import { emptyJobs } from "../fixtures/jobs.ts";
import { emptyNos } from "../fixtures/nos.ts";
import { emptyQueue } from "../fixtures/queue.ts";
import { emptySol } from "../fixtures/sol.ts";
import { emptyStaking } from "../fixtures/staking.ts";
import { expectFleetDocumentFlow, openPreviewTools } from "./helpers.ts";

const NOW = Date.UTC(2026, 0, 1, 12);
const preference = "gridlens.preview.country-mode.v1";
const countries = ["us", "DE", "gb", "Netherlands", "ZZ", null, undefined, "CA"] as const;
const compact = ["US", "DE", "GB", "Netherlands", "ZZ", "—", "—", "CA"];
const full = ["United States", "Germany", "United Kingdom", "Netherlands", "ZZ", "—", "—", "Canada"];
const baseValues: HostMetadataValues = { status: "PREMIUM", marketAddress: null, marketLabel: null,
  ram: null, disk: null, cpu: null, cuda: null, nvidia: null, currentNode: null, system: "6.11.0-synthetic" };
const servers: Server[] = [];
const directories: string[] = [];
const errors: string[] = [];
const external: string[] = [];
const dataRequests: string[] = [];
let origin = "";
let metadataCalls = 0;

function snapshot(): HostMetadataSnapshot {
  return { hosts: addresses.map((address, index) => ({ address,
    values: { ...baseValues, ...(countries[index] === undefined ? {} : { country: countries[index] }) },
    fetchedAtMs: NOW, retained: false, error: null, marketError: null,
  })) };
}

async function start(provider: () => HostMetadataSnapshot = snapshot): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-country-browser-"));
  directories.push(directory);
  const hostsFile = join(directory, "hosts.json");
  const real200HostsFile = join(directory, "real200.json");
  await writeFile(hostsFile, JSON.stringify(addresses));
  await writeFile(real200HostsFile, "[]\n");
  const server = await startPreviewServer({ now: () => NOW, hostsFile, real200HostsFile, port: 0,
    metadataProvider: async () => { metadataCalls++; return provider(); },
    nodeInfoProvider: async input => ({ hosts: input.map(address => ({ address,
      values: null, fetchedAtMs: null, validUntilMs: null, retained: false, error: null,
    })) }),
    jobProvider: emptyJobs, queueProvider: emptyQueue, solProvider: emptySol,
    nosProvider: emptyNos, stakingProvider: emptyStaking,
  });
  servers.push(server);
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("Missing isolated country preview port");
  origin = `http://127.0.0.1:${bound.port}`;
  return origin;
}

function cell(page: Page, index = 0) {
  return page.locator(`#fleet-rows [data-host="${addresses[index]}"] td[data-col="country"]`);
}
function toggle(page: Page) { return page.locator("#country-display-toggle"); }
async function order(page: Page) {
  return page.locator("#fleet-rows > tr[data-host]").evaluateAll(rows => rows.map(row => row.getAttribute("data-host")));
}
async function ready(page: Page) {
  await expect(cell(page)).toHaveText("US");
  await page.waitForLoadState("networkidle");
}

test.beforeEach(async ({ context, page }) => {
  origin = "";
  metadataCalls = 0;
  errors.length = external.length = dataRequests.length = 0;
  await page.clock.install({ time: NOW });
  await page.clock.pauseAt(NOW);
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { external.push(url.href); return route.abort(); }
    if (url.pathname.startsWith("/preview/") && url.pathname.endsWith(".json") &&
        url.pathname !== "/preview/connection.json") dataRequests.push(url.pathname);
    return route.continue();
  });
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
});

test.afterEach(async ({ page }) => {
  await page.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  expect(external, "Country uses only the isolated injected sources").toEqual([]);
  expect(errors).toEqual([]);
});

test("Country follows System, preserves free text and unknowns, and changes display without reads", async ({ page }) => {
  await page.goto(await start());
  await ready(page);
  expect((await page.locator("#column-headings th[data-col]").evaluateAll(headers =>
    headers.map(header => header.getAttribute("data-col")))).slice(-2)).toEqual(["system", "country"]);
  await expect(page.locator("#column-headings th[data-col]")).toHaveCount(28);
  await expect(toggle(page)).toHaveAccessibleName("Toggle Country display");
  await expect(toggle(page)).toHaveAttribute("data-mode", "compact");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  expect(await page.locator('#fleet-rows td[data-col="country"]').allTextContents()).toEqual(compact);
  const before = [...dataRequests];
  await toggle(page).focus();
  await page.keyboard.press("Enter");
  await expect(toggle(page)).toBeFocused();
  await expect(toggle(page)).toHaveAttribute("data-mode", "full");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  expect(await page.locator('#fleet-rows td[data-col="country"]').allTextContents()).toEqual(full);
  for (let index = 0; index < addresses.length; index++) {
    await expect(cell(page, index).locator('button, a, [tabindex], [title], [data-info]')).toHaveCount(0);
    await expect(cell(page, index)).not.toHaveAttribute("title");
    expect(await cell(page, index).locator(".metadata-value").getAttribute("aria-label")).not.toContain("Open details");
  }
  await cell(page).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await toggle(page).focus();
  await page.keyboard.press("Space");
  expect(await page.locator('#fleet-rows td[data-col="country"]').allTextContents()).toEqual(compact);
  expect(dataRequests).toEqual(before);
  expect(metadataCalls).toBe(1);
});

test("Country sorts full names in both modes with stable unknowns last and persists its own setting", async ({ page }) => {
  await page.goto(await start());
  await ready(page);
  const before = [...dataRequests];
  const sort = page.getByRole("button", { name: "Sort by Country", exact: true });
  const ascending = [7, 1, 3, 2, 0, 4, 5, 6].map(index => addresses[index]);
  const descending = [4, 0, 2, 3, 1, 7, 5, 6].map(index => addresses[index]);
  await sort.click();
  expect(await order(page)).toEqual(ascending);
  await toggle(page).click();
  expect(await order(page)).toEqual(ascending);
  await sort.click();
  expect(await order(page)).toEqual(descending);
  expect(dataRequests).toEqual(before);
  expect(metadataCalls).toBe(1);
  expect(await page.evaluate(key => localStorage.getItem(key), preference)).toBe("full");
  await expect(page.locator("#system-display-toggle")).toHaveAttribute("data-mode", "compact");
  await page.reload();
  await expect(cell(page)).toHaveText("United States");
  await expect(toggle(page)).toHaveAttribute("data-mode", "full");
  await expect(page.locator("#system-display-toggle")).toHaveAttribute("data-mode", "compact");
  expect(await order(page)).toEqual(descending);
});

test("invalid or denied Country storage falls back to compact while the control remains usable", async ({ page }) => {
  await page.goto(await start());
  await ready(page);
  await page.evaluate(key => localStorage.setItem(key, "invalid"), preference);
  await page.reload();
  await ready(page);
  await expect(toggle(page)).toHaveAttribute("data-mode", "compact");
  await toggle(page).click();
  await expect(cell(page)).toHaveText("United States");
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Storage unavailable", "SecurityError"); } });
  });
  await page.reload();
  await ready(page);
  await expect(toggle(page)).toHaveAttribute("data-mode", "compact");
  const before = [...dataRequests];
  await toggle(page).click();
  await expect(cell(page)).toHaveText("United States");
  await toggle(page).click();
  await expect(cell(page)).toHaveText("US");
  expect(dataRequests).toEqual(before);
});

test("retained Country stays muted through display changes and recovers with new reported metadata", async ({ page }) => {
  await page.goto(await start(() => {
    const current = snapshot();
    if (metadataCalls === 2) return { hosts: current.hosts.map(host => ({ ...host,
      retained: true, error: "Synthetic metadata refresh unavailable.",
    })) };
    if (metadataCalls >= 3) current.hosts[0]!.values!.country = "CA";
    return current;
  }));
  await ready(page);
  await openPreviewTools(page);
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect(cell(page)).toHaveAttribute("data-metadata-state", "retained");
  await expect(cell(page).locator(".metadata-value")).toHaveCSS("color", "rgb(136, 136, 136)");
  await toggle(page).click();
  await expect(cell(page)).toHaveText("United States");
  await expect(cell(page).locator(".metadata-value")).toHaveClass(/metadata-retained/);
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect(cell(page)).toHaveText("Canada");
  await expect(cell(page)).toHaveAttribute("data-metadata-state", "reported");
  await expect(cell(page).locator(".metadata-value")).not.toHaveClass(/metadata-retained/);
});

test("free-form Country stays literal text without creating markup", async ({ page }) => {
  const literal = '<img src=x onerror="window.__countryInjected=true">';
  await page.goto(await start(() => {
    const current = snapshot();
    current.hosts[0]!.values!.country = literal;
    return current;
  }));
  await expect(cell(page)).toHaveText(literal);
  await toggle(page).click();
  await expect(cell(page)).toHaveText(literal);
  await expect(cell(page).locator("img, script")).toHaveCount(0);
  expect(await page.evaluate(() => "__countryInjected" in window)).toBe(false);
});

test.describe("Country touch controls", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  test("the final column and toggle remain reachable and plain on a phone", async ({ page }) => {
    await page.goto(await start());
    await ready(page);
    const before = [...dataRequests];
    const region = page.getByRole("region", { name: "Fleet table", exact: true });
    await region.evaluate(element => { element.scrollLeft = element.scrollWidth; });
    await expect(toggle(page)).toBeInViewport();
    await toggle(page).tap();
    await expect(cell(page)).toHaveText("United States");
    await expect(cell(page)).toBeInViewport();
    await cell(page).tap();
    await expect(page.getByRole("dialog")).toBeHidden();
    await page.getByRole("button", { name: "Sort by Country", exact: true }).tap();
    expect(await order(page)).toEqual([7, 1, 3, 2, 0, 4, 5, 6].map(index => addresses[index]));
    await toggle(page).tap();
    await expect(cell(page)).toHaveText("US");
    expect(dataRequests).toEqual(before);
    expect(metadataCalls).toBe(1);
    await expectFleetDocumentFlow(page);
  });
});
