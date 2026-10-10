import { describe, expect, it } from "vitest";
import type { RerouteCheck, TripLeg } from "@/db/schema";
import { forecastText, tripForecast } from "@/lib/trips/forecast";
import { bestArrival } from "@/lib/trips/reroute";
import { withRealtime } from "@/lib/trips/realtime";

const T = (hm: string) => `2026-11-24T${hm}:00+01:00`;
const leg = (line: string, product: string, from: string, to: string, dep: string, arr: string): TripLeg => ({
  lineName: line,
  product,
  fromName: from,
  toName: to,
  fromId: null,
  toId: null,
  plannedDeparture: T(dep),
  plannedArrival: T(arr),
});
const live = (l: TripLeg, dep: string | null, arr: string | null, extra: { depCancelled?: boolean } = {}) =>
  withRealtime(l, { live: { dep: dep ? T(dep) : null, arr: arr ? T(arr) : null, final: false, source: "live", checkedAt: 1000, ...extra } });

const trip = () => [
  leg("STR 310", "tram", "Bochum Rathaus", "Bochum Hbf", "07:40", "07:55"),
  leg("RE 2", "regionalExpress", "Bochum Hbf", "Essen Hbf", "08:05", "08:20"),
  leg("ICE 612", "nationalExpress", "Essen Hbf", "Mannheim Hbf", "08:30", "11:00"),
  leg("RE 7", "regionalExpress", "Mannheim Hbf", "Offenburg", "11:10", "12:30"),
];

describe("Prognose vor / während der Fahrt", () => {
  it("ohne Live-Daten: keine Prognose", () => {
    expect(tripForecast(trip()).level).toBe("none");
  });

  it("alles pünktlich → ok", () => {
    const [a, b, c, d] = trip();
    const f = tripForecast([a, live(b, "08:05", "08:20"), live(c, "08:30", "11:00"), live(d, "11:10", "12:30")]);
    expect(f).toMatchObject({ level: "ok", delayMin: 0, complete: true });
  });

  it("≥ 20 min am Ziel → Zugbindung aufgehoben, mit dem Zug, der die Verspätung bringt", () => {
    const [a, b, c, d] = trip();
    const f = tripForecast([a, live(b, "08:05", "08:20"), live(c, "08:30", "11:05"), live(d, "11:10", "12:55")]);
    expect(f).toMatchObject({ level: "lifted", delayMin: 25, reason: "RE 7 +25 min" });
    expect(forecastText(f, "Offenburg")).toMatch(/\+25 min in Offenburg – Zugbindung aufgehoben/);
  });

  const broken = () => {
    const [a, b, c, d] = trip();
    return [a, live(b, "08:05", "08:20"), live(c, "08:30", "11:16"), live(d, "11:10", "12:30")];
  };
  const check = (o: Partial<RerouteCheck>): RerouteCheck => ({
    breakLeg: 3,
    from: "Mannheim Hbf",
    after: T("11:16"),
    arrival: T("12:42"),
    delayMin: 12,
    via: "RE 9",
    checkedAt: 1000,
    ...o,
  });

  it("Anschluss platzt: erst nach der Ersatz-Prüfung entschieden (Bruchstelle = Abfahrt des Anschlusszugs)", () => {
    const f = tripForecast(broken());
    expect(f.level).toBe("check");
    expect(f.reason).toMatch(/Anschluss in Mannheim Hbf platzt \(ICE 612 \+16 min.*wird geprüft/);
    expect(f.breakAt).toMatchObject({ legIndex: 3, station: "Mannheim Hbf" });
  });

  it("Anschluss platzt, aber der schnellste Ersatz ist < 20 min später am Ziel → Zugbindung bleibt", () => {
    const f = tripForecast(broken(), check({}));
    expect(f).toMatchObject({ level: "late", delayMin: 12 });
    expect(forecastText(f, "Offenburg")).toMatch(/Ersatz kommt \+12 min in Offenburg an, Zugbindung bleibt/);
  });

  it("Anschluss platzt und der schnellste Ersatz ist ≥ 20 min später (oder es gibt keinen) → aufgehoben", () => {
    expect(tripForecast(broken(), check({ arrival: T("12:55"), delayMin: 25 }))).toMatchObject({ level: "lifted", delayMin: 25 });
    expect(tripForecast(broken(), check({ arrival: null, delayMin: null })).level).toBe("lifted");
    // a check of another (older) break doesn't count
    expect(tripForecast(broken(), check({ breakLeg: 2 })).level).toBe("check");
  });

  it("Zugausfall: ebenfalls über die schnellste Weiterfahrt entschieden", () => {
    const [a, b, c, d] = trip();
    const legs = [a, live(b, "08:05", "08:20"), live(c, null, null, { depCancelled: true }), live(d, "11:10", "12:30")];
    expect(tripForecast(legs)).toMatchObject({ level: "check" });
    expect(tripForecast(legs).breakAt?.station).toBe("Essen Hbf");
    expect(tripForecast(legs, check({ breakLeg: 2, from: "Essen Hbf", delayMin: 40, arrival: T("13:10") })).level).toBe("lifted");
  });

  it("nimmt die früheste Ankunft (Echtzeit) und überspringt ausgefallene Verbindungen", () => {
    const j = (arr: string, rt: string | null, cancelled = false) => ({
      legs: [{ lineName: "RE 9", isWalking: false, origin: { name: "Mannheim Hbf" }, destination: { name: "Offenburg" }, plannedArrival: T(arr), arrival: rt ? T(rt) : null, ...(cancelled ? { cancelled: true } : {}) }],
    });
    expect(bestArrival([j("12:40", "12:58"), j("12:50", null), j("12:35", null, true)])).toEqual({ arrival: T("12:50"), via: "RE 9" });
  });

  it("Tram zählt nicht (nur Bahn-Abschnitte)", () => {
    const [a, b, c, d] = trip();
    const f = tripForecast([live(a, "07:40", "08:30"), live(b, "08:05", "08:20"), live(c, "08:30", "11:00"), live(d, "11:10", "12:30")]);
    expect(f.level).toBe("ok");
  });
});
