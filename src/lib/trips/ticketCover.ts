import type { TripLeg } from "@/db/schema";
import { normStationName, sameStation } from "@/lib/domain/ticketCoverage";
import { isRailLeg } from "./rules";

/**
 * Which parts of a booked trip the ticket covers — from the span the booking
 * names ("Bochum+City → Freiburg(Brsg)Hbf", "Gilt nur für Essen-Steele – …").
 * "+City" is DB's City-Ticket: local transport (tram, bus, S-Bahn) in that city
 * is included — typically the tram to the station at the start.
 */
export type LegCover = "in" | "city" | "out" | "walk";

export interface TripCover {
  legs: LegCover[];
  from: string;
  to: string;
  /** City-Ticket included at the start / end (the city's name) */
  cityFrom: string | null;
  cityTo: string | null;
}

const CITY = /^(.*?)\s*\+\s*City$/i;

export function tripTicketCover(legs: TripLeg[], ticket: { from?: string | null; to?: string | null } | null | undefined): TripCover | null {
  if (!ticket?.from || !ticket.to) return null;
  const cityFrom = CITY.exec(ticket.from)?.[1]?.trim() ?? null;
  const cityTo = CITY.exec(ticket.to)?.[1]?.trim() ?? null;
  const from = cityFrom ?? ticket.from;
  const to = cityTo ?? ticket.to;
  // with a City-Ticket the span itself starts / ends at the city's railway station
  const okStart = (l: TripLeg) => !l.isWalking && (!cityFrom || isRailLeg(l));
  const okEnd = (l: TripLeg) => !l.isWalking && (!cityTo || isRailLeg(l));
  const find = (match: (a: string, b: string) => boolean) => {
    const s = legs.findIndex((l) => okStart(l) && match(l.fromName, from));
    let e = -1;
    for (let i = legs.length - 1; i >= 0; i--)
      if (okEnd(legs[i]) && match(legs[i].toName, to)) {
        e = i;
        break;
      }
    return [s, e] as const;
  };
  const exact = (a: string, b: string) => normStationName(a) === normStationName(b);
  let [s, e] = find(exact);
  if (s < 0 || e < 0) [s, e] = find(sameStation);
  if (s < 0 || e < 0 || e < s) return null;
  const inCity = (l: TripLeg, city: string | null) =>
    !!city && [l.fromName, l.toName].every((n) => normStationName(n).includes(normStationName(city)));
  return {
    legs: legs.map((l, i): LegCover => {
      if (l.isWalking) return "walk";
      if (i >= s && i <= e) return "in";
      if (i < s) return inCity(l, cityFrom) ? "city" : "out";
      return inCity(l, cityTo) ? "city" : "out";
    }),
    from,
    to,
    cityFrom,
    cityTo,
  };
}
