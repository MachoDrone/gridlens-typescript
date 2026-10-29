/** Optional owner-only persistence. The developer preview never supplies it. */
export interface ProviderCheckpoint {
  read<T>(): T | undefined;
  write(value: unknown): void;
}

// A narrow tagged JSON codec preserves Maps/Sets and the scheduling -Infinity
// sentinel. No object prototypes, functions, credentials or raw responses are
// serialized. Invalid or future formats fail closed rather than resetting quotas.
type Encoded = null | boolean | number | string | Encoded[];
export function encodeProviderState(value: unknown): Encoded {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (Number.isNaN(value)) throw new Error("Invalid provider number.");
    return Number.isFinite(value) ? value : ["number", value > 0 ? "+inf" : "-inf"];
  }
  if (value instanceof Map) return ["map", [...value].map(([key, entry]) => [encodeProviderState(key), encodeProviderState(entry)])];
  if (value instanceof Set) return ["set", [...value].map(encodeProviderState)];
  if (Array.isArray(value)) return ["array", value.map(encodeProviderState)];
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return ["object", Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, encodeProviderState(entry)])];
  }
  throw new Error("Provider state contains an unsupported value.");
}
export function decodeProviderState(value: unknown, depth = 0): unknown {
  if (depth > 64) throw new Error("Provider state is too deeply nested.");
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number" && Number.isFinite(value)) return value;
  if (!Array.isArray(value) || value.length !== 2) throw new Error("Invalid provider checkpoint.");
  if (value[0] === "number" && ["+inf", "-inf"].includes(value[1])) return value[1] === "+inf" ? Infinity : -Infinity;
  const entries: unknown = value[1];
  if (!Array.isArray(entries)) throw new Error("Invalid provider checkpoint entries.");
  const decode = (entry: unknown) => decodeProviderState(entry, depth + 1);
  if (value[0] === "array") return entries.map(decode);
  if (value[0] === "set") return new Set(entries.map(decode));
  if (!["map", "object"].includes(value[0])) throw new Error("Unknown provider checkpoint type.");
  const pairs = entries.map(entry => {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error("Invalid provider checkpoint pair.");
    return [value[0] === "object" ? entry[0] : decode(entry[0]), decode(entry[1])] as const;
  });
  if (value[0] === "map") return new Map(pairs);
  if (pairs.some(([key]) => typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key))) throw new Error("Invalid provider checkpoint key.");
  return Object.fromEntries(pairs);
}

export function createProviderCheckpoint(state: { get<T>(key: string): T | undefined; set(key: string, value: unknown): void }, name: string): ProviderCheckpoint {
  const key = `provider/${name}`;
  let failed = false;
  return {
    read<T>(): T | undefined {
      if (failed) throw new Error("Provider checkpoint requires reopening.");
      const stored = state.get<{ version: number; value: unknown }>(key);
      if (!stored) return undefined;
      if (stored.version !== 1) throw new Error("Unsupported provider checkpoint version.");
      return decodeProviderState(stored.value) as T;
    },
    write(value) {
      if (failed) throw new Error("Provider checkpoint requires reopening.");
      try { state.set(key, { version: 1, value: encodeProviderState(value) }); }
      catch (error) { failed = true; throw error; }
    },
  };
}
