import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPreviewServer } from "../../scripts/preview-server.ts";
import type { OnlineHostsSnapshot } from "../../src/contracts/online-hosts.ts";
import type { NodeInfoRecord, NodeInfoSnapshot } from "../../src/fleet/node-info.ts";
import type { JobSnapshot } from "../../src/fleet/jobs.ts";
import { SYNTHETIC_HOST_ADDRESSES as fixedHosts } from "../fixtures/host-addresses.ts";
import { emptyJobs } from "../fixtures/jobs.ts";
import { emptyQueue } from "../fixtures/queue.ts";
import { emptySol } from "../fixtures/sol.ts";
import { emptyNos } from "../fixtures/nos.ts";
import { emptyStaking } from "../fixtures/staking.ts";

const NOW = Date.UTC(2026, 0, 1, 12);
const [a, b, c] = fixedHosts as [string, string, string, ...string[]];
const servers: Server[] = [];
const directories: string[] = [];
let origin = "";
let errors: string[] = [];
let external: string[] = [];
type Options = NonNullable<Parameters<typeof startPreviewServer>[0]>;

// Public integer encodings only: these are synthetic identities, never keys.
function address(value: number): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let encoded = "";
  let remaining = value;
  while (remaining) { encoded = alphabet[remaining % 58]! + encoded; remaining = Math.floor(remaining / 58); }
  return "1".repeat(32 - Math.ceil(Math.log2(value + 1) / 8)) + encoded;
}

function roster(addresses: readonly string[], revision = "fixture-1", at = NOW, after = 60_000): OnlineHostsSnapshot {
  return { addresses: [...addresses], error: null, online: {
    revision, checkedAtMs: at, nextRefreshAtMs: at + after, retained: false, discoveryError: null,
  } };
}

function nodeSnapshot(addresses: readonly string[], at = NOW, state = "RUNNING_JOB"): NodeInfoSnapshot {
  return { hosts: addresses.map(address => ({ address,
    values: { state, dl: null, ul: null, ping: null, networkUnavailableReason: null },
    fetchedAtMs: at, validUntilMs: at + 30_000, retained: false, error: null,
    apiCheck: { status: "online", checkedAtMs: at },
  })), nextRefreshAtMs: at + 20_000 };
}

function unknownNode(address: string): NodeInfoRecord {
  return { address, values: null, fetchedAtMs: null, validUntilMs: null, retained: false, error: null };
}

function nodeFeed(initial: (addresses: readonly string[]) => NodeInfoSnapshot) {
  const watchers = new Set<{ addresses: readonly string[]; signal: AbortSignal; emit: (value: NodeInfoSnapshot) => void }>();
  const provider: NonNullable<Options["nodeInfoProvider"]> = async addresses => initial(addresses);
  provider.watch = (addresses, signal, emit) => new Promise<never>((_resolve, reject) => {
    const watcher = { addresses: [...addresses], signal, emit };
    watchers.add(watcher);
    emit(initial(addresses));
    signal.addEventListener("abort", () => { watchers.delete(watcher); reject(signal.reason); }, { once: true });
  });
  return { provider, watchers,
    publish(snapshot: NodeInfoSnapshot) { for (const watcher of watchers) watcher.emit(snapshot); },
  };
}

function jobSnapshot(addresses: readonly string[]): JobSnapshot {
  return { hosts: addresses.map(host => ({ address: host,
    job: { address: address(10_000 + fixedHosts.indexOf(host)), node: host, state: "RUNNING",
      timeStart: NOW / 1_000 - 120, timeEnd: 0, timeout: 600 },
    checkedAtMs: NOW, validUntilMs: NOW + 180_000, failedAtMs: null,
    retained: false, pending: false, retryAtMs: null, error: null,
  })), nextRefreshAtMs: NOW + 120_000 };
}

function unknownJobs(addresses: readonly string[]): JobSnapshot {
  return { hosts: addresses.map(address => ({ address, job: null, checkedAtMs: null,
    validUntilMs: null, failedAtMs: null, retained: false, pending: false,
    retryAtMs: null, error: null })) };
}

