import type { ClaimRow, TripRow } from "@/db/schema";
import { DbLoginError, withDbSession, type DbOrder, type DbOrderDetail } from "./dbBrowser";
import { getProfile, ibanValid, type ClaimantProfile } from "./profile";
import { getTrip, saveClaim } from "./repo";
import { arrivalDelayMin, onlineClaimType, ticketSpan, type OnlineClaimType } from "./rules";

export { onlineClaimType, type OnlineClaimType };

/**
 * Passenger-rights claim through the DB customer account — the same request
 * bahn.de's own form sends (Fahrgastrechte online): positions of the booking,
 * one Antrag per direction, the claimant and the payout.
 */


const SALUTATION: Record<string, string> = { Herr: "HR", Frau: "FR", "Neutrale Anrede": "NA" };
const COUNTRY: Record<string, string> = {
  "": "DEU", deutschland: "DEU", germany: "DEU", d: "DEU", de: "DEU",
  österreich: "AUT", austria: "AUT", schweiz: "CHE", switzerland: "CHE", niederlande: "NLD", belgien: "BEL",
  frankreich: "FRA", luxemburg: "LUX", dänemark: "DNK", polen: "POL", tschechien: "CZE", italien: "ITA",
};

export interface OnlineClaimInput {
  orderNumber: string;
  positionIds: string[];
  direction: "HINFAHRT" | "RUECKFAHRT";
  roundTrip: boolean;
  type: OnlineClaimType;
  startStation: string;
  destStation: string;
  plannedDeparture: string;
  plannedArrival: string;
  actualArrival?: string | null;
  abortedAt?: string | null;
  /** Round trip, outbound aborted / not started: the return won't be / wasn't used. */
  returnUnused?: boolean;
  profile: ClaimantProfile;
}

const iso = (s: string) => new Date(s).toISOString();

/** The request body of bahn.de's Fahrgastrechte form (einreichungId is filled in when sending). */
export function buildSubmission(i: OnlineClaimInput) {
  const p = i.profile;
  const missing: string[] = [];
  const anrede = SALUTATION[p.salutation];
  if (!anrede) missing.push("Anrede");
  if (!p.firstName || !p.lastName) missing.push("Name");
  if (!p.street || !p.postcode || !p.city) missing.push("Adresse");
  if (!p.email) missing.push("E-Mail");
  if (p.payout === "transfer" && !ibanValid(p.iban)) missing.push("gültige IBAN");
  const land = COUNTRY[(p.country ?? "").trim().toLowerCase()];
  if (!land) missing.push("Land (Deutschland, Österreich, Schweiz, …)");
  if (missing.length) throw new Error(`In den Einstellungen fehlt: ${missing.join(", ")}`);
  if (i.type === "abgebrochen" && !i.abortedAt) throw new Error("Bahnhof des Abbruchs fehlt.");
  if (i.type === "verspaetung" && !i.actualArrival) throw new Error("Tatsächliche Ankunft fehlt.");
  const asksReturn = i.roundTrip && i.direction === "HINFAHRT" && i.type !== "verspaetung";
  if (asksReturn && typeof i.returnUnused !== "boolean") throw new Error("Angabe fehlt, ob die Rückfahrt genutzt wird.");

  const late = i.type === "verspaetung" ? arrivalDelayMin(i.plannedArrival, i.actualArrival ?? null) : null;
  return {
    einreichungId: "",
    fahrtberechtigung: { fahrkarte: { auftragsnummer: i.orderNumber, auftragspositionIds: i.positionIds } },
    antraege: [
      {
        antragsTyp: `antragstyp-${i.type}`,
        fahrtrichtung: i.direction,
        abbruchbahnhof: i.type === "abgebrochen" ? i.abortedAt! : undefined,
        startbahnhof: i.startStation,
        zielbahnhof: i.destStation,
        abfahrtszeitGeplant: iso(i.plannedDeparture),
        ankunftszeitGeplant: iso(i.plannedArrival),
        ankunftszeitIst: i.type === "verspaetung" ? iso(i.actualArrival!) : undefined,
        verspaetungUeberEineStunde: i.type === "verspaetung" && (late ?? 0) >= 60,
        // bahn.de: true unless asked (outbound of a round trip) and the return is used
        rueckfahrtUngenutzt: asksReturn ? i.returnUnused! : true,
        hasVerkehrsmittelNebenbelege: false,
        hasWeitereNebenbelege: false,
        hasHotelNebenbelege: false,
      },
    ],
    antragsteller: {
      anrede: anrede!,
      titel: p.academic || undefined,
      nachname: p.lastName,
      vorname: p.firstName,
      email: p.email,
      strasse: [p.street, p.houseNumber].filter(Boolean).join(" "),
      adresszusatz: p.addressExtra || undefined,
      land: land!,
      ort: p.city,
      plz: p.postcode,
      telefon: p.phone || undefined,
    },
    entschaedigung:
      p.payout === "voucher"
        ? { entschaedigungsart: "gutschein" }
        : {
            entschaedigungsart: "ueberweisung",
            bankverbindung: { inhaber: p.accountHolder || `${p.firstName} ${p.lastName}`, bic: p.bic || undefined, iban: p.iban.replace(/\s/g, "") },
          },
    bestaetigungEmail: true,
    kundenbefragung: false,
    nebenbelegInhalte: [],
  };
}

