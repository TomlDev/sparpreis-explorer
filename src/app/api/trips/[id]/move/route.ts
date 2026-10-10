import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/bootstrap";
import { moveTrip, unmoveTrip } from "@/lib/trips/repo";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** Ticket used for another journey: { date, targetId? } → the replacement trip. */
export async function POST(req: Request, { params }: Ctx) {
  ensureReady();
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const trip = moveTrip((await params).id, {
      date: typeof b.date === "string" ? b.date : "",
      targetId: typeof b.targetId === "string" && b.targetId ? b.targetId : null,
    });
    return NextResponse.json({ trip });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

/** Undo: the booked trip is planned again. */
export async function DELETE(_req: Request, { params }: Ctx) {
  ensureReady();
  unmoveTrip((await params).id);
  return NextResponse.json({ ok: true });
}
