import { openPreviewTools } from "./helpers.ts";
import { emptyStaking } from "../fixtures/staking.ts";
import { emptyNos } from "../fixtures/nos.ts";
import { emptySol } from "../fixtures/sol.ts";
import { emptyQueue } from "../fixtures/queue.ts";
import { expect, test } from "@playwright/test";
import type { JSHandle, Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPreviewServer } from "../../scripts/preview-server.ts";
import type { JobRecord, JobSnapshot } from "../../src/fleet/jobs.ts";
import type { NodeInfoSnapshot } from "../../src/fleet/node-info.ts";
import { SYNTHETIC_HOST_ADDRESSES } from "../fixtures/host-addresses.ts";

const addresses = SYNTHETIC_HOST_ADDRESSES;
const NOW = Date.UTC(2026, 0, 1, 12);
let responseTime = NOW;
// Another artificial address from the fixture byte range, outside its eight jobs.
const replacementJob = addresses[0]!.slice(0, -1) + "t";
const servers: Server[] = [];
const directories: string[] = [];
let origin = "";
let jobRequests = 0;
let stateRequests = 0;
const errors: string[] = [];
const externalRequests: string[] = [];

function reading(index: number, at = NOW, elapsed = 120, limit = 600): JobRecord {
  return {
    address: addresses[index]!,
    job: { address: addresses[(index + 1) % addresses.length]!, node: addresses[index]!, state: "RUNNING",
      timeStart: (NOW - elapsed * 1000) / 1000, timeEnd: 0, timeout: limit },
    checkedAtMs: at, validUntilMs: at + 180_000, failedAtMs: null,
    retained: false, pending: false, retryAtMs: null, error: null,
  };
}

function snapshot(at = NOW): JobSnapshot {
  return { hosts: addresses.map((_address, index) => reading(index, at, [120, 960, 0, 90, 300, 30, 50, 600][index])) };
}

async function noState(input: readonly string[]): Promise<NodeInfoSnapshot> {
  return { hosts: input.map(address => ({
    address, values: null, fetchedAtMs: null, validUntilMs: null, retained: false, error: null,
  })) };
}

async function start(provider: () => Promise<JobSnapshot>, nodeInfoProvider = noState): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-duration-browser-"));
  directories.push(directory);
  const hostsFile = join(directory, "hosts.json");
  await writeFile(hostsFile, JSON.stringify(addresses));
  const server = await startPreviewServer({ now: () => responseTime, stakingProvider: emptyStaking, nosProvider: emptyNos, solProvider: emptySol, queueProvider: emptyQueue,
    hostsFile, port: 0, jobProvider: provider, nodeInfoProvider,
    metadataProvider: async input => ({ hosts: input.map(address => ({
      address, values: null, fetchedAtMs: null, retained: false, error: null, marketError: null,
    })) }),
  });
  servers.push(server);
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("Missing isolated port");
  origin = `http://127.0.0.1:${bound.port}`;
  return origin;
}

function cell(page: Page, index = 0) {
  return page.locator(`#fleet-rows [data-host="${addresses[index]}"] td[data-col="duration"]`);
}

function durationSource(page: Page, index = 0) {
  return page.locator(`#fleet-rows [data-host="${addresses[index]}"] .queued-duration-source[data-source="duration"]`);
}

async function visibility(page: Page, state: "visible" | "hidden"): Promise<void> {
  await page.evaluate(value => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => value === "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
  if (state === "visible") await page.clock.runFor(1);
}

interface KeptDuration {
  button: Element;
  track: Element;
  fill: Element;
  animation: Animation | undefined;
}

async function keepDuration(page: Page, index = 0): Promise<JSHandle<KeptDuration>> {
  return durationSource(page, index).evaluateHandle(element => {
    const button = element.querySelector("button")!;
    const track = button.querySelector(".duration-track")!;
    const fill = track.querySelector(".duration-fill")!;
    return { button, track, fill, animation: fill.getAnimations({ subtree: true })[0] };
  });
}

async function expectKept(saved: JSHandle<KeptDuration>, animation = true): Promise<void> {
  expect(await saved.evaluate(kept => kept.button.isConnected && kept.track.isConnected && kept.fill.isConnected)).toBe(true);
  if (animation) expect(await saved.evaluate(kept => kept.animation !== undefined && kept.fill.getAnimations({ subtree: true }).includes(kept.animation))).toBe(true);
}

test.beforeEach(async ({ page, context }) => {
  origin = "";
  jobRequests = 0;
  stateRequests = 0;
  errors.length = 0;
  externalRequests.length = 0;
  await page.clock.install({ time: NOW });
  await page.clock.pauseAt(NOW);
  await context.route("**/*", async route => {
    if (new URL(route.request().url()).origin !== origin) {
      externalRequests.push(route.request().url());
      return route.abort();
    }
    // Preserve the fixture clock through reloads after simulated elapsed time.
    if (new URL(route.request().url()).pathname.startsWith("/preview/")) responseTime = await page.evaluate(() => Date.now());
    return route.continue();
  });
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path === "/preview/jobs.json") jobRequests++;
    if (path === "/preview/node-info.json") stateRequests++;
  });
});

test.afterEach(async ({ page }) => {
  // End browser polling before closing its isolated provider server.
  await page.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  expect(errors).toEqual([]);
  expect(externalRequests, "All Duration providers must remain isolated").toEqual([]);
});

