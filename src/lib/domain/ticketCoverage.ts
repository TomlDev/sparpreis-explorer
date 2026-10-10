import type { NormJourney, NormLeg } from "@/lib/rail/types";
import { isLongDistanceProduct } from "./products";

// green = confirmed through-ticket, yellow = uncertain, red = partial fare,
// unpriced = schedule found but price not checked (MOTIS-only / pricing offline),
// none = provider explicitly returned no through-price.
export type Coverage = "green" | "yellow" | "red" | "unpriced" | "none";

export interface CoverageResult {
  coverage: Coverage;
  reason: string;
  isFullRoute: boolean;
  price: number | null;
  currency: string;
  klasse: number;
  offerFromName: string | null;
  offerToName: string | null;
  /** Legs the ticket doesn't cover (tram / bus before or after DB's tariff area). */
  uncoveredLegs?: number[];
}

const TRAIN = new Set(["nationalExpress", "national", "regionalExpress", "regional", "suburban"]);

/**
 * Which legs lie outside the ticket's span: before the leg leaving from its
 * start station and after the leg arriving at its end station. null when the
 * span's stations aren't in the journey at all.
 */
export function uncoveredLegs(legs: NormLeg[], from: string, to: string): number[] | null {
  // exact name first — the loose match would take "Essen Hbf" for "Essen-Steele"
  const exact = (a: string, b: string) => normStationName(a) === normStationName(b);
  const find = (match: (a: string, b: string) => boolean) => {
    const iStart = legs.findIndex((l) => !l.isWalking && match(l.origin.name, from));
    let iEnd = -1;
    for (let i = legs.length - 1; i >= 0; i--)
      if (!legs[i].isWalking && match(legs[i].destination.name, to)) {
        iEnd = i;
        break;
      }
    return { iStart, iEnd };
  };
  let { iStart, iEnd } = find(exact);
  if (iStart < 0 || iEnd < 0) ({ iStart, iEnd } = find(sameStation));
  if (iStart < 0 || iEnd < 0 || iEnd < iStart) return null;
  return legs.flatMap((l, i) => ((i < iStart || i > iEnd) && !l.isWalking ? [i] : []));
}

/** Normalize a station name for loose comparison. */
export function normStationName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/hauptbahnhof|hbf|bahnhof|bhf/g, "")
    .replace(/[^a-zäöüß0-9]+/g, " ")
    .trim();
}

