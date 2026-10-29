import { openPreviewTools } from "./helpers.ts";
import { emptyStaking } from "../fixtures/staking.ts";
import { emptyNos } from "../fixtures/nos.ts";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPreviewServer } from "../../scripts/preview-server.ts";
import type { SolSnapshot } from "../../src/fleet/sol.ts";
import { SYNTHETIC_HOST_ADDRESSES as defaultHosts } from "../fixtures/host-addresses.ts";
import { emptyJobs } from "../fixtures/jobs.ts";
import { emptyQueue } from "../fixtures/queue.ts";
import { emptySol } from "../fixtures/sol.ts";

// Fixture identifiers encode small public integers, never real host identities.
function fixtureAddress(value: number): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let encoded = "";
  let remaining = value;
  while (remaining) { encoded = alphabet[remaining % 58]! + encoded; remaining = Math.floor(remaining / 58); }
  return "1".repeat(32 - Math.ceil(Math.log2(value + 1) / 8)) + encoded;
}
const real200Hosts = Array.from({ length: 200 }, (_, index) => fixtureAddress(index + 1));
const servers: Server[] = [];
const directories: string[] = [];
const errors: string[] = [];
const externalRequests: string[] = [];
type Read = { kind: string; addresses: readonly string[] };
type Options = NonNullable<Parameters<typeof startPreviewServer>[0]>;
let origin = "";

async function start({ hosts = real200Hosts, solProvider = emptySol, jobProvider = emptyJobs, now = Date.now }: {
  now?: () => number;
  hosts?: readonly string[] | null;
  solProvider?: NonNullable<Options["solProvider"]>;
  jobProvider?: NonNullable<Options["jobProvider"]>;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-real200-browser-"));
  directories.push(directory);
  const hostsFile = join(directory, "hosts.json");
  const real200HostsFile = join(directory, "real200.json");
  await writeFile(hostsFile, JSON.stringify(defaultHosts));
  if (hosts !== null) await writeFile(real200HostsFile, JSON.stringify(hosts));
  const reads: Read[] = [];
  const remember = (kind: string, addresses: readonly string[]) => { reads.push({ kind, addresses: [...addresses] }); };
  const server = await startPreviewServer({
    hostsFile, real200HostsFile, port: 0, now,
    metadataProvider: async addresses => {
      remember("metadata", addresses);
      return { hosts: addresses.map(address => ({ address, values: null, fetchedAtMs: null,
        retained: false, error: null, marketError: null })) };
    },
    nodeInfoProvider: async addresses => {
      remember("node-info", addresses);
      return { hosts: addresses.map(address => ({ address, values: null, fetchedAtMs: null,
        validUntilMs: null, retained: false, error: null })) };
    },
    jobProvider: async (addresses, signal) => { remember("jobs", addresses); signal?.throwIfAborted(); return jobProvider(addresses, signal); },
    queueProvider: async (addresses, signal) => { remember("queue", addresses); signal?.throwIfAborted(); return emptyQueue(addresses); },
    solProvider: async (addresses, signal) => { remember("sol", addresses); return solProvider(addresses, signal); },
    nosProvider: async (addresses, signal) => { remember("nos", addresses); signal?.throwIfAborted(); return emptyNos(addresses); },
    stakingProvider: async (addresses, signal) => { remember("staking", addresses); signal?.throwIfAborted(); return emptyStaking(addresses); },
  });
  servers.push(server);
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("Missing isolated preview port");
  origin = `http://127.0.0.1:${bound.port}`;
  return { origin, reads, hostsFile, real200HostsFile };
}

function balances(addresses: readonly string[], lamports: string): SolSnapshot {
  const now = Date.now();
  return { hosts: addresses.map(address => ({
    address, lamports, provider: "Injected fixture", endpoint: "https://rpc.example.invalid",
    contextSlot: 123, blockTimeMs: now, checkedAtMs: now, validUntilMs: now + 60_000,
    retained: false, error: null, retryAtMs: null,
  })), nextRefreshAtMs: now + 30_000 };
}

async function addresses(page: Page): Promise<string[]> {
  return page.locator("#fleet-rows [data-host]").evaluateAll(rows => rows.map(row => row.getAttribute("data-host")!));
}

test.beforeEach(async ({ page, context }) => {
  origin = "";
  errors.length = externalRequests.length = 0;
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
  expect(externalRequests, "All providers are injected; browser traffic stays on the isolated server").toEqual([]);
  expect(errors).toEqual([]);
});

test("Real200 renders its 200 supplied addresses and routes every data feed to only that roster", async ({ page }) => {
  const fixture = await start();
  const dataRequests: URL[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    // Connection liveness has no roster and does not dispatch provider reads.
    if (url.pathname.endsWith(".json") && url.pathname !== "/preview/connection.json") dataRequests.push(url);
  });
  await page.goto(`${fixture.origin}/?scenario=real200`);
  await openPreviewTools(page);
  await expect(page.getByLabel("Scenario", { exact: true })).toHaveValue("real200");
  await expect(page.locator("#data-label")).toHaveText("Real200");
  await expect(page.locator("#host-count")).toHaveText("200 hosts");
  await expect(page.locator('#fleet-rows [data-source="supplied"]')).toHaveCount(200);
  await expect(page.locator("#input-error")).toBeHidden();
  expect(await addresses(page)).toEqual(real200Hosts);
  expect(await page.locator('#scenario > option[value="real200"]').textContent()).toBe("Real200");
  expect(await page.locator('#fleet-rows td[data-col]:not([data-col="hostAddress"]):not([data-col="api"]):not([data-col="state"]):not([data-col="duration"]):not([data-col="latestJob"])').allTextContents()).toEqual(Array(200 * 23).fill("—"));
  await expect(page.locator('.job-summary-link')).toHaveText(Array(200).fill("—"));
  await expect(page.locator('.job-summary-state')).toHaveText(Array(200).fill("Unknown"));
  await expect(page.locator('.job-history-row')).toHaveCount(0);
  expect(await page.locator('#fleet-rows td[data-col="api"]').allTextContents()).toEqual(Array(200).fill("Populating.."));
  const unknownStates = page.locator('#fleet-rows td[data-col="state"][data-state="unknown"][data-state-current="false"]');
  await expect(unknownStates.locator(".state-unknown .state-dots")).toHaveCount(200);
  await expect(unknownStates.getByRole("button", { name: /unknown/ })).toHaveCount(200);
  await expect(page.locator('#fleet-rows td[data-col="duration"]')).toHaveText(Array(200).fill("Populating.."));
  await expect.poll(() => fixture.reads.length).toBe(7);
  expect(fixture.reads.map(read => read.kind).sort()).toEqual(["jobs", "metadata", "node-info", "nos", "queue", "sol", "staking"]);
  for (const read of fixture.reads) expect(read.addresses).toEqual(real200Hosts);
  expect(dataRequests.map(url => url.pathname).sort()).toEqual([
    "/preview/hosts.json", "/preview/jobs.json", "/preview/metadata.json",
    "/preview/node-info.json", "/preview/nos.json", "/preview/queue.json", "/preview/sol.json", "/preview/staking.json",
  ]);
  expect(dataRequests.every(url => url.search === "?scenario=real200")).toBe(true);
  expect(await readFile(fixture.hostsFile, "utf8")).toBe(JSON.stringify(defaultHosts));
  expect(await readFile(fixture.real200HostsFile, "utf8")).toBe(JSON.stringify(real200Hosts));
});

