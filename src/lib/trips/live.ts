import { eq, or } from "drizzle-orm";
import { db } from "@/db/client";
import { trips, type LegRealtime, type TripLeg, type TripRow } from "@/db/schema";
import { DB_DAILY_CAP } from "@/lib/config";
import { getPricingProvider } from "@/lib/rail/provider";
import type { NormDeparture, NormStopover, NormTrip } from "@/lib/rail/types";
import { addDbUsageToday, dbUsageToday } from "@/lib/repo/settings";
import { todayLocal } from "@/lib/time";
import { updateTrip } from "./repo";
import { normalizeLeg, withRealtime } from "./realtime";
import { isRailLeg } from "./rules";
import { checkForecastAlert, isFlexible } from "./forecastAlerts";
import { checkReroute } from "./reroute";
import { dbStatusTick } from "./dbStatus";

/**
 * Live actual times on the travel day: for the trains running right now, ask
 * DB (bahn.de web API) for the train's run with prognosis / actual times and
 * cancellations. The open data replaces these the next day (final values).
 */

// How often (Oct 2026, kept low on purpose — DB's day cap is shared with the searches):
const START_BEFORE_MIN = 30; // a trip is watched from 30 min before its first train …
const AFTER_MIN = 30; // … each train until half an hour after its (late) arrival
const NEAR_MIN = 60; // the train you're on or board within the hour …
const EVERY_MS = 10 * 60_000; // … every 10 min (plus right at its departure / arrival)
const FAR_EVERY_MS = 30 * 60_000; // later trains of a Flex trip (not "Nehme ich"): every 30 min
const TICK_MS = 60_000; // the scheduler looks every minute what is due
// A train not found / a failed request: that leg waits this long before the next try
// (Oct 2026: a refused endpoint was retried every minute for 8 trains → day cap gone in 50 min).
const RETRY_AFTER_FAIL_MS = 10 * 60_000;
// DB refuses us altogether (all fingerprints): no live requests for a while.
const PAUSE_WHEN_BLOCKED_MS = 15 * 60_000;

const lg = globalThis as { __liveFails?: Map<string, number>; __livePausedUntil?: number; __stationIds?: Map<string, string | null> };
const fails = (lg.__liveFails ??= new Map());
const stationIds = (lg.__stationIds ??= new Map());
const failKey = (tripId: string, i: number) => `${tripId}#${i}`;
/** Live requests are paused (DB blocks us) — the scheduler and refreshLive skip until then. */
export const livePausedUntil = () => lg.__livePausedUntil ?? 0;

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "").replace(/hauptbahnhof/g, "hbf");
const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : NaN);

const railIdx = (legs: TripLeg[]) => legs.map((l, i) => ({ l: normalizeLeg(l), i })).filter(({ l }) => isRailLeg(l));
/** The trip's live window has begun: 30 min before it starts — its first leg, the tram to the
 *  station included (not only before the first train). */
const started = (legs: TripLeg[], now: number) => {
  const first = legs.find((l) => !l.isWalking && l.plannedDeparture) ?? railIdx(legs)[0]?.l;
  return !!first && now >= ms(first.plannedDeparture) - START_BEFORE_MIN * 60_000;
};
/** Not over yet: until 30 min after its (late) arrival, and no final data. */
const pending = (l: TripLeg, now: number) => {
  if (normalizeLeg(l).rtOpen?.final) return false;
  const arr = ms(l.plannedArrival ?? l.plannedDeparture);
  const late = Math.max(0, (ms(l.rt?.arr) || arr) - arr);
  return now <= arr + late + AFTER_MIN * 60_000;
};

/** Legs close at hand: the train you're on, or board within the hour (once the trip's window began). */
export function activeLegs(legs: TripLeg[], now = Date.now()): number[] {
  if (!started(legs, now)) return [];
  return railIdx(legs)
    .filter(({ l }) => pending(l, now) && now >= ms(l.rt?.dep ?? l.plannedDeparture) - NEAR_MIN * 60_000)
    .map(({ i }) => i);
}

