import { beforeAll, describe, expect, it } from "vitest";
import { ensureReady } from "@/lib/bootstrap";
import { applyConfirmation, applyDecision, parseClaimConfirmation, parseClaimDecision } from "@/lib/trips/claimMail";
import { createTrip, getTrip, saveClaim } from "@/lib/trips/repo";

// Anonymised samples in the shape of DB's passenger-rights mails.
const CONFIRMATION = `Hallo Frau Erika Mustermann,
 hiermit bestätigen wir Ihnen den Erhalt Ihres
 Fahrgastrechte-Antrages zu Ihrer Reise mit der
 Auftragsnummer 200000000001
 Folgende Angaben haben wir von Ihnen erhalten:
 Fall-ID 26V00000001 -
 Angaben zum Reiseverlauf:
 Start: Bochum Hbf ,
 05.08.2026, 03:54
 Uhr
 Ziel: Neueck, Triberg im Schwarzwald ,
 05.08.2026, 11:39
 Uhr
 Problem:
 Fahrtabbruch unterwegs (Freiburg(Breisgau) Hbf)
Folgende zusätzliche Belege haben Sie angegeben:
 Andere Belege: nein
 Persönliche Angaben
 Auszahlung via:
 Überweisung (IBAN: ******************1234)`;

const PAID = `Frau Erika Mustermann
Musterweg 1
44892 Bochum
03.09.2026
Ihr Anliegen vom 12.08.2026 | Fall-ID 26V00000001
Auftragsnummer: 200000000001
Ihre Reise am 05.08.2026
Hallo Frau Mustermann,
Für die Beeinträchtigungen auf der Fahrt von Bochum Hbf nach Neueck, Triberg
im Schwarzwald entschuldigen wir uns im Auftrag der DB Regio AG.
Wir bedauern die Ihnen entstandenen Unannehmlichkeiten und haben im Auftrag der DB Regio AG am
03.09.2026 den Betrag von 28,49 Euro auf das von Ihnen genannte Bankkonto angewiesen.
Gern erläutern wir Ihnen die Gründe für unsere Entscheidung.
1. Fahrtabbruch:
Auf Ihrer Fahrt hatten Sie eine Verspätung von mehr als 60 Minuten am Zielbahnhof zu erwarten und
haben deswegen die Reise abgebrochen. Sie erhalten den Wert der nicht genutzten Fahrt erstattet.
Wenn Sie weitere Fragen haben, rufen Sie uns bitte an.`;

const REJECTED = `21.09.2026
Ihr Anliegen vom 21.09.2026 | Fall-ID 26V00000002
Auftragsnummer: 200000000002
Ihre Reise am 19.09.2026
Für die Beeinträchtigungen auf der Fahrt von Triberg nach
Bochum Hbf entschuldigen wir uns im Auftrag der DB Fernverkehr AG.
Belege zu Ihrer Reise vom 19.09.2026 mit 11 min Verspätung am Zielort:
1. BX0YKJLR Verspätung unter 60 min 44,24 Euro 0,00 Euro
Wir bitten Sie um Verständnis, dass in Ihrem Fall keine Entschädigung gezahlt werden kann.
Gern erläutern wir Ihnen die Gründe für unsere Entscheidung.
1. Verspätung unter 60 min:
Ab einer Verspätung von 60 Minuten am Zielbahnhof besteht Anspruch auf eine Entschädigung.
Wenn Sie weitere Fragen haben, rufen Sie uns bitte an.`;

beforeAll(() => ensureReady());

describe("Fahrgastrechte-Post der DB", () => {
  it("liest die Eingangsbestätigung", () => {
    expect(parseClaimConfirmation(CONFIRMATION)).toEqual({
      caseId: "26V00000001",
      orderNumber: "200000000001",
      from: "Bochum Hbf",
      to: "Neueck, Triberg im Schwarzwald",
      departure: "2026-08-05T01:54:00.000Z",
      arrival: "2026-08-05T09:39:00.000Z",
      problem: "Fahrtabbruch unterwegs (Freiburg(Breisgau) Hbf)",
      abortedAt: "Freiburg(Breisgau) Hbf",
      payout: "transfer",
    });
  });

  it("liest Auszahlung und Ablehnung", () => {
    expect(parseClaimDecision(PAID)).toMatchObject({
      caseId: "26V00000001",
      orderNumber: "200000000001",
      travelDate: "2026-08-05",
      submittedDate: "2026-08-12",
      decidedDate: "2026-09-03",
      from: "Bochum Hbf",
      to: "Neueck, Triberg im Schwarzwald",
      paid: true,
      amount: 28.49,
      items: ["Fahrtabbruch"],
    });
    expect(parseClaimDecision(REJECTED)).toMatchObject({
      caseId: "26V00000002",
      paid: false,
      amount: 0,
      delayMin: 11,
      ticketValue: 44.24,
      items: ["Verspätung unter 60 min"],
    });
  });

  it("verknüpft Eingang und Bescheid mit dem Antrag aus der App", () => {
    // Trip known (imported booking), claim form generated in the app → no case id yet.
    const trip = createTrip({
      orderNumber: "200000000001",
      legs: [{ fromName: "Bochum Hbf", toName: "Triberg", plannedDeparture: "2026-08-05T01:54:00.000Z", plannedArrival: "2026-08-05T09:39:00.000Z" }],
    });
    const draft = saveClaim(trip.id, { type: "aborted_return", amount: 28.49 });
    const conf = applyConfirmation(parseClaimConfirmation(CONFIRMATION)!, Date.UTC(2026, 7, 12))!;
    expect(conf.tripCreated).toBe(false);
    expect(conf.claim).toMatchObject({ id: draft.id, caseId: "26V00000001", status: "submitted" });
    const dec = applyDecision(parseClaimDecision(PAID)!)!;
    expect(dec.claim).toMatchObject({ id: draft.id, status: "paid", paidAmount: 28.49 });
    expect(getTrip(trip.id)!.claims).toHaveLength(1);
  });

  it("legt eine unbekannte Reise aus dem Bescheid an", () => {
    const r = applyDecision(parseClaimDecision(REJECTED)!)!;
    expect(r.tripCreated).toBe(true);
    expect(r.trip).toMatchObject({ date: "2026-09-19", source: "claim", status: "delayed", originName: "Triberg", destName: "Bochum Hbf" });
    expect(r.claim).toMatchObject({ status: "rejected", delayMin: 11 });
    expect(getTrip(r.trip.id)!.price).toBe(44.24); // ticket value from the letter
    // same letter again → same claim, no new trip
    const again = applyDecision(parseClaimDecision(REJECTED)!)!;
    expect(again.tripCreated).toBe(false);
    expect(again.claim.id).toBe(r.claim.id);
  });
});
