import { openPreviewTools } from "./helpers.ts";
import { emptyStaking } from "../fixtures/staking.ts";
import { emptyNos } from "../fixtures/nos.ts";
import { emptySol } from "../fixtures/sol.ts";
import { emptyQueue } from "../fixtures/queue.ts";
import { emptyJobs } from "../fixtures/jobs.ts";
import { expect, test } from "@playwright/test";
import type { JSHandle, Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPreviewServer } from "../../scripts/preview-server.ts";
import type { HostMetadataSnapshot } from "../../src/fleet/host-metadata.ts";
import type { NodeInfoSnapshot } from "../../src/fleet/node-info.ts";
import { SYNTHETIC_HOST_ADDRESSES } from "../fixtures/host-addresses.ts";

// Isolated public identities, providers and browser clock: no live host reads.
const addresses = SYNTHETIC_HOST_ADDRESSES;
const NOW = Date.UTC(2026, 0, 1, 12);
const servers: Server[] = [];
const directories: string[] = [];
const externalRequests: string[] = [];
const errors: string[] = [];
let origin = "";
let nodeRequests = 0;
let metadataRequests = 0;
let addressRequests = 0;

function snapshot(nowMs: number): NodeInfoSnapshot {
  return { hosts: addresses.map((address, index) => ({
    address,
    values: {
      state: ["OTHER", "QUEUED", "RESTARTING", "BENCHMARKING", "HEALTHCHECK", "STARTING", "JOINING_MARKET", "OTHER"][index]!,
      dl: 100, ul: 20, ping: 8, networkUnavailableReason: null,
    },
    fetchedAtMs: nowMs, validUntilMs: nowMs + 30_000, retained: false, error: null,
    ...(index === 0 ? { activity: {
      state: "RUNNING_JOB" as const, source: "nosana-indexer" as const,
      checkedAtMs: nowMs, validUntilMs: nowMs + 30_000, error: null,
    } } : {}),
  })) };
}

function emptyMetadata(input: readonly string[]): Promise<HostMetadataSnapshot> {
  return Promise.resolve({ hosts: input.map(address => ({
    address, values: null, fetchedAtMs: null, retained: false, error: null, marketError: null,
  })) });
}

function premiumMetadata(input: readonly string[]): Promise<HostMetadataSnapshot> {
  return Promise.resolve({ hosts: input.map(address => ({
    address, values: {
      status: "PREMIUM", marketAddress: null, marketLabel: null,
      ram: null, disk: null, cpu: null, cuda: null, nvidia: null, currentNode: null, system: null,
    }, fetchedAtMs: NOW, retained: false, error: null, marketError: null,
  })) });
}

interface KeptStatusText {
  elements: { selector: string; element: Element; textNode: ChildNode | null; text: string | null; mutations: number }[];
  layout: { selector: string; y: number; height: number }[];
  observer: MutationObserver;
}

async function keepStatusText(page: Page): Promise<JSHandle<KeptStatusText>> {
  return page.evaluateHandle(address => {
    const selectors = ["#node-info-status", "#metadata-status", "#inventory-summary", "#sort-status",
      `#fleet-rows [data-host="${address}"] td[data-col="status"] button`];
    const elements = selectors.map(selector => {
      const element = document.querySelector(selector)!;
      return { selector, element, textNode: element.firstChild, text: element.textContent, mutations: 0 };
    });
    const observer = new MutationObserver(records => {
      for (const record of records) {
        const entry = elements.find(entry => entry.element === record.target || entry.element.contains(record.target));
        if (entry) entry.mutations++;
      }
    });
    for (const { element } of elements) observer.observe(element, {
      childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class"],
    });
    const layout = ["#metadata-status", "#node-info-status", "footer"].map(selector => {
      const rect = document.querySelector(selector)!.getBoundingClientRect();
      return { selector, y: rect.y + window.scrollY, height: rect.height };
    });
    return { elements, layout, observer };
  }, addresses[0]!);
}