test("default, Real200 and synthetic views remain separate while switching preserves unrelated URL parameters", async ({ page }) => {
  const fixture = await start({ solProvider: async input => balances(input, input.length === 200 ? "2222222" : "1111111") });
  await page.goto(`${fixture.origin}/?layout=compact`);
  await openPreviewTools(page);
  await expect(page.locator("#host-count")).toHaveText("8 hosts");
  expect(await addresses(page)).toEqual(defaultHosts);
  await expect(page.locator('td[data-col="sol"]').first()).toHaveText("0.001");
  await page.getByLabel("Scenario", { exact: true }).selectOption("real200");
  await expect(page).toHaveURL(`${fixture.origin}/?layout=compact&scenario=real200`);
  await expect(page.locator("#host-count")).toHaveText("200 hosts");
  expect(await addresses(page)).toEqual(real200Hosts);
  await expect(page.locator('td[data-col="sol"]').first()).toHaveText("0.002");
  await page.getByLabel("Scenario", { exact: true }).selectOption("mixed");
  await expect(page.locator("#data-label")).toHaveText("Sample data");
  await expect(page.locator("#host-count")).toHaveText("6 hosts");
  await expect(page.locator('#fleet-rows [data-source="supplied"]')).toHaveCount(0);
  await page.getByLabel("Scenario", { exact: true }).selectOption("real200");
  await expect(page.locator("#host-count")).toHaveText("200 hosts");
  expect(await addresses(page)).toEqual(real200Hosts);
  await expect(page.locator('td[data-col="sol"]').first()).toHaveText("0.002");
  await page.getByLabel("Scenario", { exact: true }).selectOption("supplied");
  await expect(page).toHaveURL(`${fixture.origin}/?layout=compact&scenario=supplied`);
  await expect(page.locator("#host-count")).toHaveText("8 hosts");
  expect(await addresses(page)).toEqual(defaultHosts);
  await expect(page.locator('td[data-col="sol"]').first()).toHaveText("0.001");
  await expect(page.locator("#data-label")).toHaveText("Supplied addresses");
  for (const read of fixture.reads) expect(read.addresses).toEqual(read.addresses.length === 200 ? real200Hosts : defaultHosts);
});

