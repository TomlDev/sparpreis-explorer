import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/bootstrap";
import { addEvent, deleteEvent, updateEvent } from "@/lib/trips/repo";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };
const TYPES = new Set(["control", "note", "delay", "abort", "arrival"]);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const coordsOk = (b: Record<string, unknown>) =>
  (b.lat == null || (num(b.lat) != null && Math.abs(b.lat as number) <= 90)) &&
  (b.lng == null || (num(b.lng) != null && Math.abs(b.lng as number) <= 180));

/** Log something that happened on the trip — e.g. a ticket check with GPS. */
export async function POST(req: Request, { params }: Ctx) {
  ensureReady();
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const type = typeof b.type === "string" && TYPES.has(b.type) ? b.type : null;
  if (!type) return NextResponse.json({ error: "type fehlt" }, { status: 400 });
  if (!coordsOk(b)) return NextResponse.json({ error: "Koordinaten ungültig" }, { status: 400 });
  try {
    const event = addEvent((await params).id, {
      type,
      at: num(b.at) ?? undefined,
      lat: num(b.lat),
      lng: num(b.lng),
      accuracy: num(b.accuracy),
      legIndex: num(b.legIndex),
      text: typeof b.text === "string" ? b.text.slice(0, 2000) : null,
    });
    return NextResponse.json({ event });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  ensureReady();
  const id = new URL(req.url).searchParams.get("eventId");
  if (id) deleteEvent(id);
  return NextResponse.json({ deleted: !!id });
}

/** Correct an entry afterwards: time, location (set by hand on the map) or text. */
export async function PATCH(req: Request) {
  ensureReady();
  const id = new URL(req.url).searchParams.get("eventId");
  if (!id) return NextResponse.json({ error: "eventId fehlt" }, { status: 400 });
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (!coordsOk(b)) return NextResponse.json({ error: "Koordinaten ungültig" }, { status: 400 });
  const opt = (v: unknown) => (v === null ? null : num(v) ?? undefined);
  const event = updateEvent(id, {
    at: num(b.at) ?? undefined,
    lat: opt(b.lat),
    lng: opt(b.lng),
    accuracy: opt(b.accuracy),
    text: b.text === null ? null : typeof b.text === "string" ? b.text.slice(0, 2000) : undefined,
  });
  return event ? NextResponse.json({ event }) : NextResponse.json({ error: "nicht gefunden" }, { status: 404 });
}
