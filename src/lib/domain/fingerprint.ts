import { createHash } from "node:crypto";
import type { NormJourney } from "@/lib/rail/types";

/**
 * Stable identity for a journey that ignores realtime delay (spec: "Realtime-
 * Verspätung NICHT in den Fingerprint aufnehmen"). Built from planned times,
 * leg order, train numbers and the leg endpoints.
 */
export function journeyFingerprint(journey: NormJourney): string {
  const parts: string[] = [];
  for (const leg of journey.legs) {
    parts.push(
      [
        leg.isWalking ? "walk" : leg.product ?? "?",
        leg.trainNumber ?? leg.lineName ?? "",
        leg.origin.id ?? leg.origin.name,
        leg.destination.id ?? leg.destination.name,
        leg.plannedDeparture ?? "",
        leg.plannedArrival ?? "",
      ].join("|"),
    );
  }
  return createHash("sha1").update(parts.join("#")).digest("hex").slice(0, 24);
}

/** Looser signature that ignores exact times — used for price history grouping
 *  of "the same connection" across days/searches. */
export function journeyRouteSignature(journey: NormJourney): string {
  const parts = journey.legs.map((leg) =>
    [
      leg.isWalking ? "walk" : leg.product ?? "?",
      leg.trainNumber ?? leg.lineName ?? "",
      leg.origin.name,
      leg.destination.name,
    ].join("|"),
  );
  return createHash("sha1").update(parts.join("#")).digest("hex").slice(0, 20);
}
