import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/bootstrap";
import { deleteTrip, getTrip, updateTrip } from "@/lib/trips/repo";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  ensureReady();
  const trip = getTrip((await params).id);
  return trip ? NextResponse.json({ trip }) : NextResponse.json({ error: "nicht gefunden" }, { status: 404 });
}

export async function PATCH(req: Request, { params }: Ctx) {
  ensureReady();
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const str = (v: unknown) => (v === null ? null : typeof v === "string" ? v.slice(0, 2000) : undefined);
  const id = (await params).id;
  // Round trip: price of this direction — merged into the stored ticket details.
  const dp = b.directionPrice;
  const directionPrice = dp === null || (typeof dp === "number" && Number.isFinite(dp) && dp >= 0 && dp < 10_000) ? dp : undefined;
  try {
    const current = directionPrice !== undefined ? getTrip(id) : null;
    const trip = updateTrip(id, {
      status: typeof b.status === "string" ? b.status : undefined,
      orderNumber: str(b.orderNumber),
      price: typeof b.price === "number" || b.price === null ? (b.price as number | null) : undefined,
      klasse: b.klasse === 1 || b.klasse === 2 || b.klasse === null ? (b.klasse as number | null) : undefined,
      ticketType: str(b.ticketType),
      direction: b.direction === "outbound" || b.direction === "return" || b.direction === null ? (b.direction as string | null) : undefined,
      actualArrival: str(b.actualArrival),
      abortedAt: str(b.abortedAt),
      expectedDelayMin:
        b.expectedDelayMin === null || (typeof b.expectedDelayMin === "number" && Number.isFinite(b.expectedDelayMin))
          ? (b.expectedDelayMin as number | null)
          : undefined,
      returnedToStart: typeof b.returnedToStart === "boolean" ? b.returnedToStart : undefined,
      roundTrip: typeof b.roundTrip === "boolean" ? b.roundTrip : undefined,
      notes: str(b.notes),
      plan: b.plan === "take" || b.plan === "skip" || b.plan === null ? (b.plan as string | null) : undefined,
      ticket: current ? { ...(current.ticket ?? {}), directionPrice } : undefined,
    });
    return trip ? NextResponse.json({ trip }) : NextResponse.json({ error: "nicht gefunden" }, { status: 404 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  ensureReady();
  deleteTrip((await params).id);
  return NextResponse.json({ deleted: true });
}
