import { beforeAll, describe, expect, it, vi } from "vitest";
import type { TripLeg } from "@/db/schema";

const plan = vi.fn();
vi.mock("@/lib/rail/provider", () => ({
  getProvider: () => ({
    searchLocations: async (q: string) => [{ id: `id:${q}`, name: q }],
    searchJourneys: plan,
  }),
}));

import { ensureReady } from "@/lib/bootstrap";
import { createTrip, getTrip } from "@/lib/trips/repo";
import { findLegStops, legStations, lineKey, stopLabel, tripStations } from "@/lib/trips/legStops";

beforeAll(() => ensureReady());

const re2: TripLeg = { lineName: "RE2 (4719)", fromName: "Offenburg", toName: "Villingen(Schwarzw)", plannedDeparture: "2026-11-17T13:58:00.000Z", plannedArrival: "2026-11-17T15:05:00.000Z" };
const run = (dep: string, line = "RE2") => ({
  journeys: [
    {
      legs: [
        {
          lineName: line,
          plannedDeparture: dep,
          isWalking: false,
          stopovers: ["Gengenbach Bahnhof", "Hausach Bahnhof", "Hornberg Bahnhof", "Triberg Bahnhof"].map((name) => ({ name })),
        },
      ],
    },
  ],
});

describe("Abgebrochen in: Zwischenhalte", () => {
  it("normalisiert Linien und Haltnamen", () => {
    expect(lineKey("RE42 (10102)")).toBe("re42");
    expect(lineKey("ICE 278")).toBe("ice278");
    expect(stopLabel("Hornberg Bahnhof")).toBe("Hornberg");
    expect(stopLabel("Essen Hbf")).toBe("Essen Hbf");
    expect(stopLabel("Neckarau,,")).toBe("Neckarau");
    expect(stopLabel("Wetter Bf.")).toBe("Wetter");
  });

  it("findet den Zug im Fahrplan und liefert die Halte dazwischen", async () => {
    plan.mockReset().mockResolvedValueOnce(run("2026-11-17T13:58:00.000Z"));
    expect(await findLegStops(re2)).toEqual(["Gengenbach", "Hausach", "Hornberg", "Triberg"]);
  });

  it("nimmt denselben Zug eine Woche später, wenn er am Reisetag fehlt (Ausfall)", async () => {
    plan
      .mockReset()
      .mockResolvedValueOnce(run("2026-11-17T13:58:00.000Z", "ICE 99"))
      .mockResolvedValueOnce(run("2026-11-24T13:58:00.000Z"));
    expect(await findLegStops(re2)).toContain("Hornberg");
  });

  it("speichert die Halte an der Fahrt und fragt nur einmal", async () => {
    plan.mockReset().mockResolvedValue(run("2026-11-17T13:58:00.000Z"));
    const t = createTrip({ legs: [{ fromName: "Offenburg", toName: "Offenburg", plannedDeparture: null, plannedArrival: null, isWalking: true }, re2] } as never);
    const legs = await tripStations(t.id);
    expect(legs).toHaveLength(1);
    expect(legs[0].stations).toEqual(["Offenburg", "Gengenbach", "Hausach", "Hornberg", "Triberg", "Villingen(Schwarzw)"]);
    expect(legs[0].complete).toBe(true);
    await tripStations(t.id);
    expect(plan).toHaveBeenCalledTimes(1);
    expect(getTrip(t.id)?.legs[1].stops).toContain("Hornberg");
  });

  it("Ticket ohne Züge (Zugbindung aufgehoben): nur Start und Ziel", () => {
    expect(legStations([{ fromName: "Bochum Hbf", toName: "Triberg", plannedDeparture: null, plannedArrival: null }])).toEqual([
      { label: "Bochum Hbf → Triberg", stations: ["Bochum Hbf", "Triberg"], complete: false },
    ]);
  });
});

describe("Abgebrochen in: ältere Fahrten", () => {
  it("fragt außerhalb des Fahrplanzeitraums denselben Wochentag jetzt ab", async () => {
    const old = { ...re2, plannedDeparture: "2026-10-13T13:58:00.000Z" };
    plan.mockReset().mockImplementation(async (_f: string, _t: string, o: { departure: Date }) => {
      if (o.departure.getTime() < Date.parse("2026-11-01")) throw new Error("motis 400");
      return run(new Date(o.departure.getTime() + 3 * 60_000).toISOString());
    });
    expect(await findLegStops(old, Date.parse("2026-11-20T10:00:00Z"))).toContain("Hornberg");
  });

  it("rechnet über die Zeitumstellung in Ortszeit (17:04 bleibt 17:04)", async () => {
    const asked: string[] = [];
    plan.mockReset().mockImplementation(async (_f: string, _t: string, o: { departure: Date }) => {
      asked.push(new Date(o.departure.getTime() + 3 * 60_000).toISOString());
      return { journeys: [] };
    });
    await findLegStops({ ...re2, plannedDeparture: "2026-10-15T15:04:00.000Z" }, Date.parse("2026-11-20T10:00:00Z"));
    expect(asked[0]).toBe("2026-11-26T16:04:00.000Z"); // Thursday, 17:04 CET (was CEST)
  });

  it("Fahrplan gar nicht erreichbar → Fehler (später nochmal), nicht 'unbekannt'", async () => {
    plan.mockReset().mockRejectedValue(new Error("down"));
    await expect(findLegStops(re2)).rejects.toThrow();
  });
});
