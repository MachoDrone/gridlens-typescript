import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPreviewServer } from "../../scripts/preview-server.ts";
import type { FleetSnapshots } from "../../src/contracts/fleet.ts";
import { blankStakingRecord, STAKING_DISPLAY_VALIDITY_MS } from "../../src/fleet/staking.ts";
import { NOS_MINT } from "../../src/fleet/nos.ts";
import { SYNTHETIC_HOST_ADDRESSES as identities } from "../fixtures/host-addresses.ts";
import { openPreviewTools } from "./helpers.ts";
import { blankJobHistoryRecord } from "../../src/fleet/job-history.ts";

const NOW = Date.UTC(2026, 2, 8, 7); // US daylight-saving boundary; source times remain UTC.
const addresses = identities.slice(0, 3);
const market = identities[7]!;

function snapshots(at: number, schedulingAt = at): FleetSnapshots {
  const account = { provider: "Isolated clock fixture", endpoint: "https://rpc.example.invalid", contextSlot: 123,
    blockTimeMs: at - 1_000, checkedAtMs: at, retained: false, error: null, retryAtMs: null };
  return {
    "job-history": { hosts: addresses.map(blankJobHistoryRecord) },
    metadata: { hosts: addresses.map(address => ({ address, values: { status: "PREMIUM", marketAddress: market,
      marketLabel: "clock-fixture", ram: 64, disk: 500, cpu: "Synthetic CPU", cuda: null, nvidia: null,
      currentNode: null, system: null }, fetchedAtMs: at, retained: false, error: null, marketError: null })) },
    "node-info": { hosts: addresses.map((address, index) => ({ address,
      values: index === 2 ? null : { state: index === 0 ? "RUNNING_JOB" : "QUEUED", dl: 100, ul: 20, ping: 8,
        networkUnavailableReason: null }, fetchedAtMs: index === 2 ? null : at,
      validUntilMs: index === 2 ? null : at + 30_000, retained: false, error: null,
      apiCheck: { status: index === 2 ? "offline" : "online", checkedAtMs: at, nextCheckAtMs: at + 60_000 },
    })), nextRefreshAtMs: schedulingAt + 20_000 },
    jobs: { hosts: addresses.map((address, index) => ({ address,
      job: index === 0 ? { address: identities[6]!, node: address, state: "RUNNING", timeStart: NOW / 1_000 - 120,
        timeEnd: 0, timeout: 600 } : null,
      checkedAtMs: at, validUntilMs: at + 180_000, failedAtMs: null,
      retained: false, pending: false, retryAtMs: null, error: null })), nextRefreshAtMs: schedulingAt + 120_000 },
    queue: { hosts: addresses.map((address, index) => ({ address, marketAddress: market, position: index === 1 ? 2 : null,
      total: 3, checkedAtMs: at, validUntilMs: at + 30_000, sourceUpdatedAtMs: at - 1_000,
      retained: false, error: null })), nextRefreshAtMs: schedulingAt + 20_000 },
    sol: { hosts: addresses.map(address => ({ address, ...account, lamports: "1230000000", validUntilMs: at + 60_000 })),
      nextRefreshAtMs: schedulingAt + 30_000 },
    nos: { hosts: addresses.map(address => ({ address, ...account, tokenAccount: identities[5]!, mint: NOS_MINT,
      amount: "123000000", decimals: 6, accountState: "initialized", validUntilMs: at + 180_000 })),
      nextRefreshAtMs: schedulingAt + 120_000 },
    staking: { hosts: addresses.map(address => {
      const row = blankStakingRecord(address);
      const proof = { ...account, validUntilMs: at + STAKING_DISPLAY_VALIDITY_MS };
      row.stake = { ...row.stake, ...proof, stakeAccount: identities[4]!, vaultAccount: identities[5]!,
        amount: "2000000", recordedAmount: "2000000", xnos: "2000000", durationSeconds: "1209600",
        unstakeAtSeconds: "0", accountState: "initialized" };
      row.requirement = { ...row.requirement, ...proof, marketAddress: market, targetAmount: "1000000", xnosMinimum: "1000000" };
      row.marketAddress = market;
      row.marketFetchedAtMs = at;
      return row;
    }), nextRefreshAtMs: schedulingAt + 1_800_000 },
  };
}