async function expectStatusTextKept(saved: JSHandle<KeptStatusText>): Promise<void> {
  const result = await saved.evaluate(kept => ({
    elements: kept.elements.map(entry => ({
      selector: entry.selector,
      sameElement: document.querySelector(entry.selector) === entry.element,
      sameTextNode: entry.element.firstChild === entry.textNode,
      sameText: entry.element.textContent === entry.text,
      mutations: entry.mutations,
    })),
    layout: kept.layout.map(before => {
      const rect = document.querySelector(before.selector)!.getBoundingClientRect();
      return { selector: before.selector, sameY: rect.y + window.scrollY === before.y, sameHeight: rect.height === before.height };
    }),
  }));
  for (const entry of result.elements) {
    expect(entry, `${entry.selector} must not flicker or repeat its live-region announcement`).toEqual({
      selector: entry.selector, sameElement: true, sameTextNode: true, sameText: true, mutations: 0,
    });
  }
  for (const entry of result.layout) {
    expect(entry, `${entry.selector} must not jump while refresh is pending`).toEqual({
      selector: entry.selector, sameY: true, sameHeight: true,
    });
  }
}

async function acceptUpdatedCheckTime(saved: JSHandle<KeptStatusText>): Promise<void> {
  await saved.evaluate(kept => {
    const entry = kept.elements.find(value => value.selector === "#node-info-status")!;
    entry.text = entry.element.textContent;
    entry.textNode = entry.element.firstChild;
    entry.mutations = 0;
  });
}

async function start(
  provider: () => Promise<NodeInfoSnapshot>,
  metadataProvider = emptyMetadata,
  now = () => NOW,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "gridlens-state-refresh-browser-"));
  directories.push(directory);
  const hostsFile = join(directory, "hosts.json");
  await writeFile(hostsFile, JSON.stringify(addresses));
  const server = await startPreviewServer({ now, stakingProvider: emptyStaking, nosProvider: emptyNos, solProvider: emptySol, queueProvider: emptyQueue, jobProvider: emptyJobs, hostsFile, port: 0, nodeInfoProvider: provider, metadataProvider });
  servers.push(server);
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("Missing isolated preview port");
  origin = `http://127.0.0.1:${bound.port}`;
  return origin;
}

function stateCell(page: Page, index = 0) {
  return page.locator(`#fleet-rows [data-host="${addresses[index]}"] td[data-col="state"]`);
}

async function visibility(page: Page, value: "hidden" | "visible"): Promise<void> {
  await page.evaluate(state => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => state === "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, value);
  // The clock is paused; let the resumed view's due setTimeout(0) execute.
  if (value === "visible") await page.clock.runFor(1);
}

interface KeptIcon {
  button: Element;
  artwork: Element;
  svg: Element | null;
  moving: Element;
  animation: Animation | null;
  time: number;
}

async function keepIcon(page: Page, index = 0): Promise<JSHandle<KeptIcon>> {
  return stateCell(page, index).getByRole("button").evaluateHandle(button => {
    const artwork = button.querySelector(".node-state-art")!;
    const moving = artwork.querySelector(".state-running-ring, .state-queued-ring, .state-dots")!;
    const animation = moving.getAnimations()[0] ?? null;
    return { button, artwork, svg: artwork.querySelector("svg"), moving, animation,
      time: typeof animation?.currentTime === "number" ? animation.currentTime : 0 };
  });
}

async function expectKept(icon: JSHandle<KeptIcon>, animated = true): Promise<void> {
  const result = await icon.evaluate(saved => ({
    connected: saved.button.isConnected && saved.artwork.isConnected && saved.moving.isConnected,
    sameArtwork: saved.button.querySelector(".node-state-art") === saved.artwork,
    sameSVG: saved.artwork.querySelector("svg") === saved.svg,
    sameAnimation: saved.moving.getAnimations()[0] === saved.animation,
    time: typeof saved.animation?.currentTime === "number" ? saved.animation.currentTime : 0,
    previous: saved.time,
  }));
  expect(result.connected, "The actual connected state DOM survives refresh").toBe(true);
  expect(result.sameArtwork).toBe(true);
  expect(result.sameSVG).toBe(true);
  if (animated) {
    expect(result.sameAnimation, "The CSS animation itself must not restart").toBe(true);
    expect(result.time).toBeGreaterThanOrEqual(result.previous);
  }
}

async function expectStale(page: Page, index: number, kind: string, moving = true): Promise<void> {
  const cell = stateCell(page, index);
  await expect(cell.getByRole("button")).toHaveClass(/node-state-retained/);
  await expect(cell.getByRole("button")).toHaveClass(/node-state-animated/);
  await expect(cell.getByRole("button")).toHaveAccessibleName(/stale|retained/i);
  await expect(cell.locator(`.state-${kind}`)).toBeVisible();
  await expect(cell.locator(`.state-${kind}`)).toHaveCSS("color", { running: "rgb(36, 78, 148)", queued: "rgb(40, 122, 71)", restarting: "rgb(139, 89, 6)" }[kind]!);
  expect(await cell.locator("*").evaluateAll(elements => elements.some(element => getComputedStyle(element).animationName !== "none"))).toBe(moving);
}

test.beforeEach(async ({ context, page }) => {
  origin = "";
  nodeRequests = metadataRequests = addressRequests = 0;
  externalRequests.length = errors.length = 0;
  await page.clock.install({ time: NOW - 1_000 });
  await page.clock.pauseAt(NOW);
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) {
      externalRequests.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path === "/preview/node-info.json") nodeRequests++;
    if (path === "/preview/metadata.json") metadataRequests++;
    if (path === "/preview/hosts.json") addressRequests++;
  });
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
});

