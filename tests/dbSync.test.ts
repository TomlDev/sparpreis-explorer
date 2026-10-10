import { beforeAll, describe, expect, it } from "vitest";
import { ensureReady } from "@/lib/bootstrap";
import { applyOrders, directionPrice } from "@/lib/trips/dbSync";
import { createTrip, getTrip } from "@/lib/trips/repo";

beforeAll(() => ensureReady());

const legs = (dep: string, arr: string) => [{ fromName: "Bochum Hbf", toName: "Triberg", plannedDeparture: dep, plannedArrival: arr }];

describe("DB-Kundenkonto: Meine Reisen", () => {
  it("summiert nur nicht stornierte Angebote einer Richtung", () => {
    expect(directionPrice([{ preis: { betrag: 20.99 } }, { preis: { betrag: 4.9 }, isStorniert: true }])).toBe(20.99);
    expect(directionPrice([{ preis: { betrag: 0.1 } }, { preis: { betrag: 0.2 } }])).toBe(0.3);
    expect(directionPrice([])).toBeNull();
  });

  it("trägt den Preis je Richtung in Hin- und Rückfahrt ein und meldet unbekannte Buchungen", () => {
    const out = createTrip({ orderNumber: "300000000001", direction: "outbound", roundTrip: true, price: 72.73, legs: legs("2026-10-06T03:48:00Z", "2026-10-06T10:42:00Z") });
    const back = createTrip({ orderNumber: "300000000001", direction: "return", roundTrip: true, price: 72.73, legs: legs("2026-10-09T14:25:00Z", "2026-10-09T19:49:00Z") });
    const orders = [
      {
        auftragsnummer: "300000000001",
        gesamtreisen: [
          {
            hinfahrt: { abfahrt: "2026-10-06T05:48:00", startort: "Bochum Hbf", zielort: "Triberg", name: "Super Sparpreis" },
            rueckfahrt: { abfahrt: "2026-10-09T16:25:00", startort: "Triberg", zielort: "Bochum Hbf", name: "Super Sparpreis" },
          },
        ],
      },
      { auftragsnummer: "300000000002", gesamtreisen: [{ hinfahrt: { abfahrt: "2026-11-02T07:00:00", startort: "Bochum Hbf", zielort: "Köln Hbf", name: "Sparpreis" } }] },
    ];
    const details = new Map([
      ["300000000001", { gesamtangebot: { hinfahrt: { angebote: [{ preis: { betrag: 20.99 } }] }, rueckfahrt: { angebote: [{ preis: { betrag: 51.74 } }] } } }],
    ]);
    const r = applyOrders(orders, details);
    expect(r.updated).toBe(2);
    expect(getTrip(out.id)!.ticket?.directionPrice).toBe(20.99);
    expect(getTrip(back.id)!.ticket?.directionPrice).toBe(51.74);
    expect(r.unknown).toEqual([{ orderNumber: "300000000002", date: "2026-11-02", from: "Bochum Hbf", to: "Köln Hbf", tariff: "Sparpreis" }]);
    // second run: nothing to change
    expect(applyOrders(orders, details).updated).toBe(0);
  });
});