function cell(page: Page, column: string, index = 0) {
  return page.locator(`[data-host="${addresses[index]}"] td[data-col="${column}"]`);
}
async function advance(pages: Page[], elapsed: number): Promise<void> {
  await Promise.all(pages.map(page => page.clock.fastForward(elapsed)));
}
async function refresh(pages: Page[]): Promise<void> {
  await Promise.all(pages.map(async page => {
    const responses = Promise.all(["metadata", "node-info", "jobs", "queue"].map(kind =>
      page.waitForResponse(response => new URL(response.url()).pathname === `/preview/${kind}.json`)));
    await page.locator("#refresh-view").click();
    await responses;
    await page.clock.runFor(20);
  }));
}
async function visibility(pages: Page[], state: "hidden" | "visible"): Promise<void> {
  await Promise.all(pages.map(page => page.evaluate(value => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => value === "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state)));
  if (state === "visible") await advance(pages, 20);
}
async function current(page: Page, checkedAt: number): Promise<void> {
  await expect(cell(page, "api")).toHaveText("Online");
  await expect(cell(page, "api")).toHaveAttribute("data-api-current", "true");
  await expect(cell(page, "api")).toHaveAttribute("data-api-checked-at", String(checkedAt));
  await expect(cell(page, "api", 2)).toHaveText("Offline");
  await expect(cell(page, "api", 2)).toHaveAttribute("data-api-current", "true");
  await expect(cell(page, "state")).toHaveAttribute("data-state", "RUNNING_JOB");
  await expect(cell(page, "state")).toHaveAttribute("data-state-current", "true");
  await expect(cell(page, "queued", 1)).toHaveAttribute("data-queue-current", "true");
  await expect(cell(page, "duration")).toHaveAttribute("data-duration-freshness", "current");
  await expect(cell(page, "sol")).toHaveText("1.230");
  await expect(cell(page, "sol")).toHaveAttribute("data-sol-state", "current");
  await expect(cell(page, "nos")).toHaveText("123");
  await expect(cell(page, "nos")).toHaveAttribute("data-nos-state", "current");
  await expect(cell(page, "stakedNos")).toHaveAttribute("data-staking-state", "current");
}
async function readings(page: Page) {
  return page.locator('#fleet-rows td[data-col="api"], #fleet-rows td[data-col="state"], #fleet-rows td[data-col="queued"], #fleet-rows td[data-col="duration"], #fleet-rows td[data-col="sol"], #fleet-rows td[data-col="nos"], #fleet-rows td[data-col="stakedNos"]').evaluateAll(cells => cells.map(cell => ({
    text: cell.textContent, attrs: [...cell.attributes].filter(attr => attr.name.startsWith("data-")).map(attr => [attr.name, attr.value]),
    label: cell.querySelector("button")?.getAttribute("aria-label"),
  })));
}

const clockResources = ["metadata", "node-info", "jobs", "queue", "sol", "nos", "staking"] as const;
function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release };
}
async function latencyFixture(now: () => number, source: () => FleetSnapshots) {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-clock-latency-"));
  const hostsFile = join(directory, "hosts.json");
  await writeFile(hostsFile, JSON.stringify(addresses));
  const server = await startPreviewServer({ hostsFile, port: 0, now,
    metadataProvider: async () => source().metadata,
    nodeInfoProvider: async () => source()["node-info"],
    jobProvider: async () => source().jobs,
    queueProvider: async () => source().queue,
    solProvider: async () => source().sol,
    nosProvider: async () => source().nos,
    stakingProvider: async () => source().staking,
  });
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("Missing isolated server port");
  return { origin: `http://127.0.0.1:${bound.port}`, async close() {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  } };
}

test("delayed initial replies expire uncertain evidence without adding response latency to Duration", async ({ page, context }) => {
  let serverNow = NOW;
  const emission = NOW + 60_000;
  const source = snapshots(emission, emission + 3_600_000);
  source["node-info"].hosts = source["node-info"].hosts.map((record, index) => {
    const at = index === 2 ? emission + 45_000 : emission - 29_000;
    return { ...record, values: { state: "RUNNING_JOB", dl: 100, ul: 20, ping: 8, networkUnavailableReason: null },
      fetchedAtMs: at, validUntilMs: at + 30_000, apiCheck: { status: "online" as const, checkedAtMs: at } };
  });
  source.jobs.hosts = source.jobs.hosts.map((record, index) => {
    const at = index === 0 ? emission : emission - 150_000;
    return { ...record, checkedAtMs: at, validUntilMs: at + 180_000,
      job: { address: identities[index + 3]!, node: record.address, state: "RUNNING",
        timeStart: emission / 1000 - [120, 900, 901][index]!, timeEnd: 0, timeout: 600 } };
  });
  source.queue.hosts = source.queue.hosts.map(record => ({ ...record, position: null }));
  source.sol = snapshots(emission - 1_000, emission + 3_600_000).sol;
  source.nos = snapshots(emission - 121_000, emission + 3_600_000).nos;
  source.staking = snapshots(emission - STAKING_DISPLAY_VALIDITY_MS + 30_000, emission + 3_600_000).staking;
  const fixture = await latencyFixture(() => serverNow, () => source);
  const roster = gate(), resources = gate();
  const reads = new Map<string, number>();
  const captured = new Set<string>();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await page.clock.pauseAt(NOW);
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== fixture.origin) { errors.push("Unexpected external request"); return route.abort(); }
    const resource = /^\/preview\/([^/]+)\.json$/.exec(url.pathname)?.[1];
    if (!resource || resource === "connection") return route.continue();
    reads.set(resource, (reads.get(resource) ?? 0) + 1);
    // Fetch and capture the emitted envelope before buffering its delivery.
    const response = await route.fetch();
    const body = await response.body();
    captured.add(resource);
    if (resource === "hosts") await roster.promise;
    else if (reads.get(resource) === 1) await resources.promise;
    await route.fulfill({ response, body });
  });
  try {
    await page.goto(fixture.origin);
    await expect.poll(() => captured.has("hosts")).toBe(true);
    serverNow = emission;
    await page.clock.fastForward(60_000);
    roster.release();
    await expect.poll(() => clockResources.every(resource => captured.has(resource))).toBe(true);
    serverNow += 60_000;
    await page.clock.fastForward(60_000);
    resources.release();
    await expect(cell(page, "duration").getByRole("button")).toHaveAccessibleName(/2m \/ 10m/);
    await expect(cell(page, "api")).toHaveText("Online");
    await expect(cell(page, "api")).toHaveAttribute("data-api-current", "false");
    await expect(cell(page, "api")).toHaveAttribute("data-api-checked-at", String(emission - 29_000));
    // The conservative expiry bound must not authorize future-dated evidence.
    await expect(cell(page, "api", 2)).toHaveText("Populating..");
    await expect(cell(page, "sol")).toHaveAttribute("data-sol-state", "retained");
    await expect(cell(page, "nos")).toHaveAttribute("data-nos-state", "retained");
    await expect(cell(page, "stakedNos")).toHaveAttribute("data-staking-state", "retained");
    await expect(cell(page, "duration", 1)).toHaveAttribute("data-duration-freshness", "retained");
    await expect(cell(page, "duration", 1)).toHaveAttribute("data-duration-tone", "current");
    await expect(cell(page, "duration", 1).getByRole("button")).toHaveAccessibleName(/15m \/ 10m/);
    await expect(cell(page, "duration", 2)).toHaveAttribute("data-duration-tone", "exceeded");
    expect(Object.fromEntries(reads)).toEqual(Object.fromEntries(["hosts", ...clockResources].map(resource => [resource, 1])));
    expect(errors).toEqual([]);
  } finally {
    roster.release(); resources.release();
    await page.close();
    await fixture.close();
  }
});

