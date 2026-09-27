import type { DelayBuildParams } from "./types";

/** Pure month planning for the punctuality import (shared with the settings UI). */

export interface AvailableMonth {
  month: string;
  bytes: number;
}

/** Before this month the data set only covers ~130 large stations. */
export const FULL_COVERAGE_FROM = "2025-11";

export function addMonths(m: string, delta: number): string {
  const [y, mo] = m.split("-").map(Number);
  const i = y * 12 + (mo - 1) + delta;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
}

/** Newest N months + (optionally) the current season 1–2 years back. */
export function planMonths(params: DelayBuildParams, available: AvailableMonth[], today: string): string[] {
  const have = new Set(available.map((a) => a.month));
  const out = new Set(available.slice(0, params.recentMonths).map((a) => a.month));
  const cur = today.slice(0, 7);
  for (let y = 1; y <= params.seasonYears; y++)
    for (let d = -params.seasonSpan; d <= params.seasonSpan; d++) {
      const m = addMonths(cur, -12 * y + d);
      if (have.has(m)) out.add(m);
    }
  return [...out].sort().reverse();
}

export function normalizeParams(p: Partial<DelayBuildParams>): DelayBuildParams {
  const int = (v: unknown, lo: number, hi: number, d: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d;
  return {
    recentMonths: int(p.recentMonths, 1, 12, 3),
    seasonYears: int(p.seasonYears, 0, 2, 1),
    seasonSpan: int(p.seasonSpan, 0, 2, 1),
  };
}
