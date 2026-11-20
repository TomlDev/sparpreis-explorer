import { beforeAll, describe, expect, it } from "vitest";
import { ensureReady } from "@/lib/bootstrap";
import { applyNavigatorTicket } from "@/lib/trips/importer";
import { getTrip } from "@/lib/trips/repo";
import { isImage, navigatorLegs, parseNavigatorTicket } from "@/lib/trips/ticketPhoto";

beforeAll(() => ensureReady());

// OCR text (tesseract) of the ticket screen in DB Navigator — anonymised.
const BACK = `08:31
Reiseplan Ticket BahnCard
Erika Mustermann
CIV 1080
Gültigkeit
ICE Fahrkarte (Rückfahrt)
Super Sparpreis
2. Klasse
1 Person (27-64 Jahre) mit 1 BC25
Von: 21.11.2026, 00:00 Uhr
Bis: 22.11.2026, 10:00 Uhr
Verbindung Rückfahrt mit ICE
Triberg - Bochum Hbf
Zugbindung:
ICE 278, 15:27 Uhr am 21.11.2026
ICE 516, 16:34 Uhr am 21.11.2026
ICE 624, 17:22 Uhr am 21.11.2026
Via: <1080>0G*KA*(LU/MA*F)*LM*K*(D/E)
Buchungsdetails
Gebucht am: 25.08.2026 um 09:52 Uhr
Auftrags-Nr: 300000000061
Gesamtpreis: 37,49 &
Konditionen`;
const OUT = BACK.replace("(Rückfahrt)", "(Hinfahrt)")
  .replace("Verbindung Rückfahrt", "Verbindung Hinfahrt")
  .replace("Triberg - Bochum Hbf", "Bochum Hbf - Triberg")
  .replace(/Zugbindung:\n(ICE .*\n){3}/, "Zugbindung: aufgehoben\n")
  .replace(/21\.11\.2026, 00:00/, "17.11.2026, 00:00")
  .replace(/22\.11\.2026, 10:00/, "18.11.2026, 10:00")
  .replace("37,49", "26,24");

describe("Ticket-Foto (DB Navigator)", () => {
  it("liest Richtung, Züge, Preis und Auftrag", () => {
    const n = parseNavigatorTicket(BACK)!;
    expect(n).toMatchObject({ direction: "return", orderNumber: "300000000061", price: 37.49, klasse: 2, from: "Triberg", to: "Bochum Hbf", date: "2026-11-21", zugbindungLifted: false });
    expect(n.trains.map((t) => `${t.line} ${t.time}`)).toEqual(["ICE 278 15:27", "ICE 516 16:34", "ICE 624 17:22"]);
    expect(n.ticket).toMatchObject({ tariff: "Super Sparpreis (Hin- und Rückfahrt)", bahncard: "BC25", travellers: "1 Person (27-64 Jahre)", bookedAt: "25.08.2026 um 09:52 Uhr", directionPrice: 37.49 });
    expect(n.ticket.zugbindung).toEqual(["ICE 278, 15:27 Uhr am 21.11.2026", "ICE 516, 16:34 Uhr am 21.11.2026", "ICE 624, 17:22 Uhr am 21.11.2026"]);
    const legs = navigatorLegs(n);
    expect(legs[0]).toMatchObject({ lineName: "ICE 278", fromName: "Triberg", toName: "Umstieg", plannedDeparture: "2026-11-21T14:27:00.000Z" });
    expect(legs.at(-1)).toMatchObject({ lineName: "ICE 624", toName: "Bochum Hbf" });
    expect(parseNavigatorTicket("Ein Foto vom Bahnhof")).toBeNull();
    expect(isImage({ name: "IMG_2900.PNG", type: "" })).toBe(true);
  });

  it("legt Hin- und Rückfahrt an, merkt die aufgehobene Zugbindung und rechnet den Gesamtpreis", () => {
    const img = (n: number) => ({ name: `IMG_${n}.png`, type: "image/png", bytes: Buffer.from(`png-${n}`) });
    const out = applyNavigatorTicket(parseNavigatorTicket(OUT)!, img(1), "photo").created[0];
    expect(out).toMatchObject({ date: "2026-11-17", direction: "outbound", originName: "Bochum Hbf", destName: "Triberg", price: 26.24 });
    expect(out.ticket?.scheduleChange?.zugbindungLifted).toBe(true);
    const back = applyNavigatorTicket(parseNavigatorTicket(BACK)!, img(2), "photo").created[0];
    expect(getTrip(back.id)!.price).toBe(63.73);
    expect(getTrip(out.id)!.price).toBe(63.73);
    expect(getTrip(back.id)!.attachments.map((a) => a.caption)).toEqual(["Ticket (Foto)"]);
    // the same screenshot again: no second trip, no second photo
    const again = applyNavigatorTicket(parseNavigatorTicket(BACK)!, img(2), "photo");
    expect(again.created).toHaveLength(0);
    expect(getTrip(back.id)!.attachments).toHaveLength(1);
  });
});