test("switching populated Real200 to supplied hosts loads only the supplied roster's Duration evidence", async ({ page }) => {
  const now = Date.UTC(2026, 0, 1, 12);
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  const jobAddresses = (large: boolean) => (large ? real200Hosts : defaultHosts)
    .map((_address, index) => fixtureAddress((large ? 1_000 : 2_000) + index));
  const fixture = await start({ now: () => now, jobProvider: async input => {
    const large = input.length === 200;
    const jobs = jobAddresses(large);
    return { hosts: input.map((address, index) => ({
      address, job: { address: jobs[index]!, node: address, state: "RUNNING",
        timeStart: now / 1_000 - (large ? 120 : 300), timeEnd: 0, timeout: large ? 600 : 1_200 },
      checkedAtMs: now, validUntilMs: now + 180_000, failedAtMs: null,
      retained: false, pending: false, retryAtMs: null, error: null,
    })), nextRefreshAtMs: now + 120_000 };
  } });
  const durationCells = page.locator('#fleet-rows td[data-col="duration"]');
  const currentDurations = page.locator('#fleet-rows td[data-col="duration"][data-duration-kind="duration"][data-duration-freshness="current"]');
  const displayedJobs = () => durationCells.evaluateAll(cells => cells.map(cell => cell.getAttribute("data-job-address")));

  await page.goto(`${fixture.origin}/?scenario=real200`);
  await expect(currentDurations).toHaveCount(200);
  expect(await displayedJobs()).toEqual(jobAddresses(true));
  await expect(durationCells.getByRole("button", { name: /Duration for .*: 2m \/ 10m\./ })).toHaveCount(200);

  await page.getByLabel("Scenario", { exact: true }).selectOption("supplied");
  await expect(page).toHaveURL(`${fixture.origin}/?scenario=supplied`);
  await expect(currentDurations).toHaveCount(defaultHosts.length);
  expect(await addresses(page)).toEqual(defaultHosts);
  expect(await displayedJobs()).toEqual(jobAddresses(false));
  await expect(durationCells.getByRole("button", { name: /Duration for .*: 5m \/ 20m\./ })).toHaveCount(defaultHosts.length);
  expect(fixture.reads.filter(read => read.kind === "jobs").map(read => read.addresses))
    .toEqual([real200Hosts, defaultHosts]);
});

for (const destination of ["mixed", "supplied"] as const) {
  test(`leaving unfinished Real200 work for ${destination} aborts it and ignores the late response`, async ({ page }) => {
    let release!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    let pendingSignal: AbortSignal | undefined;
    let firstReal200 = true;
    const fixture = await start({ solProvider: async (input, signal) => {
      if (input.length === 200 && firstReal200) {
        firstReal200 = false;
        pendingSignal = signal;
        await delayed; // Deliberately misbehaving provider resolves after cancellation.
        return balances(input, "999000000");
      }
      return balances(input, input.length === 200 ? "2222222" : "1111111");
    } });
    await page.goto(`${fixture.origin}/?scenario=real200`);
    await openPreviewTools(page);
    await expect(page.locator("#host-count")).toHaveText("200 hosts");
    await expect.poll(() => pendingSignal !== undefined).toBe(true);
    await page.getByLabel("Scenario", { exact: true }).selectOption(destination);
    await expect(page.locator("#host-count")).toHaveText(destination === "mixed" ? "6 hosts" : "8 hosts");
    await expect.poll(() => pendingSignal?.aborted).toBe(true);
    release();
    await page.getByLabel("Scenario", { exact: true }).selectOption("real200");
    await expect(page.locator("#host-count")).toHaveText("200 hosts");
    await expect(page.locator('td[data-col="sol"]').first()).toHaveText("0.002");
    expect(await addresses(page)).toEqual(real200Hosts);
    expect(await page.locator('td[data-col="sol"]').allTextContents()).toEqual(Array(200).fill("0.002"));
  });
}

test("Real200 uses the actual supplied count rather than implying 200 hosts", async ({ page }) => {
  const fixture = await start({ hosts: real200Hosts.slice(0, 34) });
  await page.goto(`${fixture.origin}/?scenario=real200`);
  await openPreviewTools(page);
  await expect(page.locator("#data-label")).toHaveText("Real200");
  await expect(page.locator("#host-count")).toHaveText("34 hosts");
  expect(await addresses(page)).toEqual(real200Hosts.slice(0, 34));
});

test("missing Real200 input stays unavailable without falling back to the default or synthetic roster", async ({ page }) => {
  const fixture = await start({ hosts: null });
  await page.goto(`${fixture.origin}/?scenario=real200`);
  await openPreviewTools(page);
  await expect(page.locator("#input-error")).toContainText(/missing|ENOENT/i);
  await expect(page.locator("#input-error")).toContainText("restart");
  await expect(page.locator("#fleet-rows [data-host]")).toHaveCount(0);
  expect(fixture.reads).toEqual([]);
  await page.getByLabel("Scenario", { exact: true }).selectOption("supplied");
  await expect(page.locator("#host-count")).toHaveText("8 hosts");
  await expect(page.locator("#input-error")).toBeHidden();
  expect(await addresses(page)).toEqual(defaultHosts);
});