/**
 * Close legs that need a measurement now: the first one, every 10 minutes, and
 * right when the train (by plan or prognosis) leaves and arrives — so the moment
 * of departure / arrival is captured, not up to 10 minutes later.
 */
export function dueLegs(legs: TripLeg[], now = Date.now()): number[] {
  return activeLegs(legs, now).filter((i) => {
    const live = normalizeLeg(legs[i]).rtLive;
    if (!live) return true;
    const last = live.checkedAt;
    if (now - last >= EVERY_MS) return true;
    const dep = ms(live.dep ?? legs[i].plannedDeparture);
    const arr = ms(live.arr ?? legs[i].plannedArrival);
    return (last < dep && now >= dep) || (last < arr && now >= arr);
  });
}

/**
 * Flex trips (not "Nehme ich"): the later trains too — a delay or cancellation
 * further on lifts the Zugbindung just as well — every 30 min.
 */
export function forecastLegs(legs: TripLeg[], now = Date.now()): number[] {
  if (!started(legs, now)) return [];
  return railIdx(legs)
    .filter(({ l }) => pending(l, now) && (!l.rtLive || now - l.rtLive.checkedAt >= FAR_EVERY_MS))
    .map(({ i }) => i);
}


/** The leg's train on a departure board: same planned minute and number / line. */
export function matchDeparture(leg: TripLeg, deps: NormDeparture[]): NormDeparture | null {
  const planned = ms(leg.plannedDeparture);
  const line = norm(leg.lineName ?? "");
  const hits = deps.filter((d) => {
    if (!d.tripId || Math.abs(ms(d.plannedWhen) - planned) > 2 * 60_000) return false;
    const n = d.trainNumber ?? "";
    return (
      (!!leg.trainNumber && (n === leg.trainNumber || n.endsWith(leg.trainNumber) || norm(d.lineName ?? "").includes(leg.trainNumber))) ||
      (!!line && norm(d.lineName ?? "") === line)
    );
  });
  return hits[0] ?? null;
}

/** Boarding / alighting stop in the train's run: by name, else by planned time. */
export function findStop(stops: NormStopover[], name: string, planned: string | null, kind: "dep" | "arr"): NormStopover | null {
  const n = norm(name);
  const byName = stops.find((s) => norm(s.name) === n);
  if (byName) return byName;
  const p = ms(planned);
  return stops.find((s) => ms(kind === "dep" ? s.plannedDeparture : s.plannedArrival) === p) ?? null;
}

/** The leg's train with its whole run (realtime per stop) — board lookup only the first time. */
export async function trainRun(leg: TripLeg): Promise<{ tripId: string; run: NormTrip } | null> {
  const provider = getPricingProvider();
  if (!provider?.getTrip || !provider.getDepartures) return null;
  const spend = () => {
    if (dbUsageToday() >= DB_DAILY_CAP) throw new Error("Tageslimit DB-Abfragen erreicht");
    addDbUsageToday(1);
  };
  let tripId = normalizeLeg(leg).rtLive?.tripId ?? null;
  if (!tripId) {
    let station = leg.fromId && /^\d{6,8}$/.test(leg.fromId) ? leg.fromId : null;
    if (!station && stationIds.has(leg.fromName)) station = stationIds.get(leg.fromName) ?? null;
    else if (!station) {
      spend();
      station = (await provider.searchLocations(leg.fromName, { results: 1 }))[0]?.id ?? null;
      stationIds.set(leg.fromName, station);
    }
    if (!station || !leg.plannedDeparture) return null;
    spend();
    const deps = await provider.getDepartures(station, { when: new Date(ms(leg.plannedDeparture) - 10 * 60_000), duration: 30, results: 40 });
    tripId = matchDeparture(leg, deps)?.tripId ?? null;
    if (!tripId) return null;
  }
  spend();
  return { tripId, run: await provider.getTrip(tripId) };
}

