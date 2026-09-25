import { desc, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { priceDecisions } from "@/db/schema";
import { newId, now } from "@/db/util";
import { normStationName } from "@/lib/domain/ticketCoverage";
import type { FvSegment } from "@/lib/domain/result";

export function segmentSignature(seg: { fromName: string; toName: string; product: string }): string {
  return `${normStationName(seg.fromName)}>${normStationName(seg.toName)}>${seg.product}`;
}

export function totalDecisions(): number {
  const r = db.select({ c: sql<number>`count(*)` }).from(priceDecisions).get();
  return r?.c ?? 0;
}

/** How often each segment has been priced (for the explore bias). */
export function observationCounts(): Map<string, number> {
  const rows = db
    .select({ sig: priceDecisions.segmentSignature, c: sql<number>`count(*)` })
    .from(priceDecisions)
    .groupBy(priceDecisions.segmentSignature)
    .all();
  return new Map(rows.map((r) => [r.sig, r.c]));
}

export interface LogDecisionInput {
  searchRunId: string | null;
  travelDate: string;
  segment: FvSegment;
  reason: "exploit" | "explore";
  exploitRank: number;
  epsilon: number;
  observedPrice: number | null;
  coverage: string;
  currency?: string;
}

export function logDecision(i: LogDecisionInput): void {
  db.insert(priceDecisions)
    .values({
      id: newId("pd"),
      searchRunId: i.searchRunId,
      travelDate: i.travelDate,
      viaName: i.segment.fromName,
      segmentSignature: segmentSignature(i.segment),
      fromName: i.segment.fromName,
      toName: i.segment.toName,
      product: i.segment.product,
      fvMinutes: i.segment.minutes,
      fvStops: i.segment.stops,
      reason: i.reason,
      exploitRank: i.exploitRank,
      epsilon: i.epsilon,
      observedPrice: i.observedPrice,
      coverage: i.coverage,
      currency: i.currency ?? "EUR",
      createdAt: now(),
    })
    .run();
}

export function recentDecisions(limit = 40) {
  return db.select().from(priceDecisions).orderBy(desc(priceDecisions.createdAt)).limit(limit).all();
}

/** Per-segment performance summary, best (cheapest green) first. */
export function segmentSummary(limit = 20) {
  return db
    .select({
      segmentSignature: priceDecisions.segmentSignature,
      fromName: sql<string>`max(${priceDecisions.fromName})`,
      toName: sql<string>`max(${priceDecisions.toName})`,
      product: sql<string>`max(${priceDecisions.product})`,
      fvMinutes: sql<number>`min(${priceDecisions.fvMinutes})`,
      fvStops: sql<number>`min(${priceDecisions.fvStops})`,
      tries: sql<number>`count(*)`,
      greens: sql<number>`sum(case when ${priceDecisions.coverage} = 'green' then 1 else 0 end)`,
      bestPrice: sql<number | null>`min(${priceDecisions.observedPrice})`,
      exploreCount: sql<number>`sum(case when ${priceDecisions.reason} = 'explore' then 1 else 0 end)`,
    })
    .from(priceDecisions)
    .groupBy(priceDecisions.segmentSignature)
    .orderBy(sql`min(${priceDecisions.observedPrice}) asc nulls last`)
    .limit(limit)
    .all();
}

export function decisionReasonCounts(): { exploit: number; explore: number } {
  const rows = db
    .select({ reason: priceDecisions.reason, c: sql<number>`count(*)` })
    .from(priceDecisions)
    .groupBy(priceDecisions.reason)
    .all();
  const out = { exploit: 0, explore: 0 };
  for (const r of rows) {
    if (r.reason === "exploit") out.exploit = r.c;
    else if (r.reason === "explore") out.explore = r.c;
  }
  return out;
}
