import { beforeAll, describe, expect, it } from "vitest";
import { ensureReady } from "@/lib/bootstrap";
import { berlinToIso } from "@/lib/time";
import { buildCalendar, calendarToken, tokenOk } from "@/lib/trips/calendarFeed";
import { applyConfirmation, applyDecision, parseClaimConfirmation, parseClaimDecision } from "@/lib/trips/claimMail";
import { countryCode, fit } from "@/lib/trips/claimForm";
import { importDocument, originalSender } from "@/lib/trips/importer";
import { reminders } from "@/lib/trips/loyalty";
import { addEvent, createTrip, getTrip, legAt, mergeTrips, updateTrip } from "@/lib/trips/repo";
import { assess } from "@/lib/trips/rules";
import { applyScheduleChange, germanDate, parseScheduleChange, saveVoucher } from "@/lib/trips/serviceMail";

beforeAll(() => ensureReady());

const D = "2026-12-03";
const at = (hhmm: string) => `${D}T${hhmm}:00+01:00`;

describe("Fahrgastrechte: keine falschen Angaben", () => {
  const base = { price: 80, plannedArrival: at("10:00"), actualArrival: null };

  it("Abbruch ohne Rückkehr erzeugt kein Formular-Kreuz „zurück zum Start“", () => {
    const e = assess({ ...base, status: "aborted", expectedDelayMin: 90, returnedToStart: false })!;
    expect(e.journey).toBeNull();
    expect(e.payable).toBe(true);
    expect(e.caveats.join(" ")).toMatch(/online beantragen/);
    expect(assess({ ...base, status: "aborted", expectedDelayMin: 90, returnedToStart: true })!.journey).toBe("aborted_return");
  });

  it("Zugausfall heißt „nicht gefahren“ und verweist sonst auf die Verspätung", () => {
    const e = assess({ ...base, status: "cancelled" })!;
    expect(e).toMatchObject({ journey: "not_started", amount: 80 });
    expect(e.caveats.join(" ")).toMatch(/Verspätet angekommen/);
  });

  it("rechnet auf den Cent genau", () => {
    expect(assess({ status: "delayed", price: 1.16 * 4 * 4, plannedArrival: at("10:00"), actualArrival: at("11:05") })!.amount).toBe(4.64);
    expect(assess({ status: "delayed", price: 18.57, plannedArrival: at("10:00"), actualArrival: at("12:05") })!.amount).toBe(9.29);
  });
});

describe("Fahrten", () => {
  const legs = [
    { product: "nationalExpress", lineName: "ICE 1", fromName: "A", toName: "B", plannedDeparture: at("08:00"), plannedArrival: at("10:00") },
    { product: "regional", lineName: "RB 2", fromName: "B", toName: "C", plannedDeparture: at("10:04"), plannedArrival: at("10:30") },
  ];
  it("ordnet eine Kontrolle kurz vor dem Umstieg noch dem ankommenden Zug zu", () => {
    const ms = (h: string) => new Date(at(h)).getTime();
    expect(legAt(legs, ms("09:59"))).toBe(0);
    expect(legAt(legs, ms("10:01"))).toBe(1);
    expect(legAt(legs, ms("07:56"))).toBe(0); // boarding window of the first train
  });

  it("übernimmt beim Zusammenführen alles, was eingetragen war", () => {
    const keep = createTrip({ legs, orderNumber: "500000000001", direction: "outbound", source: "email" });
    const drop = createTrip({ legs: [legs[0]], orderNumber: "500000000001", source: "claim" });
    updateTrip(drop.id, { status: "delayed", actualArrival: at("11:20"), returnedToStart: true });
    addEvent(drop.id, { type: "control", at: new Date(at("09:00")).getTime() });
    const merged = mergeTrips(keep.id, drop.id)!;
    expect(merged).toMatchObject({ status: "delayed", actualArrival: at("11:20"), returnedToStart: true });
    expect(getTrip(keep.id)!.events).toHaveLength(1);
    expect(getTrip(drop.id)).toBeNull();
  });

  it("Berliner Uhrzeit → Zeitpunkt, auch an den Tagen der Zeitumstellung", () => {
    expect(berlinToIso("2026-10-25", "01:30")).toBe("2026-10-24T23:30:00.000Z");
    expect(berlinToIso("2026-10-25", "03:30")).toBe("2026-10-25T02:30:00.000Z");
    expect(berlinToIso("2026-03-29", "01:30")).toBe("2026-03-29T00:30:00.000Z");
    expect(berlinToIso("", "10:00")).toBeNull();
  });
});