async function start(initial = roster([a, b]), { populated = false, nodeInfoProvider, jobProvider }: {
  populated?: boolean;
  nodeInfoProvider?: Options["nodeInfoProvider"];
  jobProvider?: Options["jobProvider"];
} = {}) {
  let current = structuredClone(initial);
  let time = NOW;
  let onlineReads = 0;
  const reads: { kind: string; addresses: readonly string[] }[] = [];
  const activeJobReads: (readonly string[])[] = [];
  const remember = (kind: string, addresses: readonly string[]) => reads.push({ kind, addresses: [...addresses] });
  const recordedNodeProvider: NonNullable<Options["nodeInfoProvider"]> = async (addresses, signal, emit) => {
    remember("node-info", addresses);
    return nodeInfoProvider ? nodeInfoProvider(addresses, signal, emit) : nodeSnapshot(addresses, time);
  };
  if (nodeInfoProvider?.watch) recordedNodeProvider.watch = (addresses, signal, emit) => {
    remember("node-info", addresses);
    return nodeInfoProvider.watch!(addresses, signal, emit);
  };
  const recordedJobProvider: NonNullable<Options["jobProvider"]> = async (addresses, signal, emit) => {
    remember("jobs", addresses);
    activeJobReads.push([...addresses]);
    return jobProvider ? jobProvider(addresses, signal, emit) : populated ? jobSnapshot(addresses) : emptyJobs(addresses);
  };
  recordedJobProvider.peek = addresses => {
    remember("jobs", addresses);
    return jobProvider?.peek?.(addresses) ?? (populated ? jobSnapshot(addresses) : unknownJobs(addresses));
  };
  const directory = await mkdtemp(join(tmpdir(), "gridlens-online-browser-"));
  directories.push(directory);
  const hostsFile = join(directory, "hosts.json");
  const real200HostsFile = join(directory, "real200.json");
  await writeFile(hostsFile, JSON.stringify(fixedHosts));
  await writeFile(real200HostsFile, JSON.stringify(fixedHosts.slice(0, 3)));
  const server = await startPreviewServer({ hostsFile, real200HostsFile, port: 0, now: () => time,
    onlineProvider: {
      async read(signal) { signal?.throwIfAborted(); onlineReads++; return structuredClone(current); },
      peek() { return structuredClone(current); },
    },
    metadataProvider: async addresses => {
      remember("metadata", addresses);
      return { hosts: addresses.map(address => ({ address, values: null, fetchedAtMs: null,
        retained: false, error: null, marketError: null })) };
    },
    nodeInfoProvider: recordedNodeProvider,
    jobProvider: recordedJobProvider,
    queueProvider: async addresses => { remember("queue", addresses); return emptyQueue(addresses); },
    solProvider: async addresses => { remember("sol", addresses); return emptySol(addresses); },
    nosProvider: async addresses => { remember("nos", addresses); return emptyNos(addresses); },
    stakingProvider: async addresses => { remember("staking", addresses); return emptyStaking(addresses); },
  });
  servers.push(server);
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("Missing isolated preview port.");
  origin = `http://127.0.0.1:${bound.port}`;
  return { origin, reads, activeJobReads, hostsFile, real200HostsFile,
    get now() { return time; },
    get onlineReads() { return onlineReads; },
    set(value: OnlineHostsSnapshot) { current = structuredClone(value); },
    async advance(page: Page, ms: number) { time += ms; await page.clock.runFor(ms); },
  };
}

async function rowAddresses(page: Page): Promise<string[]> {
  return page.locator("#fleet-rows [data-host]").evaluateAll(rows => rows.map(row => row.getAttribute("data-host")!));
}

async function visibility(page: Page, state: "hidden" | "visible") {
  await page.evaluate(value => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => value === "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
  if (state === "visible") await page.clock.runFor(1);
}

test.beforeEach(async ({ page, context }) => {
  origin = ""; errors = []; external = [];
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) {
      external.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await page.clock.pauseAt(NOW);
});

test.afterEach(async ({ context }) => {
  for (const page of context.pages()) await page.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  expect(external, "Every source is injected; browser traffic stays on loopback.").toEqual([]);
  expect(errors).toEqual([]);
});

test("Online GPU Hosts renders all 1,200 rows and keeps every feed pinned to that revision", async ({ page }) => {
  const hosts = Array.from({ length: 1_200 }, (_, index) => address(index + 1));
  const fixture = await start(roster(hosts));
  const requests: URL[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.endsWith(".json") && url.pathname !== "/preview/connection.json") requests.push(url);
  });
  await page.goto(`${origin}/?scenario=online-gpu-hosts`);
  await expect(page.locator("#host-count")).toHaveText("1200 hosts");
  await expect(page.locator('#fleet-rows [data-source="supplied"]')).toHaveCount(1_200);
  expect(await rowAddresses(page)).toEqual(hosts);
  await expect(page.locator("#online-hosts-status")).toHaveAttribute("data-online-count", "1200");
  await expect(page.locator("#online-hosts-status")).toHaveAttribute("data-candidate-count", "1200");
  await expect(page.locator("#online-hosts-status")).toBeVisible();
  await expect(page.locator("#preview-tools")).not.toHaveAttribute("open");
  expect(await page.locator("#online-hosts-status").evaluate(element => element.closest("#preview-tools") === null)).toBe(true);
  await expect.poll(() => fixture.reads.length).toBe(7);
  expect(fixture.reads.map(read => read.kind).sort()).toEqual(["jobs", "metadata", "node-info", "nos", "queue", "sol", "staking"]);
  expect(fixture.activeJobReads, "Online job replies only inspect cache, even for a large candidate roster.").toEqual([]);
  for (const read of fixture.reads) expect(read.addresses).toEqual(hosts);
  for (const url of requests) {
    expect(url.searchParams.get("scenario")).toBe("online-gpu-hosts");
    expect(url.searchParams.get("revision")).toBe(url.pathname === "/preview/hosts.json" ? null : "fixture-1");
  }
  expect(requests).toHaveLength(8);
  expect(Buffer.byteLength(JSON.stringify(roster(hosts)))).toBeLessThan(2 * 1024 * 1024);
  await expect(page.locator('#fleet-rows td[data-col="api"]')).toHaveText(Array(1_200).fill("Online"));
  await expect(page.locator("#input-error")).toBeHidden();
  expect(await readFile(fixture.hostsFile, "utf8")).toBe(JSON.stringify(fixedHosts));
  expect(await readFile(fixture.real200HostsFile, "utf8")).toBe(JSON.stringify(fixedHosts.slice(0, 3)));
});

