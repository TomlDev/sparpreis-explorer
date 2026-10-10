import { now } from "@/db/util";
import type { SearchResult } from "@/lib/domain/result";
import { assessCoverage } from "@/lib/domain/ticketCoverage";
import { getPricingProvider } from "@/lib/rail/provider";
import { loadJourney, saveJourneyResult } from "@/lib/repo/journeys";
import { getPreferences } from "@/lib/repo/settings";

/**
 * Ask DB what the offer of a priced connection really covers ("Gilt nur für
 * Essen-Steele – Freiburg"): the trip's endpoints are often outside DB's tariff
 * area (tram / bus) — or a train is. Updates the result's coverage in place and
 * stores the span with the offer (checked once per connection and price).
 * One DB request; the caller counts it.
 */
export async function checkOfferSpan(r: SearchResult, travelDate: string, expected?: { fromName?: string; toName?: string }): Promise<boolean> {
  const pricing = getPricingProvider();
  if (!pricing || !r.refreshToken || r.coverage.price == null) return false;
  const prefs = getPreferences();
  const offer = await pricing.refreshJourney(r.refreshToken, {
    tickets: true,
    stopovers: false,
    bahncard: prefs.bahncard,
    klasse: prefs.klasse,
    deutschlandTicket: prefs.deutschlandTicket,
  });
  const span = offer.ticketInfo;
  const stored = loadJourney(r.fingerprint);
  if (!span?.fromName || !span.toName || !stored?.price) return false;
  stored.ticketInfo = { ...span, klasse: prefs.klasse };
  stored.price.spanChecked = true;
  // the offer details carry today's price of this very connection too
  if (typeof offer.price?.amount === "number") stored.price.amount = offer.price.amount;
  r.coverage = assessCoverage(stored, expected, { deutschlandTicket: prefs.deutschlandTicket });
  r.priceCheckedAt = now();
  saveJourneyResult(travelDate, pricing.name, stored, r);
  return true;
}
