import type { TripLeg } from "@/db/schema";
import { getProvider } from "@/lib/rail/provider";
import { getTrip, shiftIso, updateTrip } from "./repo";

/**
 * Intermediate stops of the booked trains — where a broken-off trip can have
 * ended ("Abgebrochen in Hornberg"). The trip only knows where each train was
 * boarded and left; the run in between comes from the routing timetable
 * (Transitous, no DB requests) and is stored on the leg (`stops`), so it is
 * looked up once per trip.
 */

const WEEK = 7 * 86_400_000;
const placeIds = new Map<string, string | null>();

async function place(name: string): Promise<string | null> {
  if (placeIds.has(name)) return placeIds.get(name) ?? null;
  const id = (await getProvider().searchLocations(name, { results: 1 }))[0]?.id ?? null;
  placeIds.set(name, id);
  return id;
}

/** "Hornberg Bahnhof" → "Hornberg" (Transitous names stations like that). */
export const stopLabel = (n: string) => n.replace(/[\s,]+$/, "").replace(/\s+(Bahnhof|Bf\.?)$/i, "").replace(/[\s,]+$/, "").trim();

/** "RE42 (10102)" / "RE 42" → "re42" */
export const lineKey = (s: string | null | undefined) => (s ?? "").replace(/\(.*\)/, "").replace(/\s+/g, "").toLowerCase();

/** Can the stops of this leg be looked up (a train / bus with a planned departure)? */
export const hasRun = (l: TripLeg) => !l.isWalking && !!l.lineName && !!l.plannedDeparture && l.fromName !== "Umstieg" && l.toName !== "Umstieg";

/**
 * Stops between boarding and leaving the leg's train, or null when the train
 * isn't in the timetable. Tries the travel day, then the same train a week
 * later / earlier (a cancelled train is missing on its day; the run is the same),
 * and for an older trip the same weekday now.
 */
export async function findLegStops(leg: TripLeg, now = Date.now()): Promise<string[] | null> {
  if (!hasRun(leg)) return null;
  const [from, to] = [await place(leg.fromName), await place(leg.toName)];
  if (!from || !to) return null;
  const dep = Date.parse(leg.plannedDeparture!);
  const key = lineKey(leg.lineName);
  // the timetable only reaches back a few weeks: an older train is looked up on the same weekday now
  const ahead = Math.max(0, Math.ceil((now - dep) / WEEK)) * 7;
  const old = now - dep > 2 * WEEK;
  const shifts = Array.from(new Set(old ? [ahead, ahead + 7, 0] : [0, 7, -7, ahead]));
  let answered = false;
  for (const days of shifts) {
    // same wall-clock time (a DST change in between keeps 17:04 at 17:04)
    const at = Date.parse(shiftIso(leg.plannedDeparture!, days) ?? "");
    if (Number.isNaN(at)) continue;
    let res;
    try {
      res = await getProvider().searchJourneys(from, to, {
        departure: new Date(at - 3 * 60_000),
        results: 5,
        transfers: 0,
        stopovers: true,
        tickets: false,
      });
    } catch {
      continue; // outside the timetable's range
    }
    answered = true;
    for (const j of res.journeys) {
      const rides = j.legs.filter((l) => !l.isWalking);
      if (rides.length !== 1) continue;
      const r = rides[0];
      if (Math.abs(Date.parse(r.plannedDeparture ?? "") - at) > 2 * 60_000) continue;
      if (key && lineKey(r.lineName) !== key && !lineKey(r.lineName).endsWith(key) && !key.endsWith(lineKey(r.lineName))) continue;
      return (r.stopovers ?? []).map((s) => stopLabel(s.name)).filter((n) => n && n !== "?");
    }
  }
  if (!answered) throw new Error("Fahrplan nicht erreichbar");
  return null;
}

export interface LegStations {
  /** "RE7 Denzlingen → Offenburg" */
  label: string;
  /** boarding, the stops in between, leaving */
  stations: string[];
  /** stops in between known (false: looked up, train not found; null: not looked up) */
  complete: boolean | null;
}

/** Each leg's stations as stored (no lookup). */
export function legStations(legs: TripLeg[]): LegStations[] {
  return legs
    .filter((l) => !l.isWalking)
    .map((l) => ({
      label: `${l.lineName ? `${l.lineName} ` : ""}${l.fromName} → ${l.toName}`,
      stations: [l.fromName, ...(l.stops ?? []), l.toName].filter((s) => s !== "Umstieg"),
      complete: !hasRun(l) ? false : l.stops === undefined ? null : l.stopsFound !== false,
    }));
}

/** Look up the stops of every leg that wasn't looked up yet and store them on the trip. */
export async function tripStations(tripId: string): Promise<LegStations[]> {
  const trip = getTrip(tripId);
  if (!trip) throw new Error("Reise nicht gefunden");
  const todo = trip.legs.map((l, i) => (hasRun(l) && l.stops === undefined ? i : -1)).filter((i) => i >= 0);
  if (!todo.length) return legStations(trip.legs);
  const found = new Map<number, string[] | null>();
  await Promise.all(
    todo.map(async (i) => {
      try {
        found.set(i, await findLegStops(trip.legs[i]));
      } catch {
        // routing down: try again next time
      }
    }),
  );
  if (!found.size) return legStations(trip.legs);
  // re-read: live tracking may have written the legs meanwhile
  const now = getTrip(tripId);
  if (!now || now.legs.length !== trip.legs.length) return legStations(trip.legs);
  const legs = now.legs.map((l, i) => {
    if (!found.has(i) || l.lineName !== trip.legs[i].lineName) return l;
    const s = found.get(i);
    return { ...l, stops: s ?? [], stopsFound: s !== null };
  });
  updateTrip(tripId, { legs });
  return legStations(legs);
}