test("unchanged checks preserve feeds; membership changes retain connected artwork, focus, sort and reading times", async ({ page }) => {
  const fixture = await start(roster([b, c], "revision-1", NOW, 1_000), { populated: true,
    nodeInfoProvider: async addresses => nodeSnapshot(addresses),
  });
  await page.goto(`${origin}/?scenario=online-gpu-hosts`);
  const survivor = page.locator(`#fleet-rows [data-host="${b}"]`);
  await expect(survivor.locator('[data-col="state"]')).toHaveAttribute("data-state", "RUNNING_JOB");
  await expect(survivor.locator('[data-col="duration"]')).toHaveAttribute("data-job-checked-at", String(NOW));
  await expect.poll(() => fixture.reads.length).toBe(7);
  await page.getByRole("button", { name: "Sort by Host Address", exact: true }).click();
  const stateButton = survivor.locator('[data-col="state"] button');
  await stateButton.focus();
  const saved = await survivor.evaluateHandle(row => ({ row, button: row.querySelector('[data-col="state"] button')!,
    state: row.querySelector(".node-state-art")!, svg: row.querySelector(".node-state-art svg")!,
    duration: row.querySelector('[data-col="duration"] .duration-value')!,
    fill: row.querySelector('[data-col="duration"] .duration-fill')!,
  }));
  fixture.set(roster([b, c], "revision-1", NOW + 1_000, 1_000));
  await fixture.advance(page, 1_001);
  await expect.poll(() => fixture.onlineReads).toBe(2);
  expect(fixture.reads).toHaveLength(7);
  await expect(stateButton).toBeFocused();
  fixture.set(roster([b, a], "revision-2", NOW + 2_001, 1_000));
  await fixture.advance(page, 1_001);
  await expect(page.locator(`#fleet-rows [data-host="${a}"]`)).toHaveCount(1);
  await expect(page.locator(`#fleet-rows [data-host="${c}"]`)).toHaveCount(0);
  await expect.poll(() => fixture.reads.length).toBe(14);
  expect(await rowAddresses(page)).toEqual([a, b].sort());
  await expect(stateButton).toBeFocused();
  await expect(survivor.locator('[data-col="state"]')).toHaveAttribute("data-state-checked-at", String(NOW));
  await expect(survivor.locator('[data-col="duration"]')).toHaveAttribute("data-job-checked-at", String(NOW));
  expect(await saved.evaluate(value => ({
    row: value.row.isConnected,
    button: value.button.isConnected && value.row.querySelector('[data-col="state"] button') === value.button,
    state: value.state.isConnected && value.row.querySelector(".node-state-art") === value.state,
    svg: value.svg.isConnected && value.state.querySelector("svg") === value.svg,
    duration: value.duration.isConnected && value.row.querySelector('[data-col="duration"] .duration-value') === value.duration,
    fill: value.fill.isConnected && value.duration.querySelector(".duration-fill") === value.fill,
  }))).toEqual({ row: true, button: true, state: true, svg: true, duration: true, fill: true });
  const stale = roster([b, a], "revision-2", NOW + 2_001, 2_000);
  stale.online.retained = true; stale.online.discoveryError = "Injected discovery unavailable.";
  fixture.set(stale);
  await fixture.advance(page, 1_001);
  await expect(page.locator("#online-hosts-status")).toContainText("Discovery list stale");
  expect(await rowAddresses(page)).toEqual([a, b].sort());
  expect(fixture.reads).toHaveLength(14);
  await expect(survivor.locator('[data-col="duration"]')).toHaveAttribute("data-job-checked-at", String(NOW));
  await saved.dispose();
});

