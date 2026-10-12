// Synthetic, memory-only fixtures. No real PC addresses, identities or services.
import type {
  ObservedHost,
  PCInventory,
  RuntimeInventory,
  SuccessfulInventory,
} from "../../src/fleet/freshness.ts";

export const NOW = Date.UTC(2026, 0, 1, 12);
export const RUNNING: ObservedHost = { id: "fixture-host", name: "Example host", state: "running" };
export const STOPPED: ObservedHost = { id: "fixture-stopped", name: "Stopped example", state: "stopped" };

export function success(
  observedAtMs = NOW,
  hosts: readonly ObservedHost[] = [RUNNING],
): SuccessfulInventory {
  return { outcome: "success", observedAtMs, hosts };
}

export function runtime(
  latest: RuntimeInventory["latest"] = success(),
  lastSuccess: SuccessfulInventory | null = null,
  runtimeId = "docker",
): RuntimeInventory {
  return { runtimeId, latest, lastSuccess };
}

export function pc(
  runtimes: readonly RuntimeInventory[] = [runtime()],
  observedAtMs: number | null = NOW,
  pcId = "fixture-pc",
): PCInventory {
  return { pcId, observedAtMs, runtimes };
}
