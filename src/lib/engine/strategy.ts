import { PRICE_STRATEGY } from "@/lib/config";
import type { SearchResult } from "@/lib/domain/result";

/**
 * Explore/exploit strategy for choosing which FV candidates get a scarce DB
 * price check. epsilon-greedy: with probability epsilon we explore an
 * under-observed segment, otherwise we exploit the best-ranked one (shortest
 * ICE slice first). epsilon starts high (discover cheap short segments) and
 * decays as observations accumulate (calibration over days -> exploitation).
 */

export function explorationEpsilon(totalObservations: number): number {
  const { exploreBase, exploreFloor, calibrationObservations } = PRICE_STRATEGY;
  const decayed = exploreBase * (1 - Math.min(1, totalObservations / calibrationObservations));
  return Math.max(exploreFloor, Math.round(decayed * 1000) / 1000);
}

/** Exploit order: fewest FV stops, then fewest FV minutes, then fewest
 *  transfers, then shortest total duration. (Small ICE slice first.) */
export function exploitOrder(candidates: SearchResult[]): SearchResult[] {
  return [...candidates].sort(
    (a, b) =>
      a.metrics.fvStops - b.metrics.fvStops ||
      a.metrics.fvMinutes - b.metrics.fvMinutes ||
      a.metrics.transfers - b.metrics.transfers ||
      a.metrics.durationMin - b.metrics.durationMin,
  );
}

export interface Selected {
  result: SearchResult;
  reason: "exploit" | "explore";
  exploitRank: number;
  epsilon: number;
}

export interface SelectOpts {
  budget: number;
  totalObservations: number;
  /** how many times we have already priced the given candidate's segment */
  observationsOf: (r: SearchResult) => number;
  rng?: () => number;
}

export function selectForPricing(candidates: SearchResult[], opts: SelectOpts): Selected[] {
  const rng = opts.rng ?? Math.random;
  const eps = explorationEpsilon(opts.totalObservations);
  const ordered = exploitOrder(candidates);
  const rankOf = new Map<SearchResult, number>();
  ordered.forEach((r, i) => rankOf.set(r, i));

  const pool = new Set(ordered);
  const out: Selected[] = [];
  while (out.length < opts.budget && pool.size > 0) {
    let pick: SearchResult;
    let reason: "exploit" | "explore";
    if (rng() < eps && pool.size > 1) {
      // explore: bias toward the least-observed third of the remaining pool
      const arr = [...pool].sort((a, b) => opts.observationsOf(a) - opts.observationsOf(b));
      const k = Math.max(1, Math.floor(arr.length / 3));
      pick = arr[Math.floor(rng() * k)];
      reason = "explore";
    } else {
      pick = ordered.find((r) => pool.has(r))!;
      reason = "exploit";
    }
    pool.delete(pick);
    out.push({ result: pick, reason, exploitRank: rankOf.get(pick) ?? -1, epsilon: eps });
  }
  return out;
}
