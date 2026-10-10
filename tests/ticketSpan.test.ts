import { describe, expect, it } from "vitest";
import { assessCoverage, uncoveredLegs } from "@/lib/domain/ticketCoverage";
import { ticketTransfers } from "@/lib/domain/ticketTransfers";
import { legViews } from "@/lib/domain/result";
import { offerSpanOf } from "@/lib/rail/offerSpan";
import type { NormJourney, NormLeg } from "@/lib/rail/types";

const leg = (product: string, line: string, from: string, to: string, dep: string, arr: string): NormLeg => ({
  product,
  lineName: line,
  origin: { name: from },
  destination: { name: to },
  plannedDeparture: `2026-10-15T${dep}:00+02:00`,
  plannedArrival: `2026-10-15T${arr}:00+02:00`,
  isWalking: false,
});
// shape of the booked 25,49 € trip: tram + bus to Essen-Steele, trains, buses at the end
const legs = [
  leg("tram", "STR 301", "Musterplatz, Bochum", "Hauptbahnhof, Bochum", "06:27", "06:40"),
  leg("bus", "Bus 194", "Hauptbahnhof, Bochum", "Steele S-Bahnhof, Essen (Ruhr)", "06:45", "07:12"),
  leg("regional", "RE 30292", "Essen-Steele", "Köln Hbf", "07:16", "08:20"),
  leg("national", "IC 1940", "Köln Hbf", "Mannheim Hbf", "08:35", "10:59"),
  leg("regional", "RE 4727", "Mannheim Hbf", "Triberg", "11:10", "14:02"),
  leg("bus", "Bus 550", "Triberg", "Marktplatz, Triberg im Schwarzwald", "14:10", "14:45"),
  leg("bus", "Bus 240", "Marktplatz, Triberg im Schwarzwald", "Neueck, Triberg im Schwarzwald", "15:05", "15:40"),
];
const journey = (span: { fromName: string; toName: string } | null, ls = legs): NormJourney => ({
  legs: ls,
  price: { amount: 25.49, currency: "EUR", fullRoute: true, hint: "Teilpreis / partial fare" },
  ticketInfo: span,
});

describe("Wofür gilt das Ticket?", () => {
  it("liest die Gültigkeit aus den Angebotsdetails (passend zum angezeigten Preis)", () => {
    const raw = {
      angebotsPreis: { betrag: 25.49 },
      reiseAngebote: [
        {
          hinfahrt: {
            fahrtAngebote: [
              { name: "Flexpreis", preis: { betrag: 103.65 }, teilpreisDetails: { intervallPreis: { haltIntervall: { abfahrtHalt: { name: "Bochum Hbf" }, ankunftHalt: { name: "Triberg" } } } } },
              { name: "Super Sparpreis", preis: { betrag: 25.49 }, teilpreisDetails: { intervallPreis: { haltIntervall: { abfahrtHalt: { name: "Essen-Steele" }, ankunftHalt: { name: "Marktplatz, Triberg im Schwarzwald" } } } } },
            ],
          },
        },
      ],
    };
    expect(offerSpanOf(raw)).toEqual({ fromName: "Essen-Steele", toName: "Marktplatz, Triberg im Schwarzwald" });
    expect(offerSpanOf({ angebotsPreis: { betrag: 10 } })).toBeNull();
  });

  it("Straßenbahn/Bus außerhalb: gültiges Ticket mit Hinweis, Abschnitte markiert", () => {
    const c = assessCoverage(journey({ fromName: "Essen-Steele", toName: "Marktplatz, Triberg im Schwarzwald" }));
    expect(c).toMatchObject({ coverage: "green", isFullRoute: true, uncoveredLegs: [0, 1, 6] });
    expect(c.reason).toMatch(/Essen-Steele → Marktplatz, Triberg/);
  });

  it("ein Zug außerhalb → kein Ticket für die Reise (rot); Regionalzüge nur mit Deutschlandticket ok", () => {
    const fromKoeln = journey({ fromName: "Köln Hbf", toName: "Marktplatz, Triberg im Schwarzwald" });
    expect(assessCoverage(fromKoeln).coverage).toBe("red");
    expect(assessCoverage(fromKoeln, undefined, { deutschlandTicket: true })).toMatchObject({ coverage: "green", reason: expect.stringMatching(/Deutschlandticket/) });
    // the IC outside the span: red even with a Deutschlandticket
    expect(assessCoverage(journey({ fromName: "Mannheim Hbf", toName: "Marktplatz, Triberg im Schwarzwald" }), undefined, { deutschlandTicket: true }).coverage).toBe("red");
  });

  it("ein Preis ohne geprüften Geltungsbereich ist nie „bestätigt“ und als ungeprüft markiert", () => {
    const priced = journey(null);
    const c = assessCoverage(priced);
    expect(c).toMatchObject({ spanChecked: false });
    expect(c.reason).not.toMatch(/bestätigt/);
    expect(c.reason).toMatch(/nicht bei der DB geprüft/);
    const checked = { ...priced, price: { ...priced.price!, spanChecked: true } };
    expect(assessCoverage(checked)).toMatchObject({ spanChecked: true, reason: "Durchgehendes Ticket bestätigt" });
  });

  it("verwechselt Essen Hbf nicht mit Essen-Steele", () => {
    const viaHbf = [legs[0], { ...legs[2], origin: { name: "Essen Hbf" } }, { ...legs[2], origin: { name: "Essen-Steele" }, lineName: "S 1" }, ...legs.slice(3)];
    expect(uncoveredLegs(viaHbf, "Essen-Steele", "Triberg")).toEqual([0, 1, 5, 6]);
  });

  it("knappster Umstieg nur im Ticket; knappe Umstiege davor sind ungeschützt", () => {
    const t = ticketTransfers(legViews(journey(null)), [0, 1, 6]);
    expect(t.minCovered).toBe(8); // Triberg: RE 14:02 → Bus 550 14:10 — that bus is still in the ticket
    expect(t.unprotected).toEqual([
      // the tram is punctual enough with 5 min, the bus with 4 min is not
      { station: "Hauptbahnhof, Bochum", minutes: 5, where: "before", product: "tram", risky: false, toLeg: 1 },
      { station: "Steele S-Bahnhof, Essen (Ruhr)", minutes: 4, where: "before", product: "bus", risky: true, toLeg: 2 },
      { station: "Marktplatz, Triberg im Schwarzwald", minutes: 20, where: "after", product: "bus", risky: false, toLeg: 6 },
    ]);
  });

  it("zieht den Fußweg vom Umstieg ab (Straßenbahn an 17:45, 5 min Fußweg, Zug ab 17:50 → 0 min)", () => {
    const walk: NormLeg = { ...leg("walking", "", "Hauptbahnhof, Bochum", "Bochum Hbf", "17:45", "17:50"), isWalking: true };
    const ls = [
      leg("tram", "STR 301", "Musterplatz, Bochum", "Hauptbahnhof, Bochum", "17:27", "17:45"),
      walk,
      leg("nationalExpress", "ICE 10", "Bochum Hbf", "Dortmund Hbf", "17:50", "18:10"),
    ];
    const t = ticketTransfers(legViews(journey(null, ls)), [0]);
    expect(t.unprotected).toEqual([{ station: "Hauptbahnhof, Bochum", minutes: 0, where: "before", product: "tram", risky: true, toLeg: 2 }]);
  });
});
