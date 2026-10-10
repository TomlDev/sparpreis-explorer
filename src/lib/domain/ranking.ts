import { RANKING } from "@/lib/config";
import type { SearchResult } from "./result";
import { effectiveMinTransfer } from "./ticketTransfers";

export type SortMode =
  | "proforma"
  | "cheapest"
  | "fastest"
  | "least-fv"
  | "fewest-transfers"
  | "tight-transfers"
  | "unreliable"
  | "cheap-flex";

export const SORT_LABELS: Record<SortMode, string> = {
  proforma: "✨ Pro-Forma",
  cheapest: "€ Günstigste",
  fastest: "⚡ Schnellste",
  "least-fv": "🚄 Wenigster ICE",
  "fewest-transfers": "🔁 Wenigste Umstiege",
  "tight-transfers": "⏱ Knappe Umstiege",
  unreliable: "🎲 Unzuverlässigste",
  "cheap-flex": "🎯 Günstig & oft Flex",
};

/**
 * Same price → the likelier the Zugbindung goes: fewer transfers that hold
 * ("Anschluss" low) first, then the higher Flex chance, then less Fernverkehr.
 */
export function samePriceOrder(a: SearchResult, b: SearchResult): number {
  return (
    (a.reliability?.okPct ?? 1) - (b.reliability?.okPct ?? 1) ||
    (b.reliability?.flexPct ?? 0) - (a.reliability?.flexPct ?? 0) ||
    a.metrics.fvMinutes - b.metrics.fvMinutes
  );
}

/** Prices compared in whole cents (no float noise between equal fares). */
export const cents = (p: number | null | undefined, fallback = 1e9) => (p == null ? fallback : Math.round(p * 100));

/** Highest chance of ≥ 20 min delay first (Zugbindung likely lifted);
 *  connections without punctuality data last. */
export function flexOrder(a: SearchResult, b: SearchResult): number {
  return (b.reliability?.flexPct ?? -1) - (a.reliability?.flexPct ?? -1);
}

/**
 * "Günstig & oft Flex": cheap connections with a high chance that the
 * Zugbindung gets lifted (≥ 20 min late). First come the connections for
 * which no other is both cheaper and more likely to be late (Pareto front of
 * price vs. flexPct), then the next such layer, and so on — each by price.
 * Without price or punctuality data: last.
 */
export function cheapFlexOrder(results: SearchResult[]): SearchResult[] {
  const rated = results.filter((r) => r.coverage.price != null && r.reliability);
  const rest = results.filter((r) => !rated.includes(r));
  let left = [...rated].sort((a, b) => a.coverage.price! - b.coverage.price! || b.reliability!.flexPct - a.reliability!.flexPct);
  const out: SearchResult[] = [];
  while (left.length) {
    const front: SearchResult[] = [];
    const next: SearchResult[] = [];
    let best = -1;
    for (const r of left) {
      if (r.reliability!.flexPct > best) {
        front.push(r);
        best = r.reliability!.flexPct;
      } else next.push(r);
    }
    out.push(...front);
    left = next;
  }
  return [...out, ...rest.sort(flexOrder)];
}

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
      return (a, b) => cents(a.coverage.price) - cents(b.coverage.price) || samePriceOrder(a, b);
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
        (effectiveMinTransfer(a) ?? 1e9) - (effectiveMinTransfer(b) ?? 1e9);
    case "unreliable":
      return (a, b) => flexOrder(a, b) || priceOr(a, 1e9) - priceOr(b, 1e9);
    case "cheap-flex":
      // Needs the whole set — callers use cheapFlexOrder(); this keeps a sane pairwise fallback.
      return (a, b) => priceOr(a, 1e9) - priceOr(b, 1e9) || flexOrder(a, b);
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

  if (mode === "cheap-flex") return cheapFlexOrder(results);
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
