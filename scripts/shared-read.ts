/** A canceled viewer is not an upstream failure or a reason to back off. */
export function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

export interface SharedOperation<T> {
  readonly active: boolean;
  read(signal?: AbortSignal): Promise<T>;
}

// A 200-host consumer needs one physical listener, with no EventTarget warning.
const abortSubscriptions = new WeakMap<AbortSignal, { callbacks: Set<() => void>; dispatch: () => void }>();
function onAbort(signal: AbortSignal | undefined, callback: () => void): () => void {
  if (!signal) return () => {};
  let entry = abortSubscriptions.get(signal);
  if (!entry) {
    const callbacks = new Set<() => void>();
    const dispatch = (): void => {
      abortSubscriptions.delete(signal);
      for (const subscribed of [...callbacks]) subscribed();
      callbacks.clear();
    };
    entry = { callbacks, dispatch };
    abortSubscriptions.set(signal, entry);
    signal.addEventListener("abort", dispatch, { once: true });
  }
  entry.callbacks.add(callback);
  return () => {
    entry.callbacks.delete(callback);
    if (!entry.callbacks.size && abortSubscriptions.get(signal) === entry) {
      signal.removeEventListener("abort", entry.dispatch);
      abortSubscriptions.delete(signal);
    }
  };
}

/** Ref-count a read, detaching it before abort so an immediate rejoin can restart. */
export function createSharedOperation<T>(
  action: (signal: AbortSignal) => Promise<T>,
  onDispose: () => void = () => {},
): SharedOperation<T> {
  const controller = new AbortController();
  let active = true;
  let consumers = 0;
  const dispose = (): void => {
    if (!active) return;
    active = false;
    onDispose();
  };
  const task = Promise.resolve().then(() => {
    throwIfAborted(controller.signal);
    return action(controller.signal);
  }).then(value => {
    throwIfAborted(controller.signal);
    dispose();
    return value;
  }, error => { dispose(); throw error; });
  // A task can be canceled before its first consumer attaches.
  void task.catch(() => {});
  return {
    get active() { return active; },
    read(signal) {
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (!active && controller.signal.aborted) return Promise.reject(controller.signal.reason);
      consumers++;
      return new Promise<T>((resolve, reject) => {
        let released = false;
        let unsubscribe = (): void => {};
        const release = (): boolean => {
          if (released) return false;
          released = true;
          unsubscribe();
          consumers--;
          return true;
        };
        const abort = (): void => {
          if (!release()) return;
          if (consumers === 0 && active) {
            dispose();
            controller.abort();
          }
          reject(signal?.reason ?? new DOMException("The read was canceled.", "AbortError"));
        };
        unsubscribe = onAbort(signal, abort);
        task.then(value => { if (release()) resolve(value); }, error => { if (release()) reject(error); });
      });
    },
  };
}

export function createSharedRead<K, T>(): {
  (key: K, action: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>;
  isReading(key: K): boolean;
} {
  const pending = new Map<K, SharedOperation<T>>();
  const read = (key: K, action: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (signal?.aborted) return Promise.reject(signal.reason);
    let operation = pending.get(key);
    if (!operation) {
      const current = createSharedOperation(action, () => {
        if (pending.get(key) === current) pending.delete(key);
      });
      operation = current;
      pending.set(key, current);
    }
    return operation.read(signal);
  };
  read.isReading = (key: K): boolean => pending.has(key);
  return read;
}

/** Canceled queued reads never dispatch; active fetches receive the same signal. */
export function createRequestLimiter(maximum: number): <T>(action: () => Promise<T>, signal?: AbortSignal,
  priority?: () => readonly number[]) => Promise<T> {
  if (!Number.isInteger(maximum) || maximum < 1) throw new Error("Invalid request concurrency.");
  const queue: { start: () => void; cancel: () => void; priority: () => readonly number[] }[] = [];
  let active = 0;
  function dispatch(): void {
    // Reconsider all interested viewers when a slot opens. Sorting at enqueue
    // time lets routine work hide a newly joined host behind an entire roster.
    while (active < maximum && queue.length) {
      let selected = 0;
      let best = queue[0]!.priority();
      for (let index = 1; index < queue.length; index++) {
        const candidate = queue[index]!.priority();
        for (let part = 0; part < Math.max(best.length, candidate.length); part++) {
          const left = candidate[part] ?? 0;
          const right = best[part] ?? 0;
          if (left === right) continue;
          if (left < right) { selected = index; best = candidate; }
          break;
        }
      }
      queue.splice(selected, 1)[0]!.start();
    }
  }
  return <T>(action: () => Promise<T>, signal?: AbortSignal,
    priority: () => readonly number[] = () => []): Promise<T> => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const entry = {
      priority,
      start() {
        signal?.removeEventListener("abort", entry.cancel);
        active++;
        void Promise.resolve().then(() => {
          throwIfAborted(signal);
          return action();
        }).then(resolve, reject).finally(() => {
          active--;
          dispatch();
        });
      },
      cancel() {
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        signal?.removeEventListener("abort", entry.cancel);
        reject(signal?.reason ?? new DOMException("The read was canceled.", "AbortError"));
      },
    };
    queue.push(entry);
    signal?.addEventListener("abort", entry.cancel, { once: true });
    dispatch();
  });
}
