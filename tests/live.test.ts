import { describe, expect, it } from "vitest";
import type { TripLeg } from "@/db/schema";
import { activeLegs, findStop, matchDeparture } from "@/lib/trips/live";

const leg = (o: Partial<TripLeg>): TripLeg => ({
  product: "nationalExpress",
  lineName: "ICE 918",
  trainNumber: "918",
  fromName: "Mannheim Hbf",
  toName: "Frankfurt(M) Flughafen Fernbf",
  plannedDeparture: "2026-10-10T11:07:00.000Z",
  plannedArrival: "2026-10-10T11:38:00.000Z",
  ...o,
});
const at = (iso: string) => new Date(iso).getTime();

describe("Live-Daten am Reisetag", () => {
  it("beobachtet einen Zug ab 1 h vor Abfahrt bis 30 min nach (verspäteter) Ankunft", () => {
    const legs = [leg({}), { ...leg({}), isWalking: true }];
    expect(activeLegs(legs, at("2026-10-10T09:59:00Z"))).toEqual([]);
    expect(activeLegs(legs, at("2026-10-10T10:10:00Z"))).toEqual([0]);
    expect(activeLegs(legs, at("2026-10-10T12:20:00Z"))).toEqual([]);
    // 40 min late → still watched 30 min after the actual arrival
    const late = [leg({ rt: { arr: "2026-10-10T12:18:00.000Z", final: false, source: "live", checkedAt: 1 } })];
    expect(activeLegs(late, at("2026-10-10T12:40:00Z"))).toEqual([0]);
    // final open data → nothing to do
    expect(activeLegs([leg({ rt: { final: true, source: "opendata", checkedAt: 1 } })], at("2026-10-10T11:00:00Z"))).toEqual([]);
  });

  it("findet den Zug auf der Abfahrtstafel über Minute + Nummer oder Linie", () => {
    const deps = [
      { tripId: "a", lineName: "ICE 618", trainNumber: "618", plannedWhen: "2026-10-10T11:07:00Z" },
      { tripId: "b", lineName: "ICE 918", trainNumber: "918", plannedWhen: "2026-10-10T11:07:00Z" },
    ];
    expect(matchDeparture(leg({}), deps)?.tripId).toBe("b");
    // regional train: DB board number carries a prefix ("3552263" for 52263)
    const re = leg({ product: "regional", lineName: "RB 52263", trainNumber: "52263" });
    expect(matchDeparture(re, [{ tripId: "c", lineName: "52263", trainNumber: "3552263", plannedWhen: "2026-10-10T11:07:00Z" }])?.tripId).toBe("c");
    // S-Bahn without number: by line
    const s = leg({ product: "suburban", lineName: "S2", trainNumber: undefined });
    expect(matchDeparture(s, [{ tripId: "d", lineName: "S 2", plannedWhen: "2026-10-10T11:08:00Z" }])?.tripId).toBe("d");
    expect(matchDeparture(leg({}), [{ tripId: "e", lineName: "ICE 918", trainNumber: "918", plannedWhen: "2026-10-10T12:07:00Z" }])).toBeNull();
  });

  it("findet Ein- und Ausstieg im Zuglauf (Name, sonst Planzeit)", () => {
    const stops = [
      { name: "Mannheim Hbf", plannedDeparture: "2026-10-10T11:07:00.000Z", departure: "2026-10-10T11:37:00.000Z" },
      { name: "Frankfurt(M) Flughafen Fernbahnhof", plannedArrival: "2026-10-10T11:38:00.000Z", arrival: "2026-10-10T12:10:00.000Z" },
    ];
    expect(findStop(stops, "Mannheim Hbf", null, "dep")?.departure).toBe("2026-10-10T11:37:00.000Z");
    expect(findStop(stops, "Frankfurt(M) Flughafen Fernbf", "2026-10-10T11:38:00.000Z", "arr")?.arrival).toBe("2026-10-10T12:10:00.000Z");
  });
});
