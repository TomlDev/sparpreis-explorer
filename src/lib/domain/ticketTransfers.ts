import { minutesBetween } from "@/lib/time";
import type { LegView, SearchResult } from "./result";

export interface UnprotectedTransfer {
  /** Where you change. */
  station: string;
  /** Buffer after the walk between the two rides. */
  minutes: number;
  /** before the ticket starts (missing it can cost the ticket) or after it ends */
  where: "before" | "after";
  /** Product of the ride you arrive with (its punctuality decides the risk). */
  product?: string;
  /** Tight for that kind of transport (see RISKY_BELOW). */
  risky: boolean;
}

/**
 * Below how many minutes of buffer a transfer is risky, by the arriving ride.
 * DB's open data has no delays for trams and buses — trams / U-Bahn mostly run
 * on their own track and are punctual, buses share the road.
 */
export const RISKY_BELOW: Record<string, number> = { tram: 3, subway: 3, bus: 7, ferry: 7, taxi: 7 };
const riskyBelow = (product?: string) => RISKY_BELOW[product ?? ""] ?? 10;

export interface TicketTransfers {
  /** Tightest transfer between legs the ticket covers (null: none). */
  minCovered: number | null;
  unprotected: UnprotectedTransfer[];
}

/**
 * Transfers inside the ticket vs. outside it. A tram / bus before DB's tariff
 * area isn't part of the ticket: a delay there doesn't lift the Zugbindung —
 * missing the first train of the ticket can mean buying a new one.
 */
export function ticketTransfers(legs: LegView[], uncovered?: number[]): TicketTransfers {
  const out = new Set(uncovered ?? []);
  const ride = legs.map((l, i) => ({ l, i })).filter(({ l }) => !l.isWalking);
  const firstCovered = ride.find(({ i }) => !out.has(i))?.i ?? Infinity;
  let minCovered: number | null = null;
  const unprotected: UnprotectedTransfer[] = [];
  for (let k = 0; k + 1 < ride.length; k++) {
    const a = ride[k];
    const b = ride[k + 1];
    // the walk in between eats into the transfer time
    const walk = legs.slice(a.i + 1, b.i).reduce((sum, l) => sum + (l.isWalking ? l.durationMin : 0), 0);
    const gap = minutesBetween(a.l.plannedArrival, b.l.plannedDeparture) - walk;
    if (gap < -walk) continue;
    if (out.has(a.i) || out.has(b.i))
      unprotected.push({
        station: a.l.toName,
        minutes: gap,
        where: b.i <= firstCovered ? "before" : "after",
        product: a.l.product,
        risky: gap < riskyBelow(a.l.product),
      });
    else minCovered = minCovered == null ? gap : Math.min(minCovered, gap);
  }
  return { minCovered, unprotected };
}

/** The transfer that matters for the ticket: inside its span when the span is known. */
export function effectiveMinTransfer(r: Pick<SearchResult, "legs" | "coverage" | "metrics">): number | null {
  return r.coverage.uncoveredLegs?.length ? ticketTransfers(r.legs, r.coverage.uncoveredLegs).minCovered : r.metrics.minTransferMin;
}
