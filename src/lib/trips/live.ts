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

/**
 * Live actual times on the travel day: for the trains running right now, ask
 * DB (bahn.de web API) for the train's run with prognosis / actual times and
 * cancellations. The open data replaces these the next day (final values).
 */

const BEFORE_MIN = 60; // start watching a train an hour before it leaves …
const AFTER_MIN = 30; // … until half an hour after its planned arrival
const EVERY_MS = 10 * 60_000; // regular measurement while a train is watched
const TICK_MS = 60_000; // the scheduler looks every minute what is due

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "").replace(/hauptbahnhof/g, "hbf");
const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : NaN);

/** Legs whose train is running (or about to) at `now`. */
export function activeLegs(legs: TripLeg[], now = Date.now()): number[] {
  return legs.flatMap((l, i) => {
    if (!isRailLeg(l) || normalizeLeg(l).rtOpen?.final) return [];
    const dep = ms(l.plannedDeparture);
    const arr = ms(l.plannedArrival ?? l.plannedDeparture);
    const delay = Math.max(0, (ms(l.rt?.arr) || arr) - arr); // keep watching a late train
    return now >= dep - BEFORE_MIN * 60_000 && now <= arr + delay + AFTER_MIN * 60_000 ? [i] : [];
  });
}

/**
 * Watched legs that need a measurement now: the first one, every 10 minutes, and
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
    if (!station) {
      spend();
      station = (await provider.searchLocations(leg.fromName, { results: 1 }))[0]?.id ?? null;
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
  };
}

/** Refresh the running trains of one trip (only what is due, unless `all`). Returns true when something changed. */
export async function refreshLive(trip: TripRow, now = Date.now(), all = false): Promise<boolean> {
  const active = all ? activeLegs(trip.legs, now) : dueLegs(trip.legs, now);
  if (!active.length) return false;
  const legs = [...trip.legs];
  let changed = false;
  for (const i of active) {
    try {
      const rt = await liveRt(legs[i]);
      if (rt) {
        legs[i] = withRealtime(legs[i], { live: rt });
        changed = true;
      }
    } catch (e) {
      console.error("[live]", (e as Error).message);
    }
  }
  if (changed) updateTrip(trip.id, { legs });
  return changed;
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
      for (const t of list) if (t.status === "planned" || t.status === "delayed") await refreshLive(t);
    } catch (e) {
      console.error("[live]", (e as Error).message);
    } finally {
      busy = false;
    }
  }, TICK_MS);
  globalThis.__liveTimer.unref();
}
