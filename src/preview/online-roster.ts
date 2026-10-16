import type { OnlineHostsSnapshot } from "../contracts/online-hosts.ts";

/** Visible-page ownership for discovery; provider cache deadlines stay authoritative. */
export function createOnlineRosterController(options: {
  read: (signal: AbortSignal) => Promise<OnlineHostsSnapshot>;
  visible: () => boolean;
  now: () => number;
  apply: (snapshot: OnlineHostsSnapshot, changed: boolean) => void;
  failed: (message: string) => void;
  pending?: () => void;
}) {
  let active = false;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previous: OnlineHostsSnapshot | undefined;
  const clear = (): void => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };

  async function refresh(): Promise<void> {
    if (!active || !options.visible() || controller) return;
    clear();
    const owner = new AbortController();
    controller = owner;
    let nextRefreshAtMs: number | undefined;
    options.pending?.();
    try {
      const snapshot = await options.read(owner.signal);
      if (controller !== owner || owner.signal.aborted || !active || !options.visible()) return;
      nextRefreshAtMs = snapshot.online.nextRefreshAtMs;
      if (snapshot.error !== null) throw new Error(snapshot.error);
      const changed = previous?.online.revision !== snapshot.online.revision;
      if (!changed && previous && (previous.addresses.length !== snapshot.addresses.length ||
          previous.addresses.some((address, index) => address !== snapshot.addresses[index]))) {
        throw new Error("Online GPU host membership changed without a new revision.");
      }
      options.apply(snapshot, changed);
      previous = snapshot;
    } catch {
      if (controller !== owner || owner.signal.aborted || !active || !options.visible()) return;
      options.failed("Online GPU host discovery is unavailable. Retrying automatically.");
    } finally {
      if (controller === owner) {
        controller = undefined;
        if (active && options.visible()) {
          // Limit native timer range without shortening an upstream deadline.
          const due = nextRefreshAtMs ?? options.now() + 60_000;
          const schedule = (): void => {
            if (!active || !options.visible()) return;
            const remaining = due - options.now();
            timer = setTimeout(remaining > 2_147_483_647 ? schedule : () => { void refresh(); },
              Math.max(1_000, Math.min(remaining, 2_147_483_647)));
          };
          schedule();
        }
      }
    }
  }

  function pause(): void {
    active = false;
    clear();
    const old = controller;
    controller = undefined;
    old?.abort();
  }

  return {
    refresh,
    pause,
    resume(): Promise<void> {
      if (!options.visible()) { pause(); return Promise.resolve(); }
      if (active) return Promise.resolve();
      active = true;
      // Resume revalidates through the server's cache, including after OS sleep.
      return refresh();
    },
  };
}
