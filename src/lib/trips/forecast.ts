import type { RerouteCheck, TripLeg } from "@/db/schema";
import { delayMin, missedConnections, normalizeLeg } from "./realtime";
import { isRailLeg } from "./rules";

/**
 * What DB's live data says about a trip *before / while* travelling: will it
 * reach the ticket's destination as booked, and how late? What counts is the
 * delay at the destination: ≥ 20 min lifts the Zugbindung — the moment to pick
 * another train (Flex). A connection that breaks or a cancelled train only does
 * when the fastest way on from there (`reroute`, checked live) is ≥ 20 min late.
 */
export interface Forecast {
  /** lifted: Zugbindung lifted · check: a connection breaks, the way on is being checked · late: 5–19 min · ok · none: no live data yet */
  level: "lifted" | "check" | "late" | "ok" | "none";
  /** Expected delay at the ticket's destination (only when the trip still works as booked). */
  delayMin: number | null;
  /** One line why, e.g. "ICE 612 +25 min", "Anschluss in Mannheim Hbf platzt", "RE 7 fällt aus". */
  reason: string | null;
  /** Where the booked itinerary breaks (alternatives start there when already under way). */
  breakAt: { legIndex: number; station: string; stationId: string | null } | null;
  /** Newest live observation behind this forecast. */
  at: number | null;
  /** Every rail leg has live data. */
  complete: boolean;
}

export const LIFT_MIN = 20;

const label = (l: TripLeg) => l.lineName ?? "Zug";

const levelOf = (d: number): Forecast["level"] => (d >= LIFT_MIN ? "lifted" : d >= 5 ? "late" : "ok");

/** The break decided by the fastest alternative from there (when checked for this very break). */
function decide(f: Forecast, reroute: RerouteCheck | null | undefined): Forecast {
  if (!f.breakAt) return f;
  if (!reroute || reroute.breakLeg !== f.breakAt.legIndex) return { ...f, level: "check", reason: `${f.reason} – Ersatzverbindung wird geprüft` };
  if (reroute.arrival == null) return { ...f, level: "lifted", reason: `${f.reason} – keine Ersatzverbindung mehr gefunden` };
  const d = reroute.delayMin ?? 0;
  return {
    ...f,
    level: levelOf(d),
    delayMin: d,
    reason: `${f.reason} – schnellster Ersatz ab ${reroute.from}${reroute.via ? ` (${reroute.via})` : ""}: ${d > 0 ? `+${d}` : "pünktlich"} min am Ziel`,
  };
}

export function tripForecast(legs: TripLeg[], reroute?: RerouteCheck | null): Forecast {
  return decide(bookedForecast(legs), reroute);
}

/** The trip as booked, from the live data of its trains (a break is reported, not judged). */
export function bookedForecast(legs: TripLeg[]): Forecast {
  const rail = legs.map((l, i) => ({ l: normalizeLeg(l), i })).filter(({ l }) => isRailLeg(l));
  const seen = rail.filter(({ l }) => l.rtLive && !l.rtLive.missing);
  const at = seen.length ? Math.max(...seen.map(({ l }) => l.rtLive!.checkedAt)) : null;
  const base = { at, complete: rail.length > 0 && seen.length === rail.length };
  if (!seen.length) return { level: "none", delayMin: null, reason: null, breakAt: null, ...base };

  const cancelled = rail.find(({ l }) => l.rt?.depCancelled || l.rt?.arrCancelled);
  if (cancelled)
    return {
      level: "lifted",
      delayMin: null,
      reason: `${label(cancelled.l)} fällt aus${cancelled.l.rt?.depCancelled ? "" : " (Teilausfall)"}`,
      breakAt: { legIndex: cancelled.i, station: cancelled.l.fromName, stationId: cancelled.l.fromId ?? null },
      ...base,
    };

  const missed = missedConnections(legs)[0];
  if (missed) {
    const next = legs[missed.nextLeg];
    const late = delayMin(legs[missed.afterLeg].plannedArrival, missed.arrived);
    return {
      level: "lifted",
      delayMin: null,
      reason: `Anschluss in ${missed.station} platzt (${label(legs[missed.afterLeg])}${late && late > 0 ? ` +${late} min` : ""}, ${label(next)} fährt vorher)`,
      breakAt: { legIndex: missed.nextLeg, station: next.fromName, stationId: next.fromId ?? null },
      ...base,
    };
  }

  const last = rail[rail.length - 1].l;
  const d = delayMin(last.plannedArrival, last.rt?.arr);
  if (d == null) {
    // the last train has no data yet — the worst delay seen so far is a lower bound only
    return { level: "none", delayMin: null, reason: null, breakAt: null, ...base };
  }
  // which train brings the delay (the biggest arrival delay along the way)
  const worst = rail
    .map(({ l }) => ({ l, d: delayMin(l.plannedArrival, l.rt?.arr) ?? 0 }))
    .sort((a, b) => b.d - a.d)[0];
  return {
    level: levelOf(d),
    delayMin: d,
    reason: d >= 5 && worst.d > 0 ? `${label(worst.l)} +${worst.d} min` : null,
    breakAt: null,
    ...base,
  };
}

/** One line for banners / notifications. */
export function forecastText(f: Forecast, dest: string): string {
  if (f.level === "lifted")
    return f.delayMin != null ? `Voraussichtlich +${f.delayMin} min in ${dest} – Zugbindung aufgehoben` : `${f.reason} – Zugbindung aufgehoben`;
  if (f.level === "check") return f.reason ?? "Anschluss platzt – Ersatzverbindung wird geprüft";
  if (f.breakAt) return `${f.reason?.split(" – ")[0]} – Ersatz kommt ${f.delayMin && f.delayMin > 0 ? `+${f.delayMin} min` : "pünktlich"} in ${dest} an, Zugbindung bleibt`;
  if (f.level === "late") return `Voraussichtlich +${f.delayMin} min in ${dest}`;
  if (f.level === "ok") return `Laut Prognose pünktlich in ${dest}`;
  return "Noch keine Prognose";
}
