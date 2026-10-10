import { describe, expect, it } from "vitest";
import type { LegRealtime, TripLeg } from "@/db/schema";
import { applyHits } from "@/lib/trips/actuals";
import { dueLegs } from "@/lib/trips/live";
import { carryRealtime, combineRt, withRealtime } from "@/lib/trips/realtime";

const leg: TripLeg = {
  product: "nationalExpress",
  lineName: "ICE 101",
  trainNumber: "101",
  fromName: "Bochum Hbf",
  toName: "Köln Hbf",
  plannedDeparture: "2026-10-06T03:48:00.000Z",
  plannedArrival: "2026-10-06T04:48:00.000Z",
};
const live = (checkedAt: string, dep: string, arr: string): LegRealtime => ({
  dep,
  arr,
  final: false,
  source: "live",
  checkedAt: new Date(checkedAt).getTime(),
});

describe("Eigene Messungen bleiben erhalten", () => {
  it("live nach dem Ereignis gemessen gewinnt – geänderte DB-Daten nur als Hinweis", () => {
    const seen = live("2026-10-06T05:20:00Z", "2026-10-06T03:50:00.000Z", "2026-10-06T05:15:00.000Z"); // +27 an
    const open: LegRealtime = { dep: "2026-10-06T03:50:00.000Z", arr: "2026-10-06T04:58:00.000Z", final: true, source: "opendata", checkedAt: 1 }; // DB später: +10
    expect(combineRt(open, seen)).toMatchObject({
      arr: "2026-10-06T05:15:00.000Z",
      source: "live",
      final: true,
      dbLater: { arr: "2026-10-06T04:58:00.000Z", dep: null },
    });
  });

  it("eine Live-Prognose vor dem Ereignis wird von den finalen DB-Daten ersetzt (bleibt aber im Verlauf)", () => {
    const forecast = live("2026-10-06T04:00:00Z", "2026-10-06T03:50:00.000Z", "2026-10-06T05:40:00.000Z"); // um 06:00 +52 prognostiziert
    const open: LegRealtime = { dep: "2026-10-06T03:50:00.000Z", arr: "2026-10-06T05:05:00.000Z", final: true, source: "opendata", checkedAt: 1 };
    const l = withRealtime(withRealtime(leg, { live: forecast }), { open });
    expect(l.rt).toMatchObject({ arr: "2026-10-06T05:05:00.000Z", final: true });
    expect(l.rtLog).toHaveLength(1);
    expect(l.rtLog![0].arr).toBe("2026-10-06T05:40:00.000Z");
    expect(l.rtLive).toEqual(forecast);
  });

  it("hängt nur geänderte Messungen an und verliert nichts beim nächtlichen Abgleich", () => {
    let l = withRealtime(leg, { live: live("2026-10-06T03:00:00Z", leg.plannedDeparture!, leg.plannedArrival!) });
    l = withRealtime(l, { live: live("2026-10-06T03:10:00Z", leg.plannedDeparture!, leg.plannedArrival!) }); // unverändert
    l = withRealtime(l, { live: live("2026-10-06T03:20:00Z", leg.plannedDeparture!, "2026-10-06T05:10:00.000Z") });
    expect(l.rtLog).toHaveLength(2);
    const after = applyHits({ id: "t", legs: [l] }, { "t|0|dp": { found: false, final: true }, "t|0|ar": { found: false, final: true } });
    expect(after[0].rtLog).toHaveLength(2);
    expect(after[0].rtLive).toEqual(l.rtLive);
    expect(after[0].rtOpen).toMatchObject({ missing: true });
  });

  it("übernimmt die Messungen beim Neuimport derselben Verbindung", () => {
    const tracked = withRealtime(leg, { live: live("2026-10-06T05:20:00Z", leg.plannedDeparture!, "2026-10-06T05:15:00.000Z") });
    const [re] = carryRealtime([tracked], [{ ...leg, depPlatform: "6" }]);
    expect(re.depPlatform).toBe("6");
    expect(re.rtLog).toEqual(tracked.rtLog);
    expect(re.rt).toEqual(tracked.rt);
    // a different train stays clean
    expect(carryRealtime([tracked], [{ ...leg, trainNumber: "103", lineName: "ICE 103", fromName: "X", plannedDeparture: "2026-10-06T04:48:00.000Z" }])[0].rtLog).toBeUndefined();
  });

  it("misst direkt bei Abfahrt und Ankunft, sonst alle 10 Minuten", () => {
    const at = (s: string) => new Date(s).getTime();
    const l = withRealtime(leg, { live: live("2026-10-06T03:44:00Z", "2026-10-06T03:49:00.000Z", leg.plannedArrival!) });
    expect(dueLegs([l], at("2026-10-06T03:47:00Z"))).toEqual([]); // 3 min später, Zug noch nicht weg
    expect(dueLegs([l], at("2026-10-06T03:49:00Z"))).toEqual([0]); // prognostizierte Abfahrt erreicht
    expect(dueLegs([l], at("2026-10-06T03:54:00Z"))).toEqual([0]); // 10 min seit der letzten Messung
    expect(dueLegs([leg], at("2026-10-06T02:30:00Z"))).toEqual([]); // mehr als 1 h vorher
    expect(dueLegs([leg], at("2026-10-06T02:50:00Z"))).toEqual([0]); // erste Messung
  });
});
