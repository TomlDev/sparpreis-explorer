import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  candidatePatterns,
  hubScores,
  longDistanceEdges,
  tripPatternStops,
  tripPatterns,
} from "@/db/schema";
import { newId, now } from "@/db/util";
import { normStationName } from "@/lib/domain/ticketCoverage";
import type { NormJourney, NormLeg } from "@/lib/rail/types";
import { isLongDistanceLeg, legStopCount } from "@/lib/domain/products";
import { minutesBetween } from "@/lib/time";
import type { SearchResult } from "@/lib/domain/result";

function edgeSignature(fromName: string, toName: string, product: string): string {
  return `${normStationName(fromName)}>${normStationName(toName)}>${product}`;
}

function upsertEdge(
  fromName: string,
  fromId: string | undefined,
  toName: string,
  toId: string | undefined,
  product: string,
  durationMin: number,
  stopsBetween: number,
): string {
  const sig = edgeSignature(fromName, toName, product);
  const ts = now();
  const existing = db
    .select()
    .from(longDistanceEdges)
    .where(eq(longDistanceEdges.signature, sig))
    .get();
  if (existing) {
    db.update(longDistanceEdges)
      .set({
        lastSeen: ts,
        timesSeen: existing.timesSeen + 1,
        // Smooth typical duration.
        typicalDurationMin: Math.round(
          (existing.typicalDurationMin * existing.timesSeen + durationMin) /
            (existing.timesSeen + 1),
        ),
        fromLocationId: existing.fromLocationId ?? fromId ?? null,
        toLocationId: existing.toLocationId ?? toId ?? null,
      })
      .where(eq(longDistanceEdges.id, existing.id))
      .run();
    return existing.id;
  }
  const id = newId("lde");
  db.insert(longDistanceEdges)
    .values({
      id,
      signature: sig,
      fromLocationId: fromId ?? null,
      fromName,
      toLocationId: toId ?? null,
      toName,
      product,
      typicalDurationMin: durationMin,
      stopsBetween,
      timesSeen: 1,
      firstSeen: ts,
      lastSeen: ts,
    })
    .run();
  return id;
}

function upsertTripPattern(leg: NormLeg): void {
  if (!leg.trainNumber && !leg.lineName) return;
  const stops =
    leg.stopovers && leg.stopovers.length >= 2
      ? leg.stopovers
      : [
          { name: leg.origin.name, id: leg.origin.id, plannedDeparture: leg.plannedDeparture },
          { name: leg.destination.name, id: leg.destination.id, plannedArrival: leg.plannedArrival },
        ];
  const sig = `${leg.product}:${leg.trainNumber ?? leg.lineName}:${stops
    .map((s) => normStationName(s.name))
    .join(">")}`;
  const ts = now();
  const existing = db
    .select()
    .from(tripPatterns)
    .where(eq(tripPatterns.signature, sig))
    .get();
  if (existing) {
    db.update(tripPatterns)
      .set({ lastSeen: ts, timesSeen: existing.timesSeen + 1 })
      .where(eq(tripPatterns.id, existing.id))
      .run();
    return;
  }
  const id = newId("tp");
  db.insert(tripPatterns)
    .values({
      id,
      signature: sig,
      product: leg.product ?? "unknown",
      lineName: leg.lineName ?? null,
      trainNumber: leg.trainNumber ?? null,
      operator: leg.operator ?? null,
      firstSeen: ts,
      lastSeen: ts,
      timesSeen: 1,
    })
    .run();
  const firstDep = stops[0]?.plannedDeparture ?? null;
  stops.forEach((st, i) => {
    db.insert(tripPatternStops)
      .values({
        id: newId("tps"),
        patternId: id,
        seq: i,
        locationId: st.id ?? null,
        stationName: st.name,
        depOffsetMin: st.plannedDeparture ? minutesBetween(firstDep, st.plannedDeparture) : null,
        arrOffsetMin: st.plannedArrival ? minutesBetween(firstDep, st.plannedArrival) : null,
      })
      .run();
  });
}

function bumpHub(name: string, id: string | undefined, opts: { fv?: boolean; cheap?: boolean }): void {
  const ts = now();
  const existing = db
    .select()
    .from(hubScores)
    .where(eq(hubScores.stationName, name))
    .get();
  if (existing) {
    const appearances = existing.appearances + 1;
    const fv = existing.longDistanceConnections + (opts.fv ? 1 : 0);
    const cheap = existing.successfulCheapRoutes + (opts.cheap ? 1 : 0);
    db.update(hubScores)
      .set({
        appearances,
        longDistanceConnections: fv,
        successfulCheapRoutes: cheap,
        locationId: existing.locationId ?? id ?? null,
        score: appearances + fv * 2 + cheap * 5,
        updatedAt: ts,
      })
      .where(eq(hubScores.id, existing.id))
      .run();
  } else {
    db.insert(hubScores)
      .values({
        id: newId("hub"),
        locationId: id ?? null,
        stationName: name,
        appearances: 1,
        successfulCheapRoutes: opts.cheap ? 1 : 0,
        longDistanceConnections: opts.fv ? 1 : 0,
        score: 1 + (opts.fv ? 2 : 0) + (opts.cheap ? 5 : 0),
        updatedAt: ts,
      })
      .run();
  }
}