test("initial failure retries into a valid empty roster and then recovers without reload", async ({ page }) => {
  const initial: OnlineHostsSnapshot = { addresses: [], error: "Injected discovery unavailable.", online: {
    revision: null, checkedAtMs: null, nextRefreshAtMs: NOW + 1_000, retained: false,
    discoveryError: "Injected discovery unavailable.",
  } };
  const fixture = await start(initial);
  await page.goto(`${origin}/?scenario=online-gpu-hosts`);
  await expect(page.locator("#input-error")).toContainText("discovery is unavailable");
  expect(fixture.reads).toHaveLength(0);
  fixture.set(roster([], "empty", NOW + 1_000, 1_000));
  await fixture.advance(page, 1_001);
  await expect(page.locator("#host-count")).toHaveText("0 hosts");
  await expect(page.locator("#input-error")).toBeHidden();
  await expect(page.locator("#fleet-rows")).toContainText("currently reports no queued or running candidates");
  expect(fixture.reads).toHaveLength(0);
  fixture.set(roster([a, b], "recovered", NOW + 2_001));
  await fixture.advance(page, 1_001);
  await expect(page.locator("#host-count")).toHaveText("2 hosts");
  expect(await rowAddresses(page)).toEqual([a, b]);
  await expect.poll(() => fixture.reads.length).toBe(7);
});

test("an empty roster becomes visibly stale while its next discovery request is still stalled", async ({ page }) => {
  const fixture = await start(roster([], "empty-fresh"));
  let requests = 0;
  let stalled: Route | undefined;
  await page.route("**/preview/hosts.json?*", route => {
    requests++;
    if (requests === 1) return route.continue();
    // Hold the second read before it reaches the isolated server. Expiry must
    // update the notice independently of responses and transport timeouts.
    stalled = route;
  });
  await page.goto(`${origin}/?scenario=online-gpu-hosts`);
  await expect(page.locator("#host-count")).toHaveText("0 hosts");
  await expect(page.locator("#online-hosts-status")).toHaveAttribute("data-stale", "false");
  await fixture.advance(page, 60_001);
  await expect.poll(() => stalled !== undefined).toBe(true);
  await expect(page.locator("#online-hosts-status")).toHaveAttribute("data-stale", "false");
  await fixture.advance(page, 60_001);
  await expect(page.locator("#online-hosts-status")).toHaveAttribute("data-stale", "true");
  await expect(page.locator("#online-hosts-status")).toContainText("Discovery list stale");
  await expect(page.locator("#host-count")).toHaveText("0 hosts");
  expect(requests, "Notice expiry must not start another discovery request.").toBe(2);
  expect(fixture.onlineReads).toBe(1);
  expect(fixture.reads).toHaveLength(0);
  await stalled!.abort();
});

test("hidden, synthetic and pagehide views pause discovery while fixed live scenarios stay independent", async ({ page }) => {
  const fixture = await start();
  await page.goto(`${origin}/?layout=compact&scenario=online-gpu-hosts`);
  await expect(page.locator("#host-count")).toHaveText("2 hosts");
  await visibility(page, "hidden");
  await fixture.advance(page, 60_001);
  expect(fixture.onlineReads).toBe(1);
  fixture.set(roster([a, b], "fixture-1", NOW + 60_001));
  await visibility(page, "visible");
  await expect.poll(() => fixture.onlineReads).toBe(2);
  await page.getByLabel("Scenario", { exact: true }).selectOption("mixed");
  await expect(page.locator("#data-label")).toHaveText("Sample data");
  await expect(page.locator("#online-hosts-status")).toBeHidden();
  await fixture.advance(page, 60_001);
  expect(fixture.onlineReads).toBe(2);
  await page.getByLabel("Scenario", { exact: true }).selectOption("supplied");
  await expect(page).toHaveURL(`${origin}/?layout=compact&scenario=supplied`);
  await expect(page.locator("#host-count")).toHaveText("8 hosts");
  expect(await rowAddresses(page)).toEqual(fixedHosts);
  await page.getByLabel("Scenario", { exact: true }).selectOption("real200");
  await expect(page.locator("#host-count")).toHaveText("3 hosts");
  expect(await rowAddresses(page)).toEqual(fixedHosts.slice(0, 3));
  expect(fixture.onlineReads).toBe(2);
  fixture.set(roster([a, b], "fixture-1", NOW + 120_002));
  await page.getByLabel("Scenario", { exact: true }).selectOption("online-gpu-hosts");
  await expect(page.locator("#host-count")).toHaveText("2 hosts");
  await expect.poll(() => fixture.onlineReads).toBe(3);
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await fixture.advance(page, 60_001);
  expect(fixture.onlineReads).toBe(3);
});

