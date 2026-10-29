import { openPreviewTools } from "./helpers.ts";
import { emptyStaking } from "../fixtures/staking.ts";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPreviewServer } from "../../scripts/preview-server.ts";
import { NOS_MINT } from "../../src/fleet/nos.ts";
import type { NosSnapshot } from "../../src/fleet/nos.ts";
import { SYNTHETIC_HOST_ADDRESSES as addresses } from "../fixtures/host-addresses.ts";
import { emptyJobs } from "../fixtures/jobs.ts";
import { emptyQueue } from "../fixtures/queue.ts";
import { emptySol } from "../fixtures/sol.ts";

const NOW = Date.UTC(2026, 0, 1, 12);
const servers: Server[] = [];
const directories: string[] = [];
const errors: string[] = [];
const externalRequests: string[] = [];
let origin = "";
type Options = NonNullable<Parameters<typeof startPreviewServer>[0]>;

function snapshot(at = NOW, amounts: (string | null)[] = ["123500000", "123499999", "0", null, "9007199254740993", "9007199254740992", null, null], roster: readonly string[] = addresses): NosSnapshot {
  return { hosts: roster.map((address, index) => ({
    address, tokenAccount: addresses[(index + 1) % addresses.length]!, mint: NOS_MINT,
    amount: amounts[index] ?? null, decimals: 6, accountState: amounts[index] == null ? null : "initialized",
    provider: "Injected public RPC", endpoint: "https://rpc.example.invalid",
    contextSlot: 456, blockTimeMs: at - 1_000, checkedAtMs: at, validUntilMs: at + 180_000,
    retained: false, error: null, retryAtMs: null,
  })), nextRefreshAtMs: at + 120_000 };
}
const noMetadata = async (input: readonly string[]) => ({ hosts: input.map(address => ({
  address, values: null, fetchedAtMs: null, retained: false, error: null, marketError: null,
})) });
const noState = async (input: readonly string[]) => ({ hosts: input.map(address => ({
  address, values: null, fetchedAtMs: null, validUntilMs: null, retained: false, error: null,
})) });

