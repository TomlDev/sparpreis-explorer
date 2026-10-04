import { beforeAll, describe, expect, it } from "vitest";
import { ensureReady } from "@/lib/bootstrap";
import { applyDecision, parseClaimDecision } from "@/lib/trips/claimMail";
import { parseIcs, parseTicketText, trainNumberOf } from "@/lib/trips/importDb";
import { createTrip, getTrip, mergeClaimDuplicates } from "@/lib/trips/repo";
import { applyScheduleChange, germanDate, parseScheduleChange, parseVoucher } from "@/lib/trips/serviceMail";

beforeAll(() => ensureReady());

const ev = (start: string, date: string, from: string, to: string) =>
  [
    "BEGIN:VEVENT",
    `SUMMARY:${from} ➞ ${to}`,
    `DESCRIPTION:${from} ➞ ${to}\\nDatum: ${date}\\nKlasse: 2. Klasse\\n\\n${from} ➞ ${to}\\nRE42 (10102)\\n● ab 05:34 ${from} ▷ Gleis 3\\n○ an 06:10 ${to} ▷ Gleis 1`,
    `DTSTART:${start}`,
    "END:VEVENT",
  ].join("\r\n");

describe("weitere DB-Mails", () => {
  it("trennt Hin- und Rückfahrt einer Kalenderdatei", () => {
    const ics = ["BEGIN:VCALENDAR", ev("20261127T153900", "27.11.2026", "Triberg", "Bochum Hbf"), ev("20261124T053400", "24.11.2026", "Bochum Hbf", "Triberg"), "END:VCALENDAR"].join("\r\n");
    const j = parseIcs(ics, "BAHN_2026-11-24_Hinrueckfahrt_.ics");
    expect(j.map((x) => [x.direction, x.legs[0].fromName, x.legs[0].plannedDeparture?.slice(0, 10)])).toEqual([
      ["outbound", "Bochum Hbf", "2026-11-24"],
      ["return", "Triberg", "2026-11-27"],
    ]);
    expect(j[0].legs[0]).toMatchObject({ lineName: "RE42 (10102)", trainNumber: "10102", product: "regionalExpress" });
    expect([trainNumberOf("ICE 927"), trainNumberOf("RE42 (10102)"), trainNumberOf("STB U9")]).toEqual(["927", "10102", undefined]);
  });

  it("erkennt reine Sitzplatzreservierungen (kein Fahrpreis)", () => {
    const b = parseTicketText(`CIV 1080
Reservierung
Ihre Reiseverbindung und Reservierung - Hinfahrt am 24.04.2026
Halt Datum Zeit Gleis Produkte Reservierung / Hinweise
Bochum Hbf
Duisburg Hbf
24.04.
24.04.
ab 14:13
an 14:36
5
1 B-D
ICE 1033 2 Sitzplätze, Wg. 2, Pl. 31 33, 1 Fenster, 1 Gang,
Großraum, Ruhebereich, Res.-Nr. 800000000001
Nutzungshinweise:
Gesamtpreis 11,00 €.
Auftragsnummer: 300000000001`);
    expect(b.price).toBeNull();
    expect(b.ticket).toMatchObject({ reservationOnly: true, reservationPrice: 11, tariff: "Sitzplatzreservierung (kein Fahrschein)" });
    expect(b.journeys[0].legs[0]).toMatchObject({ lineName: "ICE 1033", depPlatform: "5", arrPlatform: "1 B-D", reservation: "Wg. 2, Pl. 31 33" });
  });

  it("hängt eine Fahrplanänderung an die Fahrt (Zugbindung aufgehoben)", () => {
    expect(germanDate("am 09. Okt. 2026")).toBe("2026-10-09");
    expect(germanDate("3. März 2026")).toBe("2026-03-03");
    const trip = createTrip({
      orderNumber: "300000000002",
      direction: "return",
      legs: [{ fromName: "Triberg", toName: "Bochum Hbf", plannedDeparture: "2026-10-09T13:40:00.000Z", plannedArrival: "2026-10-09T19:49:00.000Z" }],
    });
    const c = parseScheduleChange(
      "Fwd: Fahrplanänderung für Ihre Reise nach Bochum Hbf am 09. Okt. 2026",
      "Guten Tag, es gibt für Ihre Reise von Triberg nach Bochum Hbf am 09. Okt. 2026 Änderungen im Fahrplan. Die Zugbindung ist für Ihre Fahrt aufgehoben. Auftragsnummer: 300000000002",
    )!;
    expect(c).toMatchObject({ orderNumber: "300000000002", date: "2026-10-09", from: "Triberg", zugbindungLifted: true });
    const t = applyScheduleChange(c, new Date("2026-10-02T10:00:00Z"))!;
    expect(t.ticket?.scheduleChange).toMatchObject({ zugbindungLifted: true });
    applyScheduleChange(c, new Date("2026-10-02T10:00:00Z")); // same mail twice
    expect(getTrip(trip.id)!.events).toHaveLength(1);
  });

  it("liest Gutscheine", () => {
    expect(
      parseVoucher("Fwd: Ihr Gutschein der Deutschen Bahn (Auftrag: 300000000003)", "Gutscheinnummer: ABCDEFG Gutscheinwert: 9,30 EUR Gültig bis: 27.11.2030"),
    ).toEqual({ number: "ABCDEFG", value: 9.3, validUntil: "2030-11-27", orderNumber: "300000000003" });
    expect(parseVoucher("Buchungsbestätigung", "x")).toBeNull();
  });

  it("führt die Fahrt aus einem Bescheid mit der später importierten Buchung zusammen", () => {
    const r = applyDecision(
      parseClaimDecision(`03.09.2026
Ihr Anliegen vom 12.08.2026 | Fall-ID 26V00000009
Auftragsnummer: 300000000004
Ihre Reise am 05.08.2026
Für die Beeinträchtigungen auf der Fahrt von Bochum Hbf nach Triberg entschuldigen wir uns.
den Betrag von 28,49 Euro auf das von Ihnen genannte Bankkonto angewiesen.
1. 05.08.26 ADRMVNNG - Fahrtabbruch 28,49 Euro 28,49 Euro
Gern erläutern wir Ihnen die Gründe für unsere Entscheidung.
1. Fahrtabbruch: Sie erhalten den Wert der nicht genutzten Fahrt erstattet.
Wenn Sie weitere Fragen haben`)!,
    )!;
    const booking = createTrip({
      orderNumber: "300000000004",
      direction: "outbound",
      source: "email",
      legs: [{ fromName: "Bochum Hbf", toName: "Triberg", lineName: "ICE 101", product: "nationalExpress", plannedDeparture: "2026-08-05T01:54:00.000Z", plannedArrival: "2026-08-05T09:39:00.000Z" }],
    });
    expect(mergeClaimDuplicates()).toBeGreaterThanOrEqual(1);
    expect(getTrip(r.trip.id)).toBeNull();
    const merged = getTrip(booking.id)!;
    expect(merged.status).toBe("aborted");
    expect(merged.claims[0]).toMatchObject({ caseId: "26V00000009", status: "paid" });
  });
});

