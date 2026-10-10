import type { TripLeg, TripRow } from "@/db/schema";
import { DB_DAILY_CAP } from "@/lib/config";
import { reliabilityOfLegs } from "@/lib/delay";
import type { Reliability } from "@/lib/delay/reliability";
import { getPricingProvider } from "@/lib/rail/provider";
import type { NormJourney } from "@/lib/rail/types";
import { addDbUsageToday, dbUsageToday } from "@/lib/repo/settings";
import { berlinDay } from "@/lib/time";
import { addEvent, createTrip, getTrip, moveTrip, updateTrip } from "./repo";
import { tripForecast } from "./forecast";

/**
 * Replacement connections for a trip whose Zugbindung is lifted: the next
 * trains (timetable + realtime, no prices — one DB request) from the start, or
 * from where the booked itinerary breaks when already under way. Picking one
 * links it as the journey made on this ticket and the live tracking follows it.
 */

export interface AltLeg {
  line: string | null;
  product: string | null;
  from: string;
  to: string;
  dep: string | null;
  arr: string | null;
  /** realtime (null = none / on time) */
  depRt: string | null;
  arrRt: string | null;
  cancelled: boolean;
  walking: boolean;
}
export interface Alternative {
  key: string;
  dep: string | null;
  arr: string | null;
  depRt: string | null;
  arrRt: string | null;
  durationMin: number | null;
  transfers: number;
  legs: AltLeg[];
  reliability: Reliability | null;
  cancelled: boolean;
}

const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : NaN);
const cache = new Map<string, { at: number; journeys: Map<string, NormJourney> }>();
const CACHE_MS = 20 * 60_000;

const keyOf = (j: NormJourney) =>
  j.legs.map((l) => `${l.lineName ?? (l.isWalking ? "walk" : "?")}@${l.plannedDeparture ?? ""}`).join("|");

function toTripLegs(j: NormJourney): TripLeg[] {
  return j.legs.map((l) => ({
    product: l.product,
    lineName: l.lineName,
    trainNumber: l.trainNumber,
    fromId: l.origin.id ?? null,
    fromName: l.origin.name,
    toId: l.destination.id ?? null,
    toName: l.destination.name,
    plannedDeparture: l.plannedDeparture ?? null,
    plannedArrival: l.plannedArrival ?? null,
    isWalking: l.isWalking,
  }));
}

/** Where to look from: the start before departure, else the station where the booked itinerary breaks / continues. */
export function alternativeStart(t: TripRow, now = Date.now()): { name: string; id: string | null; underway: boolean } {
  const first = t.legs[0];
  if (!(now >= ms(t.plannedDeparture))) return { name: first.fromName, id: first.fromId ?? null, underway: false };
  const f = tripForecast(t.legs, t.reroute);
  if (f.breakAt) return { name: f.breakAt.station, id: f.breakAt.stationId, underway: true };
  // under way without a break: from the next station where a train leaves
  const next = t.legs.find((l) => !l.isWalking && ms(l.plannedDeparture) > now);
  return next ? { name: next.fromName, id: next.fromId ?? null, underway: true } : { name: first.fromName, id: first.fromId ?? null, underway: true };
}