test("live clock ticks locally, preserves numeric sort and saved toggle, and shows the taller red overrun", async ({ page }) => {
  let calls = 0;
  await page.goto(await start(async () => { calls++; return snapshot(); }));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveAttribute("data-duration-tone", "current");
  await expect(cell(page).locator(".duration-track")).toHaveCSS("height", "8px");
  await expect(cell(page, 1).locator(".duration-track")).toHaveCSS("height", "12px");
  await expect(cell(page, 1).locator(".duration-fill")).toHaveCSS("background-color", "rgb(239, 68, 68)");
  await expect(cell(page).getByRole("button")).toHaveAccessibleName(/2m \/ 10m/);
  await page.clock.runFor(1_000);
  await expect(cell(page).getByRole("button")).toHaveAccessibleName(/2m 1s \/ 10m/);
  expect(calls).toBe(1);
  await page.getByRole("button", { name: "Toggle Duration display", exact: true }).click();
  await expect(cell(page)).toHaveText("2m 1s / 10m");
  await page.getByRole("button", { name: "Sort by Duration", exact: true }).click();
  const order = await page.locator('#fleet-rows [data-source="supplied"]').evaluateAll(rows => rows.map(row => row.getAttribute("data-host")));
  expect(order).toEqual([2, 5, 6, 3, 0, 4, 7, 1].map(index => addresses[index]));
  await page.clock.runFor(1_000);
  await expect(cell(page)).toHaveText("2m 2s / 10m");
  await cell(page).getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText(addresses[1]!);
  await expect(page.getByRole("dialog")).toContainText("2026-01-01T12:00:00.000Z");
  await expect(page.getByRole("dialog")).toContainText("indexing-freshness timestamp");
  await page.keyboard.press("Escape");
  await page.reload();
  await openPreviewTools(page);
  await expect(page.locator("#duration-display-toggle")).toHaveAttribute("data-mode", "text");
  await expect(cell(page)).toHaveText("2m 2s / 10m");
});

test("similar Host Addresses get staggered glare phases that survive refresh, sorting and bar recreation", async ({ page }) => {
  let calls = 0;
  await page.goto(await start(async () => { calls++; return snapshot(); }));
  await openPreviewTools(page);
  await expect(page.locator("#fleet-rows .duration-fill")).toHaveCount(addresses.length);
  const phases = () => page.locator('#fleet-rows [data-source="supplied"]').evaluateAll(rows =>
    Object.fromEntries<number>(rows.map(row => [row.getAttribute("data-host")!,
      -Number.parseFloat((row.querySelector(".duration-fill") as HTMLElement).style.getPropertyValue("--duration-delay")),
    ])),
  );
  const initial = await phases();
  const values = Object.values(initial);
  expect(values.every(value => Number.isFinite(value) && value >= 0 && value < 10_000)).toBe(true);
  // These artificial addresses differ only in their suffix. A plain modulo
  // string hash put their glints milliseconds apart, making them look unified.
  expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(5_000);
  expect(new Set(values.map(value => Math.floor(value / 1_000))).size).toBeGreaterThanOrEqual(4);

  const saved = await keepDuration(page);
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect.poll(() => calls).toBe(2);
  expect(await phases()).toEqual(initial);
  await expectKept(saved);
  await page.getByRole("button", { name: "Sort by Duration", exact: true }).click();
  expect(await phases()).toEqual(initial);
  await expectKept(saved);
  await page.getByRole("button", { name: "Toggle Duration display", exact: true }).click();
  await expect(page.locator("#fleet-rows .duration-fill")).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle Duration display", exact: true }).click();
  expect(await phases()).toEqual(initial);
  for (const mode of ["off", "system", "on"]) {
    await page.getByLabel("Duration animation", { exact: true }).selectOption(mode);
    expect(await phases()).toEqual(initial);
  }
  expect(calls, "Sorting, display and motion changes must not request job data").toBe(2);
  await page.reload();
  await openPreviewTools(page);
  await expect(page.locator("#fleet-rows .duration-fill")).toHaveCount(addresses.length);
  expect(await phases()).toEqual(initial);
});

