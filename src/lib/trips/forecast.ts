import type { DbTripStatus, RerouteCheck, TripLeg } from "@/db/schema";
import { dbLifted, dbStatusText } from "./dbStatusText";
import { delayMin, missedConnections, normalizeLeg } from "./realtime";
import { isRailLeg } from "./rules";

/**
 * What DB's live data says about a trip *before / while* travelling: will it
 * reach the ticket's destination as booked, and how late? ≥ 20 min late at the
 * destination lifts the Zugbindung — the moment to pick another train (Flex).
 * So does a connection that can't be made or a cancelled train: DB itself then
 * shows "Zugbindung aufgehoben" (DB Navigator, Oct 2026). The fastest way on
 * from there (`reroute`, checked live) tells how late you'd arrive with it.
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
  /** The level comes from DB's own Reisebegleitung (not the app's estimate). */
  source?: "db";
  /** DB's verdict in words ("Zugbindung aufgehoben · fahrbar · Alternative möglich"). */
  dbText?: string;
}

/** DB's state counts while it is fresh. */
const DB_FRESH_MS = 30 * 60_000;

export const LIFT_MIN = 20;

const label = (l: TripLeg) => l.lineName ?? "Zug";

const levelOf = (d: number): Forecast["level"] => (d >= LIFT_MIN ? "lifted" : d >= 5 ? "late" : "ok");

/** The break decided by the fastest alternative from there (when checked for this very break). */
function decide(f: Forecast, reroute: RerouteCheck | null | undefined): Forecast {
  if (!f.breakAt) return f;
  const lifted = { ...f, level: "lifted" as const };
  if (!reroute || reroute.breakLeg !== f.breakAt.legIndex) return { ...lifted, reason: `${f.reason} · schnellster Ersatz wird gesucht` };
  if (reroute.arrival == null) return { ...lifted, reason: `${f.reason} · keine Ersatzverbindung mehr gefunden` };
  const d = reroute.delayMin ?? 0;
  return {
    ...lifted,
    delayMin: d,
    reason: `${f.reason} · Ersatz ab ${reroute.from}${reroute.via ? ` (${reroute.via})` : ""}: ${d > 0 ? `+${d} min` : "pünktlich"} am Ziel`,
  };
}

export function tripForecast(legs: TripLeg[], reroute?: RerouteCheck | null, dbs?: DbTripStatus | null, now = Date.now()): Forecast {
  const own = decide(bookedForecast(legs), reroute);
  if (!dbs || now - dbs.checkedAt > DB_FRESH_MS) return own;
  // DB's word wins: lifted when it says so — and only then
  if (dbLifted(dbs)) return { ...own, level: "lifted", source: "db", dbText: dbStatusText(dbs) };
  const kept: Forecast["level"] = own.level === "lifted" ? (own.delayMin != null && own.delayMin >= 5 ? "late" : "ok") : own.level;
  return { ...own, level: own.level === "none" ? "none" : kept, source: "db", dbText: dbStatusText(dbs) };
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
  if (f.source === "db") {
    if (f.level === "lifted") return `Laut DB: ${f.dbText}`;
    const what = f.breakAt
      ? `Anschluss in ${f.breakAt.station} knapp`
      : f.level === "late"
        ? `Voraussichtlich +${f.delayMin} min in ${dest}`
        : `Pünktlich in ${dest}`;
    return `${what} – laut DB besteht die Zugbindung`;
  }
  if (f.breakAt) {
    const what = f.reason?.startsWith("Anschluss") ? `Anschluss in ${f.reason.split(" platzt")[0].replace("Anschluss in ", "")} nicht erreichbar` : (f.reason?.split(" · ")[0] ?? "Verbindung unterbrochen");
    return `${what} – Zugbindung aufgehoben`;
  }
  if (f.level === "lifted") return `Voraussichtlich +${f.delayMin} min in ${dest} – Zugbindung aufgehoben`;
  if (f.level === "late") return `Voraussichtlich +${f.delayMin} min in ${dest}`;
  if (f.level === "ok") return `Laut Prognose pünktlich in ${dest}`;
  return "Noch keine Prognose";
}
