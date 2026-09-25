import { describe, expect, it } from "vitest";
import { analyzeJourney } from "@/lib/domain/analyze";
import { journeyFingerprint } from "@/lib/domain/fingerprint";
import { isLongDistanceLeg } from "@/lib/domain/products";
import { assessCoverage } from "@/lib/domain/ticketCoverage";
import { proformaScore, rankResults } from "@/lib/domain/ranking";
import { buildResult } from "@/lib/domain/result";
import { journey, leg } from "./helpers";

describe("Fernverkehrserkennung", () => {
  it("erkennt RE → ICE → RE als FV-Verbindung mit genau einem FV-Leg", () => {
    const j = journey(
      [
        leg("regionalExpress", "A", "B", 0, 30),
        leg("nationalExpress", "B", "C", 35, 52, { trainNumber: "612" }),
        leg("regionalExpress", "C", "D", 60, 120),
      ],
      19,
      { fullRoute: true },
    );
    const m = analyzeJourney(j);
    expect(m.fvLegs).toBe(1);
    expect(j.legs.filter(isLongDistanceLeg)).toHaveLength(1);
  });

  it("Bus und RE zählen nicht als Fernverkehr", () => {
    expect(isLongDistanceLeg(leg("bus", "A", "B", 0, 10))).toBe(false);
    expect(isLongDistanceLeg(leg("regional", "A", "B", 0, 10))).toBe(false);
    expect(isLongDistanceLeg(leg("nationalExpress", "A", "B", 0, 10))).toBe(true);
    expect(isLongDistanceLeg(leg("national", "A", "B", 0, 10))).toBe(true);
  });
});

describe("ICE-Anteil", () => {
  it("zählt nur tatsächliche ICE/IC/EC-Legs für die FV-Minuten", () => {
    const j = journey(
      [
        leg("regional", "A", "B", 0, 25), // 25 min regional
        leg("nationalExpress", "B", "C", 40, 57), // 17 min ICE
        leg("regional", "C", "D", 65, 200), // regional
      ],
      18.99,
      { fullRoute: true },
    );
    const m = analyzeJourney(j);
    expect(m.fvMinutes).toBe(17);
    expect(m.fvStops).toBe(1); // direct hop => 1 Halt
    expect(m.durationMin).toBe(200);
    expect(m.fvPercent).toBeCloseTo(8.5, 0);
  });
});

describe("Ticket Coverage", () => {
  it("markiert Teilstreckenangebote als rot (nicht durchgehend)", () => {
    const j = journey(
      [
        leg("regional", "Bochum", "Dortmund", 0, 25),
        leg("nationalExpress", "Dortmund", "Offenburg", 30, 270),
        leg("regional", "Offenburg", "Triberg", 280, 360),
      ],
      15,
      { fullRoute: false, offerFrom: "Dortmund", offerTo: "Offenburg" },
    );
    const c = assessCoverage(j);
    expect(c.coverage).toBe("red");
    expect(c.isFullRoute).toBe(false);
  });

  it("bestätigt durchgehende Tickets als grün", () => {
    const j = journey([leg("nationalExpress", "Bochum", "Triberg", 0, 60)], 39, {
      fullRoute: true,
    });
    expect(assessCoverage(j).coverage).toBe("green");
  });

  it("kennzeichnet unbekannte Abdeckung ausdrücklich als gelb", () => {
    const j = journey([leg("nationalExpress", "A", "B", 0, 60)], 30); // price, no flags
    expect(assessCoverage(j).coverage).toBe("yellow");
  });

  it("kennzeichnet Fahrplan ohne Preis als 'unpriced' (nicht als Teilstrecke)", () => {
    const j = journey([leg("nationalExpress", "A", "B", 0, 60)], null); // MOTIS-only, no price
    const c = assessCoverage(j);
    expect(c.coverage).toBe("unpriced");
    expect(c.price).toBeNull();
  });
});

describe("Deduplizierung", () => {
  it("gleiche Verbindung mit anderer Realtime-Verspätung => gleicher Fingerprint", () => {
    const onTime = journey([leg("nationalExpress", "A", "B", 0, 60, { trainNumber: "612" })], 20);
    const delayed = journey(
      [leg("nationalExpress", "A", "B", 0, 60, { trainNumber: "612", delayMin: 5 })],
      20,
    );
    expect(journeyFingerprint(onTime)).toBe(journeyFingerprint(delayed));
  });

  it("unterschiedliche Züge => unterschiedlicher Fingerprint", () => {
    const a = journey([leg("nationalExpress", "A", "B", 0, 60, { trainNumber: "612" })], 20);
    const b = journey([leg("nationalExpress", "A", "B", 0, 60, { trainNumber: "614" })], 20);
    expect(journeyFingerprint(a)).not.toBe(journeyFingerprint(b));
  });
});

describe("Ranking (Pro-Forma)", () => {
  it("bevorzugt durchgehendes Ticket mit kleinem FV-Anteil vor teurer Schnellverbindung", () => {
    const proforma = buildResult(
      journey(
        [
          leg("regional", "A", "B", 0, 25),
          leg("nationalExpress", "B", "C", 40, 57),
          leg("regional", "C", "D", 65, 400),
        ],
        18.99,
        { fullRoute: true },
      ),
    );
    const fast = buildResult(
      journey([leg("nationalExpress", "A", "D", 0, 240)], 89.9, { fullRoute: true }),
    );
    const partial = buildResult(
      journey(
        [
          leg("regional", "A", "B", 0, 25),
          leg("nationalExpress", "B", "C", 30, 270),
        ],
        12,
        { fullRoute: false, offerFrom: "B", offerTo: "C" },
      ),
    );
    const ranked = rankResults([fast, partial, proforma], "proforma");
    expect(ranked[0]).toBe(proforma);
    // partial (red) is penalised below the priced full-ticket options
    expect(proformaScore(partial)).toBeGreaterThan(proformaScore(fast));
  });
});