test("buffered stream frames preserve an earlier precise clock and keep original expiry deadlines", async ({ page, context }) => {
  let serverNow = NOW;
  const source = snapshots(NOW, NOW + 3_600_000);
  const fixture = await latencyFixture(() => serverNow, () => source);
  const stream = gate();
  let stateReads = 0;
  const reads = new Map<string, number>();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await page.clock.pauseAt(NOW);
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== fixture.origin) { errors.push("Unexpected external request"); return route.abort(); }
    const resource = /^\/preview\/([^/]+)\.json$/.exec(url.pathname)?.[1];
    if (resource && resource !== "connection") reads.set(resource, (reads.get(resource) ?? 0) + 1);
    if (resource !== "node-info") return route.continue();
    stateReads++;
    const first = { ...snapshots(NOW - 29_000, NOW + 3_600_000)["node-info"], serverTimeMs: NOW, complete: false };
    await stream.promise;
    // A response can contain an old buffered frame followed by a newly emitted
    // frame. Stream lifetime alone must not replace a tighter existing bound.
    const final = { ...snapshots(serverNow - 29_000, serverNow + 3_600_000)["node-info"], serverTimeMs: serverNow, complete: true };
    await route.fulfill({ contentType: "application/x-ndjson", body: `${JSON.stringify(first)}\n${JSON.stringify(final)}\n` });
  });
  try {
    await page.goto(fixture.origin);
    await expect(cell(page, "duration")).toHaveAttribute("data-duration-freshness", "current");
    await expect.poll(() => stateReads).toBe(1);
    serverNow += 60_000;
    await page.clock.fastForward(60_000);
    stream.release();
    await expect(cell(page, "api")).toHaveAttribute("data-api-current", "true");
    await expect(cell(page, "api")).toHaveAttribute("data-api-checked-at", String(serverNow - 29_000));
    await expect(cell(page, "duration").getByRole("button")).toHaveAccessibleName(/3m \/ 10m/);
    const beforeExpiry = Object.fromEntries(reads);
    await page.clock.runFor(1_001);
    await expect(cell(page, "api")).toHaveAttribute("data-api-current", "false");
    expect(Object.fromEntries(reads), "Clock precision and display expiry cannot trigger extra source reads").toEqual(beforeExpiry);
    expect(errors).toEqual([]);
  } finally {
    stream.release();
    await page.close();
    await fixture.close();
  }
});

