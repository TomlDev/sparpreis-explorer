import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/bootstrap";
import { fetchActuals } from "@/lib/trips/actuals";
import { activeLegs, refreshLive } from "@/lib/trips/live";
import { getTrip } from "@/lib/trips/repo";
import { todayLocal } from "@/lib/time";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** Actual times for this trip: live on the travel day, from the open DB data afterwards. */
export async function POST(_req: Request, { params }: Ctx) {
  ensureReady();
  const id = (await params).id;
  const trip = getTrip(id);
  if (!trip) return NextResponse.json({ error: "Fahrt nicht gefunden" }, { status: 404 });
  // Travel day: live data for the trains running now; the final values follow the next day.
  if (trip.date >= todayLocal() || activeLegs(trip.legs).length) {
    if (!activeLegs(trip.legs).length)
      return NextResponse.json({ error: "Gerade fährt kein Zug dieser Fahrt – Live-Daten ab einer Stunde vor Abfahrt." }, { status: 400 });
    try {
      await refreshLive(trip, Date.now(), true);
      return NextResponse.json({ trip: getTrip(id) });
    } catch (e) {
      return NextResponse.json({ error: `Live-Daten nicht verfügbar: ${(e as Error).message}` }, { status: 502 });
    }
  }
  try {
    const r = await fetchActuals([id]);
    if (r.pending.includes(id))
      return NextResponse.json({ error: "Für diesen Tag sind die DB-Daten noch nicht veröffentlicht – die App versucht es nachts erneut." }, { status: 404 });
    return NextResponse.json({ trip: getTrip(id) });
  } catch (e) {
    return NextResponse.json({ error: `Ist-Zeiten konnten nicht geladen werden: ${(e as Error).message}` }, { status: 502 });
  }
}
