import { beforeAll, describe, expect, it } from "vitest";
import { ensureReady } from "@/lib/bootstrap";
import { parseBookingHtml, parseIcs, parseTicketText, productOf } from "@/lib/trips/importDb";
import { importDocument } from "@/lib/trips/importer";
import { looksLikeBooking } from "@/lib/trips/mailSync";
import { getTrip } from "@/lib/trips/repo";
import { ticketSpan } from "@/lib/trips/rules";

// Anonymised samples in the exact shape of a DB booking (calendar export + ticket PDF text).
const ICS = [
  "BEGIN:VCALENDAR",
  "PRODID:https://www.bahn.de",
  "BEGIN:VEVENT",
  "SUMMARY:Bochum - Musterweg 1 ➞ Stuttgart - Beispielstr. 2",
  "DESCRIPTION:Bochum - Musterweg 1 ➞ Stuttgart - Beispielstr. 2\\nDatum: 05.10.2026\\nKlasse: 2. Klasse\\n\\nB",
  " ochum - Musterweg 1 ➞ Bochum Hbf\\n● ab 14:09 Bochum - Musterweg 1\\n○ an 14:20 Bochum Hbf\\n\\nBochum Hbf ➞ Köln Hbf\\nICE 927\\n● ab 14:4",
  " 9 Bochum Hbf ▷ Gleis 5\\n○ an 15:48 Köln Hbf ▷ Gleis 7\\n\\nKöln Hbf ➞ Stuttgart Hbf\\nICE 611\\n● ab 15:54 Köln Hbf ▷ Gleis 6\\n○ an 18:11 Stuttgart Hbf ▷ Gleis 15\\n\\nHauptbf (Arnulf-Klett-Platz)\\, Stuttgart ➞ Wangen Stadtwerke\\, Stuttgart\\nSTB U9\\n● ab 18:37 Hauptbf (Arnulf-Klett-Platz)\\, Stuttgart\\n○ an 18:55 Wangen Stadtwerke\\, Stuttgart\\n\\nDauer: 4h 46min",
  "DTSTART:20261005T140900",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const TICKET = `CIV 1080
Online-Ticket
ICE Fahrkarte
Gültigkeit: 05.10.2026 00:00 Uhr bis 06.10.2026 10:00 Uhr
Super Sparpreis (Einfache Fahrt)
Klasse 2. Klasse
Reisender 1 Person (27-64 Jahre) mit 1 BC25
Einfache Fahrt Bochum+City Stuttgart+City
Via: <1080>(SG/D)*K*LM
Zugbindung ICE 927, 14:49 Uhr am 05.10.2026
ICE 611, 15:54 Uhr am 05.10.2026
Eine Stornierung Ihrer Fahrkarte ist ausgeschlossen.
Gesamtpreis 44,79 €. Gebucht am 12.09.2026 um 16:03 Uhr.
Erika Mustermann
Auftragsnummer: 100000000001
Ihre Reiseverbindung und Reservierung - Einfache Fahrt am 05.10.2026
Halt Datum Zeit Gleis Produkte Reservierung / Hinweise
Bochum Hbf
Köln Hbf
05.10.
05.10.
ab 14:49
an 15:48
5
7
ICE 927
Wg. 7, Pl. 45 Fenster
Köln Hbf
Stuttgart Hbf
05.10.
05.10.
ab 15:54
an 18:11
6
15
ICE 611
Hauptbf (Arnulf-Klett-Platz),
Stuttgart
Wangen Stadtwerke, Stuttgart
05.10.
05.10.
ab 18:37
an 18:55
STB U9
Wichtige Nutzungshinweise:
- …`;

beforeAll(() => ensureReady());

describe("DB-Buchung einlesen", () => {
  it("ordnet Linien Verkehrsmitteln zu", () => {
    expect(["ICE 927", "IC 2012", "RE 2", "RB 32", "S 9", "STR 301", "STB U9", "U 79", "Bus 510", "NWB 75", null].map(productOf)).toEqual([
      "nationalExpress",
      "national",
      "regionalExpress",
      "regional",
      "suburban",
      "tram",
      "subway",
      "subway",
      "bus",
      "regional",
      undefined,
    ]);
  });

  it("liest die Kalenderdatei inkl. Fußwegen und Gleisen", () => {
    const [j] = parseIcs(ICS, "BAHN_2026-10-05_Hinfahrt_.ics");
    expect(j.direction).toBe("outbound");
    expect(j.legs.map((l) => (l.isWalking ? "walk" : l.lineName))).toEqual(["walk", "ICE 927", "ICE 611", "STB U9"]);
    expect(j.legs[1]).toMatchObject({
      product: "nationalExpress",
      trainNumber: "927",
      fromName: "Bochum Hbf",
      depPlatform: "5",
      arrPlatform: "7",
      plannedDeparture: "2026-10-05T12:49:00.000Z",
    });
    expect(j.legs[3].fromName).toBe("Hauptbf (Arnulf-Klett-Platz), Stuttgart");
  });

  it("liest Tarif, Preis, BahnCard, Zugbindung und Züge aus dem Ticket-PDF", () => {
    const b = parseTicketText(TICKET);
    expect(b).toMatchObject({ orderNumber: "100000000001", price: 44.79, klasse: 2, roundTrip: false });
    expect(b.ticket).toMatchObject({
      tariff: "Super Sparpreis (Einfache Fahrt)",
      bahncard: "BC25",
      from: "Bochum+City",
      to: "Stuttgart+City",
      zugbindung: ["ICE 927, 14:49 Uhr am 05.10.2026", "ICE 611, 15:54 Uhr am 05.10.2026"],
    });
    const legs = b.journeys[0].legs;
    expect(legs.map((l) => `${l.lineName} ${l.fromName} → ${l.toName}`)).toEqual([
      "ICE 927 Bochum Hbf → Köln Hbf",
      "ICE 611 Köln Hbf → Stuttgart Hbf",
      "STB U9 Hauptbf (Arnulf-Klett-Platz), Stuttgart → Wangen Stadtwerke, Stuttgart",
    ]);
    expect(legs[1]).toMatchObject({ depPlatform: "6", arrPlatform: "15", plannedArrival: "2026-10-05T16:11:00.000Z" });
  });

  it("nimmt für Fahrgastrechte nur den Bahn-Teil (nicht U-Bahn/Fußweg)", () => {
    const [j] = parseIcs(ICS);
    const span = ticketSpan({ legs: j.legs, originName: "x", destName: "y", plannedDeparture: null, plannedArrival: null });
    expect(span).toMatchObject({ from: "Bochum Hbf", to: "Stuttgart Hbf", arrival: "2026-10-05T16:11:00.000Z" });
  });

  it("liest Auftragsnummer und Preis zur Not aus der HTML-Mail", () => {
    const html =
      "<p>Am 12.09.2026 wurde der Auftrag mit der Auftragsnummer 100000000001 wie folgt gebucht:</p><h2>Leistungen</h2><div>Super Sparpreis, 2. Klasse</div><td>Gesamtbetrag:</td><td>44,79 EUR</td>";
    expect(parseBookingHtml(html)).toMatchObject({ orderNumber: "100000000001", price: 44.79, tariff: "Super Sparpreis", klasse: 2 });
  });

  it("importiert eine Buchungsmail und legt sie beim zweiten Mal nicht doppelt an", async () => {
    const eml = [
      "From: noreply@deutschebahn.com",
      "Subject: Buchungsbestätigung Deutsche Bahn (Auftrag: 100000000002)",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="X"',
      "",
      "--X",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>Auftrag mit der Auftragsnummer 100000000002 wie folgt gebucht</p><h2>Leistungen</h2><div>Super Sparpreis, 2. Klasse</div><td>Gesamtbetrag:</td><td>44,79 EUR</td>",
      "--X",
      'Content-Type: text/calendar; charset=utf-8; name="BAHN_2026-10-05_Hinfahrt_.ics"',
      'Content-Disposition: attachment; filename="BAHN_2026-10-05_Hinfahrt_.ics"',
      "",
      ICS,
      "--X--",
      "",
    ].join("\r\n");
    const file = { name: "buchung.eml", type: "message/rfc822", bytes: Buffer.from(eml) };
    const first = await importDocument(file, "email");
    expect(first.created).toHaveLength(1);
    const t = first.created[0];
    expect(t).toMatchObject({ orderNumber: "100000000002", price: 44.79, date: "2026-10-05", direction: "outbound", source: "email" });
    expect(t.legs).toHaveLength(4);
    const again = await importDocument(file, "email");
    expect(again.created).toHaveLength(0);
    expect(again.updated.map((x) => x.id)).toEqual([t.id]);
    expect(getTrip(t.id)!.ticket).toMatchObject({ tariff: "Super Sparpreis" });
    // A less detailed source (here: no walk legs) must not replace the itinerary.
    const fewer = eml.replace(/\\n\\nB\r\n ochum - Musterweg 1 ➞ Bochum Hbf\\n● ab 14:09 Bochum - Musterweg 1\\n○ an 14:20 Bochum Hbf/, "\\n");
    expect(fewer).not.toBe(eml);
    const third = await importDocument({ ...file, bytes: Buffer.from(fewer) }, "email");
    expect(third.updated[0].legs).toHaveLength(4);
    // A bare .ics has no order number — still the same booking (same first train).
    const ics = await importDocument({ name: "BAHN_2026-10-05_Hinfahrt_.ics", type: "text/calendar", bytes: Buffer.from(ICS) }, "pdf");
    expect(ics.created).toHaveLength(0);
    expect(ics.updated[0]).toMatchObject({ id: t.id, orderNumber: "100000000002", price: 44.79 });
  });

  it("erkennt weitergeleitete Buchungen (GMX-Filter) und packt angehängte Mails aus", async () => {
    expect(looksLikeBooking("noreply@deutschebahn.com", "x", null)).toBe(true);
    expect(looksLikeBooking("ich@gmx.de", "WG: Buchungsbestätigung Deutsche Bahn (Auftrag: 1)", null)).toBe(true);
    expect(looksLikeBooking("ich@gmx.de", "Fwd", { childNodes: [{ type: "text/calendar", dispositionParameters: { filename: "BAHN_2026-10-05_Hinfahrt_.ics" } }] })).toBe(true);
    expect(looksLikeBooking("ich@gmx.de", "Fwd", { childNodes: [{ type: "message/rfc822" }] })).toBe(true);
    expect(looksLikeBooking("ich@gmx.de", "WG: Ihr Fahrgastrechteantrag – 26V1 – X", null)).toBe(true);
    expect(looksLikeBooking("ich@gmx.de", "Fwd", { childNodes: [{ dispositionParameters: { filename: "Ablehnung-26V00000002.pdf" } }] })).toBe(true);
    expect(looksLikeBooking("newsletter@example.org", "Angebot", { type: "text/plain" })).toBe(false);

    const original = [
      "From: noreply@deutschebahn.com",
      "Subject: Buchungsbestätigung Deutsche Bahn (Auftrag: 100000000003)",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="Y"',
      "",
      "--Y",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>Auftragsnummer 100000000003</p><h2>Leistungen</h2><div>Super Sparpreis, 2. Klasse</div><td>Gesamtbetrag:</td><td>19,99 EUR</td>",
      "--Y",
      'Content-Type: text/calendar; charset=utf-8; name="BAHN_2026-11-05_Hinfahrt_.ics"',
      "",
      ICS.replace("20261005", "20261105").replace(/05\.10\.2026/g, "05.11.2026"),
      "--Y--",
      "",
    ].join("\r\n");
    const forwarded = [
      "From: ich@gmx.de",
      "Subject: WG: Buchungsbestätigung Deutsche Bahn",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="Z"',
      "",
      "--Z",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "siehe Anhang",
      "--Z",
      'Content-Type: message/rfc822; name="buchung.eml"',
      "",
      original,
      "--Z--",
      "",
    ].join("\r\n");
    const r = await importDocument({ name: "fwd.eml", type: "message/rfc822", bytes: Buffer.from(forwarded) }, "email");
    expect(r.created).toHaveLength(1);
    expect(r.created[0]).toMatchObject({ orderNumber: "100000000003", price: 19.99, date: "2026-11-05" });
  });
});
