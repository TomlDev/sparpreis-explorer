import { cheapFlexOrder, flexOrder, type SortMode } from "@/lib/domain/ranking";
import { effectiveMinTransfer } from "@/lib/domain/ticketTransfers";
import type { SearchResult } from "@/lib/domain/result";
import type { SearchFilters } from "@/lib/engine/types";
import { formatTime, toMin } from "@/lib/time";

/**
 * The search page's client-side filtering + sorting, shared with the
 * `npm run view` reproduction script so both compute the exact same visible
 * list. `filterReason` returns WHY a result is hidden (first failing rule),
 * `clientFilter` keeps the ones without a reason.
 */

/** Order-independent station token key, so the SAME station matches across
 *  data sources that spell it differently ("Langendreer, Bochum" vs
 *  "Bochum Langendreer"). */
export function normStation(name: string): string {
  return (name || "")
    .toLowerCase()
    .split(/[^a-zà-ÿ0-9]+/i)
    .filter(Boolean)
    .sort()
    .join(" ");
}

/** Identity of a train leg for prefix matching: departure time + boarding
 *  station. Robust to line-label vs train-number differences ("RB32" vs
 *  "31242") AND to station-name spelling differences across sources. */
export function legStopKey(l: { plannedDeparture: string | null; fromName: string }): string {
  return `${formatTime(l.plannedDeparture)}|${normStation(l.fromName)}`;
}

/** A real alternative must board the SAME leading trains as the reference —
 *  same first train at the same time, and the same following regional legs up
 *  to the first Fernverkehr (it may only diverge at/after the FV part). */
export function refLeadKeysFor(reference: SearchResult | null): string[] | null {
  if (!reference) return null;
  const keys: string[] = [];
  for (const l of reference.legs) {
    if (l.isWalking) continue;
    if (l.isLongDistance) break; // stop before the first ICE/IC
    keys.push(legStopKey(l));
  }
  if (keys.length === 0) {
    const first = reference.legs.find((l) => !l.isWalking);
    if (first) keys.push(legStopKey(first)); // at least the first train
  }
  return keys;
}

export interface TimeFilterWindow {
  from: number; // minutes since midnight
  to: number;
  field: "departure" | "arrival";
}

export function timeFilterWindow(from: string, to: string, field: "departure" | "arrival"): TimeFilterWindow {
  return { from: toMin(from), to: toMin(to), field };
}

export interface FilterContext {
  filters: SearchFilters;
  /** Price of the reference the USER picked (the auto-anchor never filters). */
  reference: number | null;
  refLeadKeys: string[] | null;
  window: TimeFilterWindow | null;
  /** Whether any result in the set is priced ("only priced" needs this). */
  anyPriced: boolean;
}