test("Online uses only cached timings; Supplied collects them and switching back preserves the original evidence", async ({ page }) => {
  const cache = new Map<string, JobSnapshot["hosts"][number]>();
  const jobs: NonNullable<Options["jobProvider"]> = async addresses => {
    const snapshot = jobSnapshot(addresses);
    for (const record of snapshot.hosts) cache.set(record.address, structuredClone(record));
    return snapshot;
  };
  jobs.peek = addresses => ({ hosts: addresses.map(address => structuredClone(cache.get(address)
    ?? unknownJobs([address]).hosts[0]!)) });
  const fixture = await start(roster([a, b]), { jobProvider: jobs });
  const apiRequests: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/preview/") && url.pathname.endsWith(".json")) apiRequests.push(url.pathname);
  });
  await page.goto(`${origin}/?scenario=online-gpu-hosts`);
  await expect(page.locator("#host-count")).toHaveText("2 hosts");
  await expect.poll(() => fixture.reads.length).toBe(7);
  const duration = page.locator(`#fleet-rows [data-host="${a}"] [data-col="duration"]`);
  await expect(duration).toHaveText("Populating..");
  await expect(page.locator("#online-job-policy")).toHaveText(
    "Online GPU Hosts uses cached job timings and history only. Active job collection is reserved for Supplied Host Addresses and Real200.");
  await expect(page.locator("#online-job-policy")).toBeVisible();
  expect(await page.locator("#online-job-policy").evaluate(element => element.closest("#preview-tools") === null)).toBe(true);
  await expect(page.locator("#preview-tools")).not.toHaveAttribute("open");
  expect(fixture.activeJobReads).toEqual([]);
  expect(cache.size).toBe(0);

  await fixture.advance(page, 3_000);
  await page.getByLabel("Scenario", { exact: true }).selectOption("supplied");
  await expect(page.locator("#host-count")).toHaveText("8 hosts");
  await expect(page.locator("#online-job-policy")).toBeHidden();
  await expect.poll(() => fixture.reads.length).toBe(14);
  await expect(duration).toHaveAttribute("data-job-checked-at", String(NOW));
  await expect(duration).not.toContainText("Populating..");
  expect(fixture.activeJobReads).toEqual([fixedHosts]);
  expect(cache.size).toBe(fixedHosts.length);

  await fixture.advance(page, 3_000);
  await page.getByLabel("Scenario", { exact: true }).selectOption("online-gpu-hosts");
  await expect(page.locator("#host-count")).toHaveText("2 hosts");
  await expect.poll(() => fixture.reads.length).toBe(21);
  await expect(duration).toHaveAttribute("data-job-checked-at", String(NOW));
  await expect(duration).not.toContainText("Populating..");
  expect(fixture.activeJobReads).toEqual([fixedHosts]);
  expect(cache.get(a)?.job?.timeStart).toBe(NOW / 1_000 - 120);
  expect(cache.get(a)?.validUntilMs).toBe(NOW + 180_000);

  const readsBeforeDisplayChanges = fixture.reads.length;
  const requestsBeforeDisplayChanges = apiRequests.length;
  await page.getByRole("button", { name: "Sort by Host Address", exact: true }).click();
  await page.locator("#queued-duration-layout-toggle").click();
  await page.locator("#queued-duration-layout-toggle").click();
  expect(fixture.reads).toHaveLength(readsBeforeDisplayChanges);
  expect(apiRequests).toHaveLength(requestsBeforeDisplayChanges);
  expect(fixture.activeJobReads).toEqual([fixedHosts]);
  await expect(duration).toHaveAttribute("data-job-checked-at", String(NOW));
});

test("a 409 data race reloads the current roster and retries with its new revision", async ({ page }) => {
  const fixture = await start(roster([a, c], "before-race"));
  let rejected = 0;
  await page.route("**/preview/metadata.json?*", async route => {
    const revision = new URL(route.request().url()).searchParams.get("revision");
    if (revision === "before-race") {
      rejected++;
      fixture.set(roster([a, b], "after-race"));
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Roster changed." }) });
      return;
    }
    await route.continue();
  });
  await page.goto(`${origin}/?scenario=online-gpu-hosts`);
  await expect.poll(() => fixture.onlineReads).toBe(2);
  await expect(page.locator(`#fleet-rows [data-host="${b}"]`)).toHaveCount(1);
  await expect(page.locator(`#fleet-rows [data-host="${c}"]`)).toHaveCount(0);
  await expect(page.locator("#input-error")).toBeHidden();
  expect(rejected).toBe(1);
  await expect.poll(() => fixture.reads.filter(read => read.kind === "metadata").length).toBe(1);
  expect(fixture.reads.find(read => read.kind === "metadata")!.addresses).toEqual([a, b]);
});

