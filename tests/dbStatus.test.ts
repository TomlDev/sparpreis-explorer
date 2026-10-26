import { describe, expect, it } from "vitest";
import type { DbTripStatus, TripLeg } from "@/db/schema";
import { matchKette, toStatus } from "@/lib/trips/dbStatus";
import { forecastText, tripForecast } from "@/lib/trips/forecast";
import { withRealtime } from "@/lib/trips/realtime";

const kette = (order: string, local: string, zugbindung = "AUFGEHOBEN", status = "FAHRBAR") => ({
  status,
  alternativensuche: "ALTERNATIVEN_KANN",
  auftrag: { auftragsnummer: order, zugbindung },
  origin: { name: "Bochum", dateTime: { local, offset: 120 } },
  destination: { name: "Triberg", dateTime: { local: "2026-10-15T19:14:00" }, rtDateTime: { local: "2026-10-15T19:14:00" } },
});

describe("DB-Reisebegleitung", () => {
  it("ordnet über Auftrag + Abfahrtszeit zu (Hin- und Rückfahrt haben dieselbe Auftragsnummer)", () => {
    const ketten = [kette("900001", "2026-10-15T08:27:00"), kette("900001", "2026-10-18T17:11:00", "BESTEHT"), kette("900002", "2026-10-15T08:27:00")];
    const trip = { orderNumber: "900001", plannedDeparture: "2026-10-18T15:11:00.000Z", date: "2026-10-18" };
    expect(matchKette(trip, ketten)?.auftrag?.zugbindung).toBe("BESTEHT");
    expect(matchKette({ ...trip, orderNumber: null }, ketten)).toBeNull();
    expect(toStatus(ketten[0], 5)).toEqual({ status: "FAHRBAR", zugbindung: "AUFGEHOBEN", alternativen: "ALTERNATIVEN_KANN", relevanteAbweichung: false, rtArrival: "2026-10-15T19:14:00", checkedAt: 5 });
  });

  it("das Urteil der DB geht vor – in beide Richtungen; veraltet (> 30 min) zählt es nicht", () => {
    const T = (hm: string) => `2026-11-24T${hm}:00+01:00`;
    const mk = (line: string, from: string, to: string, dep: string, arr: string): TripLeg => ({ lineName: line, product: "regionalExpress", fromName: from, toName: to, plannedDeparture: T(dep), plannedArrival: T(arr) });
    const live = (l: TripLeg, dep: string, arr: string) => withRealtime(l, { live: { dep: T(dep), arr: T(arr), final: false, source: "live", checkedAt: 1 } });
    // RE in 11:56, RB out 11:56 → the app alone calls the connection broken
    const legs = [live(mk("RE 7", "Wuppertal", "Köln", "11:04", "11:38"), "11:22", "11:56"), live(mk("RB 26", "Köln", "Mainz", "11:56", "14:58"), "11:56", "14:58")];
    expect(tripForecast(legs).level).toBe("lifted");
    const now = Date.parse("2026-11-24T10:00:00Z");
    const s = (zugbindung: string, status = "FAHRBAR", checkedAt = now): DbTripStatus => ({ status, zugbindung, alternativen: "ALTERNATIVEN_KANN", relevanteAbweichung: true, rtArrival: null, checkedAt });
    const kept = tripForecast(legs, null, s("BESTEHT"), now);
    expect(kept).toMatchObject({ level: "ok", source: "db" });
    expect(forecastText(kept, "Mainz")).toMatch(/laut DB besteht die Zugbindung/);
    const lifted = tripForecast(legs, null, s("AUFGEHOBEN"), now);
    expect(lifted).toMatchObject({ level: "lifted", source: "db" });
    expect(forecastText(lifted, "Mainz")).toBe("Laut DB: Zugbindung aufgehoben · fahrbar · Alternative möglich");
    expect(tripForecast(legs, null, s("BESTEHT", "NICHT_REKONSTRUIERBAR"), now).level).toBe("lifted");
    expect(tripForecast(legs, null, s("BESTEHT", "FAHRBAR", now - 31 * 60_000), now).source).toBeUndefined();
  });
});
