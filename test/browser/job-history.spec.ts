import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { blankJobHistoryRecord } from "../../src/fleet/job-history.ts";
import type { JobHistoryRecord } from "../../src/fleet/job-history.ts";
import { SYNTHETIC_HOST_ADDRESSES as addresses } from "../fixtures/host-addresses.ts";

const origin = "http://127.0.0.1:4174";
const requests: URL[] = [];
const errors: string[] = [];
let checkedAt = 0;
let history: (hosts: string[]) => JobHistoryRecord[];
function jobAddress(index: number): string {
  // Artificial 32-byte identities independent of the synthetic host roster.
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = BigInt(index + 1) + (0x22n << 248n);
  let address = "";
  while (value > 0) { address = alphabet[Number(value % 58n)]! + address; value /= 58n; }
  return address;
}
function pageRecord(address: string, count = 10): JobHistoryRecord {
  return { address, jobs: Array.from({ length: count }, (_, index) => ({
    address: jobAddress(Math.max(0, addresses.indexOf(address)) * 10 + index), node: address, state: "COMPLETED", result: index === 1 ? "failed" : index === 2 ? null : "success",
    timeStart: Math.floor(checkedAt / 1000) - 60 * (index + 2), timeEnd: Math.floor(checkedAt / 1000) - 60 * (index + 1), timeout: 600,
    checkedAtMs: checkedAt,
  })), checkedAtMs: checkedAt, validUntilMs: checkedAt + 300_000, totalJobs: 15, retained: false,
  pending: false, retryAtMs: null, error: null };
}
const hostRow = (page: Page, index = 0) => page.locator(`#fleet-rows > tr[data-host="${addresses[index]}"]`);
const panel = (page: Page, index = 0) => page.locator(`tr[data-job-history-host="${addresses[index]}"]`);
const source = (page: Page, index = 0) => panel(page, index).locator(".job-history-source");
async function open(page: Page, index = 0): Promise<void> {
  await hostRow(page, index).locator(".jobs-expand").click();
  await expect(panel(page, index).locator(".job-history-table tbody > tr")).toHaveCount(10);
}

test.beforeEach(async ({ context, page }) => {
  requests.length = errors.length = 0;
  checkedAt = Date.now();
  history = hosts => hosts.map(address => pageRecord(address));
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { errors.push(`External request: ${url.origin}`); await route.abort(); return; }
    if (url.pathname === "/preview/job-history.json") {
      requests.push(url);
      await route.fulfill({ json: { hosts: history(url.searchParams.getAll("host")), serverTimeMs: Date.now() } });
      return;
    }
    await route.continue();
  });
  page.on("pageerror", error => errors.push(error.message));
});
test.afterEach(() => { expect(errors).toEqual([]); });

