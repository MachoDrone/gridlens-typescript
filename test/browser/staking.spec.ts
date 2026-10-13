import { openPreviewTools } from "./helpers.ts";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPreviewServer } from "../../scripts/preview-server.ts";
import { blankStakingRecord, STAKING_DISPLAY_VALIDITY_MS, STAKING_REFRESH_INTERVAL_MS } from "../../src/fleet/staking.ts";
import type { StakingSnapshot } from "../../src/fleet/staking.ts";
import { NOS_MINT } from "../../src/fleet/nos.ts";
import { SYNTHETIC_HOST_ADDRESSES as addresses } from "../fixtures/host-addresses.ts";
import { emptyJobs } from "../fixtures/jobs.ts";
import { emptyQueue } from "../fixtures/queue.ts";
import { emptySol } from "../fixtures/sol.ts";
import { emptyNos } from "../fixtures/nos.ts";

const NOW = Date.UTC(2026, 0, 1, 12);
const MARKET = addresses[7]!;
const preferenceKey = "gridlens.preview.staking-mode.v1";
const servers: Server[] = [];
const directories: string[] = [];
const errors: string[] = [];
const externalRequests: string[] = [];
let origin = "";
type Options = NonNullable<Parameters<typeof startPreviewServer>[0]>;

function snapshot(at = NOW, amounts: (string | null)[] = ["1499999", "1500000", "1500001", "0", null, "9007199254740993", "9007199254740992", null],
  targets: (string | null)[] = ["1500000", "1500000", "1500000", "0", null, "9007199254740993", "9007199254740993", "1500000"],
  roster: readonly string[] = addresses, marketAddress = MARKET): StakingSnapshot {
  return { hosts: roster.map((address, index) => {
    const row = blankStakingRecord(address);
    const evidence = { provider: "Injected public RPC", endpoint: "https://rpc.example.invalid", contextSlot: 456,
      blockTimeMs: at - 1_000, checkedAtMs: at, validUntilMs: at + STAKING_DISPLAY_VALIDITY_MS };
    if (amounts[index] != null) row.stake = { ...row.stake, ...evidence,
      stakeAccount: addresses[(index + 1) % addresses.length]!, vaultAccount: addresses[(index + 2) % addresses.length]!,
      amount: amounts[index]!, recordedAmount: amounts[index]!, xnos: amounts[index]!, durationSeconds: "1209600",
      unstakeAtSeconds: "0", accountState: "initialized" };
    row.requirement = { ...row.requirement, ...evidence, marketAddress,
      targetAmount: targets[index] ?? null, xnosMinimum: targets[index] ?? null };
    row.marketAddress = marketAddress;
    row.marketFetchedAtMs = at;
    return row;
  }), nextRefreshAtMs: at + STAKING_REFRESH_INTERVAL_MS };
}
function metadata(input: readonly string[], at = NOW, marketAddress = MARKET) {
  return { hosts: input.map(address => ({ address, fetchedAtMs: at, retained: false, error: null, marketError: null,
    values: { marketAddress, marketLabel: "sample market", status: null, ram: null, disk: null,
      cpu: null, cuda: null, nvidia: null, currentNode: null, system: null },
  })) };
}
const noState = async (input: readonly string[]) => ({ hosts: input.map(address => ({
  address, values: null, fetchedAtMs: null, validUntilMs: null, retained: false, error: null,
})) });
async function start(stakingProvider: NonNullable<Options["stakingProvider"]>,
  extra: Partial<Pick<Options, "metadataProvider">> = {}, extraRoster: readonly string[] = []): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-staking-browser-"));
  directories.push(directory);
  const hostsFile = join(directory, "hosts.json");
  const real200HostsFile = join(directory, "real200.json");
  await writeFile(hostsFile, JSON.stringify(addresses));
  await writeFile(real200HostsFile, JSON.stringify(extraRoster));
  const server = await startPreviewServer({ now: () => NOW, hostsFile, real200HostsFile, port: 0, stakingProvider,
    metadataProvider: async input => metadata(input), nodeInfoProvider: noState,
    jobProvider: emptyJobs, queueProvider: emptyQueue, solProvider: emptySol, nosProvider: emptyNos, ...extra });
  servers.push(server);
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("Missing isolated preview port");
  origin = `http://127.0.0.1:${bound.port}`;
  return origin;
}
function cell(page: Page, index = 0) {
  return page.locator(`#fleet-rows [data-host="${addresses[index]}"] td[data-col="stakedNos"]`);
}
function toggle(page: Page) {
  return page.getByRole("button", { name: "Toggle Staked NOS display", exact: true });
}
async function showAmounts(page: Page): Promise<void> {
  await expect(toggle(page)).toHaveAttribute("data-mode", "symbols");
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("data-mode", "amounts");
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

test("Staked NOS defaults to exact comparison symbols and toggles amounts without changing reads or sorting", async ({ page }) => {
  let calls = 0;
  await page.goto(await start(async () => { calls++; return snapshot(); }));
  await openPreviewTools(page);
  await expect(toggle(page)).toHaveAttribute("data-mode", "symbols");
  await expect(toggle(page)).toHaveAttribute("aria-describedby", "stakedNos-mode-status");
  await expect(page.locator("#stakedNos-mode-status")).toContainText("checkmark / x");
  for (const [index, text] of ["x", "✓", "✓", "✓", "—", "✓", "x", "—"].entries()) {
    await expect(cell(page, index)).toHaveText(text, { useInnerText: true });
  }
  for (const index of [1, 2, 3, 5]) {
    await expect(cell(page, index).locator(".staking-symbol")).toHaveCSS("color", "rgb(21, 128, 61)");
  }
  for (const index of [0, 6]) {
    await expect(cell(page, index).locator(".staking-symbol")).toHaveCSS("color", "rgb(255, 0, 0)");
  }
  await expect(cell(page).getByRole("button")).toHaveAccessibleName(/below the current target/);
  await expect(cell(page, 3).getByRole("button")).toHaveAccessibleName(/meets the current target/);
  await expect(cell(page, 7).getByRole("button")).toHaveAccessibleName(/comparison unknown/);
  await page.getByRole("button", { name: "Sort by Staked NOS", exact: true }).click();
  const ascending = [addresses[3], addresses[0], addresses[1], addresses[2], addresses[6], addresses[5], addresses[4], addresses[7]];
  expect(await order(page)).toEqual(ascending);
  const valueControl = await cell(page).getByRole("button").elementHandle();
  const toggleControl = await toggle(page).elementHandle();
  await toggle(page).focus();
  await page.keyboard.press("Enter");
  await expect(toggle(page)).toHaveAttribute("data-mode", "amounts");
  await expect(toggle(page)).toBeFocused();
  await expect(cell(page, 6)).toHaveText("9007199255 / 9007199255", { useInnerText: true });
  expect(await order(page)).toEqual(ascending);
  expect(calls).toBe(1);
  expect(await page.evaluate(key => localStorage.getItem(key), preferenceKey)).toBe("amounts");
  await page.keyboard.press("Space");
  await expect(toggle(page)).toHaveAttribute("data-mode", "symbols");
  await expect(cell(page, 6)).toHaveText("x", { useInnerText: true });
  expect(await order(page)).toEqual(ascending);
  expect(calls).toBe(1);
  expect(await valueControl!.evaluate(node => node.isConnected)).toBe(true);
  expect(await toggleControl!.evaluate(node => node.isConnected)).toBe(true);
  await cell(page, 3).getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText("does not establish full market eligibility");
  await page.keyboard.press("Escape");
  await expect(cell(page, 3).getByRole("button")).toBeFocused();
  await toggle(page).click();
  await page.reload();
  await openPreviewTools(page);
  await expect(toggle(page)).toHaveAttribute("data-mode", "amounts");
  await expect(cell(page, 3)).toHaveText("0 / 0", { useInnerText: true });
  expect(await order(page)).toEqual(ascending);
  await toggle(page).click();
  await page.reload();
  await openPreviewTools(page);
  await expect(toggle(page)).toHaveAttribute("data-mode", "symbols");
  await expect(cell(page, 3)).toHaveText("✓", { useInnerText: true });
});

test("invalid and denied Staked NOS storage preserve the symbol default and working toggle", async ({ page }) => {
  await page.goto(await start(async () => snapshot()));
  await openPreviewTools(page);
  await page.evaluate(key => localStorage.setItem(key, "invalid"), preferenceKey);
  await page.reload();
  await openPreviewTools(page);
  await expect(toggle(page)).toHaveAttribute("data-mode", "symbols");
  await expect(cell(page)).toHaveText("x", { useInnerText: true });
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Storage unavailable", "SecurityError"); } });
  });
  await page.reload();
  await openPreviewTools(page);
  await showAmounts(page);
  await expect(cell(page)).toHaveText("1 / 2", { useInnerText: true });
  await toggle(page).click();
  await expect(cell(page)).toHaveText("x", { useInnerText: true });
  await page.getByLabel("Scenario", { exact: true }).selectOption("empty");
  await expect(page.locator("#fleet-rows [data-host]")).toHaveCount(0);
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("data-mode", "amounts");
});

