export type CountryDisplayMode = "compact" | "full";

export interface CountryDisplay {
  readonly text: string;
  /** English country name when recognized; otherwise the original reported text. */
  readonly fullName: string | null;
}

let countryNames: Intl.DisplayNames | undefined;
try {
  countryNames = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
} catch {
  // Keep reported text usable in browsers without region display names.
}

export function normalizeCountryMode(value: unknown): CountryDisplayMode {
  return value === "full" ? "full" : "compact";
}

/** Nosana allows free-form country text. Never infer codes from names or truncate it. */
export function formatCountry(value: string | null | undefined, mode: CountryDisplayMode): CountryDisplay {
  const reported = value?.trim() || null;
  if (reported === null) return { text: "—", fullName: null };
  const code = /^[a-z]{2}$/i.test(reported) ? reported.toUpperCase() : null;
  // ZZ is CLDR's unknown-region sentinel, not a recognized country.
  const name = code && code !== "ZZ" ? countryNames?.of(code) : undefined;
  const fullName = name || reported;
  return { text: mode === "compact" && name ? code! : fullName, fullName };
}