function sameStation(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  const na = normStationName(a);
  const nb = normStationName(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

/** Looser relatedness: same station, or sharing a significant place token
 *  (e.g. "Triberg Bahnhof" vs "Triberg (Schwarzw)"). Used to verify a
 *  priced journey covers roughly the requested endpoints despite naming drift
 *  between the routing (MOTIS) and pricing (DB) providers. */
function stationsRelated(a?: string | null, b?: string | null): boolean {
  if (sameStation(a, b)) return true;
  const ta = new Set(normStationName(a || "").split(/\s+/).filter((t) => t.length >= 4));
  const tb = new Set(normStationName(b || "").split(/\s+/).filter((t) => t.length >= 4));
  for (const t of ta) if (tb.has(t)) return true;
  return false;
}

/**
 * Decide whether the priced offer actually covers the whole requested route.
 * This is the safety-critical part of the spec (green / yellow / red): a
 * partial-route price must never be shown as a full through-ticket.
 */
export function assessCoverage(
  journey: NormJourney,
  expected?: { fromName?: string; toName?: string },
  opts: { deutschlandTicket?: boolean } = {},
): CoverageResult {
  const price = journey.price;
  const legs = journey.legs;
  const journeyFrom = legs[0]?.origin.name;
  const journeyTo = legs[legs.length - 1]?.destination.name;

  // If we know which O→D was requested, the priced journey must actually start
  // and end there — otherwise the price could be for a deviating route.
  const endpointsMatchExpected =
    !expected ||
    ((!expected.fromName || stationsRelated(journeyFrom, expected.fromName)) &&
      (!expected.toName || stationsRelated(journeyTo, expected.toName)));

  if (!price || typeof price.amount !== "number") {
    return {
      coverage: "unpriced",
      reason: "Fahrplan gefunden – Preis derzeit nicht geprüft",
      isFullRoute: false,
      price: null,
      currency: "EUR",
      klasse: journey.ticketInfo?.klasse ?? 2,
      offerFromName: null,
      offerToName: null,
    };
  }

  const info = journey.ticketInfo;
  const offerFrom = info?.fromName ?? null;
  const offerTo = info?.toName ?? null;

  // Explicit signal from the provider that this is only a partial fare.
  if (price.fullRoute === false) {
    return {
      coverage: "red",
      reason: describePartial(offerFrom, offerTo),
      isFullRoute: false,
      price: price.amount,
      currency: price.currency,
      klasse: info?.klasse ?? 2,
      offerFromName: offerFrom,
      offerToName: offerTo,
    };
  }

  // If we know the offer endpoints, verify they match the journey endpoints.
  if (offerFrom && offerTo) {
    const startsOk = sameStation(offerFrom, journeyFrom);
    const endsOk = sameStation(offerTo, journeyTo);
    if (startsOk && endsOk) {
      return {
        coverage: "green",
        reason: "Durchgehendes Ticket bestätigt",
        isFullRoute: true,
        price: price.amount,
        currency: price.currency,
        klasse: info?.klasse ?? 2,
        offerFromName: offerFrom,
        offerToName: offerTo,
        uncoveredLegs: [],
      };
    }
    // A Teilpreis that only leaves out tram / bus at the ends is the normal ticket
    // (it covers every train); a train outside the span is not.
    const out = uncoveredLegs(legs, offerFrom, offerTo);
    const outside = (out ?? []).map((i) => legs[i]);
    const base = { price: price.amount, currency: price.currency, klasse: info?.klasse ?? 2, offerFromName: offerFrom, offerToName: offerTo, uncoveredLegs: out ?? undefined };
    // A train outside the span isn't covered: no ticket for the trip — unless it's a
    // regional train and the user has a Deutschlandticket.
    const trainsOut = outside.filter((l) => TRAIN.has(l.product ?? ""));
    if (out && !trainsOut.some((l) => isLongDistanceProduct(l.product)) && (!trainsOut.length || opts.deutschlandTicket)) {
      return {
        ...base,
        coverage: "green",
        reason: trainsOut.length
          ? `Ticket gilt ${offerFrom} → ${offerTo} – der Rest mit deinem Deutschlandticket`
          : `Ticket gilt ${offerFrom} → ${offerTo} – Straßenbahn/Bus davor/danach nicht enthalten`,
        isFullRoute: true,
      };
    }
    return { ...base, coverage: "red", reason: describePartial(offerFrom, offerTo), isFullRoute: false };
  }

  // Provider priced the through connection — but only trust it as green if the
  // journey actually starts/ends at the requested stations. A mismatch means we
  // priced a deviating route (e.g. wrong station resolved) -> don't claim green.
  if (price.fullRoute === true) {
    if (!endpointsMatchExpected) {
      return {
        coverage: "yellow",
        reason: "Preis bezieht sich evtl. auf abweichende Halte – bitte bei DB prüfen",
        isFullRoute: false,
        price: price.amount,
        currency: price.currency,
        klasse: info?.klasse ?? 2,
        offerFromName: journeyFrom ?? null,
        offerToName: journeyTo ?? null,
      };
    }
    return {
      coverage: "green",
      reason: "Durchgehendes Ticket bestätigt",
      isFullRoute: true,
      price: price.amount,
      currency: price.currency,
      klasse: info?.klasse ?? 2,
      offerFromName: journeyFrom ?? null,
      offerToName: journeyTo ?? null,
    };
  }

  // Price present but we can't prove coverage → be honest: uncertain (yellow).
  return {
    coverage: "yellow",
    reason: "Ticketabdeckung nicht eindeutig – bitte bei DB prüfen",
    isFullRoute: false,
    price: price.amount,
    currency: price.currency,
    klasse: info?.klasse ?? 2,
    offerFromName: offerFrom,
    offerToName: offerTo,
  };
}

function describePartial(from?: string | null, to?: string | null): string {
  if (from && to) return `Teilstreckenpreis (${from} → ${to})`;
  return "Teilstreckenpreis – deckt nicht die ganze Reise";
}