test("retained and expired staking comparisons use gray symbols while missing or mismatched targets stay unknown", async ({ page }) => {
  await page.goto(await start(async () => {
    const result = snapshot();
    result.hosts[0]!.stake.retained = true;
    result.hosts[0]!.stake.error = "Injected stake failure";
    result.hosts[1]!.requirement.retained = true;
    result.hosts[1]!.requirement.error = "Injected target failure";
    result.hosts[2]!.requirement.marketAddress = addresses[6]!;
    return result;
  }, { metadataProvider: async input => metadata(input, await page.evaluate(() => Date.now())) }));
  await openPreviewTools(page);
  for (const [index, text] of ["x", "✓", "—", "✓", "—", "✓", "x", "—"].entries()) {
    await expect(cell(page, index)).toHaveText(text, { useInnerText: true });
  }
  for (const index of [0, 1]) {
    await expect(cell(page, index).locator(".staking-symbol")).toHaveCSS("color", "rgb(136, 136, 136)");
  }
  await expect(cell(page).getByRole("button")).toHaveAccessibleName(/retained comparison/);
  await expect(cell(page, 2).getByRole("button")).toHaveAccessibleName(/comparison unknown/);
  await page.clock.fastForward(STAKING_DISPLAY_VALIDITY_MS);
  for (const [index, text] of [[0, "x"], [1, "✓"], [3, "✓"], [5, "✓"], [6, "x"]] as const) {
    await expect(cell(page, index)).toHaveText(text, { useInnerText: true });
    await expect(cell(page, index).locator(".staking-symbol")).toHaveCSS("color", "rgb(136, 136, 136)");
  }
  for (const index of [2, 4, 7]) {
    await expect(cell(page, index)).toHaveText("—", { useInnerText: true });
  }
});

