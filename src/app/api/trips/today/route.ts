import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/bootstrap";
import { tripForecast } from "@/lib/trips/forecast";
import { planStates } from "@/lib/trips/plan";
import { currentTrips, legAt } from "@/lib/trips/repo";

export const runtime = "nodejs";

/** Today's trips + where in the trip we are right now (planned times). */
export async function GET() {
  ensureReady();
  const nowMs = Date.now();
  const current = currentTrips(nowMs);
  // Not the spare of a double booking, nor one not taken (the live tracking still records it) —
  // unless the spare's Zugbindung just went: then its ticket is free for another train.
  const plans = planStates(current);
  const freed = (t: (typeof current)[number]) => t.status === "planned" && t.plan !== "take" && tripForecast(t.legs, t.reroute).level === "lifted";
  const trips = current.filter((t) => plans.get(t.id)?.state !== "skip" || freed(t)).map((t) => {
    const dep = t.plannedDeparture ? new Date(t.plannedDeparture).getTime() : null;
    const arr = t.plannedArrival ? new Date(t.plannedArrival).getTime() : null;
    // A train announced late is still under way after its planned arrival.
    const grace = Math.max(30, t.expectedDelayMin ?? 0, t.ticket?.scheduleChange ? 60 : 0) * 60_000;
    const phase = dep && nowMs < dep ? "before" : arr && nowMs > arr + grace ? "after" : "underway";
    const legIndex = phase === "underway" ? legAt(t.legs, nowMs) : null;
    const nextIndex = t.legs.findIndex(
      (l) => !l.isWalking && l.plannedDeparture && new Date(l.plannedDeparture).getTime() > nowMs,
    );
    return { trip: t, phase, legIndex, nextIndex: nextIndex >= 0 ? nextIndex : null };
  });
  return NextResponse.json({ now: nowMs, trips });
}
