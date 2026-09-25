import { desc } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import {
  candidatePatterns,
  journeyQueries,
  journeys,
  locations,
  longDistanceEdges,
  priceSnapshots,
  searchRuns,
  tripPatterns,
} from "@/db/schema";
import { ensureReady } from "@/lib/bootstrap";
import { providerStatuses } from "@/lib/rail/provider";
import { getInterestingEdges, getHubs } from "@/lib/engine/patterns";
import { explorationEpsilon } from "@/lib/engine/strategy";
import {
  decisionReasonCounts,
  recentDecisions,
  segmentSummary,
  totalDecisions,
} from "@/lib/repo/decisions";

export const runtime = "nodejs";

export async function GET() {
  ensureReady();
  const counts = {
    locations: db.select().from(locations).all().length,
    tripPatterns: db.select().from(tripPatterns).all().length,
    longDistanceEdges: db.select().from(longDistanceEdges).all().length,
    journeyQueries: db.select().from(journeyQueries).all().length,
    journeys: db.select().from(journeys).all().length,
    priceSnapshots: db.select().from(priceSnapshots).all().length,
    candidatePatterns: db.select().from(candidatePatterns).all().length,
  };

  const edges = getInterestingEdges(20);
  const hubs = getHubs(15);
  const runs = db
    .select()
    .from(searchRuns)
    .orderBy(desc(searchRuns.startedAt))
    .limit(10)
    .all();

  const total = totalDecisions();
  const strategy = {
    totalDecisions: total,
    epsilon: explorationEpsilon(total),
    reasons: decisionReasonCounts(),
    topSegments: segmentSummary(15),
    recent: recentDecisions(25),
  };

  return NextResponse.json({
    counts,
    providers: providerStatuses(),
    edges,
    hubs,
    runs,
    strategy,
  });
}