test("a precise resumed reply narrows conservative freshness without renewing observations or adding reads", async ({ page, context }) => {
  let serverNow = NOW;
  const emission = NOW + 120_000;
  const source = snapshots(emission, emission + 3_600_000);
  source["node-info"] = snapshots(emission - 29_000, emission + 3_600_000)["node-info"];
  source.jobs.hosts[0]!.job!.timeStart = emission / 1_000 - 120;
  const fixture = await latencyFixture(() => serverNow, () => source);
  const roster = gate(), resources = gate(), calibration = gate();
  const reads = new Map<string, number>();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await page.clock.pauseAt(NOW);
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== fixture.origin) { errors.push("Unexpected external request"); return route.abort(); }
    const resource = /^\/preview\/([^/]+)\.json$/.exec(url.pathname)?.[1];
    if (!resource || resource === "connection") return route.continue();
    reads.set(resource, (reads.get(resource) ?? 0) + 1);
    // These requests wait before emission, unlike the buffered-body regression.
    // Their long RTT is an honest upper bound, but not an elapsed-clock offset.
    if (resource === "hosts") await roster.promise;
    else if (reads.get(resource) === 1) await resources.promise;
    else if (resource === "metadata") await calibration.promise;
    const response = await route.fetch();
    await route.fulfill({ response });
  });
  try {
    await page.goto(fixture.origin);
    await expect.poll(() => reads.get("hosts")).toBe(1);
    serverNow += 60_000;
    await page.clock.fastForward(60_000);
    roster.release();
    await expect.poll(() => clockResources.every(resource => reads.has(resource))).toBe(true);
    serverNow += 60_000;
    await page.clock.fastForward(60_000);
    resources.release();
    await expect(cell(page, "api")).toHaveText("Online");
    await expect(cell(page, "api")).toHaveAttribute("data-api-current", "false");
    await expect(cell(page, "api")).toHaveAttribute("data-api-checked-at", String(emission - 29_000));
    await expect(cell(page, "duration").getByRole("button")).toHaveAccessibleName(/2m \/ 10m/);
    const initial = Object.fromEntries(reads);
    expect(initial).toEqual(Object.fromEntries(["hosts", ...clockResources].map(resource => [resource, 1])));

    await visibility([page], "hidden");
    serverNow += 20;
    await visibility([page], "visible");
    await expect.poll(() => reads.get("metadata")).toBe(2);
    await expect(cell(page, "api")).toHaveAttribute("data-api-current", "false");
    await expect(cell(page, "duration")).toHaveAttribute("data-duration-freshness", "retained");
    calibration.release();
    await expect.poll(async () => {
      await page.clock.runFor(20);
      return cell(page, "api").getAttribute("data-api-current");
    }).toBe("true");
    await expect(cell(page, "api")).toHaveAttribute("data-api-checked-at", String(emission - 29_000));
    await expect(cell(page, "duration")).toHaveAttribute("data-job-checked-at", String(emission));
    await expect(cell(page, "duration").getByRole("button")).toHaveAccessibleName(/2m \/ 10m/);
    expect(Object.fromEntries(reads), "Resume reuses one metadata calibration; precision recovery itself does not collect").toEqual({ ...initial, metadata: 2 });
    await page.clock.runFor(1_000);
    await expect(cell(page, "api")).toHaveAttribute("data-api-current", "false");
    expect(Object.fromEntries(reads)).toEqual({ ...initial, metadata: 2 });
    expect(errors).toEqual([]);
  } finally {
    roster.release(); resources.release(); calibration.release();
    await page.close();
    await fixture.close();
  }
});