test("on-demand drawers preserve compact rows, lifecycle/result, cache and focus through sorting", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#fleet-rows > tr[data-host]")).toHaveCount(8);
  expect(requests).toHaveLength(0);
  expect(await hostRow(page).evaluate(row => row.getBoundingClientRect().height)).toBe(34);
  const fleetWidth = await page.locator(".fleet-table").evaluate(table => table.getBoundingClientRect().width);
  const row = await hostRow(page).elementHandle();
  const toggle = await hostRow(page).locator(".jobs-expand").elementHandle();
  await open(page);
  expect(await page.locator(".fleet-table").evaluate(table => table.getBoundingClientRect().width)).toBeLessThanOrEqual(fleetWidth + 1);
  expect(await panel(page).locator(".job-history-table").evaluate(table => table.getBoundingClientRect().width)).toBeLessThanOrEqual(fleetWidth);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.searchParams.getAll("host")).toEqual([addresses[0]]);
  await expect(hostRow(page).locator(".jobs-expand")).toBeFocused();
  await expect(hostRow(page).locator(".jobs-expand")).toHaveAttribute("aria-expanded", "true");
  await expect(panel(page).locator(".job-history-table thead th")).toHaveText(["ADDRESS", "HOST", "STARTED", "DURATION", "PRICE", "GPU", "STATUS"]);
  await expect(source(page)).not.toHaveAttribute("open", "");
  await expect(source(page).locator(".job-history-source-summary")).toContainText("15 indexed records; more history exists");
  await expect(source(page).locator(".job-history-source-list")).not.toBeVisible();
  const second = panel(page).locator(".job-history-table tbody > tr").nth(1);
  await expect(second.locator(".job-history-status-label")).toHaveText("FAILED");
  await expect(second.locator(".job-history-status")).toHaveAttribute("data-tone", "failed");
  await expect(source(page).locator(`[data-job-source="${jobAddress(1)}"]`)).toContainText("Lifecycle: Completed");
  await expect(source(page).locator(`[data-job-source="${jobAddress(1)}"]`)).toContainText("Result: Failed");
  const unknown = panel(page).locator(".job-history-table tbody > tr").nth(2);
  await expect(unknown.locator(".job-history-status-label")).toHaveText("COMPLETED");
  await expect(unknown.locator(".job-history-status-note")).toContainText("Result unknown");
  await expect(unknown.locator(".job-history-status")).toHaveAttribute("data-tone", "unknown");
  await expect(panel(page).locator(".job-history-table tbody > tr").first().locator('[data-history-col="address"] a')).toHaveAttribute("href", `https://explore.nosana.com/jobs/${jobAddress(0)}`);
  await expect(panel(page).locator(".job-history-table tbody > tr").first().locator('[data-history-col="host"] a')).toHaveAttribute("href", `https://explore.nosana.com/hosts/${addresses[0]}`);
  await expect(panel(page).locator('tbody [data-history-col="price"] .job-history-price')).toHaveText(Array(10).fill("—"));
  await expect(panel(page).locator('tbody [data-history-col="gpu"]')).toHaveText(Array(10).fill("—"));
  const historyGeometry = await panel(page).locator(".job-history-table tbody > tr").evaluateAll(rows => rows.map(row => {
    const cells = [...row.querySelectorAll<HTMLElement>("td")].map(cell => {
      const bounds = cell.getBoundingClientRect();
      const contents = document.createRange(); contents.selectNodeContents(cell);
      const content = contents.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, contentLeft: content.left, contentRight: content.right };
    });
    return { height: row.getBoundingClientRect().height, cells };
  }));
  for (const row of historyGeometry) {
    expect(row.height).toBeGreaterThanOrEqual(48);
    expect(row.height).toBeLessThanOrEqual(56);
    for (const [index, cell] of row.cells.entries()) {
      expect(cell.contentLeft).toBeGreaterThanOrEqual(cell.left - 1);
      expect(cell.contentRight).toBeLessThanOrEqual(cell.right + 1);
      if (index) expect(cell.left).toBeGreaterThanOrEqual(row.cells[index - 1]!.right - 1);
    }
  }
  expect(await hostRow(page).evaluate(element => element.getBoundingClientRect().height)).toBe(34);
  await expect(hostRow(page).locator(".job-summary-state")).toHaveText("Completed · seen");
  await page.locator("#queued-duration-layout-toggle").click();
  await expect(panel(page).locator(":scope > td")).toHaveAttribute("colspan", "28");
  await page.locator("#queued-duration-layout-toggle").click();
  await expect(panel(page).locator(":scope > td")).toHaveAttribute("colspan", "29");
  const details = await panel(page).elementHandle();
  await page.getByRole("button", { name: "Sort by Host Address", exact: true }).click();
  expect(await details!.evaluate(element => element.isConnected && element.previousElementSibling?.getAttribute("data-host") === element.getAttribute("data-job-history-host"))).toBe(true);
  expect(await row!.evaluate(element => element.isConnected)).toBe(true);
  expect(await toggle!.evaluate(element => element.isConnected)).toBe(true);
  await hostRow(page).locator(".jobs-expand").click();
  await expect(panel(page)).toHaveCount(0);
  await open(page);
  expect(requests).toHaveLength(1);
  await page.getByRole("button", { name: "Show all recent jobs", exact: true }).click();
  await expect(page.locator("#fleet-rows > .job-history-row")).toHaveCount(8);
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]!.searchParams.getAll("host")).toHaveLength(7);
  await page.getByRole("button", { name: "Hide all recent jobs", exact: true }).click();
  await expect(page.locator(".job-history-row")).toHaveCount(0);
  expect(await hostRow(page).evaluate(element => element.getBoundingClientRect().height)).toBe(34);
  await page.reload();
  await expect(page.locator("#fleet-rows > tr[data-host]")).toHaveCount(8);
  await expect(page.locator(".job-history-row")).toHaveCount(0);
  expect(requests).toHaveLength(2);
});