test("Staked NOS matches reference paint, compares exact amounts and sorts beyond rounded precision", async ({ page }) => {
  await page.goto(await start(async () => {
    const result = snapshot();
    result.hosts[2]!.stake.unstakeAtSeconds = "1767225600";
    result.hosts[2]!.stake.recordedAmount = "2500000";
    result.hosts[2]!.stake.xnos = "3000000";
    return result;
  }));
  await openPreviewTools(page);
  await showAmounts(page);
  for (const [index, text] of ["1 / 2", "2 / 2", "2 / 2", "0 / 0", "—", "9007199255 / 9007199255", "9007199255 / 9007199255", "— / 2"].entries()) {
    await expect(cell(page, index)).toHaveText(text, { useInnerText: true });
  }
  await expect(cell(page)).toHaveCSS("text-align", "center");
  await expect(cell(page).getByRole("button")).toHaveCSS("font-size", "11px");
  await expect(cell(page).getByRole("button")).toHaveCSS("font-weight", "400");
  await expect(cell(page).locator(".staking-actual")).toHaveCSS("color", "rgb(255, 0, 0)");
  await expect(cell(page).locator(".staking-required")).toHaveCSS("color", "rgb(21, 128, 61)");
  for (const index of [1, 2, 3, 5]) {
    await expect(cell(page, index).locator(".staking-actual")).toHaveCSS("color", "rgb(16, 232, 12)");
    await expect(cell(page, index).locator(".staking-required")).toHaveCSS("color", "rgb(21, 128, 61)");
  }
  await expect(cell(page, 6).locator(".staking-actual")).toHaveCSS("color", "rgb(255, 0, 0)");
  await page.getByRole("button", { name: "Sort by Staked NOS", exact: true }).click();
  expect(await order(page)).toEqual([addresses[3], addresses[0], addresses[1], addresses[2], addresses[6], addresses[5], addresses[4], addresses[7]]);
  await page.getByRole("button", { name: "Sort by Staked NOS", exact: true }).click();
  expect(await order(page)).toEqual([addresses[5], addresses[6], addresses[2], addresses[1], addresses[0], addresses[3], addresses[4], addresses[7]]);
  await cell(page, 2).getByRole("button").click();
  for (const text of [addresses[2]!, NOS_MINT, "1.500001", "1500001", "2.5 NOS", "Recorded duration-weighted xNOS: 3",
    "Unstaking/releasing", "Staking account", "Staking vault", "NOS target (node display convention)",
    "On-chain duration-weighted xNOS minimum", "Injected public RPC", "API check time", "does not establish full market eligibility"]) {
    await expect(page.getByRole("dialog")).toContainText(text);
  }
  await page.keyboard.press("Escape");
  await expect(cell(page, 2).getByRole("button")).toBeFocused();
});

