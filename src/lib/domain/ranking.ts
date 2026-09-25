import { RANKING } from "@/lib/config";
import type { SearchResult } from "./result";

export type SortMode =
  | "proforma"
  | "cheapest"
  | "fastest"
  | "least-fv"
  | "fewest-transfers"
  | "tight-transfers";

export const SORT_LABELS: Record<SortMode, string> = {
  proforma: "✨ Pro-Forma",
  cheapest: "€ Günstigste",
  fastest: "⚡ Schnellste",
  "least-fv": "🚄 Wenigster ICE",
  "fewest-transfers": "🔁 Wenigste Umstiege",
  "tight-transfers": "⏱ Knappe Umstiege",
};

/**
 * Default "Pro-Forma" score (lower = better): a valid through-ticket dominates,
 * then a low price, then a very small Fernverkehr slice, then few FV stops.
 * Not "more transfers = good" — transfers are a mild cost, never a reward.
 */
export function proformaScore(r: SearchResult): number {
  let score = 0;
  const c = r.coverage.coverage;
  if (c === "red" || c === "none") score += RANKING.noFullTicketPenalty;
  else if (c === "unpriced") score += RANKING.unpricedPenalty;
  else if (c === "yellow") score += RANKING.uncertainTicketPenalty;

  // Unpriced results have no price term (constant), so FV metrics decide their
  // relative order; priced results compete on real price.
  const price = r.coverage.price ?? 0;
  score += price * RANKING.pricePerEuro;
  score += r.metrics.fvMinutes * RANKING.perFvMinute;
  score += r.metrics.fvStops * RANKING.perFvStop;
  score += r.metrics.fvLegs * RANKING.perFvLeg;
  score += r.metrics.transfers * RANKING.perTransfer;
  score += r.metrics.durationMin * RANKING.perDurationMinute;
  return Math.round(score);
}

function priceOr(r: SearchResult, fallback: number): number {
  return r.coverage.price ?? fallback;
}

export function compareBy(mode: SortMode): (a: SearchResult, b: SearchResult) => number {
  switch (mode) {
    case "cheapest":
      return (a, b) => priceOr(a, 1e9) - priceOr(b, 1e9);
    case "fastest":
      return (a, b) => a.metrics.durationMin - b.metrics.durationMin;
    case "least-fv":
      return (a, b) =>
        a.metrics.fvMinutes - b.metrics.fvMinutes ||
        a.metrics.fvStops - b.metrics.fvStops ||
        priceOr(a, 1e9) - priceOr(b, 1e9);
    case "fewest-transfers":
      return (a, b) =>
        a.metrics.transfers - b.metrics.transfers ||
        priceOr(a, 1e9) - priceOr(b, 1e9);
    case "tight-transfers":
      // Shortest "shortest transfer" first (purely informational sort).
      return (a, b) =>
        (a.metrics.minTransferMin ?? 1e9) - (b.metrics.minTransferMin ?? 1e9);
    case "proforma":
    default:
      return (a, b) => a.score - b.score;
  }
}

/** Assign proforma scores and comparative "why interesting" reasons, then sort. */
export function rankResults(
  results: SearchResult[],
  mode: SortMode = "proforma",
): SearchResult[] {
  for (const r of results) r.score = proformaScore(r);

  // Comparative reasons need the whole set (e.g. "X € cheaper than fastest").
  const priced = results.filter((r) => r.coverage.price != null);
  if (priced.length > 0) {
    const fastest = [...results].sort(
      (a, b) => a.metrics.durationMin - b.metrics.durationMin,
    )[0];
    const cheapest = [...priced].sort(
      (a, b) => (a.coverage.price ?? 0) - (b.coverage.price ?? 0),
    )[0];
    for (const r of results) {
      if (
        fastest &&
        r !== fastest &&
        fastest.coverage.price != null &&
        r.coverage.price != null
      ) {
        const diff = Math.round(fastest.coverage.price - r.coverage.price);
        if (diff >= 5) {
          r.reasons.push(
            `${diff.toLocaleString("de-DE")} € günstiger als die schnellste Verbindung`,
          );
        }
      }
      if (r === cheapest && results.length > 1) {
        r.reasons.push("günstigste gefundene Verbindung");
      }
      // Deduplicate reasons.
      r.reasons = [...new Set(r.reasons)];
    }
  }

  const cmp = compareBy(mode);
  return [...results].sort(cmp);
}

/** Interest stars for the card badge (0–3). */
export function interestStars(r: SearchResult): number {
  let s = 0;
  if (r.coverage.coverage === "green") s++;
  if (r.metrics.fvStops > 0 && r.metrics.fvStops <= 1) s++;
  if (r.metrics.fvPercent > 0 && r.metrics.fvPercent < 8) s++;
  return s;
}
