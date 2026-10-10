import { describe, expect, it } from "vitest";
import { locateTrain } from "@/lib/trips/controlCheck";

// ICE Köln → Frankfurt, 10 min late from Siegburg on
const stops = [
  { name: "Köln Hbf", plannedDeparture: "2026-10-10T10:00:00Z", departure: "2026-10-10T10:02:00Z", lat: 50.943, lng: 6.959 },
  { name: "Siegburg/Bonn", plannedArrival: "2026-10-10T10:15:00Z", arrival: "2026-10-10T10:20:00Z", plannedDeparture: "2026-10-10T10:17:00Z", departure: "2026-10-10T10:27:00Z", lat: 50.794, lng: 7.203 },
  { name: "Montabaur", plannedArrival: "2026-10-10T10:40:00Z", arrival: "2026-10-10T10:52:00Z", plannedDeparture: "2026-10-10T10:41:00Z", departure: "2026-10-10T10:53:00Z", lat: 50.445, lng: 7.825 },
  { name: "Frankfurt(Main)Hbf", plannedArrival: "2026-10-10T11:05:00Z", arrival: "2026-10-10T11:16:00Z", lat: 50.107, lng: 8.663 },
];
const leg = { fromName: "Köln Hbf", toName: "Montabaur", plannedDeparture: "2026-10-10T10:00:00Z", plannedArrival: "2026-10-10T10:40:00Z" };
const at = (s: string) => new Date(s).getTime();

describe("Kontrolle: wo war der Zug?", () => {
  it("zwischen zwei Halten, mit Verspätung bei Abfahrt und Prognose am nächsten Halt", () => {
    expect(locateTrain(stops, at("2026-10-10T10:35:00Z"), leg, null, "ICE 123")).toMatchObject({
      train: "ICE 123", where: "between", from: "Siegburg/Bonn", to: "Montabaur", delayMin: 10, nextDelayMin: 12, outsideLeg: false,
    });
  });

  it("steht am Halt (angekommen, noch nicht abgefahren)", () => {
    expect(locateTrain(stops, at("2026-10-10T10:22:00Z"), leg)).toMatchObject({ where: "at", from: "Siegburg/Bonn", delayMin: 5, nextDelayMin: 10 });
  });

  it("merkt, wenn die Kontrolle außerhalb des gebuchten Abschnitts liegt", () => {
    expect(locateTrain(stops, at("2026-10-10T11:00:00Z"), leg)).toMatchObject({ where: "between", from: "Montabaur", to: "Frankfurt(Main)Hbf", outsideLeg: true });
  });

  it("prüft den GPS-Standort gegen die Strecke", () => {
    const onTrack = locateTrain(stops, at("2026-10-10T10:35:00Z"), leg, { lat: 50.62, lng: 7.51, accuracy: 50 });
    expect(onTrack.gpsOk).toBe(true);
    const elsewhere = locateTrain(stops, at("2026-10-10T10:35:00Z"), leg, { lat: 51.45, lng: 7.01, accuracy: 30 }); // Essen
    expect(elsewhere.gpsOk).toBe(false);
    expect(elsewhere.gpsKm).toBeGreaterThan(50);
  });

  it("vor der Abfahrt / nach der Ankunft", () => {
    expect(locateTrain(stops, at("2026-10-10T09:58:00Z"), leg)).toMatchObject({ where: "before", from: "Köln Hbf" });
    expect(locateTrain(stops, at("2026-10-10T11:30:00Z"), leg)).toMatchObject({ where: "after", from: "Frankfurt(Main)Hbf", delayMin: 11 });
  });
});