export async function findAlternatives(tripId: string, opts: { at?: string | null; fromName?: string; fromId?: string | null } = {}) {
  const t = getTrip(tripId);
  if (!t) throw new Error("Fahrt nicht gefunden");
  const provider = getPricingProvider();
  if (!provider) throw new Error("Keine Fahrplanabfrage verfügbar");
  if (dbUsageToday() >= DB_DAILY_CAP) throw new Error("Tageslimit DB-Abfragen erreicht");
  const start = opts.fromName ? { name: opts.fromName, id: opts.fromId ?? null, underway: true } : alternativeStart(t);
  const last = t.legs[t.legs.length - 1];
  // default: not before the booked departure (whether an earlier train is allowed isn't clearly regulated)
  const when = opts.at ? new Date(opts.at) : new Date(Math.max(Date.now(), ms(t.plannedDeparture) || 0));
  const resolve = async (id: string | null, name: string) => {
    if (id && /^\d{6,8}$/.test(id)) return id;
    addDbUsageToday(1);
    return (await provider.searchLocations(name, { results: 1 }))[0]?.id ?? null;
  };
  const from = await resolve(start.id, start.name);
  const to = await resolve(last.toId ?? null, last.toName);
  if (!from || !to) throw new Error("Haltestelle nicht gefunden");
  addDbUsageToday(1);
  const res = await provider.searchJourneys(from, to, { departure: when, results: 8, tickets: false, stopovers: false, transfers: -1 });
  const journeys = new Map<string, NormJourney>();
  const day = berlinDay(when);
  const list: Alternative[] = res.journeys.map((j) => {
    const key = keyOf(j);
    journeys.set(key, j);
    const rides = j.legs.filter((l) => !l.isWalking);
    const a = rides[0] ?? j.legs[0];
    const b = rides[rides.length - 1] ?? j.legs[j.legs.length - 1];
    const legs = toTripLegs(j);
    return {
      key,
      dep: a?.plannedDeparture ?? null,
      arr: b?.plannedArrival ?? null,
      depRt: a?.departure ?? null,
      arrRt: b?.arrival ?? null,
      durationMin: a && b ? Math.round((ms(b.arrival ?? b.plannedArrival) - ms(a.departure ?? a.plannedDeparture)) / 60_000) : null,
      transfers: Math.max(0, rides.length - 1),
      cancelled: j.legs.some((l) => (l as { cancelled?: boolean }).cancelled === true),
      legs: j.legs.map((l) => ({
        line: l.lineName ?? null,
        product: l.product ?? null,
        from: l.origin.name,
        to: l.destination.name,
        dep: l.plannedDeparture ?? null,
        arr: l.plannedArrival ?? null,
        depRt: l.departure ?? null,
        arrRt: l.arrival ?? null,
        cancelled: (l as { cancelled?: boolean }).cancelled === true,
        walking: l.isWalking,
      })),
      reliability: reliabilityOfLegs(
        legs.map((l) => ({ ...l, isWalking: !!l.isWalking, durationMin: Math.round((ms(l.plannedArrival) - ms(l.plannedDeparture)) / 60_000) || 0 })),
        day,
      ),
    };
  });
  cache.set(tripId, { at: Date.now(), journeys });
  return { start, when: when.toISOString(), alternatives: list, forecast: tripForecast(t.legs, t.reroute) };
}

/**
 * "Diese nehme ich": the picked connection becomes the trip actually made on
 * this ticket (linked, tracked live); the forecast that lifted the Zugbindung
 * is kept on the booked trip as the expected delay.
 */
export function pickAlternative(tripId: string, key: string): TripRow {
  const t = getTrip(tripId);
  if (!t) throw new Error("Fahrt nicht gefunden");
  const hit = cache.get(tripId);
  const j = hit && Date.now() - hit.at < CACHE_MS ? hit.journeys.get(key) : undefined;
  if (!j) throw new Error("Verbindung nicht mehr aktuell – bitte neu laden");
  const legs = toTripLegs(j);
  // From a break under way: the part already travelled stays, the new trains follow.
  const startName = legs[0]?.fromName;
  const keep = t.legs[0]?.fromName === startName ? [] : t.legs.slice(0, Math.max(0, t.legs.findIndex((l) => l.fromName === startName)));
  const f = tripForecast(t.legs, t.reroute);
  if (t.expectedDelayMin == null && f.delayMin != null) updateTrip(t.id, { expectedDelayMin: f.delayMin });
  const created = createTrip({ legs: [...keep.map((l) => ({ ...l })), ...legs], source: "replacement" });
  const replacement = moveTrip(t.id, { date: created.date, targetId: created.id });
  addEvent(t.id, {
    type: "note",
    text: `Ersatzverbindung gewählt: ${legs.filter((l) => !l.isWalking).map((l) => l.lineName).join(", ")} ab ${startName}${f.reason ? ` (Grund: ${f.reason})` : ""}`,
  });
  cache.delete(tripId);
  return replacement;
}