test.afterEach(async ({ page }) => {
  // End browser polling before closing its isolated provider server.
  await page.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  expect(externalRequests, "Refresh tests must never contact real services").toEqual([]);
  expect(errors, "No browser runtime or loading errors").toEqual([]);
});

test("unchanged status text and narrow-page layout survive held automatic and manual refreshes without DOM mutations", async ({ page }) => {
  let calls = 0;
  let metadataCalls = 0;
  let releaseAuto!: () => void;
  let releaseManual!: () => void;
  const automaticRead = new Promise<void>(resolve => { releaseAuto = resolve; });
  const manualRead = new Promise<void>(resolve => { releaseManual = resolve; });
  await page.setViewportSize({ width: 390, height: 1200 });
  await page.goto(await start(async () => {
    calls++;
    if (calls === 2) await automaticRead;
    if (calls === 3) await manualRead;
    return snapshot(await page.evaluate(() => Date.now()));
  }, async input => {
    if (++metadataCalls === 2) await manualRead;
    const result = await premiumMetadata(input);
    // A field outside the observed status text proves the browser applied the
    // second metadata payload, even though all status labels remain identical.
    for (const host of result.hosts) host.values!.currentNode = metadataCalls === 1 ? "1.0.0" : "1.0.1";
    return result;
  }));
  await openPreviewTools(page);
  await expect(page.locator("#node-info-status")).toContainText("7/8 recent state readings");
  await expect(page.locator("#inventory-summary")).toContainText("8/8 host reports available");
  const versions = page.locator('#fleet-rows td[data-col="currentNode"]');
  await expect(versions).toHaveText(Array(addresses.length).fill("1.0.0"));
  const saved = await keepStatusText(page);
  const initialLayout = await saved.evaluate(value => value.layout);
  expect(initialLayout.find(entry => entry.selector === "#node-info-status")!.height,
    "The narrow viewport must exercise wrapping of the full summary").toBeGreaterThan(40);

  await page.clock.fastForward(20_000);
  await expect.poll(() => calls).toBe(2);
  await expectStatusTextKept(saved);
  await page.clock.fastForward(5_000);
  await expectStatusTextKept(saved);
  const autoResponse = page.waitForResponse(response => response.url().endsWith("/preview/node-info.json"));
  releaseAuto();
  await autoResponse;
  await page.clock.runFor(1);
  await expect(page.locator("#node-info-status")).toContainText("Latest successful API check: 2026-01-01T12:00:25.000Z");
  await acceptUpdatedCheckTime(saved);
  await expectStatusTextKept(saved);
  expect(metadataCalls).toBe(1);

  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect.poll(() => calls).toBe(3);
  await expect.poll(() => metadataCalls).toBe(2);
  await expectStatusTextKept(saved);
  await page.clock.fastForward(2_000);
  await expectStatusTextKept(saved);
  const manualResponses = Promise.all([
    page.waitForResponse(response => response.url().endsWith("/preview/node-info.json")),
    page.waitForResponse(response => response.url().endsWith("/preview/metadata.json")),
  ]);
  releaseManual();
  await manualResponses;
  // With the clock paused, drain the scheduled UI turn before checking the
  // applied snapshots. Network EOF is not evidence that either view rendered.
  await page.clock.runFor(1);
  await expect(page.locator("#node-info-status")).toContainText("Latest successful API check: 2026-01-01T12:00:27.001Z");
  await expect(versions).toHaveText(Array(addresses.length).fill("1.0.1"));
  await acceptUpdatedCheckTime(saved);
  await expectStatusTextKept(saved);
  await saved.evaluate(value => value.observer.disconnect());
  expect(nodeRequests).toBe(3);
  expect(metadataRequests).toBe(2);
  expect(addressRequests).toBe(1);
});