const eur = (n: number) => `${n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** Why a result is hidden (first failing rule), or null when it is shown. */
export function filterReason(r: SearchResult, ctx: FilterContext): string | null {
  const f = ctx.filters;
  const m = r.metrics;
  // Real alternative: must board the SAME leading trains as the reference
  // (same time + station), diverging only at/after the Fernverkehr.
  if (ctx.refLeadKeys && ctx.refLeadKeys.length) {
    const legs = r.legs.filter((l) => !l.isWalking);
    for (let i = 0; i < ctx.refLeadKeys.length; i++) {
      if (!legs[i] || legStopKey(legs[i]) !== ctx.refLeadKeys[i])
        return `andere ersten Züge als die Referenz (Zug ${i + 1})`;
    }
  } else if (ctx.window) {
    // Departure- or arrival-time window (only when browsing — a chosen
    // reference governs the time via the leading-train match). Supports
    // overnight wrap.
    const w = ctx.window;
    const iso = w.field === "arrival" ? m.plannedArrival : m.plannedDeparture;
    if (iso) {
      const t = toMin(formatTime(iso));
      const inWindow = w.from <= w.to ? t >= w.from && t <= w.to : t >= w.from || t <= w.to;
      if (!inWindow)
        return `${w.field === "arrival" ? "Ankunft" : "Abfahrt"} ${formatTime(iso)} außerhalb ${hhmm(w.from)}–${hhmm(w.to)}`;
    }
  }
  // Original = what DB proposes for a plain search (normal/anchor) — excludes
  // pro-forma AND constructed alternatives (low-FV, via-forced, MOTIS routes).
  if (f.onlyOriginal && r.resultKind !== "normal" && r.resultKind !== "anchor")
    return `nur Original (DB) – Art: ${r.resultKind}`;
  if (f.onlyPriced && ctx.anyPriced && r.coverage.price == null) return "ohne Preis (nur bepreiste)";
  if (f.requireFv && m.fvLegs < 1) return "kein Fernverkehr";
  if (f.maxFvLegs != null && f.maxFvLegs > 0 && m.fvLegs > f.maxFvLegs) // 0 = unbegrenzt
    return `zu viele FV-Abschnitte (${m.fvLegs} > ${f.maxFvLegs})`;
  if (f.belowReference && ctx.reference != null && r.coverage.price != null && r.coverage.price >= ctx.reference)
    return `nicht günstiger als Referenz (${eur(r.coverage.price)} ≥ ${eur(ctx.reference)})`;
  if ((f.allowICE || f.allowIC) && m.fvLegs < 1) return "kein Fernverkehr";
  if (!f.allowICE && r.legs.some((l) => l.product === "nationalExpress")) return "enthält ICE (ausgeschlossen)";
  if (!f.allowIC && r.legs.some((l) => l.product === "national")) return "enthält IC (ausgeschlossen)";
  if (f.onlyFullTicket && (r.coverage.coverage === "red" || r.coverage.coverage === "none"))
    return `kein durchgehendes Ticket (${r.coverage.coverage})`;
  if (f.maxPrice != null && r.coverage.price != null && r.coverage.price > f.maxPrice)
    return `Preis über Max. (${eur(r.coverage.price)} > ${eur(f.maxPrice)})`;
  if (f.maxDurationMin != null && m.durationMin > f.maxDurationMin)
    return `Dauer über Max. (${m.durationMin} > ${f.maxDurationMin} min)`;
  if (f.maxTransfers != null && m.transfers > f.maxTransfers)
    return `zu viele Umstiege (${m.transfers} > ${f.maxTransfers})`;
  if (f.maxFvMinutes != null && m.fvMinutes > f.maxFvMinutes)
    return `zu viele ICE-Minuten (${m.fvMinutes} > ${f.maxFvMinutes})`;
  if (f.maxFvStops != null && m.fvStops > f.maxFvStops)
    return `zu viele ICE-Halte (${m.fvStops} > ${f.maxFvStops})`;
  const tight = effectiveMinTransfer(r);
  if (f.minTransferMin != null && tight != null && tight < f.minTransferMin)
    return `Umstieg zu knapp (${tight} < ${f.minTransferMin} min)`;
  if (f.minFlexPct != null && f.minFlexPct > 0) {
    const flex = r.reliability?.flexPct;
    if (flex == null) return "keine Pünktlichkeitsdaten (Flex-Filter)";
    if (flex * 100 < f.minFlexPct)
      return `Flex-Chance zu niedrig (${Math.round(flex * 100)} % < ${f.minFlexPct} %)`;
  }
  return null;
}

/** Client-side filter mirroring (and extending) the server's applyFilters, so
 *  filter changes apply instantly to the already-fetched results. */
export function clientFilter(
  results: SearchResult[],
  filters: SearchFilters,
  reference: number | null,
  refLeadKeys: string[] | null,
  window: TimeFilterWindow | null,
): SearchResult[] {
  const ctx: FilterContext = {
    filters,
    reference,
    refLeadKeys,
    window,
    anyPriced: results.some((r) => r.coverage.price != null),
  };
  return results.filter((r) => filterReason(r, ctx) === null);
}

/** Lightweight client-side re-sort (mirrors server ranking's comparators). */
export function clientSort(results: SearchResult[], mode: SortMode): SearchResult[] {
  if (mode === "cheap-flex") return cheapFlexOrder(results);
  const price = (r: SearchResult, f: number) => r.coverage.price ?? f;
  const cmp: Record<SortMode, (a: SearchResult, b: SearchResult) => number> = {
    proforma: (a, b) => a.score - b.score,
    cheapest: (a, b) => price(a, 1e9) - price(b, 1e9),
    fastest: (a, b) => a.metrics.durationMin - b.metrics.durationMin,
    "least-fv": (a, b) => a.metrics.fvMinutes - b.metrics.fvMinutes || price(a, 1e9) - price(b, 1e9),
    "fewest-transfers": (a, b) => a.metrics.transfers - b.metrics.transfers || price(a, 1e9) - price(b, 1e9),
    "tight-transfers": (a, b) => (effectiveMinTransfer(a) ?? 1e9) - (effectiveMinTransfer(b) ?? 1e9),
    unreliable: (a, b) => flexOrder(a, b) || price(a, 1e9) - price(b, 1e9),
    "cheap-flex": (a, b) => price(a, 1e9) - price(b, 1e9) || flexOrder(a, b),
  };
  return [...results].sort(cmp[mode]);
}
