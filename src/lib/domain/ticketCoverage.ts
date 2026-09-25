import type { NormJourney } from "@/lib/rail/types";

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
      };
    }
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