test("market changes hide the prior comparison immediately and fetch the new target using retained vault evidence", async ({ page }) => {
  let market = MARKET;
  let calls = 0;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.goto(await start(async () => {
    if (++calls === 2) await pending;
    return snapshot(NOW, ["1500000"], [calls === 1 ? "1000000" : "2000000"], addresses, market);
  }, { metadataProvider: async input => metadata(input, NOW, market) }));
  await openPreviewTools(page);
  await showAmounts(page);
  await expect(cell(page)).toHaveText("2 / 1", { useInnerText: true });
  await expect(cell(page).locator(".staking-actual")).toHaveCSS("color", "rgb(16, 232, 12)");
  const control = await cell(page).getByRole("button").elementHandle();
  market = addresses[6]!;
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect.poll(() => calls).toBe(2);
  await expect(cell(page)).toHaveText("2 / —", { useInnerText: true });
  await expect(cell(page).locator(".staking-actual")).toHaveCSS("color", "rgb(21, 128, 61)");
  await toggle(page).click();
  await expect(cell(page)).toHaveText("—", { useInnerText: true });
  await toggle(page).click();
  release();
  await expect(cell(page)).toHaveText("2 / 2", { useInnerText: true });
  await expect(cell(page).locator(".staking-actual")).toHaveCSS("color", "rgb(255, 0, 0)");
  expect(await control!.evaluate(node => node.isConnected)).toBe(true);
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  expect(calls).toBe(2);
});