test("membership retirement cancels old feeds and a late response cannot recreate removed rows", async ({ page }) => {
  let first = true;
  let signal: AbortSignal | undefined;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const fixture = await start(roster([a, c], "before-removal", NOW, 1_000), {
    nodeInfoProvider: async (addresses, received) => {
      if (first) { first = false; signal = received; await pending; }
      return nodeSnapshot(addresses);
    },
  });
  await page.goto(`${origin}/?scenario=online-gpu-hosts`);
  await expect.poll(() => signal !== undefined).toBe(true);
  fixture.set(roster([a, b], "after-removal", NOW + 1_000));
  await fixture.advance(page, 1_001);
  await expect.poll(() => signal?.aborted).toBe(true);
  await expect(page.locator(`#fleet-rows [data-host="${b}"] [data-col="state"]`)).toHaveAttribute("data-state", "RUNNING_JOB");
  release();
  await page.clock.runFor(1);
  await expect(page.locator(`#fleet-rows [data-host="${c}"]`)).toHaveCount(0);
  expect(await rowAddresses(page)).toEqual([a, b]);
});

test("candidate checks continue with zero visible rows and fresh Node Info progress admits hosts without extra reads", async ({ page }) => {
  const feed = nodeFeed(addresses => ({ hosts: addresses.map(unknownNode) }));
  const fixture = await start(roster([a, b]), { nodeInfoProvider: feed.provider });
  await page.goto(`${origin}/?scenario=online-gpu-hosts`);
  await expect.poll(() => fixture.reads.length).toBe(7);
  await expect(page.locator("#host-count")).toHaveText("0 hosts");
  await expect(page.locator("#online-hosts-status")).toHaveAttribute("data-online-count", "0");
  await expect(page.locator("#online-hosts-status")).toHaveAttribute("data-candidate-count", "2");
  await expect(page.locator("#fleet-rows")).toContainText("checks continue automatically");
  expect(await rowAddresses(page)).toEqual([]);
  expect([...feed.watchers].map(watcher => watcher.addresses)).toEqual([[a, b]]);

  feed.publish(nodeSnapshot([a], NOW, "QUEUED"));
  await expect.poll(async () => { await page.clock.runFor(20); return rowAddresses(page); }).toEqual([a]);
  await expect(page.locator("#host-count")).toHaveText("1 host");
  await expect(page.locator("#online-hosts-status")).toHaveAttribute("data-online-count", "1");
  const row = page.locator(`#fleet-rows [data-host="${a}"]`);
  const connected = await row.evaluateHandle(element => element);
  const requests = fixture.reads.length;
  await page.getByRole("button", { name: "Sort by Host Address", exact: true }).click();
  await page.locator("#queued-duration-layout-toggle").click();
  await page.locator("#queued-duration-layout-toggle").click();
  expect(fixture.reads).toHaveLength(requests);
  expect(fixture.onlineReads).toBe(1);
  expect(await connected.evaluate(element => element.isConnected)).toBe(true);
  await connected.dispose();
  feed.publish(nodeSnapshot([b], NOW, "QUEUED"));
  await expect.poll(async () => { await page.clock.runFor(20); return rowAddresses(page); }).toEqual([a, b].sort());
  await expect(page.locator("#host-count")).toHaveText("2 hosts");
  expect(fixture.reads).toHaveLength(requests);
});