test("initial loading, actual expiry and read failures remain visible and recover after a pending retry", async ({ page }) => {
  let calls = 0;
  let metadataCalls = 0;
  let releaseInitial!: () => void;
  let releaseExpired!: () => void;
  let releaseRecovery!: () => void;
  const initialRead = new Promise<void>(resolve => { releaseInitial = resolve; });
  const expiredRead = new Promise<void>(resolve => { releaseExpired = resolve; });
  const recoveryRead = new Promise<void>(resolve => { releaseRecovery = resolve; });
  await page.goto(await start(async () => {
    calls++;
    if (calls === 1) await initialRead;
    if (calls === 2) {
      await expiredRead;
      return { hosts: snapshot(NOW).hosts.map(host => ({ ...host, retained: true, error: "Node Info unavailable (HTTP 503)." })) };
    }
    if (calls === 3) await recoveryRead;
    return snapshot(await page.evaluate(() => Date.now()));
  }, async input => {
    metadataCalls++;
    if (metadataCalls === 1) await initialRead;
    if (metadataCalls === 2) {
      const result = await premiumMetadata(input);
      return { hosts: result.hosts.map(host => ({ ...host, retained: true, error: "Metrics unavailable (HTTP 429)." })) };
    }
    if (metadataCalls === 3) await recoveryRead;
    return premiumMetadata(input);
  }));
  await openPreviewTools(page);
  await expect(page.locator("#node-info-status")).toHaveText("Reading Node Info state and network fields…");
  await expect(page.locator("#metadata-status")).toHaveText("Reading Nosana metadata…");
  await expect(page.locator("#inventory-summary")).toHaveText("Loading reported Nosana metadata…");
  await expect(stateCell(page, 7).locator(".state-unknown .state-dots")).toBeVisible();
  await expect(stateCell(page, 7)).toHaveAttribute("data-state-current", "false");
  const pendingUnknown = await keepIcon(page, 7);
  await stateCell(page, 7).getByRole("button").focus();
  releaseInitial();
  await expect(page.locator("#node-info-status")).toContainText("7/8 recent state readings");
  await expect(page.locator("#inventory-summary")).toContainText("8/8 host reports available");
  await expectKept(pendingUnknown);
  await expect(stateCell(page, 7).getByRole("button")).toBeFocused();
  await expect(stateCell(page, 7).getByRole("button")).toHaveAccessibleName(/unknown/i);
  await expect(stateCell(page, 7).locator(".state-unknown")).toHaveCSS("color", "rgb(99, 64, 6)");
  await page.clock.fastForward(20_000);
  await expect.poll(() => calls).toBe(2);
  await expect(page.locator("#node-info-status")).toContainText("7/8 recent state readings");
  await page.clock.fastForward(10_100);
  await expect(page.locator("#node-info-status")).toContainText("0/8 recent state readings");
  await expectStale(page, 0, "running");
  releaseExpired();
  await expect(page.locator("#node-info-status")).toContainText("8 unavailable reads; last reported values retained");
  await expectKept(pendingUnknown);
  await expect(stateCell(page, 7).getByRole("button")).toBeFocused();

  // The automatic failed node read has settled; a manual read also returns a metadata failure.
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect.poll(() => calls).toBe(3);
  await expect(page.locator("#metadata-status")).toContainText("8 host reports have unavailable reads");
  const failedNodeText = await page.locator("#node-info-status").textContent();
  const failedMetadataText = await page.locator("#metadata-status").textContent();
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect.poll(() => metadataCalls).toBe(3);
  await expect(page.locator("#node-info-status")).toHaveText(failedNodeText!);
  await expect(page.locator("#metadata-status")).toHaveText(failedMetadataText!);
  releaseRecovery();
  await expect(page.locator("#node-info-status")).toContainText("7/8 recent state readings");
  await expect(page.locator("#node-info-status")).not.toContainText("unavailable reads");
  await expect(page.locator("#metadata-status")).toHaveText("Reported Nosana metadata. Successful metrics reads are cached for five minutes; State is checked separately.");
  await expect(stateCell(page).getByRole("button")).toHaveAccessibleName(/: RUNNING_JOB\./);
  await expectKept(pendingUnknown);
  await expect(stateCell(page, 7).getByRole("button")).toHaveAccessibleName(/unknown/i);
  expect(calls).toBe(3);
});