test("stale pages refresh on reopening; manual failure retains dated records and explicit refresh", async ({ page }) => {
  checkedAt = Date.now() - 301_000;
  await page.goto("/");
  await open(page);
  await expect(panel(page).locator(".job-history-notice")).toHaveAttribute("data-stale", "true");
  await expect(panel(page).locator(".job-history-notice")).toContainText(/stale/i);
  await hostRow(page).locator(".jobs-expand").click();
  await open(page);
  await expect.poll(() => requests.length).toBe(2);
  history = hosts => hosts.map(address => ({ ...pageRecord(address), retained: true, error: "Synthetic history unavailable." }));
  await panel(page).getByRole("button", { name: /Refresh recent jobs/ }).click();
  await expect(panel(page).locator(".job-history-notice")).toContainText("History refresh unavailable");
  await expect(source(page).locator(".job-history-source-summary")).toContainText("Synthetic history unavailable.");
  expect(requests[2]!.searchParams.get("refresh")).toBe("1");
  await expect(panel(page).locator(".job-history-table tbody > tr")).toHaveCount(10);
  await expect(source(page).locator(".job-history-source-summary")).toContainText(new Date(checkedAt).toISOString());
});

test("expanded history headings scroll with their own rows without inheriting Fleet header animation", async ({ page }) => {
  await page.goto("/");
  await open(page);
  const heading = panel(page).locator(".job-history-table thead");
  await expect(heading).toHaveCSS("position", "static");
  await expect(heading).toHaveCSS("animation-name", "none");
  const before = await heading.evaluate(head => {
    const table = head.parentElement as HTMLTableElement;
    return { top: head.getBoundingClientRect().top, bottom: head.getBoundingClientRect().bottom,
      body: table.tBodies[0]!.rows[0]!.getBoundingClientRect().top, scroll: window.scrollY };
  });
  await page.evaluate(() => window.scrollBy(0, 150));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before.scroll);
  const after = await heading.evaluate(head => {
    const table = head.parentElement as HTMLTableElement;
    return { top: head.getBoundingClientRect().top, bottom: head.getBoundingClientRect().bottom,
      body: table.tBodies[0]!.rows[0]!.getBoundingClientRect().top, scroll: window.scrollY };
  });
  expect(after.top + after.scroll).toBeCloseTo(before.top + before.scroll, 0);
  expect(after.body - after.bottom).toBeCloseTo(before.body - before.bottom, 0);
  expect(after.bottom).toBeLessThanOrEqual(after.body + 1);
  expect(requests).toHaveLength(1);
});

test("pending history follows retry eligibility only while expanded and Hide all cancels it", async ({ page }) => {
  await page.clock.install();
  history = hosts => hosts.map(address => ({ ...blankJobHistoryRecord(address), pending: true, retryAtMs: checkedAt + 60_000 }));
  await page.goto("/");
  await hostRow(page).locator(".jobs-expand").click();
  await expect(panel(page).locator(".job-history-notice")).toContainText(/pending/i);
  await expect(source(page).locator(".job-history-source-summary")).toContainText("retry eligible");
  expect(requests).toHaveLength(1);
  await page.getByRole("button", { name: "Hide all recent jobs", exact: true }).click();
  await page.clock.runFor(70_000);
  expect(requests).toHaveLength(1);
  history = hosts => hosts.map(address => pageRecord(address));
  await open(page);
  expect(requests).toHaveLength(2);
});

test("synthetic expansions make no history requests and do not expose live cached records", async ({ page }) => {
  await page.goto("/");
  await open(page);
  await page.locator("#scenario").selectOption("fresh");
  await expect(page.locator(".job-history-row")).toHaveCount(0);
  await page.getByRole("button", { name: "Show all recent jobs", exact: true }).click();
  await expect(page.locator("#fleet-rows > .job-history-row")).toHaveCount(8);
  await expect(page.locator(".job-history-notice").first()).toHaveText("Synthetic example only; live history is not requested.");
  await expect(page.locator(".job-history-table a")).toHaveCount(0);
  expect(requests).toHaveLength(1);
});

