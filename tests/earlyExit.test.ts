import { describe, expect, it } from "vitest";
import { buildResult } from "@/lib/domain/result";
import { deriveEarlyExit } from "@/lib/engine/earlyExit";
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
const journey: NormJourney = {
  legs: [
    leg("regional", "RE 1", "Bochum Hbf", "Köln Hbf", "08:00", "08:50"),
    leg("nationalExpress", "ICE 101", "Köln Hbf", "Freiburg(Breisgau) Hbf", "09:00", "12:30"),
    leg("suburban", "S 1", "Freiburg(Breisgau) Hbf", "Titisee", "12:45", "13:20"),
  ],
  price: { amount: 24.79, currency: "EUR", fullRoute: true },
};
const full = buildResult(journey, { resultKind: "proforma" });

describe("Früher aussteigen", () => {
  it("macht aus dem Ticket nach Titisee eine Fahrt bis Freiburg zum selben Preis", () => {
    const e = deriveEarlyExit(full, journey, ["Freiburg (Breisgau) Hbf"])!;
    expect(e.metrics.destinationName).toBe("Freiburg(Breisgau) Hbf");
    expect(e.metrics.plannedArrival).toBe("2026-10-15T12:30:00+02:00");
    expect(e.legs).toHaveLength(2);
    expect(e.coverage.price).toBe(24.79);
    expect(e.earlyExit).toMatchObject({ ticketTo: "Titisee", ticketFrom: "Bochum Hbf", fvFrom: "Köln Hbf", fvTo: "Freiburg(Breisgau) Hbf", fvLegs: 1 });
    expect(e.fingerprint).not.toBe(e.earlyExit!.baseFingerprint);
  });

  it("nicht, wenn das Ticket dort nicht mehr gilt, die Fahrt dort ohnehin endet oder der Halt fehlt", () => {
    const uncovered = { ...full, coverage: { ...full.coverage, uncoveredLegs: [1, 2] } };
    expect(deriveEarlyExit(uncovered, journey, ["Freiburg(Breisgau) Hbf"])).toBeNull();
    expect(deriveEarlyExit(full, journey, ["Titisee"])).toBeNull();
    expect(deriveEarlyExit(full, journey, ["Offenburg"])).toBeNull();
    expect(deriveEarlyExit({ ...full, coverage: { ...full.coverage, coverage: "red" } }, journey, ["Freiburg(Breisgau) Hbf"])).toBeNull();
  });
});
