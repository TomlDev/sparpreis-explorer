import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import {
  journeyLegs,
  journeys,
  priceSnapshots,
  ticketOffers,
} from "@/db/schema";
import { newId, now } from "@/db/util";
import { TTL } from "@/lib/config";
import type { NormJourney, NormLeg } from "@/lib/rail/types";
import { buildResult, isOriginalKind, type ResultKind, type SearchResult } from "@/lib/domain/result";
import { isLongDistanceLeg, legStopCount } from "@/lib/domain/products";

/** Persist a journey (dedup by fingerprint), its legs, the ticket offer and a
 *  price snapshot. Idempotent per fingerprint. */
export function saveJourneyResult(
  travelDate: string,
  provider: string,
  journey: NormJourney,
  result: SearchResult,
): void {
  const ts = now();
  const fp = result.fingerprint;
  const m = result.metrics;

  db.transaction((tx) => {
    const existing = tx
      .select({ id: journeys.id, resultKind: journeys.resultKind })
      .from(journeys)
      .where(eq(journeys.fingerprint, fp))
      .get();

    let journeyId: string;
    if (existing) {
      journeyId = existing.id;
      // Same fingerprint = same trains. Once DB proposed it in a plain search it
      // stays "original", even if a constructed search re-finds it later.
      const resultKind =
        isOriginalKind(existing.resultKind) && !isOriginalKind(result.resultKind)
          ? existing.resultKind
          : result.resultKind;
      tx.update(journeys)
        .set({ lastSeen: ts, refreshToken: journey.refreshToken ?? null, resultKind })
        .where(eq(journeys.id, journeyId))
        .run();
    } else {
      journeyId = newId("j");
      tx.insert(journeys)
        .values({
          id: journeyId,
          fingerprint: fp,
          provider,
          originId: m.originId ?? null,
          originName: m.originName,
          destinationId: m.destinationId ?? null,
          destinationName: m.destinationName,
          travelDate,
          plannedDeparture: m.plannedDeparture ?? "",
          plannedArrival: m.plannedArrival ?? "",
          durationMin: m.durationMin,
          transfers: m.transfers,
          fvMinutes: m.fvMinutes,
          fvStops: m.fvStops,
          fvLegs: m.fvLegs,
          minTransferMin: m.minTransferMin ?? null,
          maxTransferMin: m.maxTransferMin ?? null,
          deviationMin: 0,
          legsJson: journey.legs,
          refreshToken: journey.refreshToken ?? null,
          resultKind: result.resultKind,
          firstSeen: ts,
          lastSeen: ts,
        })
        .run();

      journey.legs.forEach((leg: NormLeg, i) => {
        tx.insert(journeyLegs)
          .values({
            id: newId("jl"),
            journeyId,
            seq: i,
            product: leg.product ?? null,
            lineName: leg.lineName ?? null,
            trainNumber: leg.trainNumber ?? null,
            originId: leg.origin.id ?? null,
            originName: leg.origin.name,
            destId: leg.destination.id ?? null,
            destName: leg.destination.name,
            plannedDep: leg.plannedDeparture ?? null,
            plannedArr: leg.plannedArrival ?? null,
            durationMin: null,
            isLongDistance: isLongDistanceLeg(leg),
            isWalking: leg.isWalking,
            stopsCount: legStopCount(leg),
          })
          .run();
      });
    }

    // Ticket offer (always insert a fresh assessment).
    const c = result.coverage;
    if (c.price != null || c.coverage === "none") {
      tx.insert(ticketOffers)
        .values({
          id: newId("to"),
          journeyFingerprint: fp,
          price: c.price,
          currency: c.currency,
          klasse: c.klasse,
          coverage: c.coverage,
          coverageReason: c.reason,
          isFullRoute: c.isFullRoute,
          offerFromName: c.offerFromName ?? null,
          offerToName: c.offerToName ?? null,
          raw: journey.price ?? null,
          source: provider,
          fetchedAt: ts,
          validUntil: ts + TTL.price,
        })
        .run();

      if (c.price != null) {
        tx.insert(priceSnapshots)
          .values({
            id: newId("ps"),
            journeyFingerprint: fp,
            travelDate,
            price: c.price,
            currency: c.currency,
            coverage: c.coverage,
            observedAt: ts,
          })
          .run();
      }
    }
  });
}

/** Reconstruct a NormJourney from stored legs + latest offer. */
export function loadJourney(fp: string): NormJourney | null {
  const row = db.select().from(journeys).where(eq(journeys.fingerprint, fp)).get();
  if (!row) return null;
  const offer = latestOffer(fp);
  const legs = row.legsJson as NormLeg[];
  return {
    legs,
    refreshToken: row.refreshToken ?? null,
    price:
      offer && offer.price != null
        ? {
            amount: offer.price,
            currency: offer.currency,
            fullRoute: offer.isFullRoute,
            hint: null,
          }
        : null,
    ticketInfo:
      offer && (offer.offerFromName || offer.offerToName)
        ? {
            fromName: offer.offerFromName ?? undefined,
            toName: offer.offerToName ?? undefined,
            klasse: offer.klasse,
          }
        : null,
  };
}

export function latestOffer(fp: string) {
  return db
    .select()
    .from(ticketOffers)
    .where(eq(ticketOffers.journeyFingerprint, fp))
    .orderBy(desc(ticketOffers.fetchedAt))
    .get();
}

/** Load stored journeys as SearchResults (for the stale-while-revalidate path). */
export function loadResults(fps: string[]): SearchResult[] {
  if (fps.length === 0) return [];
  const rows = db.select().from(journeys).where(inArray(journeys.fingerprint, fps)).all();
  const byFp = new Map(rows.map((r) => [r.fingerprint, r]));
  const out: SearchResult[] = [];
  for (const fp of fps) {
    const row = byFp.get(fp);
    if (!row) continue;
    const journey = loadJourney(fp);
    if (!journey) continue;
    const offer = latestOffer(fp);
    out.push(
      buildResult(journey, {
        source: "cache",
        priceCheckedAt: offer?.fetchedAt ?? null,
        timetableAt: row.lastSeen,
        // Rows from before result_kind existed are unknown — never claim them
        // as DB originals; a plain search re-finding them upgrades them.
        resultKind: (row.resultKind as ResultKind | null) ?? "alternative",
      }),
    );
  }
  return out;
}

export function priceHistory(fp: string, limit = 30) {
  return db
    .select()
    .from(priceSnapshots)
    .where(eq(priceSnapshots.journeyFingerprint, fp))
    .orderBy(desc(priceSnapshots.observedAt))
    .limit(limit)
    .all();
}

export function findFingerprintByRouteSignature(
  _sig: string,
): string | null {
  // Route signature is recomputed on read; kept for future cross-day linking.
  return null;
}

export { and };
