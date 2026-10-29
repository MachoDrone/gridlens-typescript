import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { SYNTHETIC_HOST_ADDRESSES as addresses } from "../fixtures/host-addresses.ts";
import { emptyQueue } from "../fixtures/queue.ts";
import { emptySol } from "../fixtures/sol.ts";
import { emptyNos } from "../fixtures/nos.ts";
import { emptyStaking } from "../fixtures/staking.ts";
import { normalizeHostMetadata } from "../../src/fleet/host-metadata.ts";
import type { FleetResource, FleetSnapshots } from "../../src/contracts/fleet.ts";
import { openPreviewTools } from "./helpers.ts";
import { blankJobHistoryRecord } from "../../src/fleet/job-history.ts";

const checkedAt = Date.UTC(2026, 0, 1, 12);
const now = checkedAt + 3_600_000;
const host = addresses[0]!;

async function observations(): Promise<FleetSnapshots> {
  return {
    "job-history": { hosts: addresses.map(blankJobHistoryRecord) },
    metadata: { hosts: addresses.map(address => ({ address,
      values: normalizeHostMetadata(address, { nodeAddress: address, status: "PREMIUM" }),
      fetchedAtMs: checkedAt, retained: false, error: null, marketError: null })) },
    "node-info": { hosts: addresses.map(address => ({ address, values: { state: "RUNNING_JOB", dl: null, ul: null,
      ping: null, networkUnavailableReason: null }, fetchedAtMs: checkedAt, validUntilMs: checkedAt + 30_000,
      retained: false, error: null, apiCheck: { status: "online", checkedAtMs: checkedAt } })), nextRefreshAtMs: now + 30_000 },
    jobs: { hosts: addresses.map((address, index) => ({ address,
      job: { address: addresses[(index + 1) % addresses.length]!, node: address, state: "RUNNING",
        timeStart: checkedAt / 1_000 - 120, timeEnd: 0, timeout: 600 },
      checkedAtMs: checkedAt, validUntilMs: checkedAt + 180_000, failedAtMs: null,
      retained: false, pending: false, retryAtMs: null, error: null })), nextRefreshAtMs: now + 120_000 },
    queue: await emptyQueue(addresses), sol: await emptySol(addresses),
    nos: await emptyNos(addresses), staking: await emptyStaking(addresses),
  };
}

async function configure(page: Page, requests: string[], deniedRoster = false): Promise<void> {
  const snapshots = await observations();
  await page.clock.install({ time: now });
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (route.request().resourceType() === "document") {
      const response = await route.fetch();
      const body = (await response.text()).replace("<head>", `<head>
        <meta name="gridlens-api-base" content="/api/fleet">
        <meta name="gridlens-source-mode" content="snapshot">
        <meta name="gridlens-source-label" content="Local snapshot rehearsal">`);
      await route.fulfill({ response, body });
      return;
    }
    if (url.pathname.endsWith(".json")) requests.push(url.pathname + url.search);
    if (!url.pathname.startsWith("/api/fleet/")) { await route.continue(); return; }
    const resource = url.pathname.split("/").at(-1)!.replace(".json", "");
    if (resource === "connection") { await route.fulfill({ json: { status: "ok" } }); return; }
    if (resource === "hosts") {
      await route.fulfill(deniedRoster ? { status: 403, body: "private upstream diagnostic" }
        : { json: { addresses, error: null } });
      return;
    }
    await route.fulfill({ json: snapshots[resource as FleetResource] });
  });
}

