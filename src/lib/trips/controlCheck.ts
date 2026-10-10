import type { EventContext, TripEventRow, TripLeg } from "@/db/schema";
import type { NormStopover } from "@/lib/rail/types";
import { todayLocal } from "@/lib/time";
import { trainRun, findStop } from "./live";
import { withRealtime } from "./realtime";
import { getTrip, setEventContext, updateTrip } from "./repo";

/**
 * Ticket check → where was the train at that moment? From DB's live run of the
 * leg's train: between which stops (actual times), its delay then and the
 * prognosis for the next stop; with GPS also whether the phone was near that
 * stretch of track — i.e. whether you sat in the train you think you did.
 */

const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : NaN);
const dep = (s: NormStopover) => ms(s.departure ?? s.plannedDeparture);
const arr = (s: NormStopover) => ms(s.arrival ?? s.plannedArrival);
const late = (planned: string | null | undefined, actual: string | null | undefined) =>
  planned && actual ? Math.round((ms(actual) - ms(planned)) / 60_000) : null;

/** km between two coordinates (equirectangular — fine for a few hundred km). */
function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const x = ((b.lng - a.lng) * Math.PI) / 180 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  const y = ((b.lat - a.lat) * Math.PI) / 180;
  return Math.sqrt(x * x + y * y) * 6371;
}

/** Distance of p to the straight line a–b (km). */
function kmToSegment(p: { lat: number; lng: number }, a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const ab = km(a, b);
  if (ab < 0.05) return km(p, a);
  // project in a local flat frame around a
  const toXY = (q: { lat: number; lng: number }) => ({
    x: ((q.lng - a.lng) * Math.PI) / 180 * Math.cos((a.lat * Math.PI) / 180) * 6371,
    y: ((q.lat - a.lat) * Math.PI) / 180 * 6371,
  });
  const P = toXY(p);
  const B = toXY(b);
  const t = Math.max(0, Math.min(1, (P.x * B.x + P.y * B.y) / (B.x * B.x + B.y * B.y)));
  return Math.hypot(P.x - t * B.x, P.y - t * B.y);
}

const hasPos = (s: NormStopover | undefined): s is NormStopover & { lat: number; lng: number } =>
  !!s && typeof s.lat === "number" && typeof s.lng === "number";

/** Position of the train at `at` within its run, plus GPS plausibility. */
export function locateTrain(
  stops: NormStopover[],
  at: number,
  leg: Pick<TripLeg, "fromName" | "toName" | "plannedDeparture" | "plannedArrival">,
  gps?: { lat: number; lng: number; accuracy?: number | null } | null,
  train: string | null = null,
): EventContext {
  const base: EventContext = { train, where: null, from: null, to: null, delayMin: null, nextDelayMin: null, outsideLeg: false, gpsKm: null, gpsOk: null, note: null, checkedAt: Date.now() };
  const live = stops.filter((s) => !s.cancelled);
  if (live.length < 2) return { ...base, note: "Zuglauf nicht verfügbar" };
  let ctx: EventContext;
  let near: [NormStopover, NormStopover | undefined] = [live[0], undefined];
  if (at < dep(live[0])) {
    ctx = { ...base, where: "before", from: live[0].name, nextDelayMin: late(live[0].plannedDeparture, live[0].departure) };
  } else if (at >= arr(live[live.length - 1])) {
    const last = live[live.length - 1];
    ctx = { ...base, where: "after", from: last.name, delayMin: late(last.plannedArrival, last.arrival) };
    near = [last, undefined];
  } else {
    // last stop the train has left by `at` …
    let i = 0;
    while (i + 1 < live.length && dep(live[i + 1]) <= at) i++;
    const s = live[i];
    const next = live[i + 1];
    if (next && at >= arr(next)) {
      // … but it already stands at the next one
      ctx = { ...base, where: "at", from: next.name, delayMin: late(next.plannedArrival, next.arrival), nextDelayMin: late(next.plannedDeparture, next.departure) };
      near = [next, undefined];
    } else {
      ctx = {
        ...base,
        where: "between",
        from: s.name,
        to: next?.name ?? null,
        delayMin: late(s.plannedDeparture, s.departure),
        nextDelayMin: next ? late(next.plannedArrival, next.arrival) : null,
      };
      near = [s, next];
    }
  }
  // Only the booked part of the train counts (boarding stop … alighting stop).
  const iFrom = live.findIndex((s) => s === findStop(live, leg.fromName, leg.plannedDeparture, "dep"));
  const iTo = live.findIndex((s) => s === findStop(live, leg.toName, leg.plannedArrival, "arr"));
  const iNow = live.indexOf(near[0]);
  if (iFrom >= 0 && iTo >= 0 && iNow >= 0) ctx.outsideLeg = iNow < iFrom || (ctx.where === "between" ? iNow >= iTo : iNow > iTo);

  if (gps && hasPos(near[0])) {
    const d = hasPos(near[1]) ? kmToSegment(gps, near[0], near[1]) : km(gps, near[0]);
    const slack = 3 + Math.min(5, (gps.accuracy ?? 0) / 1000);
    ctx.gpsKm = Math.round(d * 10) / 10;
    ctx.gpsOk = d <= slack;
  }
  return ctx;
}

/**
 * Fill in the context of a ticket check (and store what we saw of the train as a
 * live observation). Only on the travel day — DB's live run is gone afterwards.
 */
export async function checkControl(event: TripEventRow): Promise<EventContext | null> {
  if (event.type !== "control" || event.legIndex == null) return null;
  const trip = getTrip(event.tripId);
  const leg = trip?.legs[event.legIndex];
  if (!trip || !leg || leg.isWalking) return null;
  const day = new Date(event.at).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
  if (day !== todayLocal()) return null;
  const found = await trainRun(leg);
  if (!found) {
    const ctx: EventContext = { train: leg.lineName ?? null, where: null, from: null, to: null, delayMin: null, nextDelayMin: null, outsideLeg: false, gpsKm: null, gpsOk: null, note: "Zug nicht in den Live-Daten gefunden", checkedAt: Date.now() };
    setEventContext(event.id, ctx);
    return ctx;
  }
  const gps = event.lat != null && event.lng != null ? { lat: event.lat, lng: event.lng, accuracy: event.accuracy } : null;
  const ctx = locateTrain(found.run.stops, event.at, leg, gps, found.run.lineName ?? leg.lineName ?? null);
  setEventContext(event.id, ctx);
  // The run we just fetched is a live observation of this leg too.
  const from = findStop(found.run.stops, leg.fromName, leg.plannedDeparture, "dep");
  const to = findStop(found.run.stops, leg.toName, leg.plannedArrival, "arr");
  if (from || to) {
    const legs = [...trip.legs];
    legs[event.legIndex] = withRealtime(leg, {
      live: {
        dep: from ? (from.departure ?? from.plannedDeparture ?? null) : null,
        arr: to ? (to.arrival ?? to.plannedArrival ?? null) : null,
        depCancelled: !!from?.cancelled,
        arrCancelled: !!to?.cancelled,
        final: false,
        source: "live",
        checkedAt: Date.now(),
        tripId: found.tripId,
      },
    });
    updateTrip(trip.id, { legs });
  }
  return ctx;
}
