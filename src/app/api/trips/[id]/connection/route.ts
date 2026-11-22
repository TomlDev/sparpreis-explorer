import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/bootstrap";
import { getTrip, replaceLegs } from "@/lib/trips/repo";
import { parseShareText } from "@/lib/trips/shareText";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** { text } — "Verbindung teilen" from DB Navigator → the trip's trains (times, platforms). */
export async function POST(req: Request, { params }: Ctx) {
  ensureReady();
  const id = (await params).id;
  const b = (await req.json().catch(() => ({}))) as { text?: unknown };
  const c = typeof b.text === "string" ? parseShareText(b.text) : null;
  if (!c) return NextResponse.json({ error: "Keine Verbindung erkannt – in DB Navigator „Verbindung teilen“ → Text kopieren." }, { status: 400 });
  const trip = getTrip(id);
  if (!trip) return NextResponse.json({ error: "Fahrt nicht gefunden" }, { status: 404 });
  if (c.date !== trip.date)
    return NextResponse.json({ error: `Die Verbindung ist vom ${c.date.split("-").reverse().join(".")}, die Fahrt vom ${trip.date.split("-").reverse().join(".")}.` }, { status: 400 });
  try {
    return NextResponse.json({ trip: replaceLegs(id, c.legs), legs: c.legs.length });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
