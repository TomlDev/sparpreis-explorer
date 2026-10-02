import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { claims, trips } from "@/db/schema";
import { ensureReady } from "@/lib/bootstrap";

export const runtime = "nodejs";

/** All passenger-rights claims with their trip — for the overview on /reisen. */
export async function GET() {
  ensureReady();
  const rows = db
    .select({ claim: claims, trip: { id: trips.id, date: trips.date, originName: trips.originName, destName: trips.destName } })
    .from(claims)
    .innerJoin(trips, eq(claims.tripId, trips.id))
    .orderBy(desc(trips.date))
    .all();
  const paid = rows.filter((r) => r.claim.status === "paid");
  return NextResponse.json({
    paidTotal: Math.round(paid.reduce((s, r) => s + (r.claim.paidAmount ?? 0), 0) * 100) / 100,
    paidCount: paid.length,
    pending: rows.filter((r) => r.claim.status === "submitted").length,
    drafts: rows.filter((r) => r.claim.status === "draft").length,
    rejected: rows.filter((r) => r.claim.status === "rejected").length,
    claims: rows.map((r) => ({
      id: r.claim.id,
      caseId: r.claim.caseId,
      status: r.claim.status,
      paidAmount: r.claim.paidAmount,
      amount: r.claim.amount,
      tripId: r.trip.id,
      date: r.trip.date,
      route: `${r.trip.originName} → ${r.trip.destName}`,
    })),
  });
}