test("Offline, inconclusive and expired candidates stay hidden despite ancient running jobs; OTHER can remain API Online", async ({ page }) => {
  const candidates = fixedHosts.slice(0, 6);
  const [online, other, offline, inconclusive, expired, unknown] = candidates as [string, string, string, string, string, string];
  const fresh = (address: string) => nodeSnapshot([address]).hosts[0]!;
  const initial: NodeInfoSnapshot = { hosts: [
    fresh(online),
    { ...fresh(other), values: { ...fresh(other).values!, state: "OTHER" },
      activity: { state: null, source: "nosana-indexer", checkedAtMs: NOW, validUntilMs: NOW + 30_000,
        error: "Injected reconciliation unavailable." } },
    { ...unknownNode(offline), error: "Injected confirmed HTTP 503 outage.",
      apiCheck: { status: "offline", checkedAtMs: NOW, httpStatus: 503, failureKind: "http", nextCheckAtMs: NOW + 60_000 } },
    { ...unknownNode(inconclusive), apiCheck: { status: "other", checkedAtMs: NOW, failureKind: "network" } },
    nodeSnapshot([expired], NOW - 30_001).hosts[0]!,
    unknownNode(unknown),
  ] };
  const feed = nodeFeed(() => initial);
  const ancientJobs = (addresses: readonly string[]) => {
    const value = jobSnapshot(addresses);
    for (const record of value.hosts) if (record.job) record.job.timeStart = NOW / 1_000 - 35 * 86_400;
    return value;
  };
  const jobs: NonNullable<Options["jobProvider"]> = async addresses => ancientJobs(addresses);
  jobs.peek = ancientJobs;
  const fixture = await start(roster(candidates), { nodeInfoProvider: feed.provider,
    jobProvider: jobs,
  });
  await page.goto(`${origin}/?scenario=online-gpu-hosts`);
  await expect.poll(() => fixture.reads.length).toBe(7);
  await expect.poll(async () => { await page.clock.runFor(20); return rowAddresses(page); }).toEqual([online, other]);
  await expect(page.locator("#host-count")).toHaveText("2 hosts");
  expect(await rowAddresses(page)).toEqual([online, other]);
  await expect(page.locator("#online-hosts-status")).toHaveAttribute("data-candidate-count", "6");
  await expect(page.locator("#online-hosts-status")).toContainText("Offline/unconfirmed hosts hidden");
  await expect(page.locator(`#fleet-rows [data-host="${other}"] td[data-col="api"]`)).toHaveText("Online");
  expect(fixture.reads.find(read => read.kind === "jobs")!.addresses).toEqual(candidates);
  expect(fixture.activeJobReads).toEqual([]);
  const readsBeforeRecovery = fixture.reads.length;
  feed.publish(nodeSnapshot([offline], NOW, "QUEUED"));
  await expect.poll(async () => { await page.clock.runFor(20); return rowAddresses(page); }).toEqual([online, other, offline]);
  await expect(page.locator("#host-count")).toHaveText("3 hosts");
  expect(fixture.reads).toHaveLength(readsBeforeRecovery);
});

test("Online qualification expires at its original 30-second deadline and a fresh proof restores a hidden candidate", async ({ page }) => {
  const feed = nodeFeed(addresses => nodeSnapshot(addresses));
  const fixture = await start(roster([a]), { nodeInfoProvider: feed.provider, populated: true });
  await page.goto(`${origin}/?scenario=online-gpu-hosts`);
  await expect.poll(async () => { await page.clock.runFor(20); return rowAddresses(page); }).toEqual([a]);
  await expect(page.locator("#host-count")).toHaveText("1 host");
  const checked = page.locator(`#fleet-rows [data-host="${a}"] [data-col="api"]`);
  await expect(checked).toHaveAttribute("data-api-checked-at", String(NOW));
  await expect.poll(() => feed.watchers.size).toBe(1);
  await expect.poll(() => fixture.reads.length).toBe(7);
  // Keep this an expiry-without-new-data check. Advancing the controlled server
  // clock in one jump must not let an unrelated response recalibrate the browser
  // halfway through replaying that interval.
  const held: Route[] = [];
  await page.route("**/preview/*.json?*", route => { held.push(route); });
  await fixture.advance(page, 29_000);
  await expect(page.locator("#host-count")).toHaveText("1 host");
  await fixture.advance(page, 1_001);
  await expect(page.locator("#host-count")).toHaveText("0 hosts");
  expect(await rowAddresses(page)).toEqual([]);
  await expect(page.locator("#online-hosts-status")).toHaveAttribute("data-candidate-count", "1");
  expect(feed.watchers.size).toBe(1);
  expect([...feed.watchers][0]!.signal.aborted).toBe(false);
  expect(fixture.reads.filter(read => read.kind === "node-info")).toHaveLength(1);
  feed.publish(nodeSnapshot([a], fixture.now));
  await expect.poll(async () => { await page.clock.runFor(20); return rowAddresses(page); }).toEqual([a]);
  await expect(checked).toHaveAttribute("data-api-checked-at", String(fixture.now));
  await expect(page.locator("#host-count")).toHaveText("1 host");
  expect(fixture.reads.filter(read => read.kind === "node-info")).toHaveLength(1);
  for (const route of held) await route.abort().catch(() => {});
});

