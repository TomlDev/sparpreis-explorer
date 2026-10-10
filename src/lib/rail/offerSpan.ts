/**
 * Where a DB ticket is valid. bahn.de prices trips from a tram / bus stop as a
 * "Teilpreis": the ticket starts at the first station in DB's tariff (e.g.
 * "Gilt nur für Essen-Steele – Triberg"). Only the offer details
 * (refreshJourney) carry it: reiseAngebote[].hinfahrt.fahrtAngebote[]
 * .teilpreisDetails.intervallPreis.haltIntervall.
 */

export interface OfferSpan {
  fromName: string;
  toName: string;
}

type Raw = Record<string, unknown>;

/** Span of the offer that matches the shown price (else the first one with a span). */
export function offerSpanOf(raw: unknown): OfferSpan | null {
  const v = raw as Raw | null;
  if (!v || typeof v !== "object") return null;
  const shown = (v.angebotsPreis as { betrag?: number } | undefined)?.betrag;
  const spans: { price?: number; span: OfferSpan }[] = [];
  for (const ra of (v.reiseAngebote as Raw[] | undefined) ?? []) {
    for (const fa of ((ra.hinfahrt as Raw | undefined)?.fahrtAngebote as Raw[] | undefined) ?? []) {
      const h = ((fa.teilpreisDetails as Raw | undefined)?.intervallPreis as Raw | undefined)?.haltIntervall as
        | { abfahrtHalt?: { name?: string }; ankunftHalt?: { name?: string } }
        | undefined;
      const from = h?.abfahrtHalt?.name;
      const to = h?.ankunftHalt?.name;
      if (from && to) spans.push({ price: (fa.preis as { betrag?: number } | undefined)?.betrag, span: { fromName: from, toName: to } });
    }
  }
  if (!spans.length) return null;
  return (spans.find((s) => shown != null && s.price === shown) ?? spans[0]).span;
}

/** Make a db-vendo profile attach `ticketSpan` to every parsed journey. Call before createClient. */
export async function withOfferSpan(profile: unknown): Promise<void> {
  const { parseJourney } = await import("db-vendo-client/parse/journey.js");
  (profile as { parseJourney: unknown }).parseJourney = (ctx: unknown, raw: unknown) => {
    const j = parseJourney(ctx, raw) as Record<string, unknown>;
    const span = offerSpanOf(raw);
    if (span) j.ticketSpan = span;
    return j;
  };
}