test("visible refresh preserves useful and unknown animations through repeated 20/30/60 second boundaries", async ({ page }) => {
  let calls = 0;
  let metadataCalls = 0;
  let releaseMetadata!: (value: HostMetadataSnapshot) => void;
  const delayedMetadata = new Promise<HostMetadataSnapshot>(resolve => { releaseMetadata = resolve; });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(await start(async () => {
    calls++;
    return snapshot(await page.evaluate(() => Date.now()));
  }, async input => ++metadataCalls === 1 ? delayedMetadata : emptyMetadata(input)));
  await openPreviewTools(page);
  await expect(stateCell(page).locator(".state-running-ring")).not.toHaveCSS("animation-name", "none");
  const icons = await Promise.all([0, 1, 2, 7].map(index => keepIcon(page, index)));
  await expect.poll(async () => icons[0]!.evaluate(saved => typeof saved.animation?.currentTime === "number" && saved.animation.currentTime > saved.time)).toBe(true);
  releaseMetadata(await emptyMetadata(addresses));
  await expect(page.locator("#metadata-status")).not.toContainText(/loading/i);
  for (const icon of icons) await expectKept(icon);
  await page.getByRole("button", { name: "Toggle Market display", exact: true }).click();
  await page.getByRole("button", { name: "Toggle NVIDIA display", exact: true }).click();
  await page.locator("#clear-sort").click();
  for (const icon of icons) await expectKept(icon);
  await page.getByRole("button", { name: "Sort by State", exact: true }).click();
  for (const icon of icons) await expectKept(icon);
  await page.getByRole("button", { name: "Sort by State", exact: true }).click();
  for (const icon of icons) await expectKept(icon);

  await stateCell(page, 7).getByRole("button").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toContainText("OTHER");
  await expect(page.getByRole("dialog")).toContainText("No useful activity");
  for (let cycle = 1; cycle <= 4; cycle++) {
    await page.clock.fastForward(20_000);
    await expect.poll(() => calls).toBe(cycle + 1);
    await expect(stateCell(page).getByRole("button")).toHaveAccessibleName(/: RUNNING_JOB\./);
    await expect(page.locator("#node-info-status")).not.toContainText(/loading/i);
    for (const icon of icons) await expectKept(icon);
    for (const index of [0, 1, 2, 7]) await expect(stateCell(page, index).getByRole("button")).toHaveClass(/node-state-animated/);
    await expect(stateCell(page, 7)).toHaveAttribute("data-state-current", "false");
    await expect(stateCell(page, 7).locator(".state-unknown")).toHaveCSS("color", "rgb(99, 64, 6)");
  }
  await page.keyboard.press("Escape");
  await expect(stateCell(page, 7).getByRole("button")).toBeFocused();
  expect(metadataCalls).toBe(1);
  expect(metadataRequests).toBe(1);
  expect(addressRequests).toBe(1);
  expect(nodeRequests).toBe(5);
  // Manual metadata/node refresh also keeps the same artwork and CSS timelines.
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect.poll(() => calls).toBe(6);
  await expect.poll(() => metadataCalls).toBe(2);
  await expect(page.locator("#node-info-status")).not.toContainText(/loading/i);
  for (const icon of icons) await expectKept(icon);
});

