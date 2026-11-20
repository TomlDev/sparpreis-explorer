import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/bootstrap";
import { tripStations } from "@/lib/trips/legStops";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** Every station on the booked trains, stops in between included (for "Abgebrochen in"). */
export async function GET(_req: Request, { params }: Ctx) {
  ensureReady();
  try {
    return NextResponse.json({ legs: await tripStations((await params).id) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
