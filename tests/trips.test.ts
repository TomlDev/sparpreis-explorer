import fs from "node:fs";
import path from "node:path";
import { PDFDocument, PDFRadioGroup, PDFTextField } from "pdf-lib";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureReady } from "@/lib/bootstrap";
import { decrypt, encrypt } from "@/lib/trips/crypto";
import { getProfile, ibanValid, maskIban, setProfile } from "@/lib/trips/profile";
import { addEvent, createTrip, currentTrips, getTrip, legAt, updateEvent, updateTrip, uploadsDir } from "@/lib/trips/repo";
import { arrivalDelayMin, assess, liveHints } from "@/lib/trips/rules";

const T = "2026-10-15";
const legs = [
  { product: "regional", lineName: "RE 1", fromName: "Bochum Hbf", toName: "Essen Hbf", plannedDeparture: `${T}T07:00:00+02:00`, plannedArrival: `${T}T07:10:00+02:00` },
  { fromName: "Essen Hbf", toName: "Essen Hbf", plannedDeparture: `${T}T07:10:00+02:00`, plannedArrival: `${T}T07:12:00+02:00`, isWalking: true },
  { product: "nationalExpress", lineName: "ICE 101", fromName: "Essen Hbf", toName: "Köln Hbf", plannedDeparture: `${T}T07:14:00+02:00`, plannedArrival: `${T}T08:00:00+02:00` },
];

beforeAll(() => ensureReady());

describe("Fahrgastrechte-Regeln (laut DB-Merkblatt)", () => {
  const base = { status: "delayed", price: 40, plannedArrival: `${T}T08:00:00+02:00` };

  it("25 % ab 60 min, 50 % ab 120 min Verspätung am Ziel", () => {
    expect(assess({ ...base, actualArrival: `${T}T08:59:00+02:00` })).toBeNull();
    expect(assess({ ...base, actualArrival: `${T}T09:00:00+02:00` })).toMatchObject({ journey: "delay", amount: 10, payable: true });
    expect(assess({ ...base, actualArrival: `${T}T10:05:00+02:00` })).toMatchObject({ amount: 20 });
  });

  it("zahlt unter 4 € nichts aus und halbiert bei Hin- und Rückfahrt", () => {
    expect(assess({ ...base, price: 15, actualArrival: `${T}T09:10:00+02:00` })).toMatchObject({ amount: 3.75, payable: false });
    expect(assess({ ...base, price: 80, roundTrip: true, actualArrival: `${T}T09:10:00+02:00` })).toMatchObject({ amount: 10 });
  });

  it("erstattet bei Nichtantritt nur mit Zugausfall oder ≥ 60 min Prognose", () => {
    expect(assess({ ...base, status: "not_started", actualArrival: null, expectedDelayMin: 45 })).toMatchObject({ payable: false });
    expect(assess({ ...base, status: "not_started", actualArrival: null, expectedDelayMin: 70 })).toMatchObject({ amount: 40, payable: true });
    expect(assess({ ...base, status: "cancelled", actualArrival: null })).toMatchObject({ journey: "not_started", amount: 40 });
  });

  it("unterscheidet Abbruch mit Rückkehr (voll) und ohne (Anteil, rechnet die DB)", () => {
    const a = { ...base, status: "aborted", actualArrival: null, expectedDelayMin: 90 };
    expect(assess({ ...a, returnedToStart: true })).toMatchObject({ journey: "aborted_return", amount: 40 });
    expect(assess(a)).toMatchObject({ amount: null, payable: true });
  });

  it("gibt Hinweise ab 20 bzw. 60 min", () => {
    expect(liveHints(15)).toHaveLength(0);
    expect(liveHints(25)[0]).toMatch(/Zugbindung aufgehoben/);
    expect(liveHints(65)).toHaveLength(2);
    expect(arrivalDelayMin(`${T}T08:00:00+02:00`, `${T}T08:42:00+02:00`)).toBe(42);
  });
});

describe("Persönliche Daten", () => {
  it("verschlüsselt und prüft die IBAN", () => {
    const blob = encrypt("DE89370400440532013000");
    expect(blob).not.toContain("DE89");
    expect(decrypt(blob)).toBe("DE89370400440532013000");
    expect(ibanValid("DE89 3704 0044 0532 0130 00")).toBe(true);
    expect(ibanValid("DE88370400440532013000")).toBe(false);
    expect(maskIban("DE89370400440532013000")).toBe("DE89 •••• •••• 3000");
  });

  it("speichert das Profil nur verschlüsselt", () => {
    setProfile({ firstName: "Erika", lastName: "Mustermann", iban: "de89 3704 0044 0532 0130 00" });
    expect(getProfile()).toMatchObject({ firstName: "Erika", iban: "DE89370400440532013000" });
  });
});

