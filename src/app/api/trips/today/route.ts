import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/bootstrap";
import { currentTrips, legAt } from "@/lib/trips/repo";

export const runtime = "nodejs";

/** Today's trips + where in the trip we are right now (planned times). */
export async function GET() {
  ensureReady();
  const nowMs = Date.now();
  const trips = currentTrips(nowMs).map((t) => {
    const dep = t.plannedDeparture ? new Date(t.plannedDeparture).getTime() : null;
    const arr = t.plannedArrival ? new Date(t.plannedArrival).getTime() : null;
    const phase = dep && nowMs < dep ? "before" : arr && nowMs > arr + 30 * 60_000 ? "after" : "underway";
    const legIndex = phase === "underway" ? legAt(t.legs, nowMs) : null;
    const nextIndex = t.legs.findIndex(
      (l) => !l.isWalking && l.plannedDeparture && new Date(l.plannedDeparture).getTime() > nowMs,
    );
    return { trip: t, phase, legIndex, nextIndex: nextIndex >= 0 ? nextIndex : null };
  });
  return NextResponse.json({ now: nowMs, trips });
}
