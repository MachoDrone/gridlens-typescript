import { expect, test } from "@playwright/test";
import { startFleetServer, closeFleetServer } from "../../src/server/application.ts";
import { createMemorySnapshotStore, emptyFleetSnapshots } from "../../src/server/snapshot-store.ts";
import { createSnapshotSource } from "../../src/server/snapshot-source.ts";
import type { FleetContext } from "../../src/contracts/fleet.ts";
import { SYNTHETIC_HOST_ADDRESSES as addresses } from "../fixtures/host-addresses.ts";

test("the actual hosted gateway reuses aged data, accepts updates without viewers and serves the same UI after three days", async ({ page, context }) => {
  const original = Date.UTC(2026, 0, 1, 12);
  const now = original + 3 * 86_400_000;
  const fleet: FleetContext = { scopeId: "isolated-browser", rosterRevision: "one", addresses };
  const snapshots = (at: number) => {
    const result = emptyFleetSnapshots(addresses);
    result["node-info"] = { hosts: addresses.map(address => ({ address,
      values: { state: "RUNNING_JOB", dl: null, ul: null, ping: null, networkUnavailableReason: null },
      fetchedAtMs: at, validUntilMs: at + 30_000, retained: false, error: null,
      apiCheck: { status: "online", checkedAtMs: at },
    })) };
    result.jobs = { hosts: addresses.map((address, index) => ({ address,
      job: { address: addresses[(index + 1) % addresses.length]!, node: address, state: "RUNNING",
        timeStart: at / 1000 - 120, timeEnd: 0, timeout: 600 }, checkedAtMs: at,
      validUntilMs: at + 180_000, failedAtMs: null, retained: false, pending: false, retryAtMs: null, error: null,
    })), nextRefreshAtMs: null };
    return result;
  };
  const store = createMemorySnapshotStore();
  await store.commit(fleet, snapshots(original), 0);
  const integration = { label: "Isolated hosting acceptance — synthetic readings", demonstration: true,
    source: createSnapshotSource(store, { now: () => now }), resolveAccess: async () => fleet };
  const server = await startFleetServer({ now: () => now, integration, port: 0, basePath: "/tools/fleet" });
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("Missing hosting test port");
  const origin = `http://127.0.0.1:${bound.port}`;
  const failures: string[] = [];
  const dataRequests: string[] = [];
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { failures.push("unexpected external request"); return route.abort(); }
    if (url.pathname.endsWith(".json")) dataRequests.push(url.pathname);
    return route.continue();
  });
  page.on("pageerror", error => failures.push(error.message));
  await page.clock.install({ time: now });
  try {
    await page.goto(`${origin}/tools/fleet/?scenario=mixed`);
    const api = page.locator(`[data-host="${addresses[0]}"] [data-col="api"]`);
    const duration = page.locator(`[data-host="${addresses[0]}"] [data-col="duration"]`);
    await expect(page.locator('#fleet-rows tr[data-source="supplied"]')).toHaveCount(8);
    await expect(page.locator("#hosting-lab-notice")).toBeVisible();
    await expect(page.locator("#hosting-lab-notice")).toContainText("synthetic readings");
    await expect(api).toHaveText("Online");
    await expect(api).toHaveAttribute("data-api-current", "false");
    await expect(api).toHaveAttribute("data-api-checked-at", String(original));
    await expect(duration).toHaveAttribute("data-duration-freshness", "retained");
    await expect(duration).toHaveAttribute("data-job-checked-at", String(original));
    await expect(duration).not.toContainText("Populating..");
    await expect(page.locator("#scenario")).toBeHidden();
    await page.goto("about:blank");
    // A platform data adapter commits independently of browser visibility.
    await store.commit(fleet, snapshots(now), 1);
    await page.goto(`${origin}/tools/fleet/`);
    await expect(api).toHaveAttribute("data-api-current", "true");
    await expect(api).toHaveAttribute("data-api-checked-at", String(now));
    await expect(duration).toHaveAttribute("data-duration-freshness", "current");
    await expect(duration).toHaveAttribute("data-job-checked-at", String(now));
    expect(dataRequests.every(path => path.startsWith("/tools/fleet/api/fleet/"))).toBe(true);
    expect(failures).toEqual([]);
  } finally {
    await page.close();
    await closeFleetServer(server, integration);
    await store.close();
  }
});