test("unchanged provider timestamps expire to retained dim artwork despite successful automatic HTTP reads", async ({ page }) => {
  let calls = 0;
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(await start(async () => { calls++; return snapshot(NOW); }));
  await openPreviewTools(page);
  await expect(stateCell(page).locator(".state-running")).toBeVisible();
  const icons = await Promise.all([0, 1, 2].map(index => keepIcon(page, index)));
  await page.clock.fastForward(20_000);
  await expect.poll(() => calls).toBe(2);
  await expect(page.locator("#node-info-status")).not.toContainText(/loading/i);
  await page.clock.fastForward(10_100);
  for (const [index, kind] of ["running", "queued", "restarting"].entries()) {
    await expectStale(page, index, kind);
    await expectKept(icons[index]!);
  }
  await stateCell(page).getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText(/stale|retained/i);
  await expect(page.getByRole("dialog")).toContainText("OTHER");
  await expect(page.getByRole("dialog")).not.toContainText("STOPPED");
  expect(calls).toBe(2);
});

test("a cached manual refresh does not postpone the already scheduled automatic state read", async ({ page }) => {
  let calls = 0;
  const cached = snapshot(NOW);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(await start(async () => {
    calls++;
    return calls === 2 ? cached : snapshot(await page.evaluate(() => Date.now()));
  }));
  await openPreviewTools(page);
  await expect(stateCell(page).locator(".state-running-ring")).not.toHaveCSS("animation-name", "none");
  const icons = await Promise.all([0, 1, 2].map(index => keepIcon(page, index)));
  await page.clock.fastForward(10_000);
  expect(calls).toBe(1);
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect.poll(() => calls).toBe(2);
  await expect(page.locator("#node-info-status")).not.toContainText(/loading/i);
  for (const icon of icons) await expectKept(icon);
  await page.clock.fastForward(9_999);
  expect(calls).toBe(2);
  await page.clock.fastForward(1);
  await expect.poll(() => calls).toBe(3);
  await expect(page.locator("#node-info-status")).not.toContainText(/loading/i);
  await expect(stateCell(page).getByRole("button")).toHaveAccessibleName(/: RUNNING_JOB\./);
  for (const icon of icons) await expectKept(icon);
  await page.clock.fastForward(20_000);
  await expect.poll(() => calls).toBe(4);
  await expect(page.locator("#node-info-status")).not.toContainText(/loading/i);
  for (const icon of icons) await expectKept(icon);
  expect(nodeRequests).toBe(4);
  expect(metadataRequests).toBe(2);
  expect(addressRequests).toBe(1);
  expect(cached.hosts[0]!.fetchedAtMs).toBe(NOW);
});