test("independent 120-second refresh and local ticks preserve connected bars, focus and dialog targets", async ({ page }) => {
  let calls = 0;
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(await start(async () => { calls++; return snapshot(await page.evaluate(() => Date.now())); }));
  await openPreviewTools(page);
  await expect(cell(page).locator(".duration-active")).toHaveCount(1);
  const saved = await keepDuration(page);
  await cell(page).getByRole("button").focus();
  await page.clock.runFor(1_000);
  await expect(cell(page).getByRole("button")).toBeFocused();
  await expectKept(saved);
  await page.keyboard.press("Enter");
  await page.clock.fastForward(19_000);
  expect(calls).toBe(1);
  await expect.poll(() => stateRequests).toBeGreaterThanOrEqual(2);
  await expectKept(saved);
  await page.clock.fastForward(100_000);
  await expect.poll(() => calls).toBe(2);
  await expectKept(saved);
  await page.keyboard.press("Escape");
  await expect(cell(page).getByRole("button")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toContainText("4m / 10m");
  await expect(page.getByRole("dialog")).toContainText("2026-01-01T12:02:00.000Z");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Sort by Duration", exact: true }).click();
  await expectKept(saved);
  expect(jobRequests).toBe(2);
});

test("replacement resets elapsed, timeout extensions apply, and completion clears the old assignment", async ({ page }) => {
  let calls = 0;
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(await start(async () => {
    const at = await page.evaluate(() => Date.now());
    const result = snapshot(at);
    calls++;
    const first = result.hosts[0]!;
    if (calls === 2) first.job!.timeout = 1_200;
    if (calls === 3) first.job = { ...first.job!, address: replacementJob, timeStart: at / 1000 - 5 };
    if (calls >= 4) first.job = { ...first.job!, state: "COMPLETED", timeEnd: at / 1000 };
    return result;
  }));
  await openPreviewTools(page);
  await expect(cell(page).getByRole("button")).toHaveAccessibleName(/2m \/ 10m/);
  const saved = await keepDuration(page);
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect(cell(page).getByRole("button")).toHaveAccessibleName(/2m \/ 20m/);
  await expectKept(saved);
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect(cell(page)).toHaveAttribute("data-job-address", replacementJob);
  await expect(cell(page).getByRole("button")).toHaveAccessibleName(/5s \/ 10m/);
  await expectKept(saved);
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect(cell(page)).toHaveText("—");
  await expect(cell(page).locator(".duration-active")).toHaveCount(0);
  expect(await saved.evaluate(kept => kept.button.isConnected)).toBe(true);
  await cell(page).getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText(/No running assignment|assignment ended/i);
});

test("failed and expired timing keeps ticking with dim colors, original evidence and connected animation", async ({ page }) => {
  let calls = 0;
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(await start(async () => {
    calls++;
    const result = snapshot();
    if (calls >= 2) result.hosts[0] = { ...result.hosts[0]!, retained: true, error: "Job batch unavailable (HTTP 503).", failedAtMs: NOW + 10_000 };
    return result;
  }));
  await openPreviewTools(page);
  await expect(cell(page).locator(".duration-active")).toHaveCount(1);
  const failed = await keepDuration(page);
  const expired = await keepDuration(page, 1);
  await page.clock.fastForward(10_000);
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect(cell(page)).toHaveAttribute("data-duration-freshness", "retained");
  await expect(cell(page).getByRole("button")).toHaveAccessibleName(/2m 10s \/ 10m/);
  await expect(cell(page).getByRole("button")).toHaveAccessibleName(/stale estimate/i);
  await expect(cell(page).locator(".duration-fill")).toHaveCSS("background-color", "rgb(40, 122, 71)");
  await page.clock.fastForward(20_000);
  await expect(cell(page).getByRole("button")).toHaveAccessibleName(/2m 30s \/ 10m/);
  await expectKept(failed);
  await page.clock.fastForward(90_000);
  await expect.poll(() => calls).toBe(3);
  await expect(cell(page)).toHaveAttribute("data-duration-freshness", "retained");
  await page.clock.fastForward(60_000);
  await expect(cell(page, 1)).toHaveAttribute("data-duration-freshness", "retained");
  await expect(cell(page).getByRole("button")).toHaveAccessibleName(/5m \/ 10m/);
  await expect(cell(page, 1).getByRole("button")).toHaveAccessibleName(/19m \/ 10m/);
  await expect(cell(page, 1)).toHaveAttribute("data-duration-tone", "exceeded");
  await expect(cell(page, 1).locator(".duration-fill")).toHaveCSS("background-color", "rgb(150, 48, 48)");
  await expectKept(expired);
  await page.clock.fastForward(5_000);
  await expect(cell(page).getByRole("button")).toHaveAccessibleName(/5m 5s \/ 10m/);
  await expect(cell(page).locator(".duration-active")).toHaveCount(1);
  await cell(page).getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText(addresses[1]!);
  await expect(page.getByRole("dialog")).toContainText("2026-01-01T12:00:00.000Z");
  await expect(page.getByRole("dialog")).toContainText(/stale estimate/i);
});

test("mismatched identities reject new timing while the last verified assignment keeps ticking", async ({ page }) => {
  let calls = 0;
  await page.goto(await start(async () => {
    const result = snapshot();
    calls++;
    if (calls === 2) result.hosts[0]!.job!.node = addresses[7]!;
    if (calls > 2) result.hosts[0]!.job!.address = result.hosts[1]!.job!.address;
    return result;
  }));
  await openPreviewTools(page);
  await expect(cell(page).getByRole("button")).toHaveAccessibleName(/2m \/ 10m/);
  await page.clock.fastForward(5_000);
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect(page.locator("#jobs-status")).toContainText("Job refresh failed");
  await expect(cell(page).getByRole("button")).toHaveAccessibleName(/2m 5s \/ 10m/);
  await page.clock.fastForward(10_000);
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect.poll(() => calls).toBe(3);
  await expect(cell(page).getByRole("button")).toHaveAccessibleName(/2m 15s \/ 10m/);
  await expect(cell(page)).toHaveAttribute("data-duration-freshness", "retained");
  await expect(cell(page)).toHaveAttribute("data-job-address", addresses[1]!);
});

test("pending budgets stay visible, respect retry times, and hidden/synthetic views pause and resume reads", async ({ page }) => {
  let calls = 0;
  await page.goto(await start(async () => {
    calls++;
    const at = await page.evaluate(() => Date.now());
    const result = snapshot(at);
    if (calls === 1) result.hosts[0] = {
      ...result.hosts[0]!, job: null, checkedAtMs: null, validUntilMs: null,
      pending: true, retryAtMs: NOW + 60_000, error: "Local request budget; lookup pending.",
    };
    return result;
  }));
  await openPreviewTools(page);
  await expect(page.locator("#jobs-status")).toContainText("1 lookups pending");
  await cell(page).getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText("lookup pending");
  await page.keyboard.press("Escape");
  await page.clock.fastForward(59_000);
  expect(calls).toBe(1);
  await page.clock.fastForward(1_000);
  await expect.poll(() => calls).toBe(2);
  await visibility(page, "hidden");
  await page.clock.fastForward(200_000);
  expect(calls).toBe(2);
  await visibility(page, "visible");
  await expect.poll(() => calls).toBe(3);
  await page.getByLabel("Scenario", { exact: true }).selectOption("durations");
  await expect(page.locator("#jobs-status")).toBeHidden();
  await page.clock.fastForward(130_000);
  expect(calls).toBe(3);
  await page.getByLabel("Scenario", { exact: true }).selectOption("supplied");
  await page.clock.runFor(1);
  await expect.poll(() => calls).toBe(4);
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await page.clock.fastForward(130_000);
  expect(calls).toBe(4);
});

for (const combined of [false, true]) {
  test(`confirmed API Offline uses an unavailable dash without hiding job timing (${combined ? "combined" : "separate"})`, async ({ page }) => {
    let recovered = false;
    let calls = 0;
    await page.addInitScript(value => localStorage.setItem("gridlens.preview.queued-duration-layout.v1", value),
      combined ? "combined" : "separate");
    await page.goto(await start(async () => {
      calls++;
      const result = snapshot();
      result.hosts[0] = { ...result.hosts[0]!, job: null, checkedAtMs: null, validUntilMs: null,
        pending: true, retryAtMs: NOW + 3_600_000 };
      result.hosts[1] = { ...result.hosts[1]!, job: null };
      result.hosts[3] = { ...result.hosts[3]!, retained: true, error: "Synthetic job refresh failed.", failedAtMs: NOW };
      result.nextRefreshAtMs = NOW + 3_600_000;
      return result;
    }, async input => ({ hosts: input.map(address => ({
      address, values: null, fetchedAtMs: null, validUntilMs: null, retained: false,
      error: recovered ? null : "Synthetic HTTP 503 confirmation.",
      apiCheck: recovered ? { status: "online" as const, checkedAtMs: responseTime }
        : { status: "offline" as const, checkedAtMs: NOW, firstFailedAtMs: NOW - 1_000,
          failureKind: "http" as const, httpStatus: 503, nextCheckAtMs: NOW + 900_000 },
    })) })));
    await expect(durationSource(page)).toHaveText("—");
    await expect(cell(page)).toHaveAttribute("data-duration-unavailable-reason", "api-offline");
    await expect(cell(page)).toHaveAttribute("data-duration-freshness", "unknown");
    await expect(durationSource(page).getByRole("button")).toHaveAccessibleName(/timing unavailable while API is Offline/i);
    await expect(durationSource(page, 1)).toHaveText("—");
    await expect(cell(page, 1)).toHaveAttribute("data-duration-unavailable-reason", "");
    await expect(cell(page, 2)).toHaveAttribute("data-duration-freshness", "current");
    await expect(cell(page, 3)).toHaveAttribute("data-duration-freshness", "retained");
    const kept = await keepDuration(page, 2);
    await durationSource(page).getByRole("button").click();
    await expect(page.locator(combined ? ".info-facts" : ".info-summary")).toContainText("timing unavailable while API is Offline");
    await expect(page.locator(".info-source-body")).toContainText(new Date(NOW).toISOString());
    await expect(page.locator("#info-body")).not.toContainText("Current evidence confirms no running timing");
    await page.keyboard.press("Escape");
    await page.clock.fastForward(180_000);
    await expect(durationSource(page)).toHaveText("—");
    await expect(durationSource(page, 1)).toHaveText("—");
    await expect(cell(page, 1)).toHaveAttribute("data-duration-unavailable-reason", "api-offline");
    await expect(cell(page, 2)).toHaveAttribute("data-duration-freshness", "retained");
    await expectKept(kept, false);
    expect(calls, "Offline presentation and absence expiry must not change discovery deadlines").toBe(1);
    await page.clock.fastForward(728_000);
    await expect(durationSource(page)).toHaveText("Populating..");
    await expect(cell(page)).toHaveAttribute("data-duration-unavailable-reason", "");
    await expect(page.locator(`#fleet-rows [data-host="${addresses[0]}"] td[data-col="api"]`)).toHaveAttribute("data-api-current", "false");
    expect(calls).toBe(1);
    recovered = true;
    await page.clock.fastForward(20_000);
    await expect(page.locator(`#fleet-rows [data-host="${addresses[0]}"] td[data-col="api"]`)).toHaveText("Online");
    await expect(durationSource(page)).toHaveText("Populating..");
    await expectKept(kept, false);
    expect(calls, "API recovery without running State does not invent timing or request discovery").toBe(1);
  });

  test(`expired Duration absence becomes Populating without new reads (${combined ? "combined" : "separate"})`, async ({ page }) => {
    let calls = 0;
    await page.addInitScript(value => localStorage.setItem("gridlens.preview.queued-duration-layout.v1", value),
      combined ? "combined" : "separate");
    await page.goto(await start(async () => {
      calls++;
      return {
        hosts: snapshot().hosts.map(record => ({ ...record, job: null })),
        nextRefreshAtMs: NOW + 900_000,
      };
    }));
    await expect(durationSource(page)).toHaveText("—");
    const button = await durationSource(page).locator(".duration-value").elementHandle();
    await page.clock.fastForward(180_000);
    await expect(durationSource(page)).toHaveText("Populating..");
    await expect(durationSource(page).locator(".duration-value")).toHaveCSS("color", "rgb(245, 158, 11)");
    expect(await button!.evaluate(element => element.isConnected)).toBe(true);
    expect(calls, "Expiry must not bypass the provider's future retry deadline").toBe(1);
    await durationSource(page).getByRole("button").click();
    await expect(page.getByRole("dialog")).toContainText("2026-01-01T12:00:00.000Z");
    await expect(page.getByRole("dialog")).toContainText(/no useful timing|unknown timing/i);
  });

  test(`successful Duration portions continue promptly and respect later budget pauses (${combined ? "combined" : "separate"})`, async ({ page }) => {
    let calls = 0;
    await page.addInitScript(value => localStorage.setItem("gridlens.preview.queued-duration-layout.v1", value),
      combined ? "combined" : "separate");
    await page.goto(await start(async () => {
      calls++;
      const at = await page.evaluate(() => Date.now());
      const result = snapshot();
      if (calls < 3) {
        const firstRetry = combined ? at + 200 : at;
        result.hosts = result.hosts.map((record, index) => index < calls ? record : {
          ...record, job: null, checkedAtMs: null, validUntilMs: null, pending: true,
          retryAtMs: calls === 1 ? firstRetry : NOW + 60_000,
        });
        result.nextRefreshAtMs = calls === 1 ? firstRetry : NOW + 60_000;
        if (calls === 2) {
          result.waitReason = "discovery-budget";
          result.waitUntilMs = NOW + 60_000;
        }
      } else result.nextRefreshAtMs = at + 120_000;
      return result;
    }));
    await openPreviewTools(page);
    await expect(page.locator("#jobs-status")).toContainText("7 lookups pending");
    await expect(durationSource(page, 1)).toHaveText("Populating..");
    const saved = await keepDuration(page);
    await page.clock.runFor(999);
    expect(calls).toBe(1);
    await page.clock.runFor(1);
    await expect.poll(() => calls).toBe(2);
    await expect(page.locator("#jobs-status")).toContainText("6 lookups pending");
    await expect(durationSource(page, 1).locator(".duration-track")).toHaveCount(1);
    await expectKept(saved, false);
    await page.clock.fastForward(58_999);
    expect(calls).toBe(2);
    await page.clock.runFor(1);
    await expect.poll(() => calls).toBe(3);
    await expect(page.locator("#jobs-status")).toContainText("8/8 current job timings");
    await expectKept(saved, false);
    await page.clock.fastForward(1_000);
    expect(calls, "Completing the final portion returns to ordinary timing refresh").toBe(3);
  });
}

test("State transition requests independent job discovery without coupling Duration validity to State", async ({ page }) => {
  let calls = 0;
  let stateCalls = 0;
  await page.goto(await start(async () => { calls++; return snapshot(await page.evaluate(() => Date.now())); }, async input => {
    stateCalls++;
    const at = await page.evaluate(() => Date.now());
    return { hosts: input.map(address => ({
      address, values: { state: stateCalls === 1 ? "QUEUED" : "RUNNING_JOB", dl: null, ul: null, ping: null, networkUnavailableReason: null },
      fetchedAtMs: at, validUntilMs: at + 30_000, retained: false, error: null,
    })) };
  }));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveText("⟵");
  expect(calls).toBe(1);
  await page.clock.fastForward(20_000);
  await expect.poll(() => calls).toBe(2);
  await page.clock.fastForward(20_000);
  await expect.poll(() => stateCalls).toBe(3);
  expect(calls).toBe(2);
  await expect(cell(page)).toHaveAttribute("data-duration-tone", "current");
});

test.describe("mobile Duration discovery", () => {
  test.use({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });

  function absentSnapshot(nextRefreshAtMs: number): JobSnapshot {
    return { hosts: addresses.map((_address, index) => ({ ...reading(index), job: null })), nextRefreshAtMs };
  }

  function stateSnapshot(input: readonly string[], state: "QUEUED" | "RUNNING_JOB", at: number): NodeInfoSnapshot {
    return { hosts: input.map(address => ({
      address, values: { state, dl: null, ul: null, ping: null, networkUnavailableReason: null },
      fetchedAtMs: at, validUntilMs: at + 30_000, retained: false, error: null,
    })) };
  }

  test("an overlapping running transition rechecks an older job deadline without a second viewer", async ({ page }) => {
    let calls = 0;
    let stateCalls = 0;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    // Capture a response before the State hint, then deliver it afterward. A
    // shared provider can finish its snapshot while the browser still reads it.
    const olderSnapshot = absentSnapshot(NOW + 900_000);
    await page.goto(await start(async () => {
      calls++;
      if (calls === 1) { await held; return olderSnapshot; }
      const at = await page.evaluate(() => Date.now());
      return { ...snapshot(at), nextRefreshAtMs: at + 120_000 };
    }, async input => {
      stateCalls++;
      return stateSnapshot(input, stateCalls === 1 ? "QUEUED" : "RUNNING_JOB", await page.evaluate(() => Date.now()));
    }));
    const state = page.locator(`#fleet-rows [data-host="${addresses[0]}"] td[data-col="state"]`);
    await expect.poll(() => calls).toBe(1);
    await expect(state).toHaveAttribute("data-state", "QUEUED");
    await page.clock.fastForward(20_000);
    await expect(state).toHaveAttribute("data-state", "RUNNING_JOB");
    release();
    // Let the response settle and run a possible coalesced same-origin read.
    await expect.poll(async () => { await page.clock.runFor(20); return calls; }).toBe(2);
    await expect(cell(page).locator(".duration-track")).toHaveCount(1);
    await expect(cell(page)).toHaveAttribute("data-duration-freshness", "current");
    await page.clock.fastForward(20_000);
    await expect.poll(() => stateCalls).toBe(3);
    expect(calls, "Unchanged running evidence must not repeat discovery").toBe(2);
  });

  test("first running evidence refreshes already empty timing on a newly loaded phone", async ({ page }) => {
    let calls = 0;
    let releaseState!: () => void;
    const held = new Promise<void>(resolve => { releaseState = resolve; });
    await page.goto(await start(async () => {
      calls++;
      const at = await page.evaluate(() => Date.now());
      return calls === 1 ? absentSnapshot(NOW + 900_000)
        : { ...snapshot(at), nextRefreshAtMs: at + 120_000 };
    }, async input => {
      await held;
      return stateSnapshot(input, "RUNNING_JOB", await page.evaluate(() => Date.now()));
    }));
    await expect(cell(page)).toHaveText("—");
    expect(calls).toBe(1);
    await page.clock.fastForward(1_000);
    releaseState();
    await expect.poll(async () => { await page.clock.runFor(20); return calls; }).toBe(2);
    await expect(cell(page).locator(".duration-track")).toHaveCount(1);
    await expect(cell(page)).toHaveAttribute("data-duration-freshness", "current");
  });

  test("a coalesced State hint accepts a renewed budget pause without a retry loop", async ({ page }) => {
    let calls = 0;
    let stateCalls = 0;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const budgetDeadline = NOW + 3_600_000;
    await page.goto(await start(async () => {
      calls++;
      if (calls === 1) { await held; return absentSnapshot(NOW + 900_000); }
      return {
        ...absentSnapshot(budgetDeadline),
        hosts: absentSnapshot(budgetDeadline).hosts.map(record => ({ ...record, pending: true, retryAtMs: budgetDeadline })),
        waitReason: "discovery-budget", waitUntilMs: budgetDeadline,
      };
    }, async input => {
      stateCalls++;
      return stateSnapshot(input, stateCalls === 1 ? "QUEUED" : "RUNNING_JOB", await page.evaluate(() => Date.now()));
    }));
    const state = page.locator(`#fleet-rows [data-host="${addresses[0]}"] td[data-col="state"]`);
    await expect.poll(() => calls).toBe(1);
    await expect(state).toHaveAttribute("data-state", "QUEUED");
    await page.clock.fastForward(20_000);
    await expect(state).toHaveAttribute("data-state", "RUNNING_JOB");
    release();
    await expect.poll(async () => { await page.clock.runFor(20); return calls; }).toBe(2);
    await openPreviewTools(page);
    await expect(cell(page)).toHaveText("Populating..");
    await expect(page.locator("#jobs-status")).toContainText("2026-01-01T13:00:00.000Z");
    await page.clock.fastForward(20_000);
    await expect.poll(() => stateCalls).toBe(3);
    await expect(state).toHaveAttribute("data-state-checked-at", String(await page.evaluate(() => Date.now())));
    await page.clock.fastForward(20_000);
    await expect.poll(() => stateCalls).toBe(4);
    expect(calls, "A State hint must not spin against the authoritative renewed pause").toBe(2);
    await visibility(page, "hidden");
    await page.clock.fastForward(3_600_000);
    expect(calls, "An overdue job read stays paused while the phone is hidden").toBe(2);
  });
});

test("Duration System mode honors reduced motion independently of State's explicit animation setting", async ({ page }) => {
  await page.goto(await start(async () => snapshot()));
  await openPreviewTools(page);
  await page.getByLabel("Duration animation", { exact: true }).selectOption("system");
  await expect(cell(page).locator(".duration-active")).toHaveCount(1);
  await expect(page.getByLabel("State animation", { exact: true })).toHaveValue("on");
  expect(await cell(page).locator(".duration-fill").evaluate(element => getComputedStyle(element, "::after").animationName)).toBe("none");
  expect(await cell(page).locator(".duration-fill").evaluate(element => (element as HTMLElement).style.width)).toBe("20%");
  await page.clock.runFor(1_000);
  await expect(cell(page).getByRole("button")).toHaveAccessibleName(/2m 1s \/ 10m/);
});

test("Populating placeholder uses stable centered space through timing, completion and unbounded readings", async ({ page }) => {
  let calls = 0;
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(await start(async () => {
    calls++;
    const at = await page.evaluate(() => Date.now());
    const result = snapshot(at);
    if (calls === 1) for (const host of result.hosts) Object.assign(host, {
      job: null, checkedAtMs: null, validUntilMs: null, pending: true,
      retryAtMs: NOW + 60_000, error: "Lookup pending.",
    });
    if (calls === 3) for (const host of result.hosts) Object.assign(host.job!, { state: "COMPLETED", timeEnd: at / 1_000 });
    if (calls === 4) for (const host of result.hosts) host.job!.timeout = null;
    return result;
  }));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveText("Populating..");
  await expect(cell(page).getByRole("button")).toHaveCSS("font-size", "8px");
  await expect(cell(page).getByRole("button")).toHaveCSS("color", "rgb(245, 158, 11)");
  const row = page.locator(`#fleet-rows [data-host="${addresses[0]}"]`);
  const positions = () => row.locator("td").evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x + window.scrollX, width: rect.width };
  }));
  const initial = await positions();
  const button = await cell(page).getByRole("button").elementHandle();
  await page.clock.fastForward(1_000);
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect(cell(page).locator(".duration-track")).toHaveCount(1);
  expect(await positions()).toEqual(initial);
  const centered = await cell(page).evaluate(element => {
    const cell = element.getBoundingClientRect();
    const track = element.querySelector(".duration-track")!.getBoundingClientRect();
    return Math.abs((cell.left + cell.right) / 2 - (track.left + track.right) / 2);
  });
  expect(centered).toBeLessThanOrEqual(1);
  await page.clock.fastForward(1_000);
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect(cell(page)).toHaveText("—");
  expect(await positions()).toEqual(initial);
  await cell(page).getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText("No running assignment");
  await page.keyboard.press("Escape");
  await page.clock.fastForward(1_000);
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect(cell(page)).toContainText("2m 3s");
  await expect(cell(page).locator(".duration-track")).toHaveCount(0);
  await expect(cell(page).locator(".duration-active")).toHaveCount(0);
  expect(await button!.evaluate(element => element.isConnected)).toBe(true);
});