describe("Reihenfolge-unabhängig", () => {
  it("ordnet eine Fahrplanänderung zu, die vor der Buchung ankam", async () => {
    const { rememberScheduleChange, applyPendingScheduleChanges } = await import("@/lib/trips/serviceMail");
    const c = parseScheduleChange("Fahrplanänderung für Ihre Reise nach X am 12. Dez. 2026", "Reise von A nach X am 12. Dez. 2026 Die Zugbindung ist für Ihre Fahrt aufgehoben. Auftragsnummer: 300000000005")!;
    expect(applyScheduleChange(c, new Date())).toBeNull();
    rememberScheduleChange(c, new Date("2026-12-01T08:00:00Z"));
    const t = createTrip({ orderNumber: "300000000005", direction: "outbound", legs: [{ fromName: "A", toName: "X", plannedDeparture: "2026-12-12T08:00:00.000Z", plannedArrival: "2026-12-12T10:00:00.000Z" }] });
    expect(applyPendingScheduleChanges()).toBe(1);
    expect(getTrip(t.id)!.ticket?.scheduleChange?.zugbindungLifted).toBe(true);
    expect(applyPendingScheduleChanges()).toBe(0);
  });

  it("liest Sitzplätze aus der Kalenderdatei", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "DESCRIPTION:A ➞ B\\nDatum: 24.04.2026\\n\\nA ➞ B\\n[Reservierung: 2 Sitzplätze\\, Wg. 2\\, Pl. 31 33]\\nICE 1033\\n● ab 14:13 A ▷ Gleis 5\\n○ an 14:36 B ▷ Gleis 1 B-D",
      "DTSTART:20260424T141300",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    expect(parseIcs(ics)[0].legs[0]).toMatchObject({ lineName: "ICE 1033", isWalking: false, reservation: "Wg. 2, Pl. 31 33", arrPlatform: "1 B-D" });
  });
});