test("staking refreshes every 30 minutes, preserves focus and grays independent failures without changing evidence", async ({ page }) => {
  let calls = 0;
  await page.goto(await start(async () => {
    const at = await page.evaluate(() => Date.now());
    const result = snapshot(at, [++calls === 1 ? "2000000" : "500000"], ["1000000"]);
    if (calls === 3) {
      result.hosts[0]!.stake = { ...snapshot(NOW + STAKING_REFRESH_INTERVAL_MS, ["500000"], ["1000000"]).hosts[0]!.stake,
        retained: true, error: "Injected stake batch failure" };
    }
    return result;
  }, { metadataProvider: async input => metadata(input, await page.evaluate(() => Date.now())) }));
  await openPreviewTools(page);
  await showAmounts(page);
  await expect(cell(page)).toHaveText("2 / 1", { useInnerText: true });
  const control = await cell(page).getByRole("button").elementHandle();
  await cell(page).getByRole("button").click();
  await page.clock.fastForward(STAKING_REFRESH_INTERVAL_MS);
  await expect(cell(page)).toHaveText("1 / 1", { useInnerText: true });
  expect(calls).toBe(2);
  expect(await control!.evaluate(node => node.isConnected)).toBe(true);
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(cell(page).getByRole("button")).toBeFocused();
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect(cell(page)).toHaveAttribute("data-staking-state", "current");
  await page.clock.fastForward(STAKING_REFRESH_INTERVAL_MS);
  await expect.poll(() => calls).toBe(3);
  await expect(cell(page).locator(".staking-actual")).toHaveCSS("color", "rgb(136, 136, 136)");
  await cell(page).getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText("Injected stake batch failure");
  await expect(page.getByRole("dialog")).toContainText("2026-01-01T12:30:00.000Z");
});

test("35-minute expiry and metadata failure disable comparisons while retained amounts stay visible", async ({ page }) => {
  let calls = 0;
  let failMetadata = false;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.goto(await start(async () => {
    if (++calls > 1) await pending;
    return snapshot();
  }, { metadataProvider: async input => {
    const result = metadata(input, await page.evaluate(() => Date.now()));
    if (failMetadata) return { hosts: result.hosts.map(record => ({ ...record, retained: true, error: "Injected metadata failure" })) };
    return result;
  } }));
  await openPreviewTools(page);
  await showAmounts(page);
  await expect(cell(page, 3)).toHaveText("0 / 0", { useInnerText: true });
  failMetadata = true;
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect(cell(page, 3).locator(".staking-required")).toHaveCSS("color", "rgb(136, 136, 136)");
  await expect(cell(page).locator(".staking-actual")).toHaveCSS("color", "rgb(21, 128, 61)");
  await expect(cell(page, 3).locator(".staking-actual")).toHaveCSS("color", "rgb(21, 128, 61)");
  await page.clock.fastForward(STAKING_REFRESH_INTERVAL_MS);
  await expect.poll(() => calls).toBe(2);
  await page.clock.fastForward(STAKING_DISPLAY_VALIDITY_MS - STAKING_REFRESH_INTERVAL_MS);
  await expect(cell(page, 3)).toHaveText("0 / 0", { useInnerText: true });
  await expect(cell(page, 3).locator(".staking-actual")).toHaveCSS("color", "rgb(136, 136, 136)");
  release();
});