test("job-backed State keeps its original 180-second deadline and stale ticks never refresh it", async ({ page }) => {
  let calls = 0;
  await page.goto(await start(async () => { calls++; return snapshot(); }));
  await openPreviewTools(page);
  const state = page.locator(`#fleet-rows [data-host="${addresses[0]}"] td[data-col="state"]`);
  await expect(state).toHaveAttribute("data-state-current", "true");
  await expect(state.locator(".state-running")).toBeVisible();
  const icon = await state.locator(".state-running").elementHandle();
  await page.clock.fastForward(30_000);
  await expect(state).toHaveAttribute("data-state-current", "true");
  await page.clock.fastForward(90_000);
  await expect.poll(() => calls).toBe(2);
  await expect(state).toHaveAttribute("data-state-current", "true");
  await page.clock.fastForward(60_000);
  await expect(state).toHaveAttribute("data-state-current", "false");
  await expect(state.locator(".state-running")).toHaveCSS("color", "rgb(36, 78, 148)");
  await expect(state.locator(".state-running-ring")).not.toHaveCSS("animation-name", "none");
  await expect(cell(page)).toHaveAttribute("data-duration-freshness", "retained");
  await page.clock.fastForward(5_000);
  await expect(cell(page).getByRole("button")).toHaveAccessibleName(/5m 5s \/ 10m/);
  await expect(state).toHaveAttribute("data-state-current", "false");
  expect(await icon!.evaluate(element => element.isConnected)).toBe(true);
  await state.getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText(addresses[1]!);
  await expect(page.getByRole("dialog")).toContainText("2026-01-01T12:00:00.000Z");
  expect(calls).toBe(2);
});