test("failed raw OTHER read retains its last resolved icon and evidence then recovers on fresh automatic read", async ({ page }) => {
  let calls = 0;
  const initial = snapshot(NOW);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(await start(async () => {
    calls++;
    if (calls === 2) return { hosts: initial.hosts.map(host => {
      const { activity: _activity, ...raw } = host;
      return { ...raw, retained: true, error: "Node Info unavailable (HTTP 503)." };
    }) };
    return snapshot(await page.evaluate(() => Date.now()));
  }));
  await openPreviewTools(page);
  await expect(stateCell(page).locator(".state-running")).toBeVisible();
  const icons = await Promise.all([0, 1, 2].map(index => keepIcon(page, index)));
  await page.clock.fastForward(20_000);
  await expect.poll(() => calls).toBe(2);
  for (const [index, kind] of ["running", "queued", "restarting"].entries()) {
    await expectStale(page, index, kind);
    await expectKept(icons[index]!);
  }
  await stateCell(page).getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText("OTHER");
  await expect(page.getByRole("dialog")).toContainText("RUNNING_JOB");
  await expect(page.getByRole("dialog")).toContainText("503");
  await expect(page.getByRole("dialog")).toContainText(/indexer/i);
  await page.keyboard.press("Escape");
  await page.clock.fastForward(20_000);
  await expect.poll(() => calls).toBe(3);
  await expect(stateCell(page).getByRole("button")).toHaveAccessibleName(/: RUNNING_JOB\./);
  for (const index of [0, 1, 2]) {
    await expect(stateCell(page, index).getByRole("button")).toHaveClass(/node-state-animated/);
    await expectKept(icons[index]!);
  }
  await expect(stateCell(page).locator(".state-running-ring")).not.toHaveCSS("animation-name", "none");
  expect(metadataRequests).toBe(1);
});

test("explicit state changes replace only the affected artwork while neighboring animations continue", async ({ page }) => {
  let calls = 0;
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(await start(async () => {
    calls++;
    const result = snapshot(await page.evaluate(() => Date.now()));
    if (calls > 1) {
      const host = result.hosts[0]!;
      host.values!.state = calls === 2 ? "QUEUED" : "BENCHMARKING";
      delete host.activity;
    }
    return result;
  }));
  await openPreviewTools(page);
  await expect(stateCell(page).locator(".state-running")).toBeVisible();
  const original = await keepIcon(page);
  const neighbor = await keepIcon(page, 1);
  await page.clock.fastForward(20_000);
  await expect(stateCell(page).locator(".state-queued")).toBeVisible();
  await expect(stateCell(page).locator(".state-running")).toHaveCount(0);
  expect(await original.evaluate(saved => saved.button.isConnected && !saved.artwork.isConnected)).toBe(true);
  await expectKept(neighbor);
  await page.clock.fastForward(20_000);
  await expect(stateCell(page).getByRole("button")).toHaveText("B");
  await expect(stateCell(page).getByRole("button")).toHaveAccessibleName(/: BENCHMARKING\./);
  await expect(stateCell(page).locator("svg")).toHaveCount(0);
  await expectKept(neighbor);
  expect(calls).toBe(3);
});

test("hidden pages and synthetic views stop automatic reads, visibility resumes them, and pagehide cancels them", async ({ page }) => {
  let calls = 0;
  let serverNow = NOW;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(await start(async () => {
    calls++;
    if (calls === 2) await pending;
    const at = await page.evaluate(() => Date.now());
    serverNow = at;
    return snapshot(at);
  }, emptyMetadata, () => serverNow));
  await openPreviewTools(page);
  await expect(stateCell(page).locator(".state-running")).toBeVisible();
  await visibility(page, "hidden");
  await page.clock.fastForward(60_000);
  expect(calls).toBe(1);
  await visibility(page, "visible");
  await expect.poll(() => calls).toBe(2);
  await expectStale(page, 0, "running");
  release();
  await expect(stateCell(page).getByRole("button")).toHaveAccessibleName(/: RUNNING_JOB\./);
  await page.getByLabel("Scenario", { exact: true }).selectOption("states");
  await page.clock.fastForward(60_000);
  expect(calls).toBe(2);
  await page.getByLabel("Scenario", { exact: true }).selectOption("supplied");
  await page.clock.runFor(1);
  await expect.poll(() => calls).toBe(3);
  await expect(stateCell(page).getByRole("button")).toHaveAccessibleName(/: RUNNING_JOB\./);
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await page.clock.fastForward(60_000);
  expect(calls).toBe(3);
  expect(nodeRequests).toBe(3);
  expect(metadataRequests).toBe(1);
  expect(addressRequests).toBe(1);
});