test("one unchanged Fleet build reads a trusted backend prefix and preserves stale API/Duration after time away and reload", async ({ page }) => {
  const requests: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await configure(page, requests);
  // Synthetic query input cannot switch a hosted source into sample rows.
  await page.goto("/?scenario=mixed");
  const api = page.locator(`[data-host="${host}"] td[data-col="api"]`);
  const duration = page.locator(`[data-host="${host}"] td[data-col="duration"]`);
  await expect(page.locator('#fleet-rows tr[data-source="supplied"]')).toHaveCount(addresses.length);
  await expect(page.locator("#scenario")).toBeHidden();
  await expect(page.locator('#scenario option[value="mixed"]')).toHaveCount(0);
  await expect(api).toHaveText("Online");
  await expect(api).toHaveAttribute("data-api-current", "false");
  await expect(api).toHaveAttribute("data-api-checked-at", String(checkedAt));
  await expect(duration).toHaveAttribute("data-duration-freshness", "retained");
  await expect(duration).toHaveAttribute("data-job-checked-at", String(checkedAt));
  await expect(duration.getByRole("button")).toHaveAccessibleName(/1h 2m \/ 10m/);
  await openPreviewTools(page);
  await expect(page.locator("#data-label")).toHaveText("Local snapshot rehearsal");
  await expect(page.locator("#scenario-description")).not.toContainText("supplied file");
  await expect(page.locator("#preview-description")).toContainText("original source time");
  await expect(page.locator("#advance-time")).toBeHidden();
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect(api).toHaveAttribute("data-api-checked-at", String(checkedAt));
  await expect(duration).toHaveAttribute("data-job-checked-at", String(checkedAt));
  await page.reload();
  await expect(api).toHaveAttribute("data-api-current", "false");
  await expect(duration).toHaveAttribute("data-duration-freshness", "retained");
  await expect(duration).toHaveAttribute("data-job-checked-at", String(checkedAt));
  await expect(page.locator("#fleet-connection")).toHaveAttribute("data-connection-state", "connected");
  expect(requests.length).toBeGreaterThanOrEqual(9);
  expect(requests.every(path => path.startsWith("/api/fleet/") && !path.includes("scenario="))).toBe(true);
  expect(errors).toEqual([]);
});

test("a denied hosted roster stays empty with a session explanation even while the service responds", async ({ page }) => {
  const requests: string[] = [];
  await configure(page, requests, true);
  await page.goto("/?scenario=real200");
  await expect(page.locator("#input-error")).toContainText("not authorized");
  await expect(page.locator("#input-error")).not.toContainText("private upstream diagnostic");
  await expect(page.locator('#fleet-rows tr[data-host]')).toHaveCount(0);
  await expect(page.locator("#fleet-connection")).toHaveAttribute("data-connection-state", "connected");
  expect(requests).toEqual(expect.arrayContaining(["/api/fleet/hosts.json", "/api/fleet/connection.json"]));
  expect(requests.some(path => /(?:metadata|jobs|sol)\.json/.test(path))).toBe(false);
});

test("Refresh view explicitly retries a failed initial hosted roster once without polling or replacing a successful roster", async ({ page }) => {
  const requests: string[] = [];
  await configure(page, requests);
  let rosterReads = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/fleet/hosts.json", async route => {
    requests.push("/api/fleet/hosts.json");
    if (++rosterReads === 1) {
      await route.fulfill({ status: 503, json: { addresses: [], error: "Fleet source is temporarily unavailable." } });
      return;
    }
    await held;
    await route.fulfill({ json: { addresses, error: null } });
  });
  await page.goto("/");
  await expect(page.locator("#input-error")).toContainText("temporarily unavailable");
  await expect(page.locator('#fleet-rows tr[data-host]')).toHaveCount(0);
  await page.clock.fastForward(60_000);
  expect(rosterReads).toBe(1);
  expect(requests.every(path => /\/(?:hosts|connection)\.json$/.test(path))).toBe(true);
  await openPreviewTools(page);
  const refresh = page.getByRole("button", { name: "Refresh view", exact: true });
  await refresh.click();
  await expect.poll(() => rosterReads).toBe(2);
  await refresh.click();
  expect(rosterReads).toBe(2);
  expect(requests.every(path => /\/(?:hosts|connection)\.json$/.test(path))).toBe(true);
  release();
  await expect(page.locator('#fleet-rows tr[data-source="supplied"]')).toHaveCount(addresses.length);
  await expect(page.locator(`[data-host="${host}"] td[data-col="api"]`)).toHaveText("Online");
  await expect(page.locator("#input-error")).toBeHidden();
  expect(requests).toContain("/api/fleet/jobs.json");
  await refresh.click();
  await page.clock.fastForward(60_000);
  expect(rosterReads, "successful roster identity remains immutable through manual and scheduled value refreshes").toBe(2);
});