describe("weitergeleitete Mails", () => {
  it("nimmt das Originaldatum aus dem Weiterleitungs-Kopf", async () => {
    const { originalDate } = await import("@/lib/trips/importer");
    const body = " -------- Weitergeleitete Nachricht -------- Betreff: Ihr Gutschein Datum: Sat, 12 Sep 2026 14:03:57 +0000 (UTC) Von: noreply@deutschebahn.com An: x@y";
    expect(originalDate(body)?.toISOString()).toBe("2026-09-12T14:03:57.000Z");
    expect(originalDate("kein Kopf")).toBeNull();
  });
});

describe("Zugtabelle im Ticket-PDF (Sonderfälle)", () => {
  it("liest Gleise in der ab/an-Zeile, vor der Linie und als 5a/b, ignoriert Hinweise und setzt Namen zusammen", () => {
    const b = parseTicketText(`CIV 1080
Online-Ticket
Super Sparpreis (Hin- und Rückfahrt)
Klasse 2. Klasse
Auftragsnummer: 300000000009
Ihre Reiseverbindung und Reservierung - Hinfahrt am 06.10.2026
Halt Datum Zeit Gleis Produkte Reservierung / Hinweise
Bochum Hbf
Köln Hbf
06.10.
06.10.
ab 05:48
an 06:48 6 D-G
ICE 101
Köln Hbf
Mainz Hbf
06.10.
06.10.
ab 06:53
an 09:21
5
5a/b
ICE 23 2 Sitzplätze, Wg. 7, Pl. 45 46, 1 Fenster,
Großraum, Ruhebereich, Res.-Nr. 800000000002
Bahnhof, Triberg im
Schwarzwald
Neueck, Schonach
im Schwarzwald
06.10.
06.10.
ab 12:05
an 12:42
Bus 240 Die Fahrkarte ist für diesen Abschnitt nicht gültig. Hier ist
eine weitere Fahrkarte erforderlich.
Mainz Hbf
Essen Hbf
06.10.
06.10.
ab 19:07
an 21:49
3 ICE 912
Ticketcode: XYZ Seite 1 / 2
Wichtige Nutzungshinweise:`);
    const legs = b.journeys[0].legs;
    expect(legs.map((l) => [l.lineName, l.fromName, l.toName, l.depPlatform, l.arrPlatform])).toEqual([
      ["ICE 101", "Bochum Hbf", "Köln Hbf", null, "6 D-G"],
      ["ICE 23", "Köln Hbf", "Mainz Hbf", "5", "5a/b"],
      ["Bus 240", "Bahnhof, Triberg im Schwarzwald", "Neueck, Schonach im Schwarzwald", null, null],
      ["ICE 912", "Mainz Hbf", "Essen Hbf", "3", null],
    ]);
    expect(legs[1].reservation).toBe("Wg. 7, Pl. 45 46");
  });
});
