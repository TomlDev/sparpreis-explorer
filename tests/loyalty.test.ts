import { beforeAll, describe, expect, it } from "vitest";
import { ensureReady } from "@/lib/bootstrap";
import { buildCalendar, calendarToken, tokenOk } from "@/lib/trips/calendarFeed";
import {
  activeBahnCard,
  applyBahnCardCancellation,
  parseBahnCardCancellation,
  getBahnCards,
  parseBahnCardOrder,
  parseBahnCardService,
  parsePoints,
  parsePromo,
  reminders,
  saveBahnCard,
  savePoints,
  updateBahnCard,
} from "@/lib/trips/loyalty";
import { createTrip } from "@/lib/trips/repo";

beforeAll(() => ensureReady());

const ORDER = `Hallo Frau Erika Mustermann, vielen Dank für Ihre BahnCard-Bestellung.
 Ihre Bestelldaten Auftragsnummer: 400000000001 Produkt: BahnCard 25 Aktion Herbst 2026 Inhaber: Erika Mustermann
 Gültigkeitsbeginn: 30.09.2026 Gesamtpreis: 29,99 EUR Die Zahlung …`;
const SERVICE = `Hallo Frau Erika Mustermann, wir freuen uns … Zur digitalen Nutzung Ihrer BahnCard mit der Nummer 7081400000001234 loggen Sie sich …`;

describe("BahnCard, BahnBonus, Aktionen", () => {
  it("liest Bestellung und Service-Mail und führt beide zu einer Karte zusammen", () => {
    expect(parseBahnCardOrder(ORDER)).toEqual({ product: "BahnCard 25 Aktion Herbst 2026", orderNumber: "400000000001", validFrom: "2026-09-30", price: 29.99 });
    expect(parseBahnCardService("(ID 1-X) Vielen Dank für Ihre Bestellung einer digitalen BahnCard 25", SERVICE)).toEqual({ product: "BahnCard 25", number: "7081400000001234" });
    saveBahnCard(parseBahnCardService("Bestellung einer digitalen BahnCard 25", SERVICE)!, new Date("2026-09-01T10:53:00Z"));
    saveBahnCard(parseBahnCardOrder(ORDER)!, new Date("2026-09-01T09:49:00Z"));
    const cards = getBahnCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      product: "BahnCard 25 Aktion Herbst 2026",
      number: "7081400000001234",
      validFrom: "2026-09-30",
      validUntil: "2027-09-29", // assumed: 1 year
      cancelBy: "2027-08-18", // assumed: 6 weeks before the end
      autoRenew: true,
      confirmed: false,
    });
    expect(activeBahnCard("2026-10-05")?.id).toBe(cards[0].id);
    expect(activeBahnCard("2026-09-01")).toBeNull();
    // user corrects the end date → deadline moves along
    updateBahnCard(cards[0].id, { validUntil: "2027-01-29", confirmed: true });
    expect(getBahnCards()[0]).toMatchObject({ validUntil: "2027-01-29", cancelBy: "2026-12-18", confirmed: true });
  });

  it("erkennt die Kündigungsbestätigung", () => {
    const c = parseBahnCardCancellation(
      "Bestätigung Ihrer Kündigung",
      "Hallo Frau Erika Mustermann, schade, dass Sie Ihre BahnCard 1234 kündigen möchten. Wir bestätigen Ihnen die Kündigung zum 29.09.2027.",
    );
    expect(c).toEqual({ last4: "1234", until: "2027-09-29" });
    expect(parseBahnCardCancellation("Buchungsbestätigung", "x")).toBeNull();
    const card = applyBahnCardCancellation(c!)!;
    expect(card).toMatchObject({ cancelled: true, validUntil: "2027-09-29", confirmed: true });
    updateBahnCard(card.id, { cancelled: false, validUntil: "2027-01-29" }); // restore for the following tests
  });

  it("liest den Punktestand und behält den neuesten", () => {
    const p = parsePoints("Erika Mustermann, deine Punkteübersicht vom 18.8.2026 2.145 Prämienpunkte 1.090 Statuspunkte Verfallende Prämienpunkte zum 30.9.2026 : 120 Dein tagesaktueller");
    expect(p).toEqual({ asOf: "2026-08-18", praemien: 2145, status: 1090, expiring: { date: "2026-09-30", points: 120 } });
    savePoints(p!);
    savePoints({ ...p!, asOf: "2026-05-10", praemien: 1 }); // older overview arrives later
    expect(reminders("2026-09-01").find((r) => r.kind === "points")).toMatchObject({ date: "2026-09-30", title: "120 BahnBonus-Punkte verfallen" });
  });

  it("findet die Frist einer Aktion", () => {
    const d = new Date("2026-08-05T11:40:00Z");
    expect(parsePromo("Fwd: [Aktion] Exklusive Tickets", "Hallo, Buche dein Ticket bis zum 7. August 2026 und reise …", d).deadline).toBe("2026-08-07");
    expect(parsePromo("x", "Deutsche Bahn Nur bis 7.8. Nur bei BahnBonus. Hallo …", d)).toMatchObject({ subject: "x", deadline: "2026-08-07" });
  });

  it("erinnert an die Kündigungsfrist und an offene Fahrten", () => {
    createTrip({ legs: [{ fromName: "A", toName: "B", plannedDeparture: "2026-09-01T08:00:00Z", plannedArrival: "2026-09-01T09:00:00Z" }] });
    const r = reminders("2026-10-02");
    expect(r.find((x) => x.id.startsWith("bc-cancel"))).toMatchObject({ date: "2026-12-18", kind: "bahncard" });
    expect(r.find((x) => x.kind === "trip")?.title).toMatch(/Wie lief die Fahrt A → B/);
  });

  it("eine gekündigte BahnCard gilt bis zum Ende weiter, ohne Kündigungs-Erinnerung", () => {
    const c = getBahnCards()[0];
    updateBahnCard(c.id, { cancelled: true });
    expect(activeBahnCard("2026-12-01")?.id).toBe(c.id);
    const r = reminders("2026-10-02").filter((x) => x.kind === "bahncard");
    expect(r.map((x) => x.id.split("-").slice(0, 2).join("-"))).toEqual(["bc-end"]);
    expect(r[0].detail).toMatch(/Gekündigt/);
  });

  it("liefert einen gültigen Kalender nur mit dem richtigen Token", () => {
    const t = calendarToken();
    expect(t.length).toBeGreaterThanOrEqual(32);
    expect(tokenOk(t)).toBe(true);
    expect(tokenOk("x".repeat(t.length))).toBe(false);
    const ics = buildCalendar("https://example.org");
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("SUMMARY:🚆 A → B");
    expect(ics).toMatch(/SUMMARY:⏰ BahnCard 25 Aktion Herbst 2026 läuft ab/); // cancelled above → no cancel reminder
    expect(ics.split("\r\n").every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
    const rotated = calendarToken(true);
    expect(rotated).not.toBe(t);
    expect(tokenOk(t)).toBe(false);
  });
});
