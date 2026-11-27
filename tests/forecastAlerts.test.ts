import { describe, expect, it } from "vitest";
import type { TripRow } from "@/db/schema";
import type { Forecast } from "@/lib/trips/forecast";
import { alertFor } from "@/lib/trips/forecastAlerts";

const trip = { status: "planned", plan: "skip", movedFrom: null, plannedArrival: "2026-11-24T11:42:00.000Z" } as unknown as TripRow;
const f = (delayMin: number | null, at: number): Forecast => ({ level: "lifted", delayMin, reason: "Anschluss in Köln Hbf platzt", breakAt: null, at, complete: true });
const NOON = Date.parse("2026-11-24T11:00:00.000Z");

describe("Prognose als Eintrag in der Fahrt", () => {
  it("einmal, dann nur bei neuen Live-Daten und deutlich schlechter", () => {
    const first = alertFor(trip, f(30, 1), undefined, NOON)!;
    expect(first).toMatchObject({ kind: "lifted", delay: 30, seen: 1 });
    // the same snapshot again — the replacement computed from "now" is later, but DB said nothing new
    expect(alertFor(trip, f(300, 1), first, NOON + 3_600_000)).toBeNull();
    expect(alertFor(trip, f(40, 2), first, NOON)).toBeNull();
    expect(alertFor(trip, f(55, 2), first, NOON)).toMatchObject({ delay: 55, seen: 2 });
  });

  it("nach dem Reisetag nicht mehr", () => {
    expect(alertFor(trip, f(30, 1), undefined, Date.parse("2026-11-25T08:00:00.000Z"))).toBeNull();
  });
});