function bumpCandidate(edgeId: string, result: SearchResult): void {
  const ts = now();
  const price = result.coverage.price;
  const success = result.coverage.coverage === "green" && price != null;
  const existing = db
    .select()
    .from(candidatePatterns)
    .where(eq(candidatePatterns.edgeId, edgeId))
    .get();
  if (existing) {
    const searches = existing.numberOfSearches + 1;
    const succ = existing.numberOfSuccessfulJourneys + (success ? 1 : 0);
    const lowest =
      price != null
        ? Math.min(existing.lowestObservedPrice ?? Infinity, price)
        : existing.lowestObservedPrice;
    const avg =
      price != null
        ? ((existing.averagePrice ?? price) * (existing.numberOfSuccessfulJourneys || 1) + price) /
          ((existing.numberOfSuccessfulJourneys || 1) + 1)
        : existing.averagePrice;
    db.update(candidatePatterns)
      .set({
        numberOfSearches: searches,
        numberOfSuccessfulJourneys: succ,
        lowestObservedPrice: lowest === Infinity ? null : lowest,
        averagePrice: avg,
        lastSuccessfulDate: success ? new Date().toISOString().slice(0, 10) : existing.lastSuccessfulDate,
        score: succ * 10 - (lowest && lowest !== Infinity ? lowest / 10 : 0),
        updatedAt: ts,
      })
      .where(eq(candidatePatterns.id, existing.id))
      .run();
  } else {
    db.insert(candidatePatterns)
      .values({
        id: newId("cp"),
        edgeId,
        numberOfSearches: 1,
        numberOfSuccessfulJourneys: success ? 1 : 0,
        lowestObservedPrice: price ?? null,
        averagePrice: price ?? null,
        lastSuccessfulDate: success ? new Date().toISOString().slice(0, 10) : null,
        score: success ? 10 - (price ?? 0) / 10 : 0,
        updatedAt: ts,
      })
      .run();
  }
}

/** Extract long-term route knowledge from a concrete journey. */
export function learnFromJourney(journey: NormJourney, result: SearchResult): void {
  const cheap = result.coverage.coverage === "green" && (result.coverage.price ?? 999) < 40;

  db.transaction(() => {
    const rideLegs = journey.legs.filter((l) => !l.isWalking);
    rideLegs.forEach((leg, idx) => {
      if (isLongDistanceLeg(leg)) {
        const dur = minutesBetween(
          leg.plannedDeparture ?? leg.departure,
          leg.plannedArrival ?? leg.arrival,
        );
        const edgeId = upsertEdge(
          leg.origin.name,
          leg.origin.id,
          leg.destination.name,
          leg.destination.id,
          leg.product!,
          dur,
          legStopCount(leg),
        );
        bumpCandidate(edgeId, result);

        // Granular edges between adjacent stopovers (the mine-able graph).
        if (leg.stopovers && leg.stopovers.length >= 2) {
          for (let i = 0; i < leg.stopovers.length - 1; i++) {
            const a = leg.stopovers[i];
            const b = leg.stopovers[i + 1];
            const d = minutesBetween(a.plannedDeparture, b.plannedArrival);
            if (d > 0) upsertEdge(a.name, a.id, b.name, b.id, leg.product!, d, 0);
          }
        }
        upsertTripPattern(leg);
      }
      // Transfer hub = where you change to the next ride leg.
      if (idx < rideLegs.length - 1) {
        bumpHub(leg.destination.name, leg.destination.id, {
          fv: isLongDistanceLeg(leg) || isLongDistanceLeg(rideLegs[idx + 1]),
          cheap,
        });
      }
    });
  });
}

// ---- readers used by candidate generation ----

export interface EdgeRow {
  id: string;
  fromName: string;
  fromLocationId: string | null;
  toName: string;
  toLocationId: string | null;
  product: string;
  typicalDurationMin: number;
  stopsBetween: number;
  timesSeen: number;
}

/** Known short FV edges, ordered by "interestingness": historically cheap
 *  candidates first, then short (few stops, short duration). Sorted in JS to
 *  keep the correlated candidate score portable across SQLite. */
export function getInterestingEdges(limit = 40): EdgeRow[] {
  const rows = db
    .select({
      id: longDistanceEdges.id,
      fromName: longDistanceEdges.fromName,
      fromLocationId: longDistanceEdges.fromLocationId,
      toName: longDistanceEdges.toName,
      toLocationId: longDistanceEdges.toLocationId,
      product: longDistanceEdges.product,
      typicalDurationMin: longDistanceEdges.typicalDurationMin,
      stopsBetween: longDistanceEdges.stopsBetween,
      timesSeen: longDistanceEdges.timesSeen,
      candScore: sql<number>`coalesce((select ${candidatePatterns.score} from ${candidatePatterns} where ${candidatePatterns.edgeId} = ${longDistanceEdges.id}), 0)`,
    })
    .from(longDistanceEdges)
    .all();
  rows.sort(
    (a, b) =>
      (b.candScore ?? 0) - (a.candScore ?? 0) ||
      a.stopsBetween - b.stopsBetween ||
      a.typicalDurationMin - b.typicalDurationMin,
  );
  return rows.slice(0, limit).map(({ candScore: _c, ...r }) => r);
}

export function getHubs(limit = 20) {
  return db.select().from(hubScores).orderBy(desc(hubScores.score)).limit(limit).all();
}