test("stale bounded timing obeys independent motion preferences and resumes after a prolonged hidden view", async ({ page }) => {
  let calls = 0;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(await start(async () => { calls++; return snapshot(); }));
  await openPreviewTools(page);
  await expect(cell(page).locator(".duration-active")).toHaveCount(1);
  const kept = await keepDuration(page);
  const fill = cell(page).locator(".duration-fill");
  await cell(page).getByRole("button").focus();
  await visibility(page, "hidden");
  await page.clock.fastForward(3_600_000);
  expect(calls).toBe(1);
  await visibility(page, "visible");
  await expect.poll(() => calls).toBe(2);
  await expect(cell(page).getByRole("button")).toBeFocused();
  await expect(cell(page).getByRole("button")).toHaveAccessibleName(/1h 2m \/ 10m/);
  await expect(cell(page)).toHaveAttribute("data-duration-freshness", "retained");
  await expect(cell(page)).toHaveAttribute("data-duration-tone", "exceeded");
  await expect(fill).toHaveCSS("background-color", "rgb(150, 48, 48)");
  await expectKept(kept);
  const glare = () => fill.evaluate(element => getComputedStyle(element, "::after").animationName);
  expect(await glare()).toBe("duration-sweep");
  expect(await fill.evaluate(element => getComputedStyle(element, "::after").opacity)).toBe("0.45");
  await page.getByLabel("Duration animation", { exact: true }).selectOption("off");
  expect(await glare()).toBe("none");
  const stateRing = page.locator(`#fleet-rows [data-host="${addresses[0]}"] .state-running-ring`);
  await expect(stateRing).not.toHaveCSS("animation-name", "none");
  await page.getByLabel("Duration animation", { exact: true }).selectOption("system");
  expect(await glare()).toBe("none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  expect(await glare()).toBe("duration-sweep");
  await page.getByLabel("State animation", { exact: true }).selectOption("off");
  await expect(stateRing).toHaveCSS("animation-name", "none");
  expect(await glare()).toBe("duration-sweep");
  await page.clock.runFor(60_000);
  await expect(cell(page).getByRole("button")).toHaveAccessibleName(/1h 3m \/ 10m/);
  expect(calls).toBe(2);
});

test("five-minute Duration grace crosses once for running and restarting hosts without resetting on failed reads or layouts", async ({ page }) => {
  let fail = false;
  let restarting = false;
  let calls = 0;
  await page.goto(await start(async () => {
    calls++;
    const result = snapshot();
    result.hosts[0] = reading(0, NOW, 899, 600);
    result.hosts[1] = reading(1, NOW, 899, 600);
    if (fail) Object.assign(result.hosts[0]!, { retained: true, failedAtMs: NOW, error: "Delayed refresh." });
    return result;
  }, async input => ({ hosts: input.map((address, index) => ({
    address, values: index < 2 ? { state: index === 1 || restarting ? "RESTARTING" : "RUNNING_JOB",
      dl: null, ul: null, ping: null, networkUnavailableReason: null } : null,
    fetchedAtMs: index < 2 ? NOW + (restarting ? 2_000 : 0) : null,
    validUntilMs: index < 2 ? NOW + (restarting ? 32_000 : 30_000) : null,
    retained: false, error: null,
  })) })));
  await openPreviewTools(page);
  const value = (index: number) => page.locator(`#fleet-rows [data-host="${addresses[index]}"] .duration-value`);
  const state = (index: number) => page.locator(`#fleet-rows [data-host="${addresses[index]}"] td[data-col="state"]`);
  const display = page.getByRole("button", { name: "Toggle Duration display", exact: true });
  for (const index of [0, 1]) {
    await expect(cell(page, index)).toHaveAttribute("data-duration-tone", "current");
    await expect(value(index)).toHaveAccessibleName(/14m 59s \/ 10m/);
    await expect(value(index).locator(".duration-fill")).toHaveCSS("background-color", "rgb(74, 222, 128)");
    expect(await value(index).locator(".duration-fill").evaluate(element => (element as HTMLElement).style.width)).toBe("100%");
    await expect(value(index).locator(".duration-track")).toHaveCSS("height", "8px");
  }
  await expect(state(0)).toHaveAttribute("data-state", "RUNNING_JOB");
  await expect(state(1)).toHaveAttribute("data-state", "RESTARTING");
  fail = true;
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect(cell(page)).toHaveAttribute("data-duration-freshness", "retained");
  await expect.poll(() => calls).toBe(2);
  const reads = { jobs: jobRequests, state: stateRequests };
  await display.click();
  await page.clock.runFor(1_000);
  for (const index of [0, 1]) {
    await expect(value(index)).toHaveText("15m / 10m");
    await expect(cell(page, index)).toHaveAttribute("data-duration-tone", "current");
  }
  await expect(value(0)).toHaveCSS("color", "rgb(40, 122, 71)");
  await expect(value(1)).toHaveCSS("color", "rgb(74, 222, 128)");
  await display.click();
  await expect(value(0).locator(".duration-fill")).toHaveCSS("background-color", "rgb(40, 122, 71)");
  await expect(value(1).locator(".duration-fill")).toHaveCSS("background-color", "rgb(74, 222, 128)");
  for (const index of [0, 1]) await expect(value(index).locator(".duration-track")).toHaveCSS("height", "8px");
  await display.click();
  await page.locator("#queued-duration-layout-toggle").click();
  await expect(page.locator('th[data-col="queued-duration"]')).toBeVisible();
  await page.clock.runFor(1_000);
  for (const index of [0, 1]) {
    await expect(value(index)).toHaveText("15m 1s / 10m");
    await expect(cell(page, index)).toHaveAttribute("data-duration-tone", "exceeded");
    await expect(cell(page, index)).toHaveAttribute("data-job-checked-at", String(NOW));
  }
  await expect(value(0)).toHaveCSS("color", "rgb(150, 48, 48)");
  await expect(value(1)).toHaveCSS("color", "rgb(239, 68, 68)");
  await display.click();
  for (const index of [0, 1]) {
    await expect(value(index).locator(".duration-track")).toHaveCSS("height", "12px");
    expect(await value(index).locator(".duration-fill").evaluate(element => (element as HTMLElement).style.width)).toBe("100%");
  }
  await expect(value(0).locator(".duration-fill")).toHaveCSS("background-color", "rgb(150, 48, 48)");
  await expect(value(1).locator(".duration-fill")).toHaveCSS("background-color", "rgb(239, 68, 68)");
  expect({ jobs: jobRequests, state: stateRequests }).toEqual(reads);
  restarting = true;
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect.poll(() => calls).toBe(3);
  await expect(state(0)).toHaveAttribute("data-state", "RESTARTING");
  await expect(cell(page)).toHaveAttribute("data-duration-tone", "exceeded");
  await expect(cell(page)).toHaveAttribute("data-job-checked-at", String(NOW));
  await value(0).click();
  await expect(page.getByRole("dialog")).toContainText("15m 1s / 10m");
  await expect(page.getByRole("dialog")).toContainText("600 seconds");
  await expect(page.getByRole("dialog")).toContainText(new Date(NOW).toISOString());
  await expect(page.getByRole("dialog")).toContainText(new Date(NOW + 180_000).toISOString());
  await page.keyboard.press("Escape");
  await page.reload();
  await openPreviewTools(page);
  await expect.poll(() => calls).toBe(4);
  await expect(state(0)).toHaveAttribute("data-state", "RESTARTING");
  for (const index of [0, 1]) {
    await expect(cell(page, index)).toHaveAttribute("data-duration-tone", "exceeded");
    await expect(cell(page, index)).toHaveAttribute("data-job-checked-at", String(NOW));
    await expect(value(index)).toHaveAccessibleName(/15m 1s \/ 10m/);
  }
});

test("completion retires job-backed State and timing through expiry and cached responses until a newer running check", async ({ page }) => {
  let mode: "running" | "completed" | "cached" | "rechecked" = "running";
  await page.goto(await start(async () => {
    const at = await page.evaluate(() => Date.now());
    const result = snapshot(mode === "cached" ? NOW : at);
    if (mode === "completed") Object.assign(result.hosts[0]!.job!, { state: "COMPLETED", timeEnd: at / 1_000 });
    return result;
  }));
  await openPreviewTools(page);
  const state = page.locator(`#fleet-rows [data-host="${addresses[0]}"] td[data-col="state"]`);
  await expect(state.locator(".state-running")).toBeVisible();
  await expect(cell(page).locator(".duration-active")).toHaveCount(1);
  await page.clock.fastForward(5_000);
  mode = "completed";
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect(cell(page)).toHaveText("—");
  await expect(state.locator(".state-unknown .state-dots")).toBeVisible();
  await expect(state).toHaveAttribute("data-state", "unknown");
  await expect(state).toHaveAttribute("data-state-current", "false");
  await expect(state.getByRole("button")).toHaveAccessibleName(/unknown/);
  await page.clock.fastForward(31_000);
  mode = "cached";
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect(cell(page)).toHaveText("—");
  await expect(state.locator(".state-unknown .state-dots")).toBeVisible();
  await expect(state).toHaveAttribute("data-state", "unknown");
  await expect(state).toHaveAttribute("data-state-current", "false");
  await page.clock.fastForward(1_000);
  mode = "rechecked";
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect(cell(page)).toHaveAttribute("data-duration-freshness", "current");
  await expect(cell(page).getByRole("button")).toHaveAccessibleName(/2m 37s \/ 10m/);
  await expect(state).toHaveAttribute("data-state-current", "true");
  await expect(state.locator(".state-running")).toBeVisible();
});
