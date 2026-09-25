import type { NormJourney, NormLeg } from "@/lib/rail/types";
import { minutesBetween } from "@/lib/time";
import { isLongDistanceLeg, legStopCount } from "./products";

export interface JourneyMetrics {
  originName: string;
  originId?: string;
  destinationName: string;
  destinationId?: string;
  plannedDeparture: string | null;
  plannedArrival: string | null;
  durationMin: number;
  transfers: number;
  fvMinutes: number;
  fvStops: number;
  fvLegs: number;
  fvPercent: number;
  minTransferMin: number | null;
  maxTransferMin: number | null;
  /** the ride legs (non-walking) in order */
  rideLegs: NormLeg[];
  /** the long-distance legs in order */
  longDistanceLegs: NormLeg[];
}

export function analyzeJourney(journey: NormJourney): JourneyMetrics {
  const legs = journey.legs;
  const first = legs[0];
  const last = legs[legs.length - 1];
  const rideLegs = legs.filter((l) => !l.isWalking);
  const longDistanceLegs = legs.filter(isLongDistanceLeg);

  const plannedDeparture = first?.plannedDeparture ?? first?.departure ?? null;
  const plannedArrival = last?.plannedArrival ?? last?.arrival ?? null;
  const durationMin = minutesBetween(plannedDeparture, plannedArrival);

  let fvMinutes = 0;
  let fvStops = 0;
  for (const l of longDistanceLegs) {
    fvMinutes += minutesBetween(
      l.plannedDeparture ?? l.departure,
      l.plannedArrival ?? l.arrival,
    );
    fvStops += legStopCount(l) + 1; // intermediate stops + the alighting stop
  }

  // Transfer gaps between consecutive ride legs.
  const transferMins: number[] = [];
  for (let i = 0; i < rideLegs.length - 1; i++) {
    const gap = minutesBetween(
      rideLegs[i].plannedArrival ?? rideLegs[i].arrival,
      rideLegs[i + 1].plannedDeparture ?? rideLegs[i + 1].departure,
    );
    if (gap >= 0) transferMins.push(gap);
  }

  const transfers = Math.max(0, rideLegs.length - 1);
  const fvPercent = durationMin > 0 ? (fvMinutes / durationMin) * 100 : 0;

  return {
    originName: first?.origin.name ?? "?",
    originId: first?.origin.id,
    destinationName: last?.destination.name ?? "?",
    destinationId: last?.destination.id,
    plannedDeparture,
    plannedArrival,
    durationMin,
    transfers,
    fvMinutes,
    fvStops,
    fvLegs: longDistanceLegs.length,
    fvPercent: Math.round(fvPercent * 10) / 10,
    minTransferMin: transferMins.length ? Math.min(...transferMins) : null,
    maxTransferMin: transferMins.length ? Math.max(...transferMins) : null,
    rideLegs,
    longDistanceLegs,
  };
}