test("visible staking reads continue without focus, cancel on hide/pagehide and reject late responses", async ({ page }) => {
  let calls = 0;
  let canceled = false;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.goto(await start(async (_input, signal) => {
    const call = ++calls;
    if (call === 3) {
      signal?.addEventListener("abort", () => { canceled = true; }, { once: true });
      await pending;
    }
    return snapshot(await page.evaluate(() => Date.now()), [call === 3 ? "99000000" : call === 2 ? "2000000" : "1000000"], ["1000000"]);
  }));
  await openPreviewTools(page);
  await showAmounts(page);
  await expect(cell(page)).toHaveText("1 / 1", { useInnerText: true });
  await page.evaluate(() => {
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
    window.dispatchEvent(new Event("blur"));
  });
  await page.clock.fastForward(STAKING_REFRESH_INTERVAL_MS);
  await expect(cell(page)).toHaveText("2 / 1", { useInnerText: true });
  await page.clock.fastForward(STAKING_REFRESH_INTERVAL_MS);
  await expect.poll(() => calls).toBe(3);
  await visibility(page, "hidden");
  await expect.poll(() => canceled).toBe(true);
  await page.clock.fastForward(STAKING_REFRESH_INTERVAL_MS);
  expect(calls).toBe(3);
  await visibility(page, "visible");
  await expect.poll(() => calls).toBe(4);
  await expect(cell(page)).toHaveText("1 / 1", { useInnerText: true });
  release();
  await expect(cell(page)).toHaveText("1 / 1", { useInnerText: true });
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await page.clock.fastForward(STAKING_REFRESH_INTERVAL_MS);
  expect(calls).toBe(4);
});

test("two viewers share pending staking reads and only last-viewer cancellation stops provider work", async ({ page, context }) => {
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
  await showAmounts(page);
  await expect.poll(() => calls).toBe(1);
  const other = await context.newPage();
  await other.goto(origin);
  await openPreviewTools(other);
  await expect(other.locator("#staking-status")).toContainText("Reading confirmed staking");
  await visibility(page, "hidden");
  expect(canceled).toBe(false);
  expect(calls).toBe(1);
  await visibility(page, "visible");
  release();
  await expect(cell(page)).toHaveText("1 / 2", { useInnerText: true });
  await expect(cell(other)).toHaveText("1 / 2", { useInnerText: true });
  expect(calls).toBe(1);
});

test("invalid staking identities and future timestamps retain prior readings gray", async ({ page }) => {
  let calls = 0;
  await page.goto(await start(async () => {
    const at = await page.evaluate(() => Date.now());
    const result = snapshot(at);
    if (++calls === 2) result.hosts[1]!.address = result.hosts[0]!.address;
    if (calls === 3) {
      result.hosts[0]!.stake.checkedAtMs = at + 16_000;
      result.hosts[0]!.stake.validUntilMs = at + 16_000 + STAKING_DISPLAY_VALIDITY_MS;
    }
    return result;
  }));
  await openPreviewTools(page);
  await showAmounts(page);
  await expect(cell(page)).toHaveText("1 / 2", { useInnerText: true });
  for (let attempt = 2; attempt <= 3; attempt++) {
    await page.clock.fastForward(STAKING_REFRESH_INTERVAL_MS);
    await expect.poll(() => calls).toBe(attempt);
    await expect(cell(page)).toHaveText("1 / 2", { useInnerText: true });
    await expect(cell(page).locator(".staking-actual")).toHaveCSS("color", "rgb(136, 136, 136)");
  }
});

test("staking reads only the chosen startup roster and leaves synthetic scenarios isolated", async ({ page }) => {
  const reads: string[][] = [];
  const roster = addresses.slice(0, 2);
  await page.goto(`${await start(async input => {
    reads.push([...input]);
    return snapshot(NOW, input.map(() => "500000"), input.map(() => "0"), input);
  }, {}, roster)}/?scenario=real200`);
  await openPreviewTools(page);
  await showAmounts(page);
  await expect(cell(page)).toHaveText("1 / 0", { useInnerText: true });
  expect(reads).toEqual([roster]);
  await expect(page.locator("#fleet-rows [data-host]")).toHaveCount(2);
  await page.getByLabel("Scenario", { exact: true }).selectOption("mixed");
  await expect(page.locator("#staking-status")).toBeHidden();
  await page.clock.fastForward(STAKING_REFRESH_INTERVAL_MS);
  expect(reads).toEqual([roster]);
  await page.getByLabel("Scenario", { exact: true }).selectOption("supplied");
  await expect(page.locator("#fleet-rows [data-host]")).toHaveCount(addresses.length);
  await expect.poll(() => reads).toEqual([roster, addresses]);
});
