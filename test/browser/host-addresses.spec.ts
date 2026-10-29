import { expectFleetDocumentFlow, openPreviewTools } from "./helpers.ts";
import { emptyStaking } from "../fixtures/staking.ts";
import { emptyNos } from "../fixtures/nos.ts";
import { emptySol } from "../fixtures/sol.ts";
import { emptyQueue } from "../fixtures/queue.ts";
import { emptyJobs } from "../fixtures/jobs.ts";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPreviewServer } from "../../scripts/preview-server.ts";
import { ASCENDING_HOST_ADDRESSES, SYNTHETIC_HOST_ADDRESSES } from "../fixtures/host-addresses.ts";

const allowedOrigins = new Set<string>();
const unexpectedRequests: string[] = [];
const browserErrors: string[] = [];
const historyRequests: string[] = [];
const servers: Server[] = [];
const directories: string[] = [];
let expectUnavailableInput = false;

test.beforeEach(async ({ context, page }) => {
  allowedOrigins.clear();
  allowedOrigins.add("http://127.0.0.1:4174");
  unexpectedRequests.length = 0;
  browserErrors.length = 0;
  historyRequests.length = 0;
  expectUnavailableInput = false;
  await context.route("**/*", route => {
    if (new URL(route.request().url()).pathname === "/preview/job-history.json") historyRequests.push(route.request().url());
    if (!allowedOrigins.has(new URL(route.request().url()).origin)) {
      unexpectedRequests.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("console", message => {
    if (message.type() !== "error") return;
    if (expectUnavailableInput && /Failed to load resource:.*503/.test(message.text())) return;
    browserErrors.push(message.text());
  });
});

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test.afterEach(async ({ page }) => {
  // End browser polling before closing its isolated provider server.
  await page.close();
  for (const server of servers.splice(0)) await closeServer(server);
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  expect(unexpectedRequests, "Supplied addresses must cause no external automatic requests").toEqual([]);
  expect(browserErrors, "No unexpected browser runtime or loading errors").toEqual([]);
});

async function startIsolatedServer(hostsFile: string): Promise<{ server: Server; origin: string }> {
  const server = await startPreviewServer({ stakingProvider: emptyStaking, nosProvider: emptyNos, solProvider: emptySol, queueProvider: emptyQueue, jobProvider: emptyJobs,
    hostsFile, port: 0,
    metadataProvider: async addresses => ({ hosts: addresses.map(address => ({
      address, values: null, fetchedAtMs: null, retained: false,
      error: null, marketError: null,
    })) }),
    nodeInfoProvider: async addresses => ({ hosts: addresses.map(address => ({
      address, values: null, fetchedAtMs: null, validUntilMs: null,
      retained: false, error: null,
    })) }),
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server port");
  const origin = `http://127.0.0.1:${address.port}`;
  allowedOrigins.add(origin);
  return { server, origin };
}

async function isolatedFile(contents: string | null): Promise<{ path: string; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-input-browser-"));
  directories.push(directory);
  const path = join(directory, "hosts.json");
  if (contents !== null) await writeFile(path, contents);
  return { path, directory };
}

async function addresses(page: Page): Promise<string[]> {
  return page.locator("#fleet-rows [data-host]").evaluateAll(rows => rows.map(row => row.getAttribute("data-host") ?? ""));
}

test("the default supplied file renders eight Explorer links and leaves every other field unknown", async ({ page }, info) => {
  await page.goto("/");
  await openPreviewTools(page);
  await expect(page.getByLabel("Scenario", { exact: true })).toHaveValue("supplied");
  await expect(page.locator("#host-count")).toHaveText("8 hosts");
  await expect(page.locator("#input-error")).toBeHidden();
  await expect(page.getByText("Sample data", { exact: true })).toBeHidden();
  expect(await addresses(page)).toEqual(SYNTHETIC_HOST_ADDRESSES);
  await expect(page.locator("#column-headings th[data-col]")).toHaveCount(28);
  await expect(page.locator('#fleet-rows [data-source="supplied"]')).toHaveCount(8);
  for (const address of SYNTHETIC_HOST_ADDRESSES) {
    const row = page.locator(`#fleet-rows [data-host="${address}"]`);
    await expect(row.locator("td[data-col]")).toHaveCount(28);
    expect(await row.locator('td[data-col]:not([data-col="hostAddress"]):not([data-col="api"]):not([data-col="state"]):not([data-col="duration"]):not([data-col="latestJob"])').allTextContents()).toEqual(Array(23).fill("—"));
    await expect(row.locator('.job-summary-link')).toHaveText("—");
    await expect(row.locator('.job-summary-link')).not.toHaveAttribute("href");
    await expect(row.locator('.job-summary-state')).toHaveText("Unknown");
    await expect(row.locator('.jobs-expand')).toHaveAttribute("aria-expanded", "false");
    await expect(row.locator('td[data-col="api"]')).toHaveText("Populating..");
    const state = row.locator('td[data-col="state"]');
    await expect(state.locator(".state-unknown .state-dots")).toBeVisible();
    await expect(state).toHaveAttribute("data-state", "unknown");
    await expect(state).toHaveAttribute("data-state-current", "false");
    await expect(state.getByRole("button")).toHaveAccessibleName(/unknown/);
    await expect(row.locator('td[data-col="duration"]')).toHaveText("Populating..");
    const link = row.getByRole("link", { name: new RegExp(address) });
    await expect(link).toHaveText(address.slice(0, 5));
    await expect(link).toHaveAttribute("href", `https://explore.nosana.com/hosts/${address}`);
    await expect(link).toHaveAttribute("title", address);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(await row.evaluate(element => element.getBoundingClientRect().height)).toBe(34);
  }
  const firstAddress = SYNTHETIC_HOST_ADDRESSES[0]!;
  const firstLink = page.getByRole("link", { name: new RegExp(firstAddress) });
  await firstLink.focus();
  await expect(firstLink).toBeFocused();
  await expectFleetDocumentFlow(page);
  const lastRow = await page.locator("#fleet-rows tr").last().boundingBox();
  const controls = await page.getByLabel("Scenario", { exact: true }).boundingBox();
  expect(controls?.y).toBeGreaterThan((lastRow?.y ?? 0) + (lastRow?.height ?? 0));
  expect(historyRequests, "Collapsed rows do not request job history").toEqual([]);
  await page.screenshot({ path: info.outputPath("supplied-host-addresses.png"), fullPage: true });
});

test("Host Address sorts complete identities despite colliding short labels and preserves input order for unknowns", async ({ page }) => {
  await page.goto("/");
  await openPreviewTools(page);
  await expect(page.locator("#host-count")).toHaveText("8 hosts");
  expect(new Set(await page.locator('#fleet-rows td[data-col="hostAddress"]').allTextContents()).size).toBe(1);
  const sort = page.getByRole("button", { name: "Sort by Host Address", exact: true });
  await sort.focus();
  await page.keyboard.press("Enter");
  expect(await addresses(page)).toEqual(ASCENDING_HOST_ADDRESSES);
  await expect(page.locator('#column-headings th[data-col="hostAddress"]')).toHaveAttribute("aria-sort", "ascending");
  await page.keyboard.press("Space");
  expect(await addresses(page)).toEqual([...ASCENDING_HOST_ADDRESSES].reverse());
  await page.reload();
  await openPreviewTools(page);
  await expect(page.locator("#host-count")).toHaveText("8 hosts");
  expect(await addresses(page)).toEqual([...ASCENDING_HOST_ADDRESSES].reverse());
  await page.getByRole("button", { name: "Sort by SOL", exact: true }).click();
  expect(await addresses(page)).toEqual(SYNTHETIC_HOST_ADDRESSES);
  await page.getByRole("button", { name: "Sort by SOL", exact: true }).click();
  expect(await addresses(page)).toEqual(SYNTHETIC_HOST_ADDRESSES);
  await sort.click();
  await page.getByRole("button", { name: "Clear sort", exact: true }).click();
  expect(await addresses(page)).toEqual(SYNTHETIC_HOST_ADDRESSES);
});

test("supplied addresses stay separate from samples and refresh never reloads or polls the input", async ({ page }) => {
  const inputRequests: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname === "/preview/hosts.json") inputRequests.push(request.url()); });
  await page.clock.install();
  await page.goto("/");
  await openPreviewTools(page);
  await expect(page.locator("#host-count")).toHaveText("8 hosts");
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await page.getByRole("button", { name: "Toggle IP display", exact: true }).click();
  await page.getByRole("button", { name: "Toggle Market display", exact: true }).click();
  expect(await page.locator('#fleet-rows td[data-col="ip"]').allTextContents()).toEqual(Array(8).fill("—"));
  expect(await page.locator('#fleet-rows td[data-col="market"]').allTextContents()).toEqual(Array(8).fill("—"));
  await page.getByLabel("Scenario", { exact: true }).selectOption("mixed");
  await expect(page.locator("#host-count")).toHaveText("6 hosts");
  await expect(page.getByText("Sample data", { exact: true })).toBeVisible();
  await expect(page.locator('#fleet-rows [data-source="supplied"]')).toHaveCount(0);
  await expect(page.locator('#fleet-rows td[data-col="hostAddress"] a')).toHaveCount(0);
  await page.getByLabel("Scenario", { exact: true }).selectOption("scale");
  await expect(page.locator("#fleet-rows [data-host]")).toHaveCount(200);
  await page.getByLabel("Scenario", { exact: true }).selectOption("supplied");
  await expect(page.locator("#host-count")).toHaveText("8 hosts");
  expect(await addresses(page)).toEqual(SYNTHETIC_HOST_ADDRESSES);
  await expect(page.getByText("Sample data", { exact: true })).toBeHidden();
  expect(await page.locator('#fleet-rows td[data-col]:not([data-col="hostAddress"]):not([data-col="api"]):not([data-col="state"]):not([data-col="duration"]):not([data-col="latestJob"])').allTextContents()).toEqual(Array(8 * 23).fill("—"));
  await expect(page.locator('.job-summary-link')).toHaveText(Array(8).fill("—"));
  await expect(page.locator('.job-summary-state')).toHaveText(Array(8).fill("Unknown"));
  const unknownStates = page.locator('#fleet-rows td[data-col="state"][data-state="unknown"][data-state-current="false"]');
  await expect(unknownStates.locator(".state-unknown .state-dots")).toHaveCount(8);
  await expect(unknownStates.getByRole("button", { name: /unknown/ })).toHaveCount(8);
  await expect(page.locator('#fleet-rows td[data-col="duration"]')).toHaveText(Array(8).fill("Populating.."));
  await page.clock.fastForward(300_000);
  expect(inputRequests).toHaveLength(1);
  expect(historyRequests, "Refreshing or switching scenarios does not request collapsed job history").toEqual([]);
});

for (const input of [
  { name: "missing", contents: null, error: /missing|ENOENT/i },
  { name: "invalid", contents: "{broken json", error: /invalid JSON/i },
]) {
  test(`${input.name} input gives an actionable error, without creating or replacing the file`, async ({ page }) => {
    const file = await isolatedFile(input.contents);
    const { origin } = await startIsolatedServer(file.path);
    expectUnavailableInput = true;
    await page.goto(origin);
    await openPreviewTools(page);
    const error = page.locator("#input-error");
    await expect(error).toHaveAttribute("role", "alert");
    await expect(error).toBeVisible();
    await expect(error).toContainText(input.error);
    await expect(error).toContainText("restart");
    await expect(page.locator("#fleet-rows [data-host]")).toHaveCount(0);
    await page.getByRole("button", { name: "Refresh view", exact: true }).click();
    await page.getByLabel("Scenario", { exact: true }).selectOption("mixed");
    await expect(error).toBeHidden();
    await expect(page.locator("#host-count")).toHaveText("6 hosts");
    await page.getByLabel("Scenario", { exact: true }).selectOption("supplied");
    await expect(error).toBeVisible();
    await expect(page.locator("#fleet-rows [data-host]")).toHaveCount(0);
    if (input.contents === null) {
      await expect(stat(file.path)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(await readFile(file.path, "utf8")).toBe(input.contents);
    }
  });
}

test("an intentionally empty list is distinct from invalid input", async ({ page }) => {
  const file = await isolatedFile("[]\n");
  const { origin } = await startIsolatedServer(file.path);
  await page.goto(origin);
  await openPreviewTools(page);
  await expect(page.locator("#host-count")).toHaveText("0 hosts");
  await expect(page.locator("#input-error")).toBeHidden();
  await expect(page.locator("#fleet-rows [data-host]")).toHaveCount(0);
  expect(await readFile(file.path, "utf8")).toBe("[]\n");
});

test("external edits take effect only after server restart and preserve the separate backup", async ({ page }) => {
  const original = JSON.stringify(SYNTHETIC_HOST_ADDRESSES, null, 2) + "\n";
  const file = await isolatedFile(original);
  const backup = join(file.directory, "hosts.json.backup");
  await writeFile(backup, original);
  const started = await startIsolatedServer(file.path);
  await page.goto(started.origin);
  await openPreviewTools(page);
  await expect(page.locator("#host-count")).toHaveText("8 hosts");
  const edited = JSON.stringify([SYNTHETIC_HOST_ADDRESSES[3]], null, 2) + "\n";
  await writeFile(file.path, edited);
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await page.reload();
  await openPreviewTools(page);
  await expect(page.locator("#host-count")).toHaveText("8 hosts");
  await closeServer(started.server);
  const restarted = await startIsolatedServer(file.path);
  await page.goto(restarted.origin);
  await openPreviewTools(page);
  await expect(page.locator("#host-count")).toHaveText("1 host");
  expect(await addresses(page)).toEqual([SYNTHETIC_HOST_ADDRESSES[3]]);
  expect(await readFile(file.path, "utf8")).toBe(edited);
  expect(await readFile(backup, "utf8")).toBe(original);
});
