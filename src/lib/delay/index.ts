import type { SearchResult } from "@/lib/domain/result";
import { computeReliability, type Reliability } from "./reliability";
import { activeMonths, delayCacheVersion, getWeights, hasDelayData, resolveEva, statRows } from "./store";

const memo = new Map<string, Reliability | null>();
let memoVersion = -1;

/** Attach punctuality estimates to results (memoized per connection + date;
 *  recomputed only when the data build or the weighting changes). */
export function annotateReliability(results: Iterable<SearchResult>, travelDate: string): void {
  let enabled = false;
  try {
    enabled = hasDelayData();
  } catch {
    enabled = false; // tables missing (not migrated yet) → feature off
  }
  if (!enabled) {
    for (const r of results) r.reliability = null;
    return;
  }
  const v = delayCacheVersion();
  if (v !== memoVersion) {
    memo.clear();
    memoVersion = v;
  }
  const ctx = { travelDate, months: activeMonths(), weights: getWeights() };
  const src = { resolveEva, rows: statRows };
  for (const r of results) {
    const uncovered = r.coverage.uncoveredLegs?.filter((i) => r.legs[i] && !r.legs[i].isWalking);
    const key = `${travelDate}|${r.fingerprint}|${uncovered?.join(",") ?? ""}`;
    if (!memo.has(key)) {
      let rel: Reliability | null = null;
      try {
        rel = computeReliability(r.legs, src, ctx, uncovered);
      } catch {
        rel = null;
      }
      if (memo.size > 5000) memo.clear();
      memo.set(key, rel);
    }
    r.reliability = memo.get(key) ?? null;
  }
}