async function liveRt(leg: TripLeg): Promise<LegRealtime | null> {
  const found = await trainRun(leg);
  if (!found) return null;
  const { tripId, run } = found;
  const from = findStop(run.stops, leg.fromName, leg.plannedDeparture, "dep");
  const to = findStop(run.stops, leg.toName, leg.plannedArrival, "arr");
  if (!from && !to) return null;
  return {
    dep: from ? (from.departure ?? from.plannedDeparture ?? null) : null,
    arr: to ? (to.arrival ?? to.plannedArrival ?? null) : null,
    depCancelled: !!from?.cancelled,
    arrCancelled: !!to?.cancelled,
    final: false,
    source: "live",
    checkedAt: Date.now(),
    tripId,
    runStart: run.stops.find((x) => !x.cancelled)?.plannedDeparture ?? run.stops[0]?.plannedDeparture ?? null,
  };
}

/** One scheduler pass for a trip: the trains that are due, then the forecast checks.
 *  (A whole-trip refresh via DB's journey reconstruction was tried — it carries no
 *  realtime, only planned times, so each train is asked for on its own.) */
export async function measureTrip(t: TripRow, now = Date.now()): Promise<void> {
  if (now < livePausedUntil()) return;
  await refreshLive(t, now);
  await afterMeasure(t.id);
}

/** Refresh the running trains of one trip (only what is due, unless `all`). Returns true when something changed. */
export async function refreshLive(trip: TripRow, now = Date.now(), all = false): Promise<boolean> {
  if (now < livePausedUntil()) return false;
  const watch = isFlexible(trip) || (trip.status === "planned" && !!trip.movedFrom);
  const active = [...new Set([...(all ? activeLegs(trip.legs, now) : dueLegs(trip.legs, now)), ...(watch ? forecastLegs(trip.legs, now) : [])])]
    // a leg that just failed waits (unless asked for explicitly)
    .filter((i) => all || now - (fails.get(failKey(trip.id, i)) ?? 0) >= RETRY_AFTER_FAIL_MS);
  if (!active.length) return false;
  const legs = [...trip.legs];
  let changed = false;
  for (const i of active) {
    try {
      const rt = await liveRt(legs[i]);
      if (rt) {
        legs[i] = withRealtime(legs[i], { live: rt });
        changed = true;
        fails.delete(failKey(trip.id, i));
      } else fails.set(failKey(trip.id, i), now);
    } catch (e) {
      fails.set(failKey(trip.id, i), now);
      console.error("[live]", (e as Error).message);
      if ((e as { isBlocked?: boolean }).isBlocked || /Tageslimit/.test((e as Error).message)) {
        lg.__livePausedUntil = now + PAUSE_WHEN_BLOCKED_MS;
        console.error(`[live] paused until ${new Date(lg.__livePausedUntil).toISOString()}`);
        break;
      }
    }
  }
  if (changed) updateTrip(trip.id, { legs });
  return changed;
}

/**
 * After measuring: a broken connection → check the fastest way on (decides the
 * Zugbindung), then keep a crossed line as evidence on the trip.
 */
export async function afterMeasure(tripId: string): Promise<void> {
  try {
    let t = db.select().from(trips).where(eq(trips.id, tripId)).get();
    if (!t) return;
    const check = await checkReroute(t);
    if (check && check !== t.reroute) t = { ...t, reroute: check };
    if (isFlexible(t) || (t.status === "planned" && !!t.movedFrom)) checkForecastAlert(t);
  } catch (e) {
    console.error("[forecast]", (e as Error).message);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __liveTimer: ReturnType<typeof setInterval> | undefined;
}

/** Every minute: measure what is due on today's (and last night's) trips. */
export function startLivePolling(): void {
  if (globalThis.__liveTimer || process.env.NODE_ENV === "test") return;
  let busy = false;
  globalThis.__liveTimer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const today = todayLocal();
      const yesterday = new Date(Date.now() - 86_400_000).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
      const list = db.select().from(trips).where(or(eq(trips.date, today), eq(trips.date, yesterday))).all();
      for (const t of list) if (t.status === "planned" || t.status === "delayed") await measureTrip(t);
      // DB's own verdict on booked trips (Reisebegleitung) — on its own track (a browser is
      // slow): never holds up the live tracking
      void dbStatusTick();
    } catch (e) {
      console.error("[live]", (e as Error).message);
    } finally {
      busy = false;
    }
  }, TICK_MS);
  globalThis.__liveTimer.unref();
}
