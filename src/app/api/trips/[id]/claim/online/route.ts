import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/bootstrap";
import { submitClaimOnline } from "@/lib/trips/dbClaim";
import { getTrip } from "@/lib/trips/repo";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** Submit the passenger-rights claim through the DB customer account (after the user confirmed). */
export async function POST(req: Request, { params }: Ctx) {
  ensureReady();
  const id = (await params).id;
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (b.confirm !== true) return NextResponse.json({ error: "Bestätigung fehlt" }, { status: 400 });
  try {
    const claim = await submitClaimOnline(id, { returnUnused: typeof b.returnUnused === "boolean" ? b.returnUnused : undefined });
    return NextResponse.json({ claim, trip: getTrip(id) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