for (const boundary of [
  { column: "api", label: "API", validity: 30_000, attribute: "data-api-current", current: "true", retained: "false", valueClass: "node-api-value" },
  { column: "sol", label: "SOL", validity: 60_000, attribute: "data-sol-state", current: "current", retained: "retained", valueClass: "sol-value" },
  { column: "nos", label: "NOS", validity: 180_000, attribute: "data-nos-state", current: "current", retained: "retained", valueClass: "nos-value" },
] as const) {
test(`${boundary.label} expiry crossed during rendering still changes emphasis on the next timer turn`, async ({ page, context }) => {
  const source = snapshots(NOW, NOW + 3_600_000);
  const checkedAt = NOW - boundary.validity + 1;
  if (boundary.column === "api") source["node-info"] = snapshots(checkedAt, NOW + 3_600_000)["node-info"];
  else if (boundary.column === "sol") source.sol = snapshots(checkedAt, NOW + 3_600_000).sol;
  else source.nos = snapshots(checkedAt, NOW + 3_600_000).nos;
  const fixture = await latencyFixture(() => NOW, () => source);
  const reads = new Map<string, number>();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await page.clock.pauseAt(NOW);
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== fixture.origin) { errors.push("Unexpected external request"); return route.abort(); }
    const resource = /^\/preview\/([^/]+)\.json$/.exec(url.pathname)?.[1];
    if (resource && resource !== "connection") reads.set(resource, (reads.get(resource) ?? 0) + 1);
    return route.continue();
  });
  try {
    await page.goto(fixture.origin);
    await expect(cell(page, "api")).toHaveAttribute("data-api-current", "true");
    await expect(cell(page, "duration")).toHaveAttribute("data-duration-freshness", "current");
    await expect(cell(page, "nos")).toHaveAttribute("data-nos-state", "current");
    await expect(cell(page, "stakedNos")).toHaveAttribute("data-staking-state", "current");
    await expect(cell(page, boundary.column)).toHaveAttribute(boundary.attribute, boundary.current);
    await expect.poll(() => clockResources.every(resource => reads.get(resource) === 1)).toBe(true);
    const initialReads = Object.fromEntries(reads);
    // A complete render can cross an evidence deadline after computing a
    // current view but before arming expiry. Advance elapsed time at that exact
    // boundary, without running timers or changing the source observation.
    const crossed = await page.evaluate(({ valueClass, attribute, current }) => {
      const elapsedNow = performance.now.bind(performance);
      let offset = 0;
      let crossed = false;
      const probe = { writes: 0 };
      Object.assign(window, { clockBoundaryProbe: probe });
      Object.defineProperty(performance, "now", { configurable: true, value: () => elapsedNow() + offset });
      const setAttribute = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
        setAttribute.call(this, name, value);
        if (name !== "aria-label" || !this.classList.contains(valueClass)) return;
        probe.writes++;
        if (!crossed && this.closest("td")?.getAttribute(attribute) === current) {
          crossed = true;
          offset += 40;
        }
      };
      document.querySelector<HTMLButtonElement>("#duration-display-toggle")!.click();
      return crossed;
    }, boundary);
    expect(crossed).toBe(true);
    await expect(cell(page, boundary.column)).toHaveAttribute(boundary.attribute, boundary.current);
    await page.clock.runFor(1);
    await expect(cell(page, boundary.column)).toHaveAttribute(boundary.attribute, boundary.retained);
    if (boundary.column === "api") {
      await expect(cell(page, "api").locator(".node-api-value")).toHaveCSS("font-weight", "400");
      await expect(cell(page, "api")).toHaveAttribute("data-api-checked-at", String(checkedAt));
    } else {
      await expect(cell(page, boundary.column).locator(`.${boundary.valueClass}`)).toHaveCSS("color", "rgb(136, 136, 136)");
      await expect(cell(page, boundary.column)).toHaveText(boundary.column === "sol" ? "1.230" : "123");
    }
    // Drain any ordinary coalesced startup render before checking for a loop.
    await page.clock.runFor(20);
    const writes = await page.evaluate(() => (window as unknown as { clockBoundaryProbe: { writes: number } }).clockBoundaryProbe.writes);
    await page.clock.runFor(100);
    expect(await page.evaluate(() => (window as unknown as { clockBoundaryProbe: { writes: number } }).clockBoundaryProbe.writes),
      "Already retained cells must not rearm a one-millisecond render loop").toBe(writes);
    expect(Object.fromEntries(reads), "Display expiry must not collect another source reading").toEqual(initialReads);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    await fixture.close();
  }
});
}

