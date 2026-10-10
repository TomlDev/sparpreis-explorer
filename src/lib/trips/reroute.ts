import type { RerouteCheck, TripRow } from "@/db/schema";
import { DB_DAILY_CAP } from "@/lib/config";
import { getPricingProvider } from "@/lib/rail/provider";
import type { NormJourney } from "@/lib/rail/types";
import { addDbUsageToday, dbUsageToday } from "@/lib/repo/settings";
import { formatTime } from "@/lib/time";
import { bookedForecast, LIFT_MIN } from "./forecast";
import { missedConnections } from "./realtime";
import { addEvent, updateTrip } from "./repo";
import { isRailLeg } from "./rules";

/**
 * A connection of a booked trip breaks (the next train leaves before the late
 * one arrives, or a train is cancelled). Whether the Zugbindung goes depends on
 * the delay at the ticket's destination with the *fastest* way on from there —
 * not on the broken connection itself. Checked against DB's live timetable
 * while the break lasts (every 10 min, one request) and kept on the trip as
 * evidence.
 */

const EVERY_MS = 10 * 60_000;
const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : NaN);

/** Best arrival among DB's journeys (realtime where known), skipping cancelled ones. */
export function bestArrival(journeys: NormJourney[]): { arrival: string; via: string } | null {
  let best: { arrival: string; via: string } | null = null;
  for (const j of journeys) {
    const rides = j.legs.filter((l) => !l.isWalking);
    if (!rides.length || j.legs.some((l) => (l as { cancelled?: boolean }).cancelled === true)) continue;
    const last = rides[rides.length - 1];
    const arrival = last.arrival ?? last.plannedArrival;
    if (!arrival) continue;
    if (!best || ms(arrival) < ms(best.arrival)) best = { arrival, via: rides.map((l) => l.lineName ?? "?").join(" → ") };
  }
  return best;
}

export async function checkReroute(t: TripRow, now = Date.now()): Promise<RerouteCheck | null> {
  if (t.status !== "planned" && t.status !== "delayed") return null;
  const f = bookedForecast(t.legs);
  if (!f.breakAt) return null;
  const prev = t.reroute;
  if (prev && prev.breakLeg === f.breakAt.legIndex && now - prev.checkedAt < EVERY_MS) return prev;
  const provider = getPricingProvider();
  if (!provider || dbUsageToday() >= DB_DAILY_CAP) return prev ?? null;

  // the ticket's destination = last train (bus / tram after it don't count)
  const rail = t.legs.filter(isRailLeg);
  const dest = rail[rail.length - 1];
  if (!dest?.plannedArrival) return null;
  // earliest you're at the break: the late train's arrival (missed) / its planned time (cancelled), not before now
  const missed = missedConnections(t.legs).find((m) => m.nextLeg === f.breakAt!.legIndex);
  const at = Math.max(now, ms(missed?.arrived ?? t.legs[f.breakAt.legIndex].plannedDeparture) || now);
  const resolve = async (id: string | null | undefined, name: string) => {
    if (id && /^\d{6,8}$/.test(id)) return id;
    addDbUsageToday(1);
    return (await provider.searchLocations(name, { results: 1 }))[0]?.id ?? null;
  };
  try {
    const from = await resolve(f.breakAt.stationId, f.breakAt.station);
    const to = await resolve(dest.toId, dest.toName);
    if (!from || !to) return prev ?? null;
    addDbUsageToday(1);
    const res = await provider.searchJourneys(from, to, { departure: new Date(at), results: 6, tickets: false, stopovers: false, transfers: -1 });
    const best = bestArrival(res.journeys);
    const check: RerouteCheck = {
      breakLeg: f.breakAt.legIndex,
      from: f.breakAt.station,
      after: new Date(at).toISOString(),
      arrival: best?.arrival ?? null,
      delayMin: best ? Math.round((ms(best.arrival) - ms(dest.plannedArrival)) / 60_000) : null,
      via: best?.via ?? null,
      checkedAt: now,
    };
    updateTrip(t.id, { reroute: check });
    // evidence: first result for this break, and whenever it crosses the 20-minute line
    const lifted = (c: RerouteCheck | null | undefined) => !!c && (c.arrival == null || (c.delayMin ?? 0) >= LIFT_MIN);
    if (!prev || prev.breakLeg !== check.breakLeg || lifted(prev) !== lifted(check)) {
      addEvent(t.id, {
        type: "delay",
        at: now,
        text: `${f.reason}. Schnellste Weiterfahrt ab ${check.from} (DB-Live-Fahrplan ${formatTime(new Date(now).toISOString())}): ${
          check.arrival
            ? `${check.via}, an ${dest.toName} ${formatTime(check.arrival)} (${(check.delayMin ?? 0) > 0 ? `+${check.delayMin}` : "±0"} min) → Zugbindung ${lifted(check) ? "aufgehoben" : "bleibt"}`
            : "keine Verbindung gefunden → Zugbindung aufgehoben"
        }`,
      });
    }
    return check;
  } catch (e) {
    console.error("[reroute]", (e as Error).message);
    return prev ?? null;
  }
}