test("slow automatic reads never overlap and expired evidence stays dimmed until completion", async ({ page }) => {
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto(await start(async () => {
    calls++;
    maximumActive = Math.max(maximumActive, ++active);
    if (calls === 2) await delayed;
    const result = snapshot(await page.evaluate(() => Date.now()));
    active--;
    return result;
  }));
  await openPreviewTools(page);
  await expect(stateCell(page).locator(".state-running")).toBeVisible();
  await page.clock.fastForward(20_000);
  await expect.poll(() => calls).toBe(2);
  await page.clock.fastForward(60_000);
  await expectStale(page, 0, "running");
  expect(calls).toBe(2);
  expect(nodeRequests).toBe(2);
  expect(maximumActive).toBe(1);
  release();
  await expect(stateCell(page).getByRole("button")).toHaveAccessibleName(/: RUNNING_JOB\./);
  await page.clock.fastForward(20_000);
  await expect.poll(() => calls).toBe(3);
  expect(maximumActive).toBe(1);
});

test("shorter supporting evidence deadline refreshes before expiry without extending source validity", async ({ page }) => {
  let calls = 0;
  let cached = snapshot(NOW);
  await page.goto(await start(async () => {
    calls++;
    if (calls > 2) return cached;
    const nowMs = await page.evaluate(() => Date.now());
    const result = snapshot(nowMs);
    result.hosts[0]!.activity!.checkedAtMs = nowMs - 10_000;
    result.hosts[0]!.activity!.validUntilMs = nowMs + 20_000;
    cached = result;
    return result;
  }));
  await openPreviewTools(page);
  await expect(stateCell(page).getByRole("button")).toHaveAccessibleName(/: RUNNING_JOB\./);
  await page.clock.fastForward(14_000);
  expect(calls).toBe(1);
  await page.clock.fastForward(1_100);
  await expect.poll(() => calls).toBe(2);
  await expect(page.locator("#node-info-status")).not.toContainText(/loading/i);
  await visibility(page, "hidden");
  await page.clock.fastForward(20_100);
  expect(calls).toBe(2);
  await visibility(page, "visible");
  await expectStale(page, 0, "running");
  await expect.poll(() => calls).toBe(3);
  expect(cached.hosts[0]!.activity!.checkedAtMs).toBe(NOW + 5_100);
});

test("reduced motion keeps unchanged artwork legible and still across automatic refresh and expiration", async ({ page }) => {
  let calls = 0;
  let cached = snapshot(NOW);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(await start(async () => {
    calls++;
    if (calls <= 4) cached = snapshot(await page.evaluate(() => Date.now()));
    return cached;
  }));
  await openPreviewTools(page);
  await page.getByLabel("State animation", { exact: true }).selectOption("system");
  await expect(stateCell(page).locator(".state-running")).toBeVisible();
  const icons = await Promise.all([0, 1, 2].map(index => keepIcon(page, index)));
  for (let cycle = 0; cycle < 3; cycle++) {
    await page.clock.fastForward(20_000);
    await expect.poll(() => calls).toBe(cycle + 2);
    await expect(page.locator("#node-info-status")).not.toContainText(/loading/i);
    for (const icon of icons) {
      await expectKept(icon, false);
      expect(await icon.evaluate(saved => getComputedStyle(saved.moving).animationName)).toBe("none");
    }
  }
  await visibility(page, "hidden");
  await page.clock.fastForward(31_000);
  expect(calls).toBe(4);
  await visibility(page, "visible");
  for (const [index, kind] of ["running", "queued", "restarting"].entries()) {
    await expectStale(page, index, kind, false);
    await expectKept(icons[index]!, false);
  }
  await expect.poll(() => calls).toBe(5);
});
