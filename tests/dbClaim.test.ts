import { describe, expect, it } from "vitest";
import { buildSubmission, onlineClaimType } from "@/lib/trips/dbClaim";
import { EMPTY_PROFILE } from "@/lib/trips/profile";

const profile = {
  ...EMPTY_PROFILE,
  salutation: "Herr" as const,
  firstName: "Max",
  lastName: "Mustermann",
  street: "Musterweg",
  houseNumber: "1",
  postcode: "44892",
  city: "Bochum",
  email: "max@example.org",
  iban: "DE89370400440532013000",
  payout: "transfer" as const,
};
const base = {
  orderNumber: "300000000001",
  positionIds: ["11111111-2222-3333-4444-555555555555"],
  roundTrip: true,
  startStation: "Bochum Hbf",
  destStation: "Neueck, Triberg im Schwarzwald",
  plannedDeparture: "2026-10-06T05:48:00+02:00",
  plannedArrival: "2026-10-06T12:42:00+02:00",
  profile,
};

describe("Online-Antrag über das DB-Konto", () => {
  it("baut den Abbruch so, wie ihn bahn.de selbst schickt", () => {
    const b = JSON.parse(JSON.stringify(buildSubmission({ ...base, direction: "HINFAHRT", type: "abgebrochen", abortedAt: "Mannheim Hbf", returnUnused: false })));
    expect(b).toEqual({
      einreichungId: "",
      fahrtberechtigung: { fahrkarte: { auftragsnummer: "300000000001", auftragspositionIds: ["11111111-2222-3333-4444-555555555555"] } },
      antraege: [
        {
          antragsTyp: "antragstyp-abgebrochen",
          fahrtrichtung: "HINFAHRT",
          abbruchbahnhof: "Mannheim Hbf",
          startbahnhof: "Bochum Hbf",
          zielbahnhof: "Neueck, Triberg im Schwarzwald",
          abfahrtszeitGeplant: "2026-10-06T03:48:00.000Z",
          ankunftszeitGeplant: "2026-10-06T10:42:00.000Z",
          verspaetungUeberEineStunde: false,
          rueckfahrtUngenutzt: false,
          hasVerkehrsmittelNebenbelege: false,
          hasWeitereNebenbelege: false,
          hasHotelNebenbelege: false,
        },
      ],
      antragsteller: { anrede: "HR", nachname: "Mustermann", vorname: "Max", email: "max@example.org", strasse: "Musterweg 1", land: "DEU", ort: "Bochum", plz: "44892" },
      entschaedigung: { entschaedigungsart: "ueberweisung", bankverbindung: { inhaber: "Max Mustermann", iban: "DE89370400440532013000" } },
      bestaetigungEmail: true,
      kundenbefragung: false,
      nebenbelegInhalte: [],
    });
  });

  it("Verspätung: tatsächliche Ankunft und „über eine Stunde“", () => {
    const [a] = buildSubmission({ ...base, direction: "RUECKFAHRT", type: "verspaetung", actualArrival: "2026-10-06T13:50:00+02:00" }).antraege;
    expect(a).toMatchObject({ antragsTyp: "antragstyp-verspaetung", fahrtrichtung: "RUECKFAHRT", ankunftszeitIst: "2026-10-06T11:50:00.000Z", verspaetungUeberEineStunde: true, rueckfahrtUngenutzt: true });
    expect(a.abbruchbahnhof).toBeUndefined();
  });

  it("verweigert unvollständige Angaben, bevor etwas an die DB geht", () => {
    expect(() => buildSubmission({ ...base, direction: "HINFAHRT", type: "abgebrochen", abortedAt: "Mannheim Hbf" })).toThrow(/Rückfahrt/);
    expect(() => buildSubmission({ ...base, direction: "HINFAHRT", type: "nicht-angetreten", returnUnused: true, profile: { ...profile, salutation: "" as const } })).toThrow(/Anrede/);
    expect(() => buildSubmission({ ...base, direction: "RUECKFAHRT", type: "verspaetung" })).toThrow(/Ankunft/);
  });

  it("wählt die Antragsart nur, wenn die DB etwas zahlt", () => {
    const planned = "2026-10-06T12:42:00+02:00";
    expect(onlineClaimType({ status: "delayed", actualArrival: "2026-10-06T13:45:00+02:00", expectedDelayMin: null, abortedAt: null }, planned)).toBe("verspaetung");
    expect(onlineClaimType({ status: "delayed", actualArrival: "2026-10-06T13:20:00+02:00", expectedDelayMin: null, abortedAt: null }, planned)).toBeNull();
    expect(onlineClaimType({ status: "aborted", actualArrival: null, expectedDelayMin: 70, abortedAt: "Mannheim Hbf" }, planned)).toBe("abgebrochen");
    expect(onlineClaimType({ status: "aborted", actualArrival: null, expectedDelayMin: 30, abortedAt: "Mannheim Hbf" }, planned)).toBeNull();
    expect(onlineClaimType({ status: "cancelled", actualArrival: null, expectedDelayMin: null, abortedAt: null }, planned)).toBe("nicht-angetreten");
  });
});