async function start(nosProvider: NonNullable<Options["nosProvider"]>, extraRoster?: readonly string[], now = () => NOW): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-nos-browser-"));
  directories.push(directory);
  const hostsFile = join(directory, "hosts.json");
  await writeFile(hostsFile, JSON.stringify(addresses));
  const real200HostsFile = join(directory, "real200.json");
  await writeFile(real200HostsFile, JSON.stringify(extraRoster ?? []));
  const server = await startPreviewServer({ now, stakingProvider: emptyStaking, hostsFile, real200HostsFile, port: 0, nosProvider,
    metadataProvider: noMetadata, nodeInfoProvider: noState, jobProvider: emptyJobs, queueProvider: emptyQueue,
    solProvider: emptySol,
  });
  servers.push(server);
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("Missing isolated preview port");
  origin = `http://127.0.0.1:${bound.port}`;
  return origin;
}
function cell(page: Page, index = 0) {
  return page.locator(`#fleet-rows [data-host="${addresses[index]}"] td[data-col="nos"]`);
}
async function order(page: Page): Promise<string[]> {
  return page.locator("#fleet-rows [data-host]").evaluateAll(rows => rows.map(row => row.getAttribute("data-host")!));
}
async function visibility(page: Page, state: "visible" | "hidden"): Promise<void> {
  await page.evaluate(value => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => value === "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
  if (state === "visible") await page.clock.runFor(1);
}

test.beforeEach(async ({ page, context }) => {
  origin = "";
  errors.length = externalRequests.length = 0;
  await page.clock.install({ time: NOW });
  await page.clock.pauseAt(NOW);
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) {
      externalRequests.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  page.on("pageerror", error => errors.push(error.message));
});
test.afterEach(async ({ context }) => {
  for (const page of context.pages()) await page.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  expect(externalRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test("plain NOS values retain reference paint, rounded amounts, exact sorting and absent/frozen balances", async ({ page }) => {
  await page.goto(await start(async () => {
    const result = snapshot();
    result.hosts[2]!.accountState = "absent";
    result.hosts[4]!.accountState = "frozen";
    return result;
  }));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveText("124");
  await expect(cell(page, 1)).toHaveText("123");
  await expect(cell(page, 2)).toHaveText("0");
  await expect(cell(page, 3)).toHaveText("—");
  await expect(cell(page, 4)).toHaveText("9007199255");
  await expect(cell(page, 5)).toHaveText("9007199255");
  await expect(cell(page)).toHaveCSS("text-align", "center");
  await expect(cell(page).locator("span.nos-value")).toHaveCSS("font-size", "11px");
  await expect(cell(page).locator(".nos-value")).toHaveCSS("font-weight", "400");
  await expect(cell(page).locator(".nos-value")).toHaveCSS("color", "rgb(21, 128, 61)");
  await expect(page.locator("#column-headings th[data-col]")).toHaveCount(28);
  await page.getByRole("button", { name: "Sort by NOS", exact: true }).click();
  expect(await order(page)).toEqual([addresses[2], addresses[1], addresses[0], addresses[5], addresses[4], addresses[3], addresses[6], addresses[7]]);
  await page.getByRole("button", { name: "Sort by NOS", exact: true }).click();
  expect(await order(page)).toEqual([addresses[4], addresses[5], addresses[0], addresses[1], addresses[2], addresses[3], addresses[6], addresses[7]]);
  await page.getByRole("button", { name: "Column info", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Additional wallet token accounts, staking and claimable rewards are excluded");
  await page.keyboard.press("Escape");
  for (const index of [0, 2, 4]) {
    const value = cell(page, index).locator("span.nos-value");
    await expect(cell(page, index).getByRole("button")).toHaveCount(0);
    await expect(cell(page, index)).not.toHaveAttribute("title");
    await expect(value).not.toHaveAttribute("title");
    await expect(value).toHaveAttribute("aria-label", /NOS:/);
    expect(await value.getAttribute("aria-label")).not.toContain("Open details");
    await value.click();
    await expect(page.getByRole("dialog")).toBeHidden();
  }
  await expect(cell(page, 2)).toHaveAttribute("data-nos-state", "current");
  await expect(cell(page, 4)).toHaveAttribute("data-nos-state", "current");
});

test("two-minute refresh detects increases/decreases and preserves connected values, header focus and steady summaries", async ({ page }) => {
  let calls = 0;
  await page.goto(await start(async () => {
    const amounts = calls++ === 0 ? ["1000000"] : calls === 2 ? ["2500000"] : ["750000"];
    return snapshot(await page.evaluate(() => Date.now()), amounts);
  }));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveText("1");
  const saved = await cell(page).locator("span.nos-value").elementHandle();
  const status = await page.locator("#nos-status").textContent();
  const refresh = page.getByRole("button", { name: "Refresh view", exact: true });
  await refresh.focus();
  await page.clock.fastForward(120_000);
  await expect(cell(page)).toHaveText("3");
  expect(await saved!.evaluate(node => node.isConnected)).toBe(true);
  await expect(page.locator("#nos-status")).toHaveText(status!);
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(refresh).toBeFocused();
  await refresh.click();
  await page.clock.fastForward(119_999);
  expect(calls).toBe(2);
  await page.clock.fastForward(1);
  await expect(cell(page)).toHaveText("1");
  expect(calls).toBe(3);
});

test("pending reads expire after three minutes without loading churn and failures retain amounts including zero", async ({ page }) => {
  let calls = 0;
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  await page.goto(await start(async () => {
    calls++;
    if (calls === 2) await delayed;
    if (calls === 2) return { hosts: snapshot().hosts.map(record => ({ ...record, retained: record.amount !== null,
      error: "Injected RPC unavailable (429)", retryAtMs: NOW + 240_000,
    })), nextRefreshAtMs: NOW + 240_000 };
    return snapshot(await page.evaluate(() => Date.now()));
  }));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveAttribute("data-nos-state", "current");
  const initialStatus = await page.locator("#nos-status").textContent();
  await page.clock.fastForward(120_000);
  await expect.poll(() => calls).toBe(2);
  await expect(page.locator("#nos-status")).toHaveText(initialStatus!);
  await page.clock.fastForward(60_000);
  await expect(cell(page)).toHaveAttribute("data-nos-state", "retained");
  await expect(cell(page).locator("span.nos-value")).toHaveCSS("color", "rgb(136, 136, 136)");
  await expect(cell(page, 2)).toHaveText("0");
  await expect(cell(page, 2)).toHaveAttribute("data-nos-state", "retained");
  release();
  await expect(page.locator("#nos-status")).toContainText("Next eligible retry");
  await expect(cell(page)).toHaveText("124");
  await expect(cell(page).locator(".nos-value")).toHaveClass(/nos-retained/);
  await expect(cell(page, 2)).toHaveText("0");
  await expect(cell(page, 2).locator(".nos-value")).toHaveClass(/nos-retained/);
  await page.clock.fastForward(60_000);
  await expect(cell(page)).toHaveAttribute("data-nos-state", "current");
  expect(calls).toBe(3);
});

test("NOS polls unfocused visible pages, cancels hidden work and resumes overdue without accepting old results", async ({ page }) => {
  let calls = 0;
  let serverNow = NOW;
  let canceled = false;
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  await page.goto(await start(async (_input, signal) => {
    const call = ++calls;
    if (call === 3) {
      signal?.addEventListener("abort", () => { canceled = true; }, { once: true });
      await delayed;
    }
    const at = await page.evaluate(() => Date.now());
    // The resumed reply is emitted now even though earlier observations and
    // canceled work retain their original source times.
    serverNow = at;
    return snapshot(at, [call === 3 ? "99000000" : call === 2 ? "2000000" : "1000000"]);
  }, undefined, () => serverNow));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveText("1");
  await page.evaluate(() => {
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
    window.dispatchEvent(new Event("blur"));
  });
  await page.clock.fastForward(120_000);
  await expect.poll(() => calls).toBe(2);
  await expect(cell(page)).toHaveText("2");
  await page.clock.fastForward(120_000);
  await expect.poll(() => calls).toBe(3);
  await visibility(page, "hidden");
  await expect.poll(() => canceled).toBe(true);
  await page.clock.fastForward(300_000);
  expect(calls).toBe(3);
  await visibility(page, "visible");
  await expect.poll(() => calls).toBe(4);
  await expect(cell(page)).toHaveAttribute("data-nos-state", "current");
  release();
  await expect(cell(page)).toHaveText("1");
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await page.clock.fastForward(300_000);
  expect(calls).toBe(4);
});

test("two viewers share pending NOS work and one hidden viewer cannot cancel the other", async ({ page, context }) => {
  let calls = 0;
  let canceled = false;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.goto(await start(async (_input, signal) => {
    calls++;
    signal?.addEventListener("abort", () => { canceled = true; }, { once: true });
    await pending;
    return snapshot();
  }));
  await openPreviewTools(page);
  await expect.poll(() => calls).toBe(1);
  const other = await context.newPage();
  await other.goto(origin);
  await openPreviewTools(other);
  await expect(other.locator("#nos-status")).toContainText("Reading confirmed NOS balances");
  await visibility(page, "hidden");
  expect(canceled).toBe(false);
  expect(calls).toBe(1);
  await visibility(page, "visible");
  release();
  await expect(cell(page)).toHaveText("124");
  await expect(cell(other)).toHaveText("124");
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await other.getByRole("button", { name: "Refresh view", exact: true }).click();
  expect(calls).toBe(1);
  expect(canceled).toBe(false);
});

test("invalid identities and future times gray immediately; partial failures preserve each host's evidence", async ({ page }) => {
  let calls = 0;
  await page.goto(await start(async () => {
    calls++;
    const at = await page.evaluate(() => Date.now());
    const result = snapshot(at);
    if (calls === 2) result.hosts[1]!.address = result.hosts[0]!.address;
    if (calls === 3) {
      result.hosts[0]!.checkedAtMs = at + 16_000;
      result.hosts[0]!.validUntilMs = at + 196_000;
    }
    if (calls === 4) {
      result.hosts[0] = { ...snapshot().hosts[0]!, retained: true, error: "Only this batch failed", retryAtMs: at + 120_000 };
      result.hosts[1]!.amount = "4000000";
      result.hosts.reverse();
    }
    return result;
  }));
  await openPreviewTools(page);
  await expect(cell(page)).toHaveText("124");
  for (let attempt = 2; attempt <= 3; attempt++) {
    await page.clock.fastForward(120_000);
    await expect.poll(() => calls).toBe(attempt);
    await expect(cell(page)).toHaveAttribute("data-nos-state", "retained");
    await expect(cell(page)).toHaveText("124");
    await expect(cell(page, 1)).toHaveText("123");
  }
  await page.clock.fastForward(120_000);
  await expect(cell(page, 1)).toHaveText("4");
  await expect(cell(page, 1)).toHaveAttribute("data-nos-state", "current");
  await expect(cell(page)).toHaveAttribute("data-nos-state", "retained");
  await expect(cell(page, 2)).toHaveText("0");
  await expect(cell(page, 3)).toHaveText("—");
});

test("only selected startup roster requests NOS; synthetic scenarios stay isolated", async ({ page }) => {
  const reads: string[][] = [];
  const roster = addresses.slice(0, 2);
  await page.goto(`${await start(async input => {
    reads.push([...input]);
    return snapshot(await page.evaluate(() => Date.now()), input.map(() => "500000"), input);
  }, roster)}/?scenario=real200`);
  await openPreviewTools(page);
  await expect(cell(page)).toHaveText("1");
  expect(reads).toEqual([roster]);
  await expect(page.locator("#fleet-rows [data-host]")).toHaveCount(2);
  await page.getByLabel("Scenario", { exact: true }).selectOption("mixed");
  await expect(page.locator("#nos-status")).toBeHidden();
  await page.clock.fastForward(300_000);
  expect(reads).toEqual([roster]);
  await page.getByLabel("Scenario", { exact: true }).selectOption("supplied");
  await expect(page.locator("#fleet-rows [data-host]")).toHaveCount(addresses.length);
  await expect.poll(() => reads).toEqual([roster, addresses]);
});