describe("Fahrgastrechte-Mails in beliebiger Reihenfolge", () => {
  const conf = (caseId: string, order: string, day: string, problem = "Fahrtabbruch unterwegs (Mainz Hbf)") =>
    parseClaimConfirmation(
      `Fall-ID ${caseId} - Auftragsnummer ${order} Start: Bochum Hbf , ${day}, 08:00 Uhr Ziel: Triberg , ${day}, 14:00 Uhr Problem: ${problem} Folgende`,
    )!;

  it("ein Antrag nach der Buchung setzt die Fahrt auf „abgebrochen“", () => {
    const t = createTrip({
      orderNumber: "500000000002",
      direction: "outbound",
      legs: [{ fromName: "Bochum Hbf", toName: "Triberg", plannedDeparture: "2026-12-04T07:00:00.000Z", plannedArrival: "2026-12-04T13:00:00.000Z" }],
    });
    const r = applyConfirmation(conf("26V50000001", "500000000002", "04.12.2026"), Date.now())!;
    expect(r.trip.id).toBe(t.id);
    expect(getTrip(t.id)).toMatchObject({ status: "aborted", abortedAt: "Mainz Hbf" });
  });

  it("Hin- und Rückfahrt: der Antrag zur Rückfahrt landet nicht bei der Hinfahrt", () => {
    const out = createTrip({
      orderNumber: "500000000003",
      direction: "outbound",
      legs: [{ fromName: "Bochum Hbf", toName: "Triberg", plannedDeparture: "2026-12-05T07:00:00.000Z", plannedArrival: "2026-12-05T13:00:00.000Z" }],
    });
    const r = applyConfirmation(conf("26V50000002", "500000000003", "08.12.2026"), Date.now())!;
    expect(r.trip.id).not.toBe(out.id);
    expect(r.trip.date).toBe("2026-12-08");
    expect(getTrip(out.id)!.claims).toHaveLength(0);
  });

  it("die Eingangsbestätigung nach dem Bescheid ergänzt Zeiten, Ort und Art", () => {
    const d = parseClaimDecision(`03.12.2026
Ihr Anliegen vom 01.12.2026 | Fall-ID 26V50000003
Auftragsnummer: 500000000004
Ihre Reise am 01.12.2026
Für die Beeinträchtigungen auf der Fahrt von Bochum Hbf nach Triberg entschuldigen wir uns.
Gern erläutern wir Ihnen die Gründe für unsere Entscheidung.
1. Verspätung unter 60 min: Ab einer Verspätung von 60 Minuten …
Wenn Sie weitere Fragen haben`)!;
    const first = applyDecision(d)!;
    expect(first.trip.plannedDeparture).toBeNull();
    applyConfirmation(conf("26V50000003", "500000000004", "01.12.2026"), new Date("2026-12-01T19:12:00Z").getTime());
    const t = getTrip(first.trip.id)!;
    expect(t).toMatchObject({ status: "aborted", abortedAt: "Mainz Hbf", plannedDeparture: "2026-12-01T07:00:00.000Z" });
    expect(t.claims[0]).toMatchObject({ type: "aborted_return", status: "rejected", submittedAt: new Date("2026-12-01T19:12:00Z").getTime() });
  });

  it("packt eine als Anhang weitergeleitete Fahrgastrechte-Mail aus", async () => {
    const inner = [
      "From: no-reply@bahn.de",
      "Subject: Fahrgastrechteantrag Eingangsbestätigung 26V50000004",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>Fall-ID 26V50000004 - Auftragsnummer 500000000005 Start: Bochum Hbf , 06.12.2026, 08:00 Uhr Ziel: Triberg , 06.12.2026, 14:00 Uhr Problem: Fahrtabbruch unterwegs (Köln Hbf) Folgende</p>",
    ].join("\r\n");
    const outer = ["From: ich@example.org", "Subject: Fwd: Antrag", 'Content-Type: multipart/mixed; boundary="Q"', "", "--Q", "Content-Type: text/plain", "", "s. Anhang", "--Q", "Content-Type: message/rfc822", "", inner, "--Q--", ""].join("\r\n");
    const r = await importDocument({ name: "fwd.eml", type: "message/rfc822", bytes: Buffer.from(outer) }, "email");
    expect(r.claims?.[0]).toMatchObject({ kind: "confirmation", caseId: "26V50000004" });
  });
});