async function findOrder(nr: string, s: { orders: { auftraege?: DbOrder[] }; pastOrders: (i: number) => Promise<{ auftraege?: DbOrder[]; hasMoreAuftraege?: boolean }> }): Promise<DbOrder | null> {
  const hit = s.orders.auftraege?.find((o) => o.auftragsnummer === nr);
  if (hit) return hit;
  for (let i = 0; i < 100; i += 10) {
    const page = await s.pastOrders(i);
    const o = page.auftraege?.find((x) => x.auftragsnummer === nr);
    if (o) return o;
    if (!page.hasMoreAuftraege) break;
  }
  return null;
}

/** Submit the claim for this trip online. Returns the claim with DB's Fall-ID. */
export async function submitClaimOnline(tripId: string, opts: { returnUnused?: boolean } = {}): Promise<ClaimRow> {
  const trip = getTrip(tripId);
  if (!trip) throw new Error("Fahrt nicht gefunden");
  if (!trip.orderNumber) throw new Error("Für den Online-Antrag fehlt die Auftragsnummer.");
  if (trip.claims.some((c) => c.caseId || c.status !== "draft")) throw new Error("Für diese Fahrt gibt es schon einen eingereichten Antrag.");
  // Like the paper form: the ticket's rail part (its destination is where the actual arrival was taken).
  const span = ticketSpan(trip);
  if (!span.departure || !span.arrival) throw new Error("Planzeiten der Fahrt fehlen.");
  const type = onlineClaimType(trip, span.arrival);
  if (!type) throw new Error("Laut den DB-Regeln gibt es für diese Fahrt nichts – oder es fehlen Angaben (Ankunft / angekündigte Verspätung).");
  const dirKey = trip.direction === "return" ? "rueckfahrt" : "hinfahrt";
  const profile = getProfile();
  // Fail on missing data before logging in at DB.
  buildSubmission({
    orderNumber: trip.orderNumber, positionIds: [], direction: dirKey === "rueckfahrt" ? "RUECKFAHRT" : "HINFAHRT", roundTrip: trip.roundTrip, type,
    startStation: span.from, destStation: span.to, plannedDeparture: span.departure, plannedArrival: span.arrival,
    actualArrival: trip.actualArrival, abortedAt: trip.abortedAt, returnUnused: opts.returnUnused, profile,
  });

  const caseIds = await withDbSession(async (s) => {
    const order = await findOrder(trip.orderNumber!, s);
    if (!order) throw new Error("Die Buchung ist nicht in deinem DB-Konto (Auftragsnummer nicht gefunden).");
    const g = (order.gesamtreisen ?? []).find((x) => x[dirKey]) ?? order.gesamtreisen?.[0];
    if (!g?.id) throw new Error("Reise in der Buchung nicht gefunden.");
    const detail = await s.getJson<DbOrderDetail>(`/web/api/buchung/auftrag/${encodeURIComponent(trip.orderNumber!)}?gesamtreiseId=${encodeURIComponent(g.id)}`);
    const fr = detail.gesamtangebot?.[dirKey]?.fahrgastrechte;
    const positionIds = (fr?.possibleAntragList ?? []).map((x) => x.positionId).filter((x): x is string => !!x);
    if (!positionIds.length)
      throw new Error(fr?.submittedAntragList?.length ? "Für diese Fahrt ist bei der DB schon ein Antrag eingereicht." : "Die DB bietet für diese Fahrt keinen Online-Antrag an.");
    const body = buildSubmission({
      orderNumber: trip.orderNumber!, positionIds, direction: dirKey === "rueckfahrt" ? "RUECKFAHRT" : "HINFAHRT", roundTrip: trip.roundTrip, type,
      startStation: span.from, destStation: span.to, plannedDeparture: span.departure!, plannedArrival: span.arrival!,
      actualArrival: trip.actualArrival, abortedAt: trip.abortedAt, returnUnused: opts.returnUnused, profile,
    });
    const id = await s.api("POST", "/web/api/buchung/fahrgastrechte/ticket", undefined, { Accept: "text/plain" });
    if (id.status !== 200 && id.status !== 201) throw new Error(`Einreichungsnummer: HTTP ${id.status}`);
    body.einreichungId = id.text.trim();
    const res = await s.api("PUT", "/web/api/buchung/fahrgastrechte/einreichung", JSON.stringify(body), {
      "Content-Type": "application/x.db.vendo.web.streamable+json; charset=utf-8",
      Accept: "application/json",
    });
    if (res.status !== 200) throw new Error(`Die DB hat den Antrag abgelehnt (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
    const ids = (JSON.parse(res.text) as { validAntragIds?: string[] }).validAntragIds ?? [];
    if (!ids.length) throw new Error("Die DB hat keine Fall-ID zurückgegeben – bitte in „Meine Reisen“ prüfen.");
    return ids;
  }).catch((e) => {
    throw e instanceof DbLoginError ? new Error(`DB-Login: ${e.message}`) : e;
  });

  const draft = trip.claims.find((c) => c.status === "draft" && !c.caseId);
  return saveClaim(trip.id, {
    id: draft?.id,
    type: type === "verspaetung" ? "delay" : type === "nicht-angetreten" ? "not_started" : "aborted_return",
    status: "submitted",
    caseId: caseIds[0],
    submittedAt: Date.now(),
    payout: profile.payout,
    notes: `Online über das DB-Konto eingereicht (${type}).`,
  });
}