test("200-host Show all uses bounded chunks and keeps parent rows connected", async ({ page }) => {
  const roster = Array.from({ length: 200 }, (_, index) => jobAddress(index + 100));
  await page.route("**/preview/*.json*", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/job-history.json")) { await route.fallback(); return; }
    if (url.pathname.endsWith("/connection.json")) { await route.continue(); return; }
    const response = await route.fetch();
    const body = await response.json() as Record<string, unknown>;
    if (url.pathname.endsWith("/hosts.json")) body.addresses = roster;
    else if (Array.isArray(body.hosts)) {
      const template = body.hosts[0] as Record<string, unknown>;
      body.hosts = roster.map(address => ({ ...template, address }));
    }
    await route.fulfill({ json: body });
  });
  history = hosts => hosts.map(address => ({ ...blankJobHistoryRecord(address), checkedAtMs: checkedAt,
    validUntilMs: checkedAt + 300_000, totalJobs: 0 }));
  await page.goto("/");
  await expect(page.locator("#fleet-rows > tr[data-host]")).toHaveCount(200);
  const first = await page.locator("#fleet-rows > tr[data-host]").first().elementHandle();
  await page.getByRole("button", { name: "Show all recent jobs", exact: true }).click();
  await expect(page.locator("#fleet-rows > .job-history-row")).toHaveCount(200);
  await expect.poll(() => requests.length).toBe(2);
  expect(requests.map(request => request.searchParams.getAll("host").length)).toEqual([100, 100]);
  expect(new Set(requests.flatMap(request => request.searchParams.getAll("host"))).size).toBe(200);
  expect(await first!.evaluate(element => element.isConnected)).toBe(true);
});


test.describe("phone history", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  test("expanded history remains in document flow and permits native horizontal panning", async ({ page, context }) => {
    await page.goto("/");
    await open(page);
    await expect(panel(page).locator(".job-history-table")).toBeVisible();
    const wrapper = page.locator(".fleet-table-wrap");
    await expect(wrapper).toHaveCSS("overflow-x", "auto");
    expect(await wrapper.evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    await wrapper.evaluate(element => { element.scrollLeft = 0; });
    const before = await wrapper.evaluate(element => element.scrollLeft);
    const session = await context.newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 350, y: 250 }] });
    for (let step = 1; step <= 8; step++) {
      await new Promise(resolve => setTimeout(resolve, 25));
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 350 - step * 30, y: 250 }] });
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => wrapper.evaluate(element => element.scrollLeft)).toBeGreaterThan(before);
    expect(await hostRow(page).evaluate(element => element.getBoundingClientRect().height)).toBe(34);
    await expect(page.locator("#fleet-connection")).toBeVisible();
    await session.detach();
  });
});

test("an explicitly requested refresh retries its pending page before the five-minute cache expires", async ({ page }) => {
  history = hosts => hosts.map(address => requests.length === 2
    ? { ...pageRecord(address), pending: true, retryAtMs: Date.now() + 1000 }
    : pageRecord(address));
  await page.goto("/");
  await open(page);
  await panel(page).getByRole("button", { name: /Refresh recent jobs/ }).click();
  await expect(panel(page).locator(".job-history-notice")).toContainText("History pending");
  await expect.poll(() => requests.length, { timeout: 5000 }).toBe(3);
  await expect(panel(page).locator(".job-history-notice")).not.toContainText("History pending");
  await expect(panel(page).locator(".job-history-notice")).toHaveAttribute("data-stale", "false");
});

