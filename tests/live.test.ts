import { describe, expect, it } from "vitest";
import type { TripLeg } from "@/db/schema";
import { activeLegs, dueLegs, findStop, forecastLegs, matchDeparture } from "@/lib/trips/live";

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
  // ICE Mannheim 11:07 → Frankfurt 11:38 (UTC), then RE 2 11:50 → 12:30
  const re2 = leg({ lineName: "RE 2", product: "regionalExpress", plannedDeparture: "2026-10-10T11:50:00.000Z", plannedArrival: "2026-10-10T12:30:00.000Z" });

  it("fängt 30 min vor der Fahrt an; misst den nahen Zug (Einstieg ≤ 1 h) bis 30 min nach der (späten) Ankunft", () => {
    const legs = [leg({}), { ...leg({}), isWalking: true }];
    expect(activeLegs(legs, at("2026-10-10T10:36:00Z"))).toEqual([]); // > 30 min before the trip
    expect(activeLegs(legs, at("2026-10-10T10:40:00Z"))).toEqual([0]);
    expect(activeLegs(legs, at("2026-10-10T12:20:00Z"))).toEqual([]);
    // 40 min late → still watched 30 min after the actual arrival
    const late = [leg({ rt: { arr: "2026-10-10T12:18:00.000Z", final: false, source: "live", checkedAt: 1 } })];
    expect(activeLegs(late, at("2026-10-10T12:40:00Z"))).toEqual([0]);
    // final open data → nothing to do
    expect(activeLegs([leg({ rt: { final: true, source: "opendata", checkedAt: 1 } })], at("2026-10-10T11:00:00Z"))).toEqual([]);
    // a later train only once you board it within the hour
    expect(activeLegs([leg({}), re2], at("2026-10-10T10:45:00Z"))).toEqual([0]);
    expect(activeLegs([leg({}), re2], at("2026-10-10T10:55:00Z"))).toEqual([0, 1]);
  });

  it("der 30-min-Vorlauf zählt ab Fahrtbeginn – auch wenn die Fahrt mit der Straßenbahn beginnt", () => {
    const tram = leg({ lineName: "STR 301", product: "tram", plannedDeparture: "2026-10-10T10:00:00.000Z", plannedArrival: "2026-10-10T10:20:00.000Z" });
    const legs = [tram, leg({ plannedDeparture: "2026-10-10T10:40:00.000Z", plannedArrival: "2026-10-10T11:38:00.000Z" })];
    expect(forecastLegs(legs, at("2026-10-10T09:29:00Z"))).toEqual([]);
    expect(forecastLegs(legs, at("2026-10-10T09:31:00Z"))).toEqual([1]); // the train, 30 min before the tram
    expect(dueLegs(legs, at("2026-10-10T09:41:00Z"))).toEqual([1]); // boarding within the hour
  });

  it("Flex-Fahrt: spätere Züge alle 30 min, nahe alle 10 min", () => {
    const seen = [leg({}), re2].map((l) => ({ ...l, rtLive: { final: false, source: "live" as const, checkedAt: at("2026-10-10T10:40:00Z") } }));
    expect(forecastLegs(seen, at("2026-10-10T11:05:00Z"))).toEqual([]);
    expect(forecastLegs(seen, at("2026-10-10T11:10:00Z"))).toEqual([0, 1]);
    expect(dueLegs(seen, at("2026-10-10T10:45:00Z"))).toEqual([]);
    expect(dueLegs(seen, at("2026-10-10T10:50:00Z"))).toEqual([0, 1]); // the RE 2 is now within the hour too
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