test("resuming a hidden view requires clock revalidation before an otherwise unexpired Online proof qualifies", async ({ page }) => {
  const fixture = await start(roster([a]), { nodeInfoProvider: async addresses => nodeSnapshot(addresses) });
  await page.goto(`${origin}/?scenario=online-gpu-hosts`);
  await expect(page.locator("#host-count")).toHaveText("1 host");
  await expect.poll(() => fixture.reads.length).toBe(7);
  await visibility(page, "hidden");
  await fixture.advance(page, 10_000);
  const held: Route[] = [];
  let hold = true;
  await page.route("**/preview/*.json*", route => {
    if (hold) { held.push(route); return; }
    return route.continue();
  });
  await visibility(page, "visible");
  await expect(page.locator("#host-count")).toHaveText("0 hosts");
  expect(await rowAddresses(page)).toEqual([]);
  await expect.poll(() => held.some(route => new URL(route.request().url()).pathname === "/preview/hosts.json")).toBe(true);
  fixture.set(roster([a], "fixture-1", fixture.now));
  const rosterRoute = held.find(route => new URL(route.request().url()).pathname === "/preview/hosts.json")!;
  held.splice(held.indexOf(rosterRoute), 1);
  await rosterRoute.continue();
  await expect.poll(async () => { await page.clock.runFor(20); return rowAddresses(page); }).toEqual([a]);
  await expect(page.locator(`#fleet-rows [data-host="${a}"] [data-col="api"]`)).toHaveAttribute("data-api-checked-at", String(NOW));
  hold = false;
  for (const route of held) await route.continue().catch(() => {});
});

for (const phase of ["before API paint", "after API paint"] as const) {
  test(`an Online proof expiring ${phase} never commits a newly admitted stale row`, async ({ page }) => {
    const feed = nodeFeed(addresses => ({ hosts: addresses.map(unknownNode) }));
    const fixture = await start(roster([a]), { nodeInfoProvider: feed.provider });
    await page.goto(`${origin}/?scenario=online-gpu-hosts`);
    await expect.poll(() => fixture.reads.length).toBe(7);
    await expect(page.locator("#host-count")).toHaveText("0 hosts");
    const originalReads = fixture.reads.length;
    await page.evaluate(({ phase, address, epoch }) => {
      const elapsedNow = performance.now.bind(performance);
      let offset = 0;
      const probe = { crossed: false, commits: [] as { host: string; apiCurrent: string | null; expired: boolean }[] };
      Object.assign(window, { onlineCommitExpiryProbe: probe });
      Object.defineProperty(performance, "now", { configurable: true, value: () => elapsedNow() + offset });
      const setAttribute = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
        setAttribute.call(this, name, value);
        if (probe.crossed || name !== "aria-label") return;
        const beforePaint = phase === "before API paint" && this.tagName === "TR" && this.getAttribute("data-host") === address;
        const afterPaint = phase === "after API paint" && this.classList.contains("node-api-value") &&
          value.startsWith(`API for ${address}:`);
        if (beforePaint || afterPaint) { probe.crossed = true; offset = 30_001; }
      };
      new MutationObserver(records => {
        for (const record of records) for (const added of record.addedNodes) {
          if (!(added instanceof HTMLTableRowElement) || !added.dataset.host) continue;
          const api = added.querySelector<HTMLTableCellElement>('td[data-col="api"]');
          const checked = Number(api?.dataset.apiCheckedAt);
          probe.commits.push({ host: added.dataset.host, apiCurrent: api?.getAttribute("data-api-current") ?? null,
            expired: Number.isFinite(checked) && checked + 30_000 <= epoch + offset });
        }
      }).observe(document.querySelector("#fleet-rows")!, { childList: true });
    }, { phase, address: a, epoch: NOW });
    feed.publish(nodeSnapshot([a], NOW, "QUEUED"));
    await expect.poll(async () => {
      await page.clock.runFor(20);
      return page.evaluate(() => (window as unknown as { onlineCommitExpiryProbe: { crossed: boolean } }).onlineCommitExpiryProbe.crossed);
    }).toBe(true);
    await expect(page.locator("#host-count")).toHaveText("0 hosts");
    expect(await rowAddresses(page)).toEqual([]);
    await expect(page.locator("#online-hosts-status")).toHaveAttribute("data-online-count", "0");
    await expect(page.locator("#online-hosts-status")).toHaveAttribute("data-candidate-count", "1");
    const commits = await page.evaluate(() => (window as unknown as {
      onlineCommitExpiryProbe: { commits: { host: string; apiCurrent: string | null; expired: boolean }[] };
    }).onlineCommitExpiryProbe.commits);
    expect(commits.filter(commit => commit.apiCurrent !== "true" || commit.expired),
      "Even a row removed by the next expiry timeout must never have been committed with expired Online proof.").toEqual([]);
    expect(commits, "The proof crossed its deadline before this candidate could enter the table.").toEqual([]);
    expect(fixture.reads).toHaveLength(originalReads);
    expect(fixture.onlineReads).toBe(1);
    expect(feed.watchers.size).toBe(1);
  });
}