describe("Reisen", () => {
  it("legt Fahrten an, ohne Duplikate beim zweiten „Gebucht“", () => {
    const a = createTrip({ legs, fingerprint: "fp1", source: "search", price: 40 });
    const b = createTrip({ legs, fingerprint: "fp1", source: "search" });
    expect(b.id).toBe(a.id);
    expect(a).toMatchObject({ date: T, originName: "Bochum Hbf", destName: "Köln Hbf", status: "planned" });
  });

  it("ordnet eine Kontrolle dem Zug zu, in dem man gerade sitzt", () => {
    const at = (hhmm: string) => new Date(`${T}T${hhmm}:00+02:00`).getTime();
    expect(legAt(legs, at("06:00"))).toBeNull();
    expect(legAt(legs, at("07:05"))).toBe(0);
    expect(legAt(legs, at("07:11"))).toBe(2); // ICE departs 07:14 (5 min boarding window)
    expect(legAt(legs, at("07:40"))).toBe(2);
    const trip = createTrip({ legs, fingerprint: "fp2" });
    const ev = addEvent(trip.id, { type: "control", at: at("07:30"), lat: 51.4, lng: 7.0, accuracy: 12 });
    expect(ev.legIndex).toBe(2);
    expect(getTrip(trip.id)!.events).toHaveLength(1);
    // corrected afterwards: earlier time (→ first train), location set by hand on the map
    const fixed = updateEvent(ev.id, { at: at("07:05"), lat: 51.45, lng: 7.01, accuracy: null })!;
    expect(fixed).toMatchObject({ legIndex: 0, lat: 51.45, lng: 7.01, accuracy: null });
    expect(updateEvent(ev.id, { lat: null, lng: null })).toMatchObject({ lat: null, lng: null });
  });

  it("findet die Fahrten von heute und speichert, was passiert ist", () => {
    // A trip under way right now (works at any time of day, also around midnight).
    const dep = new Date(Date.now() - 5 * 60_000).toISOString();
    const t = createTrip({
      legs: [{ fromName: "A", toName: "B", plannedDeparture: dep, plannedArrival: new Date(Date.now() + 3600_000).toISOString() }],
    });
    expect(t.date).toBe(new Date(dep).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" }));
    expect(currentTrips().map((x) => x.id)).toContain(t.id);
    const u = updateTrip(t.id, { status: "aborted", abortedAt: "A", expectedDelayMin: 80, returnedToStart: true })!;
    expect(u).toMatchObject({ status: "aborted", expectedDelayMin: 80, returnedToStart: true });
    expect(() => updateTrip(t.id, { status: "kaputt" })).toThrow();
  });
});

const cachedForm = path.join(path.dirname(uploadsDir()), "forms", "fahrgastrechte-formular.pdf");
const localForm = path.resolve("data/forms/fahrgastrechte-formular.pdf");

describe.skipIf(!fs.existsSync(localForm))("Offizielles Formular", () => {
  it("füllt Reise, Ticket, Person und Konto aus", async () => {
    fs.mkdirSync(path.dirname(cachedForm), { recursive: true });
    fs.copyFileSync(localForm, cachedForm);
    const { fillClaimForm } = await import("@/lib/trips/claimForm");
    const trip = updateTrip(createTrip({ legs, fingerprint: "fp3", orderNumber: "123456789012" }).id, {
      status: "delayed",
      actualArrival: `${T}T09:17:00+02:00`,
    })!;
    const profile = setProfile({
      salutation: "Frau",
      firstName: "Erika",
      lastName: "Mustermann",
      street: "Heidestraße",
      houseNumber: "17",
      postcode: "51147",
      city: "Köln",
      iban: "DE89370400440532013000",
      bic: "COBADEFFXXX",
      email: "erika@example.org",
    });
    const pdf = await PDFDocument.load(await fillClaimForm({ trip, profile, journey: "delay" }));
    const f = pdf.getForm();
    const text = (n: string) => (f.getField(n) as PDFTextField).getText();
    expect((f.getField("journey") as PDFRadioGroup).getSelected()).toMatch(/^Verspätung am Ziel/);
    expect([text("planned_day"), text("planned_month"), text("planned_year")]).toEqual(["15", "10", "26"]);
    expect([text("planned_departure_station"), text("planned_departure_hours"), text("planned_departure_minutes")]).toEqual(["Bochum Hbf", "07", "00"]);
    expect([text("arrived_hours"), text("arrived_minutes")]).toEqual(["09", "17"]);
    expect(text("ticket_digital_number")).toBe("123456789012");
    expect(text("compensation_iban")).toBe("DE89370400440532013000");
    expect(text("compensation_accountholder")).toBe("Mustermann, Erika");
    expect((f.getField("personal") as PDFRadioGroup).getSelected()).toBe("Frau");
  });
});
