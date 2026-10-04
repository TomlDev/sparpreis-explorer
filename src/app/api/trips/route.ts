import { NextResponse } from "next/server";
import type { TripLeg } from "@/db/schema";
import { ensureReady } from "@/lib/bootstrap";
import { createTrip, listTrips } from "@/lib/trips/repo";

export const runtime = "nodejs";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  ensureReady();
  const q = new URL(req.url).searchParams;
  const from = q.get("from") ?? "";
  const to = q.get("to") ?? "";
  if (!DAY.test(from) || !DAY.test(to)) return NextResponse.json({ error: "from/to (yyyy-MM-dd) fehlen" }, { status: 400 });
  return NextResponse.json({ trips: listTrips(from, to) });
}

/** Create a trip, e.g. from a search result ("Gebucht"). */
export async function POST(req: Request) {
  ensureReady();
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const legs = (Array.isArray(b.legs) ? b.legs : []) as Record<string, unknown>[];
  const str = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 200) : null);
  const when = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
  const clean: TripLeg[] = legs.slice(0, 40).map((l) => ({
    product: str(l.product) ?? undefined,
    lineName: str(l.lineName) ?? undefined,
    trainNumber: str(l.trainNumber) ?? undefined,
    fromId: str(l.fromId),
    fromName: str(l.fromName) ?? "?",
    toId: str(l.toId),
    toName: str(l.toName) ?? "?",
    plannedDeparture: when(l.plannedDeparture),
    plannedArrival: when(l.plannedArrival),
    isWalking: l.isWalking === true,
  }));
  try {
    const trip = createTrip({
      legs: clean,
      source: str(b.source) ?? "manual",
      fingerprint: str(b.fingerprint),
      refreshToken: typeof b.refreshToken === "string" ? b.refreshToken.slice(0, 4000) : null,
      orderNumber: str(b.orderNumber),
      price: typeof b.price === "number" ? b.price : null,
      klasse: b.klasse === 1 || b.klasse === 2 ? b.klasse : null,
      ticketType: str(b.ticketType),
      notes: str(b.notes),
    });
    return NextResponse.json({ trip });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
