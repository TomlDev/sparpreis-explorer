import { beforeAll, describe, expect, it } from "vitest";
import { ensureReady } from "@/lib/bootstrap";
import { assess, movedNotes } from "@/lib/trips/rules";
import { createTrip, getTrip, moveTrip, unmoveTrip, updateTrip } from "@/lib/trips/repo";

beforeAll(() => ensureReady());

const legs = (day: string) => [
  {
    product: "nationalExpress",
    lineName: "ICE 100",
    fromName: "Bochum Hbf",
    toName: "Offenburg",
    plannedDeparture: `${day}T08:12:00+02:00`,
    plannedArrival: `${day}T12:40:00+02:00`,
    rtLive: { dep: `${day}T08:30:00+02:00`, arr: null, final: false, source: "live" as const, checkedAt: 1 },
  },
];

describe("Ticket an einem anderen Tag genutzt", () => {
  it("kopiert die Züge auf den neuen Tag (gleiche Uhrzeit trotz Zeitumstellung) mit den Ticketdaten", () => {
    const a = createTrip({ legs: legs("2026-10-24"), orderNumber: "900000000001", price: 29.99, ticketType: "Sparpreis", direction: "outbound" });
    updateTrip(a.id, { expectedDelayMin: 75 });
    const b = moveTrip(a.id, { date: "2026-10-26" });
    expect(b).toMatchObject({ date: "2026-10-26", orderNumber: "900000000001", price: 29.99, movedFrom: a.id, source: "copy" });
    // 25.10. ends summer time: 08:12 stays 08:12 local (= 07:12 UTC instead of 06:12)
    expect(new Date(b.plannedDeparture!).toISOString()).toBe("2026-10-26T07:12:00.000Z");
    expect(b.legs[0].rtLive).toBeUndefined(); // the original's tracking stays with the original
    const orig = getTrip(a.id)!;
    expect(orig).toMatchObject({ status: "moved", plan: "skip" });
    expect(orig.movedTo?.id).toBe(b.id);
    expect(getTrip(b.id)!.movedFromTrip?.id).toBe(a.id);
    expect(() => moveTrip(a.id, { date: "2026-10-27" })).toThrow(/schon eine Ersatzfahrt/);

    unmoveTrip(a.id);
    expect(getTrip(a.id)).toMatchObject({ status: "planned", plan: null });
    expect(getTrip(b.id)).toBeNull(); // untouched copy is removed
  });

  it("verknüpft eine schon eingetragene Fahrt und ergänzt nur fehlende Ticketdaten", () => {
    const a = createTrip({ legs: legs("2026-11-20"), orderNumber: "900000000002", price: 19.99 });
    const c = createTrip({ legs: legs("2026-11-21"), price: 17 });
    const b = moveTrip(a.id, { date: "2026-11-21", targetId: c.id });
    expect(b).toMatchObject({ id: c.id, orderNumber: "900000000002", price: 17, movedFrom: a.id, plan: "take" });
    unmoveTrip(a.id);
    expect(getTrip(c.id)).toMatchObject({ movedFrom: null }); // linked trip stays, only unlinked
  });

  it("Regeln: keine Ansprüche für die verschobene Fahrt, Hinweis bei der Ersatzfahrt", () => {
    expect(movedNotes(null).warnings[0]).toMatch(/erwartete Verspätung eintragen/);
    expect(movedNotes(15).warnings[0]).toMatch(/Zugbindung/);
    expect(movedNotes(75).warnings).toEqual([]);
    const e = assess({ status: "delayed", price: 40, plannedArrival: "2026-10-26T11:40:00Z", actualArrival: "2026-10-26T12:50:00Z", replacement: true })!;
    expect(e.amount).toBe(10);
    expect(e.caveats.join(" ")).toMatch(/Ersatzfahrt/);
  });
});
