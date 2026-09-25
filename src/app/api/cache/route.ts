import { NextResponse } from "next/server";
import { db } from "@/db/client";
import {
  candidatePatterns,
  edgeTripPatterns,
  hubScores,
  journeyLegs,
  journeyQueries,
  journeys,
  longDistanceEdges,
  priceSnapshots,
  ticketOffers,
  tripPatternStops,
  tripPatterns,
} from "@/db/schema";
import { ensureReady } from "@/lib/bootstrap";
import { pruneCache } from "@/lib/cache/cache";

export const runtime = "nodejs";

export async function POST(req: Request) {
  ensureReady();
  const body = await req.json().catch(() => ({}));
  const action = body?.action;
  switch (action) {
    case "prune":
      return NextResponse.json({ ok: true, pruned: pruneCache() });
    case "clearPrices":
      db.delete(ticketOffers).run();
      db.delete(priceSnapshots).run();
      break;
    case "clearTimetable":
      db.delete(journeyLegs).run();
      db.delete(journeys).run();
      db.delete(journeyQueries).run();
      break;
    case "relearn":
      db.delete(edgeTripPatterns).run();
      db.delete(candidatePatterns).run();
      db.delete(longDistanceEdges).run();
      db.delete(tripPatternStops).run();
      db.delete(tripPatterns).run();
      db.delete(hubScores).run();
      break;
    case "clearAll":
      db.delete(journeyLegs).run();
      db.delete(journeys).run();
      db.delete(journeyQueries).run();
      db.delete(ticketOffers).run();
      db.delete(priceSnapshots).run();
      db.delete(edgeTripPatterns).run();
      db.delete(candidatePatterns).run();
      db.delete(longDistanceEdges).run();
      db.delete(tripPatternStops).run();
      db.delete(tripPatterns).run();
      db.delete(hubScores).run();
      pruneCache();
      break;
    default:
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