test("current assignment stays the compact summary and historical results do not replace activity evidence", async ({ page }) => {
  await page.clock.install({ time: checkedAt });
  const currentAddress = jobAddress(500);
  await page.route("**/preview/jobs.json*", route => route.fulfill({ json: {
    hosts: addresses.map((address, index) => ({ address, job: index === 0 ? {
      address: currentAddress, node: address, state: "RUNNING", timeStart: Math.floor(checkedAt / 1000) - 30,
      timeEnd: 0, timeout: 600,
    } : null, checkedAtMs: checkedAt, validUntilMs: checkedAt + 180_000, failedAtMs: null,
    retained: false, pending: false, retryAtMs: null, error: null })), serverTimeMs: Date.now(),
  } }));
  await page.goto("/");
  await expect(hostRow(page).locator(".job-summary-link")).toHaveAttribute("href", `https://explore.nosana.com/jobs/${currentAddress}`);
  await expect(hostRow(page).locator(".job-summary-state")).toHaveText("Running");
  const state = await hostRow(page).locator('td[data-col="state"]').getAttribute("data-state");
  const duration = await hostRow(page).locator('td[data-col="duration"]').getAttribute("data-job-address");
  await open(page);
  await expect(hostRow(page).locator(".job-summary-link")).toHaveAttribute("href", `https://explore.nosana.com/jobs/${currentAddress}`);
  await expect(hostRow(page).locator(".job-summary-state")).toHaveText("Running");
  const running = panel(page).locator(`.job-history-table tbody > tr[data-job="${currentAddress}"]`);
  await expect(running.locator(".job-history-status-label")).toHaveText("RUNNING");
  await expect(running.locator(".job-history-status")).toHaveAttribute("data-current", "true");
  await expect(running.locator(".job-history-status")).toHaveAttribute("data-tone", "running");
  await expect(running).not.toContainText("Unavailable");
  const started = running.locator('[data-history-col="started"]');
  const elapsed = running.locator('[data-history-col="duration"]');
  await expect(started).toHaveText(/\d+ seconds? ago/);
  await expect(elapsed).toContainText(/Max\s+10m/);
  await expect(elapsed).toHaveAttribute("aria-label", /estimate/i);
  expect(await hostRow(page).locator('td[data-col="state"]').getAttribute("data-state")).toBe(state);
  expect(await hostRow(page).locator('td[data-col="duration"]').getAttribute("data-job-address")).toBe(duration);
  await source(page).locator("summary").click();
  await expect(source(page)).toHaveAttribute("open", "");
  await expect(source(page).locator("summary")).toBeFocused();
  const original = source(page).locator(`[data-job-source="${currentAddress}"]`);
  await expect(original).toContainText("Lifecycle: Running");
  await expect(original).toContainText("Result: Unavailable");
  await expect(original).toContainText(new Date((Math.floor(checkedAt / 1000) - 30) * 1000).toISOString());
  await expect(original).toContainText(new Date(checkedAt).toISOString());
  await expect(original).toContainText("Reported timeout: 600 seconds");
  await expect(source(page).locator(".job-history-source-summary")).toContainText("15 indexed records");
  const originalText = await original.textContent();
  const disclosure = await source(page).elementHandle();
  const originalNode = await original.elementHandle();
  const startedBefore = await started.textContent();
  const elapsedBefore = await elapsed.textContent();
  await page.clock.fastForward(3000);
  await expect(started).not.toHaveText(startedBefore!);
  await expect(elapsed).not.toHaveText(elapsedBefore!);
  await expect(original).toHaveText(originalText!);
  await expect(source(page)).toHaveAttribute("open", "");
  await expect(source(page).locator("summary")).toBeFocused();
  expect(await disclosure!.evaluate(element => element.isConnected)).toBe(true);
  expect(await originalNode!.evaluate(element => element.isConnected)).toBe(true);
  expect(requests).toHaveLength(1);
});

test("historical running and unknown results stay explicit without inventing current activity or success", async ({ page }) => {
  checkedAt = Date.now() - 301_000;
  history = hosts => hosts.map(address => {
    const record = pageRecord(address);
    Object.assign(record.jobs[0]!, { state: "RUNNING", result: null, timeEnd: 0 });
    Object.assign(record.jobs[3]!, { state: "RUNNING", result: "success", timeEnd: 0 });
    record.jobs[4]!.timeout = null;
    Object.assign(record.jobs[5]!, { timeStart: null, timeEnd: null, result: null });
    return record;
  });
  await page.goto("/");
  await open(page);
  const item = (index: number) => panel(page).locator(`.job-history-table tbody > tr[data-job="${jobAddress(index)}"]`);
  await expect(item(0).locator(".job-history-status-label")).toHaveText("RUNNING");
  await expect(item(0).locator(".job-history-status")).toHaveAttribute("data-current", "false");
  await expect(item(0).locator(".job-history-status-note")).toContainText("Last reported");
  await expect(item(0)).not.toContainText("Unavailable");
  await expect(item(2).locator(".job-history-status-label")).toHaveText("COMPLETED");
  await expect(item(2).locator(".job-history-status-note")).toContainText("Result unknown");
  await expect(item(2).locator(".job-history-status")).toHaveAttribute("data-tone", "unknown");
  await expect(item(3).locator(".job-history-status-label")).toHaveText("CONFLICT");
  await expect(item(3).locator(".job-history-status-note")).toContainText(/result/i);
  await expect(item(3).locator(".job-history-status")).toHaveAttribute("data-current", "false");
  await expect(item(4).locator('[data-history-col="duration"]')).toContainText("Max unknown");
  await expect(item(4).locator('[data-history-col="duration"]')).toContainText("1m");
  await expect(item(5).locator('[data-history-col="started"]')).toHaveText("Unknown");
  await expect(item(5).locator('[data-history-col="duration"]')).toContainText("Unknown");
  await expect(item(6).locator(".job-history-status-label")).toHaveText("SUCCESS");
  await expect(item(6).locator(".job-history-status")).toHaveAttribute("data-tone", "success");
  await source(page).locator("summary").click();
  const proof = source(page).locator(`[data-job-source="${jobAddress(0)}"]`);
  await expect(proof).toContainText("Lifecycle: Running");
  await expect(proof).toContainText("Result: Unavailable");
  await expect(proof).toContainText(new Date(checkedAt).toISOString());
  await expect(source(page).locator(`[data-job-source="${jobAddress(2)}"]`)).toContainText("Result: Unavailable");
  expect(requests).toHaveLength(1);
});

