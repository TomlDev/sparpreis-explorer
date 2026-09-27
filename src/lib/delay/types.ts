/** Shared punctuality-data types (safe to import on the client). */

export type DowGroup = "wk" | "fr" | "we";
export type StatLevel = "train" | "line_hour" | "line" | "station";

/** Build-time choice (which months get downloaded). */
export interface DelayBuildParams {
  /** Most recent N months (1–12). */
  recentMonths: number;
  /** Also the same season 1–2 years back (0 = off). */
  seasonYears: number;
  /** Season = the current calendar month ± this many months (0–2). */
  seasonSpan: number;
}

/** Query-time weighting — changeable without rebuilding. */
export interface DelayWeights {
  /** A month's weight halves every N months of age (older data counts less). */
  halfLifeMonths: number;
  /** Extra weight for months in the travel date's season (same calendar month ×boost, ±1 month half of it). */
  seasonBoost: number;
  /** Prefer the travel day's weekday group (Mo–Do / Fr / Sa–So). */
  matchWeekday: boolean;
  /** Below this many observations a train's own history is topped up with its line / station. */
  minSamples: number;
}

export const DEFAULT_BUILD_PARAMS: DelayBuildParams = { recentMonths: 3, seasonYears: 1, seasonSpan: 1 };
export const DEFAULT_WEIGHTS: DelayWeights = {
  halfLifeMonths: 3,
  seasonBoost: 2,
  matchWeekday: true,
  minSamples: 20,
};

export interface StatRow {
  month: string;
  dow: string;
  n: number;
  cancelled: number;
  arr: [number, number][];
  dep: [number, number][];
}