for (const [scenario, phoneSkew] of [["supplied", -3_000], ["real200", 7_200_000]] as const) {
  test(`${scenario}: phone and laptop share evidence time across timezone, wall-clock changes, refresh and stale replay`, async ({ browser }) => {
    const directory = await mkdtemp(join(tmpdir(), "gridlens-clock-browser-"));
    const hostsFile = join(directory, "hosts.json"), real200HostsFile = join(directory, "real200.json");
    await writeFile(hostsFile, JSON.stringify(addresses));
    await writeFile(real200HostsFile, JSON.stringify(addresses));
    let serverNow = NOW;
    let observedAt = NOW;
    const server = await startPreviewServer({ hostsFile, real200HostsFile, port: 0, now: () => serverNow,
      metadataProvider: async () => snapshots(observedAt, serverNow).metadata,
      nodeInfoProvider: async () => snapshots(observedAt, serverNow)["node-info"],
      jobProvider: async () => snapshots(observedAt, serverNow).jobs,
      queueProvider: async () => snapshots(observedAt, serverNow).queue,
      solProvider: async () => snapshots(observedAt, serverNow).sol,
      nosProvider: async () => snapshots(observedAt, serverNow).nos,
      stakingProvider: async () => snapshots(observedAt, serverNow).staking,
    });
    const bound = server.address();
    if (!bound || typeof bound === "string") throw new Error("Missing isolated server port");
    const origin = `http://127.0.0.1:${bound.port}`;
    const contexts: BrowserContext[] = [];
    const pages: Page[] = [];
    const errors: string[] = [];
    try {
      for (const mobile of [false, true]) {
        const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
          isMobile: mobile, hasTouch: mobile, timezoneId: mobile ? "Pacific/Auckland" : "America/New_York", serviceWorkers: "block" });
        contexts.push(context);
        await context.route("**/*", route => {
          if (new URL(route.request().url()).origin !== origin) { errors.push("Unexpected external request"); return route.abort(); }
          return route.continue();
        });
        const page = await context.newPage();
        pages.push(page);
        page.on("pageerror", error => errors.push(error.message));
        await page.clock.install({ time: NOW + (mobile ? phoneSkew : 0) });
        await page.clock.pauseAt(NOW + (mobile ? phoneSkew : 0));
        await page.goto(`${origin}/?scenario=${scenario}`);
        await openPreviewTools(page);
        await current(page, NOW);
        await expect(cell(page, "duration").getByRole("button")).toHaveAccessibleName(/2m \/ 10m/);
        // Capture transient regressions too, not merely the final settled text.
        await page.evaluate(() => {
          const regressions: string[] = [];
          Object.assign(window, { apiClockRegressions: regressions });
          new MutationObserver(() => {
            for (const cell of document.querySelectorAll('td[data-col="api"]')) {
              if (cell.textContent?.includes("Populating")) regressions.push(cell.textContent);
            }
          }).observe(document.querySelector("#fleet-rows")!, { subtree: true, childList: true, characterData: true });
        });
      }
      expect(await readings(pages[1]!)).toEqual(await readings(pages[0]!));
      for (let turn = 0; turn < 3; turn++) {
        serverNow += 20_000;
        observedAt = serverNow;
        await advance(pages, 20_000);
        await refresh(pages);
        for (const page of pages) await current(page, observedAt);
        expect(await readings(pages[1]!)).toEqual(await readings(pages[0]!));
      }
      // Wall time can change after calibration without aging evidence or Duration.
      const before = await readings(pages[1]!);
      await pages[1]!.clock.setSystemTime(NOW - 86_400_000);
      await pages[0]!.clock.setSystemTime(NOW + 86_400_000);
      await advance(pages, 1_000);
      serverNow += 1_000;
      for (const page of pages) await current(page, observedAt);
      expect(await readings(pages[1]!)).toEqual(await readings(pages[0]!));
      expect((await readings(pages[1]!))[0]).toEqual(before[0]);

      // Replayed observations retain their original timestamps despite a new server envelope.
      serverNow += 60_000;
      await advance(pages, 60_000);
      await refresh(pages);
      for (const page of pages) {
        await expect(cell(page, "api")).toHaveText("Online");
        await expect(cell(page, "api")).toHaveAttribute("data-api-current", "false");
        await expect(cell(page, "api")).toHaveAttribute("data-api-checked-at", String(observedAt));
        await expect(cell(page, "queued", 1)).toHaveAttribute("data-queue-current", "false");
        await expect(cell(page, "sol")).toHaveAttribute("data-sol-state", "retained");
        await expect(cell(page, "nos")).toHaveAttribute("data-nos-state", "current");
        await expect(cell(page, "duration")).toHaveAttribute("data-duration-freshness", "current");
        // Offline's recorded retry window outlives Online's 30-second proof window.
        await expect(cell(page, "api", 2)).toHaveAttribute("data-api-current", "true");
      }
      await visibility(pages, "hidden");
      serverNow += 180_000;
      await advance(pages, 180_000);
      await visibility(pages, "visible");
      await refresh(pages);
      for (const page of pages) {
        await expect(cell(page, "api")).toHaveText("Online");
        await expect(cell(page, "api")).toHaveAttribute("data-api-checked-at", String(observedAt));
        await expect(cell(page, "api", 2)).toHaveAttribute("data-api-current", "false");
        await expect(cell(page, "duration")).toHaveAttribute("data-duration-freshness", "retained");
        await expect(cell(page, "nos")).toHaveAttribute("data-nos-state", "retained");
      }
      // Wait through the longest shared account deadline; manual refresh preserves those budgets.
      serverNow += 1_800_000;
      observedAt = serverNow;
      await advance(pages, 1_800_000);
      // The helper's short render steps also advance the paused browser clock.
      // Bring this independent fixture server forward by those elapsed steps
      // before expecting a zero-latency reply to establish a precise bound.
      serverNow = NOW + await pages[0]!.evaluate(() => Math.floor(performance.now()));
      observedAt = serverNow;
      await refresh(pages);
      for (const page of pages) {
        await current(page, observedAt);
        expect(await page.evaluate(() => (window as unknown as { apiClockRegressions: string[] }).apiClockRegressions)).toEqual([]);
      }
      expect(await readings(pages[1]!)).toEqual(await readings(pages[0]!));
      expect(errors).toEqual([]);
    } finally {
      await Promise.all(contexts.map(context => context.close()));
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test.describe("finite provider clock recovery after phone suspension", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("paused elapsed time resumes through one metadata read, retains Duration colors and rearms source deadlines", async ({ page, context }) => {
    const directory = await mkdtemp(join(tmpdir(), "gridlens-clock-sleep-"));
    const hostsFile = join(directory, "hosts.json"), real200HostsFile = join(directory, "real200.json");
    await writeFile(hostsFile, JSON.stringify(addresses));
    await writeFile(real200HostsFile, "[]");
    let serverNow = NOW;
    let releaseMetadata!: () => void;
    const metadataGate = new Promise<void>(resolve => { releaseMetadata = resolve; });
    const reads = { metadata: 0, state: 0, jobs: 0, queue: 0, sol: 0, nos: 0, staking: 0 };
    const server = await startPreviewServer({ hostsFile, real200HostsFile, port: 0, now: () => serverNow,
      metadataProvider: async () => {
        if (++reads.metadata === 2) await metadataGate;
        return snapshots(NOW, serverNow).metadata;
      },
      nodeInfoProvider: async () => {
        reads.state++;
        const result = snapshots(NOW, serverNow)["node-info"];
        result.hosts = result.hosts.map(record => ({ ...record, values: { state: "RUNNING_JOB", dl: 100, ul: 20, ping: 8, networkUnavailableReason: null } }));
        return result;
      },
      jobProvider: async () => {
        reads.jobs++;
        const result = snapshots(NOW, serverNow).jobs;
        result.hosts = result.hosts.map((record, index) => ({ ...record, job: {
          address: identities[index + 3]!, node: record.address, state: "RUNNING",
          timeStart: NOW / 1_000 - [120, 901, 900][index]!, timeEnd: 0, timeout: 600,
        } }));
        return result;
      },
      queueProvider: async () => {
        reads.queue++;
        const result = snapshots(NOW, serverNow).queue;
        result.hosts = result.hosts.map(record => ({ ...record, position: null }));
        return result;
      },
      solProvider: async () => { reads.sol++; return snapshots(NOW, serverNow).sol; },
      nosProvider: async () => { reads.nos++; return snapshots(NOW, serverNow).nos; },
      stakingProvider: async () => { reads.staking++; return snapshots(NOW, serverNow).staking; },
    });
    const bound = server.address();
    if (!bound || typeof bound === "string") throw new Error("Missing isolated server port");
    const origin = `http://127.0.0.1:${bound.port}`;
    const failures: string[] = [];
    let rosterReads = 0;
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { failures.push("Unexpected external request"); return route.abort(); }
      if (url.pathname === "/preview/hosts.json") rosterReads++;
      return route.continue();
    });
    page.on("pageerror", error => failures.push(error.message));
    await page.clock.install({ time: NOW - 3_000 });
    await page.clock.pauseAt(NOW - 3_000);
    try {
      await page.goto(origin);
      await expect(cell(page, "api")).toHaveAttribute("data-api-current", "true");
      await expect(cell(page, "nos")).toHaveAttribute("data-nos-state", "current");
      await expect(cell(page, "stakedNos")).toHaveAttribute("data-staking-state", "current");
      await expect(cell(page, "duration", 2)).toHaveAttribute("data-duration-freshness", "current");
      await expect(cell(page, "duration", 2)).toHaveAttribute("data-duration-tone", "current");
      await expect(cell(page, "duration", 1)).toHaveAttribute("data-duration-tone", "exceeded");
      const initialReads = { ...reads };
      const elapsedBeforeSleep = await page.evaluate(() => performance.now());
      await visibility([page], "hidden");
      // Some platforms pause performance.now during OS sleep. Only the independent
      // server clock advances, beyond State/SOL/job/NOS deadlines but before metadata's.
      serverNow += 240_000;
      await visibility([page], "visible");
      await expect.poll(() => reads.metadata).toBe(initialReads.metadata + 1);
      expect(await page.evaluate(() => performance.now()) - elapsedBeforeSleep).toBe(20);
      await expect(cell(page, "api")).toHaveText("Online");
      await expect(cell(page, "api")).toHaveAttribute("data-api-current", "false");
      await expect(cell(page, "duration")).toHaveAttribute("data-duration-freshness", "retained");
      await expect(cell(page, "duration").locator(".duration-fill")).toHaveCSS("background-color", "rgb(40, 122, 71)");
      await expect(cell(page, "duration", 1).locator(".duration-fill")).toHaveCSS("background-color", "rgb(150, 48, 48)");
      await expect(cell(page, "duration", 2)).toHaveAttribute("data-duration-tone", "current");
      await expect(cell(page, "duration", 2).locator(".duration-fill")).toHaveCSS("background-color", "rgb(40, 122, 71)");
      await expect(page.locator("#fleet-connection")).toHaveAttribute("data-connection-state", "connected");
      expect(reads, "Connection success cannot refresh the evidence clock or dispatch overdue source reads").toEqual({
        ...initialReads, metadata: initialReads.metadata + 1,
      });

      // Even before time is revalidated, retained Duration keeps its old start,
      // original grace boundary and dim overrun color instead of becoming unknown.
      await page.clock.runFor(1_000);
      await expect(cell(page, "duration", 2)).toHaveAttribute("data-duration-tone", "exceeded");
      await expect(cell(page, "duration", 2)).toHaveAttribute("data-duration-freshness", "retained");
      await expect(cell(page, "duration", 2).locator(".duration-fill")).toHaveCSS("background-color", "rgb(150, 48, 48)");
      releaseMetadata();
      await expect.poll(async () => {
        await page.clock.runFor(20);
        return [reads.state, reads.jobs, reads.queue, reads.sol, reads.nos];
      }).toEqual([initialReads.state + 1, initialReads.jobs + 1, initialReads.queue + 1, initialReads.sol + 1, initialReads.nos + 1]);
      await expect(cell(page, "duration").getByRole("button")).toHaveAccessibleName(/6m/);
      await expect(cell(page, "duration")).toHaveAttribute("data-duration-freshness", "retained");
      await expect(cell(page, "duration")).toHaveAttribute("data-job-checked-at", String(NOW));
      await expect(cell(page, "api")).toHaveAttribute("data-api-checked-at", String(NOW));
      await expect(cell(page, "api")).toHaveAttribute("data-api-current", "false");
      await expect(cell(page, "sol")).toHaveAttribute("data-sol-state", "retained");
      await expect(cell(page, "nos")).toHaveAttribute("data-nos-state", "retained");
      expect(reads.metadata).toBe(initialReads.metadata + 1);
      expect(reads.staking).toBe(initialReads.staking);
      expect(rosterReads).toBe(1);
      expect(failures).toEqual([]);
    } finally {
      releaseMetadata();
      await page.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
