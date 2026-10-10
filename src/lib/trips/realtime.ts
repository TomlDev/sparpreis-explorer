import type { LegRealtime, RtObservation, TripLeg } from "@/db/schema";
import { isRailLeg } from "./rules";

/** Minutes actual − planned (null when either is unknown). */
export function delayMin(planned: string | null | undefined, actual: string | null | undefined): number | null {
  if (!planned || !actual) return null;
  return Math.round((new Date(actual).getTime() - new Date(planned).getTime()) / 60_000);
}

export interface MissedConnection {
  /** Index of the arriving rail leg. */
  afterLeg: number;
  /** Index of the connecting rail leg that left before. */
  nextLeg: number;
  station: string;
  arrived: string;
  departed: string;
}

/** Connections that broke: the next train left before the previous one arrived. */
export function missedConnections(legs: TripLeg[]): MissedConnection[] {
  const rail = legs.map((l, i) => ({ l, i })).filter(({ l }) => isRailLeg(l));
  const out: MissedConnection[] = [];
  for (let k = 0; k + 1 < rail.length; k++) {
    const a = rail[k];
    const b = rail[k + 1];
    const arrived = a.l.rt?.arr;
    const departed = b.l.rt?.dep;
    if (!arrived || !departed || b.l.rt?.depCancelled) continue;
    if (new Date(arrived).getTime() > new Date(departed).getTime())
      out.push({ afterLeg: a.i, nextLeg: b.i, station: a.l.toName, arrived, departed });
  }
  return out;
}

export interface RealtimeSummary {
  /** Every rail leg has (final) data. */
  complete: boolean;
  final: boolean;
  /** Actual arrival of the last rail leg — only when the trip ran as booked. */
  arrival: string | null;
  arrivalDelay: number | null;
  missed: MissedConnection[];
  /** Rail legs with a cancelled departure or arrival. */
  cancelled: number[];
}

export function realtimeSummary(legs: TripLeg[]): RealtimeSummary | null {
  const rail = legs.filter(isRailLeg);
  const withRt = rail.filter((l) => l.rt && !l.rt.missing);
  if (!withRt.length) return null;
  const missed = missedConnections(legs);
  const cancelled = legs.flatMap((l, i) => (isRailLeg(l) && (l.rt?.depCancelled || l.rt?.arrCancelled) ? [i] : []));
  const last = rail[rail.length - 1];
  const asBooked = !missed.length && !cancelled.length && !!last.rt?.arr;
  return {
    complete: withRt.length === rail.length,
    final: withRt.every((l) => l.rt!.final),
    arrival: asBooked ? last.rt!.arr! : null,
    arrivalDelay: asBooked ? delayMin(last.plannedArrival, last.rt!.arr) : null,
    missed,
    cancelled,
  };
}

// ---- our own observations vs. DB's data -------------------------------------

const MAX_LOG = 300;
const t = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : NaN);

/** Legs stored before rtLive/rtOpen existed carry everything in `rt`. */
export function normalizeLeg(leg: TripLeg): TripLeg {
  if (!leg.rt || leg.rtOpen || leg.rtLive) return leg;
  return leg.rt.source === "opendata" ? { ...leg, rtOpen: leg.rt } : { ...leg, rtLive: leg.rt };
}

/**
 * The value to show / use for claims. Per side (departure, arrival): a live
 * observation made after the event happened is what we saw — it wins over DB's
 * later data (DB sometimes rewrites delays afterwards), which is then kept as
 * `dbLater`. A live value seen before the event was only a forecast — DB's
 * final data replaces it for display, the forecast stays in rtLog.
 */
export function combineRt(open: LegRealtime | null | undefined, live: LegRealtime | null | undefined): LegRealtime | null {
  const o = open && !open.missing ? open : null;
  if (!o && !live) return open ?? null;
  const pick = (kind: "dep" | "arr") => {
    const lv = live?.[kind] ?? null;
    const ov = o?.[kind] ?? null;
    if (lv && live!.checkedAt >= t(lv)) {
      const differs = ov != null && Math.abs(t(ov) - t(lv)) >= 2 * 60_000;
      return { v: lv, final: true, fromLive: true, later: differs ? ov : null };
    }
    if (ov) return { v: ov, final: o!.final, fromLive: false, later: null };
    if (lv) return { v: lv, final: false, fromLive: true, later: null };
    return { v: null, final: !!o?.final, fromLive: false, later: null };
  };
  const dep = pick("dep");
  const arr = pick("arr");
  return {
    dep: dep.v,
    arr: arr.v,
    depCancelled: !!(live?.depCancelled || o?.depCancelled),
    arrCancelled: !!(live?.arrCancelled || o?.arrCancelled),
    codes: o?.codes,
    missing: !o && !!open?.missing && !live,
    final: dep.final && arr.final,
    source: dep.fromLive || arr.fromLive ? "live" : "opendata",
    checkedAt: Math.max(live?.checkedAt ?? 0, open?.checkedAt ?? 0),
    tripId: live?.tripId ?? null,
    dbLater: dep.later || arr.later ? { dep: dep.later, arr: arr.later } : null,
  };
}

/** Store a new live observation and/or open-data result; keeps everything we saw before. */
export function withRealtime(leg: TripLeg, update: { live?: LegRealtime; open?: LegRealtime | null }): TripLeg {
  const base = normalizeLeg(leg);
  const rtOpen = update.open !== undefined ? update.open : (base.rtOpen ?? null);
  const rtLive = update.live ?? base.rtLive ?? null;
  let rtLog = base.rtLog ?? [];
  if (update.live) {
    const obs: RtObservation = {
      at: update.live.checkedAt,
      dep: update.live.dep ?? null,
      arr: update.live.arr ?? null,
      depCancelled: !!update.live.depCancelled,
      arrCancelled: !!update.live.arrCancelled,
    };
    const last = rtLog[rtLog.length - 1];
    const same =
      last && last.dep === obs.dep && last.arr === obs.arr && !!last.depCancelled === obs.depCancelled && !!last.arrCancelled === obs.arrCancelled;
    if (!same) rtLog = [...rtLog, obs].slice(-MAX_LOG);
  }
  return { ...base, rtOpen, rtLive, ...(rtLog.length ? { rtLog } : {}), rt: combineRt(rtOpen, rtLive) };
}

const sameTrain = (a: TripLeg, b: TripLeg) =>
  !a.isWalking &&
  !b.isWalking &&
  a.plannedDeparture != null &&
  t(a.plannedDeparture) === t(b.plannedDeparture) &&
  ((!!a.trainNumber && a.trainNumber === b.trainNumber) || (!!a.lineName && a.lineName === b.lineName) || a.fromName === b.fromName);

/** New legs (re-import, merge, edit) take over the tracking of the same train from the old ones. */
export function carryRealtime(old: TripLeg[], next: TripLeg[]): TripLeg[] {
  return next.map((n) => {
    if (n.rt || n.rtLive || n.rtOpen || n.rtLog) return n;
    const o = old.find((x) => sameTrain(x, n) && (x.rt || x.rtLive || x.rtOpen || x.rtLog));
    if (!o) return n;
    const src = normalizeLeg(o);
    return { ...n, rt: src.rt, rtLive: src.rtLive, rtOpen: src.rtOpen, ...(src.rtLog ? { rtLog: src.rtLog } : {}) };
  });
}