test("job prices distinguish current hourly quotes from recorded finished totals and missing sources stay unknown", async ({ page }) => {
  const marketAddress = jobAddress(900);
  history = hosts => hosts.map(address => {
    const record = pageRecord(address);
    record.jobs = record.jobs.map(job => ({ ...job, marketAddress, usdRewardPerHour: 0.37,
      marketName: "sample-market NVIDIA 4090", marketUsdRewardPerHour: 9,
      marketCheckedAtMs: checkedAt - 1000, marketValidUntilMs: checkedAt - 1000 + 300_000 }));
    Object.assign(record.jobs[0]!, { state: "RUNNING", result: null,
      timeStart: Math.floor(checkedAt / 1000) - 30, timeEnd: 0,
      usdRewardPerHour: 99, marketUsdRewardPerHour: 0.37 });
    Object.assign(record.jobs[1]!, { timeStart: Math.floor(checkedAt / 1000) - 10_800,
      timeEnd: Math.floor(checkedAt / 1000) - 3600 });
    Object.assign(record.jobs[2]!, { usdRewardPerHour: null });
    Object.assign(record.jobs[3]!, { marketAddress: null, marketName: null, usdRewardPerHour: null,
      marketUsdRewardPerHour: null, marketCheckedAtMs: null, marketValidUntilMs: null });
    Object.assign(record.jobs[4]!, { state: "RUNNING", result: null, timeEnd: 0,
      marketUsdRewardPerHour: null, usdRewardPerHour: 0.37 });
    Object.assign(record.jobs[6]!, { state: "RUNNING", result: null, timeEnd: 0,
      marketUsdRewardPerHour: 0.37, marketCheckedAtMs: checkedAt - 301_000,
      marketValidUntilMs: checkedAt - 1000 });
    return record;
  });
  await page.goto("/");
  await open(page);
  const item = (index: number) => panel(page).locator(`.job-history-table tbody > tr[data-job="${jobAddress(index)}"]`);
  await expect(item(0).locator('[data-history-col="price"] .job-history-price')).toHaveText("$0.407/h");
  await expect(item(0).locator('[data-history-col="price"]')).toHaveAttribute("data-price-kind", "hourly");
  await expect(item(0).locator(".job-history-price-note")).not.toBeVisible();
  await expect(item(1).locator('[data-history-col="price"] .job-history-price')).toHaveText("$0.814");
  await expect(item(1).locator('[data-history-col="price"]')).toHaveAttribute("data-price-kind", "total");
  await expect(item(1).locator('[data-history-col="duration"]')).toContainText("2h");
  await expect(item(1).locator('[data-history-col="price"]')).not.toContainText("/h");
  for (const index of [2, 3, 4]) {
    await expect(item(index).locator('[data-history-col="price"] .job-history-price')).toHaveText("—");
    await expect(item(index).locator('[data-history-col="price"]')).toHaveAttribute("data-price-kind", "unknown");
  }
  await expect(item(0).locator('[data-history-col="gpu"]')).toHaveText("sample-market NVIDIA 4090");
  await expect(item(1).locator('[data-history-col="gpu"]')).toHaveText("sample-market NVIDIA 4090");
  await expect(item(3).locator('[data-history-col="gpu"]')).toHaveText("—");
  await expect(item(6).locator('[data-history-col="price"] .job-history-price')).toHaveText("$0.407/h");
  await expect(item(6).locator('[data-history-col="price"]')).toHaveAttribute("data-retained", "true");
  await expect(item(6).locator(".job-history-price-note")).toBeVisible();
  await expect(item(6).locator(".job-history-price-note")).toHaveText("Last quoted");
  await source(page).locator("summary").click();
  const original = source(page).locator(`[data-job-source="${jobAddress(1)}"]`);
  await expect(original).toContainText(marketAddress);
  await expect(original).toContainText("0.37");
  await expect(original).toContainText("sample-market NVIDIA 4090");
  await expect(original).toContainText(new Date(checkedAt - 1000).toISOString());
  expect(requests).toHaveLength(1);
});
