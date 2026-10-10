import { describe, expect, it } from "vitest";
import type { TripLeg } from "@/db/schema";
import { applyHits, needsActuals } from "@/lib/trips/actuals";
import { delayMin, missedConnections, realtimeSummary } from "@/lib/trips/realtime";

const leg = (line: string, number: string, from: string, to: string, dep: string, arr: string): TripLeg => ({
  product: line.startsWith("S") ? "suburban" : "nationalExpress",
  lineName: line,
  trainNumber: number,
  fromName: from,
  toName: to,
  plannedDeparture: `2026-10-06T${dep}:00+02:00`,
  plannedArrival: `2026-10-06T${arr}:00+02:00`,
});

// 06.10.2026 as it really ran (open DB data): the IC came 31 min late, the ICE left on time.
const legs = [
  leg("ICE 101", "101", "Bochum Hbf", "Köln Hbf", "05:48", "06:48"),
  leg("IC 2348", "2348", "Köln Hbf", "Mannheim Hbf", "06:53", "09:21"),
  leg("ICE 277", "277", "Mannheim Hbf", "Freiburg(Breisgau) Hbf", "09:37", "11:01"),
];
const hits = {
  "t|0|dp": { found: true, pt: "2610060548", ct: "2610060550", final: true },
  "t|0|ar": { found: true, pt: "2610060648", ct: "2610060653", final: true },
  "t|1|dp": { found: true, pt: "2610060653", ct: "2610060710", final: true },
  "t|1|ar": { found: true, pt: "2610060921", ct: "2610060952", codes: ["34"], final: true },
  "t|2|dp": { found: true, pt: "2610060937", ct: "2610060939", final: true },
  "t|2|ar": { found: true, pt: "2610061101", ct: null, final: true },
};

describe("Ist-Zeiten aus den offenen DB-Daten", () => {
  const withRt = applyHits({ id: "t", legs }, hits, 1);

  it("übernimmt Ist-Zeiten in Berliner Zeit (ohne Änderung = pünktlich)", () => {
    expect(withRt[0].rt).toMatchObject({ dep: "2026-10-06T03:50:00.000Z", arr: "2026-10-06T04:53:00.000Z", final: true, source: "opendata" });
    expect(withRt[1].rt!.codes).toEqual(["34"]);
    expect(withRt[2].rt!.arr).toBe("2026-10-06T09:01:00.000Z");
    expect(delayMin(withRt[1].plannedArrival, withRt[1].rt!.arr)).toBe(31);
  });

  it("erkennt den geplatzten Anschluss in Mannheim", () => {
    expect(missedConnections(withRt)).toEqual([
      { afterLeg: 1, nextLeg: 2, station: "Mannheim Hbf", arrived: "2026-10-06T07:52:00.000Z", departed: "2026-10-06T07:39:00.000Z" },
    ]);
    // a broken connection → no "actual arrival" of the booked trip
    expect(realtimeSummary(withRt)).toMatchObject({ arrival: null, complete: true, final: true });
  });

  it("liefert die Ankunft, wenn alles geklappt hat", () => {
    const ok = applyHits({ id: "t", legs }, { ...hits, "t|1|ar": { found: true, pt: "2610060921", ct: "2610060930", final: true } }, 1);
    expect(realtimeSummary(ok)).toMatchObject({ arrival: "2026-10-06T09:01:00.000Z", arrivalDelay: 0, missed: [] });
  });

  it("überschreibt Live-Daten nicht mit „nicht gefunden“ und fragt nur vergangene, offene Fahrten an", () => {
    const live: TripLeg[] = [{ ...legs[0], rt: { dep: "x", final: false, source: "live", checkedAt: 1 } }];
    expect(applyHits({ id: "t", legs: live }, { "t|0|dp": { found: false, final: true } })[0].rt!.source).toBe("live");
    expect(needsActuals({ date: "2026-10-06", legs }, "2026-10-10")).toBe(true);
    expect(needsActuals({ date: "2026-10-06", legs: withRt }, "2026-10-10")).toBe(false);
    expect(needsActuals({ date: "2026-10-10", legs }, "2026-10-10")).toBe(false);
  });
});