describe("Fahrplanänderungen", () => {
  it("erkennt „Geänderte Fahrtzeiten“ und trägt jede Mitteilung nur einmal ein", () => {
    const t = createTrip({
      orderNumber: "500000000006",
      direction: "outbound",
      legs: [{ fromName: "A", toName: "B", plannedDeparture: "2026-12-07T08:00:00.000Z", plannedArrival: "2026-12-07T09:00:00.000Z" }],
    });
    const c = parseScheduleChange(
      "Fwd: Geänderte Fahrtzeiten für Ihre Reise nach B am 07. Dez. 2026",
      "es gibt Änderungen für Ihre Reise von A nach B am 07. Dez. 2026 : Ihre neue Abfahrtszeit mit Bus 240 in A ist 09:05 Uhr statt 09:04 Uhr. Grund … Auftragsnummer: 500000000006",
    )!;
    expect(c).toMatchObject({ date: "2026-12-07", zugbindungLifted: false });
    expect(c.details?.[0]).toMatch(/09:05 Uhr statt 09:04 Uhr/);
    const when = new Date("2026-12-01T10:00:00Z");
    applyScheduleChange(c, when);
    applyScheduleChange(c, when); // re-import
    applyScheduleChange(c, new Date("2026-11-20T10:00:00Z")); // an older notice arrives later
    const after = getTrip(t.id)!;
    expect(after.events).toHaveLength(2);
    expect(after.ticket?.scheduleChange?.notifiedAt).toBe(when.toISOString());
    expect(parseScheduleChange("Fahrplanänderung für Ihre Reise", "ohne Auftragsnummer")).toBeNull();
  });
});

describe("Robustheit", () => {
  it("verwirft unmögliche Daten und bleibt bei kaputten Einträgen bedienbar", () => {
    expect(germanDate("99.99.2026")).toBeNull();
    expect(germanDate("31.02.2026")).toBeNull();
    saveVoucher({ number: "BROKEN1", value: 5, validUntil: "2026-99-99", orderNumber: null }, new Date());
    expect(() => reminders()).not.toThrow();
    expect(() => buildCalendar("https://example.org")).not.toThrow();
  });

  it("maskiert Kalender-Text korrekt und vergleicht Tokens sicher", () => {
    createTrip({
      legs: [{ fromName: "Gl. 5; Platz 12", toName: "B\r\nX-EVIL:1", plannedDeparture: "2026-12-09T08:00:00.000Z", plannedArrival: null }],
    });
    const ics = buildCalendar("https://example.org");
    expect(ics).toContain("Gl. 5\\; Platz 12");
    expect(ics).not.toMatch(/\r\nX-EVIL:1/);
    const t = calendarToken();
    expect(tokenOk("ä".repeat(t.length))).toBe(false);
  });

  it("liest den Absender aus dem Weiterleitungskopf, auch mit &lt;…&gt;", () => {
    expect(originalSender("-------- Weitergeleitete Nachricht -------- Betreff: x Von: BahnBonus <info@mail.bahncard.bahn.de> An: y")).toBe(
      "info@mail.bahncard.bahn.de",
    );
  });

  it("kürzt lange Namen sinnvoll und nutzt Länderkürzel", () => {
    expect(fit("Frankfurt(M) Flughafen Fernbf", 26).length).toBeLessThanOrEqual(26);
    expect(fit("Frankfurt(M) Flughafen Fernbf", 26)).toMatch(/^Ffm Flugh\. Fbf/);
    expect([countryCode("Deutschland"), countryCode("Österreich"), countryCode("NL")]).toEqual(["", "A", "NL"]);
  });
});
