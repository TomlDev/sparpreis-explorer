import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/bootstrap";
import { findAlternatives, pickAlternative } from "@/lib/trips/alternatives";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** Next connections to the trip's destination (timetable + realtime, one DB request). */
export async function GET(req: Request, { params }: Ctx) {
  ensureReady();
  const q = new URL(req.url).searchParams;
  const at = q.get("at");
  try {
    return NextResponse.json(
      await findAlternatives((await params).id, {
        at: at && !Number.isNaN(Date.parse(at)) ? at : null,
        fromName: q.get("fromName") ?? undefined,
        fromId: q.get("fromId"),
      }),
    );
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

/** { key } → that connection becomes the journey made on this ticket. */
export async function POST(req: Request, { params }: Ctx) {
  ensureReady();
  const b = (await req.json().catch(() => ({}))) as { key?: string };
  try {
    return NextResponse.json({ trip: pickAlternative((await params).id, String(b.key ?? "")) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
